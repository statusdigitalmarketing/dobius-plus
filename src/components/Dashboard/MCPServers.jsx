export default function MCPServers({ settings, bridgeServers }) {
  const servers = settings?.mcpServers || {};
  const entries = Object.entries(servers);
  const bridgeEntries = Object.entries(bridgeServers || {});

  const categoryColors = {
    analytics: '#f59e0b',
    productivity: '#3b82f6',
    creative: '#ec4899',
    ai: '#8b5cf6',
    devops: '#10b981',
    system: '#6b7280',
    communication: '#06b6d4',
  };

  return (
    <div className="p-4 space-y-6">
      {/* Direct MCP Servers */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--dim)' }}>
            MCP Servers
          </h3>
          <span className="text-xs" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
            {entries.length}
          </span>
        </div>
        {entries.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--dim)' }}>
            No MCP servers configured
          </div>
        ) : (
          <div
            className="rounded-lg overflow-hidden"
            style={{ border: '1px solid var(--border)' }}
          >
            <table className="w-full text-xs">
              <thead>
                <tr style={{ backgroundColor: 'var(--surface)' }}>
                  <th className="text-left px-3 py-2 font-medium" style={{ color: 'var(--dim)' }}>Name</th>
                  <th className="text-left px-3 py-2 font-medium" style={{ color: 'var(--dim)' }}>Type</th>
                  <th className="text-left px-3 py-2 font-medium" style={{ color: 'var(--dim)' }}>Command / URL</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(([name, config]) => (
                  <tr
                    key={name}
                    className="transition-colors duration-100"
                    style={{ borderTop: '1px solid var(--border)' }}
                  >
                    <td className="px-3 py-2 font-medium" style={{ color: 'var(--fg)' }}>
                      <div className="flex items-center gap-2">
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ backgroundColor: 'var(--accent)' }}
                        />
                        {name}
                      </div>
                    </td>
                    <td className="px-3 py-2" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
                      {config.type || 'stdio'}
                    </td>
                    <td className="px-3 py-2 truncate max-w-sm" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
                      {config.command ? `${config.command} ${(config.args || []).join(' ')}` : config.url || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Bridge Servers */}
      {bridgeEntries.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--dim)' }}>
              Bridge Servers
              <span className="ml-2 text-[10px] font-normal" style={{ color: 'var(--dim)', opacity: 0.6 }}>
                lazy-loaded via mcp-bridge
              </span>
            </h3>
            <span className="text-xs" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
              {bridgeEntries.length}
            </span>
          </div>
          <div
            className="rounded-lg overflow-hidden"
            style={{ border: '1px solid var(--border)' }}
          >
            <table className="w-full text-xs">
              <thead>
                <tr style={{ backgroundColor: 'var(--surface)' }}>
                  <th className="text-left px-3 py-2 font-medium" style={{ color: 'var(--dim)' }}>Name</th>
                  <th className="text-left px-3 py-2 font-medium" style={{ color: 'var(--dim)' }}>Category</th>
                  <th className="text-left px-3 py-2 font-medium" style={{ color: 'var(--dim)' }}>Description</th>
                  <th className="text-left px-3 py-2 font-medium" style={{ color: 'var(--dim)' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {bridgeEntries.map(([name, config]) => (
                  <tr
                    key={name}
                    className="transition-colors duration-100"
                    style={{ borderTop: '1px solid var(--border)' }}
                  >
                    <td className="px-3 py-2 font-medium" style={{ color: 'var(--fg)' }}>
                      <div className="flex items-center gap-2">
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ backgroundColor: categoryColors[config.category] || 'var(--dim)' }}
                        />
                        {name}
                      </div>
                    </td>
                    <td className="px-3 py-2" style={{ color: categoryColors[config.category] || 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
                      {config.category || '—'}
                    </td>
                    <td className="px-3 py-2 truncate max-w-md" style={{ color: 'var(--dim)' }}>
                      {config.description || '—'}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                        style={{
                          backgroundColor: config.enabled ? 'rgba(16, 185, 129, 0.1)' : 'rgba(107, 114, 128, 0.1)',
                          color: config.enabled ? '#10b981' : '#6b7280',
                        }}
                      >
                        {config.enabled ? 'idle' : 'disabled'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
