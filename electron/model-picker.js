// The model picker in the desktop Chat box (Asana 1220098108555124, Bryan):
// which models a tab's Claude can switch to, which one it runs now, and the one
// command that switches it.
//
// Measured on Claude Code 2.1.316:
//  - Claude caches its model catalog as JSON per account at
//    <claude config dir>/cache/model-catalog/<org>-<hash>-cc.json, refreshed
//    about hourly: names, descriptions, "main" vs "overflow" models and each
//    model's effort levels with the Recommended badge.
//  - `/model <id>` and `/effort <level>` typed at Claude's prompt switch the
//    running session AND save it as the default for new sessions on that
//    account (Claude's own words; there is no session-only form).
//  - Dobius's statusLine reporter keeps each session's latest statusLine
//    payload in <userData>/usage/<sid>.json, which carries model and effort.
//
// Pure apart from readModelCatalog's file reads: electron/__tests__/model-picker.test.mjs.

import fs from 'node:fs/promises';
import path from 'node:path';

export const EFFORT_IDS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_ID_RE = /^claude-[a-z0-9-]{1,64}$/;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_MODELS = 64;
const RECORD_FORMAT = 'DOBIUS1'; // claude-usage.js FORMAT

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** A cached catalog file's JSON -> { models: [...], fetchedAt } or null. */
export function normalizeCatalog(json) {
  const models = json?.catalog?.config?.models;
  if (!Array.isArray(models)) return null;
  const out = [];
  const seen = new Set();
  for (const m of models.slice(0, MAX_MODELS)) {
    const id = typeof m?.id === 'string' ? m.id : '';
    if (!MODEL_ID_RE.test(id) || seen.has(id)) continue;
    const name = str(m.name, 40);
    if (!name) continue;
    seen.add(id);
    const opts = m.thinking?.type === 'effort' && Array.isArray(m.thinking.effort_options) ? m.thinking.effort_options : [];
    const efforts = [];
    for (const o of opts) {
      if (!EFFORT_IDS.includes(o?.id) || efforts.some((e) => e.id === o.id)) continue;
      efforts.push({ id: o.id, name: str(o.name, 20) || o.id, badge: str(o.badge?.message, 40) });
    }
    const def = m.runtime?.default_effort;
    out.push({
      id,
      name,
      description: str(m.description, 80),
      section: m.section === 'main' ? 'main' : 'overflow',
      efforts,
      defaultEffort: efforts.some((e) => e.id === def) ? def : null,
    });
  }
  if (!out.length) return null;
  const fetchedAt = Number.isFinite(json.fetchedAt) ? json.fetchedAt : 0;
  return { models: out, fetchedAt };
}

/**
 * The newest catalog Claude cached for the first config dir that has one.
 * `dirs` are Claude config dirs, most specific first (the session's account,
 * then the default ~/.claude). Never throws; null when none is readable.
 */
export async function readModelCatalog(dirs) {
  for (const dir of dirs) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) continue;
    const cache = path.join(dir, 'cache', 'model-catalog');
    let names;
    try { names = (await fs.readdir(cache)).filter((n) => n.endsWith('-cc.json')); } catch { continue; }
    let best = null;
    for (const n of names.slice(0, 50)) {
      try {
        const file = path.join(cache, n);
        const st = await fs.stat(file);
        if (!st.isFile() || st.size > MAX_CATALOG_BYTES) continue;
        const cat = normalizeCatalog(JSON.parse(await fs.readFile(file, 'utf8')));
        if (cat && (!best || cat.fetchedAt > best.fetchedAt)) best = cat;
      } catch { /* unreadable or not JSON: skip it */ }
    }
    if (best) return best;
  }
  return null;
}

/**
 * What a session runs now, from its usage record (claude-usage.js format:
 * header line, config dir line, then the statusLine payload as JSON).
 * { modelId, modelName, effort, configDir } or null.
 */
export function currentFromRecord(text) {
  if (typeof text !== 'string') return null;
  const a = text.indexOf('\n');
  const b = a < 0 ? -1 : text.indexOf('\n', a + 1);
  if (b < 0) return null;
  const header = text.slice(0, a).split(' ');
  if (header[0] !== RECORD_FORMAT) return null;
  let payload;
  try { payload = JSON.parse(text.slice(b + 1)); } catch { return null; }
  const modelId = typeof payload?.model?.id === 'string' ? payload.model.id : null;
  if (!modelId) return null;
  const level = payload?.effort?.level;
  const bindingSet = header[1] === '1';
  const dir = text.slice(a + 1, b);
  return {
    modelId,
    modelName: str(payload.model.display_name, 40),
    effort: EFFORT_IDS.includes(level) ? level : null,
    // Only an absolute binding names a home we can read; unset means ~/.claude.
    configDir: bindingSet ? (dir.startsWith('/') ? dir : null) : '',
  };
}

/** A catalog model by id, also matching a dated id to its base ("claude-haiku-4-5-20251001"). */
export function findModel(catalog, id) {
  if (!catalog || typeof id !== 'string') return null;
  return catalog.models.find((m) => m.id === id)
    || catalog.models.find((m) => id.startsWith(`${m.id}-`) || m.id.startsWith(`${id}-`))
    || null;
}

/**
 * The ONE line typed into Claude for a choice, or null. Only ids from the
 * catalog and only effort levels the current model offers: nothing the window
 * sends is ever typed as given.
 */
export function pickerCommand(choice, catalog, currentModelId) {
  if (!choice || typeof choice !== 'object' || !catalog) return null;
  if (typeof choice.model === 'string') {
    const m = catalog.models.find((x) => x.id === choice.model);
    return m ? `/model ${m.id}` : null;
  }
  if (typeof choice.effort === 'string') {
    const m = findModel(catalog, currentModelId);
    if (!m || !m.efforts.some((e) => e.id === choice.effort)) return null;
    return `/effort ${choice.effort}`;
  }
  return null;
}
