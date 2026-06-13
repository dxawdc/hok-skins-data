// api/admin.js — Vercel Node.js Serverless Function

const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

const SUPABASE_URL = process.env.SUPABASE_URL        || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const JWT_SECRET   = process.env.JWT_SECRET           || 'change-me';

// Storage bucket 名称，需在 Supabase 控制台提前创建并设为 Public
const BUCKET = 'skin-images';
const OLD_COMPANION_QUALITY = '\u4f34\u751f';
const QUALITY_OTHER = '\u5176\u4ed6';
const TYPE_FIRST = '\u9996\u53d1';
const TYPE_RETURN = '\u8fd4\u573a';
const PERMANENT_NO = '\u5426';
const SKIN_SELECT = '*, skin_profiles:skin_profile_id(*, skin_profile_series(series:series_id(*)))';

function normalizeQuality(q) {
  return q === OLD_COMPANION_QUALITY ? QUALITY_OTHER : q;
}

function normalizeSkinRecord(row) {
  return flattenSkinRow(row);
}

function profileSeries(profile) {
  return (profile?.skin_profile_series || [])
    .map(item => item.series || item.skin_series || null)
    .filter(Boolean)
    .map(s => ({
      id: s.id,
      name: s.name,
      description: s.description || '',
      sort_order: s.sort_order || 0,
    }))
    .sort((a, b) => (a.sort_order - b.sort_order) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
}

function flattenSkinRow(row) {
  if (!row) return row;
  const profile = Array.isArray(row.skin_profiles) ? row.skin_profiles[0] : row.skin_profiles;
  if (!profile) return { ...row, quality: normalizeQuality(row.quality), series: [] };
  const flat = {
    ...row,
    skin_profile_id: row.skin_profile_id || profile.id || null,
    name: profile.name || row.name,
    hero: profile.hero || row.hero,
    hero_id: profile.hero_id || row.hero_id || null,
    quality: normalizeQuality(profile.quality || row.quality),
    tag: profile.tag ?? row.tag ?? '',
    permanent: profile.permanent || row.permanent || PERMANENT_NO,
    skin_img_url: profile.skin_img_url || row.skin_img_url || '',
    tag_img_url: profile.tag_img_url || row.tag_img_url || '',
    profile_notes: profile.notes || '',
    first_release_date: profile.first_release_date || null,
    notes: row.notes || profile.notes || '',
    series: profileSeries(profile),
  };
  delete flat.skin_profiles;
  return flat;
}

async function syncSkinHeroName(client, clean) {
  if (!clean || clean.hero_id === undefined || clean.hero_id === null || clean.hero_id === '') return;
  const { data } = await client
    .from('heroes')
    .select('name')
    .eq('id', parseInt(clean.hero_id))
    .maybeSingle();
  if (data?.name) clean.hero = data.name;
}

async function getHeroName(client, heroId) {
  if (!heroId) return '';
  const { data } = await client
    .from('heroes')
    .select('name')
    .eq('id', parseInt(heroId))
    .maybeSingle();
  return data?.name || '';
}

async function getSkinProfile(client, id) {
  if (!id) return null;
  let { data, error } = await client
    .from('skin_profiles')
    .select('*, skin_profile_series(series:series_id(*))')
    .eq('id', parseInt(id))
    .maybeSingle();
  if (error) {
    const fallback = await client
      .from('skin_profiles')
      .select('*')
      .eq('id', parseInt(id))
      .maybeSingle();
    data = fallback.data;
  }
  return data || null;
}

async function findSkinProfile(client, data) {
  if (data.skin_profile_id) return getSkinProfile(client, data.skin_profile_id);
  if (!data.hero_id || !data.name) return null;
  let { data: profile, error } = await client
    .from('skin_profiles')
    .select('*, skin_profile_series(series:series_id(*))')
    .eq('hero_id', parseInt(data.hero_id))
    .eq('name', data.name)
    .maybeSingle();
  if (error) {
    const fallback = await client
      .from('skin_profiles')
      .select('*')
      .eq('hero_id', parseInt(data.hero_id))
      .eq('name', data.name)
      .maybeSingle();
    profile = fallback.data;
  }
  return profile || null;
}

async function upsertSkinProfile(client, data, existingId = null) {
  const heroId = data.hero_id ? parseInt(data.hero_id) : null;
  const heroName = data.hero || await getHeroName(client, heroId);
  const profile = {
    name: data.name,
    hero_id: heroId,
    hero: heroName,
    quality: normalizeQuality(data.quality) || QUALITY_OTHER,
    tag: data.tag || '',
    permanent: data.permanent || PERMANENT_NO,
    skin_img_url: data.skin_img_url || null,
    tag_img_url: data.tag_img_url || null,
    notes: data.notes || null,
  };
  if (data.date && data.type === TYPE_FIRST) profile.first_release_date = data.date;

  if (existingId) {
    const { data: updated, error } = await client
      .from('skin_profiles')
      .update(profile)
      .eq('id', parseInt(existingId))
      .select()
      .maybeSingle();
    if (error) throw error;
    return updated;
  }

  const { data: upserted, error } = await client
    .from('skin_profiles')
    .upsert(profile, { onConflict: 'hero_id,name' })
    .select()
    .maybeSingle();
  if (error) throw error;
  return upserted;
}

function normalizeSeriesIds(value) {
  if (value === undefined || value === null || value === '') return null;
  const arr = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(arr.map(v => parseInt(v, 10)).filter(Number.isFinite))];
}

