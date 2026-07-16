import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../../store/store';
import { motion, AnimatePresence } from 'framer-motion';

const BLANK = { title: '', text: '' };

export default function Prompts() {
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveView = useStore((s) => s.setActiveView);

  const [prompts, setPrompts] = useState([]);
  const [editing, setEditing] = useState(null); // null | { id?, title, text }
  const [flash, setFlash] = useState(null); // id that was just injected

  const load = useCallback(async () => {
    if (!window.electronAPI?.configGetSettings) return;
    const settings = await window.electronAPI.configGetSettings();
    setPrompts(Array.isArray(settings?.prompts) ? settings.prompts : []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (updated) => {
    if (!window.electronAPI?.configUpdateSettings) return;
    await window.electronAPI.configUpdateSettings({ prompts: updated });
    setPrompts(updated);
  };

  const injectPrompt = (prompt) => {
    if (!activeTabId || !window.electronAPI?.terminalWrite) return;
    // Write text without Enter so the user can review / edit before submitting
    window.electronAPI.terminalWrite(activeTabId, prompt.text);
    setFlash(prompt.id);
    setTimeout(() => setFlash(null), 800);
    setActiveView('terminal');
  };

  const saveEditing = async () => {
    if (!editing) return;
    const title = editing.title.trim();
    const text = editing.text.trim();
    if (!title || !text) return;

    let updated;
    if (editing.id) {
      updated = prompts.map((p) => p.id === editing.id ? { ...p, title, text } : p);
    } else {
      const id = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
      updated = [...prompts, { id, title, text, createdAt: Date.now() }];
    }
    await save(updated);
    setEditing(null);
  };

  const deletePrompt = async (id) => {
    await save(prompts.filter((p) => p.id !== id));
  };

  return (
    <div className="h-full flex flex-col p-4 gap-4">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>Prompt Library</h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--dim)' }}>
            Click a prompt to inject it into the active terminal tab.
          </p>
        </div>
        <button
          onClick={() => setEditing({ ...BLANK })}
          className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
          style={{ backgroundColor: 'var(--accent)', color: '#000' }}
        >
          + New Prompt
        </button>
      </div>

      {/* Prompt grid */}
      <div className="flex-1 overflow-y-auto">
        {prompts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2" style={{ color: 'var(--dim)' }}>
            <span className="text-xs">No prompts saved yet.</span>
            <button
              onClick={() => setEditing({ ...BLANK })}
              className="text-xs underline"
              style={{ color: 'var(--accent)' }}
            >
              Add your first prompt
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            <AnimatePresence>
              {prompts.map((p) => (
                <motion.div
                  key={p.id}
                  layout
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  className="rounded-lg p-3 flex items-start gap-3 transition-colors"
                  style={{
                    backgroundColor: flash === p.id ? 'var(--accent)' : 'var(--surface)',
                    border: `1px solid ${flash === p.id ? 'var(--accent)' : 'var(--border)'}`,
                    cursor: 'pointer',
                    transition: 'background-color 0.2s, border-color 0.2s',
                  }}
                  onClick={() => injectPrompt(p)}
                >
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-xs font-semibold truncate"
                      style={{ color: flash === p.id ? '#000' : 'var(--fg)' }}
                    >
                      {p.title}
                    </div>
                    <div
                      className="text-xs mt-0.5 line-clamp-2"
                      style={{
                        color: flash === p.id ? '#000' : 'var(--dim)',
                        fontFamily: "'SF Mono', monospace",
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {p.text}
                    </div>
                  </div>
                  <div className="flex gap-1.5 shrink-0 mt-0.5">
                    <button
                      onClick={(e) => { e.stopPropagation(); setEditing({ id: p.id, title: p.title, text: p.text }); }}
                      className="text-xs px-2 py-1 rounded transition-colors"
                      style={{ color: 'var(--dim)', backgroundColor: 'transparent', border: '1px solid var(--border)' }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); deletePrompt(p.id); }}
                      className="text-xs px-2 py-1 rounded transition-colors"
                      style={{ color: '#f85149', backgroundColor: 'transparent', border: '1px solid var(--border)' }}
                    >
                      Del
                    </button>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Edit modal */}
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
                {editing.id ? 'Edit Prompt' : 'New Prompt'}
              </h3>
              <div className="flex flex-col gap-3">
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--dim)' }}>Title</label>
                  <input
                    autoFocus
                    value={editing.title}
                    onChange={(e) => setEditing((v) => ({ ...v, title: e.target.value }))}
                    placeholder="e.g. Write PR description"
                    className="w-full px-3 py-1.5 rounded text-xs outline-none"
                    style={{
                      backgroundColor: 'var(--surface)',
                      border: '1px solid var(--border)',
                      color: 'var(--fg)',
                    }}
                  />
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--dim)' }}>Prompt text</label>
                  <textarea
                    value={editing.text}
                    onChange={(e) => setEditing((v) => ({ ...v, text: e.target.value }))}
                    placeholder="Write a concise PR description for the changes above..."
                    rows={5}
                    className="w-full px-3 py-2 rounded text-xs outline-none resize-none"
                    style={{
                      backgroundColor: 'var(--surface)',
                      border: '1px solid var(--border)',
                      color: 'var(--fg)',
                      fontFamily: "'SF Mono', monospace",
                    }}
                  />
                </div>
                <div className="flex justify-end gap-2 mt-1">
                  <button
                    onClick={() => setEditing(null)}
                    className="px-4 py-1.5 rounded text-xs"
                    style={{ color: 'var(--dim)', border: '1px solid var(--border)' }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveEditing}
                    disabled={!editing.title.trim() || !editing.text.trim()}
                    className="px-4 py-1.5 rounded text-xs font-medium"
                    style={{
                      backgroundColor: 'var(--accent)',
                      color: '#000',
                      opacity: (!editing.title.trim() || !editing.text.trim()) ? 0.5 : 1,
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
