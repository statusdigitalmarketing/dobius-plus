// Tabs mid-dock (window:dockTab in main.js): moving from a tear-off into a
// primary window. Their PTY may briefly read as ownerless (the source closed
// before the target claimed), so every cleanup that keys on "no live owner"
// must leave these alone. Own module so auto-resume can read it without
// importing window-manager.
export const dockingTabs = new Set();
