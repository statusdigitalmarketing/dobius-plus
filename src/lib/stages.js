// Shared pipeline-stage contract for the Kanban board (Epic 7).
// STAGES MUST stay byte-for-byte identical to electron/task-pipeline.js's STAGES
// (same names, same order) — the board columns and the state machine key off it.
// Other sessions (the Pipeline UI) depend on these exports verbatim.

export const STAGES = ['intake', 'queued', 'building', 'review', 'shiptest', 'approval', 'done', 'blocked'];

export const STAGE_META = {
  intake: { label: 'Intake' },
  queued: { label: 'Queued' },
  building: { label: 'Building' },
  review: { label: 'Review' },
  shiptest: { label: 'Ship-Test' },
  approval: { label: 'Approval' },
  done: { label: 'Done' },
  blocked: { label: 'Blocked' },
};

export const LANE_COLORS = { build: '#58A6FF', review: '#A371F7' };

// Group a flat task list into { stage: task[] } buckets, one per known stage.
// Tasks with an unrecognized stage get their own bucket so nothing is dropped.
export function groupByStage(tasks) {
  const g = Object.fromEntries(STAGES.map((s) => [s, []]));
  for (const t of (tasks || [])) {
    (g[t.stage] || (g[t.stage] = [])).push(t);
  }
  return g;
}
