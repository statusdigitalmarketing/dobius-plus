// Dev-harness hooks. MUST be main.js's FIRST import: config-manager (and
// friends) resolve app.getPath('userData') at module load, so the override has
// to run before they do. Both hooks are inert unless their env var is set,
// which never happens in a packaged launch.
//
//   DOBIUS_USERDATA_DIR  point userData at an isolated dir so a ship-test
//                        instance runs beside the real app without sharing
//                        config.json or its single-instance lock.
//   DOBIUS_DEV_CDP       open a CDP port (for Playwright screenshots).
import { app } from 'electron';

export const HARNESS_APP_NAME = 'Dobius+ Harness';

if (process.env.DOBIUS_USERDATA_DIR) {
  app.setPath('userData', process.env.DOBIUS_USERDATA_DIR);
  // Its own name too, so its Keychain item ("<name> Safe Storage", used by
  // safeStorage for the Fireflies key) is never the real app's: a harness
  // creating "Dobius+ Safe Storage" would make the signed app ask for
  // Keychain access later.
  app.setName(HARNESS_APP_NAME);
}
if (process.env.DOBIUS_DEV_CDP) {
  app.commandLine.appendSwitch('remote-debugging-port', String(parseInt(process.env.DOBIUS_DEV_CDP, 10) || 9223));
}
