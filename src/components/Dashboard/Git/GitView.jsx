import { useState, useEffect, useCallback } from 'react';
import { useGit } from '../../../hooks/useGit';
import GitStatusBar from './GitStatusBar';
import CommitLog from './CommitLog';
import BranchList from './BranchList';
import PullRequests from './PullRequests';
import IssuesList from './IssuesList';
import DiffViewer from './DiffViewer';

const SUB_TABS = [
  { id: 'commits', label: 'Commits' },
  { id: 'branches', label: 'Branches' },
  { id: 'prs', label: 'PRs' },
  { id: 'issues', label: 'Issues' },
];

export default function GitView() {
  const [projectDir, setProjectDir] = useState(null);
  const [subTab, setSubTab] = useState('commits');
  const [selectedHash, setSelectedHash] = useState(null);
  const [configLoaded, setConfigLoaded] = useState(false);

  // Load saved git project dir from config (reuse monitoredBuildDir if available)
  useEffect(() => {
    if (!window.electronAPI) {
      setConfigLoaded(true);
      return;
    }
    window.electronAPI.configLoad().then((config) => {
      if (config?.gitProjectDir) {
        setProjectDir(config.gitProjectDir);
      } else if (config?.monitoredBuildDir) {
        setProjectDir(config.monitoredBuildDir);
      }
      setConfigLoaded(true);
    });
  }, []);

  const { status, commits, branches, ghAvailable, pullRequests, issues, loading, refresh, loadDiff } = useGit(projectDir);

  const handlePickDirectory = useCallback(async () => {
    if (!window.electronAPI) return;
    const dir = await window.electronAPI.buildMonitorPickDirectory();
    if (dir) {
      setProjectDir(dir);
      const config = await window.electronAPI.configLoad();
      config.gitProjectDir = dir;
      window.electronAPI.configSave(config);
    }
  }, []);

  if (!configLoaded) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-6 h-6 rounded-full animate-pulse" style={{ backgroundColor: 'var(--border)' }} />
      </div>
    );
  }

  // Not a git repo or no directory
  if (!projectDir || (!loading && !status?.isRepo)) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8">
        <div className="text-center max-w-sm">
          <div
            className="w-12 h-12 rounded-xl mx-auto mb-4 flex items-center justify-center"
            style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          </div>

          <h3 className="text-sm font-medium mb-1" style={{ color: 'var(--fg)' }}>
            {projectDir ? 'Not a Git Repository' : 'No Project Selected'}
          </h3>
          <p className="text-xs mb-4" style={{ color: 'var(--dim)' }}>
            {projectDir
              ? 'The selected directory is not a git repository.'
              : 'Select a project directory to view its git history, branches, and GitHub data.'}
          </p>

          <button
            onClick={handlePickDirectory}
            className="px-4 py-2 text-xs font-medium rounded-lg transition-all duration-150"
            style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
          >
            Select Project...
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col relative">
      {/* Status bar */}
      <GitStatusBar status={status} onRefresh={refresh} />

      {/* Sub-tab bar */}
      <div
        className="flex items-center gap-0.5 px-4 shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setSubTab(tab.id)}
            className="relative px-3 py-2 text-xs transition-colors duration-150"
            style={{
              color: subTab === tab.id ? 'var(--fg)' : 'var(--dim)',
              fontWeight: subTab === tab.id ? 500 : 400,
            }}
          >
            {tab.label}
            {subTab === tab.id && (
              <span
                className="absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 rounded-full"
                style={{ width: '70%', backgroundColor: 'var(--accent)' }}
              />
            )}
          </button>
        ))}

        {/* Dir path */}
        <div className="ml-auto flex items-center gap-2">
          <span
            className="text-xs truncate max-w-[200px]"
            style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}
          >
            {projectDir.split('/').pop()}
          </span>
          <button
            onClick={handlePickDirectory}
            className="text-xs px-2 py-1 rounded transition-colors duration-150"
            style={{ color: 'var(--dim)', border: '1px solid var(--border)' }}
          >
            Change
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-6 h-6 rounded-full animate-pulse" style={{ backgroundColor: 'var(--border)' }} />
          </div>
        ) : (
          <>
            {subTab === 'commits' && (
              <CommitLog commits={commits} onSelectCommit={setSelectedHash} />
            )}
            {subTab === 'branches' && <BranchList branches={branches} />}
            {subTab === 'prs' && (
              <PullRequests pullRequests={pullRequests} ghAvailable={ghAvailable} />
            )}
            {subTab === 'issues' && (
              <IssuesList issues={issues} ghAvailable={ghAvailable} />
            )}
          </>
        )}
      </div>

      {/* Diff slide-in panel */}
      <DiffViewer
        hash={selectedHash}
        onClose={() => setSelectedHash(null)}
        loadDiff={loadDiff}
      />
    </div>
  );
}
