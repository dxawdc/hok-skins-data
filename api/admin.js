// api/admin.js  —  Vercel Node.js Serverless Function
// 处理所有后台请求：登录、数据编辑、Excel 导入

const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const JWT_SECRET   = process.env.JWT_SECRET || 'change-me';

function getClient() {
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ── CORS headers ─────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

function ok(data, status = 200) {
  return { statusCode: status, headers: CORS, body: JSON.stringify(data) };
}
function err(msg, status = 400) {
  return { statusCode: status, headers: CORS, body: JSON.stringify({ error: msg }) };
}

// ── JWT ──────────────────────────────────────────────────────
function verifyToken(headers) {
  const auth = headers['authorization'] || headers['Authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(auth.slice(7), JWT_SECRET);
  } catch {
    return null;
  }
}
function requireAuth(headers) {
  const user = verifyToken(headers);
  if (!user) return [null, err('未登录或登录已过期', 401)];
  return [user, null];
}
function requireAdmin(headers) {
  const [user, e] = requireAuth(headers);
  if (e) return [null, e];
  if (user.role !== 'admin') return [null, err('需要管理员权限', 403)];
  return [user, null];
}

// ── 日志 ─────────────────────────────────────────────────────
async function writeLog(client, operator, action, targetId, detail) {
  try {
    await client.from('audit_log').insert({ operator, action, target_id: targetId, detail });
  } catch {}
}

// ── 主路由 ───────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // 统一设置 CORS
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // 解析 body
  let body = {};
  if (req.body) {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }

  const path    = req.url.split('?')[0];
  const qs      = Object.fromEntries(new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : ''));
  const headers = req.headers;
  const method  = req.method;

  function send(result) {
    res.status(result.statusCode).json(JSON.parse(result.body));
  }

  // ── POST /api/admin/login
  if (path.endsWith('/login') && method === 'POST') {
    return send(await handleLogin(body));
  }

  // ── GET /api/admin/me
  if (path.endsWith('/me') && method === 'GET') {
    const [user, e] = requireAuth(headers);
    if (e) return send(e);
    return send(ok({ user }));
  }

  // ── Users (admin only)
  if (path.endsWith('/users')) {
    if (method === 'GET')  { const [u,e]=requireAdmin(headers); if(e) return send(e); return send(await listUsers()); }
    if (method === 'POST') { const [u,e]=requireAdmin(headers); if(e) return send(e); return send(await createUser(body, u)); }
  }
  if (path.match(/\/users\/\d+$/) && method === 'DELETE') {
    const [u,e]=requireAdmin(headers); if(e) return send(e);
    return send(await deleteUser(path.split('/').pop(), u));
  }

  // ── Skins
  if (path.endsWith('/skins') && method === 'GET') {
    const [u,e]=requireAuth(headers); if(e) return send(e);
    return send(await listSkins(qs));
  }
  if (path.match(/\/skins\/\d+$/) && method === 'PUT') {
    const [u,e]=requireAuth(headers); if(e) return send(e);
    return send(await updateSkin(path.split('/').pop(), body, u));
  }
  if (path.match(/\/skins\/\d+$/) && method === 'DELETE') {
    const [u,e]=requireAuth(headers); if(e) return send(e);
    return send(await deleteSkin(path.split('/').pop(), u));
  }
  if (path.endsWith('/batch-update') && method === 'POST') {
    const [u,e]=requireAuth(headers); if(e) return send(e);
    return send(await batchUpdate(body, u));
  }

  // ── Excel Import
  if (path.endsWith('/import') && method === 'POST') {
    const [u,e]=requireAuth(headers); if(e) return send(e);
    return send(await handleImport(body, u));
  }

  // ── Logs
  if (path.endsWith('/logs') && method === 'GET') {
    const [u,e]=requireAuth(headers); if(e) return send(e);
    return send(await listLogs(qs));
  }

  return send(err('接口不存在', 404));
};

