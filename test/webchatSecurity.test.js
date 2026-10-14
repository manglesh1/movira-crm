const test = require('node:test');
const assert = require('node:assert/strict');
const { browserChallenge, validateBrowserChallenge, clientIp } = require('../src/modules/conversations/webchatSecurity');

test('browser challenges reject tampering, wrong scope, expiry and bot traps', t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const token = browserChallenge('widget-a', 'https://park.example', '127.0.0.1');
  const verify = (value = token, widget = 'widget-a', origin = 'https://park.example', ip = '127.0.0.1', trap = '') => validateBrowserChallenge(value, widget, origin, ip, trap);
  assert.throws(() => verify(), { code: 'browser_check_failed' });
  now += 1000; assert.doesNotThrow(() => verify());
  assert.throws(() => verify(`${token}x`), { code: 'browser_check_failed' });
  assert.throws(() => verify(token, 'widget-b'), { code: 'browser_check_failed' });
  assert.throws(() => verify(token, 'widget-a', 'https://other.example'), { code: 'browser_check_failed' });
  assert.throws(() => verify(token, 'widget-a', 'https://park.example', '127.0.0.2'), { code: 'browser_check_failed' });
  assert.throws(() => verify(token, 'widget-a', 'https://park.example', '127.0.0.1', 'spam'), { code: 'browser_check_failed' });
  now += 31 * 60_000; assert.throws(() => verify(), { code: 'browser_check_failed' });
});

test('forwarded addresses are not trusted by default', () => {
  if (!process.env.WEBCHAT_TRUSTED_PROXIES) assert.equal(clientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.99' } }), '127.0.0.1');
});
