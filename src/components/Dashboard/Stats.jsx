import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export default function Stats({ stats }) {
  if (!stats) {
    return <div className="p-4 text-xs" style={{ color: 'var(--dim)' }}>No stats available</div>;
  }

  const modelUsage = stats.modelUsage || {};
  const dailyActivity = (stats.dailyActivity || []).slice(-14);
  const hourCounts = stats.hourCounts || {};

  const hourData = useMemo(() => {
    return Array.from({ length: 24 }, (_, h) => ({
      hour: `${h}`,
      count: hourCounts[h] || 0,
    }));
  }, [hourCounts]);

  const chartColors = useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      accent: style.getPropertyValue('--accent').trim() || '#58A6FF',
      dim: style.getPropertyValue('--dim').trim() || '#8B949E',
      border: style.getPropertyValue('--border').trim() || '#30363D',
      surface: style.getPropertyValue('--surface').trim() || '#161B22',
    };
  }, []);

  return (
    <div className="p-4 space-y-5 overflow-y-auto h-full">
      {/* Model usage */}
      {Object.keys(modelUsage).length > 0 && (
        <div>
          <h3 className="text-xs font-medium mb-2 uppercase tracking-wider" style={{ color: 'var(--dim)' }}>
            Model Usage
          </h3>
          <div
            className="rounded-lg overflow-hidden"
            style={{ border: '1px solid var(--border)' }}
          >
            <table className="w-full text-xs">
              <thead>
                <tr style={{ backgroundColor: 'var(--surface)' }}>
                  <th className="text-left px-3 py-2 font-medium" style={{ color: 'var(--dim)' }}>Model</th>
                  <th className="text-right px-3 py-2 font-medium" style={{ color: 'var(--dim)' }}>Input</th>
                  <th className="text-right px-3 py-2 font-medium" style={{ color: 'var(--dim)' }}>Output</th>
                  <th className="text-right px-3 py-2 font-medium" style={{ color: 'var(--dim)' }}>Cache</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(modelUsage).map(([model, usage]) => (
                  <tr key={model} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="px-3 py-2" style={{ color: 'var(--fg)', fontFamily: "'SF Mono', monospace" }}>{model}</td>
                    <td className="px-3 py-2 text-right" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
                      {((usage.inputTokens || 0) / 1000).toFixed(0)}k
                    </td>
                    <td className="px-3 py-2 text-right" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
                      {((usage.outputTokens || 0) / 1000).toFixed(0)}k
                    </td>
                    <td className="px-3 py-2 text-right" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
                      {usage.cacheReadTokens > 0 ? `${((usage.cacheReadTokens || 0) / 1000).toFixed(0)}k` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Daily activity chart */}
      {dailyActivity.length > 0 && (
        <div>
          <h3 className="text-xs font-medium mb-2 uppercase tracking-wider" style={{ color: 'var(--dim)' }}>
            Daily Activity (Last 14 Days)
          </h3>
          <div
            className="rounded-lg p-3"
            style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={dailyActivity} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <XAxis
                  dataKey="date"
                  tick={{ fill: chartColors.dim, fontSize: 10 }}
                  tickFormatter={(d) => d.slice(5)}
                  axisLine={{ stroke: chartColors.border }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: chartColors.dim, fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: chartColors.surface,
                    border: `1px solid ${chartColors.border}`,
                    borderRadius: '6px',
                    fontSize: '11px',
                  }}
                  labelStyle={{ color: chartColors.dim }}
                  itemStyle={{ color: chartColors.accent }}
                />
                <Bar dataKey="messageCount" name="Messages" fill={chartColors.accent} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Hour distribution */}
      {Object.keys(hourCounts).length > 0 && (
        <div>
          <h3 className="text-xs font-medium mb-2 uppercase tracking-wider" style={{ color: 'var(--dim)' }}>
            Activity by Hour
          </h3>
          <div
            className="rounded-lg p-3"
            style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            <ResponsiveContainer width="100%" height={100}>
              <BarChart data={hourData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <XAxis
                  dataKey="hour"
                  tick={{ fill: chartColors.dim, fontSize: 9 }}
                  axisLine={{ stroke: chartColors.border }}
                  tickLine={false}
                  interval={2}
                />
                <YAxis hide />
                <Bar dataKey="count" fill={chartColors.accent} radius={[2, 2, 0, 0]} opacity={0.8} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
