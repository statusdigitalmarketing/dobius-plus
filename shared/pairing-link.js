// Pairing payload shared by the Mac's QR code (Settings) and the "text myself
// the address and code" iMessage (main). One builder so both always agree.

// The Mac's origin, scheme included: `https://my-mac.ts.net:8420` when HTTPS
// is on, `http://100.x.x.x:8420` when HTTP-only, so the phone pairs with the
// TLS listener rather than plaintext.
export function pairingOrigin(mobileStatus) {
  try {
    if (mobileStatus?.url) {
      const u = new URL(mobileStatus.url);
      return `${u.protocol}//${u.host}`;
    }
    if (mobileStatus?.address) return `http://${mobileStatus.address.host}:${mobileStatus.address.port}`;
  } catch { /* malformed url: no origin */ }
  return '';
}

// The QR's browser choice: the Mac's own mobile page, which any scanner opens
// in Safari or Chrome. (The app choice is the dobiusplus:// link below, which
// only opens when the iPhone app is installed; without it the camera reports
// "no usable data", so Settings offers both.) The code rides in
// the fragment only over HTTPS: on plain HTTP a phone off Tailscale can be
// served an impostor page by the local network that reads the fragment, so
// there the link prefills the Mac and the user types the code.
export function buildPairingWebLink(mobileStatus) {
  if (!mobileStatus?.pairingCode) return '';
  const origin = pairingOrigin(mobileStatus);
  if (!origin) return '';
  if (!origin.startsWith('https://')) return `${origin}/#pair`;
  return `${origin}/#pair=${encodeURIComponent(String(mobileStatus.pairingCode))}`;
}

// The dobiusplus:// deep link: the mobile app's @capacitor/app URL handler
// reads `host` and `code` off it and pre-fills the pairing screen.
export function buildPairingDeepLink(mobileStatus) {
  if (!mobileStatus?.pairingCode) return '';
  const origin = pairingOrigin(mobileStatus);
  if (!origin) return '';
  const params = new URLSearchParams({ host: origin, code: String(mobileStatus.pairingCode) });
  return `dobiusplus://pair?${params.toString()}`;
}

// Reads either QR the Mac can show, or a dobiusplus:// link: { host, code } with the
// address exactly as written (callers normalise it), or null if it is not a pairing link.
export function parsePairingLink(text) {
  let u;
  try { u = new URL(String(text).trim()); } catch { return null; }
  const code = (c) => String(c || '').replace(/\D/g, '').slice(0, 6);
  if (u.protocol === 'dobiusplus:') {
    if (u.hostname !== 'pair' && u.pathname.replace(/^\/+/, '').split('/')[0] !== 'pair') return null;
    const host = u.searchParams.get('host') || '';
    const c = code(u.searchParams.get('code'));
    return host || c ? { host, code: c } : null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const m = /^#pair(?:=(\d{6}))?$/.exec(u.hash);
  return m ? { host: u.origin, code: m[1] || '' } : null;
}

// The text iMessaged to the user's own handle: everything the phone needs,
// each on its own line so iOS linkifies the pair link by itself. '' when the
// server has no live code or address to send.
export function pairingText(mobileStatus) {
  const origin = pairingOrigin(mobileStatus);
  if (!mobileStatus?.running || !mobileStatus?.pairingCode || !origin) return '';
  return [
    'Dobius+ pairing',
    `Mac address: ${origin}`,
    `Pairing code: ${mobileStatus.pairingCode}`,
    `Tap to pair: ${buildPairingWebLink(mobileStatus)}`,
    `In the Dobius+ iPhone app: ${buildPairingDeepLink(mobileStatus)}`,
  ].join('\n');
}

