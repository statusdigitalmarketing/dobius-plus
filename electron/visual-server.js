/**
 * visual-server.js — live preview server for the Visual panel.
 *
 * Serves a project directory as a static site on a random localhost port.
 * Injects a WebSocket live-reload snippet into every HTML response so the
 * webview reloads automatically when Claude edits a file.
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';

const RELOAD_SNIPPET = `
<script>
(function(){
  var _vws=new WebSocket('ws://'+location.host+'/__vreload');
  _vws.onmessage=function(e){if(e.data==='reload')location.reload();};
  _vws.onclose=function(){setTimeout(function(){location.reload();},600);};
})();
</script>`;

let _server = null;
let _wss = null;
let _watcher = null;
let _port = null;
let _projectPath = null;
let _webRoot = null;

// Subfolders to probe (in priority order) when the project root has no
// index.html. Source/content dirs come before build outputs so we serve the
// editable files, not a stale build.
const WEB_ROOT_CANDIDATES = ['website', 'public', 'site', 'www', 'docs', 'dist', 'build', 'out'];

// Find the folder that actually contains index.html so sites kept in a
// subfolder (and using absolute asset paths like /css/app.css) preview
// correctly. Root index.html always wins, so existing projects are unaffected.
function resolveWebRoot(projectPath) {
  if (fs.existsSync(path.join(projectPath, 'index.html'))) return projectPath;
  for (const sub of WEB_ROOT_CANDIDATES) {
    if (fs.existsSync(path.join(projectPath, sub, 'index.html'))) return path.join(projectPath, sub);
  }
  return projectPath;
}

function broadcast(msg) {
  if (!_wss) return;
  _wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
}

function injectReload(html) {
  if (html.includes('</body>')) return html.replace('</body>', RELOAD_SNIPPET + '</body>');
  return html + RELOAD_SNIPPET;
}

export async function startVisualServer(projectPath) {
  if (_server) await stopVisualServer();
  _projectPath = projectPath;
  _webRoot = resolveWebRoot(projectPath);
  const webRoot = _webRoot;

  const app = express();

  // Intercept HTML files to inject reload script
  app.use((req, res, next) => {
    let filePath = path.join(webRoot, req.path === '/' ? 'index.html' : req.path);
    // Containment guard: `req.path` is not normalized, so `../` segments could
    // escape webRoot and read arbitrary local files. Reject anything that
    // resolves outside the web root before we readFileSync it.
    const resolved = path.resolve(filePath);
    if (resolved !== path.resolve(webRoot) && !resolved.startsWith(path.resolve(webRoot) + path.sep)) {
      return next();
    }
    // Attempt directory index
    if (!path.extname(filePath) || fs.existsSync(filePath + '.html')) {
      const candidate = fs.existsSync(filePath + '.html') ? filePath + '.html' : path.join(filePath, 'index.html');
      if (fs.existsSync(candidate)) filePath = candidate;
    }
    if (filePath.endsWith('.html') && fs.existsSync(filePath)) {
      try {
        const html = injectReload(fs.readFileSync(filePath, 'utf8'));
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(html);
      } catch { /* fall through to static */ }
    }
    next();
  });

  app.use(express.static(webRoot, { etag: false, maxAge: 0 }));

  const httpServer = createServer(app);
  _wss = new WebSocketServer({ server: httpServer, path: '/__vreload' });

  _watcher = chokidar.watch(webRoot, {
    ignored: /(^|[/\\])\.|node_modules|dist|build|\.next|\.vercel|coverage|out/,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 50 },
  });
  // Debounce so a multi-file save triggers ONE reload, not a storm.
  let reloadTimer = null;
  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { reloadTimer = null; broadcast('reload'); }, 150);
  };
  _watcher.on('change', scheduleReload);
  _watcher.on('add', scheduleReload);
  _watcher.on('unlink', scheduleReload);

  await new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      _port = httpServer.address().port;
      _server = httpServer;
      resolve();
    });
  });

  return _port;
}

export async function stopVisualServer() {
  if (_watcher) { try { await _watcher.close(); } catch {} _watcher = null; }
  if (_wss) { try { _wss.close(); } catch {} _wss = null; }
  if (_server) { await new Promise((r) => _server.close(r)); _server = null; }
  _port = null;
  _projectPath = null;
  _webRoot = null;
}

export function getVisualPort() { return _port; }
export function getVisualProjectPath() { return _projectPath; }

export function listVisualPages() {
  if (!_webRoot) return ['/'];
  try {
    const walk = (dir, base) => {
      const results = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        const rel = base + '/' + entry.name;
        if (entry.isDirectory()) results.push(...walk(full, rel));
        else if (entry.name.endsWith('.html')) results.push(rel);
      }
      return results;
    };
    const pages = walk(_webRoot, '').map((p) => p.replace(/\/index\.html$/, '/') || '/');
    return ['/'].concat(pages.filter((p) => p !== '/').sort()).slice(0, 40);
  } catch {
    return ['/'];
  }
}
