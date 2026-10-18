// Local speech-to-text for the mobile voice feature. v1.0.80 switches from a
// per-request `whisper-cli + ffmpeg` fork/exec (2-3s cold start, model reloaded
// every time) to a managed `whisper-server` subprocess with the model held in
// VRAM: on a warm model a 4s clip transcribes in ~60ms (50x faster, measured on
// M5 Max with ggml-base.en.bin on 2026-10-18). Same exported API, same fallback
// to the old spawn-per-request path if whisper-server is not installed, so the
// change is invisible to callers.
//
// Pipeline (new): webm/opus blob -> POST multipart /inference -> text.
// Pipeline (fallback): webm/opus blob -> ffmpeg to 16kHz mono WAV -> whisper-cli -> text.

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import net from 'net';
import { spawn, execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { app } from 'electron';

const WHISPER_SERVER_CANDIDATES = ['/opt/homebrew/bin/whisper-server', '/usr/local/bin/whisper-server'];
const WHISPER_CLI_CANDIDATES = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'];
const FFMPEG_CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
const MODEL_CANDIDATES = [
  path.join(os.homedir(), '.samknows', 'models', 'ggml-base.en.bin'),
  path.join(os.homedir(), '.cache', 'whisper-cpp', 'ggml-base.en.bin'),
  path.join(os.homedir(), '.cache', 'whisper-cpp', 'ggml-medium.en.bin'),
];
// A recorded voice command is short; cap the upload so a bad/hostile client
// can't fill the disk or hang whisper.
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
// Pick a port well above the mobile-server bridge (8420/8421) and the dev-mode
// vite range. 127.0.0.1 bind only, so collisions can only come from other local
// services; ensureServer() falls through to the next port if 8089 is taken.
const SERVER_HOST = '127.0.0.1';
const SERVER_PORT_CANDIDATES = [8089, 8189, 8289, 8389, 8489];
// Give the server up to this long to answer its first health probe. On an M-series
// Mac with ggml-base.en.bin cold start is ~1-2s; medium models can be 3-5s.
const READY_TIMEOUT_MS = 15000;

function firstExecutable(cands) {
  for (const p of cands) {
    try { fsSync.accessSync(p, fsSync.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}
function firstFile(cands) {
  for (const p of cands) {
    try { if (fsSync.statSync(p).size > 0) return p; } catch { /* next */ }
  }
  return null;
}

/** Can we transcribe locally at all? True if either the server OR the CLI path
 *  is viable. Both paths need ffmpeg: the CLI pipeline runs it directly, and
 *  the server launches with --convert which shells out to a bare `ffmpeg`
 *  (Codex r2 P2-4: without this guard, the module reports true, then every
 *  upload fails because the --convert step can't find ffmpeg). */
export function transcribeAvailable() {
  const model = firstFile(MODEL_CANDIDATES);
  const haveFfmpeg = !!firstExecutable(FFMPEG_CANDIDATES);
  if (!model || !haveFfmpeg) return false;
  const haveServer = !!firstExecutable(WHISPER_SERVER_CANDIDATES);
  const haveCli = !!firstExecutable(WHISPER_CLI_CANDIDATES);
  return haveServer || haveCli;
}

// -------- Managed whisper-server (fast path) --------

let serverState = null; // { child, port, generation }
let serverGeneration = 0;
let serverStarting = null; // Promise<serverState|null> while a start is in flight
let startingChild = null; // child currently mid-launch; shutdown must kill it even before serverState is set (Codex P1-3)
let serverTmpDir = null;  // scratch dir passed to --tmp-dir; purged on shutdown
const retiring = new Set(); // children we SIGTERMed; SIGKILL as escalation if still alive after RETIRE_KILL_MS (Codex r3 P2-2)
const RETIRE_KILL_MS = 2000;

// Single-shot probe that resolves to 'ok' | 'refused' | 'other-http' | 'timeout'.
// 'other-http' means a non-whisper service answered our probe (we did not spawn
// anything there): Codex P1-1 flagged that on a mis-bound port the parent would
// otherwise mark the port ready and route uploads at an unrelated service.
// Whisper's httplib backend sends `Server: whisper.cpp` on every response; that
// header is the reliable identity signal, independent of status code or body.
// The probePath is the random per-start secret prefix also used by requests
// (security review MEDIUM-1): it means an unprivileged local process cannot
// just POST to /inference blind, raising the bar from unauthenticated to
// "guess a 128-bit path first".
function probeOnce(port, probePath) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; try { req.destroy(); } catch { /* noop */ } resolve(v); };
    const req = http.request({ host: SERVER_HOST, port, path: probePath, method: 'GET', timeout: 800 }, (res) => {
      res.resume(); // drain the small body so the socket can close
      const server = String(res.headers.server || '').toLowerCase();
      done(server.includes('whisper') ? 'ok' : 'other-http');
    });
    req.on('error', (e) => done(e.code === 'ECONNREFUSED' ? 'refused' : 'other-http'));
    req.on('timeout', () => done('timeout'));
    req.end();
  });
}

