// Teammates on two different Tailscale networks (docs/team-communicator.md, "Teammates on another Tailscale
// network"). Pure, no electron: used by main (team-main, team-service) and the renderer (Settings > Team).
//
// A machine on another tailnet is reachable only after its owner SHARES it with you (Tailscale admin console,
// Machines, the machine's menu, Share). A shared machine is quarantined: it answers connections but cannot start
// one. Dobius teammates send to each other both ways, so each person shares their own computer with the other.

export const MACHINES_URL = 'https://console.tailscale.com/admin/machines';
export const SHARING_DOCS_URL = 'https://tailscale.com/kb/1084/sharing';

/** `host.tail1234.ts.net` -> `tail1234.ts.net`; null for anything that is not a full MagicDNS name. */
export function tailnetOf(host) {
  const m = /^[a-z0-9-]+\.([a-z0-9-]+\.ts\.net)\.?$/i.exec(String(host || '').trim());
  return m ? m[1].toLowerCase() : null;
}

/** True only when both names are MagicDNS names on DIFFERENT tailnets. */
export function crossTailnet(a, b) {
  const x = tailnetOf(a);
  const y = tailnetOf(b);
  return !!(x && y && x !== y);
}

/** Errors meaning "this name does not resolve" (Node on macOS and Windows). */
export function isNameError(err) {
  return /^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_NODATA|EAI_FAIL)$/.test(String(err || ''));
}

/**
 * Where `host` is in this computer's `tailscale status --json`: { found, online, ip } (ip: first IPv4, else first
 * IPv6), or { found: false }. A shared-in machine is listed under its owner's tailnet name, so this also answers
 * "has it been shared with me". Matching is on the full name only.
 */
export function peerInStatus(status, host) {
  const want = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!want || !status || typeof status !== 'object') return { found: false };
  for (const node of Object.values(status.Peer || {})) {
    const name = String(node?.DNSName || '').toLowerCase().replace(/\.$/, '');
    if (name !== want) continue;
    const ips = (Array.isArray(node.TailscaleIPs) ? node.TailscaleIPs : []).map(String);
    const ip = ips.find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x)) || ips.find((x) => /^[0-9a-f:]+$/i.test(x)) || null;
    return { found: true, online: node.Online !== false, ip };
  }
  return { found: false };
}

const tnName = (t) => String(t || '').replace(/\.ts\.net$/, '');
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

/**
 * The share steps for one direction, in plain words: `owner` (a name) shares the computer called `machine` on the
 * `ownerTailnet` network with `recipient` (a name). Lines without numbering, the UI numbers them.
 */
export function shareSteps({ owner, machine, recipient }) {
  const who = cap(owner || 'they');
  return [
    `${who}: open the Tailscale Machines page (${MACHINES_URL}) and find ${machine || 'this computer'}.`,
    'Click its ... menu, then Share, then the Copy invite link tab, then Copy share link.',
    `Send that link to ${recipient || 'your teammate'}. They open it, sign in with their own Tailscale account and accept.`,
  ];
}

/**
 * The whole explanation for two teammates on different tailnets. `me` and `them` are { name, host }; `missing` says
 * which share is not there yet: 'theirs' (their computer is not shared with me), 'mine', or 'both'/'unknown'.
 * Returns { title, why, steps: [{ heading, lines }], after } for the UI, and `text` for the CLI and notes.
 */
export function crossTailnetHelp({ me, them, missing = 'both' }) {
  const mine = tailnetOf(me?.host);
  const theirs = tailnetOf(them?.host);
  const myMachine = String(me?.host || '').split('.')[0] || 'your computer';
  const theirMachine = String(them?.host || '').split('.')[0] || 'their computer';
  const name = them?.name || 'your teammate';
  const title = `${cap(name)} is on a different Tailscale network`;
  const why = `Your computer is on ${tnName(mine) || 'one Tailscale network'} and ${name}'s is on ${tnName(theirs) || 'another'}. `
    + 'Computers on two networks only see each other once each owner shares their computer with the other. '
    + 'Tailscale lets a shared computer answer but not start a connection, so both of you share (two shares, once each).';
  const steps = [];
  if (missing !== 'mine') {
    steps.push({ heading: `${cap(name)} shares ${theirMachine} with you`, lines: shareSteps({ owner: name, machine: theirMachine, recipient: 'you' }) });
  }
  if (missing !== 'theirs') {
    steps.push({ heading: `You share ${myMachine} with ${name}`, lines: shareSteps({ owner: 'You', machine: myMachine, recipient: name }) });
  }
  const after = 'Sharing needs the Owner or Admin role on each Tailscale account (a personal account is its own Owner). '
    + 'When both shares are accepted, paste the invite again (or press Check connection).';
  const text = [title + '.', why, ...steps.flatMap((s, i) => [`${i + 1}. ${s.heading}:`, ...s.lines.map((l) => `   ${l}`)]), after].join('\n');
  return { title, why, steps, after, mine, theirs, text };
}
