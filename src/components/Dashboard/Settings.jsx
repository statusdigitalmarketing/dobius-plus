import { useRef, useState, useEffect, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { buildPairingDeepLink, buildPairingWebLink } from '../../../shared/pairing-link.js';
import { useStore } from '../../store/store';
import { curatedTerminalFontsFor, buildTerminalFontFamily } from '../../lib/terminal-font';
import { THEMES } from '../../lib/themes';
import { normalizeSidebarOrder } from '../../lib/sidebar-order';
import {
  normalizeNewTabTool, normalizeNewTabModel, normalizeNewTabPermissionMode, NEW_TAB_MODELS, NEW_TAB_PERMISSION_MODES,
} from '../../../shared/new-tab.js';
import { isWindows, currentPlatform } from '../../../shared/platform.js';
import { WINDOWS_SHORTCUT_ROWS } from '../../../shared/win-keys.js';
import AccountsSection from './AccountsSection';
import GwsAccounts from './GwsAccounts';
import TeamSection from './TeamSection';

// The terminal fonts offered here: the Mac faces, or the ones Windows ships.
const CURATED_TERMINAL_FONTS = curatedTerminalFontsFor(currentPlatform());
// The new-tab Claude defaults (shared/new-tab.js allowlist), named as a person reads them.
const MODEL_NAMES = { '': "Claude's default model", opus: 'Opus', sonnet: 'Sonnet', fable: 'Fable', haiku: 'Haiku' };
const PERMISSION_NAMES = { '': "Claude's default mode", acceptEdits: 'Accept edits', plan: 'Plan mode', auto: 'Auto mode' };
const SELECT_STYLE = {
  backgroundColor: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '4px 8px',
  fontSize: 12,
  fontFamily: "'SF Mono', monospace",
  outline: 'none',
};

export default function Settings() {
  const themeIndex = useStore((s) => s.themeIndex);
  const setThemeIndex = useStore((s) => s.setThemeIndex);

  const [settings, setSettings] = useState({
    projectScanDir: '',
    scrollbackLines: 1000,
    terminalFontSize: 13,
    terminalFontFamily: '',
    sidebarDefaultOpen: false,
    newTabTool: 'claude',
  });
  // Bumped by every edit here: a settings read that began before an edit must not undo it.
  const editSeq = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);

  // Mobile server state
  const [mobileStatus, setMobileStatus] = useState(null);
  const [qrTarget, setQrTarget] = useState('app'); // what scanning the pairing QR opens: the iPhone app or a browser
  const [mobileDevices, setMobileDevices] = useState([]);
  const [mobileBusy, setMobileBusy] = useState(false);
  const [mobileError, setMobileError] = useState('');

  const [autoMode, setAutoMode] = useState({ enabled: false, intervalMinutes: 10 });

  // Terminal-tab status dots — managed Claude Notification hook
  const [statusHooks, setStatusHooks] = useState(false);
  const [statusHooksBusy, setStatusHooksBusy] = useState(false);
  const [statusHooksError, setStatusHooksError] = useState('');
  // Model + effort on Claude's status line, under the prompt
  const [modelLine, setModelLine] = useState(null);
  const [modelLineBusy, setModelLineBusy] = useState(false);
  const [modelLineError, setModelLineError] = useState('');
  const [voiceConductor, setVoiceConductor] = useState(false);
  const [errorLogPath, setErrorLogPath] = useState('');

  useEffect(() => {
    window.electronAPI?.autoModeGet?.().then((a) => { if (a) setAutoMode(a); });
    window.electronAPI?.claudeHooksGetStatus?.().then((r) => {
      if (!r) return;
      setStatusHooks(!!r.installed);
      // Say when the Codex half cannot be read, instead of a silent off switch.
      if (r.codex?.error) setStatusHooksError(`Codex tabs: ${r.codex.error}`);
    });
    window.electronAPI?.voiceConductorGet?.().then((r) => { if (r) setVoiceConductor(!!r.enabled); });
    window.electronAPI?.errorLogInfo?.().then((r) => { if (r?.path) setErrorLogPath(r.path); });
  }, []);

  const toggleVoiceConductor = useCallback(async (on) => {
    const r = await window.electronAPI?.voiceConductorSet?.(on);
    setVoiceConductor(r?.enabled ?? on);
  }, []);


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
    else {
      setStatusHooks(!!r?.installed);
      // Claude's half worked; say so if Codex's did not, instead of hiding it.
      if (r?.codex?.error) setStatusHooksError(`Codex tabs: ${r.codex.error}`);
    }
    setStatusHooksBusy(false);
  }, []);

  // Account usage (in the Accounts section) installs the same status line, so
  // it announces changes and this re-reads rather than showing a stale switch.
  // Focus covers a change made from another window.
  useEffect(() => {
    const refresh = () => window.electronAPI?.modelLineGetStatus?.().then((r) => { if (r) setModelLine(r); });
    refresh();
    window.addEventListener('dobius:statusline-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('dobius:statusline-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const toggleModelLine = useCallback(async (on) => {
    setModelLineBusy(true);
    setModelLineError('');
    let r = await window.electronAPI?.modelLineSet?.(on);
    // Same consent as the status dots: never create settings.json unasked.
    if (r?.error === 'needs-confirm-create') {
      if (window.confirm(`${r.message}\n\nCreate it now?`)) r = await window.electronAPI?.modelLineSet?.(on, { confirmCreate: true });
      else r = null;
    }
    if (r?.error) setModelLineError(r.error);
    // Account usage shares the status line; this also refreshes the switch here.
    window.dispatchEvent(new Event('dobius:statusline-changed'));
    setModelLineBusy(false);
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
    const a = window.electronAPI;
    if (!a?.configGetSettings) return undefined;
    const read = () => a.configGetSettings().then((s) => {
      setSettings((prev) => ({ ...prev, ...s }));
      setLoaded(true);
    });
    read();
    // The phone can change a few settings: show those as soon as it does, and only those, so a
    // field being typed into here is never reset by an older read (Codex).
    return a.onSettingsChanged?.(() => {
      const at = editSeq.current;
      a.configGetSettings().then((s) => { if (at === editSeq.current) setSettings((prev) => ({ ...prev, todayNudges: s.todayNudges, newTabTool: s.newTabTool, newTabModel: s.newTabModel, newTabPermissionMode: s.newTabPermissionMode })); });
      a.autoModeGet?.().then((m) => { if (m) setAutoMode(m); });
    });
  }, []);

  // Today alerts go through main's check (same rules as the phone), never a raw settings write.
  const [nudgeError, setNudgeError] = useState('');
  const updateNudges = useCallback(async (patch) => {
    const r = await window.electronAPI?.settingsWriteChecked?.('todayNudges', patch);
    if (!r?.ok) {
      setNudgeError(r?.error === 'quiet-before-morning' ? 'Quiet time has to be after the morning time.' : 'That time does not work. Morning is between 5:00 and 12:00.');
      return;
    }
    setNudgeError('');
    const at = editSeq.current;
    const s = await window.electronAPI.configGetSettings();
    if (at === editSeq.current) setSettings((prev) => ({ ...prev, todayNudges: s.todayNudges }));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }, []);
  const nudges = { imessage: true, mac: true, push: true, morningAt: '08:00', quietAfter: '20:00', ...(settings.todayNudges || {}) };

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

  // Poll while the server runs so the displayed pairing code + device list stay
  // current. The server rotates the pairing code on a wrong-guess flood (audit
  // MED-8 / Codex), so without this the desktop could keep showing a stale code
  // that the phone can no longer use. Cheap: one status read every 5s.
  // Also poll while the server is enabled but not yet up (v1.0.77): the main
  // process is retrying the start and this view has to notice when it lands.
  useEffect(() => {
    if (!mobileStatus?.running && !mobileStatus?.enabled) return undefined;
    const i = setInterval(refreshMobile, 5000);
    return () => clearInterval(i);
  }, [mobileStatus?.running, mobileStatus?.enabled, refreshMobile]);

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

  // Text the Mac address, code and pair link to the user's own iMessage, so a
  // phone signed in to the same Apple ID gets it without retyping. main builds
  // the message from the live server state; nothing here supplies the text.
  const [pairTextMsg, setPairTextMsg] = useState('');
  const [pairTextBusy, setPairTextBusy] = useState(false);
  const textPairingToSelf = useCallback(async () => {
    setPairTextBusy(true);
    setPairTextMsg('Sending...');
    try {
      const r = await window.electronAPI.mobileServerTextPairing();
      setPairTextMsg(r?.ok ? 'Sent. Check Messages on your phone.' : `Failed: ${r?.error || 'unknown error'}`);
    } finally {
      setPairTextBusy(false);
    }
  }, []);

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

  const provisionMobileCert = useCallback(async () => {
    setMobileBusy(true);
    setMobileError('');
    try {
      const res = await window.electronAPI.mobileServerProvisionCert();
      if (!res?.ok) setMobileError(res?.error || 'Could not enable HTTPS.');
      if (res?.status) setMobileStatus(res.status);
    } finally {
      setMobileBusy(false);
    }
  }, []);

  // Custom terminal font entry is OPEN (select shows "Custom…") even while
  // the saved value is still a curated name; cleared when a curated font is
  // picked again.
  const [customFontMode, setCustomFontMode] = useState(false);

  const updateSetting = useCallback((key, value) => {
    editSeq.current += 1;
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

      {/* Accounts (Claude login switching: Keychain + /bin/ps, macOS only) */}
      {!isWindows() && <div data-settings-section="accounts"><AccountsSection /></div>}
      <div data-settings-section="gws"><GwsAccounts /></div>

      {/* Appearance */}
      <Section id="appearance" title="Appearance">
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
              className="flex flex-wrap gap-0.5 rounded overflow-hidden"
              // Two rows of 16 swatches: one row of every theme ran past the
              // settings column, and off a narrow window beside the side nav.
              style={{ border: '1px solid var(--border)', maxWidth: 288 }}
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

        <SettingRow
          label="Terminal Font"
          description={(CURATED_TERMINAL_FONTS.find((f) => f.id === settings.terminalFontFamily)?.hint)
            || 'Any installed MONOSPACE font. Proportional faces (Helvetica, Arial) break the terminal grid: boxes and tables stop lining up.'}
        >
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              value={(customFontMode || !CURATED_TERMINAL_FONTS.some((f) => f.id === settings.terminalFontFamily)) ? '__custom__' : settings.terminalFontFamily}
              onChange={(e) => {
                if (e.target.value === '__custom__') {
                  // Open the text field without touching the setting: writing a
                  // placeholder here changed the font before the user typed
                  // anything, and writing the CURRENT value back snapped the
                  // select shut so Custom was unreachable from a curated
                  // choice (Codex, Medium).
                  setCustomFontMode(true);
                  return;
                }
                setCustomFontMode(false);
                updateSetting('terminalFontFamily', e.target.value);
                window.dispatchEvent(new CustomEvent('dobius:terminal-font', { detail: e.target.value }));
              }}
              style={{
                backgroundColor: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '4px 8px', fontSize: 12, outline: 'none',
                fontFamily: buildTerminalFontFamily(settings.terminalFontFamily),
              }}
            >
              {CURATED_TERMINAL_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              <option value="__custom__">Custom…</option>
            </select>
            {(customFontMode || !CURATED_TERMINAL_FONTS.some((f) => f.id === settings.terminalFontFamily)) && (
              <input
                type="text"
                value={settings.terminalFontFamily || ''}
                placeholder="Font name"
                onChange={(e) => {
                  updateSetting('terminalFontFamily', e.target.value);
                  window.dispatchEvent(new CustomEvent('dobius:terminal-font', { detail: e.target.value }));
                }}
                style={{
                  backgroundColor: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)',
                  borderRadius: 6, padding: '4px 8px', fontSize: 12, width: 130, outline: 'none',
                }}
              />
            )}
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
      <Section id="terminal" title="Terminal">
        <SettingRow
          label="New Tab Starts"
          description={isWindows()
            ? 'What a new tab runs in its project folder (Ctrl+Shift+T, or the + project picker), back to your shell when it exits. Restored tabs are left alone.'
            : 'What a new tab runs in its project folder (Cmd+T, or the + project picker), back to your shell when it exits. Needs zsh or bash. Restored tabs are left alone.'}
        >
          <select
            value={normalizeNewTabTool(settings.newTabTool)}
            onChange={(e) => updateSetting('newTabTool', e.target.value)}
            data-testid="new-tab-tool"
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
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="shell">Terminal (nothing starts)</option>
          </select>
        </SettingRow>
        {!isWindows() && normalizeNewTabTool(settings.newTabTool) === 'claude' && (
          <SettingRow
            label="New Claude Tabs Use"
            description="The model and permission mode a new tab's Claude starts with. Claude's own default sends no flag. Resumed and restored tabs keep what they had. Also set from the phone."
          >
            <div style={{ display: 'flex', gap: 6 }}>
              <select
                value={normalizeNewTabModel(settings.newTabModel)}
                onChange={(e) => updateSetting('newTabModel', e.target.value)}
                data-testid="new-tab-model"
                aria-label="Model for new Claude tabs"
                style={SELECT_STYLE}
              >
                {NEW_TAB_MODELS.map((m) => <option key={m || 'default'} value={m}>{MODEL_NAMES[m]}</option>)}
              </select>
              <select
                value={normalizeNewTabPermissionMode(settings.newTabPermissionMode)}
                onChange={(e) => updateSetting('newTabPermissionMode', e.target.value)}
                data-testid="new-tab-permission"
                aria-label="Permission mode for new Claude tabs"
                style={SELECT_STYLE}
              >
                {NEW_TAB_PERMISSION_MODES.map((m) => <option key={m || 'default'} value={m}>{PERMISSION_NAMES[m]}</option>)}
              </select>
            </div>
          </SettingRow>
        )}
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
      <Section id="projects" title="Projects">
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
          label="Sidebar Tab Order"
          description="How the sidebar's Tabs list orders each project's tabs. Same as the tab bar keeps them where you put them; by status puts working tabs first, then ones that need you, waiting, and done."
        >
          <select
            value={normalizeSidebarOrder(settings.sidebarTabOrder)}
            onChange={(e) => {
              updateSetting('sidebarTabOrder', e.target.value);
              window.dispatchEvent(new CustomEvent('dobius:sidebarTabOrder', { detail: e.target.value }));
            }}
            data-testid="sidebar-tab-order"
            aria-label="Sidebar tab order"
            style={SELECT_STYLE}
          >
            <option value="activity">Most recent first</option>
            <option value="tabs">Same as the tab bar</option>
            <option value="status">By status</option>
          </select>
        </SettingRow>

        {/* The status hooks are printf commands that need bash: on a Windows PC
            without Git Bash every Claude hook would fail, so not offered there. */}
        {!isWindows() && (
        <SettingRow
          label="Tab status dots"
          description="Green = done, yellow = working, red = needs you, for Claude and Codex tabs. Adds hooks to ~/.claude/settings.json and ~/.codex/hooks.json (your own hooks are left alone). Codex asks you once to trust its hooks the next time it starts: choose Trust all."
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
        )}

        <SettingRow
          label="Show model under the prompt"
          description={
            modelLine?.installedElsewhere
              ? 'Another copy of Dobius owns Claude\'s status line. Turn this on here to take it over.'
              : modelLine?.theirs && !modelLine?.on
                ? 'You have your own Claude status line. Turning this on puts the model in front of it; yours keeps working and is restored when you turn this off.'
                : 'Shows the model and effort (e.g. Opus 5.5 · extra high) on Claude\'s status line, under the prompt, so it stays visible after the startup banner scrolls away.'
          }
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {modelLineError && (
              <span style={{ color: 'var(--danger)', fontSize: 10, maxWidth: 180 }}>{modelLineError}</span>
            )}
            <Toggle
              checked={!!modelLine?.on}
              disabled={modelLineBusy || modelLine === null}
              onChange={(v) => toggleModelLine(v)}
            />
          </div>
        </SettingRow>

        {Array.isArray(settings.hiddenSessionPaths) && settings.hiddenSessionPaths.length > 0 && (
          <SettingRow
            label="Hidden session sources"
            description="Paths hidden from the Sessions history list (via the Hide button on a project group)"
          >
            <div className="flex flex-col items-end gap-1" style={{ maxWidth: 320 }}>
              {settings.hiddenSessionPaths.map((p) => (
                <div key={p} className="flex items-center gap-2" style={{ maxWidth: '100%' }}>
                  <span
                    className="truncate"
                    title={p}
                    style={{ color: 'var(--dim)', fontSize: 10, fontFamily: "'SF Mono', monospace" }}
                  >
                    {p}
                  </span>
                  <button
                    onClick={() => updateSetting('hiddenSessionPaths', settings.hiddenSessionPaths.filter((x) => x !== p))}
                    title="Unhide: show this source's sessions again"
                    aria-label={`Unhide sessions from ${p}`}
                    style={{
                      padding: '2px 8px',
                      fontSize: 10,
                      fontFamily: "'SF Mono', monospace",
                      color: 'var(--fg)',
                      backgroundColor: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    Unhide
                  </button>
                </div>
              ))}
            </div>
          </SettingRow>
        )}
      </Section>

      {/* Integrations */}
      <Section id="integrations" title="Integrations">
        <SharedKeyRow
          name="ASANA_PAT"
          label="Asana PAT"
          description="For Tasks' Asana sync, Claude, Codex and SamKnows. Saved as ASANA_PAT in ~/.claude/settings.json."
          placeholder="Paste your Asana PAT…"
        />
        <SharedKeyRow
          name="FIREFLIES_API_KEY"
          label="Fireflies API Key"
          description="So Claude, Codex and SamKnows can read your calls. Saved as FIREFLIES_API_KEY in ~/.claude/settings.json."
          placeholder="Paste your Fireflies key…"
        />

        {/* Runs through the Voice Conductor, which is macOS only (Codex round 3). */}
        {!isWindows() && (
        <SettingRow
          label="Auto Mode"
          description={`Poll Asana every ${autoMode.intervalMinutes || 10} min and auto-run new tasks (build mine + review Sam's). Stops only for your OK before posting to Asana or deploying.`}
        >
          <Toggle checked={!!autoMode.enabled} onChange={toggleAutoMode} />
        </SettingRow>
        )}
      </Section>

      {/* Today alerts: counts only, never what a card says */}
      <Section id="today" title="Today Alerts">
        <SettingRow label={isWindows() ? 'Notification' : 'Mac notification'} description="A notification each morning with how many things are on Today, then again as you clear them. Click it to open Today.">
          <Toggle checked={!!nudges.mac} onChange={(v) => updateNudges({ mac: v })} />
        </SettingRow>
        {!isWindows() && (
        <SettingRow label="Text to yourself" description="The same count as an iMessage to your own handle (set under iMessage Bridge). Says how many, never what they are.">
          <Toggle checked={!!nudges.imessage} onChange={(v) => updateNudges({ imessage: v })} />
        </SettingRow>
        )}
        <SettingRow label="Phone notification" description="On a phone with Dobius notifications turned on (the web app added to the Home Screen).">
          <Toggle checked={!!nudges.push} onChange={(v) => updateNudges({ push: v })} />
        </SettingRow>
        <SettingRow label="Morning" description="When the first five go out. Nothing is sent after quiet time.">
          <div className="flex items-center gap-2">
            <input type="time" value={nudges.morningAt} onChange={(e) => e.target.value && updateNudges({ morningAt: e.target.value })}
              className="text-xs px-2 py-1 rounded" style={{ backgroundColor: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)' }} aria-label="Morning time" />
            <span className="text-xs" style={{ color: 'var(--dim)' }}>quiet after</span>
            <input type="time" value={nudges.quietAfter} onChange={(e) => e.target.value && updateNudges({ quietAfter: e.target.value })}
              className="text-xs px-2 py-1 rounded" style={{ backgroundColor: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)' }} aria-label="Quiet time" />
          </div>
        </SettingRow>
        {nudgeError && <div className="text-xs px-3 py-2 rounded" style={{ color: 'var(--red, #e5534b)' }}>{nudgeError}</div>}
      </Section>

      {/* Mobile Access */}
      <Section id="mobile" title="Mobile Access">
        <SettingRow
          label="Mobile Server"
          description="Reach your terminals from your phone or iPad"
        >
          <Toggle
            checked={!!mobileStatus?.enabled}
            onChange={(v) => { if (!mobileBusy) toggleMobileServer(v); }}
          />
        </SettingRow>

        {mobileStatus?.enabled && !mobileStatus?.running && (
          <div
            className="text-xs px-3 py-2 rounded"
            style={{ backgroundColor: 'var(--surface)', color: 'var(--dim)', border: '1px solid var(--border)' }}
          >
            {mobileStatus.tailnetIp
              ? 'Starting... it retries by itself until the server is up. Turn the switch off to stop.'
              : 'Waiting for Tailscale. The server starts on its own as soon as this Mac has a tailnet address. Turn the switch off to stop.'}
          </div>
        )}

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
                {mobileStatus.url
                  || (mobileStatus.address ? `http://${mobileStatus.address.host}:${mobileStatus.address.port}` : '...')}
              </code>
            </SettingRow>

            <SettingRow
              label="HTTPS"
              description={mobileStatus.secure
                ? 'Secure: notifications and install are available. A phone paired over plain HTTP keeps working. For notifications on it: scan the code below, add the page to the Home Screen, open it from there, pair it with the current code, then tap the bell'
                : 'HTTP only: push notifications and installing the app need HTTPS. It turns on by itself once HTTPS Certificates are enabled for your tailnet, and phones paired over HTTP keep working'}
            >
              {mobileStatus.secure ? (
                <span className="text-xs px-2 py-1 rounded" style={{ color: 'var(--accent)', backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
                  Enabled
                </span>
              ) : (
                <button
                  onClick={provisionMobileCert}
                  disabled={mobileBusy}
                  className="text-xs px-3 py-1 rounded"
                  style={{ color: 'var(--bg)', backgroundColor: 'var(--accent)', border: 'none', cursor: mobileBusy ? 'wait' : 'pointer' }}
                >
                  {mobileBusy ? 'Enabling…' : 'Enable HTTPS'}
                </button>
              )}
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

            {mobileStatus.pairingCode && (mobileStatus.address || mobileStatus.url) && (
              <div
                className="flex items-center gap-3 px-3 py-3 rounded"
                style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
              >
                <div style={{ background: '#fff', padding: 8, borderRadius: 6, lineHeight: 0 }}>
                  <QRCodeSVG
                    value={qrTarget === 'app' ? buildPairingDeepLink(mobileStatus) : buildPairingWebLink(mobileStatus)}
                    size={120}
                    level="M"
                    includeMargin={false}
                  />
                </div>
                <div className="text-xs" style={{ color: 'var(--dim)' }}>
                  <div style={{ color: 'var(--fg)', marginBottom: 4, fontWeight: 500 }}>
                    Scan with your iPhone camera
                  </div>
                  <div className="flex gap-1" role="group" aria-label="What the QR code opens" style={{ marginBottom: 6 }}>
                    {[['app', 'iPhone app'], ['browser', 'Safari or Chrome']].map(([value, label]) => (
                      <button
                        key={value}
                        aria-pressed={qrTarget === value}
                        onClick={() => setQrTarget(value)}
                        style={{
                          padding: '3px 8px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
                          color: qrTarget === value ? 'var(--bg)' : 'var(--fg)',
                          backgroundColor: qrTarget === value ? 'var(--accent)' : 'var(--bg)',
                          border: qrTarget === value ? '1px solid var(--accent)' : '1px solid var(--border)',
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {qrTarget === 'app'
                    ? `Opens the Dobius+ app with this ${isWindows() ? 'PC' : 'Mac'} and code filled in, so you only confirm. Needs the app installed: without it the camera finds nothing to open.`
                    : <>Opens Dobius+ in your browser with this {isWindows() ? 'PC' : 'Mac'} filled in{mobileStatus.url?.startsWith('https://')
                      ? ' and this code too, so you only tap “Pair this device.”'
                      : '; type this code there. With HTTPS on, the code is filled in too.'}</>}
                  {' '}Needs Tailscale on the phone. The code rotates on regenerate.
                </div>
              </div>
            )}

            {!isWindows() && mobileStatus.pairingCode && (mobileStatus.address || mobileStatus.url) && (
              <SettingRow
                label="Text it to yourself"
                description={pairTextMsg || (imsgCfg?.selfHandle
                  ? `iMessages the address, code and a pair link to ${imsgCfg.selfHandle}`
                  : 'Set your iMessage handle under iMessage Bridge below first')}
              >
                <button
                  disabled={pairTextBusy || !imsgCfg?.selfHandle}
                  onClick={textPairingToSelf}
                  style={{
                    padding: '4px 10px', fontSize: 11, fontFamily: "'SF Mono', monospace",
                    color: 'var(--fg)', backgroundColor: 'var(--surface)',
                    border: '1px solid var(--border)', borderRadius: 6,
                    opacity: (pairTextBusy || !imsgCfg?.selfHandle) ? 0.5 : 1,
                    cursor: (pairTextBusy || !imsgCfg?.selfHandle) ? 'not-allowed' : 'pointer',
                  }}
                >
                  Text myself the IP URL and the PIN
                </button>
              </SettingRow>
            )}

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

      <div data-settings-section="team">
        <TeamSection Section={Section} SettingRow={SettingRow} Toggle={Toggle} />
      </div>

      {/* iMessage Bridge: text yourself to drive Dobius (Messages.app: macOS only) */}
      {!isWindows() && (
      <Section id="imessage" title="iMessage Bridge">
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
      )}

      {/* Keyboard Shortcuts */}
      <Section id="shortcuts" title="Keyboard Shortcuts">
        {isWindows() ? (
        <div className="space-y-1.5">
          {WINDOWS_SHORTCUT_ROWS.map((r) => <ShortcutRow key={r.keys} keys={r.keys} action={r.action} />)}
        </div>
        ) : (
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
        )}
      </Section>

      <Section id="diagnostics" title="Diagnostics">
        {/* iPhone/Siri voice routing: macOS only */}
        {!isWindows() && (
        <SettingRow
          label="Voice Conductor"
          description="A background Opus session for iPhone voice routing. Off by default: leave it off unless you use the voice Shortcut. When on it self-recycles so it never fills memory."
        >
          <Toggle checked={voiceConductor} onChange={toggleVoiceConductor} />
        </SettingRow>
        )}
        <SettingRow
          label="Error log"
          description={errorLogPath
            ? `Runtime errors and crashes are logged to ${errorLogPath}. Reveal it if something misbehaves so it can be diagnosed.`
            : 'Runtime errors and crashes are logged so issues can be diagnosed from your machine.'}
        >
          <button
            onClick={() => window.electronAPI?.errorLogReveal?.()}
            style={{
              backgroundColor: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
            }}
          >
            Reveal log
          </button>
        </SettingRow>
      </Section>
    </div>
  );
}

// A key kept in the env block of ~/.claude/settings.json, the one spot Claude,
// SamKnows and every Dobius terminal read. Main tells this page only whether
// it is set and its last four characters; the key goes one way, in.
function SharedKeyRow({ name, label, description, placeholder }) {
  const [status, setStatus] = useState({ set: false, hint: null });
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    window.electronAPI?.sharedKeysStatus?.().then((s) => { if (s?.[name]) setStatus(s[name]); })
      .catch((err) => console.warn('[Settings] shared key status failed:', err?.message));
  }, [name]);
  const apply = async (key) => {
    let r;
    try { r = await window.electronAPI?.sharedKeySet?.(name, key); } catch (err) { r = { ok: false, error: `Not saved: ${err?.message || 'unknown error'}` }; }
    if (!r?.ok) {
      setMsg(r?.error || 'Not saved.');
      // A failed save can still have changed something (a Remove clears the
      // older Dobius-only PAT first), so show what is really saved now.
      window.electronAPI?.sharedKeysStatus?.().then((s) => { if (s?.[name]) setStatus(s[name]); })
        .catch((err) => console.warn('[Settings] shared key status failed:', err?.message));
      return;
    }
    setStatus({ set: r.set, hint: r.hint, legacy: false });
    setValue('');
    setMsg(r.set ? 'Saved. New terminal tabs and Claude sessions get it.' : 'Removed.');
    setTimeout(() => setMsg(''), 3000);
  };
  const btn = (primary) => ({
    padding: '4px 10px', fontSize: 11, fontFamily: "'SF Mono', monospace", borderRadius: 5, cursor: 'pointer',
    color: primary ? 'var(--bg)' : 'var(--fg)', backgroundColor: primary ? 'var(--accent)' : 'transparent',
    border: primary ? 'none' : '1px solid var(--border)',
  });
  return (
    <SettingRow label={label} description={description}>
      <div data-testid={`key-${name}`} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 300 }}>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) apply(value); }}
          placeholder={status.set ? 'Paste to replace…' : placeholder}
          autoComplete="off"
          spellCheck={false}
          style={{
            width: status.set ? 150 : 200, backgroundColor: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: "'SF Mono', monospace", outline: 'none',
          }}
        />
        <button type="button" onClick={() => apply(value)} disabled={!value.trim()} style={{ ...btn(true), opacity: value.trim() ? 1 : 0.5 }}>Save</button>
        {status.set && <button type="button" onClick={() => apply('')} style={btn(false)}>Remove</button>}
        {msg ? (
          <span role="status" style={{ flexBasis: '100%', textAlign: 'right', fontSize: 11, color: 'var(--dim)' }}>{msg}</span>
        ) : status.set && (
          <span className="key-status" style={{ flexBasis: '100%', textAlign: 'right', fontSize: 11, color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
            {status.legacy ? `Saved in Dobius only, ends in ${status.hint}. Save it again to share it` : `Saved, ends in ${status.hint}`}
          </span>
        )}
      </div>
    </SettingRow>
  );
}

function Section({ id, title, children }) {
  return (
    <div data-settings-section={id}>
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
