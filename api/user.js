'use strict';

// WeChat Mini Program v2 identity, profile, and mark-sync API.
// OpenID and UnionID never leave this server. Clients receive revocable opaque
// session tokens whose SHA-256 hashes are the only token values stored.

const crypto = require('crypto');
const https = require('https');
const Busboy = require('busboy');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const WECHAT_APP_ID = process.env.WECHAT_MINIPROGRAM_APP_ID || 'wx9b58b642b80ab6aa';
const WECHAT_APP_SECRET = process.env.WECHAT_MINIPROGRAM_APP_SECRET || '';

const DEFAULT_NICKNAME = '收藏用户';
const AVATAR_BUCKET = 'miniprogram-avatars';
const AVATAR_URL_TTL_SECONDS = 60 * 60;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_AVATAR_BYTES + 64 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_MARK_CHANGES = 200;
const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const USER_SELECT = 'id,unionid,nickname,avatar_path,avatar_updated_at,marks_revision,updated_at';

function sessionTtlDays() {
  const value = Number(process.env.MINIPROGRAM_SESSION_TTL_DAYS || 30);
  return Number.isFinite(value) && Number.isInteger(value) && value >= 1 && value <= 90
    ? value
    : 30;
}

class ApiError extends Error {
  constructor(status, code, message, cause) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.cause = cause;
  }
}

function apiError(status, code, message, cause) {
  return new ApiError(status, code, message, cause);
}

function serviceError(code, message, cause) {
  return apiError(503, code, message, cause);
}

function getClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw serviceError('SERVICE_NOT_CONFIGURED', '用户服务暂不可用');
  }
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function requireLoginConfig() {
  if (!SUPABASE_URL || !SUPABASE_KEY || !WECHAT_APP_ID || !WECHAT_APP_SECRET) {
    throw serviceError('SERVICE_NOT_CONFIGURED', '登录服务暂不可用');
  }
}

function configureResponse(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-MiniProgram-User-Api', 'v2-20260716');
}

function sendJson(res, status, body) {
  return res.status(status).json(body);
}

function sendError(res, error) {
  const safeError = error instanceof ApiError
    ? error
    : serviceError('SERVICE_UNAVAILABLE', '用户服务暂不可用', error);
  return sendJson(res, safeError.status, {
    error: { code: safeError.code, message: safeError.message },
  });
}

function safeCauseMessage(error) {
  const raw = error && error.cause && typeof error.cause.message === 'string'
    ? error.cause.message
    : '';
  if (!raw) return undefined;
  let safe = raw.slice(0, 300);
  for (const secret of [SUPABASE_KEY, WECHAT_APP_SECRET]) {
    if (secret) safe = safe.split(secret).join('[redacted]');
  }
  return safe
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9_-]{43}\b/g, '[redacted-token]')
    .replace(/\b[0-9a-f]{64}\b/gi, '[redacted-hash]');
}

function logServerFailure(error) {
  if (error instanceof ApiError) {
    if (error.status < 500) return;
    console.error('[miniprogram user api] request failed', {
      code: error.code,
      cause: safeCauseMessage(error),
    });
    return;
  }
  console.error('[miniprogram user api] request failed', {
    code: 'UNHANDLED_ERROR',
    cause: safeCauseMessage({ cause: error }),
  });
}

function routePath(rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl || '/', 'https://local.invalid').pathname;
  } catch {
    return '/';
  }
  pathname = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (pathname === '/api/user') return '/';
  if (pathname.startsWith('/api/user/')) return pathname.slice('/api/user'.length);
  return pathname;
}

function requestUrl(rawUrl) {
  try {
    return new URL(rawUrl || '/', 'https://local.invalid');
  } catch {
    throw apiError(400, 'INVALID_REQUEST', '请求地址无效');
  }
}

function contentType(req) {
  const value = req && req.headers && (req.headers['content-type'] || req.headers['Content-Type']);
  return typeof value === 'string' ? value : '';
}

