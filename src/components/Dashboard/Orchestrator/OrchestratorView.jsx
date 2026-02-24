import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../../../store/store';
import { motion, AnimatePresence } from 'framer-motion';

const ALLOWED_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];

const MODEL_LABELS = {
  'claude-opus-4-6': 'Opus',
  'claude-sonnet-4-5-20250929': 'Sonnet',
  'claude-haiku-4-5-20251001': 'Haiku',
};

export default function OrchestratorView() {
  const activeOrchestration = useStore((s) => s.activeOrchestration);

  return (
    <div className="p-5 space-y-5">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        <h2
          className="text-sm font-semibold uppercase tracking-wider"
          style={{ color: 'var(--fg)', letterSpacing: '0.1em' }}
        >
          Orchestrator
        </h2>
        <div className="text-xs mt-0.5" style={{ color: 'var(--dim)', fontSize: 10 }}>
          Delegate tasks to your agent team
        </div>
      </motion.div>

      {activeOrchestration ? (
        <OrchestrationProgress />
      ) : (
        <TaskInput />
      )}
    </div>
  );
}

function TaskInput() {
  const [description, setDescription] = useState('');
  const [agents, setAgents] = useState([]);
  const [selectedAgents, setSelectedAgents] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [decomposing, setDecomposing] = useState(false);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);

  const setActiveOrchestration = useStore((s) => s.setActiveOrchestration);
  const addTab = useStore((s) => s.addTab);
  const removeTab = useStore((s) => s.removeTab);
  const currentProjectPath = useStore((s) => s.currentProjectPath);

  // Load agents
  useEffect(() => {
    if (!window.electronAPI?.agentsList) return;
    window.electronAPI.agentsList().then((list) => {
      setAgents(list || []);
      // Select all agents by default
      setSelectedAgents(new Set((list || []).map((a) => a.id)));
      setLoading(false);
    });
  }, []);

  // Load orchestration history
  useEffect(() => {
    if (!window.electronAPI?.orchestrationList) return;
    window.electronAPI.orchestrationList().then((runs) => {
      setHistory(runs || []);
    });
  }, []);

  const toggleAgent = useCallback((agentId) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);

  const handleDecompose = useCallback(async () => {
    if (!description.trim() || selectedAgents.size === 0) return;
    setDecomposing(true);
    setError(null);

    try {
      const availableAgents = agents.filter((a) => selectedAgents.has(a.id));
      const agentList = availableAgents.map((a) => `- ${a.name}: ${a.description}`).join('\n');

      const systemPrompt = `You are a task decomposition assistant. Given a user's task description and a list of available specialist agents, break the task into 2-5 independent sub-tasks. Each sub-task should be assignable to one specialist agent.

Available agents:
${agentList}

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "subtasks": [
    { "title": "...", "description": "...", "agentName": "..." }
  ]
}`;

      // Write system prompt to temp file
      const promptPath = await window.electronAPI.agentsWriteTempPrompt(systemPrompt);
      if (!promptPath) throw new Error('Failed to write decomposition prompt');

      // Create a temp tab for decomposition
      const tab = addTab(currentProjectPath);
      const tabId = tab.id;

      // Collect output from the temp tab
      let output = '';
      const removeDataListener = window.electronAPI.onTerminalData((id, data) => {
        if (id === tabId) output += data;
      });

      // Launch non-interactive claude with -p flag
      const safePath = promptPath.replace(/'/g, "'\\''");
      const cmd = `claude -p "${description.replace(/"/g, '\\"').replace(/`/g, '\\`')}" --model claude-haiku-4-5-20251001 --system-prompt-file '${safePath}'\r`;

      // Write command char-by-char with 5ms delay
      const chars = cmd.split('');
      for (let i = 0; i < chars.length; i++) {
        window.electronAPI.terminalWrite(tabId, chars[i]);
        if (i < chars.length - 1) await new Promise((r) => setTimeout(r, 5));
      }

      // Wait for completion (poll for terminal exit)
      const exitCode = await new Promise((resolve) => {
        const removeExitListener = window.electronAPI.onTerminalExit((id, code) => {
          if (id === tabId) {
            removeExitListener();
            resolve(code);
          }
        });
        // Timeout after 60s
        setTimeout(() => resolve(-1), 60000);
      });

      removeDataListener();

      // Clean up temp tab
      if (window.electronAPI) window.electronAPI.terminalKill(tabId);
      removeTab(tabId);

      if (exitCode !== 0 && exitCode !== null) {
        throw new Error(`Decomposition agent exited with code ${exitCode}`);
      }

      // Parse JSON from output — find the first { ... } block
      const jsonMatch = output.match(/\{[\s\S]*"subtasks"[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Failed to parse decomposition response');

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.subtasks || !Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
        throw new Error('No subtasks returned from decomposition');
      }

      // Map agentName to agentId
      const subtasks = parsed.subtasks.slice(0, 5).map((st, i) => {
        const matched = availableAgents.find(
          (a) => a.name.toLowerCase() === (st.agentName || '').toLowerCase()
        );
        return {
          id: `subtask-${i + 1}`,
          title: String(st.title || '').slice(0, 200),
          description: String(st.description || '').slice(0, 2000),
          agentId: matched?.id || availableAgents[i % availableAgents.length]?.id || '',
          tabId: null,
          status: 'pending',
          startedAt: null,
          completedAt: null,
          exitCode: null,
          outputSummary: null,
        };
      });

      // Create orchestration run
      const run = {
        id: `orch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        description: description.trim(),
        createdAt: Date.now(),
        status: 'running',
        subtasks,
        synthesis: null,
        completedAt: null,
      };

      await window.electronAPI.orchestrationSave(run);
      setActiveOrchestration(run);
    } catch (err) {
      console.error('[Orchestrator] Decomposition failed:', err);
      setError(err.message || 'Decomposition failed');
    } finally {
      setDecomposing(false);
    }
  }, [description, selectedAgents, agents, addTab, removeTab, currentProjectPath, setActiveOrchestration]);

  const handleLoadRun = useCallback(async (run) => {
    setActiveOrchestration(run);
  }, [setActiveOrchestration]);

  const handleDeleteRun = useCallback(async (runId) => {
    if (!window.electronAPI?.orchestrationDelete) return;
    await window.electronAPI.orchestrationDelete(runId);
    setHistory((prev) => prev.filter((r) => r.id !== runId));
  }, []);

  if (loading) return <OrchestratorSkeleton />;

  return (
    <div className="space-y-5">
      {/* Task input */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05, duration: 0.2 }}
        className="p-4 rounded-lg"
        style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <textarea
          value={description}
          onChange={(e) => { setDescription(e.target.value); setError(null); }}
          placeholder="Describe what you want to accomplish..."
          rows={4}
          maxLength={2000}
          style={{
            width: '100%',
            backgroundColor: 'var(--bg)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '10px 12px',
            fontSize: 12,
            fontFamily: "'SF Mono', monospace",
            outline: 'none',
            resize: 'vertical',
            lineHeight: 1.5,
          }}
        />

        {/* Agent selector */}
        <div className="mt-3">
          <div className="text-xs font-medium mb-2" style={{ color: 'var(--dim)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Available Agents ({selectedAgents.size}/{agents.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {agents.map((agent) => {
              const selected = selectedAgents.has(agent.id);
              return (
                <button
                  key={agent.id}
                  onClick={() => toggleAgent(agent.id)}
                  style={{
                    padding: '3px 10px',
                    fontSize: 10,
                    fontFamily: "'SF Mono', monospace",
                    color: selected ? 'var(--accent)' : 'var(--dim)',
                    backgroundColor: selected ? 'rgba(88,166,255,0.1)' : 'transparent',
                    border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 4,
                    cursor: 'pointer',
                    transition: 'all 150ms',
                  }}
                >
                  {agent.name}
                  {agent.model && (
                    <span style={{ marginLeft: 4, fontSize: 8, opacity: 0.6 }}>
                      {MODEL_LABELS[agent.model] || ''}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <div className="mt-3 text-xs px-3 py-1.5 rounded" style={{ backgroundColor: 'rgba(248,81,73,0.1)', color: '#F85149' }}>
            {error}
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={handleDecompose}
            disabled={!description.trim() || selectedAgents.size === 0 || decomposing}
            style={{
              padding: '6px 16px',
              fontSize: 11,
              fontFamily: "'SF Mono', monospace",
              color: (!description.trim() || selectedAgents.size === 0 || decomposing) ? 'var(--dim)' : 'var(--bg)',
              backgroundColor: (!description.trim() || selectedAgents.size === 0 || decomposing) ? 'var(--border)' : 'var(--accent)',
              border: 'none',
              borderRadius: 6,
              cursor: (!description.trim() || selectedAgents.size === 0 || decomposing) ? 'default' : 'pointer',
              transition: 'all 150ms',
            }}
          >
            {decomposing ? 'Decomposing...' : 'Decompose & Launch'}
          </button>
          {decomposing && (
            <span className="text-xs" style={{ color: 'var(--dim)', fontSize: 10 }}>
              Breaking down task with Haiku...
            </span>
          )}
        </div>
      </motion.div>

      {/* Decomposition skeleton loader */}
      <AnimatePresence>
        {decomposing && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="space-y-2"
          >
            {[1, 2, 3].map((i) => (
              <div key={i} className="p-3 rounded-lg animate-pulse" style={{ backgroundColor: 'var(--surface)' }}>
                <div className="h-3 w-32 rounded mb-2" style={{ backgroundColor: 'var(--border)' }} />
                <div className="h-2 w-full rounded mb-1" style={{ backgroundColor: 'var(--border)' }} />
                <div className="h-2 w-3/4 rounded" style={{ backgroundColor: 'var(--border)' }} />
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* History */}
      {history.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.2 }}
        >
          <div className="text-xs font-medium mb-2" style={{ color: 'var(--dim)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Recent Orchestrations
          </div>
          <div className="space-y-1.5">
            {[...history].reverse().slice(0, 10).map((run) => (
              <HistoryRow key={run.id} run={run} onLoad={handleLoadRun} onDelete={handleDeleteRun} />
            ))}
          </div>
        </motion.div>
      )}
    </div>
  );
}

function HistoryRow({ run, onLoad, onDelete }) {
  const statusColor = run.status === 'completed' ? '#3FB950' : run.status === 'failed' ? '#F85149' : 'var(--accent)';
  const date = new Date(run.createdAt).toLocaleDateString();
  const completedCount = run.subtasks?.filter((st) => st.status === 'completed').length || 0;
  const totalCount = run.subtasks?.length || 0;

  return (
    <div
      className="flex items-center gap-3 p-2.5 rounded-lg"
      style={{
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border)',
        cursor: 'pointer',
        transition: 'border-color 150ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(88,166,255,0.3)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
      onClick={() => onLoad(run)}
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
        style={{ backgroundColor: statusColor }}
      />
      <span className="text-xs flex-1 truncate" style={{ color: 'var(--fg)', fontSize: 11 }}>
        {run.description}
      </span>
      <span className="text-xs shrink-0" style={{ color: 'var(--dim)', fontSize: 9, fontFamily: "'SF Mono', monospace" }}>
        {completedCount}/{totalCount}
      </span>
      <span className="text-xs shrink-0" style={{ color: 'var(--dim)', fontSize: 9 }}>
        {date}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(run.id); }}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--dim)',
          cursor: 'pointer',
          fontSize: 10,
          padding: '0 2px',
          opacity: 0.5,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = '#F85149'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; e.currentTarget.style.color = 'var(--dim)'; }}
      >
        x
      </button>
    </div>
  );
}

function OrchestrationProgress() {
  const activeOrchestration = useStore((s) => s.activeOrchestration);
  const setActiveOrchestration = useStore((s) => s.setActiveOrchestration);
  const clearOrchestration = useStore((s) => s.clearOrchestration);
  const updateSubtaskStatus = useStore((s) => s.updateSubtaskStatus);
  const addTab = useStore((s) => s.addTab);
  const renameTab = useStore((s) => s.renameTab);
  const registerRunningAgent = useStore((s) => s.registerRunningAgent);
  const setActiveView = useStore((s) => s.setActiveView);
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const setDashboardTab = useStore((s) => s.setDashboardTab);
  const [agents, setAgents] = useState([]);
  const [agentMemories, setAgentMemories] = useState({});
  const [launching, setLaunching] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);

  // Load agents + memories to build system prompts
  useEffect(() => {
    if (!window.electronAPI?.agentsList) return;
    window.electronAPI.agentsList().then((list) => setAgents(list || []));
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.agentMemoryGet || agents.length === 0) return;
    Promise.all(agents.map(async (a) => {
      const mem = await window.electronAPI.agentMemoryGet(a.id);
      return [a.id, mem];
    })).then((entries) => {
      setAgentMemories(Object.fromEntries(entries.filter(([, m]) => m)));
    });
  }, [agents]);

  if (!activeOrchestration) return null;

  const { description, subtasks, status } = activeOrchestration;
  const completedCount = subtasks.filter((st) => st.status === 'completed').length;
  const failedCount = subtasks.filter((st) => st.status === 'failed').length;
  const totalCount = subtasks.length;
  const pendingCount = subtasks.filter((st) => st.status === 'pending').length;
  const allDone = subtasks.every((st) => st.status === 'completed' || st.status === 'failed');
  const progressPct = totalCount > 0 ? Math.round(((completedCount + failedCount) / totalCount) * 100) : 0;

  const launchSubtask = async (subtask) => {
    const agent = agents.find((a) => a.id === subtask.agentId);
    if (!agent || !window.electronAPI?.agentsWriteTempPrompt) return;

    // Build enhanced system prompt
    let prompt = agent.systemPrompt;
    const mem = agentMemories[agent.id];
    if (mem && (mem.context || mem.experience?.length > 0)) {
      let memorySection = '\n\n---\n## Agent Memory\n';
      if (mem.context) memorySection += `\n### Context\n${mem.context}\n`;
      if (mem.experience?.length > 0) {
        memorySection += '\n### Experience\n';
        mem.experience.forEach((exp, i) => { memorySection += `${i + 1}. ${exp}\n`; });
      }
      const maxMemory = 10000 - prompt.length - 50;
      if (maxMemory > 100) prompt += memorySection.slice(0, maxMemory);
    }

    // Append orchestrator task context
    prompt += `\n\n---\n## Orchestrated Task\nYou are working as part of an orchestrated team. Your specific assignment:\n\n**${subtask.title}**\n${subtask.description}\n\nOverall goal: ${description}\n`;

    const promptPath = await window.electronAPI.agentsWriteTempPrompt(prompt);
    if (!promptPath) return;

    const tab = addTab(currentProjectPath);
    renameTab(tab.id, `[O] ${subtask.title.slice(0, 30)}`);
    registerRunningAgent(agent.id, tab.id);

    // Update subtask status
    updateSubtaskStatus(subtask.id, { tabId: tab.id, status: 'running', startedAt: Date.now() });

    // Save to config
    const updatedRun = { ...useStore.getState().activeOrchestration };
    window.electronAPI.orchestrationSave(updatedRun);

    // Write claude command char-by-char with 5ms delay
    setTimeout(async () => {
      const modelFlag = agent.model && ALLOWED_MODELS.includes(agent.model) ? ` --model ${agent.model}` : '';
      const safePath = promptPath.replace(/'/g, "'\\''");
      const cmd = `claude --system-prompt-file '${safePath}'${modelFlag}\r`;
      const chars = cmd.split('');
      for (let i = 0; i < chars.length; i++) {
        window.electronAPI.terminalWrite(tab.id, chars[i]);
        if (i < chars.length - 1) await new Promise((r) => setTimeout(r, 5));
      }
    }, 500);
  };

  const handleLaunchAll = async () => {
    setLaunching(true);
    const pendingSubtasks = subtasks.filter((st) => st.status === 'pending');
    for (let i = 0; i < pendingSubtasks.length; i++) {
      await launchSubtask(pendingSubtasks[i]);
      if (i < pendingSubtasks.length - 1) await new Promise((r) => setTimeout(r, 1000));
    }
    setLaunching(false);
  };

  const handleCancel = () => {
    // Kill all running subtask tabs
    const runningSubtasks = subtasks.filter((st) => st.status === 'running' && st.tabId);
    runningSubtasks.forEach((st) => {
      if (window.electronAPI) window.electronAPI.terminalKill(st.tabId);
    });
    // Update orchestration
    const updatedRun = {
      ...activeOrchestration,
      status: 'failed',
      subtasks: subtasks.map((st) =>
        st.status === 'running' ? { ...st, status: 'failed', completedAt: Date.now() } : st
      ),
      completedAt: Date.now(),
    };
    setActiveOrchestration(updatedRun);
    window.electronAPI?.orchestrationSave(updatedRun);
    setCancelConfirm(false);
  };

  return (
    <div className="space-y-4">
      {/* Task description + progress */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="p-4 rounded-lg"
        style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <div className="text-xs font-medium mb-1" style={{ color: 'var(--dim)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          Task
        </div>
        <div className="text-sm" style={{ color: 'var(--fg)', lineHeight: 1.5 }}>
          {description}
        </div>

        {/* Progress bar */}
        <div className="mt-3 flex items-center gap-3">
          <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--border)' }}>
            <motion.div
              className="h-full rounded-full"
              style={{ backgroundColor: failedCount > 0 ? '#F85149' : '#3FB950' }}
              initial={{ width: 0 }}
              animate={{ width: `${progressPct}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
          <span className="text-xs shrink-0" style={{ color: 'var(--dim)', fontSize: 10, fontFamily: "'SF Mono', monospace" }}>
            {completedCount}/{totalCount}
          </span>
        </div>

        {/* Action buttons */}
        <div className="mt-3 flex items-center gap-2">
          {pendingCount > 0 && (
            <button
              onClick={handleLaunchAll}
              disabled={launching}
              style={{
                padding: '5px 14px',
                fontSize: 10,
                fontFamily: "'SF Mono', monospace",
                color: launching ? 'var(--dim)' : 'var(--bg)',
                backgroundColor: launching ? 'var(--border)' : 'var(--accent)',
                border: 'none',
                borderRadius: 4,
                cursor: launching ? 'default' : 'pointer',
              }}
            >
              {launching ? 'Launching...' : `Launch All (${pendingCount})`}
            </button>
          )}
          {!allDone && !cancelConfirm && (
            <button
              onClick={() => setCancelConfirm(true)}
              style={{
                padding: '5px 14px',
                fontSize: 10,
                fontFamily: "'SF Mono', monospace",
                color: '#F85149',
                backgroundColor: 'transparent',
                border: '1px solid #F85149',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          )}
          {cancelConfirm && (
            <>
              <button
                onClick={handleCancel}
                style={{
                  padding: '5px 14px',
                  fontSize: 10,
                  fontFamily: "'SF Mono', monospace",
                  color: '#F85149',
                  backgroundColor: 'rgba(248,81,73,0.1)',
                  border: '1px solid #F85149',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                Confirm Cancel
              </button>
              <button
                onClick={() => setCancelConfirm(false)}
                style={{
                  padding: '5px 14px',
                  fontSize: 10,
                  fontFamily: "'SF Mono', monospace",
                  color: 'var(--dim)',
                  backgroundColor: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                Keep Running
              </button>
            </>
          )}
          {subtasks.some((st) => st.status === 'running') && (
            <button
              onClick={() => setDashboardTab('board')}
              style={{
                padding: '5px 14px',
                fontSize: 10,
                fontFamily: "'SF Mono', monospace",
                color: 'var(--accent)',
                backgroundColor: 'transparent',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              View on Board
            </button>
          )}
        </div>
      </motion.div>

      {/* Status banner */}
      {allDone && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="px-4 py-2.5 rounded-lg text-center"
          style={{
            backgroundColor: failedCount === 0 ? 'rgba(63,185,80,0.1)' : 'rgba(248,81,73,0.1)',
            border: `1px solid ${failedCount === 0 ? 'rgba(63,185,80,0.3)' : 'rgba(248,81,73,0.3)'}`,
          }}
        >
          <span className="text-xs font-semibold" style={{ color: failedCount === 0 ? '#3FB950' : '#F85149', fontFamily: "'SF Mono', monospace" }}>
            {failedCount === 0 ? 'All Succeeded' : `${failedCount} Failed`}
          </span>
          <span className="text-xs ml-2" style={{ color: 'var(--dim)', fontSize: 10 }}>
            {completedCount} completed, {failedCount} failed
            {activeOrchestration.completedAt && activeOrchestration.createdAt && (
              <> &middot; {formatElapsed(activeOrchestration.completedAt - activeOrchestration.createdAt)}</>
            )}
          </span>
        </motion.div>
      )}

      {/* Subtask cards */}
      <div className="space-y-2">
        {subtasks.map((st, i) => (
          <SubtaskCard
            key={st.id}
            subtask={st}
            index={i}
            agent={agents.find((a) => a.id === st.agentId)}
            onLaunch={() => launchSubtask(st)}
          />
        ))}
      </div>

      {/* Footer actions */}
      <div className="flex items-center gap-2">
        {allDone && (
          <button
            onClick={clearOrchestration}
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
            New Task
          </button>
        )}
      </div>
    </div>
  );
}

function formatElapsed(ms) {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function SubtaskCard({ subtask, index, agent, onLaunch }) {
  const [expanded, setExpanded] = useState(false);
  const agentActivity = useStore((s) => s.agentActivity);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setActiveView = useStore((s) => s.setActiveView);

  const { title, description, agentId, tabId, status, exitCode, outputSummary } = subtask;
  const activity = agentId ? agentActivity[agentId] : null;

  const statusColor = status === 'completed' ? '#3FB950' : status === 'failed' ? '#F85149' : status === 'running' ? 'var(--accent)' : 'var(--dim)';
  const statusLabel = status === 'completed' ? 'Done' : status === 'failed' ? 'Failed' : status === 'running' ? 'Running' : 'Pending';

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.2 }}
      className="p-3 rounded-lg"
      style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center gap-2">
        {/* Status indicator */}
        <span
          className="inline-block w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: statusColor }}
        />
        {/* Title */}
        <span className="text-xs font-semibold flex-1" style={{ color: 'var(--fg)', fontSize: 11 }}>
          {title}
        </span>
        {/* Agent badge */}
        {agent && (
          <span
            className="text-xs px-1.5 py-0.5 rounded"
            style={{ fontSize: 8, backgroundColor: 'rgba(88,166,255,0.1)', color: 'var(--accent)' }}
          >
            {agent.name}
          </span>
        )}
        {/* Status label */}
        <span className="text-xs" style={{ color: statusColor, fontSize: 9, fontFamily: "'SF Mono', monospace" }}>
          {statusLabel}
        </span>
        {exitCode !== null && exitCode !== undefined && (
          <span className="text-xs" style={{ color: exitCode === 0 ? '#3FB950' : '#F85149', fontSize: 9, fontFamily: "'SF Mono', monospace" }}>
            exit {exitCode}
          </span>
        )}
        {subtask.startedAt && subtask.completedAt && (
          <span className="text-xs" style={{ color: 'var(--dim)', fontSize: 9, fontFamily: "'SF Mono', monospace" }}>
            {formatElapsed(subtask.completedAt - subtask.startedAt)}
          </span>
        )}
      </div>

      {/* Description */}
      <div className="mt-1 text-xs" style={{ color: 'var(--dim)', fontSize: 10, lineHeight: 1.4 }}>
        {description}
      </div>

      {/* Live activity */}
      {activity && status === 'running' && (
        <div className="mt-1.5 text-xs" style={{ color: 'var(--accent)', fontSize: 9, fontFamily: "'SF Mono', monospace" }}>
          {activity.currentAction || 'Working...'}
        </div>
      )}

      {/* Actions */}
      <div className="mt-2 flex items-center gap-1.5">
        {status === 'pending' && (
          <button
            onClick={onLaunch}
            style={{
              padding: '2px 8px',
              fontSize: 9,
              fontFamily: "'SF Mono', monospace",
              color: 'var(--bg)',
              backgroundColor: 'var(--accent)',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            Launch
          </button>
        )}
        {tabId && status === 'running' && (
          <button
            onClick={() => { setActiveTab(tabId); setActiveView('terminal'); }}
            style={{
              padding: '2px 8px',
              fontSize: 9,
              fontFamily: "'SF Mono', monospace",
              color: 'var(--accent)',
              backgroundColor: 'transparent',
              border: '1px solid var(--accent)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            View Terminal
          </button>
        )}
        {outputSummary && (
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              padding: '2px 8px',
              fontSize: 9,
              fontFamily: "'SF Mono', monospace",
              color: expanded ? 'var(--accent)' : 'var(--dim)',
              backgroundColor: 'transparent',
              border: `1px solid ${expanded ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {expanded ? 'Hide Output' : 'Show Output'}
          </button>
        )}
      </div>

      {/* Expandable output */}
      <AnimatePresence>
        {expanded && outputSummary && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: 'hidden' }}
          >
            <pre
              className="mt-2 p-2 rounded text-xs"
              style={{
                backgroundColor: 'var(--bg)',
                color: 'var(--dim)',
                fontSize: 9,
                fontFamily: "'SF Mono', monospace",
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 200,
                overflowY: 'auto',
              }}
            >
              {outputSummary}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function OrchestratorSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-32 rounded-lg animate-pulse" style={{ backgroundColor: 'var(--surface)' }} />
      <div className="h-20 rounded-lg animate-pulse" style={{ backgroundColor: 'var(--surface)' }} />
    </div>
  );
}
