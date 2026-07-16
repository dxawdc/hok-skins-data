'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyMarkBatch,
  bearerToken,
  hashSessionToken,
  inspectAvatar,
  normalizeLoginBody,
  normalizeMarkBatch,
  normalizeNickname,
  parseKnownRevision,
  parseMultipartAvatar,
  publicProfile,
  readMarks,
  requestWechatSession,
  routePath,
  validateWechatSession,
} = require('../api/user')._private;

function expectApiError(fn, code) {
  assert.throws(fn, error => error && error.code === code);
}

test('public route paths are normalized without accepting legacy endpoints', () => {
  assert.equal(routePath('/api/user/session?x=1'), '/session');
  assert.equal(routePath('/api/user/profile/avatar/'), '/profile/avatar');
  assert.equal(routePath('/marks?revision=4'), '/marks');
  assert.equal(routePath('/api/user/login'), '/login');
});

test('login codes are strict and WeChat identity output excludes session secrets', () => {
  assert.deepEqual(normalizeLoginBody({ code: 'abc_123' }), { code: 'abc_123' });
  expectApiError(() => normalizeLoginBody({ code: ' abc ' }), 'INVALID_WECHAT_CODE');
  expectApiError(() => normalizeLoginBody({ code: 'abc', profile: {} }), 'INVALID_REQUEST');

  const identity = validateWechatSession({
    openid: 'server-only-openid',
    unionid: 'server-only-unionid',
    session_key: 'must-not-escape',
  });
  assert.deepEqual(identity, { openid: 'server-only-openid', unionid: 'server-only-unionid' });
  assert.equal(Object.prototype.hasOwnProperty.call(identity, 'session_key'), false);
  expectApiError(() => validateWechatSession({ errcode: 40029 }), 'WECHAT_CODE_INVALID');
});

test('WeChat session transport returns structured upstream failures', async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => ({ ok: true, text: async () => '{"errcode":40029}' });
  try {
    assert.deepEqual(await requestWechatSession('test-code'), { errcode: 40029 });
  } finally {
    global.fetch = previousFetch;
  }
});

test('opaque session tokens are strictly parsed and only hash to storage form', () => {
  const token = 'A'.repeat(43);
  assert.equal(bearerToken({ authorization: `Bearer ${token}` }), token);
  assert.equal(bearerToken({ authorization: `bearer ${token}` }), null);
  assert.equal(bearerToken({ authorization: 'Bearer too-short' }), null);
  const hash = hashSessionToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, token);
});

test('nickname normalization permits reset but rejects controls and excess length', () => {
  assert.equal(normalizeNickname('  王者玩家  '), '王者玩家');
  assert.equal(normalizeNickname('   '), '');
  expectApiError(() => normalizeNickname('bad\nname'), 'INVALID_NICKNAME');
  expectApiError(() => normalizeNickname('名'.repeat(81)), 'INVALID_NICKNAME');
});

test('profile fallback is explicitly distinguished from a user-entered nickname', async () => {
  const client = { storage: { from: () => { throw new Error('no avatar signing expected'); } } };
  const fallback = await publicProfile(client, {
    nickname: '', avatar_path: '', updated_at: '2026-07-16T00:00:00.000Z',
  });
  assert.equal(fallback.nickname, '收藏用户');
  assert.equal(fallback.hasNickname, false);
  assert.equal(fallback.isComplete, false);

  const custom = await publicProfile(client, {
    nickname: '召唤师', avatar_path: '', updated_at: '2026-07-16T00:00:00.000Z',
  });
  assert.equal(custom.nickname, '召唤师');
  assert.equal(custom.hasNickname, true);

  const quickProfile = await publicProfile(client, {
    nickname: '召唤师', avatar_path: 'avatars/example.jpg', updated_at: '2026-07-16T00:00:00.000Z',
  }, { includeAvatarUrl: false });
  assert.equal(quickProfile.hasAvatar, true);
  assert.equal(quickProfile.avatarUrl, '');
  assert.equal(quickProfile.avatarExpiresAt, null);
});

