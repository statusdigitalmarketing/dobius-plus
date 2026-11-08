// The Settings page's sections, in page order. Settings.jsx tags each one with
// data-settings-section="<id>", and the Dashboard side nav lists these under
// its Settings entry as jump links. settings-sections.test.mjs keeps the two
// in sync, so a section added to the page without an entry here fails a test.
export const SETTINGS_SECTIONS = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'gws', label: 'Google Workspace' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'projects', label: 'Projects' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'today', label: 'Today Alerts' },
  { id: 'mobile', label: 'Mobile Access' },
  { id: 'team', label: 'Team' },
  { id: 'imessage', label: 'iMessage Bridge' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

// Sections that only work on macOS, hidden on Windows: iMessage Bridge reads
// Messages.app's chat.db, and Accounts switches Claude logins through the
// Keychain and finds running sessions with /bin/ps.
export const MAC_ONLY_SETTINGS_SECTIONS = new Set(['accounts', 'imessage']);

// The sections to show on this platform, in page order.
export function settingsSectionsFor(platform) {
  return platform === 'win32'
    ? SETTINGS_SECTIONS.filter((s) => !MAC_ONLY_SETTINGS_SECTIONS.has(s.id))
    : SETTINGS_SECTIONS;
}

export const settingsSectionSelector = (id) => `[data-settings-section="${id}"]`;

// The scrollTop that puts `elTop` (a viewport y, from getBoundingClientRect)
// `pad` px below the top of a scroller whose own top is at `boxTop`. Clamped
// at 0; the browser clamps the far end itself.
export function sectionScrollTop({ scrollTop, boxTop, elTop, pad = 12 }) {
  return Math.max(0, Math.round(scrollTop + elTop - boxTop - pad));
}
