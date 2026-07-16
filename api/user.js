// api/user.js — WeChat Mini Program user login and cloud mark sync.

const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const WECHAT_APP_ID = process.env.WECHAT_MINIPROGRAM_APP_ID || 'wx9b58b642b80ab6aa';
const WECHAT_APP_SECRET = process.env.WECHAT_MINIPROGRAM_APP_SECRET || '';
const USER_JWT_SECRET = process.env.MINIPROGRAM_JWT_SECRET || '';

const TOKEN_ISSUER = 'skinsdata-miniprogram';
const TOKEN_AUDIENCE = 'skinsdata-miniprogram-user';
const TOKEN_TTL = '30d';
const MAX_MARKS = 2000;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 3 * 1024 * 1024;
const USER_AVATAR_BUCKET = 'user-avatars';
const AVATAR_URL_TTL_SECONDS = 60 * 60;

function ok(data, status = 200) {
  return { statusCode: status, body: JSON.stringify(data) };
}

function fail(error, status = 400) {
  return { statusCode: status, body: JSON.stringify({ error }) };
}

function readBody(req) {
  return new Promise(resolve => {
    if (req.body !== undefined) {
      if (typeof req.body === 'string') {
        if (Buffer.byteLength(req.body, 'utf8') > MAX_REQUEST_BODY_BYTES) return resolve({ value: {}, tooLarge: true });
        try { return resolve({ value: JSON.parse(req.body), tooLarge: false }); } catch { return resolve({ value: {}, tooLarge: false }); }
      }
      try {
        if (Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8') > MAX_REQUEST_BODY_BYTES) return resolve({ value: {}, tooLarge: true });
      } catch {
        return resolve({ value: {}, tooLarge: true });
      }
      return resolve({ value: req.body || {}, tooLarge: false });
    }
    let raw = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_REQUEST_BODY_BYTES) tooLarge = true;
      else raw += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return resolve({ value: {}, tooLarge: true });
      try { resolve({ value: raw ? JSON.parse(raw) : {}, tooLarge: false }); }
      catch { resolve({ value: {}, tooLarge: false }); }
    });
    req.on('error', () => resolve({ value: {}, tooLarge: false }));
  });
}

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('用户服务暂未配置数据库连接');
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

function getConfigError() {
  if (!WECHAT_APP_SECRET) return '用户服务暂未配置微信登录';
  if (!USER_JWT_SECRET) return '用户服务暂未配置登录凭证';
  if (!SUPABASE_URL || !SUPABASE_KEY) return '用户服务暂未配置数据库连接';
  return '';
}

function requestWechatSession(code) {
  const query = new URLSearchParams({
    appid: WECHAT_APP_ID,
    secret: WECHAT_APP_SECRET,
    js_code: code,
    grant_type: 'authorization_code',
  });
  const url = `https://api.weixin.qq.com/sns/jscode2session?${query.toString()}`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); }
        catch { reject(new Error('微信登录服务返回格式异常')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('微信登录服务响应超时')));
    req.on('error', reject);
  });
}

function trimText(value, max) {
  return String(value || '').trim().slice(0, max);
}

function normalizeProfile(profile) {
  const nickname = trimText(profile && profile.nickName, 80);
  return {
    nickname,
    avatarData: trimText(profile && profile.avatarData, Math.ceil(MAX_AVATAR_BYTES * 4 / 3) + 16),
  };
}

function parseAvatarData(value) {
  if (!value) return null;
  const encoded = String(value).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('头像数据格式无效');
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > MAX_AVATAR_BYTES) throw new Error('头像图片不能超过 2MB');
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return { buffer, contentType: 'image/png', extension: 'png' };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { buffer, contentType: 'image/jpeg', extension: 'jpg' };
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return { buffer, contentType: 'image/webp', extension: 'webp' };
  throw new Error('头像仅支持 PNG、JPG 或 WEBP 格式');
}

async function uploadAvatar(client, avatar) {
  const objectPath = `avatars/${crypto.randomUUID()}.${avatar.extension}`;
  const { error } = await client.storage.from(USER_AVATAR_BUCKET).upload(objectPath, avatar.buffer, {
    contentType: avatar.contentType,
    cacheControl: '3600',
    upsert: false,
  });
  if (error) throw error;
  return objectPath;
}

