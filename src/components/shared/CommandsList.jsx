// Tasks > Commands: the `! ` commands this project's Claude sessions handed back for the person to run
// (electron/handoff-commands.js). Each card says where it came from, what Claude said around it (what it is for, what
// to do first), warns about a placeholder to fill in, and runs in one click: Run asks main for a one-time token, then
// opens a new tab that starts with the command as its startup program in the folder shown (nothing is typed into any
// shell or into the session's own Claude prompt). The card then shows Running, Done or Failed.
import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../../store/store';
import { commandPlaceholder } from '../../../shared/handoff.js';
import { isWindows } from '../../../shared/platform.js';

// Windows tabs run PowerShell, which cannot start a run script: Copy only (Max, 2026-11-09).
const CAN_RUN = !isWindows();

const MONO = "'SF Mono', Menlo, monospace";
const api = window.electronAPI;

const btn = (kind = 'plain', disabled = false) => ({
  fontSize: 10.5, fontFamily: MONO, borderRadius: 4, padding: '2px 8px', cursor: disabled ? 'default' : 'pointer',
  border: kind === 'primary' ? 'none' : '1px solid var(--border)',
  background: kind === 'primary' ? (disabled ? 'var(--border)' : 'var(--accent)') : 'none',
  color: kind === 'primary' ? (disabled ? 'var(--dim)' : 'var(--bg)') : 'var(--dim)',
  fontWeight: kind === 'primary' ? 600 : 400,
});

const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

/** This project's commands, live. `waiting` counts the ones still to run (the Tasks badge). */
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
export const waitingCount = (entries) => entries.reduce((n, e) => n + e.commands.filter((c) => c.state === 'waiting').length, 0);

const STATUS = {
  running: { label: 'Running', color: 'var(--accent)' },
  done: { label: '✓ Done', color: '#3FB950' },
  failed: { label: 'Failed', color: 'var(--danger)' },
  closed: { label: 'Tab closed before it finished', color: '#F87300' },
};

