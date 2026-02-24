import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../../store/store';
import { motion, AnimatePresence } from 'framer-motion';

const ALLOWED_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];

const MODEL_LABELS = {
  'claude-opus-4-6': 'Opus',
  'claude-sonnet-4-5-20250929': 'Sonnet',
  'claude-haiku-4-5-20251001': 'Haiku',
};

function StatCard({ label, value, subtitle, accent, index = 0 }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.2 }}
      className="p-3 rounded-lg"
      style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="text-xs font-medium uppercase tracking-wider mb-1" style={{ color: 'var(--dim)', fontSize: 9, letterSpacing: '0.1em' }}>
        {label}
      </div>
      <div className="text-lg font-semibold" style={{ color: accent ? 'var(--accent)' : 'var(--fg)', fontFamily: "'SF Mono', monospace" }}>
        {value}
      </div>
      {subtitle && (
        <div className="text-xs mt-0.5" style={{ color: accent ? 'var(--accent)' : 'var(--dim)', fontSize: 9 }}>
          {subtitle}
        </div>
      )}
    </motion.div>
  );
}

export default function Agents() {
  const addTab = useStore((s) => s.addTab);
  const renameTab = useStore((s) => s.renameTab);
  const setActiveView = useStore((s) => s.setActiveView);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const terminalTabs = useStore((s) => s.terminalTabs);
  const runningAgents = useStore((s) => s.runningAgents);
  const registerRunningAgent = useStore((s) => s.registerRunningAgent);

  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingAgent, setEditingAgent] = useState(null);
  const [sessionCount, setSessionCount] = useState(0);
  const [agentMemories, setAgentMemories] = useState({});

  const loadAgents = useCallback(async () => {
    if (!window.electronAPI?.agentsList) return;
    const list = await window.electronAPI.agentsList();
    setAgents(list || []);
    setLoading(false);
  }, []);

  const loadMemories = useCallback(async (agentList) => {
    if (!window.electronAPI?.agentMemoryGet || !agentList?.length) return;
    const mems = {};
    for (const agent of agentList) {
      const mem = await window.electronAPI.agentMemoryGet(agent.id);
      if (mem) mems[agent.id] = mem;
    }
    setAgentMemories(mems);
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    if (agents.length > 0) loadMemories(agents);
  }, [agents, loadMemories]);

  // Load session count for stats
  useEffect(() => {
    if (!window.electronAPI?.dataLoadAllSessions) return;
    window.electronAPI.dataLoadAllSessions().then((sessions) => {
      setSessionCount(sessions?.length || 0);
    });
  }, []);

  const handleLaunch = useCallback(async (agent) => {
    if (!window.electronAPI?.agentsWriteTempPrompt) return;
    // Build enhanced prompt with memory injection
    let prompt = agent.systemPrompt;
    const mem = agentMemories[agent.id];
    if (mem && (mem.context || mem.experience?.length > 0 || mem.journal?.length > 0)) {
      let memorySection = '\n\n---\n## Agent Memory (auto-injected by Dobius+)\n';
      if (mem.context) {
        memorySection += `\n### Context\n${mem.context}\n`;
      }
      if (mem.experience?.length > 0) {
        memorySection += '\n### Recent Experience\n';
        mem.experience.forEach((exp, i) => {
          memorySection += `${i + 1}. ${exp}\n`;
        });
      }
      if (mem.journal?.length > 0) {
        const recent = mem.journal.slice(-3).reverse();
        memorySection += '\n### Last 3 Runs\n';
        recent.forEach((entry) => {
          const date = new Date(entry.timestamp).toLocaleDateString();
          const dur = formatDuration(entry.duration);
          const status = entry.exitCode === 0 ? 'success' : entry.exitCode != null ? `exit ${entry.exitCode}` : 'unknown';
          memorySection += `- ${date} | ${dur} | ${status}`;
          if (entry.projectPath) {
            const projName = entry.projectPath.split('/').filter(Boolean).pop();
            memorySection += ` | ${projName}`;
          }
          if (entry.summary) memorySection += ` — ${entry.summary}`;
          memorySection += '\n';
        });
      }
      // Keep total under 10,000 chars — truncate memory section if needed
      const maxMemory = 10000 - prompt.length - 50;
      if (maxMemory > 100) {
        prompt += memorySection.slice(0, maxMemory);
      }
    }
    const promptPath = await window.electronAPI.agentsWriteTempPrompt(prompt);
    if (!promptPath) return;
    const tab = addTab(currentProjectPath);
    renameTab(tab.id, agent.name);
    registerRunningAgent(agent.id, tab.id);
    setActiveView('terminal');
    setTimeout(() => {
      const modelFlag = agent.model && ALLOWED_MODELS.includes(agent.model) ? ` --model ${agent.model}` : '';
      const safePath = promptPath.replace(/'/g, "'\\''");
      const cmd = `claude --system-prompt-file '${safePath}'${modelFlag}\r`;
      window.electronAPI.terminalWrite(tab.id, cmd);
    }, 500);
  }, [addTab, renameTab, setActiveView, currentProjectPath, registerRunningAgent, agentMemories]);

  const handleChat = useCallback((agentId) => {
    const tabId = runningAgents[agentId];
    if (!tabId) return;
    setActiveTab(tabId);
    setActiveView('terminal');
  }, [runningAgents, setActiveTab, setActiveView]);

  const handleDelete = useCallback(async (agentId) => {
    if (!window.electronAPI?.agentsDelete) return;
    await window.electronAPI.agentsDelete(agentId);
    await loadAgents();
  }, [loadAgents]);

  const handleSave = useCallback(async (agent) => {
    if (!window.electronAPI?.agentsSave) return;
    await window.electronAPI.agentsSave(agent);
    await loadAgents();
    setEditingAgent(null);
  }, [loadAgents]);

  const runningCount = Object.keys(runningAgents).length;
  const memoryAgentCount = Object.values(agentMemories).filter(
    (m) => m.journal?.length > 0 || m.context || m.experience?.length > 0
  ).length;

  if (loading) {
    return <MissionControlSkeleton />;
  }

  return (
    <div className="p-5 space-y-5">
      {/* Stats Bar */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard index={0} label="Agents" value={agents.length} subtitle={runningCount > 0 ? `${runningCount} running` : 'none running'} accent={runningCount > 0} />
        <StatCard index={1} label="Terminals" value={terminalTabs.length} subtitle="active" />
        <StatCard index={2} label="Sessions" value={sessionCount} subtitle="total" />
        <StatCard index={3} label="Memory" value={memoryAgentCount} subtitle={memoryAgentCount === 1 ? 'agent' : 'agents'} accent={memoryAgentCount > 0} />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--fg)', letterSpacing: '0.1em' }}>
            Mission Control
          </h2>
          <div className="text-xs mt-0.5" style={{ color: 'var(--dim)', fontSize: 10 }}>
            All systems at a glance
          </div>
        </div>
        <button
          onClick={() => setEditingAgent({ name: '', description: '', systemPrompt: '', model: '' })}
          style={{
            padding: '5px 14px',
            fontSize: 11,
            fontFamily: "'SF Mono', monospace",
            color: 'var(--bg)',
            backgroundColor: 'var(--accent)',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          + New Agent
        </button>
      </div>

      {/* Agent grid */}
      {agents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12" style={{ color: 'var(--dim)' }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4, marginBottom: 12 }}>
            <circle cx="12" cy="8" r="4" />
            <path d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
          </svg>
          <div className="text-xs mb-3" style={{ fontSize: 11 }}>No agents configured</div>
          <button
            onClick={() => setEditingAgent({ name: '', description: '', systemPrompt: '', model: '' })}
            style={{
              padding: '5px 14px',
              fontSize: 11,
              fontFamily: "'SF Mono', monospace",
              color: 'var(--bg)',
              backgroundColor: 'var(--accent)',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Create Agent
          </button>
        </div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {agents.map((agent) => {
            const isRunning = !!runningAgents[agent.id];
            return (
              <AgentCard
                key={agent.id}
                agent={agent}
                isRunning={isRunning}
                memory={agentMemories[agent.id]}
                onLaunch={handleLaunch}
                onChat={handleChat}
                onEdit={setEditingAgent}
                onDelete={handleDelete}
                onMemoryChange={() => loadMemories(agents)}
              />
            );
          })}
        </div>
      )}

      {editingAgent && (
        <AgentEditor
          agent={editingAgent}
          onSave={handleSave}
          onClose={() => setEditingAgent(null)}
        />
      )}
    </div>
  );
}

function StatusBadge({ running }) {
  return (
    <span className="inline-flex items-center gap-1" style={{ fontSize: 9, fontFamily: "'SF Mono', monospace" }}>
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: running ? '#3FB950' : 'var(--dim)' }}
      />
      <span style={{ color: running ? '#3FB950' : 'var(--dim)' }}>
        {running ? 'RUNNING' : 'OFFLINE'}
      </span>
    </span>
  );
}

function Badge({ label, bg, color }) {
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded"
      style={{ fontSize: 9, backgroundColor: bg, color }}
    >
      {label}
    </span>
  );
}

