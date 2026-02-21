export default function Stats({ stats }) {
  if (!stats) {
    return <div className="p-4 text-sm" style={{ color: 'var(--dim)' }}>No stats available</div>;
  }

  const modelUsage = stats.modelUsage || {};
  const dailyActivity = (stats.dailyActivity || []).slice(-14); // Last 14 days
  const hourCounts = stats.hourCounts || {};

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <h2 className="text-lg font-semibold" style={{ color: 'var(--accent)' }}>Usage Stats</h2>

      {/* Model usage */}
      {Object.keys(modelUsage).length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--fg)' }}>Model Usage</h3>
          <div className="space-y-1">
            {Object.entries(modelUsage).map(([model, usage]) => (
              <div key={model} className="flex items-center justify-between p-2 rounded text-xs" style={{ backgroundColor: 'var(--surface)' }}>
                <span className="font-mono" style={{ color: 'var(--fg)' }}>{model}</span>
                <div className="flex gap-4" style={{ color: 'var(--dim)' }}>
                  <span>In: {((usage.inputTokens || 0) / 1000).toFixed(0)}k</span>
                  <span>Out: {((usage.outputTokens || 0) / 1000).toFixed(0)}k</span>
                  {usage.cacheReadTokens > 0 && <span>Cache: {((usage.cacheReadTokens || 0) / 1000).toFixed(0)}k</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily activity */}
      {dailyActivity.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--fg)' }}>Daily Activity (Last 14 Days)</h3>
          <div className="space-y-1">
            {dailyActivity.map((day) => (
              <div key={day.date} className="flex items-center justify-between p-2 rounded text-xs" style={{ backgroundColor: 'var(--surface)' }}>
                <span style={{ color: 'var(--fg)' }}>{day.date}</span>
                <div className="flex gap-4" style={{ color: 'var(--dim)' }}>
                  <span>{day.messageCount} msgs</span>
                  <span>{day.sessionCount} sessions</span>
                  <span>{day.toolCallCount} tools</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Hour distribution */}
      {Object.keys(hourCounts).length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--fg)' }}>Activity by Hour</h3>
          <div className="flex items-end gap-0.5 h-20">
            {Array.from({ length: 24 }, (_, h) => {
              const count = hourCounts[h] || 0;
              const max = Math.max(...Object.values(hourCounts), 1);
              const height = (count / max) * 100;
              return (
                <div
                  key={h}
                  className="flex-1 rounded-t"
                  style={{
                    height: `${Math.max(height, 2)}%`,
                    backgroundColor: count > 0 ? 'var(--accent)' : 'var(--border)',
                    opacity: count > 0 ? 0.8 : 0.3,
                  }}
                  title={`${h}:00 — ${count} messages`}
                />
              );
            })}
          </div>
          <div className="flex justify-between text-xs mt-1" style={{ color: 'var(--dim)' }}>
            <span>0h</span>
            <span>6h</span>
            <span>12h</span>
            <span>18h</span>
            <span>24h</span>
          </div>
        </div>
      )}
    </div>
  );
}