async function waitForReady(child, port, probePath, deadline) {
  // Loop until one of: (a) a probe says this is our whisper-server, (b) the
  // child exits (someone else owns the port, model missing, bad args), (c) the
  // overall deadline passes. The single-shot probe above drops its own socket
  // on every outcome, so Codex P2-6 (retries multiplying from a timeout+error
  // double-fire) cannot happen.
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return 'child-exited';
    const r = await probeOnce(port, probePath);
    if (r === 'ok') return 'ok';
    if (r === 'other-http') return 'other-http'; // definitive, don't keep polling
    // 'refused' or 'timeout': keep waiting
    await new Promise((res) => setTimeout(res, 200));
  }
  return 'timeout';
}

// Try to bind a free TCP port in the candidate range before spawning
// whisper-server, so a port already in use does not race the probe (Codex r2
// P2-1): without this, our spawn exits immediately on bind failure while an
// unrelated process answers the probe, and we would mark that port 'ok'. By
// pre-probing we eliminate the race and skip occupied ports deterministically.
function tryBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    const close = (ok) => { try { srv.close(); } catch { /* noop */ } resolve(ok); };
    srv.once('error', () => close(false));
    srv.once('listening', () => close(true));
    try { srv.listen(port, SERVER_HOST); } catch { close(false); }
  });
}

// Confirm the given child owns the TCP listener on `port`. Codex r3 P1-1: a
// racing local process could have grabbed the port between tryBind's release
// and whisper-server's own bind (whisper loads the model before binding, so
// that window is seconds, not microseconds). Matching lsof's listener PID
// against child.pid closes the hijack path. One subprocess per server start,
// not per request.
function listenerPidOnPort(port) {
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t'], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null);
      const pids = stdout.split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
      resolve(pids);
    });
  });
}

// Retire a child we no longer trust. SIGTERM, then SIGKILL after
// RETIRE_KILL_MS if it has not exited (Codex r3 P2-2: a wedged ffmpeg in
// whisper's --convert path can keep whisper-server alive through SIGTERM,
// so .killed=true is not proof of death and a long-running session would
// leak memory as retired servers pile up).
function retireChild(child) {
  if (!child || retiring.has(child)) return;
  retiring.add(child);
  try { child.kill('SIGTERM'); } catch { /* noop */ }
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }
  }, RETIRE_KILL_MS);
  if (t.unref) t.unref();
  child.once('exit', () => { retiring.delete(child); clearTimeout(t); });
}

