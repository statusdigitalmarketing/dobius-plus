// Bundles the phone-mode runner (electron/phone-runner.mjs) and the Agent SDK it loads into one file,
// dist-phone/phone-runner.mjs (docs/phone-mode-design.md, "The SDK", packaging). The SDK is a dev dependency, so
// electron-builder never packs node_modules/@anthropic-ai/* or its 60 MB of dependencies: only the code the runner
// reaches ships, and the SDK's per-platform native binaries are never needed (the runner passes the tab's own claude).
// Run: node scripts/build-phone-runner.mjs   (part of electron:build)
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist-phone', 'phone-runner.mjs');
fs.rmSync(path.dirname(outfile), { recursive: true, force: true });

const result = await build({
  entryPoints: [path.join(root, 'electron', 'phone-runner.mjs')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // The Electron that runs it (ELECTRON_RUN_AS_NODE) ships Node 20 or later.
  target: 'node20',
  // CommonJS dependencies inside an ES module bundle still call require() for Node's own modules.
  banner: { js: "import { createRequire as __dobiusCreateRequire } from 'node:module'; const require = __dobiusCreateRequire(import.meta.url);" },
  legalComments: 'eof',
  metafile: true,
  logLevel: 'warning',
});

const bytes = fs.statSync(outfile).size;
const inputs = Object.keys(result.metafile.inputs);
if (!inputs.some((p) => p.includes('@anthropic-ai/claude-agent-sdk'))) throw new Error('the Agent SDK is not in the bundle');
if (inputs.some((p) => /claude-agent-sdk-(darwin|linux|win32)/.test(p))) throw new Error('a native SDK binary package was bundled');
// ponytail: a size ceiling, so a dependency that starts pulling in something large is noticed at build time.
const CAP = 12 * 1024 * 1024;
if (bytes > CAP) throw new Error(`dist-phone/phone-runner.mjs is ${bytes} bytes, over the ${CAP} cap`);
console.log(`phone runner: ${(bytes / 1024 / 1024).toFixed(1)} MB from ${inputs.length} files`);
