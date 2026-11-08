// What a Claude session inside a Dobius+ tab is told it can do (Sam, 2026-11-07: "any ai agent that's in a terminal
// inside dobius also gets the dobius commands shot into its available context ... so it knows that it has
// orchestrator capabilities across dobius team chats or self-computer chats between dobiuses and gws and the core
// features").
//
// Dobius keeps this text in <userData>/agent-context.md. Every tab gets DOBIUS_AGENT_CONTEXT pointing at it, and the
// SessionStart hook in the managed status block prints it (SessionStart output becomes part of the session's
// context). It names only the everyday commands; the Voice Conductor's own commands (texting Sam, spawning agents,
// completing Asana tasks) are deliberately left out so an ordinary session never reaches for them.
//
// No secrets: account EMAILS and teammate NAMES only, never a token, key or message.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const MAX_LISTED = 30;
const oneLine = (s, max = 80) => String(s ?? '').replace(/[\x00-\x1f\x7f\u0080-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The text, from what Dobius knows right now. Pure.
 * @param {{ machine?: string, platform?: string, gwsEmails?: string[], gwsShim?: string, teammates?: string[], orchestratorPinned?: boolean }} info
 */
export function buildAgentContext({ machine = '', platform = process.platform, gwsEmails = [], gwsShim = '', teammates = [], orchestratorPinned = false } = {}) {
  const where = platform === 'win32' ? 'PC' : 'Mac';
  const name = oneLine(machine, 60);
  // Never shortened (a cut address can be another account's), and only addresses a shell passes through unchanged:
  // an agent pastes it after DOBIUS_GWS_ACCOUNT=, where a ' or " would be removed and name another account (Codex).
  // Anything else is counted and left to Settings.
  const safeEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(e);
  // At most 30 listed (the rest counted), so the whole text stays well under the hook's 16KB read and no address is
  // ever cut in half there (Codex round 4).
  const allSafe = [...new Set(gwsEmails.filter(safeEmail))].sort();
  const emails = allSafe.slice(0, MAX_LISTED);
  const otherEmails = new Set(gwsEmails.filter((e) => !safeEmail(e))).size + (allSafe.length - emails.length);
  // Teammates name their own Dobius on their own machine. A name is listed (quoted) only when it is already plain:
  // letters, digits, single spaces and . _ ' -, at most 40 long. Cleaning one up instead would hand the agent a name
  // that is not the teammate's, and `dobius-team send` could then reach the wrong person ("Max (Work)" cleaned to
  // "Max Work", Codex). Anything else is counted and left to Settings > Team.
  const plain = (t) => typeof t === 'string' && t.length <= 40 && /^[\p{L}\p{N}._'-]+( [\p{L}\p{N}._'-]+)*$/u.test(t);
  const allPlain = [...new Set(teammates.filter(plain))];
  const mates = allPlain.slice(0, MAX_LISTED);
  const unnamed = teammates.filter((t) => !plain(t)).length + (allPlain.length - mates.length);
  const lines = [
    `This session runs in a Dobius+ terminal tab${name ? ` on ${where} "${name}"` : ''}. Dobius+ gives you these, use them when they help:`,
    '- Name this tab: when you start a distinct task, run `dobius-tab "<3-6 word summary>"`.',
    '- Other tabs on this ' + where + ': `dobius-tabs` lists them; `dobius-send <tabId> "<message>"` types a message into one; `dobius-open <project folder> <any request id> - < message.txt` opens a new tab there, starts Claude and sends it the message.',
    '- Hand the person a command to run (when an action is blocked for you): put it on its own line starting with `! `. Dobius lists it in Tasks > Commands with a Run button.',
    '- Tasks panel: when you finish a task listed there, run `dobius-task-done "<task title, Asana gid or task id>"` (it acts on the project this tab opened in).',
  ];
  // The shim by its full path: a login shell can put another gws (Homebrew's) ahead of it on PATH, and that one ignores
  // DOBIUS_GWS_ACCOUNT and runs as its own default account.
  // Exactly as installed (collapsing spaces would name another path), as a sh command: on Windows Claude's Bash tool
  // runs Git Bash, which reads forward slashes. Left out when sh would read part of it inside "...".
  const shim = typeof gwsShim === 'string' ? (platform === 'win32' ? gwsShim.replace(/\\/g, '/') : gwsShim) : '';
  if (emails.length && shim && shim.length <= 400 && !/["`$\\\x00-\x1f\x7f\u2028\u2029]/.test(shim)) {
    const call = `DOBIUS_GWS_ACCOUNT=<email> "${shim}"`;
    lines.push(`- Google Workspace (Gmail, Drive, Docs, Sheets, Calendar) as any connected account: \`${call} <service> <resource> <method> --params '{...}'\`. Use that full path (a plain \`gws\` may be another copy that ignores the account) and name the account every time. Connected: ${emails.join(', ')}${otherEmails ? `, and ${otherEmails} more (see Settings > Google Accounts)` : ''}.`);
  } else if (!emails.length && otherEmails) {
    lines.push(`- Google Workspace: ${otherEmails} connected account${otherEmails === 1 ? '' : 's'}, listed in Dobius Settings > Google Accounts (${otherEmails === 1 ? 'its address has' : 'their addresses have'} characters a shell would change).`);
  } else if (!emails.length) {
    lines.push('- Google Workspace: no accounts are connected yet (Dobius Settings > Google Accounts).');
  }
  if (mates.length || unnamed) {
    const who = [...mates.map((m) => `"${m}"`), ...(unnamed ? [`${unnamed} more (see Settings > Team)`] : [])].join(', ');
    lines.push(`- Teammates' Dobius+ (other people's Macs/PCs, end-to-end encrypted): ${who}. \`dobius-team inbox\` reads messages; \`dobius-team send <name> < <file>\` sends one, but only from the tab pinned as team orchestrator${orchestratorPinned ? '' : ' (none is pinned yet: tab menu, Use as team orchestrator)'}; from any other tab, \`dobius-team send\` hands the message to that tab for approval. Messages to people go out under the person's name: write them as the person would and only when asked to.`);
  }
  lines.push('- Other dobius-* commands on the PATH belong to the Voice Conductor; do not use them unless the person asks.');
  return `${lines.join('\n')}\n`;
}

/** Write it atomically (temp file then rename, 0644: nothing secret in it). Never throws. */
export function writeAgentContext(file, info) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = buildAgentContext(info);
    try { if (fs.readFileSync(file, 'utf8') === text) return true; } catch { /* not there yet */ }
    const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, text, { mode: 0o644, flag: 'wx' });
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* never made */ } // a failing rename must not leave one behind every refresh
      throw err;
    }
    return true;
  } catch (err) {
    console.warn('[agent-context] could not write:', err?.code || err?.message);
    return false;
  }
}