function contentLength(req) {
  const value = req && req.headers && (req.headers['content-length'] || req.headers['Content-Length']);
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function existingRequestBody(req) {
  try {
    return req && req.body;
  } catch {
    return undefined;
  }
}

function readRawBody(req, maxBytes) {
  const body = existingRequestBody(req);
  if (body !== undefined && body !== null) {
    if (Buffer.isBuffer(body)) {
      if (body.length > maxBytes) {
        return Promise.reject(apiError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大'));
      }
      return Promise.resolve(body);
    }
    if (typeof body === 'string') {
      const encoded = Buffer.from(body, 'utf8');
      if (encoded.length > maxBytes) {
        return Promise.reject(apiError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大'));
      }
      return Promise.resolve(encoded);
    }
    if (typeof body.on === 'function') return readNodeStream(body, maxBytes);
    return Promise.reject(apiError(400, 'INVALID_JSON', '请求内容不是有效的 JSON'));
  }

  return readNodeStream(req, maxBytes);
}

function readNodeStream(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!stream || typeof stream.on !== 'function') {
      reject(apiError(400, 'REQUEST_READ_FAILED', '读取请求失败'));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    try {
      stream.on('data', chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBytes) {
          tooLarge = true;
          return;
        }
        chunks.push(buffer);
      });
      stream.on('end', () => {
        if (tooLarge) {
          finish(reject, apiError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大'));
        } else {
          finish(resolve, Buffer.concat(chunks));
        }
      });
      stream.on('aborted', () => finish(reject, apiError(400, 'REQUEST_ABORTED', '请求已中断')));
      stream.on('error', error => finish(reject, apiError(400, 'REQUEST_READ_FAILED', '读取请求失败', error)));
    } catch (error) {
      finish(reject, apiError(400, 'REQUEST_READ_FAILED', '读取请求失败', error));
    }
  });
}

async function readJson(req) {
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(contentType(req))) {
    throw apiError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求必须使用 application/json');
  }
  const length = contentLength(req);
  if (length !== null && length > MAX_JSON_BYTES) {
    throw apiError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大');
  }
  // Some serverless adapters provide an already-parsed plain object even when
  // raw parsing is disabled. Reusing it avoids attempting to consume a stream
  // that the adapter has already finalized.
  const parsedBody = existingRequestBody(req);
  if (isPlainObject(parsedBody)) return parsedBody;
  const raw = await readRawBody(req, MAX_JSON_BYTES);
  if (!raw.length) throw apiError(400, 'INVALID_JSON', '请求内容不能为空');
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw apiError(400, 'INVALID_JSON', '请求内容不是有效的 JSON', error);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, allowedKeys) {
  if (!isPlainObject(value)) throw apiError(400, 'INVALID_REQUEST', '请求内容格式无效');
  const extras = Object.keys(value).filter(key => !allowedKeys.includes(key));
  if (extras.length) throw apiError(400, 'INVALID_REQUEST', '请求包含不支持的字段');
  return value;
}

function codePointLength(value) {
  return Array.from(value).length;
}

function normalizeNickname(value) {
  if (typeof value !== 'string') throw apiError(400, 'INVALID_NICKNAME', '昵称格式无效');
  const nickname = value.normalize('NFC').trim();
  if (codePointLength(nickname) > 80 || CONTROL_CHARACTER_PATTERN.test(nickname)) {
    throw apiError(400, 'INVALID_NICKNAME', '昵称格式无效');
  }
  return nickname;
}

function normalizeLoginBody(value) {
  const body = requireObject(value, ['code']);
  // wx.login codes are opaque, non-whitespace ASCII-like tokens. A single
  // expression avoids calling methods on framework-parsed request values.
  if (typeof body.code !== 'string' || !/^[^\s]{1,256}$/.test(body.code)) {
    throw apiError(400, 'INVALID_WECHAT_CODE', '微信登录凭证无效');
  }
  return { code: body.code };
}

function normalizeProfilePatch(value) {
  const body = requireObject(value, ['nickname']);
  if (!Object.prototype.hasOwnProperty.call(body, 'nickname')) {
    throw apiError(400, 'INVALID_REQUEST', '缺少昵称');
  }
  return { nickname: normalizeNickname(body.nickname) };
}

function normalizeNonnegativeInteger(value, fieldName) {
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw apiError(400, 'INVALID_REQUEST', `${fieldName} 必须是非负整数`);
  }
  return value;
}

function normalizeMutationId(value) {
  if (typeof value !== 'string' || value.trim() !== value
    || codePointLength(value) < 8 || codePointLength(value) > 100
    || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw apiError(400, 'INVALID_MUTATION_ID', 'mutationId 格式无效');
  }
  return value;
}

function normalizeSkinKey(value) {
  if (typeof value !== 'string' || value.trim() !== value
    || codePointLength(value) < 1 || codePointLength(value) > 300
    || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw apiError(400, 'INVALID_MARK_CHANGE', '皮肤标识格式无效');
  }
  return value;
}

