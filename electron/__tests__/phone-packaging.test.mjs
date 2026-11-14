// The packaged app carries the phone-mode runner as one bundle with the Agent SDK in it, outside app.asar, and never
// packs the SDK's node_modules (docs/phone-mode-design.md, "The SDK", packaging).
// Run: node --test electron/__tests__/phone-packaging.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('electron-builder packs dist-phone and keeps it on disk', () => {
  const cfg = yaml.load(read('electron-builder.yml'));
  assert.ok(cfg.files.includes('dist-phone/**/*'), 'in files');
  assert.ok(cfg.asarUnpack.includes('dist-phone/**/*'), 'unpacked from app.asar');
  assert.ok(cfg.files.includes('electron/**/*') && cfg.files.includes('package.json'), 'the entry point is still packed');
});

test('the notices ship, and the bundle keeps Happy\'s MIT notice', () => {
  const cfg = yaml.load(read('electron-builder.yml'));
  assert.ok(cfg.files.includes('THIRD-PARTY-NOTICES.md'));
  const notices = read('THIRD-PARTY-NOTICES.md');
  assert.ok(notices.includes('Copyright (c) 2026 Happy Coder Contributors') && notices.includes('claude-agent-sdk'));
  // esbuild keeps only /*! and @license comments: the adapted file's notice must be one.
  assert.ok(read('electron/phone-runner-core.mjs').startsWith('/*!\n'));
  assert.ok(read('electron/phone-runner-core.mjs').includes('Copyright (c) 2026 Happy Coder Contributors'));
});

test('the SDK is a pinned dev dependency, so its node_modules never ship', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.devDependencies['@anthropic-ai/claude-agent-sdk'] || '', /^\d+\.\d+\.\d+$/, 'pinned exactly');
  assert.equal(pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'], undefined);
});

test('every Mac build makes the bundle before electron-builder runs', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['build:phone'], 'node scripts/build-phone-runner.mjs');
  const b = pkg.scripts['electron:build'];
  assert.ok(b.indexOf('scripts/build-phone-runner.mjs') > 0 && b.indexOf('scripts/build-phone-runner.mjs') < b.indexOf('electron-builder'), b);
  const sh = read('build-and-install.sh');
  assert.ok(sh.indexOf('npm run build:phone') > 0 && sh.indexOf('npm run build:phone') < sh.indexOf('npx electron-builder'));
});

test('main runs the unpacked bundle when packaged, the source in dev', () => {
  const main = read('electron/main.js');
  assert.match(main, /runnerPath: app\.isPackaged\s*\?\s*path\.join\(process\.resourcesPath, 'app\.asar\.unpacked', 'dist-phone', 'phone-runner\.mjs'\)\s*:\s*path\.join\(__dirname, 'phone-runner\.mjs'\),/);
  assert.ok(read('.gitignore').split('\n').includes('dist-phone/'));
});
