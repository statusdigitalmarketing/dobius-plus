/**
 * Phone mode: the runner's logic that does not touch the SDK, sockets or processes, so it is tested on its own
 * (docs/phone-mode-design.md, "The SDK" and "Questions and permissions").
 *
 * Parts of this file are adapted from Happy (https://github.com/slopus/happy, packages/happy-cli/src/claude):
 * the canUseTool routing (AskUserQuestion and ExitPlanMode always go to a person, subagent-scoped request ids, the
 * deny text), the streaming input queue that keeps a query alive between turns, and the `remote_mobile` entrypoint.
 * Rewritten in JavaScript for Dobius. Happy's license:
 *
 * MIT License
 *
 * Copyright (c) 2026 Happy Coder Contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import crypto from 'node:crypto';

// Happy's deny text (permissionHandler.ts): Claude Code's own wording for a rejected tool use.
export const DENY_TEXT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
export const KEEP_PLANNING_TEXT = 'The user wants to keep planning and has not approved this plan yet. Wait for their feedback.';
export const TOO_MANY_TEXT = 'Too many requests are already waiting for an answer on the phone. Wait for them to be answered, then try again.';
export const MAX_PENDING = 8;
export const MAX_QUEUED_MESSAGES = 32;

// Caps on what a card carries, so 8 cards fit well inside one 256 KB socket line.
const CAP_TEXT = 1000; // a label, description, title, header
const CAP_QUESTION = 8000; // under the protocol's 8 KB answer-key cap, so a shortened question can still be answered
const CAP_INPUT = 4096; // a tool's input shown on a permission card
const CAP_PLAN = 16384; // a plan's text
const CAP_QUESTIONS = 20;
const CAP_OPTIONS = 8;

const REQUEST_ID = /^[\x21-\x7e]{1,200}$/;

/** Happy's fix for slopus/happy#1202: the SDK tags the session `sdk-ts` otherwise, which hides it from resume pickers. */
export function resolveEntrypoint(current) {
  return typeof current === 'string' && current.length > 0 ? current : 'remote_mobile';
}

// ---- permission mode and model carried over from the stopped TUI's argv ----

export const CARRY_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\[1m\])?$/;

/** { permissionMode, model } from Claude's argv (an array), each null unless it is an allowlisted value. Last wins. */
export function carryOverFlags(argv) {
  let permissionMode = null;
  let model = null;
  const a = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    let mode = null;
    let mdl = null;
    if (t === '--dangerously-skip-permissions') mode = 'bypassPermissions';
    else if (t === '--permission-mode') mode = a[++i] ?? null;
    else if (t.startsWith('--permission-mode=')) mode = t.slice(18);
    else if (t === '--model') mdl = a[++i] ?? null;
    else if (t.startsWith('--model=')) mdl = t.slice(8);
    if (mode !== null) permissionMode = CARRY_MODES.has(mode) ? mode : null;
    if (mdl !== null) model = MODEL_RE.test(mdl) ? mdl : null;
  }
  return { permissionMode, model };
}

// ---- cards ----

const cap = (s, n) => {
  const t = typeof s === 'string' ? s : s == null ? '' : String(s);
  return t.length > n ? `${t.slice(0, n)}...` : t;
};

/** The id an answer must name: the tool use id, scoped by the subagent's id (Happy), hashed if it is not printable. */
export function requestIdFor(opts) {
  const raw = opts?.agentID ? `${opts.agentID}:${opts.toolUseID}` : String(opts?.toolUseID ?? '');
  if (REQUEST_ID.test(raw)) return raw;
  return `r_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40)}`;
}

// `index` is the question's place in the tool input, so an answer is keyed by the ORIGINAL question text even when
// the card's copy was shortened (Codex P2, impl round 3). The card's text is what the phone answers by.
function questionsOf(input) {
  const qs = Array.isArray(input?.questions) ? input.questions.slice(0, CAP_QUESTIONS) : [];
  return qs.map((q, index) => ({
    index,
    question: cap(q?.question, CAP_QUESTION),
    header: cap(q?.header, CAP_TEXT),
    multiSelect: q?.multiSelect === true,
    options: (Array.isArray(q?.options) ? q.options.slice(0, CAP_OPTIONS) : []).map((o) => ({
      label: cap(o?.label, CAP_TEXT), description: cap(o?.description, CAP_TEXT),
    })),
  })).filter((q) => q.question.length > 0);
}