function normalizeMarkBatch(value) {
  const body = requireObject(value, ['mutationId', 'baseRevision', 'changes']);
  const mutationId = normalizeMutationId(body.mutationId);
  const baseRevision = normalizeNonnegativeInteger(body.baseRevision, 'baseRevision');
  if (!Array.isArray(body.changes) || body.changes.length < 1 || body.changes.length > MAX_MARK_CHANGES) {
    throw apiError(400, 'INVALID_MARK_CHANGE', `changes 必须包含 1-${MAX_MARK_CHANGES} 条变更`);
  }

  const seen = new Set();
  const changes = body.changes.map(change => {
    const item = requireObject(change, ['key', 'type']);
    if (!Object.prototype.hasOwnProperty.call(item, 'key')
      || !Object.prototype.hasOwnProperty.call(item, 'type')) {
      throw apiError(400, 'INVALID_MARK_CHANGE', '标记变更缺少 key 或 type');
    }
    const key = normalizeSkinKey(item.key);
    if (seen.has(key)) throw apiError(400, 'INVALID_MARK_CHANGE', '同一批次不能包含重复的皮肤标识');
    seen.add(key);
    if (item.type !== 'owned' && item.type !== 'follow' && item.type !== null) {
      throw apiError(400, 'INVALID_MARK_CHANGE', '标记类型无效');
    }
    return { key, type: item.type };
  });
  return { mutationId, baseRevision, changes };
}

function parseKnownRevision(rawUrl) {
  const value = requestUrl(rawUrl).searchParams.get('revision');
  return value === null || value === '' ? null : normalizeNonnegativeInteger(value, 'revision');
}

function canonicalMimeType(value) {
  const mime = String(value || '').toLowerCase().split(';')[0].trim();
  if (mime === 'image/jpg') return 'image/jpeg';
  return mime;
}

function inspectAvatar(buffer, declaredMimeType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw apiError(400, 'INVALID_AVATAR', '头像文件为空');
  }
  if (buffer.length > MAX_AVATAR_BYTES) {
    throw apiError(413, 'AVATAR_TOO_LARGE', '头像文件不能超过 2MB');
  }

  let contentType = '';
  let extension = '';
  const isPng = buffer.length >= 24
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && buffer.subarray(12, 16).toString('ascii') === 'IHDR';
  const isJpeg = buffer.length >= 4
    && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebp = buffer.length >= 16
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';

  if (isPng) {
    contentType = 'image/png';
    extension = 'png';
  } else if (isJpeg) {
    contentType = 'image/jpeg';
    extension = 'jpg';
  } else if (isWebp) {
    contentType = 'image/webp';
    extension = 'webp';
  } else {
    throw apiError(415, 'UNSUPPORTED_AVATAR_TYPE', '头像仅支持 PNG、JPEG 或 WebP 格式');
  }

  const declared = canonicalMimeType(declaredMimeType);
  const isGenericBinary = declared === 'application/octet-stream';
  if (!isGenericBinary && !['image/png', 'image/jpeg', 'image/webp'].includes(declared)) {
    throw apiError(415, 'UNSUPPORTED_AVATAR_TYPE', '头像 MIME 类型无效');
  }
  // Some wx.uploadFile versions label a temporary chooseAvatar file as generic
  // binary. In that one case the verified magic bytes become authoritative.
  if (!isGenericBinary && declared !== contentType) {
    throw apiError(415, 'AVATAR_MIME_MISMATCH', '头像内容与 MIME 类型不一致');
  }
  return { buffer, contentType, extension };
}

