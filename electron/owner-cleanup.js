// One 'destroyed' listener per window, not one per tab (v1.0.70).
//
// terminal:create used to add `event.sender.once('destroyed', ...)` for EVERY
// PTY it created, all on the same window's WebContents. Restoring 11 tabs at
// boot tripped Node's warning ("11 destroyed listeners added to [WebContents]",
// seen once per launch in error.log on Sep 3, 4, 5 and 8), and because each
// closure lives until the WINDOW dies, a week of opening and closing tabs in
// one window kept growing the list. The tear-off claim path added one more.
//
// The job those closures did was identical: when the sender goes away, drop
// its ownership of terminal ids so they can be re-created later. One listener
// per sender that sweeps the ownership map does the same thing without the
// per-tab growth, and it naturally honours a transferred ownership (a tear-off
// may have moved the id to another window between create and destroy): only
// ids whose CURRENT owner is the dying sender are dropped.

/**
 * @param {Map<string, number>} owners  terminal id -> webContents.id
 * @returns {{ hook(sender: {id:number, once:Function}): boolean, hookedCount(): number }}
 */
export function createOwnerCleanup(owners) {
  const hooked = new Set(); // webContents.id with a live listener

  function hook(sender) {
    const ownerId = sender?.id;
    if (typeof ownerId !== 'number' || typeof sender.once !== 'function') return false;
    if (hooked.has(ownerId)) return false;
    hooked.add(ownerId);
    sender.once('destroyed', () => {
      hooked.delete(ownerId);
      for (const [id, oid] of owners) {
        if (oid === ownerId) owners.delete(id);
      }
    });
    return true;
  }

  return { hook, hookedCount: () => hooked.size };
}
