// Roster sidebar: one row per tab with status chip and time-in-state.
// Clicking a row focuses that tab (same behavior as clicking the character).
import { memo, useEffect, useState } from 'react';

const CHIP_STYLES = {
  working: { background: '#3b2f12', color: '#e4b43a' },
  done:    { background: '#13311f', color: '#37c871' },
  idle:    { background: '#1f1f22', color: '#8a8a93' },
  needs:   { background: '#3b1414', color: '#ff8a8a' },
};
const CHIP_LABEL = { working: 'WORK', done: 'DONE', idle: 'IDLE', needs: 'NEEDS' };

// Short "4m" / "12s" / "1h" style elapsed, Dobius house style.
function elapsed(fromMs) {
  if (!fromMs) return '';
  const s = Math.max(0, Math.floor((Date.now() - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function RosterImpl({ tabs, activeTabId, onFocus }) {
  // Tick for the elapsed labels only; the tab list itself is already a
  // controlled prop. Interval is cheap at 1 Hz regardless of tab count.
  const [, bump] = useState(0);
  useEffect(() => {
    const h = setInterval(() => bump((n) => (n + 1) & 0xffff), 1000);
    return () => clearInterval(h);
  }, []);

  return (
    <>
      {tabs.map((tab) => {
        const chip = CHIP_STYLES[tab.status] || CHIP_STYLES.idle;
        return (
          <button
            type="button"
            key={tab.id}
            onClick={() => onFocus(tab.id)}
            className="office-roster-row"
            data-active={tab.id === activeTabId}
            title={`${tab.projectName || ''} / ${tab.label}`}
          >
            <span className="office-roster-chip" style={chip}>{CHIP_LABEL[tab.status] || 'IDLE'}</span>
            <span className="name">{tab.label}</span>
            <span className="elapsed">{elapsed(tab.stateSince)}</span>
          </button>
        );
      })}
      {tabs.length === 0 && (
        <div style={{ fontSize: '12px', color: 'var(--dim, #8a8a93)', padding: '12px 8px' }}>
          No tabs in this project yet.
        </div>
      )}
    </>
  );
}

export default memo(RosterImpl);