function parseMultipartAvatar(req) {
  const type = contentType(req);
  if (!/^multipart\/form-data\s*;/i.test(type) || !/boundary=/i.test(type)) {
    return Promise.reject(apiError(415, 'UNSUPPORTED_MEDIA_TYPE', '头像必须使用 multipart/form-data 上传'));
  }
  const length = contentLength(req);
  if (length !== null && length > MAX_MULTIPART_BYTES) {
    return Promise.reject(apiError(413, 'AVATAR_TOO_LARGE', '头像文件不能超过 2MB'));
  }
  if (Buffer.isBuffer(req.body) && req.body.length > MAX_MULTIPART_BYTES) {
    return Promise.reject(apiError(413, 'AVATAR_TOO_LARGE', '头像文件不能超过 2MB'));
  }

  return new Promise((resolve, reject) => {
    let parser;
    try {
      const headers = { ...req.headers, 'content-type': type };
      parser = Busboy({
        headers,
        // Busboy emits partsLimit when the configured threshold is reached, so
        // a threshold of two accepts the one required file and rejects part #2.
        limits: { files: 1, fileSize: MAX_AVATAR_BYTES, fields: 0, parts: 2 },
      });
    } catch (error) {
      reject(apiError(400, 'INVALID_MULTIPART', '头像上传格式无效', error));
      return;
    }

    let fileSeen = false;
    let fileEnded = false;
    let fileMimeType = '';
    let tooLarge = false;
    let problem = null;
    const chunks = [];

    const setProblem = error => {
      if (!problem) problem = error;
    };

    parser.on('file', (fieldName, file, info) => {
      if (fileSeen || fieldName !== 'avatar') {
        setProblem(apiError(400, 'INVALID_MULTIPART', '仅支持名为 avatar 的单个文件'));
        file.resume();
        return;
      }
      fileSeen = true;
      fileMimeType = info && info.mimeType ? info.mimeType : '';
      file.on('limit', () => { tooLarge = true; });
      file.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
      file.on('end', () => { fileEnded = true; });
      file.on('error', error => setProblem(apiError(400, 'REQUEST_READ_FAILED', '读取头像文件失败', error)));
    });
    parser.on('field', () => setProblem(apiError(400, 'INVALID_MULTIPART', '头像上传不支持额外字段')));
    parser.on('filesLimit', () => setProblem(apiError(400, 'INVALID_MULTIPART', '只能上传一个头像文件')));
    parser.on('fieldsLimit', () => setProblem(apiError(400, 'INVALID_MULTIPART', '头像上传不支持额外字段')));
    parser.on('partsLimit', () => setProblem(apiError(400, 'INVALID_MULTIPART', '头像上传包含过多内容')));
    parser.on('error', error => reject(apiError(400, 'INVALID_MULTIPART', '头像上传格式无效', error)));
    parser.on('finish', () => {
      if (problem) return reject(problem);
      if (!fileSeen || !fileEnded) return reject(apiError(400, 'INVALID_AVATAR', '缺少头像文件'));
      if (tooLarge) return reject(apiError(413, 'AVATAR_TOO_LARGE', '头像文件不能超过 2MB'));
      try {
        resolve(inspectAvatar(Buffer.concat(chunks), fileMimeType));
      } catch (error) {
        reject(error);
      }
    });

    if (req.body !== undefined && req.body !== null) {
      if (Buffer.isBuffer(req.body)) parser.end(req.body);
      else if (typeof req.body === 'string') parser.end(Buffer.from(req.body, 'latin1'));
      else reject(apiError(400, 'INVALID_MULTIPART', '头像上传内容无效'));
    } else if (typeof req.pipe === 'function') {
      req.once('aborted', () => reject(apiError(400, 'REQUEST_ABORTED', '请求已中断')));
      req.once('error', error => reject(apiError(400, 'REQUEST_READ_FAILED', '读取头像文件失败', error)));
      req.pipe(parser);
    } else {
      reject(apiError(400, 'INVALID_MULTIPART', '头像上传内容无效'));
    }
  });
}

async function requestWechatSession(code) {
  const query = new URLSearchParams({
    appid: WECHAT_APP_ID,
    secret: WECHAT_APP_SECRET,
    js_code: code,
    grant_type: 'authorization_code',
  });
  const url = `https://api.weixin.qq.com/sns/jscode2session?${query.toString()}`;
  if (typeof fetch !== 'function' || typeof AbortController !== 'function') {
    return requestWechatSessionWithHttps(url);
  }

  let controller;
  let timer;
  try {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw apiError(502, 'WECHAT_UNAVAILABLE', '微信登录服务暂不可用');
    }

    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > 32 * 1024) {
      throw apiError(502, 'WECHAT_UNAVAILABLE', '微信登录服务响应异常');
    }
    try {
      return JSON.parse(body || '{}');
    } catch (error) {
      throw apiError(502, 'WECHAT_UNAVAILABLE', '微信登录服务响应异常', error);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error && error.name === 'AbortError') {
      throw apiError(504, 'WECHAT_TIMEOUT', '微信登录服务响应超时', error);
    }
    throw apiError(502, 'WECHAT_UNAVAILABLE', '微信登录服务暂不可用', error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requestWechatSessionWithHttps(url) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = https.get(url, { timeout: 8000 }, response => {
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 32 * 1024) {
            request.destroy(apiError(502, 'WECHAT_UNAVAILABLE', '微信登录服务响应异常'));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(apiError(502, 'WECHAT_UNAVAILABLE', '微信登录服务暂不可用'));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
          } catch (error) {
            reject(apiError(502, 'WECHAT_UNAVAILABLE', '微信登录服务响应异常', error));
          }
        });
      });
      request.on('timeout', () => request.destroy(apiError(504, 'WECHAT_TIMEOUT', '微信登录服务响应超时')));
      request.on('error', error => {
        reject(error instanceof ApiError
          ? error
          : apiError(502, 'WECHAT_UNAVAILABLE', '微信登录服务暂不可用', error));
      });
    } catch (error) {
      reject(apiError(502, 'WECHAT_UNAVAILABLE', '微信登录服务暂不可用', error));
    }
  });
}

