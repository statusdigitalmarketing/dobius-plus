import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export default function DiffViewer({ hash, onClose, loadDiff }) {
  const [diff, setDiff] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!hash || !loadDiff) return;
    setLoading(true);
    loadDiff(hash).then((d) => {
      setDiff(d);
      setLoading(false);
    });
  }, [hash, loadDiff]);

  return (
    <AnimatePresence>
      {hash && (
        <motion.div
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="absolute inset-0 z-10 flex flex-col"
          style={{ backgroundColor: 'var(--bg)' }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-2 shrink-0"
            style={{ borderBottom: '1px solid var(--border)', backgroundColor: 'var(--surface)' }}
          >
            <span
              className="text-xs font-medium"
              style={{ color: 'var(--accent)', fontFamily: "'SF Mono', monospace" }}
            >
              {hash.slice(0, 7)}
            </span>
            <button
              onClick={onClose}
              className="text-xs px-2 py-1 rounded transition-colors duration-150"
              style={{ color: 'var(--dim)', border: '1px solid var(--border)' }}
            >
              Close
            </button>
          </div>

          {/* Diff content */}
          <div className="flex-1 overflow-auto p-4">
            {loading ? (
              <div className="flex items-center justify-center h-20">
                <div className="w-5 h-5 rounded-full animate-pulse" style={{ backgroundColor: 'var(--border)' }} />
              </div>
            ) : !diff ? (
              <p className="text-xs" style={{ color: 'var(--dim)' }}>No diff available</p>
            ) : (
              <pre
                className="text-xs leading-relaxed whitespace-pre"
                style={{ fontFamily: "'SF Mono', monospace" }}
              >
                {diff.split('\n').map((line, i) => {
                  let color = 'var(--dim)';
                  if (line.startsWith('+') && !line.startsWith('+++')) color = '#3fb950';
                  else if (line.startsWith('-') && !line.startsWith('---')) color = '#f85149';
                  else if (line.startsWith('@@')) color = '#79c0ff';
                  else if (line.startsWith('diff ') || line.startsWith('index ')) color = 'var(--fg)';

                  return (
                    <div key={i} style={{ color }}>
                      {line}
                    </div>
                  );
                })}
              </pre>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
