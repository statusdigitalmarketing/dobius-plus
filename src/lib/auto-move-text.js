// What an automatic move on a usage limit tells the window
// (src/components/Project/AutoMoveNotices.jsx), from main's accounts:autoMove
// payload (electron/account-headroom-service.js autoTick).
const name = (a) => (a?.label ? `${a.label}${a.email ? ` (${a.email})` : ''}` : 'another account');

export function autoMoveText(tabLabel, p) {
  const from = name(p.from);
  switch (p.kind) {
    case 'moved':
      return {
        text: `${tabLabel} hit its usage limit on ${from}. Moved to ${name(p.to)} and asked to continue.`,
        note: `Claude in Chrome follows the one account its extension is signed in to, so browser tools in this tab work only if that is ${p.to?.email || name(p.to)}. Dobius opened no browser sign-in, so the extension and your other tabs are unchanged.`,
      };
    case 'failed':
      return { text: `${tabLabel} hit its usage limit on ${from}. Moving it to ${name(p.to)} did not work: ${String(p.error || 'something went wrong').replace(/[.\s]+$/, '')}. It is not tried again for 15 minutes.` };
    case 'stuck':
      return { text: `${tabLabel} hit its usage limit on ${from}. No other account has room right now (logged in, usage known, at least 20% left and not about to run out), so it stays. Dobius keeps checking.` };
    case 'cooldown':
      return { text: `${tabLabel} hit its usage limit again on ${from} less than 15 minutes after an automatic move, so it was left alone. Move it by hand from the tab's menu if you want.` };
    default:
      return null;
  }
}