async function syncProfileSeries(client, profileId, seriesIds) {
  if (!profileId || seriesIds === null) return;
  const id = parseInt(profileId, 10);
  const { error: deleteError } = await client
    .from('skin_profile_series')
    .delete()
    .eq('skin_profile_id', id);
  if (deleteError) throw deleteError;
  if (!seriesIds.length) return;
  const rows = seriesIds.map(seriesId => ({ skin_profile_id: id, series_id: seriesId }));
  const { error } = await client.from('skin_profile_series').insert(rows);
  if (error) throw error;
}

function legacyFieldsFromProfile(profile) {
  return {
    name: profile.name,
    hero: profile.hero,
    hero_id: profile.hero_id,
    quality: normalizeQuality(profile.quality) || QUALITY_OTHER,
    tag: profile.tag || '',
    permanent: profile.permanent || PERMANENT_NO,
    skin_img_url: profile.skin_img_url || null,
    tag_img_url: profile.tag_img_url || null,
  };
}

function getClient() {
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

async function fetchAllSkinRows(client, select = SKIN_SELECT) {
  const rows = [];
  const pageSize = 1000;
  const load = async (selectExpr) => {
    const out = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await client
        .from('skins')
        .select(selectExpr)
        .order('date', { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    return out;
  };
  try {
    rows.push(...await load(select));
  } catch (error) {
    if (select !== SKIN_SELECT) throw error;
    rows.push(...await load('*, skin_profiles:skin_profile_id(*)'));
  }
  return rows;
}

// ── CORS ──────────────────────────────────────────────────────
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
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

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

  if (path.endsWith('/login')        && m === 'POST')   return send(await doLogin(body));
  if (path.endsWith('/me')           && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(ok({ user: u })); }
  if (path.endsWith('/users')        && m === 'GET')    { const [u,e]=requireAdmin(h); if(e) return send(e); return send(await listUsers()); }
  if (path.endsWith('/users')        && m === 'POST')   { const [u,e]=requireAdmin(h); if(e) return send(e); return send(await createUser(body,u)); }
  if (/\/users\/\d+$/.test(path)     && m === 'DELETE') { const [u,e]=requireAdmin(h); if(e) return send(e); return send(await deleteUser(path.split('/').pop(),u)); }
  if (path.endsWith('/skin-profiles') && m === 'GET')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listSkinProfiles(qs)); }
  if (path.endsWith('/series')       && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listSeries(qs)); }
  if (path.endsWith('/series')       && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await upsertSeries(body,u)); }
  if (/\/series\/\d+$/.test(path)    && m === 'PUT')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await upsertSeries({ ...body, id: path.split('/').pop() },u)); }
  if (/\/series\/\d+$/.test(path)    && m === 'DELETE') { const [u,e]=requireAuth(h); if(e) return send(e); return send(await deleteSeries(path.split('/').pop(),u)); }
  if (path.endsWith('/skins')        && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listSkins(qs)); }
  if (path.endsWith('/skins')        && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await insertSkin(body,u)); }
  if (/\/skins\/\d+$/.test(path)     && m === 'PUT')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await updateSkin(path.split('/').pop(),body,u)); }
  if (/\/skins\/\d+$/.test(path)     && m === 'DELETE') { const [u,e]=requireAuth(h); if(e) return send(e); return send(await deleteSkin(path.split('/').pop(),u)); }
  if (path.endsWith('/batch-update') && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await batchUpdate(body,u)); }
  if (path.endsWith('/images')       && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await uploadImage(body,u)); }
  if (path.endsWith('/images')       && m === 'DELETE') { const [u,e]=requireAuth(h); if(e) return send(e); return send(await deleteImage(body,u)); }
  if (path.endsWith('/import')       && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await doImport(body,u)); }
  if (path.endsWith('/logs')         && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listLogs(qs)); }

  if (path.endsWith('/heroes')            && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listHeroes(qs)); }
  if (path.endsWith('/heroes')            && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await insertHero(body,u)); }
  if (/\/heroes\/\d+$/.test(path)         && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await getHero(path.split('/').pop())); }
  if (/\/heroes\/\d+$/.test(path)         && m === 'PUT')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await updateHero(path.split('/').pop(),body,u)); }
  if (/\/heroes\/\d+$/.test(path)         && m === 'DELETE') { const [u,e]=requireAuth(h); if(e) return send(e); return send(await deleteHero(path.split('/').pop(),u)); }
  if (/\/heroes\/\d+\/skins$/.test(path)  && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listHeroSkins(path.split('/').slice(-2)[0])); }

  if (path.endsWith('/resources')          && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listResources(qs)); }
  if (path.endsWith('/resources')          && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await insertResource(body,u)); }
  if (/\/resources\/\d+$/.test(path)       && m === 'PUT')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await updateResource(path.split('/').pop(),body,u)); }
  if (/\/resources\/\d+$/.test(path)       && m === 'DELETE') { const [u,e]=requireAuth(h); if(e) return send(e); return send(await deleteResource(path.split('/').pop(),u)); }

  return send(fail('接口不存在', 404));
};

