import { motion } from 'framer-motion';
import { timeAgo } from '../../lib/time-ago';

export default function ProjectCard({ project, isOpen, isPinned, onClick, onTogglePin, index = 0 }) {
  const hasPath = Boolean(project.decodedPath);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: index * 0.05, ease: 'easeOut' }}
      className="w-full text-left p-4 rounded-lg transition-all duration-150 relative"
      style={{
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border)',
        borderLeft: isOpen ? '3px solid var(--accent)' : isPinned ? '3px solid var(--warning)' : '3px solid transparent',
        cursor: hasPath ? 'pointer' : 'default',
        opacity: hasPath ? 1 : 0.5,
      }}
      whileHover={hasPath ? { scale: 1.02 } : {}}
      onDoubleClick={hasPath ? onClick : undefined}
    >
      {/* Pin button */}
      <button
        onClick={(e) => { e.stopPropagation(); onTogglePin?.(); }}
        className="absolute top-2 right-2 transition-opacity duration-100"
        style={{
          color: isPinned ? 'var(--warning)' : 'var(--border)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 14,
          lineHeight: 1,
          opacity: isPinned ? 1 : 0.5,
        }}
        title={isPinned ? 'Unpin project' : 'Pin project'}
      >
        {isPinned ? '\u2605' : '\u2606'}
      </button>

      <div className="flex items-start justify-between gap-2 pr-5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate" style={{ color: 'var(--fg)' }}>
            {project.displayName}
          </div>
          <div
            className="text-xs mt-1 truncate"
            style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}
            title={project.decodedPath || 'Session data only — folder not found'}
          >
            {project.decodedPath || 'sessions only'}
          </div>
        </div>
        {isOpen && (
          <span
            className="text-xs px-2 py-0.5 rounded shrink-0"
            style={{
              backgroundColor: 'var(--accent)',
              color: 'var(--bg)',
              fontWeight: 600,
            }}
          >
            Open
          </span>
        )}
      </div>

      <div
        className="flex items-center gap-3 mt-3 text-xs"
        style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}
      >
        <span>{project.sessionCount} session{project.sessionCount !== 1 ? 's' : ''}</span>
        <span>{project.latestTimestamp ? timeAgo(project.latestTimestamp) : 'unknown'}</span>
      </div>
    </motion.div>
  );
}
