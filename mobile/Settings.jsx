import { useState, useEffect, useCallback, useRef } from 'react';
import { useFeature } from './Tasks';

/**
 * The few Mac settings worth changing from the phone: Today alerts, what a new tab starts, and
 * Auto Mode. The Mac checks every write against an allowlist (electron/mobile-today.js), so
 * nothing here can turn off the phone server, pairing or keys.
 */

let reqSeq = 0;
function ask(connection, msg, replyType, ms = 15000) {
  const reqId = `s${Date.now().toString(36)}-${++reqSeq}`;
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

function Switch({ on, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      className={`ios-switch${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
      <span className="ios-switch-knob" />
    </button>
  );
}

export default function Settings({ connection, onBack, macName }) {
  const supported = useFeature(connection, 'settings');
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
  return (
    <div className="screen history">
      {header}
      <main className="today-body settings-body">
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
          {n.push && !data.info.phonePush && ' No phone has notifications on for this Mac yet: tap the bell on the home screen of the web app.'}
        </p>
        {error && <p className="today-warn">{error}</p>}

        <p className="settings-head">Sessions</p>
        <div className="settings-group">
          <label className="settings-row"><span>New tab starts</span>
            <select value={data.newTabTool} disabled={saving} onChange={(e) => write('newTabTool', e.target.value)}>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="shell">Terminal</option>
            </select>
          </label>
          <div className="settings-row"><span>Auto Mode</span><Switch label="Auto Mode" on={data.autoMode} disabled={saving} onChange={(v) => write('autoMode', v)} /></div>
        </div>
        <p className="settings-foot">Auto Mode checks Asana and starts new tasks on its own, and still asks before posting to Asana or deploying.</p>

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
