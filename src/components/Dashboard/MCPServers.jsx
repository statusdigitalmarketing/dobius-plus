export default function MCPServers({ settings }) {
  const servers = settings?.mcpServers || {};
  const entries = Object.entries(servers);

  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold mb-3" style={{ color: 'var(--accent)' }}>MCP Servers</h2>
      {entries.length === 0 ? (
        <div className="text-sm" style={{ color: 'var(--dim)' }}>No MCP servers configured</div>
      ) : (
        <div className="space-y-2">
          {entries.map(([name, config]) => (
            <div key={name} className="p-3 rounded" style={{ backgroundColor: 'var(--surface)' }}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium" style={{ color: 'var(--fg)' }}>{name}</span>
                <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: 'var(--bg)', color: 'var(--dim)' }}>
                  {config.type || 'stdio'}
                </span>
              </div>
              {config.command && (
                <div className="text-xs mt-1 font-mono" style={{ color: 'var(--dim)' }}>
                  {config.command} {(config.args || []).join(' ')}
                </div>
              )}
              {config.url && (
                <div className="text-xs mt-1 font-mono" style={{ color: 'var(--dim)' }}>
                  {config.url}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