function validateWechatSession(value) {
  if (!isPlainObject(value)) throw apiError(502, 'WECHAT_UNAVAILABLE', '微信登录服务响应异常');
  if (value.errcode !== undefined && Number(value.errcode) !== 0) {
    const code = Number(value.errcode);
    if (code === 40029 || code === 40163) {
      throw apiError(401, 'WECHAT_CODE_INVALID', '微信登录凭证已失效，请重试');
    }
    if (code === 45011) throw apiError(429, 'WECHAT_RATE_LIMITED', '登录操作过于频繁，请稍后重试');
    if (code === 40226) throw apiError(403, 'WECHAT_LOGIN_BLOCKED', '当前微信账号暂无法登录');
    throw apiError(502, 'WECHAT_UNAVAILABLE', '微信登录服务暂不可用');
  }
  if (typeof value.openid !== 'string' || !value.openid || value.openid.length > 128) {
    throw apiError(502, 'WECHAT_UNAVAILABLE', '微信登录服务响应异常');
  }
  return {
    openid: value.openid,
    unionid: typeof value.unionid === 'string' && value.unionid && value.unionid.length <= 128
      ? value.unionid
      : null,
  };
}

async function selectUserBy(client, column, value) {
  const { data, error } = await client
    .from('miniprogram_users')
    .select(USER_SELECT)
    .eq(column, value)
    .maybeSingle();
  if (error) throw serviceError('DATABASE_UNAVAILABLE', '登录服务暂不可用', error);
  return data || null;
}

async function touchUserLogin(client, row, unionid) {
  const patch = { last_login_at: new Date().toISOString() };
  if (unionid && row.unionid !== unionid) patch.unionid = unionid;
  const { data, error } = await client
    .from('miniprogram_users')
    .update(patch)
    .eq('id', row.id)
    .select(USER_SELECT)
    .maybeSingle();
  if (error || !data) throw serviceError('DATABASE_UNAVAILABLE', '登录服务暂不可用', error);
  return data;
}

async function findOrCreateUser(client, identity) {
  let row = await selectUserBy(client, 'openid', identity.openid);
  if (row) return touchUserLogin(client, row, identity.unionid);

  const now = new Date().toISOString();
  const { data, error } = await client
    .from('miniprogram_users')
    .insert({ openid: identity.openid, unionid: identity.unionid, last_login_at: now })
    .select(USER_SELECT)
    .maybeSingle();
  if (!error && data) return data;

  // Concurrent login codes for the same account can race on the unique key.
  if (error && error.code === '23505') {
    row = await selectUserBy(client, 'openid', identity.openid);
    if (!row && identity.unionid) row = await selectUserBy(client, 'unionid', identity.unionid);
    if (row) return touchUserLogin(client, row, identity.unionid);
  }
  throw serviceError('DATABASE_UNAVAILABLE', '登录服务暂不可用', error);
}

function newSessionToken() {
  return crypto.randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

async function createSession(client, userId) {
  const expiresAt = new Date(Date.now() + sessionTtlDays() * 24 * 60 * 60 * 1000).toISOString();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = newSessionToken();
    const { error } = await client.from('miniprogram_sessions').insert({
      user_id: userId,
      token_hash: hashSessionToken(token),
      expires_at: expiresAt,
    });
    if (!error) return { token, expiresAt };
    if (error.code !== '23505') throw serviceError('DATABASE_UNAVAILABLE', '登录服务暂不可用', error);
  }
  throw serviceError('SESSION_CREATE_FAILED', '登录服务暂不可用');
}

function bearerToken(headers) {
  const authorization = headers && (headers.authorization || headers.Authorization);
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
  return match && SESSION_TOKEN_PATTERN.test(match[1]) ? match[1] : null;
}