function CommandCard({ entry, c, projectPath, tabName, hasTab, folderOf, onError }) {
  const openRunTab = useStore((s) => s.openRunTab);
  const showTab = useStore((s) => s.showTab);
  const setActiveView = useStore((s) => s.setActiveView);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.text);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  // Run (here or in another window) or Dismiss changed it: a draft for the old state must not stay on screen.
  useEffect(() => { if (c.state !== 'waiting') { setEditing(false); setDraft(c.text); } }, [c.state, c.text]);
  // Opening Edit selects the placeholder, so pasting a key replaces exactly it.
  useEffect(() => {
    const el = inputRef.current;
    if (!editing || !el) return;
    el.focus();
    const hole0 = commandPlaceholder(el.value);
    const at = hole0 ? el.value.indexOf(hole0) : -1;
    if (at >= 0) el.setSelectionRange(at, at + hole0.length);
    else el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const text = editing ? draft : c.text;
  const hole = c.state === 'waiting' ? commandPlaceholder(text) : null;
  const changed = draft.trim() !== c.text;

  const run = async (asIs = false) => {
    onError(null);
    if (!projectPath || (hole && !asIs) || busy) return;
    setBusy(true);
    try {
      const r = await api.handoffCommandsPrepare(entry.tabId, c.id, editing && changed ? draft.trim() : undefined, asIs);
      if (!r?.ok) { onError(r?.error || 'Could not run it.'); return; }
      // Named after the command as Claude gave it: an edited one may hold a pasted key, and tab names are saved.
      const tab = openRunTab(projectPath, r.token, `Run: ${c.text.slice(0, 24)}`);
      if (!tab) { onError('The window is still starting; try again.'); return; }
      setEditing(false);
      setActiveView('terminal');
      showTab(tab.id);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    onError(null);
    if (!navigator.clipboard?.writeText) { onError('Clipboard is not available.'); return; }
    try {
      await navigator.clipboard.writeText(text.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      onError(`Could not copy: ${err?.message || err}`);
    }
  };
  const openTab = (id) => { setActiveView('terminal'); showTab(id); };

  const st = STATUS[c.state];
  return (
    <div style={{ marginTop: 8 }}>
      {c.why && (
        <div style={{ fontSize: 11.5, lineHeight: 1.45, color: c.state === 'waiting' ? 'var(--fg)' : 'var(--dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', borderLeft: '2px solid var(--border)', paddingLeft: 8, marginBottom: 6 }}>
          {c.why}
        </div>
      )}
      {hole && (
        <div style={{ fontSize: 11, color: '#F87300', background: 'rgba(248,115,0,0.08)', border: '1px solid rgba(248,115,0,0.35)', borderRadius: 4, padding: '4px 8px', marginBottom: 6 }}>
          Fill in <span style={{ fontFamily: MONO }}>{hole}</span> {CAN_RUN ? 'before running' : 'before copying'}.
          {!editing && (
            <button style={{ ...btn(), marginLeft: 8, color: '#F87300', borderColor: 'rgba(248,115,0,0.5)' }} onClick={() => setEditing(true)}>Fill it in</button>
          )}
          {CAN_RUN && (
            <button
              style={{ ...btn(), border: 'none', padding: '0 0 0 8px', textDecoration: 'underline', color: 'var(--dim)' }}
              title={`Run it exactly as shown: ${hole} is part of the command, not something to replace`}
              onClick={() => run(true)}
            >
              Not a placeholder? Run as is
            </button>
          )}
        </div>
      )}
      {editing && c.state === 'waiting' ? (
        // Wraps like the shown command (one line of shell: Enter runs it, a pasted line break becomes a space).
        <textarea
          ref={inputRef}
          value={draft}
          rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 48)))}
          onChange={(e) => setDraft(e.target.value.replace(/[\r\n]+/g, ' '))}
          onKeyDown={(e) => {
            // Enter while an input method is composing (Japanese, Chinese) accepts the candidate; it never runs.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') { e.preventDefault(); if (CAN_RUN) run(); }
            if (e.key === 'Escape') { setEditing(false); setDraft(c.text); }
          }}
          aria-label="Edit the command"
          spellCheck={false}
          style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: MONO, fontSize: 11.5, lineHeight: 1.45, color: 'var(--fg)', background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: 4, padding: '5px 7px', outline: 'none', wordBreak: 'break-all' }}
        />
      ) : (
        <div style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--fg)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 7px' }}>
          {c.text}
        </div>
      )}
      {c.edited && c.state !== 'waiting' && (
        <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 2 }}>
          ran with your edit: Dobius does not show or save it (if the command itself prints it, in an error say, that shows as in any terminal)
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        {c.state === 'waiting' ? (
          <>
            {CAN_RUN && (
              <button
                style={btn('primary', !!hole || busy)}
                disabled={!!hole || busy}
                title={hole ? `Fill in ${hole} first` : 'Opens a new terminal tab in the folder shown and runs it there'}
                onClick={() => run()}
              >
                {busy ? 'Starting…' : '▶ Run'}
              </button>
            )}
            {editing ? (
              <button style={btn()} onClick={() => { setEditing(false); setDraft(c.text); }}>Cancel</button>
            ) : (
              <button style={btn()} title={CAN_RUN ? 'Change it before running (fill in a key, a path)' : 'Change it before copying (fill in a key, a path)'} onClick={() => setEditing(true)}>Edit</button>
            )}
            <button style={btn()} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            <button style={btn()} title="Not running it: remove it from the list" onClick={() => api.handoffCommandsDismiss(entry.tabId, c.id)}>Dismiss</button>
          </>
        ) : (
          <>
            <span style={{ fontSize: 11, fontWeight: 600, color: st?.color || 'var(--dim)' }}>
              {st?.label || c.state}{c.state === 'failed' && Number.isInteger(c.exit) && c.exit >= 0 ? ` (exit ${c.exit})` : ''}
            </span>
            <span style={{ fontSize: 10, color: 'var(--dim)' }}>
              {c.state === 'running' ? `in ${tabName(c.runTabId)}` : c.endedAt ? ago(c.endedAt) : ''}
              {c.cwd && c.cwd !== entry.cwd ? ` · ran in ${folderOf(c.cwd)}` : ''}
            </span>
            {c.runTabId && hasTab(c.runTabId) && <button style={btn()} onClick={() => openTab(c.runTabId)}>Open tab</button>}
            <button style={btn()} title={c.state === 'running' ? 'Remove the card (the command keeps running in its tab)' : 'Remove the card'} onClick={() => api.handoffCommandsDismiss(entry.tabId, c.id)}>Dismiss</button>
          </>
        )}
      </div>
    </div>
  );
}

