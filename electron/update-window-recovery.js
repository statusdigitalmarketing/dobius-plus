// The app being replaced runs the shutdown, so a fix to that shutdown cannot protect
// the update that installs it. Through 2.2.0 an update restart could cut the saved
// window lists down to whatever was not opened that session: a deleted folder, say,
// and nothing else (Sam, Brett, Asana 1220218501615934). The backup each app writes
// just before installing still has the real lists, so the new version checks against
// it on its first launch. This only ever adds windows.
const OLD_BUG_FIXED_IN = '2.2.1';
const BACKUP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const asList = (v) => (Array.isArray(v) ? v : []);

// The old shutdown only lost windows when the list held an entry nothing reopened.
// With no such entry its "would wipe everything" guard kept the list, so a backup
// without one means this person was never hit and has nothing to get back.
function hadLeftovers(lists, exists) {
  return asList(lists.lastOpenProjects).some((p) => typeof p === 'string' && !exists(p))
    || asList(lists.lastTearOffs).length > 0
    || asList(lists.lastPrimaryWindows).length > 0;
}

function addMissing(config, key, entries, keyOf) {
  const current = asList(config[key]);
  const have = new Set(current.map(keyOf));
  const added = [];
  for (const entry of asList(entries)) {
    const k = keyOf(entry);
    if (!k || have.has(k)) continue;
    have.add(k);
    added.push(entry);
  }
  if (added.length) config[key] = [...current, ...added];
  return added;
}

const savedState = (backup, bucket, key) => {
  const saved = backup.windowState?.[bucket];
  return saved && key !== '__proto__' && Object.hasOwn(saved, key) ? saved[key] : null;
};

const tabIds = (tabs) => asList(tabs).map((t) => t?.id).filter((id) => typeof id === 'string');

// Every tab id another window will restore: `windows` from the saved window tabs, plus a
// listed undocked tear-off with no saved tabs, which recreates its own tab when it opens.
// `projects` separately, because a tear-off may take its own tab from a project list:
// startup strips it there. Two windows restoring one id leave a dead terminal in the
// second, and a backup can be older than a tab's last move.
function tabsHeldElsewhere(config, bucket, except) {
  const windows = new Set();
  for (const name of ['tearOffWindows', 'primaryWindows']) {
    for (const [key, w] of Object.entries(config[name] || {})) {
      if (!(name === bucket && key === except)) tabIds(w?.tabs).forEach((id) => windows.add(id));
    }
  }
  for (const t of asList(config.lastTearOffs)) {
    if (t && !t.docked && typeof t.tabId === 'string' && !(bucket === 'tearOffWindows' && t.tabId === except)) windows.add(t.tabId);
  }
  const projects = new Set();
  for (const p of Object.values(config.projects || {})) tabIds(p?.tabs).forEach((id) => projects.add(id));
  return { windows, projects };
}

// Loading the config already dropped the saved tabs of any window missing from the
// lists, so a window put back needs its tabs from the backup too, minus any tab that
// lives somewhere else now. False: nothing of this window is left, so it stays closed.
function restoreSavedTabs(config, bucket, key, backup) {
  if (!config[bucket] || typeof config[bucket] !== 'object') config[bucket] = {};
  if (Object.hasOwn(config[bucket], key)) return true;
  const { windows, projects } = tabsHeldElsewhere(config, bucket, key);
  const isTearOff = bucket === 'tearOffWindows';
  const saved = savedState(backup, bucket, key);
  const savedTabs = asList(saved?.tabs);
  if (savedTabs.length === 0) {
    // A tear-off with no saved tabs recreates its own tab when it opens.
    return !(isTearOff && windows.has(key));
  }
  const tabs = savedTabs.filter((t) => !windows.has(t?.id) && !(projects.has(t?.id) && !(isTearOff && t?.id === key)));
  if (tabs.length === 0) return false;
  config[bucket][key] = { ...saved, tabs };
  return true;
}

// `read(version)` returns { lists, windowState, mtimeMs } for that version's backup, or null.
export function recoverWindowLists(config, { runningVersion, read, exists, now }) {
  const sources = [];
  const added = [];
  const fresh = (b) => b && now - b.mtimeMs <= BACKUP_MAX_AGE_MS;
  let flagChanged = false;
  // First launch of this version. Not keyed on the quit reason: older versions never
  // recorded one. A version with no backup was installed by hand and lost nothing.
  if (config.windowListsCheckedFor !== runningVersion) {
    config.windowListsCheckedFor = runningVersion;
    flagChanged = true;
    const thisUpdate = read(runningVersion);
    if (fresh(thisUpdate)) sources.push(thisUpdate);
  }
  // Already hit by the update to 2.2.1, which has been their list ever since. Once only.
  if (!config.oldUpdateWindowsRecovered && runningVersion !== OLD_BUG_FIXED_IN) {
    config.oldUpdateWindowsRecovered = true;
    flagChanged = true;
    const hit = read(OLD_BUG_FIXED_IN);
    // Project windows only. This backup can be days old, and a tear-off or extra window
    // from it may hold a tab that has since moved to another window, which would then
    // restore twice and leave a dead terminal.
    if (fresh(hit) && hadLeftovers(hit.lists, exists)) {
      added.push(...addMissing(config, 'lastOpenProjects', hit.lists.lastOpenProjects, (p) => (typeof p === 'string' ? p : null)));
    }
  }
  for (const source of sources) {
    const { lists } = source;
    added.push(...addMissing(config, 'lastOpenProjects', lists.lastOpenProjects, (p) => (typeof p === 'string' ? p : null)));
    const usable = (x, id) => (typeof x?.[id] === 'string' && x[id] && typeof x.projectPath === 'string' ? x[id] : null);
    for (const t of addMissing(config, 'lastTearOffs', lists.lastTearOffs, (x) => usable(x, 'tabId'))) {
      if (restoreSavedTabs(config, 'tearOffWindows', t.tabId, source)) added.push(t);
      else config.lastTearOffs = config.lastTearOffs.filter((x) => x !== t);
    }
    for (const e of addMissing(config, 'lastPrimaryWindows', lists.lastPrimaryWindows, (x) => usable(x, 'windowKey'))) {
      if (restoreSavedTabs(config, 'primaryWindows', e.windowKey, source)) added.push(e);
      else config.lastPrimaryWindows = config.lastPrimaryWindows.filter((x) => x !== e);
    }
  }
  return { added: added.length, changed: flagChanged || added.length > 0 };
}
