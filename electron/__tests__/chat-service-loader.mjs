export async function resolve(specifier, context, next) {
  if (specifier === './terminal-manager.js' && context.parentURL?.split('?')[0].endsWith('/chat-service.js')) {
    return { url: new URL('./fake-terminal-manager.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
