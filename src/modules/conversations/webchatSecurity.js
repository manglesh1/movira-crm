const crypto = require('node:crypto');
const config = require('../../config');
const proxyAddr = require('proxy-addr');
// Scope proxy trust to this public module; never trust arbitrary forwarded IPs.
const trustedProxies = String(process.env.WEBCHAT_TRUSTED_PROXIES || '').split(',').map(value => value.trim()).filter(Boolean);
const trustProxy = trustedProxies.length ? proxyAddr.compile(trustedProxies) : () => false;
function clientIp(req) { return proxyAddr(req, trustProxy); }

function error(message, statusCode = 400, code = 'verification_failed') {
  return Object.assign(new Error(message), { statusCode, code });
}
function digest(value) { return crypto.createHmac('sha256', config.internalApiSecret).update(`webchat:${value}`).digest('hex'); }
function equal(a, b) { return typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function browserChallenge(connectionId, origin, ip) {
  const payload = Buffer.from(JSON.stringify({ c: connectionId, o: origin, i: digest(ip), t: Date.now(), n: crypto.randomBytes(12).toString('hex') })).toString('base64url');
  return `${payload}.${digest(payload)}`;
}
function validateBrowserChallenge(value, connectionId, origin, ip, trap) {
  try {
    if (trap || typeof value !== 'string' || value.length > 2000) throw new Error();
    const [payload, signature, extra] = value.split('.');
    if (extra || !equal(digest(payload), signature)) throw new Error();
    const data = JSON.parse(Buffer.from(payload, 'base64url'));
    const age = Date.now() - data.t;
    if (data.c !== connectionId || data.o !== origin || data.i !== digest(ip) || !Number.isFinite(age) || age < 500 || age > 30 * 60_000) throw new Error();
  } catch { throw error('Please refresh the chat and try again.', 400, 'browser_check_failed'); }
}

module.exports = { browserChallenge, validateBrowserChallenge, clientIp };