async function removeAvatar(client, objectPath) {
  if (!objectPath) return;
  const { error } = await client.storage.from(USER_AVATAR_BUCKET).remove([objectPath]);
  if (error) throw error;
}

async function publicProfile(client, row) {
  let avatarUrl = '';
  if (row && row.avatar_path) {
    const { data, error } = await client.storage
      .from(USER_AVATAR_BUCKET)
      .createSignedUrl(row.avatar_path, AVATAR_URL_TTL_SECONDS);
    if (error) throw error;
    avatarUrl = data && data.signedUrl ? data.signedUrl : '';
  }
  return {
    nickname: row && row.nickname ? row.nickname : '',
    avatarUrl,
  };
}

function issueToken(openid) {
  return jwt.sign(
    { sub: openid, scope: 'miniprogram' },
    USER_JWT_SECRET,
    { expiresIn: TOKEN_TTL, issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE }
  );
}

function verifyToken(headers) {
  const auth = (headers && headers.authorization) || '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(auth.slice(7), USER_JWT_SECRET, {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    });
    return payload && payload.scope === 'miniprogram' && typeof payload.sub === 'string' ? payload : null;
  } catch {
    return null;
  }
}

function requireUser(headers) {
  const user = verifyToken(headers);
  return user ? [user, null] : [null, fail('登录已失效，请重新登录', 401)];
}

