const { test } = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../cloudflare/user-proxy.mjs');

test('legacy user proxy forwards only credentials needed by fixed new origin and never caches private replies', async () => {
  const { proxyUser } = await modulePromise;
  const request = new Request('https://www.skinsdata.top/api/user/marks?revision=12&url=https://evil.test', {
    headers: { Authorization: 'Bearer test-session', Cookie: 'private=old-site', 'X-Forwarded-Host': 'evil.test' },
  });
  const response = await proxyUser(request, async (target, options) => {
    assert.equal(target, 'https://youtiao.fun/hokskins/api/user/marks?revision=12');
    assert.equal(options.headers.get('Authorization'), 'Bearer test-session');
    assert.equal(options.headers.get('Cookie'), null);
    assert.equal(options.headers.get('X-Forwarded-Host'), null);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    return new Response('{"revision":12}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'unexpected=x', 'Cache-Control': 'public, max-age=86400' } });
  });
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Cloudflare-CDN-Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { revision: 12 });
});

test('legacy multipart avatar body is streamed unchanged and redirect targets never receive credentials', async () => {
  const { proxyUser } = await modulePromise;
  const body = '--boundary\r\nprivate-avatar-bytes\r\n--boundary--';
  const request = new Request('https://skinsdata.top/api/user/profile/avatar', {
    method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=boundary' }, body,
  });
  const response = await proxyUser(request, async (target, options) => {
    assert.equal(await new Response(options.body).text(), body);
    assert.equal(options.headers.get('Content-Type'), 'multipart/form-data; boundary=boundary');
    return new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } });
  });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('Location'), null);
});

test('private proxy bounds methods, routes, known payload sizes and failures', async () => {
  const { proxyUser } = await modulePromise;
  const never = () => { throw new Error('should not call upstream'); };
  assert.equal((await proxyUser(new Request('https://skinsdata.top/api/user/unknown'), never)).status, 404);
  assert.equal((await proxyUser(new Request('https://skinsdata.top/api/user/profile', { method: 'PUT' }), never)).status, 405);
  assert.equal((await proxyUser(new Request('https://skinsdata.top/api/user/profile', { method: 'OPTIONS' }), never)).status, 204);
  assert.equal((await proxyUser(new Request('https://skinsdata.top/api/user/profile/avatar', { method: 'POST', headers: { 'Content-Length': '3000000' } }), never)).status, 413);
  assert.equal((await proxyUser(new Request('https://skinsdata.top/api/user/profile'), never)).status, 503);
  const html = await proxyUser(new Request('https://skinsdata.top/api/user/profile'), async () => new Response('<html/>'));
  assert.equal(html.status, 502);
});
