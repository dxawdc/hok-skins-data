const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createAvatarStorage } = require('../self-hosted/avatar-store.cjs');
const key = 'avatars/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.png';
const other = key.replace('22222222-2222-', '33333333-3333-');
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1EAAAAASUVORK5CYII=', 'base64');

test('private avatar URLs enforce signature, expiry, purpose and HTTP methods', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hok-avatar-'));
  let time = 1792300000;
  const storage = createAvatarStorage({ root, secret: 'test-only'.repeat(8), now: () => time });
  const bucket = storage.from('miniprogram-avatars');
  const server = http.createServer((req, res) => storage.serve(req, res, new URL(req.url, 'https://youtiao.fun')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const fetchUrl = (url, options) => fetch(url.replace('https://youtiao.fun', origin), options);
  try {
    assert.equal((await bucket.upload(key, bytes, { contentType: 'image/png', upsert: false })).error, null);
    const url = (await bucket.createSignedUrl(key, 3600)).data.signedUrl;
    const result = await fetchUrl(url);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.equal(result.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes);
    assert.equal((await fetchUrl(url, { method: 'HEAD' })).status, 200);
    assert.equal((await fetchUrl(url, { method: 'POST' })).status, 405);
    assert.equal((await fetchUrl(url.split('?')[0])).status, 404);
    assert.equal((await fetchUrl(url.replace(key, other))).status, 404);
    assert.equal((await fetchUrl(url.replace('expires=1792303600', 'expires=1792303601'))).status, 404);
    time += 3600;
    assert.equal((await fetchUrl(url)).status, 404);
    assert.equal((await bucket.remove([key])).error, null);
    assert.ok((await bucket.createSignedUrl(key, 60)).error);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('private avatar storage rejects traversal, wrong bucket, overwrite and invalid image bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hok-avatar-'));
  try {
    const storage = createAvatarStorage({ root, secret: 'test-only'.repeat(8) });
    const bucket = storage.from('miniprogram-avatars');
    for (const bad of ['../secret', key + '/../secret', key.replace('.png', '.svg'), '/' + key]) {
      assert.ok((await bucket.upload(bad, bytes, { upsert: false, contentType: 'image/png' })).error);
      assert.ok((await bucket.remove([bad])).error);
      assert.ok((await bucket.createSignedUrl(bad, 3600)).error);
    }
    assert.ok((await storage.from('skin-images').upload(key, bytes, { upsert: false, contentType: 'image/png' })).error);
    assert.ok((await bucket.upload(key, Buffer.from('<html/>'), { upsert: false, contentType: 'image/png' })).error);
    assert.ok((await bucket.upload(key, bytes, { upsert: false, contentType: 'image/jpeg' })).error);
    assert.equal((await bucket.upload(key, bytes, { upsert: false, contentType: 'image/png' })).error, null);
    assert.ok((await bucket.upload(key, bytes, { upsert: false, contentType: 'image/png' })).error);
    assert.ok((await bucket.createSignedUrl(key, 3601)).error);
    assert.deepEqual(await fs.readFile(path.join(root, key)), bytes);
    assert.equal((await fs.readdir(root)).includes('public'), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
