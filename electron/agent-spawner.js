/**
 * agent-spawner.js — Phase 3.
 *
 * Spawns a fresh Claude agent in a new Dobius+ tab, gated by Sam's iMessage
 * confirmation via conversation-router. Two entry paths:
 *
 *   1. Conductor calls `dobius-spawn` from inside its tab — that endpoint
 *      asks Sam via iMessage first, then spawns on confirm
 *   2. Lead-tab routing: if config.projects[path].leadTabId is set and the
 *      tab is alive, Conductor sends work there instead of spawning. No
 *      iMessage prompt in that path.
 *
 * Spawn implementation reuses the existing built-in agents pipeline:
 *   - find the agent system prompt
 *   - write it to a temp file (same `--system-prompt-file` pattern as the
 *     desktop AgentManager + the orchestrator)
 *   - create a new terminal tab in the target project's window
 *   - type `claude --system-prompt-file <path>` into the tab
 *
 * If the target project doesn't have a window open, we open one first.
 */
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { createTerminal, writeTerminal, listTerminals } from './terminal-manager.js';
import { askSam } from './conversation-router.js';
import { getProjectConfig, setProjectConfig } from './config-manager.js';
import { baseName } from '../shared/platform.js';
import { projectPathFromTabId } from './tab-id-util.js';

const SPAWN_DEBOUNCE_MS = 5000;
let lastSpawnTs = 0;

/**
 * Generate a tab id for the spawned agent. Follows the same shape as the
 * desktop tabs so terminalHasDesktopAttached and registry checks all work.
 * Format: term-<projectPath>-<counter>
 */
function newTabId(projectPath) {
  const cfg = getProjectConfig(projectPath);
  const counter = (cfg?.tabCounter || 0) + 1;
  setProjectConfig(projectPath, { tabCounter: counter });
  return `term-${projectPath}-${counter}`;
}

/**
 * Find a built-in or custom agent by id or fuzzy name match.
 * Called with the same BUILTIN_AGENTS array from main.js (passed in).
 */
export function findAgent(agentId, allAgents) {
  if (!agentId || !Array.isArray(allAgents)) return null;
  const exact = allAgents.find((a) => a.id === agentId);
  if (exact) return exact;
  const q = String(agentId).toLowerCase();
  return allAgents.find((a) => (a.name || '').toLowerCase().includes(q))
      || allAgents.find((a) => (a.id || '').toLowerCase().includes(q))
      || null;
}

/**
 * Ask Sam via iMessage whether to spawn the requested agent. Returns:
 *   { confirmed: true } → proceed
 *   { confirmed: false, reason: 'rejected' | 'timeout' | 'error' }
 *
 * Sam's reply is parsed liberally: yes / y / 1 / ok = confirm; no / n / 2 /
 * cancel = reject; anything else also rejects (safer than misinterpreting).
 */
async function confirmSpawn(agentName, projectName, initialPrompt) {
  const promptSnippet = (initialPrompt || '').slice(0, 100);
  const question = `Spawn fresh "${agentName}" in ${projectName}${
    promptSnippet ? `\nFirst input: "${promptSnippet}${initialPrompt.length > 100 ? '...' : ''}"` : ''
  }\nReply YES or NO.`;
  const { answer, timedOut } = await askSam(question);
  if (timedOut) return { confirmed: false, reason: 'timeout' };
  if (!answer) return { confirmed: false, reason: 'no answer' };
  const a = String(answer).trim().toLowerCase();
  if (['yes', 'y', '1', 'ok', 'okay', 'sure', 'go'].includes(a)) return { confirmed: true };
  return { confirmed: false, reason: 'rejected', userSaid: a.slice(0, 50) };
}

/**
 * The full spawn pipeline. Returns the new tabId on success, throws on
 * failure (caller surfaces error to Conductor / Sam).
 */
