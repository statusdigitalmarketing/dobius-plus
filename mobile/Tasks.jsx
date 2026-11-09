import { useState, useEffect, useRef, useCallback } from 'react';
import { shortPath, visiblePath } from '../shared/short-path.js';
import { commandPlaceholder } from '../shared/placeholder.js';
import { dueLabel as dayLabel, localDay, sortOpenTasks } from '../shared/task-due.js';
import { viewsFor, currentView } from './tasks-views.js';

/**
 * Tasks on the phone, the views of the Mac's Tasks dropdown: Today (what Claude picked from the Inbox board, Done and
 * Snooze right there), Commands (what a session handed back for you to run), To-do and Asana (a project's task list,
 * the same files the Mac's Project view reads) and Inbox (every open card on the board). Each view shows only when the
 * Mac says it can do it (authed.features), so an older Mac never gets a message it does not know. Nothing here is saved
 * on the phone except which view and project were open: every row comes from the Mac when the screen asks
 * (electron/mobile-today.js, electron/mobile-tasks.js).
 */

let reqSeq = 0;
// One request, one reply matched by reqId. Resolves null when nothing came back in time.
function ask(connection, msg, replyType, ms = 15000) {
  const reqId = `t${Date.now().toString(36)}-${++reqSeq}`;
  // Not connected: say so now instead of waiting out the timer (writes are never queued).
  if (connection.status !== 'authed') return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve(null); }, ms);
    const off = connection.onMessage((m) => {
      if (m.type !== replyType || m.reqId !== reqId) return;
      clearTimeout(timer);
      off();
      resolve(m);
    });
    connection.send({ ...msg, reqId });
  });
}

const BOARD_PROBLEM = {
  'not-installed': 'The Inbox board is not set up on this Mac.',
  'not-running': 'The Inbox board is not running on this Mac. Start it from Tasks on the Mac.',
};

