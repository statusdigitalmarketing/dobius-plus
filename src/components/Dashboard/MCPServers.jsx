export default function MCPServers({ settings }) {
  const servers = settings?.mcpServers || {};
  const entries = Object.entries(servers);

  return (
    <div className="p-4">
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
          No MCP servers configured in ~/.claude/settings.json
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
  );
}