async function getUser(client, openid) {
  const { data, error } = await client
    .from('miniprogram_users')
    .select('openid,nickname,avatar_path')
    .eq('openid', openid)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getMarks(client, openid) {
  const { data, error } = await client
    .from('miniprogram_skin_marks')
    .select('skin_key,mark_type')
    .eq('openid', openid)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(row => ({ key: row.skin_key, type: row.mark_type }));
}

function normalizeMarks(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('标记数据格式无效');
  const result = new Map();
  Object.keys(input).forEach(rawKey => {
    const key = trimText(rawKey, 300);
    const value = input[rawKey] || {};
    if (!key) return;
    if (value.owned === true) result.set(key, 'owned');
    else if (value.follow === true) result.set(key, 'follow');
  });
  if (result.size > MAX_MARKS) throw new Error(`最多可同步 ${MAX_MARKS} 条标记`);
  return result;
}

function normalizeMarkChanges(input) {
  if (!Array.isArray(input)) throw new Error('标记变更数据格式无效');
  const result = new Map();
  input.forEach(change => {
    const key = trimText(change && change.key, 300);
    const type = change && change.type;
    if (!key) return;
    if (type !== 'owned' && type !== 'follow' && type !== null) {
      throw new Error('标记类型无效');
    }
    result.set(key, type);
  });
  if (result.size > MAX_MARKS) throw new Error(`单次最多可同步 ${MAX_MARKS} 条标记`);
  return result;
}

async function applyMarkChanges(client, openid, input) {
  const changes = normalizeMarkChanges(input);
  if (!changes.size) return getMarks(client, openid);

  const existing = await getMarks(client, openid);
  const next = new Map(existing.map(row => [row.key, row.type]));
  changes.forEach((type, key) => {
    if (type === null) next.delete(key);
    else next.set(key, type);
  });
  if (next.size > MAX_MARKS) throw new Error(`最多可同步 ${MAX_MARKS} 条标记`);

  const deleted = [];
  const upserts = [];
  changes.forEach((type, key) => {
    if (type === null) deleted.push(key);
    else upserts.push({ openid, skin_key: key, mark_type: type });
  });
  if (deleted.length) {
    const { error } = await client
      .from('miniprogram_skin_marks')
      .delete()
      .eq('openid', openid)
      .in('skin_key', deleted);
    if (error) throw error;
  }
  if (upserts.length) {
    const { error } = await client
      .from('miniprogram_skin_marks')
      .upsert(upserts, { onConflict: 'openid,skin_key' });
    if (error) throw error;
  }
  return getMarks(client, openid);
}

async function replaceMarks(client, openid, marks) {
  const desired = normalizeMarks(marks);
  const { data: existing, error: readError } = await client
    .from('miniprogram_skin_marks')
    .select('skin_key')
    .eq('openid', openid);
  if (readError) throw readError;

  const stale = (existing || []).map(row => row.skin_key).filter(key => !desired.has(key));
  if (stale.length) {
    const { error } = await client
      .from('miniprogram_skin_marks')
      .delete()
      .eq('openid', openid)
      .in('skin_key', stale);
    if (error) throw error;
  }

  const rows = [...desired].map(([skin_key, mark_type]) => ({ openid, skin_key, mark_type }));
  if (rows.length) {
    const { error } = await client
      .from('miniprogram_skin_marks')
      .upsert(rows, { onConflict: 'openid,skin_key' });
    if (error) throw error;
  }
  return getMarks(client, openid);
}

async function login(body) {
  const configError = getConfigError();
  if (configError) return fail(configError, 503);

  const code = trimText(body && body.code, 200);
  if (!code) return fail('缺少微信登录凭证');

  let session;
  try {
    session = await requestWechatSession(code);
  } catch (error) {
    return fail(error && error.message ? error.message : '微信登录服务请求失败', 502);
  }
  if (!session || !session.openid) return fail('微信登录验证失败', 401);

  let profile;
  let avatar;
  try {
    profile = normalizeProfile(body && body.profile);
    avatar = parseAvatarData(profile.avatarData);
  } catch (error) {
    return fail(error && error.message ? error.message : '头像数据无效');
  }
  try {
    const client = getClient();
    const previous = await getUser(client, session.openid);
    const avatarPath = avatar ? await uploadAvatar(client, avatar) : (previous && previous.avatar_path) || '';
    const row = {
      openid: session.openid,
      nickname: profile.nickname || (previous && previous.nickname) || '',
      avatar_path: avatarPath,
    };
    const { data, error } = await client
      .from('miniprogram_users')
      .upsert(row, { onConflict: 'openid' })
      .select('nickname,avatar_path')
      .maybeSingle();
    if (error) throw error;
    if (avatar && previous && previous.avatar_path && previous.avatar_path !== avatarPath) {
      removeAvatar(client, previous.avatar_path).catch(error => {
        console.warn('[user login] previous avatar cleanup failed', error && error.message ? error.message : error);
      });
    }
    const marks = await getMarks(client, session.openid);
    return ok({ token: issueToken(session.openid), profile: await publicProfile(client, data || row), marks });
  } catch (error) {
    console.error('[user login] database operation failed', error && error.message ? error.message : error);
    return fail('登录服务暂不可用', 503);
  }
}

async function getCurrentUser(user) {
  try {
    const client = getClient();
    const profile = await getUser(client, user.sub);
    if (!profile) return fail('用户不存在，请重新登录', 401);
    const marks = await getMarks(client, user.sub);
    return ok({ profile: await publicProfile(client, profile), marks });
  } catch (error) {
    console.error('[user me] database operation failed', error && error.message ? error.message : error);
    return fail('用户服务暂不可用', 503);
  }
}

async function syncMarks(user, body) {
  try {
    const client = getClient();
    const hasChanges = body && Object.prototype.hasOwnProperty.call(body, 'changes');
    const marks = hasChanges
      ? await applyMarkChanges(client, user.sub, body.changes)
      : await replaceMarks(client, user.sub, body && body.marks);
    return ok({ marks });
  } catch (error) {
    if (error && /标记数据格式|最多可同步/.test(error.message || '')) return fail(error.message);
    console.error('[user marks] database operation failed', error && error.message ? error.message : error);
    return fail('标记同步失败，请稍后重试', 503);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const path = (req.url || '/').split('?')[0];
  const parsedBody = await readBody(req);
  if (parsedBody.tooLarge) return res.status(413).json({ error: '请求内容过大' });
  const body = parsedBody.value;
  const send = response => res.status(response.statusCode).json(JSON.parse(response.body));

  if (path.endsWith('/login') && req.method === 'POST') return send(await login(body));

  const configError = getConfigError();
  if (configError) return send(fail(configError, 503));
  const [user, authError] = requireUser(req.headers);
  if (authError) return send(authError);
  if (path.endsWith('/me') && req.method === 'GET') return send(await getCurrentUser(user));
  if (path.endsWith('/marks') && req.method === 'GET') return send(await getCurrentUser(user));
  if (path.endsWith('/marks') && req.method === 'POST') return send(await syncMarks(user, body));
  return send(fail('接口不存在', 404));
};
