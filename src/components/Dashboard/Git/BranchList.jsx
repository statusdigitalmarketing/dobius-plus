export default function BranchList({ branches }) {
  if (!branches.local.length && !branches.remote.length) {
    return (
      <div className="flex items-center justify-center h-40">
        <p className="text-xs" style={{ color: 'var(--dim)' }}>No branches found</p>
      </div>
    );
  }

  const Section = ({ title, items }) => (
    <div className="mb-4">
      <h4
        className="text-xs font-medium uppercase tracking-wider px-4 py-2"
        style={{ color: 'var(--dim)' }}
      >
        {title}
      </h4>
      {items.map((name) => {
        const isCurrent = name === branches.current;
        return (
          <div
            key={name}
            className="flex items-center gap-2 px-4 py-1.5"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            {isCurrent && (
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: 'var(--accent)' }}
              />
            )}
            <span
              className="text-xs truncate"
              style={{
                color: isCurrent ? 'var(--fg)' : 'var(--dim)',
                fontFamily: "'SF Mono', monospace",
                fontWeight: isCurrent ? 500 : 400,
              }}
            >
              {name}
            </span>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
      {branches.local.length > 0 && <Section title="Local" items={branches.local} />}
      {branches.remote.length > 0 && <Section title="Remote" items={branches.remote} />}
    </div>
  );
}
