import { useState } from 'react';

export default function MacSwitcher({ state, busy, error, onSwitch, onRename, onRemove, onAdd, onClose }) {
  const [editing, setEditing] = useState(null);
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState(null);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet mac-sheet" role="dialog" aria-modal="true" aria-label="Paired Macs" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden="true" />
        <div className="mac-sheet-heading"><h2 className="sheet-title">Your Macs</h2><button className="icon-btn" onClick={onClose} aria-label="Close Mac switcher">×</button></div>
        {error && <p className="error mac-error" role="alert">{error}</p>}
        <div className="sheet-list">
          {state.pairings.map((p) => (
            <div className="mac-item" key={p.id}>
              <div className="mac-name">{p.name}{p.id === state.activeId && <span className="summary-chip">Active</span>}</div>
              <div className="mac-origin">{p.origin}</div>
              {editing === p.id ? (
                <form className="mac-rename" onSubmit={async (e) => { e.preventDefault(); if (await onRename(p.id, name)) setEditing(null); }}>
                  <input aria-label="Mac name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
                  <button disabled={busy || !name.trim()} type="submit">Save</button>
                  <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : (
                <div className="mac-item-actions">
                  <button disabled={busy || p.id === state.activeId} onClick={() => onSwitch(p.id)}>Switch</button>
                  <button disabled={busy} onClick={() => { setEditing(p.id); setName(p.name); setRemoving(null); }}>Rename</button>
                  <button disabled={busy} onClick={() => setRemoving(p.id)}>Remove</button>
                </div>
              )}
              {removing === p.id && <div className="mac-remove">
                <p>Remove {p.name} from this app?</p>
                <button disabled={busy} onClick={() => onRemove(p.id)}>Remove Mac</button>
                <button onClick={() => setRemoving(null)}>Cancel</button>
              </div>}
            </div>
          ))}
        </div>
        <div className="mac-add"><button className="primary" disabled={busy} onClick={onAdd}>Add a Mac</button></div>
      </section>
    </div>
  );
}