async function tryStartServer(bin, model, port, tmpDir, requestPath) {
  // --convert tells whisper-server to run ffmpeg itself on non-WAV uploads, so
  // we can POST the phone's raw webm/opus blob unchanged. --flash-attn is the
  // default on recent builds but keep it explicit. --tmp-dir points at a
  // dedicated per-session directory under os.tmpdir() so the server's
  // conversion leftovers are bounded to our own dir and cleaned on shutdown
  // (Codex r2 P2-3). cwd is the same dir so a relative "." in server code also
  // writes there. --request-path adds a per-start random path prefix that
  // only this process knows (security review MEDIUM-1), so a local
  // unprivileged process cannot blindly POST to /inference.
  const args = ['--model', model, '--host', SERVER_HOST, '--port', String(port), '--request-path', requestPath, '--convert', '--flash-attn', '--tmp-dir', tmpDir];
  const ffmpegBin = firstExecutable(FFMPEG_CANDIDATES);
  const extraPath = ffmpegBin ? [path.dirname(ffmpegBin)] : ['/opt/homebrew/bin', '/usr/local/bin'];
  const env = { ...process.env, PATH: [...extraPath, process.env.PATH || ''].filter(Boolean).join(':') };
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false, cwd: tmpDir, env });
  // Register the starting child immediately so a quit-during-start can kill
  // it even before readiness resolves (Codex P1-3).
  startingChild = child;
  // Attach the exit listener BEFORE awaiting readiness so a sync exit (bind
  // failure) is not lost between the spawn and the first await (Codex r2 P1-1
  // race). An exit sets exitCode synchronously, which waitForReady re-reads
  // between probes; the listener itself is just defense-in-depth for an
  // asynchronous child.exit that lands between settlement and the post-check.
  let exitEver = false;
  child.on('exit', () => { exitEver = true; });
  let tail = '';
  child.stderr.on('data', (b) => { tail = (tail + b.toString('utf8')).slice(-4096); });
  child.on('error', () => { /* readiness outcome handles it */ });

  const probePath = `${requestPath}/inference`;
  const outcome = await waitForReady(child, port, probePath, Date.now() + READY_TIMEOUT_MS);
  if (startingChild === child) startingChild = null;
  // Post-await exit check (Codex r2 P1-1 race).
  if (outcome === 'ok' && (exitEver || child.exitCode !== null || child.signalCode !== null)) {
    retireChild(child);
    console.warn(`[voice-transcribe] whisper-server :${port} probe-ok but child exited: ignoring to avoid hijack. tail=${tail.split('\n').slice(-3).join(' | ')}`);
    return { child: null, outcome: 'child-exited' };
  }
  // Ownership check (Codex r3 P1-1 race, security review MEDIUM-2): a
  // competitor could have bound the port between our tryBind close and
  // whisper's own bind. Fail CLOSED: if lsof cannot confirm this child owns
  // the LISTEN socket on this port, retire the child and move on. Trusting
  // the header probe alone would let a forged `Server: whisper.cpp` response
  // hijack the ownership verdict. On macOS lsof is a system tool at
  // /usr/sbin/lsof; the only time this fails is a hardened sandbox denying
  // the subprocess, in which case CLI fallback is the safe answer.
  if (outcome === 'ok') {
    const owners = await listenerPidOnPort(port);
    if (!owners || owners.length === 0 || !owners.includes(child.pid)) {
      retireChild(child);
      const reason = !owners ? 'lsof failed' : owners.length === 0 ? 'no LISTEN owner reported' : `LISTEN owned by pid(s) ${owners.join(',')} != ${child.pid}`;
      console.warn(`[voice-transcribe] whisper-server :${port} probe-ok but ${reason}; rejecting`);
      return { child: null, outcome: 'other-http' };
    }
  }
  if (outcome === 'ok') return { child, outcome };
  retireChild(child);
  console.warn(`[voice-transcribe] whisper-server :${port} ${outcome}. tail=${tail.split('\n').slice(-3).join(' | ')}`);
  return { child: null, outcome };
}

async function startServerLocked() {
  const bin = firstExecutable(WHISPER_SERVER_CANDIDATES);
  const model = firstFile(MODEL_CANDIDATES);
  if (!bin || !model) return null;
  const myGen = ++serverGeneration;
  // Dedicated tmp dir so whisper-server's --convert leftovers are bounded to a
  // directory we can purge at shutdown (Codex r2 P2-3). Includes pid to avoid
  // collision with other Dobius+ instances or a prior crash.
  const tmpDir = path.join(os.tmpdir(), `dobius-whisper-${process.pid}`);
  try { fsSync.mkdirSync(tmpDir, { recursive: true }); } catch { /* existing is fine */ }
  serverTmpDir = tmpDir;
  // Per-start random path prefix: 32 hex chars = 128 bits of entropy; no
  // local process can POST uploads blind without guessing it first.
  const requestPath = `/dobius-${randomBytes(16).toString('hex')}`;
  for (const port of SERVER_PORT_CANDIDATES) {
    // Skip ports that fail a pre-bind check; this moves the "port in use" race
    // out of band and prevents the probe from accepting a response from an
    // unrelated service while our bind failed (Codex r2 P2-1).
    if (!(await tryBind(port))) continue;
    const { child, outcome } = await tryStartServer(bin, model, port, tmpDir, requestPath);
    if (myGen !== serverGeneration) {
      try { child?.kill('SIGTERM'); } catch { /* noop */ }
      return null;
    }
    if (child) {
      const state = { child, port, generation: myGen, requestPath };
      serverState = state;
      child.on('exit', () => {
        if (serverState?.child === child) {
          console.log('[voice-transcribe] whisper-server exited, will relaunch on next request');
          serverState = null;
        }
      });
      console.log(`[voice-transcribe] whisper-server ready on :${port} (model=${path.basename(model)})`);
      return state;
    }
    // Any outcome (other-http, child-exited, timeout): try the next port. Codex
    // r2 P2-1 noted that stopping on child-exited was wrong, since the exit
    // can come from a bind collision with another local service, which says
    // nothing about the next port's health. Looping all five is cheap.
  }
  console.warn('[voice-transcribe] whisper-server could not be started; falling back to spawn-per-request');
  return null;
}

