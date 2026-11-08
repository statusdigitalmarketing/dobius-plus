import { useState, useEffect, useCallback, useRef } from 'react';
import { useFeature } from './Tasks';
import { pushSupported, pushActive, enablePush } from './push-client';
import { isNativeApp, nativePushPermission, enableNativePush } from './native-push';

/**
 * The Mac settings worth changing from the phone: notifications by event, the Claude account new tabs use, what a new
 * tab starts (tool, model, permission mode), Auto Mode and Today alerts. The Mac checks every write against an allowlist
 * (electron/mobile-today.js), so nothing here can turn off the phone server, pairing or keys. Groups the Mac does not
 * advertise (an older Dobius+) are left out.
 */

let reqSeq = 0;
function ask(connection, msg, replyType, ms = 15000) {
  const reqId = `s${Date.now().toString(36)}-${++reqSeq}`;
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

const ERRORS = {
  'quiet-before-morning': 'Quiet time has to be after the morning time.',
  'bad-time': 'Morning has to be between 5:00 and 12:00.',
};

const MODELS = [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['fable', 'Fable'], ['haiku', 'Haiku']];
const PERMISSIONS = [['', 'Default'], ['acceptEdits', 'Accept edits'], ['plan', 'Plan mode'], ['auto', 'Auto mode']];
const WINDOW_NAMES = { five_hour: '5 hour', seven_day: 'Week', seven_day_opus: 'Week, Opus', seven_day_sonnet: 'Week, Sonnet' };

function Switch({ on, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      className={`ios-switch${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
      <span className="ios-switch-knob" />
    </button>
  );
}

function Segmented({ value, options, onChange, disabled, label }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} disabled={disabled}
          className={`seg-item${value === v ? ' on' : ''}`} onClick={() => value !== v && onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

function ToggleRow({ label, on, disabled, onChange }) {
  return <div className="settings-row"><span>{label}</span><Switch label={label} on={on} disabled={disabled} onChange={onChange} /></div>;
}

/**
 * Whether notifications can reach THIS phone, and the one thing to do about it. The PWA uses Web Push (the bell), the
 * App Store app uses APNs, which also needs the Mac's Apple push key.
 */
function useReach(connection, info) {
  const [state, setState] = useState({ checking: true });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const check = useCallback(async () => {
    if (isNativeApp()) setState({ native: true, perm: await nativePushPermission() });
    else setState({ native: false, supported: pushSupported(), active: pushSupported() ? await pushActive(connection) : false });
  }, [connection]);
  useEffect(() => { check(); }, [check, info?.thisPhoneApns]);
  const turnOn = async () => {
    setBusy(true);
    setMsg('');
    const r = isNativeApp() ? await enableNativePush(connection) : await enablePush(connection);
    setBusy(false);
    if (!r.ok) setMsg(r.error || 'Could not turn notifications on.');
    await check();
    return r.ok;
  };
  let line = null;
  let action = null;
  if (state.checking) line = null;
  else if (state.native) {
    if (!info?.apnsReady) line = 'Your Mac cannot send to this app yet: its Apple push key is not set up. Until then nothing arrives here.';
    else if (state.perm === 'denied') line = 'Notifications are off for Dobius+ in iPhone Settings. Turn them on there to get these.';
    else if (state.perm !== 'granted' || !info?.thisPhoneApns) { line = 'Notifications are not on for this phone yet.'; action = 'Turn On Notifications'; }
  } else if (!state.supported) {
    line = 'This browser cannot get notifications. Add Dobius+ to your Home Screen from Safari (Share, then Add to Home Screen) and open it from there.';
  } else if (!state.active) { line = 'Notifications are not on for this phone yet.'; action = 'Turn On Notifications'; }
  return { line, action, turnOn, busy, msg, ready: !state.checking && !line };
}

function Notifications({ data, connection, write, saving, onChanged }) {
  const a = data.phoneAlerts;
  const reach = useReach(connection, data.info);
  const set = (k) => (v) => write('phoneAlerts', { [k]: v });
  return (
    <>
      <p className="settings-head">Notifications</p>
      {reach.line && (
        <div className="settings-group settings-warn" role="status">
          <p className="settings-warn-text">{reach.line}</p>
          {reach.action && (
            <button type="button" className="settings-action" disabled={reach.busy}
              onClick={async () => { if (await reach.turnOn()) onChanged(); }}>
              {reach.busy ? 'Turning On…' : reach.action}
            </button>
          )}
          {reach.msg && <p className="settings-warn-text dim">{reach.msg}</p>}
        </div>
      )}
      <div className={`settings-group${reach.line ? ' spaced' : ''}`}>
        <ToggleRow label="A tab needs you" on={a.needs} disabled={saving} onChange={set('needs')} />
        <ToggleRow label="A tab finished" on={a.done} disabled={saving} onChange={set('done')} />
        <ToggleRow label="A command was handed back" on={a.handoff} disabled={saving} onChange={set('handoff')} />
        <ToggleRow label="A team message arrived" on={a.team} disabled={saving} onChange={set('team')} />
      </div>
      <div className="settings-group spaced">
        <ToggleRow label="Show tab names" on={a.names} disabled={saving} onChange={set('names')} />
        <ToggleRow label="Quiet at night" on={a.quiet} disabled={saving} onChange={set('quiet')} />
      </div>
      <p className="settings-foot">
        {a.names ? 'A notification names the tab and what happened, never what is in it.' : 'Notifications say only what happened, not which tab.'}
        {' '}Quiet at night holds them from {data.todayNudges.quietAfter} to {data.todayNudges.morningAt} (the Today times below). Nothing comes for the tab you are looking at on the Mac.
      </p>
    </>
  );
}

function pct(n) { return Number.isFinite(n) ? `${Math.round(n)}%` : 'Unknown'; }

function UsageBars({ usage, stale }) {
  const windows = (usage?.windows || []).filter((w) => WINDOW_NAMES[w.name]);
  if (!usage?.known || !windows.length) return <span className="acct-usage muted">No usage reported yet</span>;
  return (
    <span className="acct-usage">
      {windows.map((w) => (
        <span key={w.name} className="usage-line">
          <span className="usage-name">{WINDOW_NAMES[w.name]}</span>
          <span className="usage-bar" aria-hidden="true"><span className={`usage-fill${w.used >= 90 ? ' hot' : ''}`} style={{ width: `${Math.min(100, Math.max(0, w.used || 0))}%` }} /></span>
          <span className="usage-pct">{pct(w.used)}</span>
        </span>
      ))}
      {stale && <span className="usage-stale">Not refreshed lately</span>}
    </span>
  );
}

function Accounts({ connection, onChanged }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const r = await ask(connection, { type: 'accountsRead' }, 'accounts', 30000);
    if (mine !== seq.current) return;
    setList(r?.ok ? r.data : { failed: true });
  }, [connection]);
  useEffect(() => {
    load();
    return connection.onMessage((m) => { if (m.type === 'authed' || m.type === 'settingsChanged') load(); });
  }, [connection, load]);
  const choose = async (row) => {
    if (row.active || busy || row.selectable === false) return;
    setBusy(true);
    setError('');
    const r = await ask(connection, { type: 'accountActivate', id: row.isDefault ? null : row.id }, 'accountResult');
    setBusy(false);
    if (!r) setError('No answer from your Mac. Try again in a moment.');
    else if (!r.ok) setError(r.error === 'unavailable' ? 'Your Mac would not switch accounts.' : r.error || 'Your Mac would not switch accounts.');
    load();
    onChanged();
  };
  if (!list) return <><p className="settings-head">Claude account</p><div className="settings-group"><div className="settings-row"><span className="muted">Loading…</span></div></div></>;
  if (list.failed) return <><p className="settings-head">Claude account</p><div className="settings-group"><div className="settings-row"><span className="muted">Could not read accounts.</span><button className="link-btn" onClick={load}>Try again</button></div></div></>;
  if (list.unsupported) return null;
  return (
    <>
      <p className="settings-head">Claude account</p>
      <div className="settings-group">
        {list.claude.map((row, i) => (
          <button key={`${i}:${row.id ?? 'default'}`} type="button" className="settings-row acct-row" aria-pressed={row.active} disabled={busy}
            onClick={() => choose(row)}>
            <span className="acct-main">
              <span className="acct-name">{row.label}{row.login === 'out' ? <span className="acct-tag">Signed out</span> : null}</span>
              {row.email && <span className="acct-email">{row.email}</span>}
              <UsageBars usage={row.usage} stale={row.stale} />
            </span>
            <span className="acct-check" aria-hidden="true">{row.active ? '✓' : ''}</span>
          </button>
        ))}
      </div>
      <p className="settings-foot">New tabs on your Mac start on the checked account. Tabs already running stay where they are.</p>
      {error && <p className="today-warn">{error}</p>}
      {list.codex.length > 1 && (
        <>
          <p className="settings-head">Codex account</p>
          <div className="settings-group">
            {list.codex.map((row, i) => (
              <div key={`${i}:${row.id ?? 'default'}`} className="settings-row acct-row static">
                <span className="acct-main">
                  <span className="acct-name">{row.label}{row.plan ? <span className="acct-tag">{row.plan}</span> : null}</span>
                  {row.email && <span className="acct-email">{row.email}</span>}
                </span>
                <span className="acct-check" aria-hidden="true">{row.active ? '✓' : ''}</span>
              </div>
            ))}
          </div>
          <p className="settings-foot">Switch the Codex account on the Mac (Settings, Accounts).</p>
        </>
      )}
    </>
  );
}

export default function Settings({ connection, onBack, macName }) {
  const supported = useFeature(connection, 'settings');
  const hasAlerts = useFeature(connection, 'alerts');
  const hasAccounts = useFeature(connection, 'accounts');
  const hasChatDefaults = useFeature(connection, 'chatDefaults');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const r = await ask(connection, { type: 'settingsRead' }, 'settings');
    if (mine !== seq.current) return;
    setData(r?.ok ? r.data : { failed: true });
  }, [connection]);

  useEffect(() => {
    if (!supported) return undefined;
    load();
    const off = connection.onMessage((m) => { if (m.type === 'authed' || m.type === 'settingsChanged') load(); });
    return off;
  }, [connection, load, supported]);

  const write = async (key, value) => {
    setSaving(true);
    setError('');
    const r = await ask(connection, { type: 'settingsWrite', key, value }, 'settingsResult');
    setSaving(false);
    if (!r) setError('No answer from your Mac. Try again in a moment.');
    else if (!r.ok) setError(ERRORS[r.error] || 'Your Mac would not save that.');
    load();
  };

  const header = (
    <header className="top-bar">
      <button className="icon-btn" onClick={onBack} aria-label="Back">‹</button>
      <span className="terminal-name today-head">Settings</span>
      <span className="spacer" />
    </header>
  );
  if (supported === null) return <div className="screen history">{header}<main className="today-body"><p className="muted pad">Connecting to your Mac…</p></main></div>;
  if (!supported) return <div className="screen history">{header}<main className="today-body"><p className="muted pad">This Mac needs a newer Dobius+ for Settings here. Update Dobius+ on the Mac.</p></main></div>;
  if (!data) return <div className="screen history">{header}<main className="today-body"><p className="muted pad">Loading…</p></main></div>;
  if (data.failed) return <div className="screen history">{header}<main className="today-body"><p className="muted pad">Could not read settings from your Mac. <button className="link-btn" onClick={load}>Try again</button></p></main></div>;

  const n = data.todayNudges;
  const tool = data.newTabTool;
  return (
    <div className="screen history">
      {header}
      <main className="today-body settings-body">
        {hasAlerts && data.phoneAlerts && <Notifications data={data} connection={connection} write={write} saving={saving} onChanged={load} />}
        {error && <p className="today-warn">{error}</p>}

        {hasAccounts && <Accounts connection={connection} onChanged={load} />}

        <p className="settings-head">New tabs</p>
        <div className="settings-group">
          <div className="settings-row seg-row">
            <span>Start</span>
            <Segmented label="New tab starts" value={tool} disabled={saving} onChange={(v) => write('newTabTool', v)}
              options={[['claude', 'Claude'], ['codex', 'Codex'], ['shell', 'Terminal']]} />
          </div>
          {hasChatDefaults && tool === 'claude' && (
            <>
              <label className="settings-row"><span>Model</span>
                <select value={data.newTabModel || ''} disabled={saving} onChange={(e) => write('newTabModel', e.target.value)}>
                  {MODELS.map(([v, t]) => <option key={v || 'default'} value={v}>{t}</option>)}
                </select>
              </label>
              <label className="settings-row"><span>Permissions</span>
                <select value={data.newTabPermissionMode || ''} disabled={saving} onChange={(e) => write('newTabPermissionMode', e.target.value)}>
                  {PERMISSIONS.map(([v, t]) => <option key={v || 'default'} value={v}>{t}</option>)}
                </select>
              </label>
            </>
          )}
          <div className="settings-row"><span>Auto Mode</span><Switch label="Auto Mode" on={data.autoMode} disabled={saving} onChange={(v) => write('autoMode', v)} /></div>
        </div>
        <p className="settings-foot">
          {hasChatDefaults && tool === 'claude' ? 'Default leaves the choice to Claude. Resumed and restored tabs keep what they had. ' : ''}
          Auto Mode checks Asana and starts new tasks on its own, and still asks before posting to Asana or deploying.
        </p>

        <p className="settings-head">Today alerts</p>
        <div className="settings-group">
          <div className="settings-row"><span>Mac notification</span><Switch label="Mac notification" on={n.mac} disabled={saving} onChange={(v) => write('todayNudges', { mac: v })} /></div>
          <div className="settings-row"><span>Text to yourself</span><Switch label="Text to yourself" on={n.imessage} disabled={saving} onChange={(v) => write('todayNudges', { imessage: v })} /></div>
          <div className="settings-row"><span>Phone notification</span><Switch label="Phone notification" on={n.push} disabled={saving} onChange={(v) => write('todayNudges', { push: v })} /></div>
          <label className="settings-row"><span>Morning</span>
            <input type="time" value={n.morningAt} disabled={saving} onChange={(e) => e.target.value && write('todayNudges', { morningAt: e.target.value })} />
          </label>
          <label className="settings-row"><span>Quiet after</span>
            <input type="time" value={n.quietAfter} disabled={saving} onChange={(e) => e.target.value && write('todayNudges', { quietAfter: e.target.value })} />
          </label>
        </div>
        <p className="settings-foot">
          Alerts say how many things are on Today, never what they are. The first five go out in the morning, the next five once those are done or snoozed.
          {n.imessage && !data.info.imessageReady && ' Texts need your iMessage handle set on the Mac (Settings, iMessage Bridge).'}
          {n.push && !data.info.phonePush && (hasAlerts
            ? ' No phone can get notifications from this Mac yet: turn them on under Notifications above.'
            : ' No phone has notifications on for this Mac yet: tap the bell on the home screen of the web app.')}
        </p>

        <p className="settings-head">This Mac</p>
        <div className="settings-group">
          <div className="settings-row"><span>Name</span><span className="muted">{macName}</span></div>
          <div className="settings-row"><span>Dobius+</span><span className="muted">{data.info.version}</span></div>
          <div className="settings-row"><span>Claude account</span><span className="muted">{data.info.account}</span></div>
        </div>
      </main>
    </div>
  );
}
