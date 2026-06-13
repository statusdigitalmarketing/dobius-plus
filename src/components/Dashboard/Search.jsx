import { useState, useCallback, useRef, useEffect } from 'react';
import { useStore } from '../../store/store';
import { motion, AnimatePresence } from 'framer-motion';

function timeStr(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Highlight({ text, query }) {
  if (!query) return <span>{text}</span>;
  const q = query.toLowerCase();
  const idx = text.toLowerCase().indexOf(q);
  if (idx === -1) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, idx)}
      <mark style={{ backgroundColor: 'var(--accent)', color: '#000', borderRadius: 2 }}>
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </span>
  );
}

export default function Search() {
  const resumeSession = useStore((s) => s.resumeSession);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const debounceRef = useRef(null);
  const inputRef = useRef(null);

  const doSearch = useCallback(async (q) => {
    if (!q || q.trim().length < 2) {
      setResults(null);
      return;
    }
    if (!window.electronAPI?.dataSearchTranscripts) return;
    setLoading(true);
    setError('');
    try {
      const res = await window.electronAPI.dataSearchTranscripts(q.trim());
      setResults(res);
    } catch (err) {
      setError('Search failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Clear any pending debounce timer on unmount so it can't fire a stray
  // transcript scan / setState after the view is gone.
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const handleInput = (e) => {
    const val = e.target.value;
    setQuery(val);
    clearTimeout(debounceRef.current);
    if (val.trim().length < 2) {
      setResults(null);
      return;
    }
    debounceRef.current = setTimeout(() => doSearch(val), 400);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      clearTimeout(debounceRef.current);
      doSearch(query);
    }
    if (e.key === 'Escape') {
      setQuery('');
      setResults(null);
    }
  };

  // Group results by project
  const groups = {};
  for (const r of (results || [])) {
    const key = r.projectName || 'Unknown';
    if (!groups[key]) groups[key] = { projectName: key, items: [] };
    groups[key].items.push(r);
  }
  const sortedGroups = Object.values(groups).sort((a, b) => {
    const aTs = Math.max(...a.items.map((i) => i.timestamp || 0));
    const bTs = Math.max(...b.items.map((i) => i.timestamp || 0));
    return bTs - aTs;
  });

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      {/* Search bar */}
      <div className="relative shrink-0">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          style={{ color: 'var(--dim)' }}
        >
          <circle cx="6.5" cy="6.5" r="4" />
          <path d="M10 10l3 3" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Search across all session transcripts…"
          className="w-full pl-8 pr-4 py-2 rounded-lg text-xs outline-none"
          style={{
            backgroundColor: 'var(--surface)',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
          }}
        />
        {loading && (
          <div
            className="absolute right-3 top-1/2 -translate-y-1/2 w-3 h-3 border-2 rounded-full animate-spin"
            style={{ borderColor: 'var(--accent) transparent transparent transparent' }}
          />
        )}
      </div>

      {/* Status / hint */}
      {!loading && results === null && !error && (
        <div className="text-xs text-center py-8" style={{ color: 'var(--dim)' }}>
          Type 2+ characters to search. Searches user and assistant messages.
        </div>
      )}
      {error && (
        <div className="text-xs text-center py-4" style={{ color: '#f85149' }}>{error}</div>
      )}

      {/* Results */}
      {results !== null && !loading && (
        <div className="flex-1 overflow-y-auto">
          {results.length === 0 ? (
            <div className="text-xs text-center py-8" style={{ color: 'var(--dim)' }}>
              No matches found for <em>"{query}"</em>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="text-xs shrink-0" style={{ color: 'var(--dim)' }}>
                {results.length} result{results.length !== 1 ? 's' : ''}
                {results.length === 100 && ' (showing first 100)'}
              </div>
              <AnimatePresence>
                {sortedGroups.map((group, gi) => (
                  <motion.div
                    key={group.projectName}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: gi * 0.04 }}
                  >
                    <div className="text-xs font-semibold mb-2" style={{ color: 'var(--fg)' }}>
                      {group.projectName}
                      <span className="ml-1.5 font-normal" style={{ color: 'var(--dim)' }}>
                        ({group.items.length})
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {group.items.map((item, idx) => (
                        <div
                          key={`${item.sessionId}-${idx}`}
                          className="rounded-lg p-3 cursor-pointer transition-colors"
                          style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
                          onClick={() => resumeSession(item.sessionId)}
                          title={`Resume session ${item.sessionId}`}
                        >
                          <div className="flex items-center justify-between gap-2 mb-1.5">
                            <span
                              className="text-xs px-1.5 py-0.5 rounded font-medium"
                              style={{
                                backgroundColor: item.role === 'user' ? 'rgba(88,166,255,0.15)' : 'rgba(63,185,80,0.15)',
                                color: item.role === 'user' ? '#58A6FF' : '#3FB950',
                                fontSize: 9,
                              }}
                            >
                              {item.role === 'user' ? 'You' : 'Claude'}
                            </span>
                            <span className="text-xs" style={{ color: 'var(--dim)', fontSize: 9 }}>
                              {timeStr(item.timestamp)}
                            </span>
                          </div>
                          <div
                            className="text-xs leading-relaxed"
                            style={{
                              color: 'var(--dim)',
                              fontFamily: "'SF Mono', monospace",
                              fontSize: 10,
                              wordBreak: 'break-word',
                            }}
                          >
                            <Highlight text={item.excerpt} query={query.trim()} />
                          </div>
                          <div className="mt-1.5 text-xs" style={{ color: 'var(--dim)', fontSize: 9 }}>
                            {item.sessionId.slice(0, 8)}… · click to resume
                          </div>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