export async function spawnAgent({ projectPath, agentId, initialPrompt, builtinAgents }) {
  // Debounce: never spawn more than once per 5s. Hard kill-switch from the
  // concurrency safeguards in the plan.
  const now = Date.now();
  if (now - lastSpawnTs < SPAWN_DEBOUNCE_MS) {
    throw new Error('spawn debounce — wait ~5s before another spawn');
  }
  if (!projectPath || typeof projectPath !== 'string') throw new Error('projectPath required');
  if (!fs.existsSync(projectPath)) throw new Error(`project path does not exist: ${projectPath}`);
  const agent = findAgent(agentId, builtinAgents);
  if (!agent) throw new Error(`agent not found: ${agentId}`);

  const projectName = baseName(projectPath) || projectPath;

  // Confirm with Sam via iMessage. The Conductor is the only caller right
  // now, and the Conductor was triggered by an iMessage so this gate makes
  // sense. If we ever add a desktop-initiated spawn path, skip the ask.
  const { confirmed, reason, userSaid } = await confirmSpawn(agent.name, projectName, initialPrompt);
  if (!confirmed) {
    throw new Error(`spawn declined (${reason}${userSaid ? `: "${userSaid}"` : ''})`);
  }
  lastSpawnTs = Date.now();

  // Write system prompt to temp file.
  const promptDir = path.join(app.getPath('temp'), 'dobius-agents');
  fs.mkdirSync(promptDir, { recursive: true });
  const promptPath = path.join(promptDir, `agent-${agent.id}-${Date.now()}.txt`);
  fs.writeFileSync(promptPath, agent.systemPrompt || '', 'utf8');

  // Create the tab (no webContents — runs headless in the background; user
  // can attach a desktop window later by reopening the project).
  const tabId = newTabId(projectPath);
  createTerminal(tabId, projectPath, null);
  const spawnedPid = listTerminals().find((t) => t.id === tabId)?.pid;
  noteHeadless(tabId, projectPath, spawnedPid);

  // Type the launch command. Brief delay lets the shell prompt render first.
  // Codex audit HIGH (agent-spawner.js:120): agent.model was interpolated
  // into the shell command unsanitized. A custom agent with model:
  // `claude-sonnet-4-6;rm -rf ~` would have run the rm. Whitelist the
  // exact model IDs we know about, drop everything else silently.
  // Allowed model identifiers. MUST include every value the renderer's
  // model picker can save so a custom agent isn't silently launched
  // model-less when its persisted model isn't in the set.
  // Codex round-2 HIGH on agent-spawner.js:124. Keep this list in sync
  // with src/components/Dashboard/AgentManager model selector + any other
  // place the renderer offers model choices.
  const KNOWN_MODELS = new Set([
    'opus',                              // alias → claude-opus-4-8
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5-20251001',
    'claude-fable-5',
  ]);
  const safePromptPath = promptPath.replace(/'/g, "'\\''");
  let modelFlag = '';
  if (agent.model && KNOWN_MODELS.has(agent.model)) {
    const resolved = agent.model === 'opus' ? 'claude-opus-4-8' : agent.model;
    modelFlag = ` --model ${resolved}`;
  }
  const cmd = `claude --system-prompt-file '${safePromptPath}'${modelFlag}\r`;
  // Only into the PTY made above: a window may re-create this tab id meanwhile.
  const samePty = () => Number.isInteger(spawnedPid) && listTerminals().find((t) => t.id === tabId)?.pid === spawnedPid;
  setTimeout(() => {
    if (!samePty()) return;
    writeTerminal(tabId, cmd);
    // If the spawner was given an initialPrompt, send it as the agent's
    // first input AFTER claude boots (give it ~3s — Claude TUI takes a
    // beat to be ready for input).
    if (initialPrompt && typeof initialPrompt === 'string' && initialPrompt.trim()) {
      // The guarded paste (tab-send, Claude only): no control key in the prompt reaches the terminal, and it waits for
      // Claude's prompt instead of typing into a shell. Up to 10 tries, 2 s apart, while Claude is still starting.
      const send = async (tries) => {
        if (!samePty()) return;
        const { sendViaTabSend } = await import('./voice-bridge.js');
        const r = await sendViaTabSend(tabId, initialPrompt.trim(), { claudeOnly: true });
        // Only a send that typed nothing is tried again: one typed but unconfirmed may have been taken already.
        if (r.body?.ok || r.body?.typed || tries <= 1 || r.status === 404 || r.status === 400) {
          if (!r.body?.ok) console.warn(`[agent-spawner] initial prompt for ${tabId} not sent: ${r.body?.error || r.body?.note || r.status}`);
          return;
        }
        setTimeout(() => { send(tries - 1).catch((err) => console.warn('[agent-spawner] initial prompt:', err?.message || err)); }, 2000);
      };
      setTimeout(() => { send(10).catch((err) => console.warn('[agent-spawner] initial prompt:', err?.message || err)); }, 3000);
    }
  }, 800);

  return { tabId, agentName: agent.name };
}

/**
 * Set the lead tab for a project. Once set, Conductor routes new work there
 * instead of asking to spawn. Pass `null` to clear.
 */
// The project orchestrator (docs/project-orchestrator.md) is this same slot: the tab menu and the Voice Conductor's
// dobius-lead-tab both come through here, so a tab can only lead its OWN project, only while it is open, and every
// window hears about the change.
const leadListeners = new Set();
// main: the project of the window that owns a tab; undefined when no window owns it, null for a window that is not a
// project window (a Visual window): never this project's.
let tabOwnerProject = () => undefined;
export function setTabOwnerResolver(fn) { if (typeof fn === 'function') tabOwnerProject = fn; }
// Headless agents this module started: tab id -> { projectPath, pid } (no window owns them). The pid ties the record to
// that one PTY: a window that re-creates the id gets another process. Pruned to live tabs past 200.
const headless = new Map();
function noteHeadless(tabId, projectPath, pid) {
  if (!Number.isInteger(pid)) return;
  headless.set(tabId, { projectPath, pid });
  if (headless.size > 200) {
    const live = new Set(listTerminals().map((t) => t.id));
    for (const id of [...headless.keys()]) if (!live.has(id)) headless.delete(id);
  }
}
// A live tab really is this project's: its window's project, or for a headless agent the project it was started for.
// Never the id alone (a folder named like an extra window's id, `x~w-12345678`, parses to another project; a pin
// saved for a closed window's tab can come back on a reused id), nor a tab's start folder (any window can choose it).
function tabOfProject(projectPath, tabId) {
  const t = listTerminals().find((x) => x.id === tabId);
  if (!t) return false;
  let owner;
  try { owner = tabOwnerProject(tabId); } catch { owner = undefined; }
  if (owner !== undefined) return owner === projectPath;
  const h = headless.get(tabId);
  return !!h && h.projectPath === projectPath && h.pid === t.pid;
}
export function onLeadTabChanged(fn) { leadListeners.add(fn); return () => leadListeners.delete(fn); }

export function setLeadTab(projectPath, tabId) {
  if (!projectPath || typeof projectPath !== 'string') return { ok: false, error: 'projectPath required' };
  if (tabId !== null && (typeof tabId !== 'string' || !/^term-.+-\d+$/.test(tabId))) {
    return { ok: false, error: 'tabId malformed' };
  }
  if (tabId !== null && projectPathFromTabId(tabId) !== projectPath) return { ok: false, error: 'that tab belongs to another project' };
  if (tabId !== null && !listTerminals().some((t) => t.id === tabId)) return { ok: false, error: 'that tab is not open' };
  // Every caller (tab menu, dobius-lead-tab, the Conductor) goes through here.
  if (tabId !== null && !tabOfProject(projectPath, tabId)) return { ok: false, error: 'that tab belongs to another project' };
  setProjectConfig(projectPath, { leadTabId: tabId });
  for (const fn of leadListeners) { try { fn(projectPath, tabId); } catch (err) { console.warn('[agent-spawner] lead listener:', err?.message || err); } }
  return { ok: true, projectPath, leadTabId: tabId };
}

/**
 * Get the lead tab for a project (returns the tabId if it's set AND the
 * tab is currently alive; null otherwise).
 */
export function getLeadTab(projectPath) {
  if (!projectPath) return null;
  const cfg = getProjectConfig(projectPath);
  const leadId = cfg?.leadTabId;
  if (!leadId) return null;
  // Only return it if the tab is actually alive — a dead leadTabId
  // gracefully falls through to "no lead, ask to spawn".
  return tabOfProject(projectPath, leadId) ? leadId : null;
}
