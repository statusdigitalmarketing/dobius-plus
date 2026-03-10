import { useState, useEffect, useCallback, useMemo } from 'react';
import { AnimatePresence } from 'framer-motion';
import ProjectCard from './ProjectCard';
import QuitOverlay from '../shared/QuitOverlay';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'pinned', label: 'Favorites' },
  { key: 'open', label: 'Open' },
  { key: 'recent', label: 'Recent' },
];

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export default function ProjectList() {
  const [projects, setProjects] = useState([]);
  const [openProjects, setOpenProjects] = useState([]);
  const [pinnedPaths, setPinnedPaths] = useState([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [searchFocused, setSearchFocused] = useState(false);

  useEffect(() => {
    if (!window.electronAPI) {
      setLoading(false);
      return;
    }

    Promise.all([
      window.electronAPI.dataListProjects(),
      window.electronAPI.windowGetOpen(),
      window.electronAPI.configGetPinnedProjects?.() || [],
    ]).then(([projectList, openList, pinned]) => {
      setProjects(projectList);
      setOpenProjects(openList);
      setPinnedPaths(pinned || []);
      setLoading(false);
    });

    const interval = setInterval(() => {
      window.electronAPI.windowGetOpen().then(setOpenProjects);
    }, 3000);

    const removeWatcher = window.electronAPI.onDataUpdated(() => {
      window.electronAPI.dataListProjects().then(setProjects);
    });

    return () => {
      clearInterval(interval);
      removeWatcher();
    };
  }, []);

  const handleTogglePin = useCallback((projectPath) => {
    setPinnedPaths((prev) => {
      const next = prev.includes(projectPath)
        ? prev.filter((p) => p !== projectPath)
        : [...prev, projectPath];
      window.electronAPI?.configSetPinnedProjects?.(next);
      return next;
    });
  }, []);

  const handleOpenProject = (project) => {
    if (!window.electronAPI || !project.decodedPath) return;
    window.electronAPI.windowOpenProject(project.decodedPath);
    window.electronAPI.windowGetOpen().then(setOpenProjects);
  };

  const { pinned, unpinned } = useMemo(() => {
    const q = search.toLowerCase();
    let list = projects;

    // Search filter
    if (q) {
      list = list.filter(
        (p) =>
          p.displayName.toLowerCase().includes(q) ||
          (p.decodedPath && p.decodedPath.toLowerCase().includes(q))
      );
    }

    // Category filter
    if (filter === 'pinned') {
      list = list.filter((p) => p.decodedPath && pinnedPaths.includes(p.decodedPath));
    } else if (filter === 'open') {
      list = list.filter((p) => p.decodedPath && openProjects.includes(p.decodedPath));
    } else if (filter === 'recent') {
      const cutoff = Date.now() - SEVEN_DAYS_MS;
      list = list.filter((p) => p.latestTimestamp && p.latestTimestamp > cutoff);
    }

    const pin = [];
    const unpin = [];
    for (const p of list) {
      if (p.decodedPath && pinnedPaths.includes(p.decodedPath)) {
        pin.push(p);
      } else {
        unpin.push(p);
      }
    }
    return { pinned: pin, unpinned: unpin };
  }, [projects, search, filter, pinnedPaths, openProjects]);

  const filterCounts = useMemo(() => ({
    all: projects.length,
    pinned: projects.filter((p) => p.decodedPath && pinnedPaths.includes(p.decodedPath)).length,
    open: openProjects.length,
    recent: projects.filter((p) => p.latestTimestamp && p.latestTimestamp > Date.now() - SEVEN_DAYS_MS).length,
  }), [projects, pinnedPaths, openProjects]);

  if (loading) {
    return (
      <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--bg)' }}>
        <div
          className="drag-region flex items-center justify-center shrink-0"
          style={{ height: 52, borderBottom: '1px solid var(--border)' }}
        >
          <h1
            className="text-sm font-semibold tracking-widest uppercase no-drag"
            style={{ color: 'var(--fg)', letterSpacing: '0.15em' }}
          >
            Dobius+
          </h1>
        </div>
        <div className="p-6 grid grid-cols-2 lg:grid-cols-3 gap-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="p-4 rounded-lg animate-pulse"
              style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
            >
              <div className="h-4 w-3/4 rounded" style={{ backgroundColor: 'var(--border)' }} />
              <div className="h-3 w-full mt-2 rounded" style={{ backgroundColor: 'var(--border)' }} />
              <div className="h-3 w-1/2 mt-3 rounded" style={{ backgroundColor: 'var(--border)' }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const renderCard = (project, index) => (
    <ProjectCard
      key={project.encodedPath}
      project={project}
      isOpen={openProjects.includes(project.decodedPath)}
      isPinned={pinnedPaths.includes(project.decodedPath)}
      onClick={() => handleOpenProject(project)}
      onTogglePin={() => handleTogglePin(project.decodedPath)}
      index={index}
    />
  );

  const hasResults = pinned.length > 0 || unpinned.length > 0;

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--bg)' }}>
      {/* Title bar */}
      <div
        className="drag-region flex items-center justify-center shrink-0 relative"
        style={{ height: 52, borderBottom: '1px solid var(--border)' }}
      >
        <h1
          className="text-sm font-semibold tracking-widest uppercase no-drag"
          style={{ color: 'var(--fg)', letterSpacing: '0.15em' }}
        >
          Dobius+
        </h1>
        <span
          className="absolute right-5 text-xs no-drag"
          style={{ color: 'var(--dim)' }}
        >
          {projects.length} project{projects.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Search + filters */}
      <div className="px-6 pt-4 pb-2 shrink-0 space-y-2">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: searchFocused ? 'var(--fg)' : 'var(--dim)', width: 16, height: 16 }}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <circle cx="11" cy="11" r="8" />
            <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            placeholder="Search projects..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            className="w-full pl-9 pr-8 py-2 text-sm rounded-lg outline-none transition-all duration-150"
            style={{
              backgroundColor: 'var(--surface)',
              color: 'var(--fg)',
              border: searchFocused ? '1px solid var(--dim)' : '1px solid var(--border)',
            }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--dim)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}
            >
              &times;
            </button>
          )}
        </div>
        {/* Filter chips */}
        <div className="flex gap-1.5">
          {FILTERS.map((f) => {
            const active = filter === f.key;
            const count = filterCounts[f.key];
            return (
              <button
                key={f.key}
                onClick={() => setFilter(active ? 'all' : f.key)}
                className="px-2.5 py-1 text-xs rounded-lg transition-all duration-100"
                style={{
                  backgroundColor: active ? 'var(--accent)' : 'var(--surface)',
                  color: active ? 'var(--bg)' : 'var(--dim)',
                  border: active ? '1px solid var(--accent)' : '1px solid var(--border)',
                  cursor: 'pointer',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {f.label}{count > 0 ? ` (${count})` : ''}
              </button>
            );
          })}
        </div>
      </div>

      {/* Project grid */}
      <div className="flex-1 overflow-y-auto px-6 pb-6 pt-2">
        {!hasResults ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2">
            <div className="text-sm" style={{ color: 'var(--dim)' }}>
              {search ? 'No matching projects' : filter !== 'all' ? `No ${filter} projects` : 'No projects found'}
            </div>
            {!search && filter === 'all' && (
              <div className="text-xs" style={{ color: 'var(--dim)' }}>
                Start using Claude Code in a project directory to see it here
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Favorites section */}
            {pinned.length > 0 && (
              <div className="mb-4">
                <div
                  className="flex items-center gap-2 mb-2 text-xs font-medium uppercase tracking-wider"
                  style={{ color: 'var(--warning)' }}
                >
                  <span>{'\u2605'}</span>
                  <span>Favorites</span>
                  <span style={{ color: 'var(--dim)', fontWeight: 400 }}>({pinned.length})</span>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                  <AnimatePresence mode="popLayout">
                    {pinned.map((project, index) => renderCard(project, index))}
                  </AnimatePresence>
                </div>
              </div>
            )}

            {/* All others */}
            {unpinned.length > 0 && (
              <div>
                {pinned.length > 0 && (
                  <div
                    className="flex items-center gap-2 mb-2 text-xs font-medium uppercase tracking-wider"
                    style={{ color: 'var(--dim)' }}
                  >
                    <span>All Projects</span>
                    <span style={{ fontWeight: 400 }}>({unpinned.length})</span>
                  </div>
                )}
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                  <AnimatePresence mode="popLayout">
                    {unpinned.map((project, index) => renderCard(project, pinned.length + index))}
                  </AnimatePresence>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <QuitOverlay />
    </div>
  );
}
