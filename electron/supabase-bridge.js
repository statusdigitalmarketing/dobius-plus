import os from 'node:os';
import { loadConfig } from './config-manager.js';

let projectsCache = null;
let projectsCacheAt = 0;

function creds() {
  const cfg = loadConfig().supabaseBridge || {};
  const envUrl = process.env.SUPABASE_URL;
  const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = cfg.url || envUrl;
  const key = cfg.serviceRoleKey || envKey;
  const enabled = cfg.enabled !== undefined ? cfg.enabled : Boolean(envUrl && envKey);

  if (enabled !== false && url && key) {
    return { url, key };
  }

  return null;
}

async function fetchProjects(c) {
  const now = Date.now();

  if (projectsCache && now - projectsCacheAt < 60000) {
    return projectsCache;
  }

  const r = await fetch(`${c.url}/rest/v1/projects?select=id,name,repo_path,client_owned,publish_enabled`, {
    method: 'GET',
    headers: {
      apikey: c.key,
      Authorization: `Bearer ${c.key}`,
    },
  });
  const rows = await r.json();
  projectsCache = Array.isArray(rows) ? rows : [];
  projectsCacheAt = now;
  return projectsCache;
}

function resolveProject(path, projects) {
  const base = path.split('/').filter(Boolean).at(-1);
  return projects.find((project) => (
    project.name === base || (project.repo_path && project.repo_path.endsWith(base))
  )) || null;
}

function gated(p) {
  return p.client_owned && !p.publish_enabled;
}

function hdrs(c, extra = {}) {
  return {
    apikey: c.key,
    Authorization: `Bearer ${c.key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

export async function publishRunStart(entry) {
  const c = creds();
  if (!c) return;

  try {
    const projects = await fetchProjects(c);
    const p = resolveProject(entry.projectPath || '', projects);
    if (!p || gated(p)) return;

    const r = await fetch(`${c.url}/rest/v1/work_runs?on_conflict=runner_ref`, {
      method: 'POST',
      headers: hdrs(c, { Prefer: 'return=representation,resolution=merge-duplicates' }),
      body: JSON.stringify([{
        runner_ref: entry.workId,
        project_id: p.id,
        lane: 'build',
        stage: 'running',
        status: 'running',
        started_at: new Date(entry.startedAt || Date.now()).toISOString(),
        mac_runner: os.hostname(),
      }]),
    });
    const rows = await r.json();
    const runId = Array.isArray(rows) && rows[0] && rows[0].id;

    if (runId) {
      await fetch(`${c.url}/rest/v1/work_events`, {
        method: 'POST',
        headers: hdrs(c),
        body: JSON.stringify([{
          run_id: runId,
          project_id: p.id,
          kind: 'build_started',
          payload: { description: entry.description || '' },
        }]),
      });
    }
  } catch (err) {
    console.warn(`[supabase-bridge] publishRunStart: ${err.message}`);
  }
}

export async function publishRunFinish(entry) {
  const c = creds();
  if (!c) return;

  try {
    const projects = await fetchProjects(c);
    const p = resolveProject(entry.projectPath || '', projects);
    if (!p || gated(p)) return;

    const status = entry.status === 'failed' ? 'failed' : 'done';
    const r = await fetch(`${c.url}/rest/v1/work_runs?runner_ref=eq.${encodeURIComponent(entry.workId)}`, {
      method: 'PATCH',
      headers: hdrs(c, { Prefer: 'return=representation' }),
      body: JSON.stringify({
        status,
        stage: 'finished',
        ended_at: new Date().toISOString(),
      }),
    });
    const rows = await r.json();
    const runId = Array.isArray(rows) && rows[0] && rows[0].id;

    if (runId) {
      await fetch(`${c.url}/rest/v1/work_events`, {
        method: 'POST',
        headers: hdrs(c),
        body: JSON.stringify([{
          run_id: runId,
          project_id: p.id,
          kind: 'build_done',
          payload: { status: entry.status, report: entry.finalReport || '' },
        }]),
      });
    }
  } catch (err) {
    console.warn(`[supabase-bridge] publishRunFinish: ${err.message}`);
  }
}
