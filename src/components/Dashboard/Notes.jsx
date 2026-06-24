import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../../store/store';

// Notes live in <project>/.dobius/NOTES.md so the terminal agent shares them. Each
// note is a `## <title>` section with an optional `_<stamp>_` meta line; this parses
// the file into cards and re-serializes on every save. The parser is lenient so an
// agent appending a `## heading` in the terminal shows up here as a new card.

const BLANK = { title: '', body: '' };
const AUTHOR = 'carson';

function pad(n) { return String(n).padStart(2, '0'); }
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} · ${AUTHOR}`;
}

function parseNotes(md) {
  const lines = (md || '').split('\n');
  const notes = [];
  const preamble = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    const bodyLines = cur.bodyLines;
    let i = 0;
    while (i < bodyLines.length && bodyLines[i].trim() === '') i++;
    // Only consume the first line as the meta/stamp when it actually looks like
    // our stamp (`_YYYY-MM-DD HH:MM · author_`). Matching any `_italic_` line here
    // would silently eat a user's first body line on the next load.
    let meta = '';
    if (i < bodyLines.length && /^_\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b.*_$/.test(bodyLines[i].trim())) {
      meta = bodyLines[i].trim().replace(/^_|_$/g, '');
      bodyLines.splice(0, i + 1);
    }
    notes.push({ title: cur.title, meta, body: bodyLines.join('\n').trim() });
    cur = null;
  };

  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) {
      flush();
      cur = { title: m[1].trim(), bodyLines: [] };
    } else if (cur) {
      cur.bodyLines.push(line);
    } else {
      preamble.push(line);
    }
  }
  flush();

  const pre = preamble.join('\n').trim();
  if (pre) notes.unshift({ title: 'General', meta: '', body: pre });
  return notes;
}

// Note: a `## ` line inside a body is the section delimiter shared with agents,
// so on reload such a line becomes its own card. That's the intended convention
// (agents add notes by appending `## heading` sections), not a bug.
function serializeNotes(notes) {
  const md = notes
    .map((n) => `## ${n.title}\n${n.meta ? `_${n.meta}_\n\n` : ''}${n.body}\n`)
    .join('\n')
    .trim();
  return md ? md + '\n' : '';
}

