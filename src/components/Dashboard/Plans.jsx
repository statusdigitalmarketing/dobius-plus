import { useState } from 'react';

export default function Plans({ plans }) {
  const [expandedPlan, setExpandedPlan] = useState(null);
  const [planContent, setPlanContent] = useState('');

  const handleExpand = async (plan) => {
    if (expandedPlan === plan.name) {
      setExpandedPlan(null);
      return;
    }
    setExpandedPlan(plan.name);
    if (window.electronAPI) {
      try {
        const content = await window.electronAPI.dataReadPlanFile(plan.name);
        setPlanContent(content || 'Plan file is empty');
      } catch {
        setPlanContent('Failed to load plan content');
      }
    }
  };

  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold mb-3" style={{ color: 'var(--accent)' }}>Plans</h2>
      {plans.length === 0 ? (
        <div className="text-sm" style={{ color: 'var(--dim)' }}>No plan files found</div>
      ) : (
        <div className="space-y-2">
          {plans.map((plan) => (
            <div key={plan.name}>
              <button
                onClick={() => handleExpand(plan)}
                className="w-full text-left p-3 rounded transition-colors"
                style={{ backgroundColor: 'var(--surface)' }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium" style={{ color: 'var(--fg)' }}>
                    {expandedPlan === plan.name ? '▼' : '▶'} {plan.name}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--dim)' }}>
                    {new Date(plan.modifiedTime).toLocaleDateString()}
                  </span>
                </div>
              </button>
              {expandedPlan === plan.name && (
                <div
                  className="p-3 mt-1 rounded text-xs font-mono whitespace-pre-wrap"
                  style={{ backgroundColor: 'var(--bg)', color: 'var(--dim)', border: '1px solid var(--border)' }}
                >
                  {planContent}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
