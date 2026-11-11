// When a Tasks > Team row counts as done (team-service archive): marked, and still where it was when marked (same state,
// same report from the teammate's Mac). A delivery that fails afterwards, here or over there, is not done any more.
// One rule for main (auto-route, inbox room) and the page (lists, the Tasks badge).
export const isDone = (m) => !!m && !!m.archived && m.state === m.archivedState && (m.stage ?? null) === (m.archivedStage ?? null);
