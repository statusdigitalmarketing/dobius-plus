/**
 * Skeleton — reusable loading placeholder with pulsing animation.
 * Uses CSS variables for theming.
 */
export function SkeletonLine({ width = '100%', height = '12px', className = '' }) {
  return (
    <div
      className={`rounded animate-pulse ${className}`}
      style={{ width, height, backgroundColor: 'var(--border)' }}
    />
  );
}

export function SkeletonCard({ lines = 3, className = '' }) {
  return (
    <div
      className={`p-3 rounded-lg ${className}`}
      style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      {Array.from({ length: lines }, (_, i) => (
        <SkeletonLine
          key={i}
          width={i === 0 ? '60%' : i === lines - 1 ? '40%' : '80%'}
          className={i > 0 ? 'mt-2' : ''}
        />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 3, className = '' }) {
  return (
    <div
      className={`rounded-lg overflow-hidden ${className}`}
      style={{ border: '1px solid var(--border)' }}
    >
      {/* Header */}
      <div className="flex gap-4 px-3 py-2" style={{ backgroundColor: 'var(--surface)' }}>
        {Array.from({ length: cols }, (_, i) => (
          <SkeletonLine key={i} width={i === 0 ? '80px' : '60px'} height="10px" />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex gap-4 px-3 py-2"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          {Array.from({ length: cols }, (_, j) => (
            <SkeletonLine key={j} width={j === 0 ? '100px' : '80px'} height="10px" />
          ))}
        </div>
      ))}
    </div>
  );
}