export default function CommandsList({ query }) {
  const projectPath = useStore((s) => s.currentProjectPath);
  const tabs = useStore((s) => s.terminalTabs);
  const entries = useProjectCommands(projectPath);
  const [error, setError] = useState(null);
  const [openReply, setOpenReply] = useState(null);
  // "handed back 5m ago" stays true while the list is open.
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 60_000); return () => clearInterval(t); }, []);

  const tabName = (id) => tabs.find((t) => t.id === id)?.label || 'a tab in another window';
  const hasTab = (id) => tabs.some((t) => t.id === id);
  const folder = (cwd) => (!cwd || cwd === projectPath ? 'the project folder' : (cwd.startsWith(`${projectPath}/`) ? cwd.slice(projectPath.length + 1) : cwd));

  const q = String(query || '').toLowerCase();
  const shown = entries
    .map((e) => ({ ...e, commands: q ? e.commands.filter((c) => `${c.text} ${c.why || ''}`.toLowerCase().includes(q)) : e.commands }))
    .filter((e) => e.commands.length);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '2px 0 6px' }}>
      <div style={{ padding: '6px 12px 8px', borderBottom: '1px solid var(--border)', fontSize: 11, lineHeight: 1.45, color: 'var(--dim)' }}>
        {CAN_RUN
          ? <>Commands your Claude sessions asked you to run. <span style={{ color: 'var(--fg)' }}>Run</span> opens a new terminal tab in the folder shown and runs it there; the card then says whether it worked.</>
          : <>Commands your Claude sessions asked you to run. <span style={{ color: 'var(--fg)' }}>Copy</span> one and paste it into a terminal tab in the folder shown (Run is not on Windows yet).</>}
      </div>
      {shown.length === 0 && (
        <div style={{ padding: '20px 14px', textAlign: 'center', color: 'var(--dim)', fontSize: 11, lineHeight: 1.5 }}>
          {q ? `Nothing matches "${query}".` : 'Nothing to run right now. When a session hands you a command (its tab dot turns red), it shows up here.'}
        </div>
      )}
      {shown.map((e) => {
        // One group per reply the commands came with: each shows its own folder, age and full reply, so an older
        // command never sits under a newer turn's folder or reply (they accumulate until run or dismissed).
        const groups = [];
        for (const c of e.commands) {
          // Commands captured together share their capture time: a later handback never joins an older group.
          const key = `${c.at || ''}|${c.reply || ''}|${c.cwd || ''}`;
          const last = groups[groups.length - 1];
          if (last && last.key === key) last.commands.push(c); else groups.push({ key, id: c.id, reply: c.reply || e.reply, cwd: c.cwd || e.cwd, at: c.at || e.at, commands: [c] });
        }
        return (
          <div key={e.tabId} style={{ padding: '9px 12px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--fg)', fontWeight: 600 }}>{tabName(e.tabId)}</div>
            {groups.map((g, gi) => {
              // Keyed by its first command, never by position: dismissing another group must not reset a card's edit.
              const id = `${e.tabId}|${g.id}`;
              return (
                <div key={id} style={{ marginTop: gi ? 10 : 2, paddingTop: gi ? 8 : 0, borderTop: gi ? '1px dashed var(--border)' : 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11 }}>
                    <span style={{ color: 'var(--dim)' }} title={g.cwd || projectPath}>runs in {folder(g.cwd)}</span>
                    <span style={{ color: 'var(--dim)', marginLeft: 'auto', fontSize: 10 }}>{g.at ? `handed back ${ago(g.at)}` : ''}</span>
                  </div>
                  {g.commands.map((c) => (
                    <CommandCard key={c.id} entry={e} c={c} projectPath={projectPath} tabName={tabName} hasTab={hasTab} folderOf={folder} onError={setError} />
                  ))}
                  {g.reply ? (
                    <div style={{ marginTop: 6 }}>
                      <button style={{ ...btn(), border: 'none', padding: 0, textDecoration: 'underline' }} onClick={() => setOpenReply(openReply === id ? null : id)}>
                        {openReply === id ? 'Hide Claude\'s reply' : 'Show Claude\'s full reply'}
                      </button>
                      {openReply === id && (
                        <div style={{ marginTop: 5, maxHeight: 220, overflowY: 'auto', fontSize: 11, lineHeight: 1.45, color: 'var(--fg)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px' }}>
                          {g.reply}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
      {error && <div style={{ padding: '4px 12px', fontSize: 10.5, color: 'var(--danger)' }}>{error}</div>}
    </div>
  );
}