// ── 登录 ─────────────────────────────────────────────────────
async function handleLogin({ username, password }) {
  if (!username || !password) return err('请填写用户名和密码');
  const client = getClient();
  const { data } = await client.from('admin_users').select('*').eq('username', username).single();
  if (!data) return err('用户名或密码错误', 401);
  const match = await bcrypt.compare(password, data.password_hash);
  if (!match) return err('用户名或密码错误', 401);
  const token = jwt.sign(
    { username: data.username, display_name: data.display_name, role: data.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  return ok({ token, user: { username: data.username, display_name: data.display_name, role: data.role } });
}

// ── 用户管理 ─────────────────────────────────────────────────
async function listUsers() {
  const { data } = await getClient().from('admin_users').select('id,username,display_name,role,created_at');
  return ok({ users: data || [] });
}
async function createUser({ username, password, display_name, role }, operator) {
  if (!username || !password) return err('用户名和密码不能为空');
  if (password.length < 6) return err('密码至少6位');
  if (!['admin','editor'].includes(role)) return err('角色不合法');
  const hash = await bcrypt.hash(password, 12);
  const client = getClient();
  const { data, error } = await client.from('admin_users')
    .insert({ username, password_hash: hash, display_name: display_name || username, role })
    .select().single();
  if (error) return err('创建失败，用户名可能已存在');
  await writeLog(client, operator.username, 'create_user', null, { new_user: username });
  return ok({ user: data });
}
async function deleteUser(id, operator) {
  const client = getClient();
  await client.from('admin_users').delete().eq('id', id);
  await writeLog(client, operator.username, 'delete_user', null, { user_id: id });
  return ok({ ok: true });
}

// ── 皮肤数据 ─────────────────────────────────────────────────
async function listSkins(params) {
  const client = getClient();
  const page    = parseInt(params.page || '1');
  const perPage = parseInt(params.per_page || '50');
  const offset  = (page - 1) * perPage;

  let q = client.from('skins').select('*', { count: 'exact' });
  if (params.hero)    q = q.eq('hero', params.hero);
  if (params.quality) q = q.eq('quality', params.quality);
  if (params.type)    q = q.eq('type', params.type);
  if (params.search)  q = q.or(`name.ilike.%${params.search}%,hero.ilike.%${params.search}%`);
  q = q.order('date', { ascending: false }).range(offset, offset + perPage - 1);

  const { data, count, error } = await q;
  if (error) return err(error.message);
  return ok({ skins: data || [], total: count || 0, page, per_page: perPage });
}
async function updateSkin(id, updates, user) {
  const allowed = new Set(['date','name','quality','tag','hero','job','price','obtain','type','permanent']);
  const clean = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.has(k)));
  if (!Object.keys(clean).length) return err('没有可更新的字段');
  const client = getClient();
  const { data: before } = await client.from('skins').select('*').eq('id', id).single();
  const { data, error } = await client.from('skins').update(clean).eq('id', id).select().single();
  if (error) return err(error.message);
  await writeLog(client, user.username, 'update', parseInt(id), {
    before: Object.fromEntries(Object.keys(clean).map(k => [k, before?.[k]])),
    after: clean,
  });
  return ok({ skin: data });
}
async function deleteSkin(id, user) {
  const client = getClient();
  const { data: before } = await client.from('skins').select('*').eq('id', id).single();
  await client.from('skins').delete().eq('id', id);
  await writeLog(client, user.username, 'delete', parseInt(id), { deleted: before });
  return ok({ ok: true });
}
async function batchUpdate({ ids, updates }, user) {
  if (!ids?.length || !updates) return err('请提供 ids 和 updates');
  const allowed = new Set(['quality','tag','hero','job','price','obtain','type','permanent']);
  const clean = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.has(k)));
  if (!Object.keys(clean).length) return err('没有可更新的字段');
  const client = getClient();
  const { data, error } = await client.from('skins').update(clean).in('id', ids).select();
  if (error) return err(error.message);
  await writeLog(client, user.username, 'batch_update', null, { ids, updates: clean });
  return ok({ updated: data?.length || 0 });
}

// ── 日志查询 ─────────────────────────────────────────────────
async function listLogs(params) {
  const perPage = parseInt(params.per_page || '50');
  const { data } = await getClient().from('audit_log')
    .select('*').order('created_at', { ascending: false }).limit(perPage);
  return ok({ logs: data || [] });
}

// ── Excel 导入 ───────────────────────────────────────────────
async function handleImport({ file_b64, mode = 'append' }, user) {
  if (!file_b64) return err('请提供 file_b64');

  let records, imgRecords;
  try {
    const buf = Buffer.from(file_b64, 'base64');
    ({ records, imgRecords } = parseExcel(buf));
  } catch (e) {
    return err('Excel 解析失败：' + e.message);
  }

  const client = getClient();
  const BATCH = 50;

  // 上传图片
  for (let i = 0; i < imgRecords.length; i += BATCH) {
    await client.from('images').upsert(imgRecords.slice(i, i + BATCH), { onConflict: 'img_id' });
  }

  let inserted = 0, skipped = 0;
  if (mode === 'overwrite') {
    await client.from('skins').delete().neq('id', 0);
    for (let i = 0; i < records.length; i += BATCH) {
      await client.from('skins').insert(records.slice(i, i + BATCH));
    }
    inserted = records.length;
  } else {
    const { data: existing } = await client.from('skins').select('hero,name,date,type');
    const keys = new Set((existing || []).map(r => `${r.hero}|${r.name}|${r.date}|${r.type}`));
    const newRecs = records.filter(r => !keys.has(`${r.hero}|${r.name}|${r.date}|${r.type}`));
    for (let i = 0; i < newRecs.length; i += BATCH) {
      await client.from('skins').insert(newRecs.slice(i, i + BATCH));
    }
    inserted = newRecs.length;
    skipped  = records.length - newRecs.length;
  }

  await writeLog(client, user.username, 'import', null, { mode, total: records.length, inserted, skipped });
  return ok({ inserted, skipped, images: imgRecords.length });
}

// ── Excel 解析（纯 JS，用 xlsx 库）──────────────────────────
function parseExcel(buf) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  function fmtDate(val) {
    if (!val) return '';
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    return String(val).slice(0, 10);
  }
  function extractId(val) {
    if (!val) return '';
    const m = String(val).match(/ID_([A-Fa-f0-9]+)/);
    return m ? m[1] : '';
  }
  function safe(val, def = '') {
    const s = String(val ?? '').trim();
    return (s === 'undefined' || s === 'null') ? def : s;
  }

  const records = rows.map(r => ({
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
  })).filter(r => r.name && r.hero);

  // xlsx 库不能提取嵌入图片，图片部分留空（不影响文字数据导入）
  // 图片已在初始化时通过 Python 脚本一次性导入到数据库
  const imgRecords = [];

  return { records, imgRecords };
}
