import { motion } from 'framer-motion';
import { timeAgo } from '../../lib/time-ago';

export default function ProjectCard({ project, isOpen, onClick, index = 0 }) {
  return (
    <motion.button
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: index * 0.05, ease: 'easeOut' }}
      onClick={onClick}
      className="w-full text-left p-4 rounded-lg transition-all duration-150"
      style={{
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border)',
        borderLeft: isOpen ? '3px solid var(--accent)' : '3px solid transparent',
      }}
      whileHover={{ scale: 1.02 }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate" style={{ color: 'var(--fg)' }}>
            {project.displayName}
          </div>
          <div
            className="text-xs mt-1 truncate"
            style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}
            title={project.decodedPath}
          >
            {project.decodedPath}
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
    </motion.button>
  );
}