function inputText(input) {
  let s;
  try { s = JSON.stringify(input ?? {}, null, 1); } catch (e) { s = `(input could not be shown: ${e.message})`; }
  return cap(s, CAP_INPUT);
}

/** What the phone shows for one canUseTool call. No secrets beyond what the TUI would show. */
export function cardFor(toolName, input, opts = {}) {
  const requestId = requestIdFor(opts);
  const tool = cap(toolName, 200);
  if (toolName === 'AskUserQuestion') return { requestId, kind: 'question', tool, questions: questionsOf(input), canAlways: false };
  if (toolName === 'ExitPlanMode') return { requestId, kind: 'plan', tool, summary: cap(input?.plan, CAP_PLAN), canAlways: false };
  const canAlways = Array.isArray(opts.suggestions) && opts.suggestions.length > 0 && opts.suppressAlwaysAllowRule !== true;
  return {
    requestId, kind: 'permission', tool,
    title: cap(opts.title, CAP_TEXT), description: cap(opts.description, CAP_TEXT), displayName: cap(opts.displayName, 200),
    reason: cap(opts.decisionReason, CAP_TEXT), blockedPath: cap(opts.blockedPath, CAP_TEXT),
    // An MCP server's name is untrusted text: the phone renders it as text, never markup.
    mcpServer: opts.mcpServer?.name ? cap(opts.mcpServer.name, 200) : '',
    input: inputText(input), canAlways, defaultToNo: opts.defaultToNo === true,
  };
}

/**
 * Whether an already shape-checked answer (phone-protocol.js validateAnswer) fits this card: same kind, every
 * question answered and nothing else, Always only when offered. Returns an error string or null.
 */
export function answerMisfit(card, answer) {
  if (!card || !answer || card.kind !== answer.kind) return 'answer does not match the request';
  if (card.kind === 'question') {
    const want = new Set(card.questions.map((q) => q.question));
    const got = Object.keys(answer.answers);
    if (got.length !== want.size || got.some((k) => !want.has(k))) return 'answer every question, and only those';
    return null;
  }
  if (card.kind === 'permission' && answer.always && !card.canAlways) return 'always allow is not offered here';
  return null;
}

/**
 * The SDK result for an answer that fits its card. `input` and `suggestions` are the canUseTool call's own.
 * Plan approval's mode switch is the caller's (it must happen before this result is returned, as Happy does).
 */
export function resultFor(card, answer, input, suggestions) {
  const base = input && typeof input === 'object' ? input : {};
  if (card.kind === 'question') {
    // Null prototype: a question named "__proto__" is an ordinary key (Codex P2, impl round 3).
    const answers = Object.create(null);
    const orig = Array.isArray(base.questions) ? base.questions : [];
    for (const q of card.questions) {
      if (!Object.prototype.hasOwnProperty.call(answer.answers, q.question)) continue;
      const key = typeof orig[q.index]?.question === 'string' ? orig[q.index].question : q.question;
      answers[key] = answer.answers[q.question];
    }
    return { behavior: 'allow', updatedInput: { ...base, answers }, decisionClassification: 'user_temporary' };
  }
  if (card.kind === 'plan') {
    return answer.approve
      ? { behavior: 'allow', updatedInput: base, decisionClassification: 'user_temporary' }
      : { behavior: 'deny', message: answer.note || KEEP_PLANNING_TEXT, decisionClassification: 'user_reject' };
  }
  if (!answer.allow) return { behavior: 'deny', message: answer.note || DENY_TEXT, decisionClassification: 'user_reject' };
  if (answer.always && card.canAlways) {
    return { behavior: 'allow', updatedInput: base, updatedPermissions: suggestions, decisionClassification: 'user_permanent' };
  }
  return { behavior: 'allow', updatedInput: base, decisionClassification: 'user_temporary' };
}

