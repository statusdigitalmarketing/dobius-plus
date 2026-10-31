export async function resolve(specifier, context, next) {
  if (specifier === 'electron') {
    return { url: new URL('./electron-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  // The real one reads app.getVersion() from the stub as it loads.
  if (specifier === 'electron-updater') {
    return { url: 'data:text/javascript,export default { autoUpdater: {} }', shortCircuit: true };
  }
  return next(specifier, context);
}
