// Tasks > Commands: the `! ` commands this project's Claude sessions handed back for the person to run
// (electron/handoff-commands.js). Run asks main for a one-time token, then opens a new tab that starts with the command
// as its startup program, in the folder the card names (main redeems the token at terminal:create, and only then does
// the command leave the list). Nothing is typed into any shell or into the session's own Claude prompt.
import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../../store/store';

const MONO = "'SF Mono', Menlo, monospace";
const api = window.electronAPI;

const small = (color = 'var(--accent)') => ({
  fontSize: 10, fontFamily: MONO, color, background: 'none', border: '1px solid var(--border)', borderRadius: 4,
  padding: '1px 6px', cursor: 'pointer',
});

/** This project's pending commands, live. */
export function useProjectCommands(projectPath) {
  const [entries, setEntries] = useState([]);
  const load = useCallback(async () => {
    if (!api?.handoffCommandsList) return;
    try {
      const all = await api.handoffCommandsList();
      setEntries(Array.isArray(all) ? all.filter((e) => e.projectPath === projectPath) : []);
    } catch (err) {
      console.error('[CommandsList] could not list commands:', err);
    }
  }, [projectPath]);
  useEffect(() => {
    load();
    return api?.onHandoffCommandsChanged?.(load);
  }, [load]);
  return entries;
}

export default function CommandsList({ query }) {
  const projectPath = useStore((s) => s.currentProjectPath);
  const tabs = useStore((s) => s.terminalTabs);
  const openRunTab = useStore((s) => s.openRunTab);
  const showTab = useStore((s) => s.showTab);
  const setActiveView = useStore((s) => s.setActiveView);
  const entries = useProjectCommands(projectPath);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);

  const tabName = (id) => tabs.find((t) => t.id === id)?.label || 'a tab in another window';

  const run = async (tabId, c) => {
    setError(null);
    if (!projectPath) return;
    const r = await api.handoffCommandsPrepare(tabId, c.id);
    if (!r?.ok) { setError(r?.error || 'Could not run it.'); return; }
    const tab = openRunTab(projectPath, r.token, `Run: ${c.text.slice(0, 24)}`);
    if (!tab) { setError('The window is still starting; try again.'); return; }
    setActiveView('terminal');
    showTab(tab.id);
  };

  const copy = async (text, id) => {
    setError(null);
    if (!navigator.clipboard?.writeText) { setError('Clipboard is not available.'); return; }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch (err) {
      setError(`Could not copy: ${err?.message || err}`);
    }
  };

  const q = String(query || '').toLowerCase();
  const shown = entries
    .map((e) => ({ ...e, commands: q ? e.commands.filter((c) => c.text.toLowerCase().includes(q)) : e.commands }))
    .filter((e) => e.commands.length);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 6px' }}>
      {shown.length === 0 && (
        <div style={{ padding: '20px 14px', textAlign: 'center', color: 'var(--dim)', fontSize: 11, lineHeight: 1.5 }}>
          {q ? `Nothing matches "${query}".` : 'No commands waiting. When a session hands you a `! command` to run, it shows up here.'}
        </div>
      )}
      {shown.map((e) => (
        <div key={e.tabId} style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontFamily: MONO, color: 'var(--dim)' }}>
            <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{tabName(e.tabId)}</span>
            <span title={e.cwd || projectPath}>
              runs in {!e.cwd || e.cwd === projectPath ? 'the project folder' : (e.cwd.startsWith(`${projectPath}/`) ? e.cwd.slice(projectPath.length + 1) : e.cwd)}
            </span>
          </div>
          {e.commands.map((c) => (
            <div key={c.id} style={{ marginTop: 5 }}>
              <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--fg)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 6px' }}>
                {c.text}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <button style={small()} title="Opens a new terminal tab and runs it there, in the folder shown above" onClick={() => run(e.tabId, c)}>Run</button>
                <button style={small('var(--dim)')} onClick={() => copy(c.text, c.id)}>{copied === c.id ? 'Copied' : 'Copy'}</button>
                <button style={small('var(--dim)')} title="Not running it: remove it from the list" onClick={() => api.handoffCommandsDismiss(e.tabId, c.id)}>Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      ))}
      {error && <div style={{ padding: '4px 10px', fontSize: 10, color: 'var(--danger)' }}>{error}</div>}
    </div>
  );
}
