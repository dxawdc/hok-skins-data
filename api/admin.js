// api/admin.js — Vercel Node.js Serverless Function

const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

const SUPABASE_URL = process.env.SUPABASE_URL        || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const JWT_SECRET   = process.env.JWT_SECRET           || 'change-me';

function getClient() {
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ── CORS ──────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

function ok(data, status = 200) {
  return { statusCode: status, body: JSON.stringify(data) };
}
function fail(msg, status = 400) {
  return { statusCode: status, body: JSON.stringify({ error: msg }) };
}

// ── 读取请求 body ─────────────────────────────────────────────
function readBody(req) {
  return new Promise(resolve => {
    if (req.body !== undefined) {
      if (typeof req.body === 'string') {
        try { return resolve(JSON.parse(req.body)); } catch { return resolve({}); }
      }
      return resolve(req.body || {});
    }
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end',  () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error',() => resolve({}));
  });
}

// ── JWT ───────────────────────────────────────────────────────
function verifyToken(headers) {
  const auth = headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  try { return jwt.verify(auth.slice(7), JWT_SECRET); } catch { return null; }
}
function requireAuth(headers) {
  const u = verifyToken(headers);
  return u ? [u, null] : [null, fail('未登录或登录已过期', 401)];
}
function requireAdmin(headers) {
  const [u, e] = requireAuth(headers);
  if (e) return [null, e];
  return u.role === 'admin' ? [u, null] : [null, fail('需要管理员权限', 403)];
}

// ── 日志 ─────────────────────────────────────────────────────
async function log(client, operator, action, targetId, detail) {
  try { await client.from('audit_log').insert({ operator, action, target_id: targetId, detail }); } catch {}
}

// ── 入口 ─────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS — 必须在所有响应上设置，包括 OPTIONS 预检
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  // OPTIONS 预检：直接返回 204 No Content（比 200 更标准）
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const body   = await readBody(req);
  const url    = req.url || '/';
  const path   = url.split('?')[0];
  const qs     = Object.fromEntries(new URLSearchParams(url.includes('?') ? url.split('?')[1] : ''));
  const h      = req.headers;
  const m      = req.method;

  const send = r => {
    res.setHeader('Content-Type', 'application/json');
    res.status(r.statusCode).end(r.body);
  };

  // 登录
  if (path.endsWith('/login')  && m === 'POST')   return send(await doLogin(body));
  // 当前用户
  if (path.endsWith('/me')     && m === 'GET')  {
    const [u,e] = requireAuth(h); if (e) return send(e);
    return send(ok({ user: u }));
  }
  // 用户列表 / 新建用户
  if (path.endsWith('/users')  && m === 'GET')  { const [u,e]=requireAdmin(h); if(e) return send(e); return send(await listUsers()); }
  if (path.endsWith('/users')  && m === 'POST') { const [u,e]=requireAdmin(h); if(e) return send(e); return send(await createUser(body,u)); }
  // 删除用户
  if (/\/users\/\d+$/.test(path) && m === 'DELETE') {
    const [u,e]=requireAdmin(h); if(e) return send(e);
    return send(await deleteUser(path.split('/').pop(), u));
  }
  // 皮肤列表
  if (path.endsWith('/skins')        && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listSkins(qs)); }
  // 更新皮肤
  if (/\/skins\/\d+$/.test(path)     && m === 'PUT')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await updateSkin(path.split('/').pop(),body,u)); }
  // 删除皮肤
  if (/\/skins\/\d+$/.test(path)     && m === 'DELETE') { const [u,e]=requireAuth(h); if(e) return send(e); return send(await deleteSkin(path.split('/').pop(),u)); }
  // 批量更新
  if (path.endsWith('/batch-update') && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await batchUpdate(body,u)); }
  // Excel 导入
  if (path.endsWith('/import')       && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await doImport(body,u)); }
  // 日志
  if (path.endsWith('/logs')         && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listLogs(qs)); }

  return send(fail('接口不存在', 404));
};

