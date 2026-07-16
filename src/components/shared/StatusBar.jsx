import { useStore } from '../../store/store';
import { useState, useEffect } from 'react';

function ctxColor(pct) {
  if (pct >= 95) return '#f85149';
  if (pct >= 80) return '#f0883e';
  if (pct >= 50) return '#e3b341';
  return '#3FB950';
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

function useContextSize(projectPath) {
  const [ctx, setCtx] = useState(null);

  useEffect(() => {
    if (!projectPath || !window.electronAPI?.dataEstimateContextSize) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const result = await window.electronAPI.dataEstimateContextSize(projectPath);
        if (!cancelled) setCtx(result);
      } catch {
        void 0;
      }
    };

    refresh();
    const id = setInterval(refresh, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [projectPath]);

  return ctx;
}

export default function StatusBar() {
  const sessions = useStore((s) => s.sessions);
  const activeProcesses = useStore((s) => s.activeProcesses);
  const tabs = useStore((s) => s.terminalTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const currentBranch = useStore((s) => s.currentBranch);
  const currentIsWorktree = useStore((s) => s.currentIsWorktree);
  const currentDetached = useStore((s) => s.currentDetached);
  const currentIsFork = useStore((s) => s.currentIsFork);
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const ctx = useContextSize(currentProjectPath);
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
      <div className="flex items-center gap-4">
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
          <span>
            {tabs.length} tab{tabs.length !== 1 ? 's' : ''}
            {activeTab ? ` \u00B7 ${activeTab.label}` : ''}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {ctx && (() => {
          const pct = Math.round((ctx.tokens / ctx.maxTokens) * 100);
          const color = ctxColor(pct);
          const tokStr = ctx.tokens >= 1000 ? `${(ctx.tokens / 1000).toFixed(0)}k` : ctx.tokens;
          const maxStr = `${ctx.maxTokens / 1000}k`;
          return (
            <span
              className="flex items-center gap-1.5"
              title={`Context window: ~${ctx.tokens.toLocaleString()} / ${ctx.maxTokens.toLocaleString()} tokens (${pct}%)\nModel: ${ctx.model || 'unknown'}`}
              style={{ cursor: 'default' }}
            >
              <span style={{ color, fontSize: 9 }}>ctx</span>
              <span
                className="relative h-1.5 rounded-full overflow-hidden"
                style={{ width: 40, backgroundColor: 'var(--border)' }}
              >
                <span
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${pct}%`, backgroundColor: color, transition: 'width 0.4s, background-color 0.4s' }}
                />
              </span>
              <span style={{ color, fontSize: 9, fontFamily: "'SF Mono', monospace" }}>{pct}%</span>
            </span>
          );
        })()}
        <span>v2.0</span>
      </div>
    </div>
  );
}
