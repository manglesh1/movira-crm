const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

test('widget errors retain allow-listed CORS and field details for retry', async () => {
  const servicePath = require.resolve('../src/modules/conversations/webchatService');
  const routePath = require.resolve('../src/modules/conversations/publicWebchatRoutes');
  const previous = require.cache[servicePath];
  const origin = 'https://booking.example';
  let fail = true;
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: {
    getPublicConfig: async (_key, requestOrigin) => {
      if (requestOrigin !== origin) throw Object.assign(new Error('Website not allowed'), { statusCode: 403 });
      return {};
    },
    leadRequest: async () => {
      if (fail) throw Object.assign(new Error('Please review the highlighted contact details.'), { statusCode: 400, details: { fieldErrors: { phone: 'Please enter a valid phone number.' } } });
      return { state: 'success' };
    },
    sessionStatus: async () => { throw Object.assign(new Error('Chat service is temporarily unavailable.'), {statusCode:500,details:{private:'must not leak'}}); },
  } };
  delete require.cache[routePath];
  const app = express(); app.use(express.json());
  app.use('/chat', require(routePath));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/chat/test`;
  try {
    const preflight = await fetch(`${base}/lead`, { method:'OPTIONS', headers:{ Origin:origin } });
    assert.equal(preflight.status,204);
    assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
    const invalid = await fetch(`${base}/lead`, { method:'POST', headers:{ Origin:origin } });
    assert.equal(invalid.status,400);
    assert.equal(invalid.headers.get('access-control-allow-origin'),origin);
    assert.equal((await invalid.json()).details.fieldErrors.phone,'Please enter a valid phone number.');
    fail = false;
    const retry = await fetch(`${base}/lead`, { method:'POST', headers:{ Origin:origin } });
    assert.equal((await retry.json()).data.state,'success');
    const upstream = await fetch(`${base}/session`, { headers:{ Origin:origin } });
    assert.equal(upstream.status,500);
    assert.equal(upstream.headers.get('access-control-allow-origin'),origin);
    assert.equal((await upstream.json()).details,undefined);
    const denied = await fetch(`${base}/lead`, { method:'POST', headers:{ Origin:'https://untrusted.example' } });
    assert.equal(denied.status,403);
    assert.equal(denied.headers.get('access-control-allow-origin'),null);
  } finally {
    await new Promise(resolve => server.close(resolve));
    delete require.cache[routePath];
    if (previous) require.cache[servicePath] = previous;
    else delete require.cache[servicePath];
  }
});
