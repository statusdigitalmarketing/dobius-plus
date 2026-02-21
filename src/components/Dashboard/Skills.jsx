export default function Skills({ skills }) {
  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--dim)' }}>
          Installed Skills
        </h3>
        <span className="text-xs" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
          {skills.length}
        </span>
      </div>
      {skills.length === 0 ? (
        <div className="text-xs" style={{ color: 'var(--dim)' }}>
          No skills installed in ~/.claude/skills/
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {skills.map((skill) => (
            <div
              key={skill.name}
              className="p-3 rounded-lg transition-all duration-150"
              style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
            >
              <div className="text-sm font-medium" style={{ color: 'var(--fg)' }}>{skill.name}</div>
              {skill.description && (
                <div className="text-xs mt-1 line-clamp-2" style={{ color: 'var(--dim)' }}>
                  {skill.description}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
