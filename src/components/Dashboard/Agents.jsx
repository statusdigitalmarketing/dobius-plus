import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../../store/store';

const MODEL_LABELS = {
  'claude-opus-4-6': 'Opus',
  'claude-sonnet-4-5-20250929': 'Sonnet',
  'claude-haiku-4-5-20251001': 'Haiku',
};

export default function Agents() {
  const addTab = useStore((s) => s.addTab);
  const renameTab = useStore((s) => s.renameTab);
  const setActiveView = useStore((s) => s.setActiveView);
  const currentProjectPath = useStore((s) => s.currentProjectPath);

  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingAgent, setEditingAgent] = useState(null); // null = closed, {} = new, agent obj = editing

  const loadAgents = useCallback(async () => {
    if (!window.electronAPI?.agentsList) return;
    const list = await window.electronAPI.agentsList();
    setAgents(list || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const handleLaunch = useCallback(async (agent) => {
    if (!window.electronAPI?.agentsWriteTempPrompt) return;
    // Write system prompt to temp file
    const promptPath = await window.electronAPI.agentsWriteTempPrompt(agent.systemPrompt);
    if (!promptPath) return;
    // Create new tab
    const tab = addTab(currentProjectPath);
    renameTab(tab.id, agent.name);
    setActiveView('terminal');
    // Write claude command after a brief delay for terminal to initialize
    setTimeout(() => {
      const modelFlag = agent.model ? ` --model ${agent.model}` : '';
      // Shell-escape the prompt path
      const safePath = promptPath.replace(/'/g, "'\\''");
      const cmd = `claude --system-prompt-file '${safePath}'${modelFlag}\r`;
      window.electronAPI.terminalWrite(tab.id, cmd);
    }, 500);
  }, [addTab, renameTab, setActiveView, currentProjectPath]);

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

  if (loading) {
    return (
      <div className="p-6">
        <div className="grid grid-cols-2 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-32 rounded animate-pulse" style={{ backgroundColor: 'var(--surface)' }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--fg)', letterSpacing: '0.1em' }}>
          Agents
        </h2>
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
      <div className="grid grid-cols-2 gap-3">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="p-4 rounded-lg flex flex-col"
            style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="text-xs font-semibold flex items-center gap-2" style={{ color: 'var(--fg)' }}>
                  {agent.name}
                  {agent.builtIn && (
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{ fontSize: 9, backgroundColor: 'var(--border)', color: 'var(--dim)' }}
                    >
                      BUILT-IN
                    </span>
                  )}
                  {agent.model && (
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{ fontSize: 9, backgroundColor: 'rgba(88,166,255,0.15)', color: 'var(--accent)' }}
                    >
                      {MODEL_LABELS[agent.model] || agent.model}
                    </span>
                  )}
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--dim)', fontSize: 10, lineHeight: 1.4 }}>
                  {agent.description}
                </div>
              </div>
            </div>

            <div className="mt-auto pt-3 flex items-center gap-1.5">
              <button
                onClick={() => handleLaunch(agent)}
                style={{
                  padding: '4px 12px',
                  fontSize: 10,
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
              {!agent.builtIn && (
                <>
                  <button
                    onClick={() => setEditingAgent(agent)}
                    style={{
                      padding: '4px 10px',
                      fontSize: 10,
                      fontFamily: "'SF Mono', monospace",
                      color: 'var(--dim)',
                      backgroundColor: 'transparent',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      cursor: 'pointer',
                    }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(agent.id)}
                    style={{
                      padding: '4px 10px',
                      fontSize: 10,
                      fontFamily: "'SF Mono', monospace",
                      color: '#F85149',
                      backgroundColor: 'transparent',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      cursor: 'pointer',
                    }}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Editor modal */}
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
