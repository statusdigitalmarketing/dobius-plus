import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

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
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--dim)' }}>
          Plans
        </h3>
        <span className="text-xs" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
          {plans.length}
        </span>
      </div>
      {plans.length === 0 ? (
        <div className="text-xs" style={{ color: 'var(--dim)' }}>
          No plan files found in ~/.claude/plans/
        </div>
      ) : (
        <div className="space-y-1">
          {plans.map((plan) => (
            <div key={plan.name}>
              <button
                onClick={() => handleExpand(plan)}
                className="w-full text-left px-3 py-2.5 rounded-lg transition-all duration-150 flex items-center justify-between"
                style={{
                  backgroundColor: expandedPlan === plan.name ? 'var(--surface)' : 'transparent',
                  border: '1px solid transparent',
                }}
                onMouseEnter={(e) => {
                  if (expandedPlan !== plan.name) e.currentTarget.style.backgroundColor = 'var(--surface-hover)';
                }}
                onMouseLeave={(e) => {
                  if (expandedPlan !== plan.name) e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                <div className="flex items-center gap-2">
                  <svg
                    className="w-3 h-3 transition-transform duration-150 shrink-0"
                    style={{
                      color: 'var(--dim)',
                      transform: expandedPlan === plan.name ? 'rotate(90deg)' : 'rotate(0deg)',
                    }}
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                  </svg>
                  <span className="text-xs font-medium" style={{ color: 'var(--fg)' }}>
                    {plan.name}
                  </span>
                </div>
                <span className="text-xs" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
                  {new Date(plan.modifiedTime).toLocaleDateString()}
                </span>
              </button>
              <AnimatePresence>
                {expandedPlan === plan.name && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div
                      className="p-3 mx-3 mb-1 rounded-lg text-xs whitespace-pre-wrap overflow-y-auto"
                      style={{
                        backgroundColor: 'var(--bg)',
                        color: 'var(--dim)',
                        border: '1px solid var(--border)',
                        fontFamily: "'SF Mono', monospace",
                        maxHeight: '300px',
                      }}
                    >
                      {planContent}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
