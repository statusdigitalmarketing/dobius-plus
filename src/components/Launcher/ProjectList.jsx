import { useState, useEffect } from 'react';
import { AnimatePresence } from 'framer-motion';
import ProjectCard from './ProjectCard';

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
      <div className="h-full flex flex-col p-6 pt-10" style={{ backgroundColor: 'var(--bg)' }}>
        <div className="drag-region mb-6">
          <div className="no-drag">
            <div className="text-2xl font-bold tracking-tight" style={{ color: 'var(--fg)' }}>D+</div>
          </div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
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
    <div className="h-full flex flex-col p-6 pt-10" style={{ backgroundColor: 'var(--bg)' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6 drag-region">
        <div className="no-drag">
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--fg)' }}>
            D+
          </h1>
          <p className="text-xs mt-1" style={{ color: 'var(--dim)' }}>
            {projects.length} project{projects.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="no-drag relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5"
            style={{ color: searchFocused ? 'var(--fg)' : 'var(--dim)' }}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search projects..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            className="pl-8 pr-3 py-2 text-sm rounded-lg outline-none w-64 transition-all duration-150"
            style={{
              backgroundColor: 'var(--surface)',
              color: 'var(--fg)',
              border: searchFocused ? '1px solid var(--dim)' : '1px solid var(--border)',
            }}
          />
        </div>
      </div>

      {/* Project grid */}
      <div className="flex-1 overflow-y-auto">
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
    </div>
  );
}
