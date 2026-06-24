import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export const CLAUDE_DIR = path.join(os.homedir(), '.claude');
export const HISTORY_PATH = path.join(CLAUDE_DIR, 'history.jsonl');
export const STATS_PATH = path.join(CLAUDE_DIR, 'stats-cache.json');
export const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
export const CLAUDE_JSON_PATH = path.join(os.homedir(), '.claude.json');
export const MCP_BRIDGE_CONFIG = path.join(CLAUDE_DIR, 'mcp-bridge.json');
export const PLANS_DIR = path.join(CLAUDE_DIR, 'plans');
export const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
export const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// Hard cap on bytes read when only a tail of a JSONL file is requested.
// Transcript files reach tens of MB; reading them whole just to keep the last
// few lines is what OOM-crashed the main process when the dashboard fanned
// parseJsonl(..., 5) across thousands of files at once. 4MB of tail comfortably
// contains the last 100 lines of any real transcript while bounding memory.
const TAIL_CAP_BYTES = 4 * 1024 * 1024;
const TAIL_CHUNK_BYTES = 64 * 1024;

/**
 * Read only the trailing portion of a file that is guaranteed to contain at
 * least `minLines` complete lines (or the whole file if it is smaller).
 * Reads backwards in chunks so memory stays bounded regardless of file size.
 */
async function readTail(filePath, minLines) {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size <= TAIL_CHUNK_BYTES) {
      const buf = Buffer.alloc(size);
      await handle.read(buf, 0, size, 0);
      return buf.toString('utf8');
    }
    let pos = size;
    let buf = Buffer.alloc(0);
    let newlines = 0;
    // Stop once we have more newlines than requested (so we own minLines full
    // lines after dropping the partial first one), or we hit the byte cap.
    while (pos > 0 && newlines <= minLines && buf.length < TAIL_CAP_BYTES) {
      const readSize = Math.min(TAIL_CHUNK_BYTES, pos);
      pos -= readSize;
      const chunk = Buffer.alloc(readSize);
      await handle.read(chunk, 0, readSize, pos);
      buf = Buffer.concat([chunk, buf]);
      newlines = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) newlines++;
      }
    }
    return buf.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Parse a JSONL file asynchronously, skipping malformed lines.
 * When `limit > 0`, only the last `limit` parsed entries are returned, and the
 * file is read from the tail so memory stays bounded on huge transcripts.
 */
export async function parseJsonl(filePath, limit = 0) {
  try {
    const content = limit > 0
      ? await readTail(filePath, limit)
      : await fs.readFile(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    // The first line of a tail read may be truncated mid-record; JSON.parse
    // drops it harmlessly below, and slice(-limit) keeps only complete tail
    // entries, so the truncation never reaches a caller.
    const parsedLines = [];
    for (const line of lines) {
      try {
        parsedLines.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    if (limit > 0) {
      return parsedLines.slice(-limit);
    }
    return parsedLines;
  } catch (err) {
    console.warn(`[data-utils] Failed to parse ${filePath}:`, err.message);
    return [];
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once. Bounds both
 * memory and open file descriptors when fanning out over thousands of files.
 * Results are returned in input order; a thrown task rejects the whole call,
 * so callers that want best-effort should make `fn` swallow its own errors.
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length)))
    .fill(0)
    .map(async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    });
  await Promise.all(workers);
  return results;
}

/**
 * Calculate time ago string from timestamp.
 */
export function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Check if a path exists (async).
 */
export async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
