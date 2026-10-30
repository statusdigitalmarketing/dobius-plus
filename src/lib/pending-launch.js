// The tool a brand-new tab should start (Claude Code, Codex), handed to the
// tab's terminal before it mounts, like pending-scrollback. Only the New Tab
// paths set it, so a restored, reopened or agent tab never gets one and never
// launches a second tool.
import { newTabCommand } from './new-tab.js';

const pending = new Map();

// `tool` may be a promise (the setting is read from main when the tab opens).
export function setPendingLaunch(tabId, tool) {
  pending.set(tabId, tool);
}

export function takePendingLaunch(tabId) {
  const tool = pending.get(tabId);
  pending.delete(tabId);
  return tool;
}

// Types the tool's command into the tab once its shell has printed something
// (its prompt) and gone quiet for settleMs, or after fallbackMs if it never
// does. Typing earlier would land while the shell is still sourcing its rc
// files. Anything the user types first cancels it, so their own line is never
// extended with a command they did not ask for.
export function armLaunch(tool, { write, settleMs = 300, fallbackMs = 4000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let done = false;
  let command = null;
  let resolved = false;
  let shellReady = false;
  let settle = null;

  const fire = () => {
    if (done || !resolved || !shellReady) return;
    done = true;
    clearTimer(settle);
    clearTimer(fallback);
    if (command) write(`${command}\r`);
  };
  const ready = () => { shellReady = true; fire(); };
  const fallback = setTimer(ready, fallbackMs);

  Promise.resolve(tool).then((t) => {
    command = newTabCommand(t);
    resolved = true;
    if (!command) { done = true; clearTimer(settle); clearTimer(fallback); return; }
    fire();
  }, () => { done = true; clearTimer(settle); clearTimer(fallback); });

  return {
    // Shell output: (re)start the quiet timer.
    onOutput() {
      if (done || shellReady) return;
      clearTimer(settle);
      settle = setTimer(ready, settleMs);
    },
    onUserInput() {
      if (done) return;
      done = true;
      clearTimer(settle);
      clearTimer(fallback);
    },
    dispose() {
      done = true;
      clearTimer(settle);
      clearTimer(fallback);
    },
  };
}
