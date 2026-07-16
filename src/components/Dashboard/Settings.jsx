import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../../store/store';
import { THEMES } from '../../lib/themes';
import AccountsSection from './AccountsSection';

export default function Settings() {
  const themeIndex = useStore((s) => s.themeIndex);
  const setThemeIndex = useStore((s) => s.setThemeIndex);

  const [settings, setSettings] = useState({
    projectScanDir: '',
    scrollbackLines: 1000,
    terminalFontSize: 13,
    sidebarDefaultOpen: false,
  });
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);

  // Mobile server state
  const [mobileStatus, setMobileStatus] = useState(null);
  const [mobileDevices, setMobileDevices] = useState([]);
  const [mobileBusy, setMobileBusy] = useState(false);
  const [mobileError, setMobileError] = useState('');

  // Asana state
  const [asanaPat, setAsanaPat] = useState('');
  const [asanaPatSaved, setAsanaPatSaved] = useState(false);
  const [asanaPatVisible, setAsanaPatVisible] = useState(false);
  const [autoMode, setAutoMode] = useState({ enabled: false, intervalMinutes: 10 });

  // Terminal-tab status dots — managed Claude Notification hook
  const [statusHooks, setStatusHooks] = useState(false);
  const [statusHooksBusy, setStatusHooksBusy] = useState(false);
  const [statusHooksError, setStatusHooksError] = useState('');

  useEffect(() => {
    window.electronAPI?.asanaGetConfig?.().then((cfg) => {
      if (cfg?.pat) setAsanaPat(cfg.pat);
    });
    window.electronAPI?.autoModeGet?.().then((a) => { if (a) setAutoMode(a); });
    window.electronAPI?.claudeHooksGetStatus?.().then((r) => { if (r) setStatusHooks(!!r.installed); });
  }, []);

  const saveAsanaPat = useCallback(async () => {
    await window.electronAPI?.asanaUpdateConfig?.({ pat: asanaPat.trim() });
    setAsanaPatSaved(true);
    setTimeout(() => setAsanaPatSaved(false), 2000);
  }, [asanaPat]);

  const toggleAutoMode = useCallback(async (on) => {
    const r = await window.electronAPI?.autoModeSetEnabled?.(on);
    setAutoMode((a) => ({ ...a, enabled: r?.enabled ?? on }));
  }, []);

  const toggleStatusHooks = useCallback(async (on) => {
    setStatusHooksBusy(true);
    setStatusHooksError('');
    let r = on
      ? await window.electronAPI?.claudeHooksEnable?.()
      : await window.electronAPI?.claudeHooksDisable?.();
    // Confirm creation of ~/.claude/settings.json on first opt-in. The main
    // process refuses to silently create the file — we ask the user first.
    if (r?.error === 'needs-confirm-create') {
      const ok = window.confirm(`${r.message}\n\nCreate it now?`);
      if (!ok) { setStatusHooksBusy(false); return; }
      r = await window.electronAPI?.claudeHooksEnable?.({ confirmCreate: true });
    }
    if (r?.error) setStatusHooksError(r.error);
    else setStatusHooks(!!r?.installed);
    setStatusHooksBusy(false);
  }, []);

  // iMessage Bridge state
  const [imsgCfg, setImsgCfg] = useState(null);
  const [imsgStatus, setImsgStatus] = useState(null);
  const [imsgBusy, setImsgBusy] = useState(false);
  const [imsgFeedback, setImsgFeedback] = useState('');

  const refreshImsg = useCallback(async () => {
    if (!window.electronAPI?.imessageBridgeGetConfig) return;
    const [cfg, status] = await Promise.all([
      window.electronAPI.imessageBridgeGetConfig(),
      window.electronAPI.imessageBridgeStatus(),
    ]);
    setImsgCfg(cfg);
    setImsgStatus(status);
  }, []);
  useEffect(() => { refreshImsg(); }, [refreshImsg]);

  const saveImsg = useCallback(async (updates) => {
    setImsgBusy(true);
    setImsgFeedback('');
    try {
      await window.electronAPI.imessageBridgeUpdateConfig(updates);
      await refreshImsg();
    } finally {
      setImsgBusy(false);
    }
  }, [refreshImsg]);

  const testImsgSend = useCallback(async () => {
    setImsgBusy(true);
    setImsgFeedback('Sending...');
    try {
      const r = await window.electronAPI.imessageBridgeTestSend();
      setImsgFeedback(r.ok ? 'Sent! Check your Messages app.' : `Failed: ${r.error}`);
    } finally {
      setImsgBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.configGetSettings) return;
    window.electronAPI.configGetSettings().then((s) => {
      setSettings((prev) => ({ ...prev, ...s }));
      setLoaded(true);
    });
  }, []);

  const refreshMobile = useCallback(async () => {
    if (!window.electronAPI?.mobileServerStatus) return;
    const [status, devices] = await Promise.all([
      window.electronAPI.mobileServerStatus(),
      window.electronAPI.mobileServerListDevices(),
    ]);
    setMobileStatus(status);
    setMobileDevices(devices || []);
  }, []);

  useEffect(() => { refreshMobile(); }, [refreshMobile]);

  const toggleMobileServer = useCallback(async (on) => {
    setMobileBusy(true);
    setMobileError('');
    try {
      const status = on
        ? await window.electronAPI.mobileServerStart()
        : await window.electronAPI.mobileServerStop();
      if (status?.error) setMobileError(status.error);
      setMobileStatus(status);
    } finally {
      setMobileBusy(false);
      refreshMobile();
    }
  }, [refreshMobile]);

  const regenMobileCode = useCallback(async () => {
    const status = await window.electronAPI.mobileServerRegenerateCode();
    setMobileStatus(status);
  }, []);

  // v1.0.28: callers now pass the opaque deviceId (not the raw token) —
  // listDevices no longer returns the bearer token to the renderer.
  const removeMobileDevice = useCallback(async (deviceId) => {
    await window.electronAPI.mobileServerRemoveDevice(deviceId);
    refreshMobile();
  }, [refreshMobile]);

  const setMobileBindMode = useCallback(async (mode) => {
    setMobileError('');
    const status = await window.electronAPI.mobileServerSetBindMode(mode);
    if (status?.error) setMobileError(status.error);
    setMobileStatus(status);
  }, []);

  const updateSetting = useCallback((key, value) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      window.electronAPI?.configUpdateSettings?.({ [key]: value });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      return next;
    });
  }, []);

  const handlePickDir = useCallback(async () => {
    if (!window.electronAPI?.buildMonitorPickDirectory) return;
    const dir = await window.electronAPI.buildMonitorPickDirectory();
    if (dir) updateSetting('projectScanDir', dir);
  }, [updateSetting]);

  if (!loaded) {
    return (
      <div className="p-6 space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 rounded animate-pulse" style={{ backgroundColor: 'var(--surface)' }} />
        ))}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--fg)', letterSpacing: '0.1em' }}>
          Settings
        </h2>
        {saved && (
          <span className="text-xs px-2 py-0.5 rounded" style={{ color: 'var(--accent)', backgroundColor: 'var(--surface)' }}>
            Saved
          </span>
        )}
      </div>

      {/* Accounts */}
      <AccountsSection />

      {/* Appearance */}
      <Section title="Appearance">
        <SettingRow label="Theme" description="Terminal and UI color theme">
          <div className="flex items-center gap-2">
            <select
              value={themeIndex}
              onChange={(e) => setThemeIndex(Number(e.target.value))}
              style={{
                backgroundColor: 'var(--bg)',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '4px 8px',
                fontSize: 12,
                fontFamily: "'SF Mono', monospace",
                outline: 'none',
              }}
            >
              {THEMES.map((t, i) => (
                <option key={i} value={i}>{t.name}</option>
              ))}
            </select>
            <div
              className="flex gap-0.5 rounded overflow-hidden"
              style={{ border: '1px solid var(--border)' }}
            >
              {THEMES.map((t, i) => (
                <button
                  key={i}
                  onClick={() => setThemeIndex(i)}
                  title={t.name}
                  style={{
                    width: 16,
                    height: 16,
                    backgroundColor: t.xtermTheme?.background || '#0D1117',
                    border: themeIndex === i ? '2px solid var(--accent)' : 'none',
                  }}
                />
              ))}
            </div>
          </div>
        </SettingRow>

        <SettingRow label="Terminal Font Size" description={`${settings.terminalFontSize}px`}>
          <input
            type="range"
            min={10}
            max={20}
            value={settings.terminalFontSize}
            onChange={(e) => updateSetting('terminalFontSize', Number(e.target.value))}
            style={{ width: 120, accentColor: 'var(--accent)' }}
          />
        </SettingRow>
      </Section>

      {/* Terminal */}
      <Section title="Terminal">
        <SettingRow label="Scrollback Lines" description={`Save up to ${settings.scrollbackLines.toLocaleString()} lines on window close`}>
          <select
            value={settings.scrollbackLines}
            onChange={(e) => updateSetting('scrollbackLines', Number(e.target.value))}
            style={{
              backgroundColor: 'var(--bg)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '4px 8px',
              fontSize: 12,
              fontFamily: "'SF Mono', monospace",
              outline: 'none',
            }}
          >
            <option value={500}>500</option>
            <option value={1000}>1,000</option>
            <option value={2500}>2,500</option>
            <option value={5000}>5,000</option>
            <option value={10000}>10,000</option>
          </select>
        </SettingRow>
      </Section>

      {/* Projects */}
      <Section title="Projects">
        <SettingRow label="Project Scan Directory" description="Dobius+ scans this folder to find your projects">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={settings.projectScanDir}
              onChange={(e) => updateSetting('projectScanDir', e.target.value)}
              placeholder="~/Projects"
              spellCheck={false}
              style={{
                backgroundColor: 'var(--bg)',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '4px 8px',
                fontSize: 12,
                fontFamily: "'SF Mono', monospace",
                outline: 'none',
                width: 200,
              }}
            />
            <button
              onClick={handlePickDir}
              style={{
                padding: '4px 10px',
                fontSize: 11,
                fontFamily: "'SF Mono', monospace",
                color: 'var(--fg)',
                backgroundColor: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              Browse
            </button>
          </div>
        </SettingRow>

        <SettingRow label="Sidebar Default" description="Show session sidebar when opening project windows">
          <Toggle
            checked={settings.sidebarDefaultOpen}
            onChange={(v) => updateSetting('sidebarDefaultOpen', v)}
          />
        </SettingRow>

        <SettingRow
          label="Tab status dots"
          description="Green = done, yellow = working, red = needs you. Installs a Claude notification hook in ~/.claude/settings.json (your other hooks are left untouched)."
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {statusHooksError && (
              <span style={{ color: 'var(--danger)', fontSize: 10, maxWidth: 180 }}>{statusHooksError}</span>
            )}
            <Toggle
              checked={statusHooks}
              disabled={statusHooksBusy}
              onChange={(v) => toggleStatusHooks(v)}
            />
          </div>
        </SettingRow>
      </Section>

      {/* Integrations */}
      <Section title="Integrations">
        <SettingRow label="Asana PAT" description="Personal access token for the Asana sync button in Tasks">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type={asanaPatVisible ? 'text' : 'password'}
              value={asanaPat}
              onChange={(e) => setAsanaPat(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveAsanaPat(); }}
              placeholder="Paste your Asana PAT…"
              style={{
                width: 200,
                backgroundColor: 'var(--bg)',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '4px 8px',
                fontSize: 12,
                fontFamily: "'SF Mono', monospace",
                outline: 'none',
              }}
            />
            <button
              onClick={() => setAsanaPatVisible((v) => !v)}
              title={asanaPatVisible ? 'Hide' : 'Show'}
              style={{ background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', fontSize: 13, padding: '0 2px' }}
            >
              {asanaPatVisible ? '🙈' : '👁'}
            </button>
            <button
              onClick={saveAsanaPat}
              style={{
                padding: '4px 10px',
                fontSize: 11,
                fontFamily: "'SF Mono', monospace",
                color: 'var(--bg)',
                backgroundColor: asanaPatSaved ? 'var(--success, #3fb950)' : 'var(--accent)',
                border: 'none',
                borderRadius: 5,
                cursor: 'pointer',
                transition: 'background 300ms',
              }}
            >
              {asanaPatSaved ? 'Saved' : 'Save'}
            </button>
          </div>
        </SettingRow>

        <SettingRow
          label="Auto Mode"
          description={`Poll Asana every ${autoMode.intervalMinutes || 10} min and auto-run new tasks (build mine + review Sam's). Stops only for your OK before posting to Asana or deploying.`}
        >
          <Toggle checked={!!autoMode.enabled} onChange={toggleAutoMode} />
        </SettingRow>
      </Section>

      {/* Mobile Access */}
      <Section title="Mobile Access">
        <SettingRow
          label="Mobile Server"
          description="Reach your terminals from your phone or iPad"
        >
          <Toggle
            checked={!!mobileStatus?.running}
            onChange={(v) => { if (!mobileBusy) toggleMobileServer(v); }}
          />
        </SettingRow>

        <SettingRow
          label="Network"
          description={mobileStatus?.bindMode === 'lan'
            ? 'LAN: same Wi-Fi only, simplest for testing'
            : 'Tailscale: works anywhere, fully private'}
        >
          <div className="flex rounded overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            {['tailscale', 'lan'].map((mode) => (
              <button
                key={mode}
                onClick={() => setMobileBindMode(mode)}
                style={{
                  padding: '4px 12px',
                  fontSize: 11,
                  fontFamily: "'SF Mono', monospace",
                  color: (mobileStatus?.bindMode || 'tailscale') === mode ? 'var(--bg)' : 'var(--dim)',
                  backgroundColor: (mobileStatus?.bindMode || 'tailscale') === mode ? 'var(--accent)' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {mode === 'lan' ? 'LAN' : 'Tailscale'}
              </button>
            ))}
          </div>
        </SettingRow>

        {mobileError && (
          <div
            className="text-xs px-3 py-2 rounded"
            style={{ backgroundColor: 'var(--surface)', color: 'var(--danger)', border: '1px solid var(--danger)' }}
          >
            {mobileError}
          </div>
        )}

        {mobileStatus?.running && (
          <>
            <SettingRow label="Connect URL" description="Open this on your phone (Tailscale must be on)">
              <code
                className="text-xs px-2 py-1 rounded select-text"
                style={{
                  backgroundColor: 'var(--bg)', color: 'var(--fg)',
                  border: '1px solid var(--border)', fontFamily: "'SF Mono', monospace",
                }}
              >
                {mobileStatus.address ? `http://${mobileStatus.address.host}:${mobileStatus.address.port}` : '...'}
              </code>
            </SettingRow>

            <SettingRow label="Pairing Code" description="Enter once on the phone to pair it">
              <div className="flex items-center gap-2">
                <span
                  className="px-2 py-1 rounded"
                  style={{
                    backgroundColor: 'var(--bg)', color: 'var(--accent)',
                    border: '1px solid var(--border)', fontFamily: "'SF Mono', monospace",
                    fontSize: 16, letterSpacing: '0.2em',
                  }}
                >
                  {mobileStatus.pairingCode || '------'}
                </span>
                <button
                  onClick={regenMobileCode}
                  style={{
                    padding: '4px 10px', fontSize: 11, fontFamily: "'SF Mono', monospace",
                    color: 'var(--fg)', backgroundColor: 'var(--surface)',
                    border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
                  }}
                >
                  Regenerate
                </button>
              </div>
            </SettingRow>

            {mobileDevices.length > 0 && (
              <div>
                <div className="text-xs mb-1.5" style={{ color: 'var(--dim)', fontSize: 10 }}>
                  Paired devices
                </div>
                <div className="space-y-1">
                  {mobileDevices.map((d) => (
                    <div
                      key={d.deviceId || d.token /* legacy */}
                      className="flex items-center justify-between px-2 py-1 rounded"
                      style={{ backgroundColor: 'var(--surface)' }}
                    >
                      <span className="text-xs" style={{ color: 'var(--fg)' }}>{d.name}</span>
                      <button
                        onClick={() => removeMobileDevice(d.deviceId || d.token)}
                        style={{
                          fontSize: 10, color: 'var(--danger)', background: 'none',
                          border: 'none', cursor: 'pointer',
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </Section>

      {/* iMessage Bridge — text yourself to drive Dobius */}
      <Section title="iMessage Bridge">
        <SettingRow
          label="Enable bridge"
          description="Text yourself in iMessage with the prefix below to drive Dobius."
        >
          <Toggle
            checked={!!imsgCfg?.enabled}
            onChange={(on) => saveImsg({ enabled: on })}
          />
        </SettingRow>

        <SettingRow
          label="Trigger prefix"
          description="Commands must start with this. Default 'd:' (e.g. 'd: what tabs are open')."
        >
          <input
            type="text"
            value={imsgCfg?.triggerPrefix || ''}
            onChange={(e) => setImsgCfg({ ...imsgCfg, triggerPrefix: e.target.value })}
            onBlur={() => saveImsg({ triggerPrefix: imsgCfg?.triggerPrefix || 'd:' })}
            maxLength={10}
            style={{
              width: 60, fontSize: 12, padding: '2px 6px',
              fontFamily: "'SF Mono', monospace",
              backgroundColor: 'var(--bg)', color: 'var(--fg)',
              border: '1px solid var(--border)', borderRadius: 4,
            }}
          />
        </SettingRow>

        <SettingRow
          label="Your iMessage handle"
          description="Email or phone Messages.app is signed into (the bridge listens for messages FROM this handle TO itself)."
        >
          <input
            type="text"
            placeholder="you@icloud.com or +1234..."
            value={imsgCfg?.selfHandle || ''}
            onChange={(e) => setImsgCfg({ ...imsgCfg, selfHandle: e.target.value })}
            onBlur={() => saveImsg({ selfHandle: imsgCfg?.selfHandle || null })}
            style={{
              width: 200, fontSize: 12, padding: '2px 6px',
              fontFamily: "'SF Mono', monospace",
              backgroundColor: 'var(--bg)', color: 'var(--fg)',
              border: '1px solid var(--border)', borderRadius: 4,
            }}
          />
        </SettingRow>

        <SettingRow
          label="Full Disk Access"
          description={imsgStatus?.chatDbReadable?.ok
            ? `Granted — ${imsgStatus.chatDbReadable.messageCount.toLocaleString()} messages readable.`
            : `Required — Dobius+ needs to read ~/Library/Messages/chat.db.`}
        >
          <button
            onClick={() => window.electronAPI.imessageBridgeOpenFullDiskAccess()}
            style={{
              fontSize: 11, padding: '4px 10px', borderRadius: 4,
              backgroundColor: 'var(--accent)', color: 'var(--bg)',
              border: 'none', cursor: 'pointer',
            }}
          >
            Open System Settings
          </button>
        </SettingRow>

        <SettingRow
          label="Test send"
          description={imsgFeedback || "Sends a test iMessage to your selfHandle. Confirms send pipeline works."}
        >
          <button
            disabled={imsgBusy || !imsgCfg?.selfHandle}
            onClick={testImsgSend}
            style={{
              fontSize: 11, padding: '4px 10px', borderRadius: 4,
              backgroundColor: 'var(--surface)', color: 'var(--fg)',
              border: '1px solid var(--border)',
              opacity: (imsgBusy || !imsgCfg?.selfHandle) ? 0.5 : 1,
              cursor: (imsgBusy || !imsgCfg?.selfHandle) ? 'not-allowed' : 'pointer',
            }}
          >
            Test
          </button>
        </SettingRow>

        {imsgStatus && (
          <div className="text-xs" style={{ color: 'var(--dim)', fontSize: 10 }}>
            Status: {imsgStatus.isRunning ? 'running' : 'stopped'} ·
            last ROWID: {imsgStatus.lastSeenRowid} ·
            recent outbound (60s): {imsgStatus.outboundLastMin}
          </div>
        )}
      </Section>

      {/* Keyboard Shortcuts */}
      <Section title="Keyboard Shortcuts">
        <div className="space-y-1.5">
          <ShortcutRow keys="Cmd+T" action="New Tab" />
          <ShortcutRow keys="Cmd+W" action="Close Tab" />
          <ShortcutRow keys="Cmd+1-9" action="Switch to Tab N" />
          <ShortcutRow keys="Cmd+Shift+[" action="Previous Tab" />
          <ShortcutRow keys="Cmd+Shift+]" action="Next Tab" />
          <ShortcutRow keys="Cmd+Shift+T" action="Toggle Terminal / Dashboard" />
          <ShortcutRow keys="Cmd+B" action="Toggle Sidebar" />
          <ShortcutRow keys="Cmd+G" action="Toggle Git Panel" />
          <ShortcutRow keys="Cmd+K" action="Clear Terminal" />
          <ShortcutRow keys="Cmd+F" action="Search Terminal" />
          <ShortcutRow keys="Cmd+S" action="Save (CLAUDE.md editor)" />
          <ShortcutRow keys="Cmd+Q x2" action="Quit (press twice)" />
          <ShortcutRow keys="Esc" action="Focus Terminal (from input)" />
          <ShortcutRow keys="Enter" action="Send Command (from input)" />
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div
        className="text-xs font-medium uppercase tracking-wider mb-3 pb-1"
        style={{ color: 'var(--dim)', fontSize: 10, borderBottom: '1px solid var(--border)' }}
      >
        {title}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function SettingRow({ label, description, children }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-xs font-medium" style={{ color: 'var(--fg)' }}>{label}</div>
        {description && (
          <div className="text-xs mt-0.5" style={{ color: 'var(--dim)', fontSize: 10 }}>{description}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, disabled = false }) {
  return (
    <button
      onClick={() => { if (!disabled) onChange(!checked); }}
      disabled={disabled}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        backgroundColor: checked ? 'var(--accent)' : 'var(--border)',
        position: 'relative',
        border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background-color 150ms',
      }}
    >
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          backgroundColor: 'var(--fg)',
          position: 'absolute',
          top: 3,
          left: checked ? 19 : 3,
          transition: 'left 150ms',
        }}
      />
    </button>
  );
}

function ShortcutRow({ keys, action }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs" style={{ color: 'var(--dim)', fontSize: 11 }}>{action}</span>
      <kbd
        className="text-xs px-1.5 py-0.5 rounded"
        style={{
          backgroundColor: 'var(--bg)',
          color: 'var(--fg)',
          border: '1px solid var(--border)',
          fontFamily: "'SF Mono', monospace",
          fontSize: 10,
        }}
      >
        {keys}
      </kbd>
    </div>
  );
}