const btnHover = { transition: 'opacity 150ms', };
const btnHoverStyle = (e, opacity) => { e.currentTarget.style.opacity = opacity; };

function AgentCard({ agent, isRunning, memory, onLaunch, onChat, onEdit, onDelete, onMemoryChange }) {
  const [expanded, setExpanded] = useState(false);
  const journalCount = memory?.journal?.length || 0;
  const hasContext = !!memory?.context;
  const hasExperience = memory?.experience?.length > 0;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ borderColor: 'rgba(88,166,255,0.3)' }}
      className="p-4 rounded-lg flex flex-col"
      style={{
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border)',
      }}
    >
      {/* Top row: name + status */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-semibold" style={{ color: 'var(--fg)', fontSize: 13 }}>
          {agent.name}
        </span>
        <StatusBadge running={isRunning} />
      </div>

      {/* Badges */}
      <div className="flex items-center gap-1.5 mb-2">
        <Badge
          label={agent.builtIn ? 'BUILT-IN' : 'CUSTOM'}
          bg={agent.builtIn ? 'var(--border)' : 'rgba(88,166,255,0.1)'}
          color={agent.builtIn ? 'var(--dim)' : 'var(--accent)'}
        />
        {agent.model && (
          <Badge
            label={MODEL_LABELS[agent.model] || agent.model}
            bg="rgba(88,166,255,0.15)"
            color="var(--accent)"
          />
        )}
        {journalCount > 0 && (
          <Badge
            label={`${journalCount} run${journalCount !== 1 ? 's' : ''}`}
            bg="rgba(63,185,80,0.1)"
            color="#3FB950"
          />
        )}
        {hasContext && (
          <span title="Has context notes" style={{ fontSize: 10, color: 'var(--dim)' }}>
            {'\u{1F4C4}'}
          </span>
        )}
        {hasExperience && (
          <span title="Has experience" style={{ fontSize: 10, color: 'var(--dim)' }}>
            {'\u{2B50}'}
          </span>
        )}
      </div>

      {/* Description */}
      <div
        className="text-xs flex-1"
        style={{ color: 'var(--dim)', fontSize: 10, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
      >
        {agent.description}
      </div>

      {/* Actions */}
      <div
        className="mt-3 pt-3 flex items-center gap-1.5"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        {isRunning ? (
          <button
            onClick={() => onChat(agent.id)}
            onMouseEnter={(e) => btnHoverStyle(e, '0.8')}
            onMouseLeave={(e) => btnHoverStyle(e, '1')}
            style={{
              padding: '4px 12px',
              fontSize: 10,
              fontFamily: "'SF Mono', monospace",
              color: 'var(--accent)',
              backgroundColor: 'transparent',
              border: '1px solid var(--accent)',
              borderRadius: 4,
              cursor: 'pointer',
              ...btnHover,
            }}
          >
            Chat
          </button>
        ) : (
          <button
            onClick={() => onLaunch(agent)}
            onMouseEnter={(e) => btnHoverStyle(e, '0.85')}
            onMouseLeave={(e) => btnHoverStyle(e, '1')}
            style={{
              padding: '4px 12px',
              fontSize: 10,
              fontFamily: "'SF Mono', monospace",
              color: 'var(--bg)',
              backgroundColor: 'var(--accent)',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              ...btnHover,
            }}
          >
            Start
          </button>
        )}
        <button
          onClick={() => setExpanded(!expanded)}
          onMouseEnter={(e) => btnHoverStyle(e, '0.8')}
          onMouseLeave={(e) => btnHoverStyle(e, '1')}
          style={{
            padding: '4px 10px',
            fontSize: 10,
            fontFamily: "'SF Mono', monospace",
            color: expanded ? 'var(--accent)' : 'var(--dim)',
            backgroundColor: 'transparent',
            border: `1px solid ${expanded ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 4,
            cursor: 'pointer',
            ...btnHover,
          }}
        >
          Memory
        </button>
        {!agent.builtIn && (
          <>
            <button
              onClick={() => onEdit(agent)}
              onMouseEnter={(e) => btnHoverStyle(e, '0.8')}
              onMouseLeave={(e) => btnHoverStyle(e, '1')}
              style={{
                padding: '4px 10px',
                fontSize: 10,
                fontFamily: "'SF Mono', monospace",
                color: 'var(--dim)',
                backgroundColor: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 4,
                cursor: 'pointer',
                ...btnHover,
              }}
            >
              Edit
            </button>
            <button
              onClick={() => onDelete(agent.id)}
              onMouseEnter={(e) => btnHoverStyle(e, '0.8')}
              onMouseLeave={(e) => btnHoverStyle(e, '1')}
              style={{
                padding: '4px 10px',
                fontSize: 10,
                fontFamily: "'SF Mono', monospace",
                color: '#F85149',
                backgroundColor: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 4,
                cursor: 'pointer',
                ...btnHover,
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>

      {/* Expandable memory panel */}
      <AnimatePresence>
        {expanded && (
          <MemoryPanel
            agentId={agent.id}
            memory={memory}
            onMemoryChange={onMemoryChange}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDuration(secs) {
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function MemoryPanel({ agentId, memory, onMemoryChange }) {
  const [context, setContext] = useState(memory?.context || '');
  const [newExp, setNewExp] = useState('');
  const [clearing, setClearing] = useState(false);

  const handleContextBlur = useCallback(async () => {
    if (!window.electronAPI?.agentMemorySetContext) return;
    try {
      await window.electronAPI.agentMemorySetContext(agentId, context);
      onMemoryChange?.();
    } catch (err) {
      console.error('[AgentMemory] Failed to save context:', err);
    }
  }, [agentId, context, onMemoryChange]);

  const handleAddExperience = useCallback(async () => {
    const text = newExp.trim();
    if (!text || !window.electronAPI?.agentMemoryAddExperience) return;
    try {
      await window.electronAPI.agentMemoryAddExperience(agentId, text);
      setNewExp('');
      onMemoryChange?.();
    } catch (err) {
      console.error('[AgentMemory] Failed to add experience:', err);
    }
  }, [agentId, newExp, onMemoryChange]);

  const handleRemoveExperience = useCallback(async (index) => {
    if (!window.electronAPI?.agentMemoryRemoveExperience) return;
    try {
      await window.electronAPI.agentMemoryRemoveExperience(agentId, index);
      onMemoryChange?.();
    } catch (err) {
      console.error('[AgentMemory] Failed to remove experience:', err);
    }
  }, [agentId, onMemoryChange]);

  const handleClear = useCallback(async () => {
    if (!window.electronAPI?.agentMemoryClear) return;
    try {
      await window.electronAPI.agentMemoryClear(agentId);
      setContext('');
      setClearing(false);
      onMemoryChange?.();
    } catch (err) {
      console.error('[AgentMemory] Failed to clear memory:', err);
    }
  }, [agentId, onMemoryChange]);

  const journal = memory?.journal || [];
  const experience = memory?.experience || [];

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      style={{ overflow: 'hidden' }}
    >
      <div
        className="mt-3 pt-3 space-y-3"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        {/* Context */}
        <div>
          <div className="text-xs font-medium mb-1" style={{ color: 'var(--dim)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Context
          </div>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            onBlur={handleContextBlur}
            placeholder="Add notes about this agent's role and expertise..."
            rows={2}
            maxLength={5000}
            style={{
              ...inputStyle,
              resize: 'vertical',
              lineHeight: 1.4,
              fontSize: 10,
            }}
          />
        </div>

        {/* Journal */}
        <div>
          <div className="text-xs font-medium mb-1" style={{ color: 'var(--dim)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Journal ({journal.length})
          </div>
          {journal.length === 0 ? (
            <div className="text-xs" style={{ color: 'var(--dim)', fontSize: 9, fontStyle: 'italic' }}>
              No runs recorded yet
            </div>
          ) : (
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              {[...journal].reverse().map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 py-1"
                  style={{ borderBottom: '1px solid var(--border)', fontSize: 9 }}
                >
                  <span style={{ color: entry.exitCode === 0 ? '#3FB950' : entry.exitCode != null ? '#F85149' : 'var(--dim)' }}>
                    {entry.exitCode === 0 ? '\u2713' : entry.exitCode != null ? '\u2717' : '\u2022'}
                  </span>
                  <span style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
                    {timeAgo(entry.timestamp)}
                  </span>
                  <span style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
                    {formatDuration(entry.duration)}
                  </span>
                  {entry.summary && (
                    <span
                      style={{
                        color: 'var(--dim)',
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {entry.summary}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Experience */}
        <div>
          <div className="text-xs font-medium mb-1" style={{ color: 'var(--dim)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Experience ({experience.length}/20)
          </div>
          {experience.map((item, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 py-0.5"
              style={{ fontSize: 10 }}
            >
              <span style={{ color: 'var(--dim)', flex: 1 }}>{item}</span>
              <button
                onClick={() => handleRemoveExperience(i)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#F85149',
                  cursor: 'pointer',
                  fontSize: 10,
                  padding: '0 2px',
                  opacity: 0.6,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.6'; }}
              >
                x
              </button>
            </div>
          ))}
          {experience.length < 20 && (
            <div className="flex items-center gap-1 mt-1">
              <input
                value={newExp}
                onChange={(e) => setNewExp(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddExperience(); }}
                placeholder="Add learned pattern..."
                maxLength={200}
                style={{ ...inputStyle, fontSize: 10, flex: 1 }}
              />
              <button
                onClick={handleAddExperience}
                disabled={!newExp.trim()}
                style={{
                  padding: '4px 8px',
                  fontSize: 9,
                  fontFamily: "'SF Mono', monospace",
                  color: newExp.trim() ? 'var(--accent)' : 'var(--dim)',
                  backgroundColor: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  cursor: newExp.trim() ? 'pointer' : 'default',
                }}
              >
                +
              </button>
            </div>
          )}
        </div>

        {/* Clear button */}
        <div className="flex justify-end">
          {clearing ? (
            <div className="flex items-center gap-1.5">
              <span style={{ fontSize: 9, color: '#F85149' }}>Clear all memory?</span>
              <button
                onClick={handleClear}
                style={{
                  padding: '2px 8px',
                  fontSize: 9,
                  fontFamily: "'SF Mono', monospace",
                  color: '#F85149',
                  backgroundColor: 'rgba(248,81,73,0.1)',
                  border: '1px solid #F85149',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                Confirm
              </button>
              <button
                onClick={() => setClearing(false)}
                style={{
                  padding: '2px 8px',
                  fontSize: 9,
                  fontFamily: "'SF Mono', monospace",
                  color: 'var(--dim)',
                  backgroundColor: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setClearing(true)}
              onMouseEnter={(e) => btnHoverStyle(e, '0.8')}
              onMouseLeave={(e) => btnHoverStyle(e, '1')}
              style={{
                padding: '2px 8px',
                fontSize: 9,
                fontFamily: "'SF Mono', monospace",
                color: 'var(--dim)',
                backgroundColor: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 4,
                cursor: 'pointer',
                ...btnHover,
              }}
            >
              Clear Memory
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function MissionControlSkeleton() {
  return (
    <div className="p-5 space-y-5">
      <div className="grid grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-16 rounded-lg animate-pulse" style={{ backgroundColor: 'var(--surface)' }} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="h-36 rounded-lg animate-pulse" style={{ backgroundColor: 'var(--surface)' }} />
        ))}
      </div>
    </div>
  );
}

function AgentEditor({ agent, onSave, onClose }) {
  const [name, setName] = useState(agent.name || '');
  const [description, setDescription] = useState(agent.description || '');
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt || '');
  const [model, setModel] = useState(agent.model || '');
  const [error, setError] = useState('');

  const handleSubmit = useCallback(() => {
    if (!name.trim()) { setError('Name is required'); return; }
    if (!systemPrompt.trim()) { setError('System prompt is required'); return; }
    onSave({
      id: agent.id || undefined,
      name: name.trim(),
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      model: model || null,
    });
  }, [name, description, systemPrompt, model, agent.id, onSave]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 520,
          maxHeight: '80vh',
          backgroundColor: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          overflow: 'auto',
        }}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>
            {agent.id ? 'Edit Agent' : 'New Agent'}
          </h3>
          <button
            onClick={onClose}
            style={{ color: 'var(--dim)', background: 'none', border: 'none', fontSize: 16, cursor: 'pointer' }}
          >
            x
          </button>
        </div>

        {error && (
          <div className="text-xs px-3 py-1.5 rounded" style={{ backgroundColor: 'rgba(248,81,73,0.1)', color: '#F85149' }}>
            {error}
          </div>
        )}

        <Field label="Name" required>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); setError(''); }}
            placeholder="e.g., Performance Optimizer"
            spellCheck={false}
            style={inputStyle}
          />
        </Field>

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description of what this agent does"
            spellCheck={false}
            style={inputStyle}
          />
        </Field>

        <Field label="System Prompt" required>
          <textarea
            value={systemPrompt}
            onChange={(e) => { setSystemPrompt(e.target.value); setError(''); }}
            placeholder="Instructions for how Claude should behave..."
            rows={8}
            spellCheck={false}
            style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
          />
        </Field>

        <Field label="Model (optional)">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={inputStyle}
          >
            <option value="">Default</option>
            <option value="claude-opus-4-6">Opus 4.6</option>
            <option value="claude-sonnet-4-5-20250929">Sonnet 4.5</option>
            <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
          </select>
        </Field>

        <div className="flex items-center gap-2 justify-end pt-2">
          <button
            onClick={onClose}
            style={{
              padding: '6px 16px',
              fontSize: 11,
              fontFamily: "'SF Mono', monospace",
              color: 'var(--dim)',
              backgroundColor: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            style={{
              padding: '6px 16px',
              fontSize: 11,
              fontFamily: "'SF Mono', monospace",
              color: 'var(--bg)',
              backgroundColor: 'var(--accent)',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Save Agent
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  width: '100%',
  backgroundColor: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
  fontFamily: "'SF Mono', monospace",
  outline: 'none',
};

function Field({ label, required, children }) {
  return (
    <div>
      <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--dim)', fontSize: 10 }}>
        {label}{required && <span style={{ color: '#F85149' }}> *</span>}
      </label>
      {children}
    </div>
  );
}