async function authenticate(client, headers) {
  const token = bearerToken(headers);
  if (!token) throw apiError(401, 'SESSION_INVALID', '登录已失效，请重新登录');

  const { data, error } = await client
    .from('miniprogram_sessions')
    .select(`id,user_id,expires_at,revoked_at,last_seen_at,created_at,user:miniprogram_users!inner(${USER_SELECT})`)
    .eq('token_hash', hashSessionToken(token))
    .maybeSingle();
  if (error) throw serviceError('DATABASE_UNAVAILABLE', '用户服务暂不可用', error);
  if (!data || data.revoked_at) throw apiError(401, 'SESSION_INVALID', '登录已失效，请重新登录');
  if (!data.expires_at || Date.parse(data.expires_at) <= Date.now()) {
    throw apiError(401, 'SESSION_EXPIRED', '登录已过期，请重新登录');
  }
  const user = Array.isArray(data.user) ? data.user[0] : data.user;
  if (!user || !user.id) throw apiError(401, 'SESSION_INVALID', '登录已失效，请重新登录');
  const lastSeenAt = Date.parse(data.last_seen_at || '');
  if (!Number.isFinite(lastSeenAt) || Date.now() - lastSeenAt >= 24 * 60 * 60 * 1000) {
    const { error: touchError } = await client
      .from('miniprogram_sessions')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', data.id)
      .is('revoked_at', null);
    if (touchError) {
      console.warn('[miniprogram user api] session last-seen update failed', {
        code: 'SESSION_TOUCH_FAILED',
        cause: safeCauseMessage({ cause: touchError }),
      });
    }
  }
  return { sessionId: data.id, sessionCreatedAt: data.created_at, user };
}

function safeIntegerFromDatabase(value, field) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw serviceError('DATABASE_RESPONSE_INVALID', `用户服务返回的 ${field} 无效`);
  }
  return parsed;
}

async function publicProfile(client, row, options) {
  const includeAvatarUrl = !options || options.includeAvatarUrl !== false;
  const hasAvatar = Boolean(row && row.avatar_path);
  let avatarUrl = '';
  let avatarExpiresAt = null;
  if (hasAvatar && includeAvatarUrl) {
    try {
      const { data, error } = await client.storage
        .from(AVATAR_BUCKET)
        .createSignedUrl(row.avatar_path, AVATAR_URL_TTL_SECONDS);
      if (!error && data && data.signedUrl) {
        avatarUrl = data.signedUrl;
        avatarExpiresAt = new Date(Date.now() + AVATAR_URL_TTL_SECONDS * 1000).toISOString();
      } else {
        console.warn('[miniprogram user api] avatar signing failed', {
          code: 'AVATAR_SIGN_FAILED',
          cause: safeCauseMessage({ cause: error }),
        });
      }
    } catch (error) {
      // Profile data remains usable. hasAvatar tells the client to retry GET /profile
      // instead of persisting the application placeholder over a real avatar.
      console.warn('[miniprogram user api] avatar signing failed', {
        code: 'AVATAR_SIGN_FAILED',
        cause: safeCauseMessage({ cause: error }),
      });
    }
  }
  const rawNickname = row && typeof row.nickname === 'string' ? row.nickname : '';
  return {
    nickname: rawNickname || DEFAULT_NICKNAME,
    hasNickname: Boolean(rawNickname),
    avatarUrl,
    avatarExpiresAt,
    hasAvatar,
    isComplete: Boolean(rawNickname && hasAvatar),
    updatedAt: row && row.updated_at ? row.updated_at : null,
  };
}

async function login(req) {
  let stage = 'config';
  try {
    requireLoginConfig();
    stage = 'body';
    const payload = await readJson(req);
    stage = 'validation';
    const body = normalizeLoginBody(payload);
    stage = 'wechat';
    const identity = validateWechatSession(await requestWechatSession(body.code));
    stage = 'user';
    const client = getClient();
    const user = await findOrCreateUser(client, identity);
    // Identity creation must not wait for a Storage signed-URL request. The
    // client fetches the full profile in the background immediately afterwards.
    stage = 'session';
    const session = await createSession(client, user.id);
    const profile = await publicProfile(client, user, { includeAvatarUrl: false });
    return {
      status: 201,
      body: {
        token: session.token,
        expiresAt: session.expiresAt,
        userId: user.id,
        profile,
        marksRevision: safeIntegerFromDatabase(user.marks_revision, 'marksRevision'),
      },
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const errorMessage = String(error && error.message || '').toLowerCase();
    const streamState = stage === 'body' && errorMessage.includes('not readable')
      ? 'STREAM_NOT_READABLE'
      : (stage === 'body' && errorMessage.includes('already') ? 'STREAM_ALREADY_USED' : '');
    const type = streamState || String(error && error.name || 'Unexpected')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 40)
      .toUpperCase() || 'UNEXPECTED';
    throw serviceError(`LOGIN_${stage.toUpperCase()}_${type}`, '登录服务暂不可用', error);
  }
}

