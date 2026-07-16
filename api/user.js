// api/user.js — WeChat Mini Program user login and cloud mark sync.

const https = require('https');
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
        try { return resolve(JSON.parse(req.body)); } catch { return resolve({}); }
      }
      return resolve(req.body || {});
    }
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
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
  const avatarUrl = trimText(profile && profile.avatarUrl, 1000);
  return {
    nickname,
    avatarUrl: /^https:\/\//.test(avatarUrl) ? avatarUrl : '',
  };
}

function publicProfile(row) {
  return {
    nickname: row && row.nickname ? row.nickname : '',
    avatarUrl: row && row.avatar_url ? row.avatar_url : '',
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
    .select('openid,nickname,avatar_url')
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

  const profile = normalizeProfile(body && body.profile);
  try {
    const client = getClient();
    const previous = await getUser(client, session.openid);
    const row = {
      openid: session.openid,
      nickname: profile.nickname || (previous && previous.nickname) || '',
      avatar_url: profile.avatarUrl || (previous && previous.avatar_url) || '',
    };
    const { data, error } = await client
      .from('miniprogram_users')
      .upsert(row, { onConflict: 'openid' })
      .select('nickname,avatar_url')
      .maybeSingle();
    if (error) throw error;
    const marks = await getMarks(client, session.openid);
    return ok({ token: issueToken(session.openid), profile: publicProfile(data || row), marks });
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
    return ok({ profile: publicProfile(profile), marks });
  } catch (error) {
    console.error('[user me] database operation failed', error && error.message ? error.message : error);
    return fail('用户服务暂不可用', 503);
  }
}

async function syncMarks(user, body) {
  try {
    const client = getClient();
    const marks = await replaceMarks(client, user.sub, body && body.marks);
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
  const body = await readBody(req);
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
