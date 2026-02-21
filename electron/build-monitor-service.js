import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { pathExists } from './data-utils.js';

/**
 * Validate and normalize projectDir to prevent path traversal.
 * Only allows absolute paths that resolve cleanly (no '..' components after normalization).
 */
function validateProjectDir(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') return null;
  const resolved = path.resolve(projectDir);
  if (resolved !== path.normalize(projectDir)) return null;
  return resolved;
}

/**
 * Load build progress from a project's claude-progress.json.
 * @param {string} projectDir — absolute path to the project directory
 * @returns {object|null}
 */
export async function loadBuildProgress(projectDir) {
  try {
    const validDir = validateProjectDir(projectDir);
    if (!validDir) return null;
    const filePath = path.join(validDir, 'claude-progress.json');
    if (!(await pathExists(filePath))) return null;
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.warn('[build-monitor] Failed to load progress:', err.message);
    return null;
  }
}

/**
 * Load the last 50 lines of the supervisor log.
 * @param {string} projectDir
 * @returns {string[]}
 */
export async function loadSupervisorLog(projectDir) {
  try {
    const validDir = validateProjectDir(projectDir);
    if (!validDir) return [];
    const filePath = path.join(validDir, 'scripts', 'supervisor.log');
    if (!(await pathExists(filePath))) return [];
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.trim().split('\n');
    return lines.slice(-50);
  } catch (err) {
    console.warn('[build-monitor] Failed to load supervisor log:', err.message);
    return [];
  }
}

/**
 * Load the HANDOFF.md from a project directory.
 * @param {string} projectDir
 * @returns {string}
 */
export async function loadHandoff(projectDir) {
  try {
    const validDir = validateProjectDir(projectDir);
    if (!validDir) return '';
    const filePath = path.join(validDir, 'HANDOFF.md');
    if (!(await pathExists(filePath))) return '';
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    console.warn('[build-monitor] Failed to load handoff:', err.message);
    return '';
  }
}

/**
 * Detect active autonomous build processes.
 * Uses pgrep to find claude processes with --dangerously-skip-permissions flag.
 * @returns {Array<{pid: string, command: string}>}
 */
export function detectActiveBuilds() {
  return new Promise((resolve) => {
    execFile('pgrep', ['-lf', 'claude.*dangerously-skip-permissions'], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve([]);
        return;
      }
      const lines = stdout.trim().split('\n').filter(Boolean);
      resolve(lines.map((line) => {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx === -1) return null;
        return {
          pid: line.slice(0, spaceIdx),
          command: line.slice(spaceIdx + 1),
        };
      }).filter(Boolean));
    });
  });
}