// ── 登录 ─────────────────────────────────────────────────────
async function doLogin({ username, password }) {
  if (!username || !password) return fail('请填写用户名和密码');
  const client = getClient();
  const { data, error } = await client.from('admin_users').select('*').eq('username', username).maybeSingle();
  if (error || !data) return fail('用户名或密码错误', 401);
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
  const client = getClient();
  let data;
  try {
    data = await fetchAllSkinRows(client);
  } catch (e) {
    return fail(e.message);
  }

  let rows = (data || []).map(normalizeSkinRecord);
  if (params.hero) {
    const hero = decodeURIComponent(params.hero);
    rows = rows.filter(r => r.hero === hero);
  }
  if (params.quality) {
    const quality = decodeURIComponent(params.quality);
    rows = rows.filter(r => normalizeQuality(r.quality) === normalizeQuality(quality));
  }
  if (params.type) {
    const type = decodeURIComponent(params.type);
    rows = rows.filter(r => r.type === type);
  }
  if (params.search) {
    const search = decodeURIComponent(params.search).toLowerCase();
    rows = rows.filter(r =>
      String(r.name || '').toLowerCase().includes(search) ||
      String(r.hero || '').toLowerCase().includes(search)
    );
  }
  const total = rows.length;
  return ok({ skins: rows.slice(offset, offset + perPage), total, page, per_page: perPage });
}