test('mark batches require a base revision, unique keys, and explicit types', () => {
  assert.deepEqual(normalizeMarkBatch({
    mutationId: 'mutation-0001',
    baseRevision: 12,
    changes: [
      { key: 'skin:1', type: 'owned' },
      { key: 'skin:2', type: null },
    ],
  }), {
    mutationId: 'mutation-0001',
    baseRevision: 12,
    changes: [
      { key: 'skin:1', type: 'owned' },
      { key: 'skin:2', type: null },
    ],
  });

  expectApiError(() => normalizeMarkBatch({
    mutationId: 'mutation-0001', baseRevision: 0, changes: [],
  }), 'INVALID_MARK_CHANGE');
  expectApiError(() => normalizeMarkBatch({
    mutationId: 'mutation-0001',
    baseRevision: 0,
    changes: [{ key: 'skin:1', type: 'owned' }, { key: 'skin:1', type: 'follow' }],
  }), 'INVALID_MARK_CHANGE');
  expectApiError(() => normalizeMarkBatch({
    mutationId: 'mutation-0001', baseRevision: -1, changes: [{ key: 'skin:1', type: 'owned' }],
  }), 'INVALID_REQUEST');
  expectApiError(() => normalizeMarkBatch({
    mutationId: 'mutation-0001', baseRevision: 0, changes: [{ key: ' skin:1 ', type: 'owned' }],
  }), 'INVALID_MARK_CHANGE');
});

test('known mark revisions reject malformed and unsafe integer values', () => {
  assert.equal(parseKnownRevision('/api/user/marks'), null);
  assert.equal(parseKnownRevision('/api/user/marks?revision=0'), 0);
  assert.equal(parseKnownRevision('/api/user/marks?revision=42'), 42);
  expectApiError(() => parseKnownRevision('/api/user/marks?revision=-1'), 'INVALID_REQUEST');
  expectApiError(() => parseKnownRevision('/api/user/marks?revision=1.5'), 'INVALID_REQUEST');
  expectApiError(() => parseKnownRevision('/api/user/marks?revision=9007199254740992'), 'INVALID_REQUEST');
});

test('mark RPC adapters preserve the v2 revision and conflict contract', async () => {
  const calls = [];
  const client = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'read_miniprogram_marks') {
        return {
          data: [{
            revision: 7,
            not_modified: false,
            mark_count: 1,
            marks: [{ key: 'skin:1', type: 'follow' }],
          }],
          error: null,
        };
      }
      return {
        data: [{ revision: 8, mark_count: 1, duplicate: false, conflict: false }],
        error: null,
      };
    },
  };

  assert.deepEqual(await readMarks(client, 'user-id', 6), {
    revision: 7,
    notModified: false,
    markCount: 1,
    marks: [{ key: 'skin:1', type: 'follow' }],
  });
  assert.deepEqual(await applyMarkBatch(client, 'user-id', {
    headers: { 'content-type': 'application/json' },
    body: {
      mutationId: 'mutation-0002',
      baseRevision: 7,
      changes: [{ key: 'skin:1', type: 'owned' }],
    },
  }), {
    revision: 8,
    markCount: 1,
    duplicate: false,
    conflict: false,
  });
  assert.deepEqual(calls, [
    {
      name: 'read_miniprogram_marks',
      args: { p_user_id: 'user-id', p_known_revision: 6 },
    },
    {
      name: 'apply_miniprogram_mark_changes',
      args: {
        p_user_id: 'user-id',
        p_changes: [{ key: 'skin:1', type: 'owned' }],
        p_mutation_id: 'mutation-0002',
        p_base_revision: 7,
      },
    },
  ]);
});

test('avatar inspection checks size, magic bytes, and declared MIME together', () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  Buffer.from('IHDR', 'ascii').copy(png, 12);
  assert.equal(inspectAvatar(png, 'image/png').extension, 'png');
  assert.equal(inspectAvatar(png, 'application/octet-stream').contentType, 'image/png');
  expectApiError(() => inspectAvatar(png, 'image/jpeg'), 'AVATAR_MIME_MISMATCH');
  expectApiError(() => inspectAvatar(Buffer.from('<svg/>'), 'image/png'), 'UNSUPPORTED_AVATAR_TYPE');
  expectApiError(
    () => inspectAvatar(Buffer.alloc(2 * 1024 * 1024 + 1), 'image/jpeg'),
    'AVATAR_TOO_LARGE',
  );
});

test('wx.uploadFile-style multipart bodies accept exactly one avatar part', async () => {
  const boundary = '----codex-avatar-boundary';
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n`
      + 'Content-Disposition: form-data; name="avatar"; filename="avatar.jpg"\r\n'
      + 'Content-Type: image/jpeg\r\n\r\n',
      'utf8',
    ),
    jpeg,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  const parsed = await parseMultipartAvatar({
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
    body,
  });
  assert.equal(parsed.contentType, 'image/jpeg');
  assert.deepEqual(parsed.buffer, jpeg);
});