async function revokeSession(client, auth) {
  const createdAt = Date.parse(auth.sessionCreatedAt || '');
  const revokedAt = new Date(Math.max(Date.now(), Number.isFinite(createdAt) ? createdAt + 1000 : 0)).toISOString();
  const { error } = await client
    .from('miniprogram_sessions')
    .update({ revoked_at: revokedAt })
    .eq('id', auth.sessionId)
    .is('revoked_at', null);
  if (error) throw serviceError('DATABASE_UNAVAILABLE', '退出登录失败，请稍后重试', error);
}

async function getProfile(client, auth) {
  return { profile: await publicProfile(client, auth.user) };
}

async function patchProfile(client, auth, req) {
  const patch = normalizeProfilePatch(await readJson(req));
  const { data, error } = await client
    .from('miniprogram_users')
    .update({ nickname: patch.nickname })
    .eq('id', auth.user.id)
    .select(USER_SELECT)
    .maybeSingle();
  if (error || !data) throw serviceError('DATABASE_UNAVAILABLE', '更新资料失败，请稍后重试', error);
  return { profile: await publicProfile(client, data) };
}

async function cleanupAvatar(client, path) {
  if (!path) return;
  try {
    const { error } = await client.storage.from(AVATAR_BUCKET).remove([path]);
    if (error) {
      console.warn('[miniprogram user api] avatar cleanup failed', {
        code: 'AVATAR_CLEANUP_FAILED',
        cause: safeCauseMessage({ cause: error }),
      });
    }
  } catch (error) {
    // Storage and the relational update cannot share one transaction. A later
    // bucket lifecycle cleanup may remove a rare object left after this point.
    console.warn('[miniprogram user api] avatar cleanup failed', {
      code: 'AVATAR_CLEANUP_FAILED',
      cause: safeCauseMessage({ cause: error }),
    });
  }
}

async function uploadAvatar(client, auth, req) {
  const avatar = await parseMultipartAvatar(req);
  const objectPath = `avatars/${auth.user.id}/${crypto.randomUUID()}.${avatar.extension}`;
  let uploadError;
  try {
    ({ error: uploadError } = await client.storage.from(AVATAR_BUCKET).upload(objectPath, avatar.buffer, {
      contentType: avatar.contentType,
      cacheControl: '31536000',
      upsert: false,
    }));
  } catch (error) {
    await cleanupAvatar(client, objectPath);
    throw serviceError('AVATAR_UPLOAD_FAILED', '头像上传失败，请稍后重试', error);
  }
  if (uploadError) {
    await cleanupAvatar(client, objectPath);
    throw serviceError('AVATAR_UPLOAD_FAILED', '头像上传失败，请稍后重试', uploadError);
  }

  let data;
  let updateError;
  try {
    ({ data, error: updateError } = await client
      .from('miniprogram_users')
      .update({ avatar_path: objectPath, avatar_updated_at: new Date().toISOString() })
      .eq('id', auth.user.id)
      // Only one upload based on the same profile snapshot may win. This closes
      // the common concurrent-upload orphan race; the loser removes its object.
      .eq('avatar_path', auth.user.avatar_path || '')
      .select(USER_SELECT)
      .maybeSingle());
  } catch (error) {
    await cleanupAvatar(client, objectPath);
    throw serviceError('AVATAR_UPLOAD_FAILED', '头像上传失败，请稍后重试', error);
  }
  if (updateError || !data) {
    await cleanupAvatar(client, objectPath);
    if (!updateError) {
      throw apiError(409, 'AVATAR_CONFLICT', '头像已在其他请求中更新，请重试');
    }
    throw serviceError('AVATAR_UPLOAD_FAILED', '头像上传失败，请稍后重试', updateError);
  }

  if (auth.user.avatar_path && auth.user.avatar_path !== objectPath) {
    await cleanupAvatar(client, auth.user.avatar_path);
  }
  return { profile: await publicProfile(client, data) };
}