async function listSkinProfiles(params) {
  const perPage = Math.min(1000, parseInt(params.per_page || '1000'));
  const search = params.search ? decodeURIComponent(params.search).toLowerCase() : '';
  const load = async (select) => getClient()
    .from('skin_profiles')
    .select(select)
    .order('first_release_date', { ascending: false, nullsFirst: false })
    .limit(perPage);
  let { data, error } = await load('*, skin_profile_series(series:series_id(*))');
  if (error) {
    const fallback = await load('*');
    data = fallback.data;
    error = fallback.error;
  }
  if (error) return fail(error.message);
  let profiles = (data || []).map(p => ({ ...p, quality: normalizeQuality(p.quality), series: profileSeries(p) }));
  if (search) {
    profiles = profiles.filter(p =>
      String(p.name || '').toLowerCase().includes(search) ||
      String(p.hero || '').toLowerCase().includes(search)
    );
  }
  return ok({ profiles, total: profiles.length });
}

async function listSeries(params) {
  const search = params.search ? decodeURIComponent(params.search).toLowerCase() : '';
  const { data, error } = await getClient()
    .from('skin_series')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) return fail(error.message);
  let series = data || [];
  if (search) {
    series = series.filter(s =>
      String(s.name || '').toLowerCase().includes(search) ||
      String(s.description || '').toLowerCase().includes(search)
    );
  }
  return ok({ series, total: series.length });
}

async function upsertSeries(data, user) {
  const clean = {
    name: String(data?.name || '').trim(),
    description: data?.description ? String(data.description).trim() : null,
    sort_order: Number.isFinite(parseInt(data?.sort_order, 10)) ? parseInt(data.sort_order, 10) : 0,
  };
  if (!clean.name) return fail('套系名称不能为空');
  const client = getClient();
  let saved;
  if (data?.id) {
    const { data: row, error } = await client
      .from('skin_series')
      .update(clean)
      .eq('id', parseInt(data.id, 10))
      .select()
      .maybeSingle();
    if (error) return fail(error.message);
    saved = row;
  } else {
    const { data: row, error } = await client
      .from('skin_series')
      .upsert(clean, { onConflict: 'name' })
      .select()
      .maybeSingle();
    if (error) return fail(error.message);
    saved = row;
  }
  await log(client, user.username, data?.id ? 'update_series' : 'insert_series', saved?.id || null, clean);
  return ok({ series: saved });
}

async function deleteSeries(id, user) {
  const client = getClient();
  const { data: before } = await client.from('skin_series').select('*').eq('id', id).maybeSingle();
  const { error } = await client.from('skin_series').delete().eq('id', id);
  if (error) return fail(error.message);
  await log(client, user.username, 'delete_series', parseInt(id, 10), { deleted: before });
  return ok({ ok: true });
}

