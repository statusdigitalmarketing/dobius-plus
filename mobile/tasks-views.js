// The phone's Tasks views and the Mac feature each needs (authed.features). A Mac from before a view never advertises
// its flag, so the view never shows and the phone never sends that view's messages. Tested in
// electron/__tests__/phone-tasks.test.mjs.
export const VIEWS = Object.freeze([
  { id: 'today', label: 'Today', feature: 'today' },
  { id: 'commands', label: 'Commands', feature: 'commands' },
  { id: 'todo', label: 'To-do', feature: 'projectTasks' },
  { id: 'asana', label: 'Asana', feature: 'projectTasks' },
  { id: 'inbox', label: 'Inbox', feature: 'today' },
]);

/** The views this Mac can show, in order (null: it has not said yet). */
export const viewsFor = (features) => (Array.isArray(features) ? VIEWS.filter((v) => features.includes(v.feature)) : null);

/** The view to show: the one picked before if this Mac has it, else the first it has (null: none, or not known yet). */
export const currentView = (views, wanted) => (views?.some((v) => v.id === wanted) ? wanted : views?.[0]?.id || null);
