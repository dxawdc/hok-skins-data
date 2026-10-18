const assert = require('node:assert/strict');
const { test } = require('node:test');
const core = import('../cloudflare/cache-core.mjs');

function context() {
  const pending = [];
  const entries = new Map();
  return {
    ctx: { waitUntil(promise) { pending.push(promise); } },
    cache: {
      async match(request) { return entries.get(request.url)?.clone(); },
      async put(request, response) { entries.set(request.url, response.clone()); },
    },
    async done() { await Promise.all(pending); },
  };
}
const req = (path, options) => new Request('https://www.skinsdata.top' + path, options);

test('API cache keys unify hosts and version/tracking parameters; pagination remains distinct', async () => {
  const { canonicalRequest } = await core;
  const a = canonicalRequest(req('/api/skins?v=profile-v6&utm_source=a')).url;
  assert.equal(a, 'https://skinsdata.top/api/skins');
  assert.equal(a, canonicalRequest(new Request(a + '?v=profile-v7')).url);
  assert.equal(canonicalRequest(req('/api/skins?offset=500&limit=500')).url,
    a + '?limit=500&offset=500');
  assert.throws(() => canonicalRequest(req('/api/skins?limit=-1')));
  assert.throws(() => canonicalRequest(req('/api/skins?offset=9999999999')));
});

test('refresh timestamps collapse into a bounded one-minute cache key', async () => {
  const { canonicalRequest } = await core;
  assert.equal(canonicalRequest(req('/api/skins?refresh=123'), 120000).url,
    canonicalRequest(req('/api/skins?refresh=999'), 120001).url);
  assert.notEqual(canonicalRequest(req('/api/skins?refresh=123'), 120000).url,
    canonicalRequest(req('/api/skins?refresh=123'), 180000).url);
});

test('image variants normalize dimensions/order/quality, strip tracking, separate formats', async () => {
  const { canonicalRequest } = await core;
  const a = canonicalRequest(req('/img/skin/test.png?quality=69&width=119&utm_source=test', { headers: { Accept: 'image/webp' } })).url;
  const b = canonicalRequest(req('/img/skin/test.png?height=120&width=120&quality=70&resize=contain', { headers: { Accept: 'image/webp' } })).url;
  assert.equal(a, b);
  assert.match(a, /width=120&height=120&quality=70&resize=contain&format=webp$/);
  assert.match(canonicalRequest(req('/img/skin/test.png?width=999999')).url, /width=1280/);
  assert.match(canonicalRequest(req('/img/skin/test.png?width=120')).url, /format=origin$/);
  assert.equal(canonicalRequest(req('/img/skin/test.png?random=1')).url, 'https://skinsdata.top/img/skin/test.png');
  assert.throws(() => canonicalRequest(req('/img/private/secret.png')));
});

test('private APIs and wildcard suffix paths pass through without invoking shared cache', async () => {
  const { gateway } = await core;
  for (const path of ['/api/user/marks', '/api/admin/skins', '/api/skins-extra']) {
    let called = 0;
    const result = await gateway(req(path), {}, { fetch: async () => { called++; return new Response('private'); } });
    assert.equal(await result.text(), 'private');
    assert.equal(called, 1);
  }
});

test('authenticated public requests are isolated and non-GET requests are rejected', async () => {
  const { gateway } = await core;
  const auth = await gateway(req('/api/skins', { headers: { Authorization: 'Bearer test' } }), {}, {
    fetch: async () => new Response('private'),
  });
  assert.equal(auth.headers.get('Cache-Control'), 'private, no-store');
  assert.equal((await gateway(req('/api/skins', { method: 'POST' }), {})).status, 405);
  assert.equal((await gateway(req('/api/skins', { method: 'OPTIONS' }), {})).status, 204);
});