async function updateSkin(id, updates, user) {
  const ALLOWED = new Set(['date','name','quality','tag','hero','price','obtain','type','permanent','skin_img_url','tag_img_url','hero_id','notes','skin_profile_id','series_ids']);
  const clean = Object.fromEntries(Object.entries(updates).filter(([k]) => ALLOWED.has(k)));
  if (clean.quality) clean.quality = normalizeQuality(clean.quality);
  const seriesIds = normalizeSeriesIds(clean.series_ids);
  delete clean.series_ids;
  if (!Object.keys(clean).length && seriesIds === null) return fail('没有可更新的字段');
  const client = getClient();
  await syncSkinHeroName(client, clean);
  const { data: before } = await client
    .from('skins')
    .select(SKIN_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (!before) return fail('记录不存在', 404);

  const targetType = clean.type || before.type;
  let profile = null;
  if (targetType === TYPE_RETURN) {
    profile = await findSkinProfile(client, clean) || before.skin_profiles;
    if (!profile) return fail('返场记录必须选择已有皮肤资料');
  } else {
    try {
      profile = await upsertSkinProfile(client, { ...flattenSkinRow(before), ...clean }, before.skin_profile_id);
    } catch (e) {
      return fail('皮肤资料保存失败：' + e.message);
    }
  }
  try {
    await syncProfileSeries(client, profile.id, seriesIds);
  } catch (e) {
    return fail('皮肤套系保存失败：' + e.message);
  }

  const event = {
    date: clean.date ?? before.date,
    price: clean.price ?? before.price ?? '',
    obtain: clean.obtain ?? before.obtain ?? '',
    type: targetType,
    skin_profile_id: profile.id,
    notes: targetType === TYPE_RETURN ? (clean.notes ?? before.notes ?? null) : null,
    ...legacyFieldsFromProfile(profile),
  };
  const { data, error } = await client
    .from('skins')
    .update(event)
    .eq('id', id)
    .select(SKIN_SELECT)
    .maybeSingle();
  if (error) return fail(error.message);
  await log(client, user.username, 'update', parseInt(id), {
    before: flattenSkinRow(before),
    after:  clean,
  });
  return ok({ skin: normalizeSkinRecord(data) });
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
  const ALLOWED = new Set(['quality','tag','hero','price','obtain','type','permanent','hero_id','notes']);
  const clean = Object.fromEntries(Object.entries(updates).filter(([k]) => ALLOWED.has(k)));
  if (clean.quality) clean.quality = normalizeQuality(clean.quality);
  if (!Object.keys(clean).length) return fail('没有可更新的字段');
  const client = getClient();
  await syncSkinHeroName(client, clean);

  const profileUpdates = Object.fromEntries(
    Object.entries(clean).filter(([k]) => ['quality','tag','hero','hero_id','permanent'].includes(k))
  );
  const eventUpdates = Object.fromEntries(
    Object.entries(clean).filter(([k]) => ['price','obtain','type','notes'].includes(k))
  );

  if (Object.keys(profileUpdates).length) {
    const { data: selected } = await client.from('skins').select('skin_profile_id').in('id', ids);
    const profileIds = [...new Set((selected || []).map(r => r.skin_profile_id).filter(Boolean))];
    if (profileIds.length) {
      const { error: profileError } = await client.from('skin_profiles').update(profileUpdates).in('id', profileIds);
      if (profileError) return fail(profileError.message);
    }
  }

  let updated = 0;
  if (Object.keys(eventUpdates).length) {
    const { data, error } = await client.from('skins').update(eventUpdates).in('id', ids).select();
    if (error) return fail(error.message);
    updated = data?.length || 0;
  } else {
    updated = ids.length;
  }
  await log(client, user.username, 'batch_update', null, { ids, updates: clean });
  return ok({ updated });
}

// ── 新增皮肤 ─────────────────────────────────────────────────
async function insertSkin(data, user) {
  const ALLOWED = new Set(['date','name','quality','tag','hero','price','obtain','type','permanent','skin_img_url','tag_img_url','hero_id','notes','skin_profile_id','series_ids']);
  const clean = Object.fromEntries(Object.entries(data||{}).filter(([k]) => ALLOWED.has(k)));
  if (clean.quality) clean.quality = normalizeQuality(clean.quality);
  const seriesIds = normalizeSeriesIds(clean.series_ids);
  delete clean.series_ids;
  const client = getClient();
  await syncSkinHeroName(client, clean);
  if (!clean.date) return fail('日期为必填项');

  let profile;
  if (clean.type === TYPE_RETURN) {
    profile = await findSkinProfile(client, clean);
    if (!profile) return fail('返场记录必须选择已有皮肤资料');
  } else {
    if (!clean.name || !clean.hero_id || !clean.hero) return fail('日期、皮肤名称、归属英雄为必填项');
    try {
      profile = await upsertSkinProfile(client, clean);
    } catch (e) {
      return fail('皮肤资料保存失败：' + e.message);
    }
  }
  try {
    await syncProfileSeries(client, profile.id, seriesIds);
  } catch (e) {
    return fail('皮肤套系保存失败：' + e.message);
  }

  const row = {
    date: clean.date,
    price: clean.price || '',
    obtain: clean.obtain || '',
    type: clean.type || TYPE_FIRST,
    skin_profile_id: profile.id,
    notes: clean.type === TYPE_RETURN ? (clean.notes || null) : null,
    ...legacyFieldsFromProfile(profile),
  };
  const { data: inserted, error } = await client
    .from('skins')
    .insert(row)
    .select(SKIN_SELECT)
    .maybeSingle();
  if (error) return fail(error.message);
  await log(client, user.username, 'insert', inserted?.id || null, { name: profile.name, hero: profile.hero, profile_id: profile.id });
  return ok({ skin: normalizeSkinRecord(inserted) });
}

async function resolveHeroIdByName(client, heroName) {
  if (!heroName) return null;
  const { data } = await client
    .from('heroes')
    .select('id')
    .eq('name', heroName)
    .maybeSingle();
  return data?.id || null;
}

async function insertImportedSkin(client, record) {
  const clean = { ...record };
  clean.quality = normalizeQuality(clean.quality);
  if (!clean.hero_id) clean.hero_id = await resolveHeroIdByName(client, clean.hero);
  let profile = await findSkinProfile(client, clean);
  if (!profile) profile = await upsertSkinProfile(client, clean);
  const row = {
    date: clean.date,
    price: clean.price || '',
    obtain: clean.obtain || '',
    type: clean.type || TYPE_FIRST,
    skin_profile_id: profile.id,
    notes: clean.type === TYPE_RETURN ? (clean.notes || null) : null,
    ...legacyFieldsFromProfile(profile),
  };
  const { error } = await client.from('skins').insert(row);
  if (error) throw error;
}

// ── 上传图片（改为 Supabase Storage，包含精确大小校验）────────────────────────
async function uploadImage({ img_id, img_type, data, mime_type }, user) {
  if (!img_id || !data || !mime_type) return fail('缺少必要字段');
  if (!['skin','tag','hero','resource'].includes(img_type)) return fail('img_type 只能是 skin、tag、hero 或 resource');

  // 去除前端可能附带的 Data URL 前缀 (如 data:image/png;base64,)
  const base64Data = data.replace(/^data:image\/\w+;base64,/, "");
  
  // base64 → Buffer
  const buffer = Buffer.from(base64Data, 'base64');

  // 大小校验：直接获取 Buffer 的真实字节数
  const MAX_BYTES = 400 * 1024; // 400KB
  if (buffer.byteLength > MAX_BYTES) {
    const currentKB = (buffer.byteLength / 1024).toFixed(1);
    return fail(`图片过大（当前 ${currentKB}KB），请压缩至 400KB 以内后重新上传`);
  }

  const client = getClient();

  // 文件扩展名
  const ext = mime_type.split('/')[1]?.replace('jpeg','jpg') || 'png';
  // Storage 路径：skin/abc123.png 或 tag/abc123.png
  const storagePath = `${img_type}/${img_id}.${ext}`;

  // 上传到 Supabase Storage（upsert 模式，重复上传覆盖）
  const { error: uploadError } = await client.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      contentType: mime_type,
      upsert: true,
    });

  if (uploadError) return fail('Storage 上传失败：' + uploadError.message);

  // 获取永久公开 URL（无需鉴权，CDN 直接访问）
  const { data: urlData } = client.storage
    .from(BUCKET)
    .getPublicUrl(storagePath);

  const publicUrl = urlData.publicUrl;

  await log(client, user.username, 'upload_image', null, { img_id, img_type, url: publicUrl });

  // 返回 img_id 和公开 URL，前端拿到 URL 后存入对应皮肤记录
  return ok({ img_id, url: publicUrl });
}

