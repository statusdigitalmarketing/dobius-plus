import { useState, useEffect, useCallback } from 'react';

function SkillEditor({ skill, onClose }) {
  const [tab, setTab] = useState('claude');
  const [claudeContent, setClaudeContent] = useState('');
  const [jsonContent, setJsonContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    async function load() {
      // Read SKILL.md (canonical), fall back to CLAUDE.md only for any
      // legacy skill that still uses the old filename. Writes always go to
      // SKILL.md so the skill loader (which reads SKILL.md) picks them up.
      // Codex PR#3 r5 P2: previously read+wrote CLAUDE.md, which the loader
      // ignored, so saves looked successful but did nothing.
      const [md, json] = await Promise.all([
        window.electronAPI.skillReadFile(skill.path, 'SKILL.md'),
        window.electronAPI.skillReadFile(skill.path, 'skill.json'),
      ]);
      let content = md.content ?? '';
      if (!content) {
        const legacy = await window.electronAPI.skillReadFile(skill.path, 'CLAUDE.md');
        content = legacy.content ?? '';
      }
      setClaudeContent(content);
      setJsonContent(json.content ?? '');
    }
    load();
  }, [skill.path]);

  const save = useCallback(async () => {
    setSaving(true);
    setStatus('');
    // Always write to SKILL.md (the loader reads SKILL.md; writing to
    // CLAUDE.md as before was a silent no-op).
    const filename = tab === 'claude' ? 'SKILL.md' : 'skill.json';
    const content = tab === 'claude' ? claudeContent : jsonContent;
    const res = await window.electronAPI.skillWriteFile(skill.path, filename, content);
    setSaving(false);
    setStatus(res.ok ? 'Saved' : (res.error || 'Error'));
    if (res.ok) setTimeout(() => setStatus(''), 2000);
  }, [tab, claudeContent, jsonContent, skill.path]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [save, onClose]);

  const activeContent = tab === 'claude' ? claudeContent : jsonContent;
  const setActiveContent = tab === 'claude' ? setClaudeContent : setJsonContent;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        backgroundColor: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: '780px', height: '560px',
          backgroundColor: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)', fontFamily: "'SF Mono', monospace" }}>
            {skill.name}
          </span>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {status && (
              <span style={{ fontSize: '11px', color: status === 'Saved' ? '#4ade80' : '#f87171' }}>
                {status}
              </span>
            )}
            <button
              onClick={save}
              disabled={saving}
              style={{
                fontSize: '11px', padding: '4px 12px', borderRadius: '6px',
                backgroundColor: 'var(--accent, #6366f1)', color: '#fff',
                border: 'none', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={onClose}
              style={{
                fontSize: '13px', background: 'none', border: 'none',
                color: 'var(--dim)', cursor: 'pointer', padding: '2px 6px',
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex', gap: '0',
          borderBottom: '1px solid var(--border)',
          backgroundColor: 'var(--surface)',
        }}>
          {['claude', 'json'].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: '8px 16px', fontSize: '12px', fontFamily: "'SF Mono', monospace",
                background: 'none', border: 'none', cursor: 'pointer',
                color: tab === t ? 'var(--fg)' : 'var(--dim)',
                borderBottom: tab === t ? '2px solid var(--accent, #6366f1)' : '2px solid transparent',
                marginBottom: '-1px',
              }}
            >
              {t === 'claude' ? 'SKILL.md' : 'skill.json'}
            </button>
          ))}
        </div>

        {/* Editor */}
        <textarea
          value={activeContent}
          onChange={(e) => setActiveContent(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1, resize: 'none', outline: 'none', border: 'none',
            padding: '16px', fontSize: '12px', lineHeight: '1.6',
            fontFamily: "'SF Mono', 'Fira Code', monospace",
            backgroundColor: 'var(--bg)', color: 'var(--fg)',
            tabSize: 2,
          }}
        />

        <div style={{
          padding: '6px 16px', borderTop: '1px solid var(--border)',
          fontSize: '10px', color: 'var(--dim)', fontFamily: "'SF Mono', monospace",
        }}>
          {skill.path} · ⌘S to save · Esc to close
        </div>
      </div>
    </div>
  );
}

export default function Skills({ skills }) {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);

  const filtered = search
    ? skills.filter((s) =>
        s.name.toLowerCase().includes(search.toLowerCase()) ||
        (s.description || '').toLowerCase().includes(search.toLowerCase()) ||
        (s.source || '').toLowerCase().includes(search.toLowerCase())
      )
    : skills;

  const grouped = filtered.reduce((acc, skill) => {
    const src = skill.source || 'custom';
    if (!acc[src]) acc[src] = [];
    acc[src].push(skill);
    return acc;
  }, {});

  return (
    <>
      <div className="p-4 flex flex-col gap-3" style={{ height: '100%', overflowY: 'auto' }}>
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--dim)' }}>
            Installed Skills
          </h3>
          <span className="text-xs" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
            {skills.length}
          </span>
        </div>

        {skills.length > 6 && (
          <input
            type="text"
            placeholder="Search skills…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-1.5 rounded-lg text-xs outline-none"
            style={{
              backgroundColor: 'var(--surface)',
              border: '1px solid var(--border)',
              color: 'var(--fg)',
            }}
          />
        )}

        {filtered.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--dim)' }}>
            {search ? 'No skills match your search.' : 'No skills installed.'}
          </div>
        ) : (
          Object.entries(grouped).map(([source, items]) => (
            <div key={source}>
              <div
                className="text-xs font-medium mb-1.5 uppercase tracking-wider"
                style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace", fontSize: '0.65rem' }}
              >
                {source}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {items.map((skill) => (
                  <div
                    key={skill.name + skill.source}
                    className="p-3 rounded-lg"
                    style={{
                      backgroundColor: 'var(--surface)',
                      border: '1px solid var(--border)',
                      cursor: skill.path ? 'pointer' : 'default',
                      transition: 'border-color 0.15s',
                    }}
                    onDoubleClick={() => skill.path && setEditing(skill)}
                    title={skill.path ? 'Double-click to edit' : undefined}
                  >
                    <div className="text-sm font-medium" style={{ color: 'var(--fg)' }}>
                      {skill.name}
                    </div>
                    {skill.description && (
                      <div className="text-xs mt-1 line-clamp-2" style={{ color: 'var(--dim)' }}>
                        {skill.description}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {editing && <SkillEditor skill={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