function ensureServer() {
  if (serverState?.child && !serverState.child.killed) return Promise.resolve(serverState);
  // Coalesce concurrent requests behind a single in-flight start so two voice
  // uploads that arrive together don't both fork whisper-server (and race for
  // the same port, leaving one orphan).
  if (!serverStarting) {
    serverStarting = startServerLocked().finally(() => { serverStarting = null; });
  }
  return serverStarting;
}

/** Shut the managed server down. Called from main.js on will-quit. */
export function stopVoiceTranscribe() {
  serverGeneration += 1; // invalidate any in-flight ensureServer
  const s = serverState;
  serverState = null;
  // retireChild escalates SIGTERM -> SIGKILL after RETIRE_KILL_MS; sufficient
  // for a wedged ffmpeg (Codex r3 P2-2).
  if (s?.child) retireChild(s.child);
  const sc = startingChild;
  startingChild = null;
  if (sc) retireChild(sc);
  // Codex r2 P2-3: purge the server's scratch dir so a crash during a failed
  // ffmpeg conversion does not leak audio uploads in /tmp.
  const td = serverTmpDir;
  serverTmpDir = null;
  if (td) {
    try { fsSync.rmSync(td, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

function buildMultipart(buffer, mimeType) {
  const boundary = `----n${randomBytes(16).toString('hex')}`;
  const ext = extFor(mimeType);
  const parts = [];
  parts.push(Buffer.from(`--${boundary}\r\n`));
  parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`));
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}\r\n`));
  parts.push(Buffer.from(`Content-Disposition: form-data; name="response_format"\r\n\r\ntext`));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

function postToServer(port, requestPath, buffer, mimeType, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ error: 'aborted' });
    const { body, boundary } = buildMultipart(buffer, mimeType);
    let settled = false;
    // One resolve point so a (timeout -> destroy -> error) or (close before
    // end) sequence cannot settle twice or leave the promise hung (Codex P1-2
    // and P2-7). The caller distinguishes 'aborted', 'timeout', and generic
    // transport errors via these specific keys.
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request({
      host: SERVER_HOST,
      port,
      path: `${requestPath}/inference`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return done({ error: `whisper-server status ${res.statusCode}` });
        }
        const text = Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').trim();
        if (!text) return done({ error: 'no speech detected' });
        done({ text });
      });
      // A truncated response (server died mid-send) would otherwise sit in
      // 'data' forever without an 'end' and the promise would never resolve.
      res.on('aborted', () => done({ error: 'whisper-server ECONNRESET' }));
      res.on('error', () => done({ error: 'whisper-server ECONNRESET' }));
      res.on('close', () => done({ error: 'whisper-server ECONNRESET' }));
    });
    req.on('error', (e) => {
      // Preserve timeout and abort identity so the fallback-decision in
      // transcribeAudio can route a hung server to the CLI path (Codex P2-7).
      const code = e?.code || (e?.message === 'timeout' ? 'ETIMEDOUT' : e?.message === 'aborted' ? 'ABORTED' : 'request error');
      if (code === 'ABORTED') return done({ error: 'aborted' });
      if (code === 'ETIMEDOUT') return done({ error: 'whisper-server ETIMEDOUT' });
      done({ error: `whisper-server ${code}` });
    });
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch { /* noop */ } });
    if (signal) {
      const onAbort = () => { try { req.destroy(new Error('aborted')); } catch { /* noop */ } };
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }
    req.write(body);
    req.end();
  });
}