// ── 删除 Storage 图片 ────────────────────────────────────────
async function deleteImage({ img_id, img_type, ext = 'png' }, user) {
  if (!img_id || !img_type) return fail('缺少 img_id 或 img_type');
  const client = getClient();
  const storagePath = `${img_type}/${img_id}.${ext}`;
  const { error } = await client.storage.from(BUCKET).remove([storagePath]);
  if (error) return fail('删除失败：' + error.message);
  await log(client, user.username, 'delete_image', null, { img_id, img_type });
  return ok({ ok: true });
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
    await client.from('skin_profiles').delete().neq('id', 0);
    for (const record of records) {
      await insertImportedSkin(client, record);
    }
    inserted = records.length;
  } else {
    const { data: existing } = await client.from('skins').select('hero,name,date,type');
    const keys = new Set((existing || []).map(r => `${r.hero}|${r.name}|${r.date}|${r.type}`));
    const newR = records.filter(r => !keys.has(`${r.hero}|${r.name}|${r.date}|${r.type}`));
    for (const record of newR) {
      await insertImportedSkin(client, record);
    }
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
  const safe = (v, d='') => { const s = String(v??'').trim(); return ['undefined','null','nan'].includes(s.toLowerCase()) ? d : s; };

  return rows.map(r => ({
    date:         fmtDate(r['日期']),
    name:         safe(r['皮肤名称']),
    quality:      normalizeQuality(safe(r['皮肤品质'])),
    tag:          safe(r['皮肤标签']),
    hero:         safe(r['归属英雄']),
    job:          safe(r['英雄职业']),
    price:        safe(r['价格']),
    obtain:       safe(r['获取方式']),
    type:         safe(r['首发or返场']),
    permanent:    safe(r['是否常驻'], '否'),
    skin_img_url: safe(r['皮肤图片URL']),
    tag_img_url:  safe(r['标签图片URL']),
  })).filter(r => r.name && r.hero && r.date);
}
// ── 英雄列表 ─────────────────────────────────────────────────
async function listHeroes(params) {
  const page    = Math.max(1, parseInt(params.page     || '1'));
  const perPage = Math.min(200, parseInt(params.per_page || '100'));
  const offset  = (page - 1) * perPage;

  let q = getClient().from('heroes').select('*', { count: 'exact' });

  if (params.role)   q = q.contains('roles', [decodeURIComponent(params.role)]);
  if (params.lane)   q = q.contains('lanes', [decodeURIComponent(params.lane)]);
  if (params.gender) q = q.eq('gender', decodeURIComponent(params.gender));
  if (params.search) q = q.ilike('name', `%${decodeURIComponent(params.search)}%`);

  q = q.order('release_date', { ascending: true }).range(offset, offset + perPage - 1);
  const { data, count, error } = await q;
  if (error) return fail(error.message);
  return ok({ heroes: data || [], total: count || 0, page, per_page: perPage });
}

