// Types `claude` / `codex` into a New Tab's fresh shell (Settings > New Tab
// Starts). Lives in main because main sees every write to a PTY, from the
// keyboard, the command bar, the Chat view, the phone and the bridges: the
// command is typed only if nothing else has typed into the tab first.
import { launchCommandFor, armLaunch } from '../shared/new-tab.js';
import { getSettings } from './config-manager.js';
import {
  addTerminalObserver, writeTerminal, terminalInputSeq, terminalClosing, terminalInstance,
} from './terminal-manager.js';

const armed = new Map(); // tab id -> launch handle
let stopObserving = null;

// Call right after createTerminal(id) spawned the shell. `request` is
// 'default' (Settings > New Tab Starts) or 'claude' | 'codex' | 'shell'.
export function launchInNewTerminal(id, request) {
  const command = launchCommandFor(request, request === 'default' ? getSettings().newTabTool : undefined);
  armed.get(id)?.dispose();
  if (!command) return;
  if (!stopObserving) {
    stopObserving = addTerminalObserver({
      onData: (tid) => armed.get(tid)?.onOutput(),
      onExit: (tid) => armed.get(tid)?.dispose(),
    });
  }
  const pty = terminalInstance(id);
  const inputSeq = terminalInputSeq(id);
  const handle = armLaunch(command, {
    write: (data) => writeTerminal(id, data),
    canWrite: () => terminalInstance(id) === pty && terminalInputSeq(id) === inputSeq && !terminalClosing(id),
    onDone: () => { if (armed.get(id) === handle) armed.delete(id); },
  });
  armed.set(id, handle);
}
