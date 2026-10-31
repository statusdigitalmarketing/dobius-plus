// Words for account usage (electron/account-headroom.js shapes), shared by the
// Accounts panel and the Move to account dialog.

const WINDOW_LABEL = {
  five_hour: '5 hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
};
export const windowLabel = (name) => WINDOW_LABEL[name] || name.replace(/_/g, ' ');

// five_hour first, seven_day next, the rest after.
const ORDER = ['five_hour', 'seven_day'];
export const orderedWindows = (windows) => Object.entries(windows || {})
  .sort(([a], [b]) => (ORDER.indexOf(a) === -1 ? 9 : ORDER.indexOf(a)) - (ORDER.indexOf(b) === -1 ? 9 : ORDER.indexOf(b)));

export function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function clock(ms) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
}

export function untilText(epochSeconds) {
  const ms = epochSeconds * 1000 - Date.now();
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  if (m < 90) return `in ${m}m`;
  const h = ms / 3600000;
  return h < 48 ? `in ${Math.round(h)}h` : `in ${Math.round(h / 24)}d`;
}

export const paceText = (pace) => (pace === null || pace === undefined ? 'pace unknown' : `${pace < 10 ? pace.toFixed(1) : Math.round(pace)}%/h`);

export function forecastText(f) {
  if (!f || f.unknown) return 'not enough history to forecast';
  if (f.limited) return f.until ? `limited until ${clock(f.until)}` : 'limited';
  if (f.steady) return 'not climbing';
  if (f.resetsFirst) return 'resets before it runs out';
  return `runs out ~${clock(f.at)}`;
}

export const barColor = (pct) => (pct >= 90 ? '#f87171' : pct >= 75 ? '#fbbf24' : 'var(--accent)');
