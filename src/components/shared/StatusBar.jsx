import { useStore } from '../../store/store';
import { useState, useEffect } from 'react';
import { modelLabel } from '../../lib/model-label';
import { compactTokens } from '../../lib/compact-tokens';

function ctxColor(pct) {
  if (pct >= 95) return '#f85149';
  if (pct >= 80) return '#f0883e';
  if (pct >= 50) return '#e3b341';
  return '#3FB950';
}

// Context use as a small ring that fills clockwise from 12 o'clock, colored
// by ctxColor. Same geometry idea as t3code's ContextWindowMeter.
function ContextRing({ pct, color }) {
  const r = 5;
  const c = 2 * Math.PI * r;
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
      <circle cx="7" cy="7" r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" />
      <circle
        cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct / 100)}
        style={{ transition: 'stroke-dashoffset 0.4s, stroke 0.4s' }}
      />
    </svg>
  );
}

const SHELLS = ['zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'login', 'fish', '-fish'];

// Monitored terminals: count + how many are actively running (not a bare shell).
function useMonitors() {
  const monitoredTabs = useStore((s) => s.monitoredTabs);
  const tabs = useStore((s) => s.terminalTabs);
  const live = monitoredTabs.filter((id) => tabs.some((t) => t.id === id));
  const key = live.join(',');
  const [activeCount, setActiveCount] = useState(0);

  useEffect(() => {
    if (!window.electronAPI?.terminalGetProcess || live.length === 0) { setActiveCount(0); return; }
    let cancelled = false;
    const poll = async () => {
      let active = 0;
      for (const id of live) {
        try {
          const proc = await window.electronAPI.terminalGetProcess(id);
          if (proc && !SHELLS.includes(String(proc).trim())) active += 1;
        } catch { /* ignore */ }
      }
      if (!cancelled) setActiveCount(active);
    };
    poll();
    const i = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(i); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { count: live.length, activeCount };
}

// Whether the always-on Asana monitor (Auto Mode) is enabled.
function useAsanaMonitor() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!window.electronAPI?.autoModeGet) return;
    let cancelled = false;
    const refresh = () => window.electronAPI.autoModeGet()
      .then((a) => { if (!cancelled) setOn(!!a?.enabled); })
      .catch(() => {});
    refresh();
    const i = setInterval(refresh, 30000);
    return () => { cancelled = true; clearInterval(i); };
  }, []);
  return on;
}