// ── 英雄详情（含皮肤数量统计）────────────────────────────────
async function getHero(id) {
  const client = getClient();
  const { data, error } = await client
    .from('heroes')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) return fail(error.message);
  if (!data)  return fail('英雄不存在', 404);

  const { count } = await client
    .from('skins')
    .select('*', { count: 'exact', head: true })
    .eq('hero_id', parseInt(id));

  return ok({ hero: { ...data, skin_count: count || 0 } });
}

// ── 新增英雄 ─────────────────────────────────────────────────
async function insertHero(data, user) {
  const ALLOWED = new Set(['name','gender','roles','lanes','release_date','avatar_url','is_available','notes']);
  const clean = Object.fromEntries(Object.entries(data || {}).filter(([k]) => ALLOWED.has(k)));
  if (!clean.name) return fail('英雄名称为必填项');

  const client = getClient();
  const { data: inserted, error } = await client
    .from('heroes').insert(clean).select().maybeSingle();
  if (error) return fail('创建失败：' + error.message);
  await log(client, user.username, 'hero_insert', inserted?.id || null, { name: clean.name });
  return ok({ hero: inserted });
}

// ── 编辑英雄 ─────────────────────────────────────────────────
async function updateHero(id, updates, user) {
  const ALLOWED = new Set(['name','gender','roles','lanes','release_date','avatar_url','is_available','notes']);
  const clean = Object.fromEntries(Object.entries(updates).filter(([k]) => ALLOWED.has(k)));
  if (!Object.keys(clean).length) return fail('没有可更新的字段');

  const client = getClient();
  const { data: before } = await client.from('heroes').select('*').eq('id', id).maybeSingle();
  const { data, error } = await client
    .from('heroes').update(clean).eq('id', id).select().maybeSingle();
  if (error) return fail(error.message);
  await log(client, user.username, 'hero_update', parseInt(id), {
    before: Object.fromEntries(Object.keys(clean).map(k => [k, before?.[k]])),
    after:  clean,
  });
  return ok({ hero: data });
}

