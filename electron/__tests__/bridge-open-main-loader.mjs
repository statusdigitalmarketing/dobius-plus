// Loader for bridge-open-main.test.mjs: bridge-open-main.js gets recording
// fakes for electron and the window, terminal, chat and data services (no
// windows, no node-pty); its pure imports (bridge-open-tab, claude-argv,
// screen-render, tab-id-util) resolve normally.
const FAKED = new Set(['electron', './window-manager.js', './terminal-manager.js', './chat-service.js', './data-service.js']);
export async function resolve(specifier, context, next) {
  if (FAKED.has(specifier) && context.parentURL?.split('?')[0].endsWith('/bridge-open-main.js')) {
    return { url: new URL('./fake-bridge-env.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
