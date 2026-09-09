// Shaping a GitHub release payload for the Updates panel.
//
// Its own module so it can be tested without importing auto-updater.js, which
// pulls in electron-updater and needs a real Electron app at import time.

// Release notes are capped because the panel renders a summary block, not a
// document.
const MAX_BODY_CHARS = 20000;

/**
 * Only the fields the Updates panel renders, each one type-checked. Anything
 * else on the payload is dropped rather than forwarded into the renderer.
 */
export function mapRelease(raw) {
  return {
    tag_name: typeof raw?.tag_name === 'string' ? raw.tag_name : null,
    name: typeof raw?.name === 'string' ? raw.name : null,
    html_url: typeof raw?.html_url === 'string' ? raw.html_url : null,
    body: typeof raw?.body === 'string' ? raw.body.slice(0, MAX_BODY_CHARS) : '',
    published_at: typeof raw?.published_at === 'string' ? raw.published_at : null,
  };
}