// ── 登录 ─────────────────────────────────────────────────────
async function doLogin({ username, password }) {
  if (!username || !password) return fail('请填写用户名和密码');
  const client = getClient();
  const { data, error } = await client.from('admin_users').select('*').eq('username', username).maybeSingle();
  if (error || !data) return fail('用户名或密码错误', 401);
  // pgcrypto 生成 $2a$，bcryptjs 期望 $2b$，算法相同转换前缀即可兼容
  const hashForCompare = data.password_hash.replace(/^\$2a\$/, "$2b$");
  const match = await bcrypt.compare(String(password), hashForCompare);
  if (!match) return fail('用户名或密码错误', 401);
  const token = jwt.sign(
    { username: data.username, display_name: data.display_name, role: data.role },
    JWT_SECRET, { expiresIn: '7d' }
  );
  return ok({ token, user: { username: data.username, display_name: data.display_name, role: data.role } });
}

// ── 用户管理 ─────────────────────────────────────────────────
async function listUsers() {
  const { data } = await getClient().from('admin_users').select('id,username,display_name,role,created_at').order('created_at');
  return ok({ users: data || [] });
}
async function createUser({ username, password, display_name, role }, operator) {
  if (!username || !password) return fail('用户名和密码不能为空');
  if (String(password).length < 6) return fail('密码至少6位');
  if (!['admin','editor'].includes(role)) return fail('角色不合法');
  const hash = await bcrypt.hash(String(password), 12);
  const client = getClient();
  const { data, error } = await client.from('admin_users')
    .insert({ username, password_hash: hash, display_name: display_name || username, role })
    .select().maybeSingle();
  if (error) return fail('创建失败，用户名可能已存在：' + error.message);
  await log(client, operator.username, 'create_user', null, { new_user: username });
  return ok({ user: data });
}
async function deleteUser(id, operator) {
  const client = getClient();
  await client.from('admin_users').delete().eq('id', id);
  await log(client, operator.username, 'delete_user', null, { user_id: id });
  return ok({ ok: true });
}

// ── 皮肤数据 ─────────────────────────────────────────────────
async function listSkins(params) {
  const page    = Math.max(1, parseInt(params.page    || '1'));
  const perPage = Math.min(200, parseInt(params.per_page || '50'));
  const offset  = (page - 1) * perPage;
  let q = getClient().from('skins').select('*', { count: 'exact' });
  if (params.hero)    q = q.eq('hero',    decodeURIComponent(params.hero));
  if (params.quality) q = q.eq('quality', decodeURIComponent(params.quality));
  if (params.type)    q = q.eq('type',    decodeURIComponent(params.type));
  if (params.search)  q = q.or(`name.ilike.%${decodeURIComponent(params.search)}%,hero.ilike.%${decodeURIComponent(params.search)}%`);
  q = q.order('date', { ascending: false }).range(offset, offset + perPage - 1);
  const { data, count, error } = await q;
  if (error) return fail(error.message);
  return ok({ skins: data || [], total: count || 0, page, per_page: perPage });
}
async function updateSkin(id, updates, user) {
  const ALLOWED = new Set(['date','name','quality','tag','hero','job','price','obtain','type','permanent']);
  const clean = Object.fromEntries(Object.entries(updates).filter(([k]) => ALLOWED.has(k)));
  if (!Object.keys(clean).length) return fail('没有可更新的字段');
  const client = getClient();
  const { data: before } = await client.from('skins').select('*').eq('id', id).maybeSingle();
  const { data, error } = await client.from('skins').update(clean).eq('id', id).select().maybeSingle();
  if (error) return fail(error.message);
  await log(client, user.username, 'update', parseInt(id), {
    before: Object.fromEntries(Object.keys(clean).map(k => [k, before?.[k]])),
    after:  clean,
  });
  return ok({ skin: data });
}
async function deleteSkin(id, user) {
  const client = getClient();
  const { data: before } = await client.from('skins').select('*').eq('id', id).maybeSingle();
  await client.from('skins').delete().eq('id', id);
  await log(client, user.username, 'delete', parseInt(id), { deleted: before });
  return ok({ ok: true });
}
async function batchUpdate({ ids, updates }, user) {
  if (!ids?.length || !updates) return fail('请提供 ids 和 updates');
  const ALLOWED = new Set(['quality','tag','hero','job','price','obtain','type','permanent']);
  const clean = Object.fromEntries(Object.entries(updates).filter(([k]) => ALLOWED.has(k)));
  if (!Object.keys(clean).length) return fail('没有可更新的字段');
  const client = getClient();
  const { data, error } = await client.from('skins').update(clean).in('id', ids).select();
  if (error) return fail(error.message);
  await log(client, user.username, 'batch_update', null, { ids, updates: clean });
  return ok({ updated: data?.length || 0 });
}

