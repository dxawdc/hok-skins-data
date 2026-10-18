'use strict';
// Run as a short-lived local systemd unit with the service EnvironmentFile.
// Uses a dedicated disposable account, never an existing user's login token.
const crypto = require('node:crypto');
const http = require('node:http');
const assert = require('node:assert/strict');
const jwt = require('/opt/hokskins/app/node_modules/jsonwebtoken');
process.env.SUPABASE_URL = 'http://127.0.0.1:18082';
process.env.SUPABASE_SERVICE_KEY = jwt.sign({ role: 'hokskins' }, process.env.PGRST_JWT_SECRET, { expiresIn: '10m' });
const { createClient } = require('/opt/hokskins/app/lib/data-client');
const handler = require('/opt/hokskins/app/api/user');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const userId = crypto.randomUUID();
const token = crypto.randomBytes(32).toString('base64url');
const server = http.createServer(async (req, res) => {
  res.status = code => { res.statusCode = code; return res; };
  res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return res; };
  await handler(req, res);
});
let avatarPath;
async function check(result, label) { if (result.error) throw new Error(label + ' failed (' + result.error.code + ')'); return result.data; }

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const allowed = ['https://youtiao.fun/hokskins', 'https://www.skinsdata.top', 'https://skinsdata.top'];
  if (process.env.MIGRATION_TEST_ORIGIN && !allowed.includes(process.env.MIGRATION_TEST_ORIGIN)) throw new Error('Unexpected verification origin');
  const base = (process.env.MIGRATION_TEST_ORIGIN || 'http://127.0.0.1:' + server.address().port) + '/api/user';
  async function call(route, options = {}) {
    const response = await fetch(base + route, { ...options, headers: { Authorization: 'Bearer ' + token, ...options.headers } });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
  }
  const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await check(await db.from('miniprogram_users').insert({ id: userId, openid: 'migration-check-' + userId }), 'test user');
    await check(await db.from('miniprogram_sessions').insert({ user_id: userId, token_hash: crypto.createHash('sha256').update(token).digest('hex'), expires_at: new Date(Date.now() + 600000).toISOString() }), 'test session');
    assert.equal((await call('/profile')).status, 200);
    assert.equal((await call('/profile', { headers: { Authorization: '' } })).status, 401);
    const profile = await call('/profile', { ...json({ nickname: '迁移验收' }), method: 'PATCH' });
    assert.equal(profile.status, 200); assert.equal(profile.body.profile.nickname, '迁移验收');
    const batch = { mutationId: 'migration-' + crypto.randomUUID(), baseRevision: 0, changes: [{ key: '迁移验收#测试皮肤', type: 'owned' }] };
    const written = await call('/marks/batch', json(batch));
    assert.equal(written.status, 200); assert.equal(written.body.revision, 1); assert.equal(written.body.markCount, 1);
    assert.equal((await call('/marks/batch', json(batch))).body.duplicate, true);
    const conflict = await call('/marks/batch', json({ ...batch, mutationId: 'migration-' + crypto.randomUUID() }));
    assert.equal(conflict.body.conflict, true);
    const marks = await call('/marks');
    assert.equal(marks.body.marks.length, 1); assert.equal(marks.body.revision, 1);
    assert.equal((await call('/marks?revision=1')).body.notModified, true);
    // Exercise the actual multipart parser and the private serving endpoint.
    const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1EAAAAASUVORK5CYII=', 'base64');
    const form = new FormData(); form.append('avatar', new Blob([tiny], { type: 'image/png' }), 'avatar.png');
    const avatar = await call('/profile/avatar', { method: 'POST', body: form });
    assert.equal(avatar.status, 200); assert.match(avatar.body.profile.avatarUrl, /^https:\/\/youtiao.fun\/hokskins\/avatar\//);
    const url = new URL(avatar.body.profile.avatarUrl);
    avatarPath = url.pathname.slice('/hokskins/avatar/'.length);
    const image = await fetch('http://127.0.0.1:18081' + url.pathname + url.search);
    assert.equal(image.status, 200); assert.deepEqual(Buffer.from(await image.arrayBuffer()), tiny);
    assert.equal((await fetch('http://127.0.0.1:18081' + url.pathname)).status, 404);
    assert.equal((await call('/session', { method: 'DELETE' })).status, 204);
    assert.equal((await call('/profile')).status, 401);
    console.log(JSON.stringify({ status: 'passed', checks: ['opaque-session', 'unauthorized', 'profile-update', 'mark-write-read', 'idempotent-retry', 'revision-conflict', 'not-modified', 'private-avatar-upload-read', 'unsigned-avatar-rejected', 'logout-revoked'] }));
  } finally {
    if (avatarPath) await check(await db.storage.from('miniprogram-avatars').remove([avatarPath]), 'test avatar cleanup');
    await check(await db.from('miniprogram_users').delete().eq('id', userId), 'test account cleanup');
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(JSON.stringify({ status: 'failed', name: error.name, message: String(error.message).slice(0, 200) })); process.exitCode = 1; });
