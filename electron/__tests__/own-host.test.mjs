// The phone server answers only requests addressed to this Mac: its tailnet
// IP or MagicDNS name at its port. A foreign Host is a DNS-rebinding page.
// Run: node ./electron/__tests__/own-host.test.mjs
import assert from 'node:assert/strict';
import { isOwnHost } from '../mobile-cors.js';

const mac = { ip: '100.89.143.67', name: 'sams-macbook-pro.tail6addbf.ts.net', port: 8420 };
let pass = 0;
const ok = (n) => { console.log(`PASS  ${n}`); pass += 1; };

assert.equal(isOwnHost('100.89.143.67:8420', mac), true); ok('the tailnet IP at its port');
assert.equal(isOwnHost('Sams-MacBook-Pro.tail6addbf.ts.net:8420', mac), true); ok('the MagicDNS name, any case');
assert.equal(isOwnHost('sams-macbook-pro.tail6addbf.ts.net.:8420', mac), true); ok('a trailing-dot FQDN is the same name');
assert.equal(isOwnHost('evil.example:8420', mac), false); ok('a rebinding page\'s own name is refused');
assert.equal(isOwnHost('100.89.143.67:8421', mac), false); ok('the right IP at another port is refused');
assert.equal(isOwnHost('100.89.143.67', mac), false); ok('no port is refused');
assert.equal(isOwnHost('', mac), false); assert.equal(isOwnHost(undefined, mac), false); ok('a missing Host is refused');
assert.equal(isOwnHost('sams-macbook-pro.tail6addbf.ts.net:8420', { ...mac, name: null }), false); ok('the name is refused while unknown, the IP still works');
assert.equal(isOwnHost('100.89.143.67:8420', { ...mac, name: null }), true);

assert.equal(isOwnHost('sams-macbook-pro:8420', mac), true); ok('the short machine name (MagicDNS resolves it)');
assert.equal(isOwnHost('sams-macbook-pro', mac), false); ok('the short name without the port is refused on 8420');
const std = { ...mac, port: 443 };
assert.equal(isOwnHost('sams-macbook-pro.tail6addbf.ts.net', std), true); ok('on 443 the name without a port (browsers drop it)');
assert.equal(isOwnHost('sams-macbook-pro.tail6addbf.ts.net:443', std), true);
assert.equal(isOwnHost('100.89.143.67', { ...mac, port: 80 }), true); ok('on 80 the IP without a port');
assert.equal(isOwnHost('evil.example', std), false); ok('a foreign name is refused on 443 too');
assert.equal(isOwnHost('sams-macbook-pro.tail6addbf.ts.net.', std), true); ok('a trailing dot with no port');
const strict = { ...mac, strict: true };
assert.equal(isOwnHost('sams-macbook-pro:8420', strict), false); ok('/pair refuses the short name (a search domain can repoint it)');
assert.equal(isOwnHost('sams-macbook-pro.tail6addbf.ts.net:8420', strict), true);
assert.equal(isOwnHost('100.89.143.67:8420', strict), true); ok('/pair takes the full name and the IP');
assert.equal(isOwnHost('100.64.0.20:8420', mac), true); ok('another tailnet IP literal (a shared Mac\'s translated address)');
assert.equal(isOwnHost('100.127.255.255:8420', strict), true); ok('tailnet IP literals pass /pair too (no DNS to rebind)');
assert.equal(isOwnHost('100.128.0.1:8420', mac), false); ok('just outside 100.64.0.0/10 is refused');
assert.equal(isOwnHost('192.168.1.5:8420', mac), false); ok('a LAN IP is refused');
assert.equal(isOwnHost('100.64.0.20:8421', mac), false); ok('a tailnet IP at another port is refused');
assert.equal(isOwnHost('100.64.0.20', mac), false); assert.equal(isOwnHost('100.64.0.20', std), true); ok('no port only on 80/443');
assert.equal(isOwnHost('100.64.0.999:8420', mac), false); ok('a malformed octet is refused');
console.log(`own-host: ${pass} pass`);