// -------- Fallback: per-request spawn (unchanged behavior from pre-1.0.80) --------

function runCli(bin, args, timeout, signal) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024, signal }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function extFor(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  return 'bin';
}

async function transcribeViaCli(buffer, mimeType, signal) {
  const whisper = firstExecutable(WHISPER_CLI_CANDIDATES);
  const ffmpeg = firstExecutable(FFMPEG_CANDIDATES);
  const model = firstFile(MODEL_CANDIDATES);
  if (!whisper || !ffmpeg || !model) {
    return { error: 'whisper-cli / ffmpeg / model not installed on this Mac' };
  }
  const base = path.join(os.tmpdir(), `dobius-voice-${Date.now()}-${randomBytes(4).toString('hex')}`);
  const inFile = `${base}.${extFor(mimeType)}`;
  const wavFile = `${base}.wav`;
  const outPrefix = base;
  const txtFile = `${base}.txt`;
  try {
    await fs.writeFile(inFile, buffer, { mode: 0o600 });
    const conv = await runCli(ffmpeg, ['-y', '-i', inFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavFile], 30000, signal);
    if (signal?.aborted) return { error: 'aborted' };
    if (conv.err || !fsSync.existsSync(wavFile)) return { error: 'could not decode the audio' };
    const tr = await runCli(whisper, ['-m', model, '-f', wavFile, '-otxt', '-nt', '-np', '-of', outPrefix], 120000, signal);
    if (signal?.aborted) return { error: 'aborted' };
    if (tr.err) return { error: 'transcription failed' };
    let text = '';
    try { text = (await fs.readFile(txtFile, 'utf8')).trim(); } catch { /* no output */ }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return { error: 'no speech detected' };
    return { text };
  } catch (e) {
    return { error: e?.code || 'transcribe error' };
  } finally {
    for (const f of [inFile, wavFile, txtFile]) {
      try { await fs.unlink(f); } catch { /* best effort */ }
    }
  }
}

/**
 * Transcribe a recorded audio buffer to text. Returns { text } or { error }.
 * Prefers the warm whisper-server; falls back to per-request whisper-cli if the
 * server is unavailable or dies mid-request. Never throws.
 */
export async function transcribeAudio(buffer, mimeType, signal) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { error: 'empty audio' };
  if (buffer.length > MAX_AUDIO_BYTES) return { error: 'audio too large' };
  if (signal?.aborted) return { error: 'aborted' };

  const srv = await ensureServer();
  if (srv?.child && !srv.child.killed) {
    const result = await postToServer(srv.port, srv.requestPath, buffer, mimeType, signal);
    if (!result.error) return result;
    // Codex r2 P2-2: a hung whisper-server (child alive, inference wedged) is
    // not self-healing. If we hit ETIMEDOUT or ECONNRESET on it, retire the
    // state so the next request starts a fresh server (either the current
    // generation's spawn, or the lazy ensureServer on the following call).
    const transient = result.error === 'whisper-server ECONNREFUSED'
      || result.error === 'whisper-server ECONNRESET'
      || result.error === 'whisper-server ETIMEDOUT'
      || result.error.startsWith('whisper-server status 5');
    if (transient && serverState?.child === srv.child) {
      serverState = null;
      retireChild(srv.child); // Codex r3 P2-2: escalates to SIGKILL if the child hangs through SIGTERM.
      console.warn(`[voice-transcribe] retired hung whisper-server (${result.error}); next request will respawn`);
    }
    if (!transient) return result;
    console.warn(`[voice-transcribe] server transient error (${result.error}); falling back to CLI for this request`);
  }
  return transcribeViaCli(buffer, mimeType, signal);
}

// Suppress "app is undefined" at import time in headless tests: electron.app is
// present when loaded under electron, but under a plain node unit test harness
// it's a shim. Only the hook from main.js needs it.
try { app?.on?.('will-quit', stopVoiceTranscribe); } catch { /* noop */ }
