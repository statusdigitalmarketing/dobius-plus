import { useMemo } from 'react';
import { motion } from 'framer-motion';

/**
 * Semi-circular gauge showing build health score 0-100.
 * Color transitions: red (0-40) → yellow (40-70) → green (70-100).
 */
export default function BuildHealthGauge({ progress }) {
  if (!progress) return null;

  const rawFailures = progress.verification_failures;
  const failures = typeof rawFailures === 'number' ? rawFailures
    : (rawFailures && typeof rawFailures === 'object') ? Object.keys(rawFailures).length
    : 0;
  const restarts = progress.restart_count || 0;
  const completed = progress.tasks_completed?.length || 0;
  const total = completed + (progress.tasks_remaining?.length || 0);

  // Health score: base 100, -10 per failure, -5 per restart
  const score = useMemo(() => {
    return Math.max(0, Math.min(100, 100 - failures * 10 - restarts * 5));
  }, [failures, restarts]);

  // Color based on score
  const color = useMemo(() => {
    if (score >= 70) return 'var(--accent)';
    if (score >= 40) return 'var(--warning)';
    return 'var(--danger)';
  }, [score]);

  // SVG arc params for semi-circle
  const radius = 60;
  const strokeWidth = 8;
  const cx = 70;
  const cy = 70;
  // Arc from 180° to 0° (left to right, bottom half = semi-circle)
  const circumference = Math.PI * radius; // half circle
  const arcLength = (score / 100) * circumference;

  return (
    <div
      className="p-4 rounded-lg flex flex-col items-center"
      style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <h3
        className="text-xs font-medium uppercase tracking-wider mb-3 self-start"
        style={{ color: 'var(--dim)' }}
      >
        Build Health
      </h3>

      {/* Gauge SVG */}
      <div className="relative" style={{ width: 140, height: 80 }}>
        <svg width="140" height="80" viewBox="0 0 140 80">
          {/* Background arc */}
          <path
            d={`M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`}
            fill="none"
            stroke="var(--border)"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
          {/* Filled arc */}
          <motion.path
            d={`M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: circumference - arcLength }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          />
        </svg>

        {/* Centered score */}
        <div
          className="absolute inset-0 flex items-end justify-center pb-1"
        >
          <span
            className="text-2xl font-semibold"
            style={{ color: 'var(--fg)', fontFamily: "'SF Mono', monospace" }}
          >
            {score}
          </span>
        </div>
      </div>

      {/* Stats below gauge */}
      <div className="flex gap-4 mt-2 text-xs">
        <div className="text-center">
          <div style={{ color: 'var(--dim)' }}>Failures</div>
          <div style={{ color: failures > 0 ? 'var(--danger)' : 'var(--fg)', fontFamily: "'SF Mono', monospace" }}>
            {failures}
          </div>
        </div>
        <div className="text-center">
          <div style={{ color: 'var(--dim)' }}>Restarts</div>
          <div style={{ color: restarts > 0 ? 'var(--warning)' : 'var(--fg)', fontFamily: "'SF Mono', monospace" }}>
            {restarts}
          </div>
        </div>
        <div className="text-center">
          <div style={{ color: 'var(--dim)' }}>Tasks</div>
          <div style={{ color: 'var(--fg)', fontFamily: "'SF Mono', monospace" }}>
            {completed}/{total}
          </div>
        </div>
      </div>
    </div>
  );
}
