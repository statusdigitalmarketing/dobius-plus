import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../../store/store';
import { THEMES } from '../../lib/themes';

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

  useEffect(() => {
    if (!window.electronAPI?.configGetSettings) return;
    window.electronAPI.configGetSettings().then((s) => {
      setSettings((prev) => ({ ...prev, ...s }));
      setLoaded(true);
    });
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
      </Section>

      {/* Keyboard Shortcuts */}
      <Section title="Keyboard Shortcuts">
        <div className="space-y-1.5">
          <ShortcutRow keys="Cmd+T" action="Toggle Terminal / Dashboard" />
          <ShortcutRow keys="Cmd+B" action="Toggle Sidebar" />
          <ShortcutRow keys="Cmd+G" action="Toggle Git Panel" />
          <ShortcutRow keys="Cmd+K" action="Clear Terminal" />
          <ShortcutRow keys="Cmd+F" action="Search Terminal" />
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

function Toggle({ checked, onChange }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        backgroundColor: checked ? 'var(--accent)' : 'var(--border)',
        position: 'relative',
        border: 'none',
        cursor: 'pointer',
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