test('public JSON uses the current Vercel schema unchanged, not old Supabase selects', async () => {
  const { fillPublicCache } = await core;
  const c = context();
  const rows = [{ name: '皮肤', track_returns: true, series: [{ name: '系列' }] }];
  let source;
  const result = await fillPublicCache(req('/api/skins?limit=500&offset=500'), c.ctx, {
    cache: c.cache,
    fetch: async (url, options) => {
      source = url;
      assert.equal(options.headers.has('Authorization'), false);
      return Response.json(rows, { headers: { 'X-Total': '1' } });
    },
  });
  assert.equal(source, 'https://www.skinsdata.top/api/skins?limit=500&offset=500');
  assert.deepEqual(await result.json(), rows);
  assert.equal(result.headers.get('Cache-Control'), 'public, max-age=60');
  assert.match(result.headers.get('Cloudflare-CDN-Cache-Control'), /max-age=1800/);
  assert.match(result.headers.get('Cloudflare-CDN-Cache-Control'), /stale-if-error=86400/);
  assert.doesNotMatch(result.headers.get('Cloudflare-CDN-Cache-Control'), /s-maxage|must-revalidate|proxy-revalidate/);
  assert.equal(result.headers.get('X-Total'), '1');
});

test('all resource categories survive the proxy', async () => {
  const { fillPublicCache } = await core;
  const c = context();
  const rows = ['resource', 'star_legend', 'star_outfit', 'yuanliu_suit'].map(source_category => ({ source_category }));
  const result = await fillPublicCache(req('/api/resources'), c.ctx, { cache: c.cache, fetch: async () => Response.json(rows) });
  assert.deepEqual(await result.json(), rows);
});

test('quota failure activates a short circuit, never a successful empty cache', async () => {
  const { fillPublicCache } = await core;
  const c = context();
  let calls = 0;
  const deps = { cache: c.cache, fetch: async () => {
    calls++;
    return Response.json({ error: 'restricted: exceed_egress_quota' }, { status: 500 });
  } };
  const first = await fillPublicCache(req('/api/skins'), c.ctx, deps);
  await c.done();
  const second = await fillPublicCache(req('/api/heroes'), c.ctx, deps);
  assert.equal(calls, 1);
  for (const response of [first, second]) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal((await response.json()).code, 'EGRESS_QUOTA_EXCEEDED');
  }
});

test('invalid, oversized, personalized and failed responses are never cached as public success', async () => {
  const { fillPublicCache } = await core;
  for (const origin of [new Response('<html>'), Response.json({ error: 'bad' }),
    new Response('[]', { headers: { 'Content-Length': String(9 * 1024 * 1024) } }),
    new Response('[]', { headers: { 'Set-Cookie': 'session=test' } }),
    new Response('bad', { status: 502 })]) {
    const c = context();
    const result = await fillPublicCache(req('/api/skins'), c.ctx, { cache: c.cache, fetch: async () => origin });
    assert.equal(result.status, 502);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
  }
});

test('network timeouts are bounded failures', async () => {
  const { fillPublicCache } = await core;
  const c = context();
  const result = await fillPublicCache(req('/api/heroes'), c.ctx, { cache: c.cache, fetch: async () => { throw new Error('timeout'); } });
  assert.equal(result.status, 503);
});

test('chunked quota messages still activate the circuit and entrypoint failures remain readable', async () => {
  const { fillPublicCache, gateway } = await core;
  const c = context();
  const response = await fillPublicCache(req('/api/skins'), c.ctx, { cache: c.cache, fetch: async () =>
    new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"error":"exceed_egress_'));
      controller.enqueue(new TextEncoder().encode('quota"}'));
      controller.close();
    } }), { status: 500, headers: { 'Content-Type': 'application/json' } }) });
  assert.equal((await response.json()).code, 'EGRESS_QUOTA_EXCEEDED');
  await c.done();
  const result = await gateway(req('/api/skins'), { exports: { PublicCache: { fetch: async () => { throw new Error('network'); } } } });
  assert.equal(result.status, 503);
  assert.equal((await result.json()).code, 'UPSTREAM_UNAVAILABLE');
});

