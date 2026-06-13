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

  const app = express();

  // Intercept HTML files to inject reload script
  app.use((req, res, next) => {
    let filePath = path.join(projectPath, req.path === '/' ? 'index.html' : req.path);
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

  app.use(express.static(projectPath, { etag: false, maxAge: 0 }));

  const httpServer = createServer(app);
  _wss = new WebSocketServer({ server: httpServer, path: '/__vreload' });

  _watcher = chokidar.watch(projectPath, {
    ignored: /(^|[/\\])\.|node_modules/,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 50 },
  });
  _watcher.on('change', () => broadcast('reload'));
  _watcher.on('add', () => broadcast('reload'));

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
}

export function getVisualPort() { return _port; }
export function getVisualProjectPath() { return _projectPath; }

export function listVisualPages() {
  if (!_projectPath) return ['/'];
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
    const pages = walk(_projectPath, '').map((p) => p.replace(/\/index\.html$/, '/') || '/');
    return ['/'].concat(pages.filter((p) => p !== '/').sort()).slice(0, 40);
  } catch {
    return ['/'];
  }
}
