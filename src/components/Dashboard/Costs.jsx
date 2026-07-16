import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';

const MODEL_PRICING = [
  { pattern: 'opus',   input: 15,   output: 75,   cacheRead: 1.5,   cacheWrite: 3.75 },
  { pattern: 'sonnet', input: 3,    output: 15,   cacheRead: 0.3,   cacheWrite: 0.375 },
  { pattern: 'haiku',  input: 0.80, output: 4,    cacheRead: 0.08,  cacheWrite: 0.10 },
];

function fmt(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
}

function fmtCost(n) {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function Bar({ value, max, color }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="w-full h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--border)' }}>
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${pct}%`, backgroundColor: color || 'var(--accent)' }}
      />
    </div>
  );
}

export default function Costs() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState('cost'); // 'cost' | 'tokens' | 'sessions' | 'name'

  const load = useCallback(async () => {
    if (!window.electronAPI?.dataLoadProjectTokens) return;
    setLoading(true);
    try {
      const result = await window.electronAPI.dataLoadProjectTokens();
      setData(result);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="p-4 space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 rounded-lg animate-pulse" style={{ backgroundColor: 'var(--surface)' }} />
        ))}
      </div>
    );
  }

  const rows = Object.values(data || {});

  if (rows.length === 0) {
    return (
      <div className="p-4 flex items-center justify-center h-40">
        <span className="text-xs" style={{ color: 'var(--dim)' }}>No transcript data found.</span>
      </div>
    );
  }

  const sorted = [...rows].sort((a, b) => {
    if (sortBy === 'cost') return b.estimatedCostUsd - a.estimatedCostUsd;
    if (sortBy === 'tokens') return (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens);
    if (sortBy === 'sessions') return b.sessions - a.sessions;
    return a.projectName.localeCompare(b.projectName);
  });

  const totalCost = rows.reduce((s, r) => s + r.estimatedCostUsd, 0);
  const totalInput = rows.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutput = rows.reduce((s, r) => s + r.outputTokens, 0);
  const maxCost = Math.max(...rows.map((r) => r.estimatedCostUsd));

  const SortBtn = ({ id, label }) => (
    <button
      onClick={() => setSortBy(id)}
      className="px-2 py-1 rounded text-xs transition-colors"
      style={{
        backgroundColor: sortBy === id ? 'var(--accent)' : 'transparent',
        color: sortBy === id ? '#000' : 'var(--dim)',
        border: sortBy === id ? 'none' : '1px solid var(--border)',
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="p-4 flex flex-col gap-4 h-full overflow-y-auto">
      {/* Totals */}
      <div className="grid grid-cols-3 gap-3 shrink-0">
        {[
          { label: 'Est. Total Cost', value: fmtCost(totalCost), sub: `${rows.length} project${rows.length !== 1 ? 's' : ''}` },
          { label: 'Total Input', value: fmt(totalInput), sub: 'tokens' },
          { label: 'Total Output', value: fmt(totalOutput), sub: 'tokens' },
        ].map(({ label, value, sub }, i) => (
          <motion.div
            key={label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06 }}
            className="p-3 rounded-lg"
            style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            <div className="text-xs uppercase tracking-wider mb-1" style={{ color: 'var(--dim)', fontSize: 9 }}>{label}</div>
            <div className="text-lg font-semibold" style={{ color: 'var(--accent)', fontFamily: "'SF Mono', monospace" }}>{value}</div>
            <div className="text-xs" style={{ color: 'var(--dim)', fontSize: 9 }}>{sub}</div>
          </motion.div>
        ))}
      </div>

      {/* Pricing reference */}
      <div className="shrink-0 rounded-lg p-3" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="text-xs font-medium mb-2" style={{ color: 'var(--dim)' }}>Pricing reference (per 1M tokens)</div>
        <div className="flex gap-4 flex-wrap">
          {MODEL_PRICING.map((p) => (
            <div key={p.pattern} className="text-xs" style={{ fontFamily: "'SF Mono', monospace", color: 'var(--dim)' }}>
              <span style={{ color: 'var(--fg)', textTransform: 'capitalize' }}>{p.pattern}</span>
              {' '}· in ${p.input} · out ${p.output}
            </div>
          ))}
        </div>
      </div>

      {/* Sort controls */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs" style={{ color: 'var(--dim)' }}>Sort:</span>
        <SortBtn id="cost" label="Cost" />
        <SortBtn id="tokens" label="Tokens" />
        <SortBtn id="sessions" label="Sessions" />
        <SortBtn id="name" label="Name" />
        <button
          onClick={load}
          className="ml-auto text-xs px-2 py-1 rounded"
          style={{ color: 'var(--dim)', border: '1px solid var(--border)' }}
        >
          Refresh
        </button>
      </div>

      {/* Project rows */}
      <div className="flex flex-col gap-2">
        {sorted.map((row, i) => {
          const totalTok = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
          return (
            <motion.div
              key={row.encodedPath}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
              className="rounded-lg p-3"
              style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <div className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>{row.projectName}</div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--dim)', fontSize: 9 }}>
                    {row.sessions} session{row.sessions !== 1 ? 's' : ''}
                    {row.models.length > 0 && ` · ${row.models.map((m) => m.split('-').find((s) => s.match(/opus|sonnet|haiku/i)) || m).filter(Boolean).join(', ')}`}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-semibold" style={{ color: 'var(--accent)', fontFamily: "'SF Mono', monospace" }}>
                    {fmtCost(row.estimatedCostUsd)}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--dim)', fontSize: 9 }}>
                    {fmt(totalTok)} tok
                  </div>
                </div>
              </div>
              <Bar value={row.estimatedCostUsd} max={maxCost} color="var(--accent)" />
              <div className="flex gap-4 mt-2 flex-wrap">
                {[
                  { label: 'in', value: row.inputTokens },
                  { label: 'out', value: row.outputTokens },
                  { label: 'cache↓', value: row.cacheReadTokens },
                  { label: 'cache↑', value: row.cacheWriteTokens },
                ].map(({ label, value }) => (
                  <span key={label} className="text-xs" style={{ color: 'var(--dim)', fontSize: 9, fontFamily: "'SF Mono', monospace" }}>
                    {label} {fmt(value)}
                  </span>
                ))}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