test('image fills stream validated image bytes with long-lived cache headers', async () => {
  const { fillPublicCache } = await core;
  const c = context();
  let source;
  const result = await fillPublicCache(req('/img/skin/test.png?width=120&height=120&quality=70&resize=contain&format=origin'), c.ctx, {
    cache: c.cache, fetch: async (url, options) => {
      source = url;
      assert.equal(options.headers.get('Accept'), 'image/*');
      return new Response('image bytes', { headers: { 'Content-Type': 'image/png' } });
    },
  });
  assert.match(source, /\/render\/image\/public\/skin-images\/skin\/test.png/);
  assert.match(source, /format=origin/);
  assert.equal(await result.text(), 'image bytes');
  assert.match(result.headers.get('Cache-Control'), /2592000/);
});

test('old image cache still works during quota outage; HEAD has no response body', async () => {
  const { gateway } = await core;
  const c = context();
  const path = '/img/skin/test.png?width=120&height=120&quality=70&resize=contain';
  await c.cache.put(new Request('https://skinsdata.top' + path), new Response('old bytes', { headers: { 'Content-Type': 'image/webp' } }));
  c.ctx.exports = { PublicCache: { fetch: async () => new Response('unavailable', { status: 503 }) } };
  const result = await gateway(req(path, { headers: { Accept: 'image/webp' } }), c.ctx, { cache: c.cache });
  assert.equal(await result.text(), 'old bytes');
  assert.equal(result.headers.get('X-Cache'), 'LEGACY-HIT');
  const head = await gateway(req(path, { method: 'HEAD', headers: { Accept: 'image/webp' } }), c.ctx, { cache: c.cache });
  assert.equal(await head.text(), '');
  assert.equal(head.status, 200);
});

test('public image fills accept upstream bot cookies without forwarding or caching cookies', async () => {
  const { fillPublicCache } = await core;
  for (const path of ['/img/hero/hero_15.jpg', '/img/skin/test.png?width=80&height=80&quality=70&resize=contain&format=webp']) {
    const c = context();
    const result = await fillPublicCache(req(path, { headers: { Cookie: 'visitor=test' } }), c.ctx, {
      cache: c.cache, fetch: async (_url, options) => {
        assert.equal(options.headers.has('Cookie'), false);
        assert.equal(options.headers.has('Authorization'), false);
        return new Response('public image bytes', { headers: {
          'Content-Type': 'image/jpeg',
          'Set-Cookie': '__cf_bm=test; Path=/; HttpOnly; Secure; Expires=Sun, 18 Oct 2026 06:00:00 GMT',
        } });
      },
    });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), 'public image bytes');
    assert.equal(result.headers.has('Set-Cookie'), false);
    assert.match(result.headers.get('Cache-Control'), /public, max-age=2592000/);
  }
});

test('bot cookie exception does not allow API cookies, image session cookies or non-image responses', async () => {
  const { fillPublicCache } = await core;
  const cases = [
    { path: '/api/skins', type: 'application/json', body: '[]', cookies: ['__cf_bm=test'] },
    { path: '/img/hero/hero_15.jpg', type: 'image/jpeg', body: 'private', cookies: ['session=test'] },
    { path: '/img/hero/hero_15.jpg', type: 'image/jpeg', body: 'private', cookies: ['__cf_bm=test', 'session=test'] },
    { path: '/img/hero/hero_15.jpg', type: 'text/html', body: '<html>challenge</html>', cookies: ['__cf_bm=test'] },
    { path: '/img/hero/hero_15.jpg', type: 'image/jpeg', body: 'partial', cookies: ['__cf_bm=test'], status: 206 },
  ];
  for (const sample of cases) {
    const c = context();
    const headers = new Headers({ 'Content-Type': sample.type });
    for (const cookie of sample.cookies) headers.append('Set-Cookie', cookie);
    const result = await fillPublicCache(req(sample.path), c.ctx, {
      cache: c.cache, fetch: async () => new Response(sample.body, { headers, status: sample.status || 200 }),
    });
    assert.equal(result.status, 502);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.equal(result.headers.has('Set-Cookie'), false);
  }
});
