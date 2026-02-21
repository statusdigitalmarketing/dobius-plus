import { useState, useEffect } from 'react';
import ProjectCard from './ProjectCard';

export default function ProjectList() {
  const [projects, setProjects] = useState([]);
  const [openProjects, setOpenProjects] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

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
    // Update open projects list
    window.electronAPI.windowGetOpen().then(setOpenProjects);
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center" style={{ color: 'var(--dim)' }}>
        Loading projects...
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-6 pt-10" style={{ backgroundColor: 'var(--bg)' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6 drag-region">
        <div className="no-drag">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--fg)' }}>
            Dobius+
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--dim)' }}>
            {projects.length} project{projects.length !== 1 ? 's' : ''}
          </p>
        </div>
        <input
          type="text"
          placeholder="Search projects..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg outline-none w-64 no-drag"
          style={{
            backgroundColor: 'var(--surface)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
          }}
        />
      </div>

      {/* Project grid */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div
            className="flex items-center justify-center h-40 text-sm"
            style={{ color: 'var(--dim)' }}
          >
            {search ? 'No matching projects' : 'No projects found in ~/.claude/projects/'}
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((project) => (
              <ProjectCard
                key={project.encodedPath}
                project={project}
                isOpen={openProjects.includes(project.decodedPath)}
                onClick={() => handleOpenProject(project)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
