import { timeAgo } from '../../lib/time-ago';

export default function ProjectCard({ project, isOpen, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left p-4 rounded-lg transition-all hover:scale-[1.02]"
      style={{
        backgroundColor: 'var(--surface)',
        border: isOpen ? '1px solid var(--accent)' : '1px solid var(--border)',
      }}
    >
      <div className="flex items-start justify-between">
        <div className="text-sm font-semibold truncate" style={{ color: 'var(--fg)' }}>
          {project.displayName}
        </div>
        {isOpen && (
          <span
            className="text-xs px-1.5 py-0.5 rounded"
            style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
          >
            Open
          </span>
        )}
      </div>

      <div
        className="text-xs mt-1 truncate"
        style={{ color: 'var(--dim)' }}
        title={project.decodedPath}
      >
        {project.decodedPath}
      </div>

      <div className="flex items-center gap-3 mt-3 text-xs" style={{ color: 'var(--dim)' }}>
        <span>{project.sessionCount} session{project.sessionCount !== 1 ? 's' : ''}</span>
        <span>{project.latestTimestamp ? timeAgo(project.latestTimestamp) : 'unknown'}</span>
      </div>
    </button>
  );
}