async function readMarks(client, userId, knownRevision) {
  const { data, error } = await client.rpc('read_miniprogram_marks', {
    p_user_id: userId,
    p_known_revision: knownRevision,
  });
  if (error) throw serviceError('MARKS_READ_FAILED', '读取收藏失败，请稍后重试', error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !Array.isArray(row.marks)) {
    throw serviceError('DATABASE_RESPONSE_INVALID', '收藏服务返回异常');
  }

  const marks = row.marks.map(mark => {
    if (!isPlainObject(mark) || typeof mark.key !== 'string'
      || (mark.type !== 'owned' && mark.type !== 'follow')) {
      throw serviceError('DATABASE_RESPONSE_INVALID', '收藏服务返回异常');
    }
    return { key: mark.key, type: mark.type };
  });
  return {
    revision: safeIntegerFromDatabase(row.revision, 'revision'),
    notModified: row.not_modified === true,
    markCount: safeIntegerFromDatabase(row.mark_count, 'markCount'),
    marks,
  };
}

async function applyMarkBatch(client, userId, req) {
  const batch = normalizeMarkBatch(await readJson(req));
  const { data, error } = await client.rpc('apply_miniprogram_mark_changes', {
    p_user_id: userId,
    p_changes: batch.changes,
    p_mutation_id: batch.mutationId,
    p_base_revision: batch.baseRevision,
  });
  if (error) {
    if (error.code === '22023') {
      throw apiError(400, 'INVALID_MARK_BATCH', '收藏变更无效或 mutationId 已被其他请求使用');
    }
    throw serviceError('MARKS_WRITE_FAILED', '同步收藏失败，请稍后重试', error);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw serviceError('DATABASE_RESPONSE_INVALID', '收藏服务返回异常');
  return {
    revision: safeIntegerFromDatabase(row.revision, 'revision'),
    markCount: safeIntegerFromDatabase(row.mark_count, 'markCount'),
    duplicate: row.duplicate === true,
    conflict: row.conflict === true,
  };
}

function allowedMethods(path) {
  if (path === '/session') return ['POST', 'DELETE'];
  if (path === '/profile') return ['GET', 'PATCH'];
  if (path === '/profile/avatar') return ['POST'];
  if (path === '/marks') return ['GET'];
  if (path === '/marks/batch') return ['POST'];
  return null;
}

async function handler(req, res) {
  configureResponse(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const path = routePath(req.url);
  const allowed = allowedMethods(path);
  if (!allowed) return sendError(res, apiError(404, 'NOT_FOUND', '接口不存在'));
  if (!allowed.includes(req.method)) {
    res.setHeader('Allow', [...allowed, 'OPTIONS'].join(', '));
    return sendError(res, apiError(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持'));
  }

  try {
    if (path === '/session' && req.method === 'POST') {
      const response = await login(req);
      return sendJson(res, response.status, response.body);
    }

    const client = getClient();
    const auth = await authenticate(client, req.headers);
    if (path === '/session' && req.method === 'DELETE') {
      await revokeSession(client, auth);
      return res.status(204).end();
    }
    if (path === '/profile' && req.method === 'GET') {
      return sendJson(res, 200, await getProfile(client, auth));
    }
    if (path === '/profile' && req.method === 'PATCH') {
      return sendJson(res, 200, await patchProfile(client, auth, req));
    }
    if (path === '/profile/avatar' && req.method === 'POST') {
      return sendJson(res, 200, await uploadAvatar(client, auth, req));
    }
    if (path === '/marks' && req.method === 'GET') {
      return sendJson(res, 200, await readMarks(client, auth.user.id, parseKnownRevision(req.url)));
    }
    if (path === '/marks/batch' && req.method === 'POST') {
      return sendJson(res, 200, await applyMarkBatch(client, auth.user.id, req));
    }
    return sendError(res, apiError(404, 'NOT_FOUND', '接口不存在'));
  } catch (error) {
    logServerFailure(error);
    return sendError(res, error);
  }
}

module.exports = handler;
module.exports._private = {
  ApiError,
  applyMarkBatch,
  bearerToken,
  hashSessionToken,
  inspectAvatar,
  normalizeLoginBody,
  normalizeMarkBatch,
  normalizeNickname,
  normalizeProfilePatch,
  parseKnownRevision,
  parseMultipartAvatar,
  publicProfile,
  readMarks,
  requestWechatSession,
  routePath,
  validateWechatSession,
};
