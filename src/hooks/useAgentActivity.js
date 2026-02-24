import { useEffect, useRef } from 'react';
import { useStore } from '../store/store';

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

// Tool-use patterns Claude Code emits in terminal output
const TOOL_PATTERNS = [
  { re: /\b(Read|Reading)\s+(.{1,80})/, action: (m) => `Reading ${m[2].trim()}` },
  { re: /\b(Write|Writing)\s+(.{1,80})/, action: (m) => `Writing ${m[2].trim()}` },
  { re: /\b(Edit|Editing)\s+(.{1,80})/, action: (m) => `Editing ${m[2].trim()}` },
  { re: /\bBash\b/, action: () => 'Running command' },
  { re: /\b(Grep|Searching)\b/, action: () => 'Searching files' },
  { re: /\bGlob\b/, action: () => 'Finding files' },
  { re: /\bTask\b/, action: () => 'Running subagent' },
  { re: /\bWebFetch\b/, action: () => 'Fetching URL' },
  { re: /\bWebSearch\b/, action: () => 'Searching web' },
  { re: /\bTodoWrite\b/, action: () => 'Updating todos' },
];

const IDLE_TIMEOUT_MS = 5000;
const DEBOUNCE_MS = 500;

/**
 * Monitors terminal output for all running agents and updates
 * agentActivity in the Zustand store.
 *
 * Call once at the ProjectView level — it sets up a single
 * onTerminalData listener that routes data to per-agent buffers.
 */
export function useAgentActivity() {
  const lastDataTimestamps = useRef({});
  const lineCounters = useRef({});
  const debounceTimers = useRef({});
  const idleTimer = useRef(null);
  const lastActions = useRef({});

  useEffect(() => {
    if (!window.electronAPI?.onTerminalData) return;

    // Build reverse map: tabId → agentId
    const tabToAgent = () => {
      const ra = useStore.getState().runningAgents;
      const map = {};
      for (const [agentId, tabId] of Object.entries(ra)) {
        map[tabId] = agentId;
      }
      return map;
    };

    const parseAction = (cleanLine) => {
      for (const { re, action } of TOOL_PATTERNS) {
        const match = cleanLine.match(re);
        if (match) return action(match);
      }
      return null;
    };

    // Resolve agent name from store agents list (falls back to agentId)
    const getAgentName = (agentId) => {
      // Agent names aren't in the zustand store; use agentId as label
      return agentId;
    };

    const removeDataListener = window.electronAPI.onTerminalData((termId, data) => {
      const mapping = tabToAgent();
      const agentId = mapping[termId];
      if (!agentId) return;

      // Count lines
      const newLines = (data.match(/\n/g) || []).length + 1;
      lineCounters.current[agentId] = (lineCounters.current[agentId] || 0) + newLines;
      lastDataTimestamps.current[agentId] = Date.now();

      // Strip ANSI and parse
      const clean = data.replace(ANSI_RE, '');
      const detectedAction = parseAction(clean);

      // Append to timeline if action changed
      if (detectedAction && detectedAction !== lastActions.current[agentId]) {
        lastActions.current[agentId] = detectedAction;
        const actionType = detectedAction.startsWith('Reading') ? 'read'
          : detectedAction.startsWith('Writing') ? 'write'
          : detectedAction.startsWith('Editing') ? 'write'
          : detectedAction.startsWith('Running command') ? 'bash'
          : 'other';
        useStore.getState().appendActivityTimeline({
          timestamp: Date.now(),
          agentId,
          agentName: getAgentName(agentId),
          action: detectedAction,
          type: actionType,
        });
      }

      // Debounced store update
      clearTimeout(debounceTimers.current[agentId]);
      debounceTimers.current[agentId] = setTimeout(() => {
        const tab = useStore.getState().terminalTabs.find((t) => t.id === termId);
        useStore.getState().updateAgentActivity(agentId, {
          status: 'working',
          lastActivity: Date.now(),
          linesProcessed: lineCounters.current[agentId] || 0,
          startTime: tab?.createdAt || Date.now(),
          ...(detectedAction ? { currentAction: detectedAction } : {}),
        });
      }, DEBOUNCE_MS);
    });

    // Idle checker — runs every 2s, marks agents idle if no data for IDLE_TIMEOUT_MS
    idleTimer.current = setInterval(() => {
      const ra = useStore.getState().runningAgents;
      const now = Date.now();
      for (const agentId of Object.keys(ra)) {
        const lastTs = lastDataTimestamps.current[agentId];
        if (lastTs && now - lastTs > IDLE_TIMEOUT_MS) {
          const current = useStore.getState().agentActivity?.[agentId];
          if (current?.status === 'working') {
            useStore.getState().updateAgentActivity(agentId, { status: 'idle' });
          }
        }
      }
    }, 2000);

    return () => {
      removeDataListener();
      clearInterval(idleTimer.current);
      for (const t of Object.values(debounceTimers.current)) clearTimeout(t);
      debounceTimers.current = {};
      lineCounters.current = {};
      lastDataTimestamps.current = {};
      lastActions.current = {};
    };
  }, []);
}