export default function Notes() {
  const currentProjectPath = useStore((s) => s.currentProjectPath);

  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | { index?, title, body }
  const [error, setError] = useState('');

  const projectName = currentProjectPath
    ? currentProjectPath.replace(/\/+$/, '').split('/').pop()
    : '';

  const load = useCallback(async () => {
    if (!currentProjectPath || !window.electronAPI?.notesRead) { setLoading(false); return; }
    setLoading(true);
    const res = await window.electronAPI.notesRead(currentProjectPath);
    if (res?.error) { setError(res.error); setNotes([]); }
    else { setError(''); setNotes(parseNotes(res?.content || '')); }
    setLoading(false);
  }, [currentProjectPath]);

  useEffect(() => { load(); }, [load]);

  const persist = async (updated) => {
    if (!window.electronAPI?.notesWrite) return false;
    const res = await window.electronAPI.notesWrite(currentProjectPath, serializeNotes(updated));
    if (res?.error) { setError(res.error); return false; }
    setError('');
    setNotes(updated);
    return true;
  };

  const saveEditing = async () => {
    if (!editing) return;
    const title = editing.title.trim();
    const body = editing.body.trim();
    if (!title || !body) return;
    const note = { title, body, meta: stamp() };
    let updated;
    if (editing.index != null) {
      updated = notes.map((n, i) => (i === editing.index ? note : n));
    } else {
      updated = [note, ...notes]; // newest first
    }
    if (await persist(updated)) setEditing(null);
  };

  const deleteNote = async (index) => {
    await persist(notes.filter((_, i) => i !== index));
  };

  // Launcher window has no project — notes are per-project.
  if (!currentProjectPath) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2" style={{ color: 'var(--dim)' }}>
        <span className="text-sm">Notes are per-project.</span>
        <span className="text-xs">Open a project window to take notes for it.</span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-4 gap-4">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>
            Notes — {projectName}
          </h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--dim)' }}>
            Shared with agents via <code style={{ fontFamily: "'SF Mono', monospace" }}>.dobius/NOTES.md</code>.
          </p>
        </div>
        <button
          onClick={() => setEditing({ ...BLANK })}
          className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
          style={{ backgroundColor: 'var(--accent)', color: '#000' }}
        >
          + Add note
        </button>
      </div>

      {error && (
        <div className="text-xs px-3 py-2 rounded shrink-0" style={{ color: 'var(--danger)', border: '1px solid var(--border)' }}>
          {error}
        </div>
      )}

      {/* Notes list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-20 rounded animate-pulse" style={{ backgroundColor: 'var(--surface)' }} />
            ))}
          </div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2" style={{ color: 'var(--dim)' }}>
            <span className="text-xs">No notes yet for this project.</span>
            <button onClick={() => setEditing({ ...BLANK })} className="text-xs underline" style={{ color: 'var(--accent)' }}>
              Add your first note
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 notes-md">
            <AnimatePresence>
              {notes.map((n, index) => (
                <motion.div
                  key={`${n.meta}|${n.title}|${index}`}
                  layout
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  className="rounded-lg p-3"
                  style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold truncate" style={{ color: 'var(--fg)' }}>{n.title}</div>
                      {n.meta && (
                        <div className="text-xs mt-0.5" style={{ color: 'var(--dim)', fontSize: 10 }}>{n.meta}</div>
                      )}
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      <button
                        onClick={() => setEditing({ index, title: n.title, body: n.body })}
                        className="text-xs px-2 py-1 rounded"
                        style={{ color: 'var(--dim)', border: '1px solid var(--border)' }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteNote(index)}
                        className="text-xs px-2 py-1 rounded"
                        style={{ color: 'var(--danger)', border: '1px solid var(--border)' }}
                      >
                        Del
                      </button>
                    </div>
                  </div>
                  {n.body && (
                    <div className="mt-2 text-xs" style={{ color: 'var(--fg)' }}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{n.body}</ReactMarkdown>
                    </div>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Add / edit modal */}
      <AnimatePresence>
        {editing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
            onClick={() => setEditing(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="rounded-xl p-5 w-full max-w-lg shadow-xl"
              style={{ backgroundColor: 'var(--bg)', border: '1px solid var(--border)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--fg)' }}>
                {editing.index != null ? 'Edit note' : 'New note'}
              </h3>
              <div className="flex flex-col gap-3">
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--dim)' }}>Title</label>
                  <input
                    autoFocus
                    value={editing.title}
                    onChange={(e) => setEditing((v) => ({ ...v, title: e.target.value }))}
                    placeholder="e.g. Deploy gotcha"
                    className="w-full px-3 py-1.5 rounded text-xs outline-none"
                    style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--fg)' }}
                  />
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--dim)' }}>Note (markdown)</label>
                  <textarea
                    value={editing.body}
                    onChange={(e) => setEditing((v) => ({ ...v, body: e.target.value }))}
                    placeholder="What did you learn? Agents read this at the start of each session."
                    rows={6}
                    className="w-full px-3 py-2 rounded text-xs outline-none resize-none"
                    style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--fg)', fontFamily: "'SF Mono', monospace" }}
                  />
                </div>
                <div className="flex justify-end gap-2 mt-1">
                  <button onClick={() => setEditing(null)} className="px-4 py-1.5 rounded text-xs" style={{ color: 'var(--dim)', border: '1px solid var(--border)' }}>
                    Cancel
                  </button>
                  <button
                    onClick={saveEditing}
                    disabled={!editing.title.trim() || !editing.body.trim()}
                    className="px-4 py-1.5 rounded text-xs font-medium"
                    style={{ backgroundColor: 'var(--accent)', color: '#000', opacity: (!editing.title.trim() || !editing.body.trim()) ? 0.5 : 1 }}
                  >
                    Save
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Compact markdown styling for note bodies */}
      <style>{`
        .notes-md p { margin: 0.25em 0; line-height: 1.6; }
        .notes-md ul, .notes-md ol { padding-left: 1.3em; margin: 0.25em 0; }
        .notes-md li { margin: 0.1em 0; }
        .notes-md code { font-family: 'SF Mono', monospace; font-size: 0.9em; background: var(--surface-hover); padding: 1px 4px; border-radius: 3px; color: var(--accent); }
        .notes-md pre { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; overflow-x: auto; }
        .notes-md pre code { background: none; padding: 0; color: var(--fg); }
        .notes-md a { color: var(--accent); text-decoration: none; }
        .notes-md strong { color: var(--fg); font-weight: 600; }
        .notes-md h1, .notes-md h2, .notes-md h3 { font-size: 1em; font-weight: 600; margin: 0.4em 0 0.2em; }
      `}</style>
    </div>
  );
}