// Context usage for the ACTIVE TAB's own session (v1.0.40). Was per-project:
// it estimated the project's newest-mtime transcript, so with several tabs open
// in one project the bar showed the wrong session. Now it follows the tab you
// are looking at. Re-fires immediately on tab switch (effect keyed on tabId),
// and returns { ctx, loading } so the bar can tell "no session" from "not
// checked yet" and avoid flashing "--" on every switch.
function useContextSize(tabId) {
  const [ctx, setCtx] = useState(null);
  const [loading, setLoading] = useState(!!tabId);

  useEffect(() => {
    if (!tabId || !window.electronAPI?.dataEstimateContextForTab) {
      setCtx(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Clear the previous tab's value immediately on switch, else the render
    // (which shows ctx before considering loading) briefly labels the old tab's
    // % as "this tab". The periodic refresh below does NOT clear, so a live tab
    // does not blink every 30s. Codex v1.0.40 r5 P3.
    setCtx(null);
    setLoading(true);

    const refresh = async () => {
      try {
        const result = await window.electronAPI.dataEstimateContextForTab(tabId);
        if (!cancelled) { setCtx(result); setLoading(false); }
      } catch {
        if (!cancelled) { setCtx(null); setLoading(false); }
      }
    };

    refresh();
    const id = setInterval(refresh, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tabId]);

  return { ctx, loading };
}

export default function StatusBar() {
  const sessions = useStore((s) => s.sessions);
  const activeProcesses = useStore((s) => s.activeProcesses);
  const tabs = useStore((s) => s.terminalTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  // Real app version pulled from main (was hardcoded "v2.0" while package
  // was at 1.0.28, exactly the kind of detail that makes the app feel
  // un-polished). Apple-grade audit P3.
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    if (!window.electronAPI?.updaterGetCurrentVersion) return;
    let cancelled = false;
    window.electronAPI.updaterGetCurrentVersion()
      .then((v) => { if (!cancelled && v) setAppVersion(String(v)); })
      .catch(() => { /* keep blank */ });
    return () => { cancelled = true; };
  }, []);
  const currentBranch = useStore((s) => s.currentBranch);
  const currentIsWorktree = useStore((s) => s.currentIsWorktree);
  const currentDetached = useStore((s) => s.currentDetached);
  const currentIsFork = useStore((s) => s.currentIsFork);
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const { ctx, loading: ctxLoading } = useContextSize(activeTabId);
  const monitors = useMonitors();
  const asanaOn = useAsanaMonitor();

  const hasActive = activeProcesses.length > 0;
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const projectName = currentProjectPath ? currentProjectPath.split('/').filter(Boolean).pop() : '';
  const gitKind = currentDetached ? null : (currentIsFork ? 'fork' : (currentIsWorktree ? 'worktree' : null));

  return (
    <div
      className="flex items-center justify-between px-4 h-6 shrink-0 text-xs"
      style={{
        backgroundColor: 'var(--surface)',
        borderTop: '1px solid var(--border)',
        color: 'var(--dim)',
        fontFamily: "'SF Mono', monospace",
      }}
    >
      <div className="flex items-center gap-4 min-w-0 overflow-hidden">
        {asanaOn && (
          <span className="flex items-center gap-1.5" title="Auto Mode is polling Asana for new tasks" style={{ color: 'var(--fg)' }}>
            <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: '#3FB950', boxShadow: '0 0 4px #3FB950' }} />
            Asana monitor
          </span>
        )}
        {monitors.count > 0 && (
          <span
            className="flex items-center gap-1.5"
            title={`${monitors.count} monitored terminal${monitors.count !== 1 ? 's' : ''} in ${projectName || 'this project'} — ${monitors.activeCount} active`}
            style={{ color: 'var(--fg)' }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full inline-block"
              style={{ backgroundColor: monitors.activeCount > 0 ? '#3FB950' : 'var(--dim)' }}
            />
            {projectName || 'monitor'} ×{monitors.count}
          </span>
        )}
        {(currentBranch || currentDetached) && (
          <span
            className="flex items-center gap-1"
            title={currentDetached
              ? 'Detached HEAD — not on a branch. Polled every 20s, follows the active tab\'s cwd.'
              : `Branch ${currentBranch}${gitKind ? ` (${gitKind})` : ''}. Polled every 20s, follows the active tab's cwd.`}
            style={{ color: 'var(--fg)' }}
          >
            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm-2.25.75a2.25 2.25 0 1 1 3 2.122v1.005A2.25 2.25 0 0 1 10.25 8.5h-3.5a.75.75 0 0 0-.75.75v2.378a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.875a2.25 2.25 0 0 1 .75-.128h3.5a.75.75 0 0 0 .75-.75V5.372A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
            </svg>
            {currentDetached ? 'detached' : currentBranch}
            {gitKind && (
              <span style={{ color: 'var(--accent)', marginLeft: 4 }}>{gitKind}</span>
            )}
          </span>
        )}
        <span>{sessions.length} sessions</span>
        <span className="flex items-center gap-1.5">
          <span
            className="w-1.5 h-1.5 rounded-full inline-block"
            style={{ backgroundColor: hasActive ? 'var(--accent)' : 'var(--dim)' }}
          />
          {hasActive ? `${activeProcesses.length} active` : 'idle'}
        </span>
        {tabs.length > 0 && (
          <span className="truncate min-w-0">
            {tabs.length} tab{tabs.length !== 1 ? 's' : ''}
            {activeTab ? ` \u00B7 ${activeTab.label}` : ''}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {ctx ? (() => {
          const pct = Math.min(100, Math.round((ctx.tokens / ctx.maxTokens) * 100));
          const color = ctxColor(pct);
          return (
            <span
              className="flex items-center gap-1.5"
              data-testid="context-ring"
              role="meter"
              aria-label="Context window used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              title={`This tab's Claude session\nContext window: ~${compactTokens(ctx.tokens)} of ${compactTokens(ctx.maxTokens)} tokens (${pct}%)\n${ctx.tokens.toLocaleString()} / ${ctx.maxTokens.toLocaleString()}\nModel: ${ctx.model || 'unknown'}`}
              style={{ cursor: 'default' }}
            >
              {ctx.model && (
                <span
                  style={{
                    fontSize: 9, fontFamily: "'SF Mono', monospace", color: 'var(--accent)',
                    padding: '1px 5px', borderRadius: 4, backgroundColor: 'var(--accent-muted)',
                  }}
                >
                  {modelLabel(ctx.model)}
                </span>
              )}
              <span style={{ color, fontSize: 9 }}>ctx</span>
              <ContextRing pct={pct} color={color} />
              <span style={{ color, fontSize: 9, fontFamily: "'SF Mono', monospace" }}>{pct}%</span>
            </span>
          );
        })() : (activeTabId && !ctxLoading && (
          // A tab is active but has no live Claude session (bare shell, or a
          // brand-new session with no usage yet). Show a placeholder so the
          // bar's absence is not read as "context is empty". v1.0.40.
          <span
            className="flex items-center gap-1.5"
            title="This tab has no active Claude session"
            style={{ cursor: 'default', color: 'var(--dim)' }}
          >
            <span style={{ fontSize: 9 }}>ctx</span>
            <span style={{ fontSize: 9, fontFamily: "'SF Mono', monospace" }}>--</span>
          </span>
        ))}
        <span>{appVersion ? `v${appVersion}` : ''}</span>
      </div>
    </div>
  );
}
