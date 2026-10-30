// The tool a brand-new tab should start (Claude Code, Codex), handed to the
// tab's terminal before it mounts, like pending-scrollback. The terminal passes
// it to terminal:create and main starts the tool as the login shell's first
// command (shared/new-tab.js loginShellArgs). Only store.openNewTab sets it, so a restored,
// reopened or agent tab never gets one and never launches a second tool.
const pending = new Map();

// 'default' = the Settings choice, read by main at spawn.
export function setPendingLaunch(tabId, tool) {
  pending.set(tabId, tool);
}

export function takePendingLaunch(tabId) {
  const tool = pending.get(tabId);
  pending.delete(tabId);
  return tool;
}

// Restored tabs replace whatever was created before them, so an intent made
// for a tab id that restore then reuses must not carry over to the saved tab.
export function clearPendingLaunches() {
  pending.clear();
}
