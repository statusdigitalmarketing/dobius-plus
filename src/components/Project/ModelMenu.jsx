import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// The Chat box's model menu (Asana 1220098108555124, Bryan), after the Claude
// app's: the current model with a check and its description, an Effort row
// opening the levels, and More models opening the rest of the catalog.
// Picking one types `/model <id>` or `/effort <level>` into the tab's Claude
// (main checks and builds the command, electron/model-picker.js), which also
// makes it the default for new sessions on that account: Claude's own
// behaviour, said in the footer.
//
// Keyboard: Up/Down move, Enter or Space picks or opens, Right opens a
// submenu, Left or Escape closes it, Escape closes the menu. Like every
// overlay in a project window, keys stop here (ProjectView and the terminals
// listen on window) and a click never takes focus away from it. It renders on
// <body>, placed above the chip: inside the composer the chat's scroll area
// sat on top of it and took the pointer.

const SUBMENUS = { effort: 'Effort', more: 'More models' };

export default function ModelMenu({ anchor, current, catalog, onPick, onClose }) {
  const rootRef = useRef(null);
  const [sub, setSub] = useState(null); // null | 'effort' | 'more'
  const [focus, setFocus] = useState(0); // index in the active list
  const model = useMemo(() => {
    if (!catalog || !current) return null;
    return catalog.models.find((m) => m.id === current.modelId)
      || catalog.models.find((m) => current.modelId.startsWith(`${m.id}-`) || m.id.startsWith(`${current.modelId}-`))
      || null;
  }, [catalog, current]);
  const efforts = model?.efforts || [];
  const others = useMemo(() => {
    const rest = (catalog?.models || []).filter((m) => m.id !== model?.id);
    return [...rest.filter((m) => m.section === 'main'), ...rest.filter((m) => m.section !== 'main')];
  }, [catalog, model]);
  const effortName = efforts.find((e) => e.id === current?.effort)?.name || null;

  // The rows of the list that has the keyboard.
  const mainRows = [
    { key: 'current', kind: 'current' },
    ...(efforts.length ? [{ key: 'effort', kind: 'sub', sub: 'effort' }] : []),
    ...(others.length ? [{ key: 'more', kind: 'sub', sub: 'more' }] : []),
  ];
  const subRows = sub === 'effort'
    ? efforts.map((e) => ({ key: e.id, kind: 'effort', item: e }))
    : sub === 'more' ? others.map((m) => ({ key: m.id, kind: 'model', item: m })) : [];
  const rows = sub ? subRows : mainRows;

  // Above the chip, from its place on screen; a resize closes the menu rather
  // than leave it floating where the chip used to be.
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const r = anchor?.getBoundingClientRect?.();
    if (r) setPos({ left: Math.max(8, r.left - 8), bottom: window.innerHeight - r.top + 8 });
  }, [anchor]);
  useEffect(() => {
    const close = () => onClose('away');
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, [onClose]);
  useEffect(() => { rootRef.current?.focus(); }, [pos]);
  // The main panel is fitted ONCE, when it opens, and never moves while open:
  // moving it put another row under the pointer, so a click meant for a row
  // could pick a model. A submenu that would run past the right edge opens on
  // the left of the panel instead.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !pos) return;
    const over = el.getBoundingClientRect().right - (window.innerWidth - 8);
    if (over > 0) el.style.left = `${Math.max(8, pos.left - over)}px`;
  }, [pos]);
  const [flip, setFlip] = useState(false);
  useLayoutEffect(() => {
    const el = rootRef.current;
    const subEl = el?.querySelector('.chatp-mm-sub');
    if (!subEl) { setFlip(false); return; }
    const panel = el.querySelector('.chatp-mm-panel').getBoundingClientRect();
    const w = subEl.getBoundingClientRect().width;
    setFlip(panel.right + 6 + w > window.innerWidth - 8 && panel.left - 6 - w >= 8);
  }, [sub, pos]);
  // The keyboard's row stays in view in a long list.
  useEffect(() => {
    rootRef.current?.querySelector('.chatp-mm-row.focused')?.scrollIntoView?.({ block: 'nearest' });
  }, [focus, sub]);
  useEffect(() => { setFocus(0); }, [sub]);

  const activate = (row) => {
    if (!row) return;
    if (row.kind === 'current') return onClose('done');
    if (row.kind === 'sub') return setSub(row.sub);
    if (row.kind === 'effort') return onPick({ effort: row.item.id });
    if (row.kind === 'model') return onPick({ model: row.item.id });
  };

  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    const n = rows.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocus((f) => (f + 1) % n); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus((f) => (f - 1 + n) % n); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(rows[focus]); }
    else if (e.key === 'ArrowRight' && !sub && rows[focus]?.kind === 'sub') { e.preventDefault(); setSub(rows[focus].sub); }
    else if ((e.key === 'ArrowLeft' || e.key === 'Escape') && sub) { e.preventDefault(); setSub(null); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); onClose('done'); }
  };

  const rowClass = (list, i) => `chatp-mm-row${(sub ? list === 'sub' : list === 'main') && focus === i ? ' focused' : ''}`;

  if (!pos) return null;
  return createPortal(
    <div
      ref={rootRef}
      className="chatp-mm"
      style={{ left: pos.left, bottom: pos.bottom }}
      role="menu"
      aria-label="Model"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.preventDefault()}
      // Focus went somewhere else (a click elsewhere): close and leave it there.
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) onClose('away'); }}
    >
      <div className="chatp-mm-panel">
        <button type="button" role="menuitemradio" aria-checked="true" className={`${rowClass('main', 0)} chatp-mm-current`} onClick={() => activate(mainRows[0])} onMouseEnter={() => { if (!sub) setFocus(0); }}>
          <span className="chatp-mm-text">
            <span className="chatp-mm-name">{model?.name || current?.modelName || current?.modelId || 'Unknown model'}</span>
            {model?.description && <span className="chatp-mm-desc">{model.description}</span>}
          </span>
          <Check />
        </button>
        {mainRows.length > 1 && <div className="chatp-mm-sep" />}
        {mainRows.slice(1).map((row, k) => (
          <button
            type="button"
            key={row.key}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={sub === row.sub}
            className={`${rowClass('main', k + 1)}${sub === row.sub ? ' open' : ''}`}
            onClick={() => setSub(row.sub)}
            onMouseEnter={() => { setSub(row.sub); }}
          >
            <span className="chatp-mm-label">{SUBMENUS[row.sub]}</span>
            {row.sub === 'effort' && <span className="chatp-mm-value">{effortName || 'Default'}</span>}
            <Chevron />
          </button>
        ))}
        <div className="chatp-mm-note">Also your default for new sessions</div>
      </div>
      {sub && (
        <div className={`chatp-mm-panel chatp-mm-sub chatp-mm-sub-${sub}${flip ? ' flip' : ''}`} role="menu" aria-label={SUBMENUS[sub]}>
          {subRows.map((row, i) => {
            const checked = row.kind === 'effort' ? row.item.id === current?.effort : false;
            return (
              <button
                type="button"
                key={row.key}
                role={row.kind === 'effort' ? 'menuitemradio' : 'menuitem'}
                aria-checked={row.kind === 'effort' ? checked : undefined}
                className={rowClass('sub', i)}
                onClick={() => activate(row)}
                onMouseEnter={() => setFocus(i)}
                title={row.kind === 'model' && row.item.description ? row.item.description : undefined}
              >
                <span className="chatp-mm-label">{row.item.name}</span>
                {row.item.badge && <span className="chatp-mm-badge">{row.item.badge}</span>}
                {checked && <Check />}
              </button>
            );
          })}
        </div>
      )}
    </div>,
    document.body,
  );
}

function Check() {
  return (
    <svg className="chatp-mm-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7" /></svg>
  );
}

function Chevron() {
  return (
    <svg className="chatp-mm-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
  );
}
