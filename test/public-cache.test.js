const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPublicCache } = require('../self-hosted/public-cache.cjs');

function request(options = {}) { return { method: 'GET', headers: {}, query: {}, ...options }; }
function response() { return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(body) { this.body = body; } }; }
async function call(cache, handler, req = request(), route = '/api/skins') {
  const res = response();
  res.handled = await cache.respond(req, res, route, handler);
  return res;
}

test('100 concurrent public requests share one query; refresh is throttled and TTL expires', async () => {
  let clock = 100000, queries = 0;
  const cache = createPublicCache({ now: () => clock });
  const handler = async (req, res) => { queries++; await new Promise(r => setImmediate(r)); res.json([{ name: '一塔千年' }]); };
  const batch = await Promise.all(Array.from({ length: 100 }, () => call(cache, handler)));
  assert.equal(queries, 1);
  assert.ok(batch.every(res => res.body.toString().includes('一塔千年')));
  await call(cache, handler, request({ query: { refresh: '1' } }));
  assert.equal(queries, 1);
  clock += 5001;
  const refreshed = await call(cache, handler, request({ query: { refresh: '2' } }));
  assert.equal(queries, 2);
  assert.equal(refreshed.headers['cache-control'], 'no-store');
  clock += 60001;
  await call(cache, handler);
  assert.equal(queries, 3);
  assert.equal(cache.stats().entries, 1);
});

test('ETag revalidation and HEAD do not transfer JSON again; CORS survives', async () => {
  const cache = createPublicCache();
  const handler = async (req, res) => { assert.equal(req.method, 'GET'); res.setHeader('Access-Control-Allow-Origin', '*'); res.json([1]); };
  const first = await call(cache, handler);
  const second = await call(cache, handler, request({ headers: { 'if-none-match': first.headers.etag } }));
  assert.equal(second.statusCode, 304);
  assert.equal(second.body, undefined);
  assert.equal(second.headers['access-control-allow-origin'], '*');
  const head = await call(cache, handler, request({ method: 'HEAD' }));
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, undefined);
});

test('private requests, pagination, unknown query keys and endpoints bypass shared cache', async () => {
  const cache = createPublicCache();
  const forbidden = () => { throw Error('must bypass'); };
  for (const req of [request({ headers: { authorization: 'Bearer test' } }), request({ headers: { cookie: 'session=test' } }),
    request({ query: { limit: '10' } }), request({ query: { hero: 'test' } }), request({ method: 'POST' })]) {
    assert.equal((await call(cache, forbidden, req)).handled, false);
  }
  assert.equal((await call(cache, forbidden, request(), '/api/user')).handled, false);
});

test('failed or oversized responses are not cached and total memory stays bounded', async () => {
  const cache = createPublicCache({ maxBytes: 24 });
  let failures = 0;
  const failed = async (req, res) => { failures++; res.status(503).json({ error: 'offline' }); };
  await call(cache, failed); await call(cache, failed);
  assert.equal(failures, 2);
  assert.equal(cache.stats().entries, 0);
  for (const route of ['/api/skins', '/api/heroes', '/api/resources']) {
    await call(cache, async (req, res) => res.json(['1234567890']), request(), route);
    assert.ok(cache.stats().bytes <= 24);
  }
  await call(cache, async (req, res) => res.json(['x'.repeat(100)]));
  assert.ok(cache.stats().bytes <= 24);
});

test('an in-flight pre-edit query cannot repopulate the cache after invalidation', async () => {
  const cache = createPublicCache();
  let release;
  const old = call(cache, async (req, res) => { await new Promise(r => { release = r; }); res.json(['old']); });
  await new Promise(r => setImmediate(r));
  cache.invalidate();
  const handler = async (req, res) => res.json(['new']);
  await call(cache, handler);
  release(); await old;
  assert.equal((await call(cache, handler)).body.toString(), '["new"]');
});