function dueLabel(due, today) {
  if (!due) return '';
  if (due < today) return 'Overdue';
  if (due === today) return 'Due today';
  const d = new Date(`${due}T12:00:00`);
  return Number.isNaN(d.getTime()) ? '' : `Due ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

const SOURCE = { email: 'Email', asana: 'Asana', meeting: 'Meeting', text: 'Text', imessage: 'Text', slack: 'Slack', whatsapp: 'WhatsApp' };

function clock(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window: not remembered */ } },
};

// Copy without the async clipboard API where the page is not a secure context (a plain-HTTP tailnet address).
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the old way */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function Card({ card, today, busy, onDone, onSnooze, showReason }) {
  // Both menus belong to the card version they were opened on: if a refresh brings a newer one,
  // they close and the person looks again (Codex).
  const [snoozeFor, setSnoozeFor] = useState(null);
  // An Asana card closes the task in Asana itself, so it asks first, as the Mac does.
  const [confirmFor, setConfirmFor] = useState(null);
  const version = `${card.rev}:${card.print}`;
  const snoozing = snoozeFor === version;
  const confirmAsana = confirmFor === version;
  const setSnoozing = (on) => setSnoozeFor(on ? version : null);
  const setConfirmAsana = (on) => setConfirmFor(on ? version : null);
  const title = card.subject || card.summary || '(no subject)';
  const due = dueLabel(card.due, today);
  const meta = [card.who, SOURCE[card.source] || null, due].filter(Boolean).join(' · ');
  return (
    <div className={`today-card${card.priority === 'high' ? ' high' : ''}`}>
      {card.url
        ? <a className="today-title" href={card.url} target="_blank" rel="noreferrer">{title}</a>
        : <span className="today-title">{title}</span>}
      {meta && <div className={`today-meta${due === 'Overdue' ? ' overdue' : ''}`}>{meta}</div>}
      {showReason && card.reason && <div className="today-reason">{card.reason}</div>}
      {!showReason && card.summary && card.subject && <div className="today-reason">{card.summary}</div>}
      <div className="today-actions">
        {confirmAsana ? <>
          <span className="today-ask">Close it in Asana?</span>
          <button className="today-done" disabled={busy} onClick={() => { setConfirmAsana(false); onDone(card, 'complete'); }}>Close it</button>
          <button className="quiet" onClick={() => setConfirmAsana(false)}>Cancel</button>
        </> : snoozing ? <>
          <button disabled={busy} onClick={() => { setSnoozing(false); onSnooze(card, 'tomorrow'); }}>Tomorrow</button>
          <button disabled={busy} onClick={() => { setSnoozing(false); onSnooze(card, 'week'); }}>Next week</button>
          <button className="quiet" onClick={() => setSnoozing(false)}>Cancel</button>
        </> : <>
          {card.rev !== null && card.rev !== undefined && (
            <button className="today-done" disabled={busy} onClick={() => (card.source === 'asana' ? setConfirmAsana(true) : onDone(card, 'done'))}>{busy ? '…' : card.source === 'asana' ? 'Close in Asana' : 'Done'}</button>
          )}
          {card.print && <button disabled={busy} onClick={() => setSnoozing(true)}>Snooze</button>}
        </>}
      </div>
    </div>
  );
}

// null until this Mac has said what it can do (features arrive with 'authed').
export function useFeature(connection, name) {
  const read = () => (Array.isArray(connection.features) ? connection.features.includes(name) : null);
  const [has, setHas] = useState(read);
  useEffect(() => {
    setHas(read());
    return connection.onMessage((m) => { if (m.type === 'authed') setHas(read()); });
    // read() only looks at the connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, name]);
  return has;
}


function useFeatures(connection) {
  const read = () => (Array.isArray(connection.features) ? connection.features : null);
  const [features, setFeatures] = useState(read);
  useEffect(() => {
    setFeatures(read());
    return connection.onMessage((m) => { if (m.type === 'authed') setFeatures(read()); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);
  return features;
}

// Run's answers that are codes, not sentences (the Mac's checks answer in full sentences).
const RUN_CODES = {
  unavailable: 'Your Mac did not take that. Try again.',
  'bad-request': 'Your Mac did not take that. Try again.',
  'not-waiting': 'That command is no longer waiting.',
  placeholder: 'Fill in the placeholder first (Edit), or tap Run as is if it is not one.',
  'bad-edit': 'The edited command must be one line of plain text.',
  'bad-edit-syntax': 'That edit is not a complete shell command (check quotes and brackets).',
  syntax: 'That command has a shell syntax error. Copy it and fix it, or ask the session again.',
  shell: 'Run works with zsh and bash only. Use Copy and run it on the Mac.',
  'write-failed': 'Your Mac could not write the command for its terminal.',
  'spawn-failed': 'Your Mac could not start a terminal for it.',
  'no-folder': 'The folder this command runs in is not on your Mac right now, so it was not run.',
  failed: 'Your Mac could not run it.',
};

const RUN_STATUS = {
  running: 'Running',
  done: '✓ Done',
  failed: 'Failed',
  closed: 'Its terminal closed before it finished',
};

function CommandCard({ connection, entry, c, folderOf, say, onChanged, onOpenTab }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.text);
  const [busy, setBusy] = useState(false);
  // The draft the Mac answered 'placeholder' for, on a phone that cannot check it itself.
  const [macHoleFor, setMacHoleFor] = useState(null);
  const inputRef = useRef(null);
  // Run (on the Mac, this phone or another) or Dismiss changed it: a draft for the old state must not stay on screen.
  useEffect(() => { if (c.state !== 'waiting') { setEditing(false); setDraft(c.text); } }, [c.state, c.text]);
  // Opening Edit selects the placeholder, so pasting a key replaces exactly it.
  useEffect(() => {
    const el = inputRef.current;
    if (!editing || !el) return;
    el.focus();
    const hole0 = commandPlaceholder(el.value);
    const at = hole0 ? el.value.indexOf(hole0) : -1;
    if (at >= 0) el.setSelectionRange(at, at + hole0.length);
  }, [editing]);
  const text = editing ? draft : c.text;
  // undefined: this phone's browser cannot run the check (iOS before 16.4); the Mac's answer for the command as handed
  // back is used, and an edit is checked by the Mac when Run is tapped.
  const local = c.state === 'waiting' ? commandPlaceholder(text) : null;
  const hole = local !== undefined ? local
    : !editing ? (typeof c.hole === 'string' ? c.hole : null)
      : (macHoleFor !== null && macHoleFor === draft.trim() ? 'a placeholder' : null);
  const changed = draft.trim() !== c.text;

  const run = async (asIs = false) => {
    if ((hole && !asIs) || busy) return;
    setBusy(true);
    const r = await ask(connection, { type: 'commandsRun', tabId: entry.tabId, id: c.id, edited: editing && changed ? draft.trim() : undefined, asIs }, 'commandResult', 30000);
    setBusy(false);
    if (r?.ok) {
      setEditing(false);
      say('Running in a new terminal on your Mac.', r.termId ? { label: 'Open', run: () => onOpenTab?.(r.termId) } : null);
    } else if (!r) say(connection.status !== 'authed' ? 'Not connected to your Mac. Try again once it reconnects.' : 'No answer from your Mac. Look at the card again before running it.');
    else {
      if (r.error === 'placeholder' && editing && local === undefined) setMacHoleFor(draft.trim());
      say(RUN_CODES[r.error] || 'Your Mac could not run it.');
    }
    onChanged();
  };
  const dismiss = async () => {
    const r = await ask(connection, { type: 'commandsDismiss', tabId: entry.tabId, id: c.id }, 'commandResult');
    if (!r?.ok) say(r ? 'That one was already gone.' : 'No answer from your Mac.');
    onChanged();
  };
  const copy = async () => { say((await copyText(text.trim())) ? 'Copied.' : 'Could not copy on this phone.'); };

  return (
    <div className="cmd-item">
      {c.why && <div className={`cmd-why${c.state === 'waiting' ? '' : ' dim'}`}>{c.why}</div>}
      {hole && (
        <div className="cmd-hole">
          <span>Fill in {hole === 'a placeholder' ? hole : <code>{hole}</code>} before running.</span>
          <div className="cmd-hole-actions">
            {!editing && <button className="cmd-link" onClick={() => setEditing(true)}>Fill it in</button>}
            <button className="cmd-link dim" onClick={() => run(true)} disabled={busy}>Not a placeholder? Run as is</button>
          </div>
        </div>
      )}
      {editing && c.state === 'waiting'
        ? <textarea ref={inputRef} className="cmd-edit" value={draft} rows={3} spellCheck={false} autoCapitalize="off" autoCorrect="off"
          aria-label="Edit the command" onChange={(e) => setDraft(e.target.value.replace(/[\r\n]+/g, ' '))} />
        : <div className="cmd-text">{c.text}</div>}
      {c.edited && c.state !== 'waiting' && <div className="cmd-note">Ran with your edit. Dobius does not show or save it.</div>}
      <div className="today-actions">
        {c.state === 'waiting' ? <>
          <button className="today-done" disabled={!!hole || busy} onClick={() => run()}>{busy ? 'Starting…' : 'Run'}</button>
          {editing
            ? <button onClick={() => { setEditing(false); setDraft(c.text); }}>Cancel</button>
            : <button onClick={() => setEditing(true)}>Edit</button>}
          <button onClick={copy}>Copy</button>
          <button className="quiet" onClick={dismiss}>Dismiss</button>
        </> : <>
          <span className={`cmd-state ${c.state}`}>
            {RUN_STATUS[c.state] || c.state}{c.state === 'failed' && Number.isInteger(c.exit) ? ` (exit ${c.exit})` : ''}
            {c.endedAt && c.state !== 'running' ? <span className="cmd-ago"> · {ago(c.endedAt)}</span> : null}
            {c.cwd && c.cwd !== entry.cwd ? <span className="cmd-ago"> · ran in {folderOf(c.cwd)}</span> : null}
          </span>
          {c.runTabId && c.runLive && c.state !== 'closed' && <button onClick={() => onOpenTab?.(c.runTabId)}>Open terminal</button>}
          <button className="quiet" onClick={dismiss}>Dismiss</button>
        </>}
      </div>
    </div>
  );
}

function CommandsView({ connection, entries, reload, say, onOpenTab }) {
  const [openReply, setOpenReply] = useState(null);
  if (entries === null) return <p className="muted pad">Loading…</p>;
  if (entries.error) return <p className="muted pad">Could not read the commands from your Mac. <button className="link-btn" onClick={reload}>Try again</button></p>;
  const shown = entries.filter((e) => e.commands.length);
  return <>
    <p className="today-line">Commands your Claude sessions asked you to run. Run starts a new terminal on your Mac in the folder shown; the card then says whether it worked.</p>
    {shown.length === 0 && <p className="muted pad">Nothing to run right now. When a session hands you a command, it shows up here.</p>}
    {shown.map((e) => {
      // Always the path itself: two projects can share a name and a tab label, and Run acts on exactly this folder (Codex
      // round 4). Home is shortened to ~.
      const folderOf = (cwd) => visiblePath(shortPath(cwd || e.projectPath || '', e.home)) || 'the project folder';
      // One group per reply the commands came with, as on the Mac: each has its own folder, age and full reply.
      const groups = [];
      for (const c of e.commands) {
        const key = `${c.at || ''}|${c.reply || ''}|${c.cwd || ''}`;
        const last = groups[groups.length - 1];
        if (last && last.key === key) last.commands.push(c); else groups.push({ key, id: c.id, reply: c.reply, cwd: c.cwd || e.cwd, at: c.at || e.at, commands: [c] });
      }
      return (
        <section key={e.tabId} className="today-card cmd-card">
          <div className="today-title">{e.tabLabel}{e.project ? <span className="cmd-proj"> · {e.project}</span> : null}</div>
          {groups.map((g) => {
            // By the capture (when and where), never by its first command: dismissing that one must not remount the
            // others and drop an edit in progress.
            const gid = `${e.tabId}|${g.at}|${g.cwd}`;
            return (
              <div key={gid} className="cmd-group">
                <div className="today-meta">Runs in {folderOf(g.cwd)}{g.at ? ` · handed back ${ago(g.at)}` : ''}</div>
                {g.commands.map((c) => <CommandCard key={c.id} connection={connection} entry={e} c={c} folderOf={folderOf} say={say} onChanged={reload} onOpenTab={onOpenTab} />)}
                {g.reply && <>
                  <button className="cmd-link" onClick={() => setOpenReply(openReply === gid ? null : gid)}>{openReply === gid ? 'Hide Claude\'s reply' : 'Show Claude\'s full reply'}</button>
                  {openReply === gid && <div className="cmd-reply">{g.reply}</div>}
                </>}
              </div>
            );
          })}
        </section>
      );
    })}
  </>;
}

const SYNC_PROBLEM = {
  'no-key': 'No Asana key on this Mac yet. Add one in Settings > Integrations on the Mac.',
  unauthorized: 'Asana turned down this Mac\'s key. Fix it from Tasks on the Mac, which can switch to a key that works.',
  'unknown-project': 'That project is not on this Mac any more.',
  'open-on-mac': 'This project has an older list on your Mac. Open the project there once to bring it over, then it shows here.',
};
const OPEN_ON_MAC = SYNC_PROBLEM['open-on-mac'];

const LANE = { build: 'Mine', review: 'Sam · review' };
const STAGE = { approval: null, queued: 'Queued', running: 'Running', review: 'In review', blocked: 'Blocked' };

function TaskRow({ task, today, busy, expanded, onExpand, onToggle, onDelete }) {
  // A confirm belongs to the version it was asked on: a newer one (edited on the Mac) asks again. Decided while
  // rendering, so the Delete button for an older version is never on screen with the newer task behind it.
  const [confirmFor, setConfirmFor] = useState(null);
  const confirmDelete = expanded && confirmFor === task.print;
  const setConfirmDelete = (on) => setConfirmFor(on ? task.print : null);
  const due = !task.done ? dayLabel(task.dueOn, today) : null;
  const chips = [task.lane ? LANE[task.lane] : (task.source !== 'manual' && task.source !== 'asana' ? (task.source === 'inbox' ? 'From Inbox' : task.source) : null),
    !task.done ? STAGE[task.stage] || null : null].filter(Boolean);
  const hasDetail = !!(task.notes || task.url);
  return (
    <div className={`task-row${task.done ? ' done' : ''}`}>
      <button className={`task-check${task.done ? ' on' : ''}`} disabled={busy} onClick={() => onToggle(task)}
        role="checkbox" aria-checked={task.done} aria-label={task.done ? `Mark ${task.title} not done` : `Mark ${task.title} done`}>
        <span className="task-circle" aria-hidden="true">{task.done ? '✓' : ''}</span>
      </button>
      <div className="task-main">
        <button className="task-body" onClick={onExpand} aria-expanded={expanded}>
          <span className="task-title">{task.title}</span>
          {(chips.length > 0 || due || hasDetail) && (
            <span className="task-meta">
              {chips.map((c) => <span key={c} className="task-chip">{c}</span>)}
              {due && <span className={`task-due ${due.tone}`}>{due.text}</span>}
              {hasDetail && <span className="task-more">{expanded ? 'Less' : 'Details'}</span>}
            </span>
          )}
        </button>
        {expanded && (
          <div className="task-detail">
            {task.notes && <div className="task-notes">{task.notes}</div>}
            <div className="today-actions">
              {task.url && <a className="task-open" href={task.url} target="_blank" rel="noreferrer">{task.source === 'asana' ? 'Open in Asana' : 'Open original'}</a>}
              {confirmDelete ? <>
                <span className="today-ask">Delete it from this list?</span>
                <button className="danger" disabled={busy} onClick={() => { setConfirmDelete(false); onDelete(task); }}>Delete</button>
                <button className="quiet" onClick={() => setConfirmDelete(false)}>Cancel</button>
              </> : <button className="quiet" onClick={() => setConfirmDelete(true)}>Delete</button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// To-do and Asana: one project's list from the Mac (tasks-service, as the Mac's Project view). To-do shows what is not
// from Asana; Asana shows the synced Asana tasks, a Sync button, and the Inbox board's Asana cards (closing one of
// those is the only thing here that changes Asana, and it asks first).
function ProjectView({ connection, kind, say, asanaCards, cardFor }) {
  const key = `dobius-tasks-project:${connection.pairing?.id || connection.origin || ''}`;
  const [projects, setProjects] = useState(null);
  const [project, setProject] = useState(() => store.get(key));
  const [list, setList] = useState(null); // { project, tasks } | { project, error }
  const [busy, setBusy] = useState({});
  const [expanded, setExpanded] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const [title, setTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState(null);
  const seq = useRef(0);
  const projectRef = useRef(project);
  projectRef.current = project;
  // A sync started here can answer after this view is gone (another view, then back to a different project): its
  // result is shown only while this same view is still up (Codex phone tasks round 6).
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const today = localDay();

  const loadProjects = useCallback(async () => {
    const r = await ask(connection, { type: 'tasksProjects' }, 'tasksProjects', 20000);
    if (!r?.ok) { setProjects((p) => p || { error: true }); return; }
    const all = Array.isArray(r.list) ? r.list : [];
    setProjects(all);
    // The one chosen before if this Mac still knows it, else the busiest that has a list (never one without: reading it
    // could take over another folder's old list file on the Mac). None: the person picks.
    setProject((cur) => (cur && all.some((p) => p.path === cur) ? cur : all.find((p) => p.hasList)?.path || null));
  }, [connection]);

  const loadTasks = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    const mine = ++seq.current;
    const r = await ask(connection, { type: 'projectTasksRead', project: p }, 'projectTasks', 20000);
    // Only the newest read, and only for the project still chosen.
    if (mine !== seq.current || projectRef.current !== p) return;
    setList((prev) => (r?.ok ? { project: p, tasks: r.tasks || [] } : prev?.project === p && prev.tasks ? prev : { project: p, error: r?.error || 'failed' }));
  }, [connection]);

  useEffect(() => {
    loadProjects();
    const off = connection.onMessage((m) => {
      if (m.type === 'authed') { loadProjects(); loadTasks(); }
      if (m.type === 'tasksChanged') { loadTasks(); loadProjects(); } // the rows and the picker's counts
    });
    const onVisible = () => { if (document.visibilityState === 'visible') loadTasks(); };
    document.addEventListener('visibilitychange', onVisible);
    // A task checked off from a terminal (dobius-task-done) sends phones no event: look again every minute.
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadTasks(); }, 60000);
    return () => { off(); clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [connection, loadProjects, loadTasks]);

  useEffect(() => {
    setSyncNote(null); // a note was about the project before
    if (!project) return;
    store.set(key, project);
    setExpanded(null);
    loadTasks();
  }, [project, key, loadTasks]);

  const mark = (id, on) => setBusy((b) => { const n = { ...b }; if (on) n[id] = true; else delete n[id]; return n; });
  const act = async (task, kind2) => {
    const p = projectRef.current;
    mark(task.id, true);
    const r = await ask(connection, { type: 'projectTaskAct', project: p, id: task.id, kind: kind2, print: task.print }, 'projectTaskResult');
    mark(task.id, false);
    if (r?.ok) {
      // Marking an Asana task done here is local, as on the Mac: Asana itself is never changed from this list.
      if (kind2 === 'complete' && task.source === 'asana') say('Marked done on this list. Asana is not changed.');
      else if (kind2 === 'delete') say('Deleted.');
    } else say(!r ? 'No answer from your Mac. Try again in a moment.' : r.error === 'changed' ? 'That one changed since you looked. Have another look.' : r.error === 'open-on-mac' ? OPEN_ON_MAC : 'Your Mac did not change that one. Have another look.');
    loadTasks();
    loadProjects(); // the picker's counts
  };
  const add = async () => {
    const t = title.trim();
    const p = projectRef.current;
    if (!t || adding) return;
    setAdding(true);
    const r = await ask(connection, { type: 'projectTaskAdd', project: p, title: t }, 'projectTaskResult');
    setAdding(false);
    // Only the draft that was sent: not a newer one, and not one typed for another project meanwhile.
    if (r?.ok) {
      // Saved. The draft is cleared only if it is still that project's (another project's draft is left alone).
      if (projectRef.current === p) setTitle((cur) => (cur.trim() === t ? '' : cur));
      else say('Added.');
    } else say(!r ? 'No answer from your Mac.' : r.error === 'open-on-mac' ? OPEN_ON_MAC : 'Could not add that.');
    loadTasks();
    loadProjects();
  };
  const sync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncNote(null);
    const p = projectRef.current;
    const r = await ask(connection, { type: 'asanaSync', project: p }, 'asanaSyncResult', 120000);
    setSyncing(false);
    // Every result is about the project it was for: shown only while that project is still the one on screen (Codex
    // rounds 4 and 5). A later look at that project shows the synced list itself.
    if (!alive.current || projectRef.current !== p) { /* another view or project is open now */ }
    // Named, since the note can stay up for a moment after another project is picked (Codex round 7).
    else if (r?.ok) {
      const pname = (Array.isArray(projects) ? projects.find((x) => x.path === p)?.name : null) || 'This project';
      say(r.added ? `${pname}: ${r.added} new from Asana.` : `${pname}: up to date with Asana.`);
    }
    else setSyncNote(r ? SYNC_PROBLEM[r.error] || 'Asana sync failed. Try again in a moment.' : 'No answer from your Mac.');
    loadTasks();
    loadProjects();
  };

  if (projects === null) return <p className="muted pad">Loading projects…</p>;
  if (projects.error) return <p className="muted pad">Could not read the projects from your Mac. <button className="link-btn" onClick={loadProjects}>Try again</button></p>;
  if (!projects.length) return <p className="muted pad">No projects on this Mac yet.</p>;

  const current = list?.project === project ? list : null;
  const tasks = (current?.tasks || []).filter((t) => (kind === 'asana' ? t.source === 'asana' : t.source !== 'asana'));
  const pending = sortOpenTasks(tasks.filter((t) => !t.done));
  const done = tasks.filter((t) => t.done);
  // A task the Mac sent without an id (its id was too long to send whole) can be read but not changed from here.
  const row = (t, i) => (
    <TaskRow key={t.id || `no-id-${i}`} task={t} today={today} busy={!t.id || !!busy[t.id]} expanded={!!t.id && expanded === t.id}
      onExpand={() => { if (t.id) setExpanded((v) => (v === t.id ? null : t.id)); }}
      onToggle={(x) => act(x, x.done ? 'reopen' : 'complete')} onDelete={(x) => act(x, 'delete')} />
  );
  // The count for this view: open to-dos, or open Asana tasks.
  const name = (p) => { const n = kind === 'asana' ? p.asana : p.pending; return `${p.name}${n ? ` (${n})` : ''}`; };
  return <>
    <label className="tasks-project">
      <span className="tasks-project-label">Project</span>
      <select value={project || ''} onChange={(e) => setProject(e.target.value || null)} aria-label="Project">
        {!project && <option value="">Choose…</option>}
        {projects.map((p) => <option key={p.path} value={p.path}>{name(p)}</option>)}
      </select>
    </label>
    {kind === 'todo' && (
      <form className="task-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task" maxLength={500} enterKeyHint="done" aria-label="Add a task" />
        <button type="submit" disabled={!title.trim() || adding}>{adding ? '…' : 'Add'}</button>
      </form>
    )}
    {kind === 'asana' && <>
      <button className="settings-action tasks-sync" onClick={sync} disabled={syncing}>{syncing ? 'Syncing with Asana…' : 'Sync from Asana'}</button>
      <p className="settings-foot">Pulls your Asana tasks and Sam's review lane into this project's list. Checking one off here marks it done on this list only.</p>
      {syncNote && <p className="today-warn">{syncNote}</p>}
    </>}
    {!project && <p className="muted pad">Choose a project to see its list.</p>}
    {project && !current && <p className="muted pad">Loading…</p>}
    {current?.error && <p className="muted pad">{SYNC_PROBLEM[current.error] || 'Could not read this project\'s tasks.'} <button className="link-btn" onClick={loadTasks}>Try again</button></p>}
    {current?.tasks && <>
      {pending.length === 0 && <p className="muted pad">{tasks.length ? 'Everything here is done.' : kind === 'asana' ? 'No Asana tasks on this project\'s list. Sync to pull them in.' : 'No tasks yet. Add one above.'}</p>}
      {pending.length > 0 && <div className="settings-group task-list">{pending.map(row)}</div>}
      {done.length > 0 && <>
        <button className="today-more" onClick={() => setShowDone((v) => !v)}>Done ({done.length}) {showDone ? '▾' : '▸'}</button>
        {showDone && <div className="settings-group task-list">{done.map(row)}</div>}
      </>}
    </>}
    {kind === 'asana' && asanaCards && asanaCards.length > 0 && <>
      <p className="settings-head">On your Inbox board</p>
      <p className="settings-foot tasks-foot-gap">Closing one of these closes the task in Asana itself, so it asks first.</p>
      {asanaCards.map(cardFor)}
    </>}
  </>;
}

export default function Tasks({ connection, onBack, onOpenTab, startView = null, notice = null }) {
  const features = useFeatures(connection);
  const views = viewsFor(features);
  const supported = !!features?.includes('today');
  const hasCommands = !!features?.includes('commands');
  // A Today notification opens Today; otherwise the view picked last time.
  const [view, setViewState] = useState(() => startView?.view || store.get('dobius-tasks-view') || 'today');
  // A notification while Tasks is already open (each request is a new object, so a second one switches again).
  useEffect(() => { if (startView?.view) setViewState(startView.view); }, [startView]);
  const current = currentView(views, view);
  const setView = (v) => { setViewState(v); store.set('dobius-tasks-view', v); };
  const needInbox = current === 'inbox' || current === 'asana';
  const [today, setToday] = useState(null);
  const [inbox, setInbox] = useState(null);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [busy, setBusy] = useState({});
  const [note, setNote] = useState(null); // { text, action? }
  const [undo, setUndo] = useState(null);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [commands, setCommands] = useState(null);
  const seq = useRef(0);
  const shown = useRef(0);
  const doneSeq = useRef(0);
  const inFlight = useRef(false);
  const inboxRef = useRef(false);
  inboxRef.current = needInbox;
  const cmdSeq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    inFlight.current = true;
    const [t, i] = await Promise.all([
      ask(connection, { type: 'todayRead' }, 'today', 90000),
      inboxRef.current ? ask(connection, { type: 'inboxRead' }, 'inbox', 30000) : Promise.resolve(undefined),
    ]);
    if (mine === seq.current) inFlight.current = false;
    // The newest read to FINISH wins, so slow replies never starve the screen (Codex).
    if (mine < shown.current) return;
    shown.current = mine;
    // A failed read keeps what is on screen; only a first read that fails shows the error.
    setToday((prev) => (t?.ok ? t.data : prev && !prev.error ? prev : { error: true }));
    if (i !== undefined) setInbox((prev) => (i?.ok ? i.data : prev || { ok: false }));
  }, [connection]);

  const loadCommands = useCallback(async () => {
    const mine = ++cmdSeq.current;
    const r = await ask(connection, { type: 'commandsList' }, 'commands', 15000);
    if (mine !== cmdSeq.current) return;
    setCommands((prev) => (r?.ok ? (Array.isArray(r.list) ? r.list : []) : prev && !prev.error ? prev : { error: true }));
  }, [connection]);

  useEffect(() => {
    if (!supported) return undefined;
    load();
    const off = connection.onMessage((m) => {
      // A reconnect, or something changed on the Mac or another phone: read again.
      if (m.type === 'authed' || m.type === 'todayChanged') load();
    });
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { off(); document.removeEventListener('visibilitychange', onVisible); };
  }, [connection, load, supported]);

  useEffect(() => {
    if (!hasCommands) return undefined;
    loadCommands();
    const off = connection.onMessage((m) => { if (m.type === 'authed' || m.type === 'commandsChanged') loadCommands(); });
    const onVisible = () => { if (document.visibilityState === 'visible') loadCommands(); };
    document.addEventListener('visibilitychange', onVisible);
    // "handed back 5m ago" and a running command's result stay current while the list is open.
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadCommands(); }, 60000);
    return () => { off(); clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [connection, loadCommands, hasCommands]);

  // While Claude is still picking, look again every 10 seconds.
  const picking = !!today?.board?.picking;
  useEffect(() => {
    if (!picking) return undefined;
    const t = setInterval(() => { if (!inFlight.current) load(); }, 10000);
    return () => clearInterval(t);
  }, [picking, load]);

  useEffect(() => { if (needInbox && supported) load(); }, [needInbox, supported, load]);

  // New mail reaches the board on its own schedule and sends no event: look again every two
  // minutes while the screen is up (Codex).
  useEffect(() => {
    if (!supported) return undefined;
    const t = setInterval(() => { if (document.visibilityState === 'visible' && !inFlight.current) load(); }, 120000);
    return () => clearInterval(t);
  }, [supported, load]);

  useEffect(() => {
    // Not while its own Undo is on the way, or a slow failure would land on nothing (Codex).
    if (!undo || undo.problem || undo.pending) return undefined;
    const t = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(t);
  }, [undo]);

  const say = useCallback((text, action = null) => {
    const n = { text, action };
    setNote(n);
    setTimeout(() => setNote((cur) => (cur === n ? null : cur)), action ? 8000 : 5000);
  }, []);
  const mark = (id, on) => setBusy((b) => { const n = { ...b }; if (on) n[id] = true; else delete n[id]; return n; });
  useEffect(() => { if (notice?.text) say(notice.text); }, [notice, say]);

  const done = async (card, kind) => {
    const mine = ++doneSeq.current;
    mark(card.id, true);
    // Closing in Asana can take a while: Asana answers before the board does. The print says
    // which version was on screen, so an edit that kept its rev is not closed blind.
    const r = await ask(connection, { type: 'inboxAct', kind, id: card.id, rev: card.rev, print: card.print }, 'todayResult', kind === 'complete' ? 45000 : 15000);
    mark(card.id, false);
    // Undo reopens the card on the board; a task closed in Asana stays closed there. Only the
    // newest Done offers Undo, so a slow reply never swaps the bar to another card (Codex).
    if (r?.ok) { if (kind === 'complete') say('Closed in Asana.'); else if (mine === doneSeq.current) setUndo({ card, key: mine }); }
    else if (!r && connection.status !== 'authed') say('Not connected to your Mac. Try again once it reconnects.');
    else if (r?.changed) say('Something new came in on that one. Have another look.');
    else say(r ? 'The board would not mark that done.' : 'No answer from your Mac. Try again in a moment.');
    load();
  };
  const undoDone = async () => {
    const card = undo?.card;
    const key = undo?.key;
    // One Undo at a time: a second tap could reopen a later Done of the same card (Codex).
    if (!card || undo.pending) return;
    setUndo((cur) => (cur?.key === key ? { ...cur, pending: true } : cur));
    const r = await ask(connection, { type: 'inboxAct', kind: 'undo', id: card.id, rev: card.rev }, 'todayResult');
    // Only the Undo bar this tap came from: a newer Done (even of the same card) has its own key.
    setUndo((cur) => (cur?.key !== key ? cur : r?.ok ? null : { card, key, problem: true }));
    load();
  };
  const snooze = async (card, choice) => {
    mark(card.id, true);
    const r = await ask(connection, { type: 'todaySnooze', id: card.id, choice, print: card.print }, 'todayResult');
    mark(card.id, false);
    if (r?.ok) say(choice === 'week' ? 'Snoozed until next week.' : 'Snoozed until tomorrow.');
    else if (r?.changed) say('That one changed since you looked. Have another look.');
    else say(r ? 'Could not snooze that one.' : 'No answer from your Mac.');
    load();
  };
  const bringBack = async (id, sid) => {
    mark(id, true);
    // With the snooze it saw, so a newer snooze of the card stays put.
    await ask(connection, { type: 'todayUnsnooze', id, sid }, 'todayResult');
    mark(id, false);
    load();
  };

  const waiting = Array.isArray(commands) ? commands.reduce((n, e) => n + e.commands.filter((c) => c.state === 'waiting').length, 0) : 0;
  const header = (
    <header className="top-bar">
      <button className="icon-btn" onClick={onBack} aria-label="Back">‹</button>
      <span className="terminal-name today-head">Tasks</span>
    </header>
  );
  const segments = views && views.length > 1 && (
    <div className="tasks-seg-wrap">
      <div className="seg tasks-seg" role="tablist" aria-label="Tasks views">
        {views.map((v) => (
          <button key={v.id} role="tab" aria-selected={current === v.id} className={`seg-item${current === v.id ? ' on' : ''}`}
            onClick={() => { if (current !== v.id) { setView(v.id); setQuery(''); } }}
            aria-label={v.id === 'commands' && waiting ? `Commands, ${waiting} waiting` : v.label}>
            {v.label}{v.id === 'commands' && waiting > 0 && <span className="seg-badge" aria-hidden="true">{waiting}</span>}
          </button>
        ))}
      </div>
    </div>
  );

  if (views === null) return (
    <div className="screen history">{header}<main className="today-body"><p className="muted pad">Connecting to your Mac…</p></main></div>
  );
  if (!views.length) return (
    <div className="screen history">{header}
      <main className="today-body"><p className="muted pad">This Mac needs a newer Dobius+ to show Tasks here. Update Dobius+ on the Mac.</p></main>
    </div>
  );

  const board = today?.board;
  const day = board?.today || '';
  // Today's cards by Today's date, board cards by the date of the read they came with.
  const cardFor = (c, showReason = false) => <Card key={c.id} card={c} today={showReason ? day : inbox?.today || day} busy={!!busy[c.id]} onDone={done} onSnooze={snooze} showReason={showReason} />;
  let body;
  if (current === 'commands') {
    body = <CommandsView connection={connection} entries={commands} reload={loadCommands} say={say} onOpenTab={onOpenTab} />;
  } else if (current === 'todo' || current === 'asana') {
    const asanaCards = supported && board?.state === 'ok' ? (inbox?.cards || []).filter((c) => c.source === 'asana') : null;
    body = <ProjectView connection={connection} kind={current} say={say} asanaCards={asanaCards} cardFor={(c) => cardFor(c)} />;
  } else if (!today) body = <p className="muted pad">Loading…</p>;
  else if (today.error) body = <p className="muted pad">Could not read Today from your Mac. <button className="link-btn" onClick={load}>Try again</button></p>;
  else if (board?.state !== 'ok') body = <p className="muted pad">{BOARD_PROBLEM[board?.state] || 'Could not read the Inbox board on your Mac.'}</p>;
  else if (current === 'inbox') {
    const q = query.trim().toLowerCase();
    const all = inbox?.cards || [];
    const counts = {};
    for (const c of all) counts[c.source] = (counts[c.source] || 0) + 1;
    // A filter whose cards were all closed falls back to All.
    const src = source !== 'all' && counts[source] ? source : 'all';
    const cards = all.filter((c) => (src === 'all' || c.source === src) && (!q || [c.subject, c.summary, c.who].some((v) => (v || '').toLowerCase().includes(q))));
    body = <>
      <input className="today-search" type="search" placeholder="Search every open card" value={query} onChange={(e) => setQuery(e.target.value)} />
      {Object.keys(counts).length > 1 && (
        <div className="source-chips" role="radiogroup" aria-label="Show cards from">
          {['all', ...Object.keys(counts)].map((s) => (
            <button key={s} role="radio" aria-checked={src === s} className={`source-chip${src === s ? ' on' : ''}`} onClick={() => setSource(s)}>
              {s === 'all' ? `All ${all.length}` : `${SOURCE[s] || s} ${counts[s]}`}
            </button>
          ))}
        </div>
      )}
      {!inbox && <p className="muted pad">Loading every card…</p>}
      {inbox && inbox.ok === false && <p className="muted pad">{BOARD_PROBLEM[inbox.reason] || 'Could not read the Inbox board.'}</p>}
      {inbox?.cards && <p className="today-line">{q || src !== 'all' ? `${cards.length} of ${all.length}` : `${all.length} open`}</p>}
      {cards.map((c) => cardFor(c))}
    </>;
  } else {
    const line = board.picking && board.mode !== 'claude' ? 'Claude is picking your list…'
      : board.mode === 'claude' ? `${board.suggested.length} picked by Claude${board.pickedAt ? ` at ${clock(board.pickedAt)}` : ''}${board.picking ? ', updating…' : ''}`
        : 'Sorted by due date and priority';
    const noticed = today.noticed?.state === 'ok' || today.noticed?.state === 'partial' ? today.noticed.items || [] : [];
    body = <>
      <p className="today-line">{line}</p>
      {board.failing?.length > 0 && <p className="today-warn">Can't read: {board.failing.join(', ')}. Cards from there may be missing.</p>}
      {board.suggested.length === 0 && <p className="muted pad">Nothing picked right now. Inbox shows every open card.</p>}
      {board.suggested.map((c) => cardFor(c, true))}
      {board.otherCount > 0 && <button className="today-more" onClick={() => setView('inbox')}>{board.otherCount} more open cards</button>}
      {board.snoozed?.length > 0 && <>
        <button className="today-more" onClick={() => setShowSnoozed((v) => !v)}>{board.snoozed.length} snoozed {showSnoozed ? '▾' : '▸'}</button>
        {showSnoozed && board.snoozed.map((c) => (
          <div key={c.id} className="today-card snoozed">
            <span className="today-title">{c.subject || c.summary || '(no subject)'}</span>
            <div className="today-meta">{[c.who, c.until ? `back ${new Date(c.until).toLocaleDateString([], { weekday: 'short' })}` : null].filter(Boolean).join(' · ')}</div>
            <div className="today-actions"><button disabled={!!busy[c.id]} onClick={() => bringBack(c.id, c.sid)}>Bring back</button></div>
          </div>
        ))}
      </>}
      {noticed.length > 0 && <>
        <p className="today-line">SamKnows noticed (hints, not sorted)</p>
        {noticed.map((n) => (
          <div key={n.key} className="today-card noticed">
            <span className="today-title">{n.title}</span>
            {n.who && <div className="today-meta">{n.kind === 'promise' ? `You told ${n.who}` : n.who}</div>}
          </div>
        ))}
      </>}
    </>;
  }

  return (
    <div className="screen history">
      {header}
      {segments}
      <main className="today-body">{body}</main>
      {(undo || note) && (
        <div className="today-toast" role="status">
          {undo ? <>
            <span>{undo.problem ? 'Could not undo that.' : 'Marked done.'}</span>
            <button onClick={undoDone} disabled={!!undo.pending}>{undo.pending ? 'Undoing…' : undo.problem ? 'Try again' : 'Undo'}</button>
          </> : <>
            <span>{note.text}</span>
            {note.action && <button onClick={() => { note.action.run(); setNote(null); }}>{note.action.label}</button>}
          </>}
        </div>
      )}
    </div>
  );
}
