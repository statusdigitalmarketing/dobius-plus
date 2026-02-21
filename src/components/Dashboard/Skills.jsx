export default function Skills({ skills }) {
  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold mb-3" style={{ color: 'var(--accent)' }}>Installed Skills</h2>
      {skills.length === 0 ? (
        <div className="text-sm" style={{ color: 'var(--dim)' }}>No skills installed</div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {skills.map((skill) => (
            <div key={skill.name} className="p-3 rounded" style={{ backgroundColor: 'var(--surface)' }}>
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
