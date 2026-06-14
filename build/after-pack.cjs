// electron-builder afterPack hook.
//
// Why this exists: when electron-builder repacks the app and unpacks
// node-pty into app.asar.unpacked, it drops the execute bit on node-pty's
// `spawn-helper` (a Mach-O binary node-pty execs to launch the shell behind
// every PTY). Without +x, pty.spawn opens a pty but the shell never execs, so
// every terminal tab opens BLANK and never starts. This restores 0755 after
// packing and before code signing, so the signature seals the correct mode.
//
// Runtime symptom this prevents: "can't open new sessions, blank terminal,
// can't resume" (root-caused 2026-06-12, v1.0.22 build).

const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename; // e.g. "Dobius+"
  const helper = path.join(
    appOutDir,
    `${appName}.app`,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'build',
    'Release',
    'spawn-helper',
  );

  if (!fs.existsSync(helper)) {
    // Fail the build loudly: a missing spawn-helper means every terminal
    // would be blank, which is worse to ship silently than to stop here.
    throw new Error(`[after-pack] node-pty spawn-helper not found at ${helper}`);
  }

  fs.chmodSync(helper, 0o755);
  const mode = (fs.statSync(helper).mode & 0o777).toString(8);
  console.log(`[after-pack] restored exec bit on spawn-helper (mode ${mode})`);
};