// ── 新增皮肤 ─────────────────────────────────────────────────
async function insertSkin(data, user) {
  const ALLOWED = new Set(['date','name','quality','tag','hero','job','price','obtain','type','permanent','skin_img_id','tag_img_id']);
  const clean = Object.fromEntries(Object.entries(data||{}).filter(([k]) => ALLOWED.has(k)));
  if (!clean.date || !clean.name || !clean.hero) return fail('日期、皮肤名称、归属英雄为必填项');
  const client = getClient();
  const { data: inserted, error } = await client.from('skins').insert(clean).select().maybeSingle();
  if (error) return fail(error.message);
  await log(client, user.username, 'insert', inserted?.id || null, { name: clean.name, hero: clean.hero });
  return ok({ skin: inserted });
}

// ── 上传图片 ─────────────────────────────────────────────────
async function uploadImage({ img_id, img_type, data, mime_type }, user) {
  if (!img_id || !data || !mime_type) return fail('缺少必要字段');
  if (!['skin','tag'].includes(img_type)) return fail('img_type 只能是 skin 或 tag');
  const client = getClient();
  const { error } = await client.from('images')
    .upsert({ img_id, img_type, data, mime_type }, { onConflict: 'img_id' });
  if (error) return fail(error.message);
  return ok({ img_id });
}

// ── 日志 ─────────────────────────────────────────────────────
async function listLogs(params) {
  const perPage = parseInt(params.per_page || '50');
  const { data } = await getClient().from('audit_log')
    .select('*').order('created_at', { ascending: false }).limit(perPage);
  return ok({ logs: data || [] });
}

// ── Excel 导入 ───────────────────────────────────────────────
async function doImport({ file_b64, mode = 'append' }, user) {
  if (!file_b64) return fail('请提供 file_b64');
  let records;
  try {
    const buf = Buffer.from(file_b64, 'base64');
    records = parseExcel(buf);
  } catch (e) {
    return fail('Excel 解析失败：' + e.message);
  }
  const client = getClient();
  const BATCH  = 100;
  let inserted = 0, skipped = 0;

  if (mode === 'overwrite') {
    await client.from('skins').delete().neq('id', 0);
    for (let i = 0; i < records.length; i += BATCH)
      await client.from('skins').insert(records.slice(i, i + BATCH));
    inserted = records.length;
  } else {
    const { data: existing } = await client.from('skins').select('hero,name,date,type');
    const keys = new Set((existing || []).map(r => `${r.hero}|${r.name}|${r.date}|${r.type}`));
    const newR = records.filter(r => !keys.has(`${r.hero}|${r.name}|${r.date}|${r.type}`));
    for (let i = 0; i < newR.length; i += BATCH)
      await client.from('skins').insert(newR.slice(i, i + BATCH));
    inserted = newR.length;
    skipped  = records.length - newR.length;
  }
  await log(client, user.username, 'import', null, { mode, total: records.length, inserted, skipped });
  return ok({ inserted, skipped, images: 0 });
}

function parseExcel(buf) {
  const XLSX = require('xlsx');
  const wb   = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const fmtDate = v => {
    if (!v) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).slice(0, 10);
  };
  const extractId = v => { const m = String(v||'').match(/ID_([A-Fa-f0-9]+)/); return m ? m[1] : ''; };
  const safe = (v, d='') => { const s = String(v??'').trim(); return ['undefined','null','nan'].includes(s.toLowerCase()) ? d : s; };

  return rows.map(r => ({
    date:        fmtDate(r['日期']),
    name:        safe(r['皮肤名称']),
    quality:     safe(r['皮肤品质']),
    tag:         safe(r['皮肤标签']),
    hero:        safe(r['归属英雄']),
    job:         safe(r['英雄职业']),
    price:       safe(r['价格']),
    obtain:      safe(r['获取方式']),
    type:        safe(r['首发or返场']),
    permanent:   safe(r['是否常驻'], '否'),
    skin_img_id: extractId(r['皮肤图片']),
    tag_img_id:  extractId(r['皮肤品质图片']),
  })).filter(r => r.name && r.hero && r.date);
}
