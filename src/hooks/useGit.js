import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hook for loading git data for a project directory.
 * Polls every 15s, with 2s rate-limiter to avoid rapid refires.
 */
export function useGit(projectDir) {
  const [status, setStatus] = useState(null);
  const [commits, setCommits] = useState([]);
  const [branches, setBranches] = useState({ current: '', local: [], remote: [] });
  const [ghAvailable, setGhAvailable] = useState(false);
  const [pullRequests, setPullRequests] = useState([]);
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const lastLoad = useRef(0);

  const loadAll = useCallback(async () => {
    if (!window.electronAPI || !projectDir) {
      setLoading(false);
      return;
    }

    // Rate limit: at least 2s between loads
    const now = Date.now();
    if (now - lastLoad.current < 2000) return;
    lastLoad.current = now;

    try {
      const [st, log, br, gh] = await Promise.all([
        window.electronAPI.gitStatus(projectDir),
        window.electronAPI.gitLog(projectDir, 50),
        window.electronAPI.gitBranches(projectDir),
        window.electronAPI.gitGhAvailable(),
      ]);

      setStatus(st);
      setCommits(log);
      setBranches(br);
      setGhAvailable(gh);

      // Load GH data only if available and is a repo
      if (gh && st?.isRepo) {
        const [prs, iss] = await Promise.all([
          window.electronAPI.gitPullRequests(projectDir),
          window.electronAPI.gitIssues(projectDir),
        ]);
        setPullRequests(prs);
        setIssues(iss);
      }
    } catch (err) {
      console.warn('[useGit] Failed to load:', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectDir]);

  // Load on-demand diff
  const loadDiff = useCallback(async (hash) => {
    if (!window.electronAPI || !projectDir) return '';
    try {
      return await window.electronAPI.gitDiff(projectDir, hash);
    } catch {
      return '';
    }
  }, [projectDir]);

  // Initial load + polling
  useEffect(() => {
    if (!projectDir || !window.electronAPI) {
      setLoading(false);
      return;
    }

    setLoading(true);
    loadAll();

    const interval = setInterval(loadAll, 15_000);
    return () => clearInterval(interval);
  }, [projectDir, loadAll]);

  return {
    status,
    commits,
    branches,
    ghAvailable,
    pullRequests,
    issues,
    loading,
    refresh: loadAll,
    loadDiff,
  };
}
