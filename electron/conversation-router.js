/**
 * conversation-router.js — Phase 3.
 *
 * Lets the Voice Conductor ask Sam questions over iMessage and await his
 * one-shot reply. The reply path is:
 *
 *   1. Conductor calls `dobius-ask "<question>"` from inside its tab
 *   2. voice-bridge's /askSam endpoint sends Sam an iMessage with the
 *      question + an opaque "ask id" prefix (e.g. "[ask-xyz] Spawn fresh
 *      Code Reviewer in Slimject?")
 *   3. Sam texts a reply back (anything starting with the iMessage trigger
 *      prefix, e.g. "d: yes")
 *   4. imessage-bridge sees the incoming message, asks this router whether
 *      the text is a pending askSam reply BEFORE treating it as a new command
 *   5. If yes → resolves the Promise the Conductor is awaiting
 *   6. If no → falls through to normal new-command dispatch
 *
 * Timeout default is 5 min — if Sam doesn't reply, the Promise resolves with
 * null and the Conductor receives "(no reply, action skipped)" so it can
 * decide what to do.
 */
import { sendImessageToSelf } from './imessage-bridge.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_PENDING = 8;                    // hard cap on outstanding asks

const pending = new Map();                // askId -> { resolve, timer, question, askedAt }

/**
 * Generate an askId. Short opaque token Sam doesn't have to type back —
 * the router reads it from the incoming message context, not from his text.
 * (We just track "is there ANY pending ask" — Sam's reply resolves the
 * oldest one. Multi-turn 1-on-1 model. Phase 4 can add per-ask routing
 * if we ever need parallel asks.)
 */
function newAskId() {
  return `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Ask Sam a question via iMessage and await his reply.
 * Returns: { answer: string|null, askId, timedOut: boolean }
 */
export async function askSam(question, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (typeof question !== 'string' || !question.trim()) {
    return { answer: null, askId: null, timedOut: false, error: 'question required' };
  }
  if (pending.size >= MAX_PENDING) {
    return { answer: null, askId: null, timedOut: false, error: 'too many pending asks' };
  }
  const askId = newAskId();
  const text = `🤖 ${question.slice(0, 1200)}`;
  // Fire the iMessage first so Sam has something to reply to.
  try {
    await sendImessageToSelf(text);
  } catch (err) {
    return { answer: null, askId, timedOut: false, error: `iMessage send failed: ${err.message}` };
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(askId);
      resolve({ answer: null, askId, timedOut: true });
    }, timeoutMs);
    pending.set(askId, {
      resolve: (answer) => {
        clearTimeout(timer);
        pending.delete(askId);
        resolve({ answer, askId, timedOut: false });
      },
      timer,
      question,
      askedAt: Date.now(),
    });
  });
}

/**
 * Called by imessage-bridge BEFORE treating an incoming message as a new
 * command. If there's any pending ask, resolves the oldest one with `text`
 * and returns true (consumed). Otherwise returns false (caller proceeds).
 */
export function tryResolvePending(text) {
  if (pending.size === 0) return false;
  // Resolve the OLDEST ask — assumes 1-on-1 sequential interaction, which is
  // realistic for voice/glasses use. If Sam ever asks multiple things at once
  // we revisit.
  const [askId, entry] = pending.entries().next().value;
  try { entry.resolve(text); } catch { /* noop */ }
  pending.delete(askId);
  return true;
}

/**
 * Cancel a specific pending ask (used by Phase 5 emergency-stop).
 */
export function cancelAsk(askId) {
  const entry = pending.get(askId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  try { entry.resolve(null); } catch { /* noop */ }
  pending.delete(askId);
  return true;
}

/** Diagnostics — how many asks are outstanding right now. */
export function pendingCount() {
  return pending.size;
}
