// Automatic tab labels (2026-10-11, Sam: "the claude agent within dobius can
// rename the tab so that it's a little bit more clear about what each tab is
// doing").
//
// Two automatic sources feed a tab's label, and the user always beats both:
//   'title'  the terminal title (OSC 0/2). Claude Code sets it to the topic it
//            is working on, prefixed with a status glyph (✳ idle, braille
//            spinner frames while working).
//   'agent'  an explicit `dobius-tab "<summary>"` run inside the tab, which
//            reaches the renderer through the voice bridge's /tabRename.
// A manual rename sets labelLockedByUser and nothing automatic touches the
// label again until the user clears the name (unlockLabel).
//
// Pure functions only: the store and the tests both import this file.

export const MAX_TAB_LABEL = 40;

// Status glyphs Claude Code (and similar TUIs) put in front of the title:
// whitespace, the braille block (spinner frames), the dingbat stars and
// asterisks Claude cycles through, middle dot, bullets and record dots.
const LEADING_GLYPHS_RE = /^[\s⠀-⣿✠-❋·•∙⏺●○◐-◓*]+/u;
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'tcsh', 'csh', 'ksh', 'dash', 'nu', 'login']);

/**
 * Normalise any label text: drop control characters and leading status
 * glyphs, collapse whitespace, cap the length. Returns '' when nothing
 * readable is left.
 */
export function cleanLabel(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(CONTROL_RE, ' ').replace(LEADING_GLYPHS_RE, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > MAX_TAB_LABEL) s = `${s.slice(0, MAX_TAB_LABEL - 1).trimEnd()}…`;
  return s;
}

/**
 * Turn a terminal title into a tab label, or null when the title says
 * nothing about the work: a bare shell name, a path or `user@host: path`
 * prompt title, or Claude/Codex naming itself ("Claude Code", `claude
 * --resume <id>`).
 */
export function labelFromTitle(title) {
  if (typeof title !== 'string') return null;
  const s = title.replace(CONTROL_RE, ' ').replace(LEADING_GLYPHS_RE, '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.startsWith('~') || s.startsWith('/')) return null;
  if (/^[\w.-]+@[\w.-]+(:|$)/.test(s)) return null;
  const first = s.split(' ')[0].replace(/^-/, '').split('/').pop().toLowerCase();
  if (SHELLS.has(first)) return null;
  if (/^(claude|codex)( code)?$/i.test(s)) return null;
  if (/^(claude|codex)\s+-/i.test(s)) return null;
  const label = cleanLabel(s);
  return label || null;
}

// Labels the app assigns on its own: addTab's `Tab N`, a tear-off's `Tab`,
// a browser pane.
const DEFAULT_LABEL_RE = /^(Tab( \d+)?|Browser)$/;

// History names a session after the tab it ran in, capped like the session
// tag labels a user types in by hand.
export const MAX_SESSION_NAME = 50;

/**
 * The name a session takes from the tab it ran in, or null when the tab has
 * no real name. App-assigned defaults ("Tab 3", "Tab", "Browser") say nothing
 * about the work, so History keeps Claude's own summary for those rather than
 * listing a column of "Tab 1". Only control characters and runs of whitespace
 * are touched: a hand-typed name keeps its leading symbols.
 */
export function sessionNameFromTabLabel(label) {
  if (typeof label !== 'string') return null;
  const s = label.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!s || DEFAULT_LABEL_RE.test(s)) return null;
  return Array.from(s).slice(0, MAX_SESSION_NAME).join('');
}

/**
 * Is this tab's label the user's (or a launch-assigned agent name)? A tab
 * persisted before automatic labels existed has no flags at all; a
 * non-default label on it was set by hand (or by an agent launch), so it
 * counts as locked. Only an explicit false (unlockLabel) or an automatic
 * labelSource proves otherwise.
 */
export function isLabelLocked(tab) {
  if (!tab) return false;
  if (typeof tab.labelLockedByUser === 'boolean') return tab.labelLockedByUser;
  if (tab.labelSource) return false;
  return typeof tab.label === 'string' && !DEFAULT_LABEL_RE.test(tab.label);
}

/**
 * Apply an automatic label to a tab. Returns the SAME object when nothing
 * changes, so the caller can skip a store update (titles repeat on every
 * spinner frame and each store change persists the tab list).
 *
 * Precedence: user > agent > title. A title never replaces an agent label,
 * because Claude's own topic title updates on its own schedule and would
 * undo the summary the agent chose. The latest automatic text is always
 * remembered in autoLabel so unlocking can show it.
 */
export function applyAutoLabel(tab, rawLabel, source) {
  if (!tab || (source !== 'title' && source !== 'agent')) return tab;
  const label = source === 'title' ? labelFromTitle(rawLabel) : (cleanLabel(rawLabel) || null);
  if (!label) return tab;
  if (isLabelLocked(tab)) {
    if (source === 'title' && tab.autoLabelSource === 'agent') return tab;
    if (tab.autoLabel === label && tab.autoLabelSource === source) return tab;
    return { ...tab, autoLabel: label, autoLabelSource: source };
  }
  if (source === 'title' && tab.labelSource === 'agent') return tab;
  if (tab.label === label && tab.labelSource === source && tab.autoLabel === label) return tab;
  return { ...tab, label, labelSource: source, autoLabel: label, autoLabelSource: source };
}

/** A manual rename: always wins and locks out automatic labels. */
export function lockLabel(tab, label) {
  if (!tab) return tab;
  return { ...tab, label, labelLockedByUser: true };
}

/**
 * Clear the user's lock (they emptied the name). Shows the latest automatic
 * label when there is one, otherwise keeps the current text.
 */
export function unlockLabel(tab) {
  if (!tab) return tab;
  const next = { ...tab, labelLockedByUser: false };
  if (tab.autoLabel) {
    next.label = tab.autoLabel;
    next.labelSource = tab.autoLabelSource || 'title';
  } else {
    delete next.labelSource;
  }
  return next;
}

/**
 * The automatic-label fields of a tab, plus its Terminal/Chat view mode, for
 * carrying it into a tear-off window.
 */
export function labelMeta(tab) {
  const meta = { labelLockedByUser: isLabelLocked(tab) };
  for (const k of ['labelSource', 'autoLabel', 'autoLabelSource']) {
    if (typeof tab?.[k] === 'string') meta[k] = tab[k];
  }
  if (tab?.viewMode === 'chat') meta.viewMode = 'chat';
  return meta;
}

/** Inverse of labelMeta from a URL param; anything malformed yields {}. */
export function parseLabelMeta(json) {
  if (typeof json !== 'string' || !json) return {};
  let raw;
  try { raw = JSON.parse(json); } catch { return {}; } // malformed param: start with no label state
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  if (typeof raw.labelLockedByUser === 'boolean') out.labelLockedByUser = raw.labelLockedByUser;
  for (const k of ['labelSource', 'autoLabelSource']) {
    if (raw[k] === 'title' || raw[k] === 'agent') out[k] = raw[k];
  }
  if (typeof raw.autoLabel === 'string') out.autoLabel = cleanLabel(raw.autoLabel);
  if (raw.viewMode === 'chat') out.viewMode = 'chat';
  return out;
}