// ---- the router: canUseTool for the SDK, answer() for the socket ----

/**
 * onCard(card) and onGone(requestId, why) tell main. setMode(mode) switches the SDK's permission mode (plan approval).
 * Every pending request ends exactly once: answered, aborted by the SDK, or denied by cancelAll.
 */
export function createPermissionRouter({ onCard, onGone, setMode, maxPending = MAX_PENDING }) {
  const pending = new Map(); // requestId -> { card, input, suggestions, settle }

  function canUseTool(toolName, input, opts = {}) {
    const card = cardFor(toolName, input, opts);
    if (opts.signal?.aborted) return Promise.resolve({ behavior: 'deny', message: 'Interrupted.' });
    if (pending.has(card.requestId)) return Promise.resolve({ behavior: 'deny', message: 'This request is already waiting for an answer.' });
    if (pending.size >= maxPending) return Promise.resolve({ behavior: 'deny', message: TOO_MANY_TEXT });
    return new Promise((resolve) => {
      const onAbort = () => {
        if (entry.settled) return;
        entry.settle({ behavior: 'deny', message: 'Interrupted.' });
        onGone?.(card.requestId, 'aborted');
      };
      const entry = {
        card, input, suggestions: opts.suggestions, answering: false, settled: false,
        // Ends the request exactly once, whoever gets there first (answer, abort, cancelAll).
        settle(result) {
          if (entry.settled) return false;
          entry.settled = true;
          if (pending.get(card.requestId) === entry) pending.delete(card.requestId);
          opts.signal?.removeEventListener?.('abort', onAbort);
          resolve(result);
          return true;
        },
      };
      pending.set(card.requestId, entry);
      opts.signal?.addEventListener?.('abort', onAbort, { once: true });
      onCard?.(card);
    });
  }

  /** Answer one pending request. { ok: true } or { ok: false, code, error }. */
  async function answer(requestId, ans) {
    const entry = pending.get(requestId);
    if (!entry || entry.answering) return { ok: false, code: 'not_pending', error: 'that request is no longer waiting' };
    const misfit = answerMisfit(entry.card, ans);
    if (misfit) return { ok: false, code: 'bad_answer', error: misfit };
    // Stays pending while the mode switches, so an abort or cancelAll in that moment still ends it (as a deny), and a
    // second answer is refused.
    entry.answering = true;
    if (entry.card.kind === 'plan' && ans.approve) {
      try { await setMode?.(ans.mode || 'default'); } catch (e) { onGone?.(requestId, `mode switch failed: ${e.message}`); }
    }
    if (!entry.settle(resultFor(entry.card, ans, entry.input, entry.suggestions))) {
      return { ok: false, code: 'not_pending', error: 'the request ended while it was being answered' };
    }
    return { ok: true };
  }

  /** Deny everything still waiting (the run is ending). */
  function cancelAll(why = 'ended') {
    for (const [id, entry] of [...pending]) {
      entry.settle({ behavior: 'deny', message: 'The conversation left the phone before this was answered.', interrupt: true });
      onGone?.(id, why);
    }
  }

  return { canUseTool, answer, cancelAll, pendingCards: () => [...pending.values()].map((e) => e.card), size: () => pending.size };
}

// ---- the streaming input queue (Happy): keeps the query alive between turns ----

export function createInputQueue(max = MAX_QUEUED_MESSAGES) {
  const items = [];
  let waiter = null;
  let closed = false;
  const msg = (text) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  const close = () => {
    closed = true;
    if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }); }
  };
  return {
    /** False when closed or full; the caller refuses the send rather than dropping it silently. */
    push(text) {
      if (closed || items.length >= max) return false;
      if (waiter) { const w = waiter; waiter = null; w({ value: msg(text), done: false }); } else items.push(msg(text));
      return true;
    },
    close,
    get closed() { return closed; },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (items.length) return Promise.resolve({ value: items.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => { waiter = r; });
        },
        return() { close(); return Promise.resolve({ value: undefined, done: true }); },
      };
    },
  };
}
