import { useState, useEffect } from 'react';
import { AnimatePresence } from 'framer-motion';
import ProjectCard from './ProjectCard';
import QuitOverlay from '../shared/QuitOverlay';

export default function ProjectList() {
  const [projects, setProjects] = useState([]);
  const [openProjects, setOpenProjects] = useState([]);
  const [search, setSearch] = useState('');
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
    ]).then(([projectList, openList]) => {
      setProjects(projectList);
      setOpenProjects(openList);
      setLoading(false);
    });

    // Refresh open projects periodically
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

  const filtered = search
    ? projects.filter(
        (p) =>
          p.displayName.toLowerCase().includes(search.toLowerCase()) ||
          p.decodedPath.toLowerCase().includes(search.toLowerCase())
      )
    : projects;

  const handleOpenProject = (project) => {
    if (!window.electronAPI) return;
    window.electronAPI.windowOpenProject(project.decodedPath);
    window.electronAPI.windowGetOpen().then(setOpenProjects);
  };

  if (loading) {
    return (
      <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--bg)' }}>
        {/* Drag region + title bar */}
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

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--bg)' }}>
      {/* Title bar — centered, clears traffic lights */}
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

      {/* Search bar */}
      <div className="px-6 pt-4 pb-3 shrink-0">
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
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg outline-none transition-all duration-150"
            style={{
              backgroundColor: 'var(--surface)',
              color: 'var(--fg)',
              border: searchFocused ? '1px solid var(--dim)' : '1px solid var(--border)',
            }}
          />
        </div>
      </div>

      {/* Project grid */}
      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2">
            <div className="text-sm" style={{ color: 'var(--dim)' }}>
              {search ? 'No matching projects' : 'No projects found'}
            </div>
            {!search && (
              <div className="text-xs" style={{ color: 'var(--dim)' }}>
                Start using Claude Code in a project directory to see it here
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <AnimatePresence mode="popLayout">
              {filtered.map((project, index) => (
                <ProjectCard
                  key={project.encodedPath}
                  project={project}
                  isOpen={openProjects.includes(project.decodedPath)}
                  onClick={() => handleOpenProject(project)}
                  index={index}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
      <QuitOverlay />
    </div>
  );
}