// ── 删除英雄 ─────────────────────────────────────────────────
async function deleteHero(id, user) {
  const client = getClient();
  const { data: before } = await client.from('heroes').select('*').eq('id', id).maybeSingle();
  await client.from('heroes').delete().eq('id', id);
  await log(client, user.username, 'hero_delete', parseInt(id), { deleted: before });
  return ok({ ok: true });
}

// ── 某英雄的所有皮肤 ──────────────────────────────────────────
async function listHeroSkins(heroId) {
  const { data, error } = await getClient()
    .from('skins')
    .select('*, skin_profiles:skin_profile_id(*)')
    .eq('hero_id', parseInt(heroId))
    .order('date', { ascending: false });
  if (error) return fail(error.message);
  const skins = (data || []).map(normalizeSkinRecord);
  return ok({ skins, total: skins.length });
}

// ── 资源列表 ─────────────────────────────────────────────────
async function listResources(params) {
  const page    = Math.max(1, parseInt(params.page     || '1'));
  const perPage = Math.min(200, parseInt(params.per_page || '100'));
  const offset  = (page - 1) * perPage;

  let q = getClient().from('resources').select('*', { count: 'exact' });
  if (params.type)   q = q.eq('type',   decodeURIComponent(params.type));
  if (params.search) q = q.ilike('name', `%${decodeURIComponent(params.search)}%`);

  q = q.order('date', { ascending: false }).range(offset, offset + perPage - 1);
  const { data, count, error } = await q;
  if (error) return fail(error.message);
  return ok({ resources: data || [], total: count || 0, page, per_page: perPage });
}

// ── 新增资源 ─────────────────────────────────────────────────
async function insertResource(data, user) {
  const ALLOWED = new Set(['type','name','quality','tag','tag_img_url','collab','obtain','price','release_type','permanent','date','img_url','notes','is_available']);
  const clean = Object.fromEntries(Object.entries(data || {}).filter(([k]) => ALLOWED.has(k)));
  if (!clean.type) return fail('资源类型为必填项');
  if (!clean.name) return fail('资源名称为必填项');
  if (!clean.date) return fail('上线日期为必填项');
  if (!['天幕','小兵'].includes(clean.type)) return fail('type 只能是 天幕 或 小兵');

  const client = getClient();
  const { data: inserted, error } = await client
    .from('resources').insert(clean).select().maybeSingle();
  if (error) return fail('创建失败：' + error.message);
  await log(client, user.username, 'resource_insert', inserted?.id || null, { name: clean.name, type: clean.type });
  return ok({ resource: inserted });
}

// ── 编辑资源 ─────────────────────────────────────────────────
async function updateResource(id, updates, user) {
  const ALLOWED = new Set(['type','name','quality','tag','tag_img_url','collab','obtain','price','release_type','permanent','date','img_url','notes','is_available']);
  const clean = Object.fromEntries(Object.entries(updates).filter(([k]) => ALLOWED.has(k)));
  if (!Object.keys(clean).length) return fail('没有可更新的字段');

  const client = getClient();
  const { data: before } = await client.from('resources').select('*').eq('id', id).maybeSingle();
  const { data, error } = await client
    .from('resources').update(clean).eq('id', id).select().maybeSingle();
  if (error) return fail(error.message);
  await log(client, user.username, 'resource_update', parseInt(id), {
    before: Object.fromEntries(Object.keys(clean).map(k => [k, before?.[k]])),
    after:  clean,
  });
  return ok({ resource: data });
}

// ── 删除资源 ─────────────────────────────────────────────────
async function deleteResource(id, user) {
  const client = getClient();
  const { data: before } = await client.from('resources').select('*').eq('id', id).maybeSingle();
  await client.from('resources').delete().eq('id', id);
  await log(client, user.username, 'resource_delete', parseInt(id), { deleted: before });
  return ok({ ok: true });
}
