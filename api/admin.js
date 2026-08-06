// api/admin.js — Vercel Node.js Serverless Function

const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

const SUPABASE_URL = process.env.SUPABASE_URL        || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// JWT 签名密钥：绝不允许使用公开可知的默认值，否则任何人都能伪造管理员 token。
// - 生产环境（Vercel / NODE_ENV=production）缺失时直接抛错，拒绝以不安全的密钥启动。
// - 本地开发缺失时生成一次性随机密钥（重启失效），仅用于调试，不影响线上安全。
let JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET) {
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    throw new Error('未配置 JWT_SECRET 环境变量，拒绝以不安全的默认密钥启动后台');
  }
  JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
  console.warn('[admin] 未检测到 JWT_SECRET，已生成临时开发密钥（仅本地调试，重启即失效）');
}

// Storage bucket 名称，需在 Supabase 控制台提前创建并设为 Public
const BUCKET = 'skin-images';
const OLD_COMPANION_QUALITY = '\u4f34\u751f';
const QUALITY_OTHER = '\u5176\u4ed6';
const TYPE_FIRST = '\u9996\u53d1';
const TYPE_RETURN = '\u8fd4\u573a';
const PERMANENT_NO = '\u5426';
const SERIES_TYPES = new Set(['other', 'battle_pass', 'season_limited', 'zodiac_limited']);
const SERIES_TYPES_WITH_SUB_TAG = new Set(['battle_pass', 'season_limited', 'zodiac_limited']);
const SKIN_SELECT = '*, skin_profiles:skin_profile_id(*, skin_profile_series(sub_tag,sub_tag_sort,series:series_id(*)))';
const SPECIAL_RESOURCE_QUALITIES = new Set(['绿色', '蓝色', '紫色', '金色']);
const SPECIAL_RESOURCE_CONFIG = {
  star_legend: {
    table: 'star_legend_resources',
    label: '星传说·典藏',
    requiresSkin: true,
    fields: ['skin_profile_id','parent_resource_id','name','date','release_type','tag','obtain','price','permanent','img_url','tag_img_url','notes'],
    inheritedFields: ['skin_profile_id','name','tag','permanent','img_url','tag_img_url'],
  },
  star_outfit: {
    table: 'star_outfit_resources',
    label: '星元套装',
    requiresSkin: true,
    fields: ['skin_profile_id','parent_resource_id','name','date','release_type','obtain','price','img_url','notes'],
    inheritedFields: ['skin_profile_id','name','img_url'],
  },
  yuanliu_suit: {
    table: 'yuanliu_suit_resources',
    label: '元流套装',
    requiresSkin: false,
    fields: ['parent_resource_id','name','date','release_type','quality','tag','collab','obtain','price','permanent','img_url','tag_img_url','notes'],
    inheritedFields: ['name','quality','tag','collab','permanent','img_url','tag_img_url'],
  },
};

function normalizeQuality(q) {
  return q === OLD_COMPANION_QUALITY ? QUALITY_OTHER : q;
}

function normalizeSkinRecord(row) {
  return flattenSkinRow(row);
}

function profileSeries(profile) {
  return (profile?.skin_profile_series || [])
    .map(item => {
      const s = item.series || item.skin_series || null;
      if (!s) return null;
      return {
      id: s.id,
      name: s.name,
      description: s.description || '',
      sort_order: s.sort_order || 0,
      series_type: s.series_type || 'other',
      sub_tag: item.sub_tag || '',
      sub_tag_sort: item.sub_tag_sort || 0,
      };
    })
    .filter(Boolean)
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
    skin_value_points: profile.skin_value_points ?? null,
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
    .select('*, skin_profile_series(sub_tag,sub_tag_sort,series:series_id(*))')
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
    .select('*, skin_profile_series(sub_tag,sub_tag_sort,series:series_id(*))')
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
  // 皮肤价值点数：仅作为资料层数据，由首发记录维护；返场记录复用同一 profile 故自动继承
  if (data.skin_value_points !== undefined) {
    const v = data.skin_value_points;
    const n = Number(v);
    profile.skin_value_points = (v === '' || v === null || !Number.isFinite(n)) ? null : n;
  }

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

function normalizeSeriesLinks(value) {
  if (value === undefined || value === null || value === '') return null;
  const arr = Array.isArray(value) ? value : String(value).split(',');
  const links = new Map();
  arr.forEach(raw => {
    const item = raw && typeof raw === 'object' ? raw : { series_id: raw };
    const seriesId = parseInt(item.series_id ?? item.id, 10);
    if (!Number.isFinite(seriesId)) return;
    const hasSubTag = Object.prototype.hasOwnProperty.call(item, 'sub_tag');
    const hasSubTagSort = Object.prototype.hasOwnProperty.call(item, 'sub_tag_sort');
    links.set(seriesId, {
      series_id: seriesId,
      sub_tag: hasSubTag ? String(item.sub_tag || '').trim() : undefined,
      sub_tag_sort: hasSubTagSort ? Number(item.sub_tag_sort) : undefined,
    });
  });
  return [...links.values()];
}

function seriesNeedsSubTag(seriesType) {
  return SERIES_TYPES_WITH_SUB_TAG.has(seriesType);
}

async function syncProfileSeries(client, profileId, seriesLinks) {
  if (!profileId || seriesLinks === null) return;
  const id = parseInt(profileId, 10);
  const { data: existing, error: existingError } = await client
    .from('skin_profile_series')
    .select('series_id, sub_tag, sub_tag_sort')
    .eq('skin_profile_id', id);
  if (existingError) throw existingError;
  if (!seriesLinks.length) {
    const { error: deleteError } = await client.from('skin_profile_series').delete().eq('skin_profile_id', id);
    if (deleteError) throw deleteError;
    return;
  }

  const seriesIds = seriesLinks.map(link => link.series_id);
  const { data: seriesRows, error: seriesError } = await client
    .from('skin_series')
    .select('id, series_type')
    .in('id', seriesIds);
  if (seriesError) throw seriesError;
  const seriesById = new Map((seriesRows || []).map(series => [series.id, series]));
  if (seriesById.size !== seriesIds.length) throw new Error('存在无效的皮肤套系');
  const existingBySeriesId = new Map((existing || []).map(link => [link.series_id, link]));
  const rows = seriesLinks.map(link => {
    const series = seriesById.get(link.series_id);
    const previous = existingBySeriesId.get(link.series_id);
    const subTag = link.sub_tag === undefined ? (previous?.sub_tag || '') : link.sub_tag;
    const subTagSort = link.sub_tag_sort === undefined
      ? Number(previous?.sub_tag_sort || 0)
      : link.sub_tag_sort;
    if (!Number.isInteger(subTagSort)) throw new Error('细分排序值必须是整数');
    if (seriesNeedsSubTag(series.series_type) && !subTag) throw new Error('战令限定、赛季限定和生肖限定必须填写对应细分');
    return {
      skin_profile_id: id,
      series_id: link.series_id,
      sub_tag: seriesNeedsSubTag(series.series_type) ? subTag : null,
      sub_tag_sort: seriesNeedsSubTag(series.series_type) ? subTagSort : 0,
    };
  });
  const { error: upsertError } = await client
    .from('skin_profile_series')
    .upsert(rows, { onConflict: 'skin_profile_id,series_id' });
  if (upsertError) throw upsertError;
  const { error: deleteError } = await client
    .from('skin_profile_series')
    .delete()
    .eq('skin_profile_id', id)
    .not('series_id', 'in', `(${seriesIds.join(',')})`);
  if (deleteError) throw deleteError;
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
  if (path.endsWith('/feedback')     && m === 'POST')   return send(await submitFeedback(body, h));
  if (path.endsWith('/feedback')     && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listFeedback(qs)); }
  if (path.endsWith('/users')        && m === 'GET')    { const [u,e]=requireAdmin(h); if(e) return send(e); return send(await listUsers()); }
  if (path.endsWith('/users')        && m === 'POST')   { const [u,e]=requireAdmin(h); if(e) return send(e); return send(await createUser(body,u)); }
  if (/\/users\/\d+$/.test(path)     && m === 'DELETE') { const [u,e]=requireAdmin(h); if(e) return send(e); return send(await deleteUser(path.split('/').pop(),u)); }
  if (path.endsWith('/skin-profiles') && m === 'GET')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listSkinProfiles(qs)); }
  if (path.endsWith('/series')       && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listSeries(qs)); }
  if (path.endsWith('/series')       && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await upsertSeries(body,u)); }
  if (/\/series\/\d+$/.test(path)    && m === 'PUT')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await upsertSeries({ ...body, id: path.split('/').pop() },u)); }
  if (/\/series\/\d+$/.test(path)    && m === 'DELETE') { const [u,e]=requireAuth(h); if(e) return send(e); return send(await deleteSeries(path.split('/').pop(),u)); }
  if (/\/series\/\d+\/skins$/.test(path)      && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listSeriesSkins(path.split('/').slice(-2)[0])); }
  if (/\/series\/\d+\/skins$/.test(path)      && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await bindSeriesSkins(path.split('/').slice(-2)[0],body,u)); }
  if (/\/series\/\d+\/skins\/\d+$/.test(path) && m === 'PUT')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await updateSeriesSkinMeta(path.split('/').slice(-3)[0],path.split('/').pop(),body,u)); }
  if (/\/series\/\d+\/skins\/\d+$/.test(path) && m === 'DELETE') { const [u,e]=requireAuth(h); if(e) return send(e); return send(await unbindSeriesSkin(path.split('/').slice(-3)[0],path.split('/').pop(),u)); }
  if (path.endsWith('/skins')        && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listSkins(qs)); }
  if (path.endsWith('/skins')        && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await insertSkin(body,u)); }
  if (/\/skins\/\d+$/.test(path)     && m === 'PUT')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await updateSkin(path.split('/').pop(),body,u)); }
  if (/\/skins\/\d+$/.test(path)     && m === 'DELETE') { const [u,e]=requireAuth(h); if(e) return send(e); return send(await deleteSkin(path.split('/').pop(),u)); }
  if (path.endsWith('/batch-update') && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await batchUpdate(body,u)); }
  if (path.endsWith('/images')       && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await uploadImage(body,u)); }
  if (path.endsWith('/images')       && m === 'DELETE') { const [u,e]=requireAuth(h); if(e) return send(e); return send(await deleteImage(body,u)); }
  if (path.endsWith('/logs')         && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listLogs(qs)); }

  if (path.endsWith('/heroes')            && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listHeroes(qs)); }
  if (path.endsWith('/heroes')            && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await insertHero(body,u)); }
  if (/\/heroes\/\d+$/.test(path)         && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await getHero(path.split('/').pop())); }
  if (/\/heroes\/\d+$/.test(path)         && m === 'PUT')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await updateHero(path.split('/').pop(),body,u)); }
  if (/\/heroes\/\d+$/.test(path)         && m === 'DELETE') { const [u,e]=requireAuth(h); if(e) return send(e); return send(await deleteHero(path.split('/').pop(),u)); }
  if (/\/heroes\/\d+\/skins$/.test(path)  && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listHeroSkins(path.split('/').slice(-2)[0])); }

  if (path.endsWith('/special-resources')  && m === 'GET')    { const [u,e]=requireAuth(h); if(e) return send(e); return send(await listSpecialResources(qs)); }
  if (path.endsWith('/special-resources')  && m === 'POST')   { const [u,e]=requireAuth(h); if(e) return send(e); return send(await insertSpecialResource(body,u)); }
  if (/\/special-resources\/[a-z_]+\/\d+$/.test(path) && m === 'PUT') {
    const [u,e]=requireAuth(h); if(e) return send(e);
    const parts=path.split('/'); return send(await updateSpecialResource(parts[parts.length-2],parts.pop(),body,u));
  }
  if (/\/special-resources\/[a-z_]+\/\d+$/.test(path) && m === 'DELETE') {
    const [u,e]=requireAuth(h); if(e) return send(e);
    const parts=path.split('/'); return send(await deleteSpecialResource(parts[parts.length-2],parts.pop(),u));
  }

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
  const { data } = await getClient().from('admin_users').select('id,username,display_name,role,created_at').order('created_at', { ascending: false });
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

  const hero = params.hero ? decodeURIComponent(params.hero) : '';
  const quality = params.quality ? normalizeQuality(decodeURIComponent(params.quality)) : '';
  const type = params.type ? decodeURIComponent(params.type) : '';
  const search = params.search ? decodeURIComponent(params.search).trim().replace(/[%,()]/g, ' ') : '';

  // 先在数据库层完成筛选、排序和分页，避免每次输入筛选时读取整张 skins 表。
  const load = select => {
    let query = getClient().from('skins').select(select, { count: 'exact' });
    if (hero) query = query.eq('hero', hero);
    if (quality) query = quality === QUALITY_OTHER
      ? query.in('quality', [QUALITY_OTHER, OLD_COMPANION_QUALITY])
      : query.eq('quality', quality);
    if (type) query = query.eq('type', type);
    if (search) query = query.or(`name.ilike.%${search}%,hero.ilike.%${search}%`);
    return query
      .order('date', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .range(offset, offset + perPage - 1);
  };

  let result = await load(SKIN_SELECT);
  if (result.error) result = await load('*, skin_profiles:skin_profile_id(*)');
  if (result.error) return fail(result.error.message);

  return ok({
    skins: (result.data || []).map(normalizeSkinRecord),
    total: result.count || 0,
    page,
    per_page: perPage,
  });
}

async function listSkinProfiles(params) {
  const perPage = Math.min(1000, parseInt(params.per_page || '1000'));
  const search = params.search ? decodeURIComponent(params.search).toLowerCase() : '';
  const load = async (select) => getClient()
    .from('skin_profiles')
    .select(select)
    .order('first_release_date', { ascending: false, nullsFirst: false })
    .limit(perPage);
  let { data, error } = await load('*, skin_profile_series(sub_tag,sub_tag_sort,series:series_id(*))');
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
  const client = getClient();
  const { data, error } = await client
    .from('skin_series')
    .select('*')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });
  if (error) return fail(error.message);
  const { data: links } = await client.from('skin_profile_series').select('series_id');
  const counts = {};
  (links || []).forEach(l => { counts[l.series_id] = (counts[l.series_id] || 0) + 1; });
  let series = (data || []).map(s => ({ ...s, skin_count: counts[s.id] || 0 }));
  if (search) {
    series = series.filter(s =>
      String(s.name || '').toLowerCase().includes(search) ||
      String(s.description || '').toLowerCase().includes(search) ||
      String(s.sub_tag || '').toLowerCase().includes(search)
    );
  }
  return ok({ series, total: series.length });
}

async function upsertSeries(data, user) {
  const seriesType = String(data?.series_type || 'other').trim();
  if (!SERIES_TYPES.has(seriesType)) return fail('套系类型不合法');
  const clean = {
    name: String(data?.name || '').trim(),
    series_type: seriesType,
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

// ── 套系↔皮肤绑定 ─────────────────────────────────────────────
async function listSeriesSkins(seriesId) {
  const sid = parseInt(seriesId, 10);
  const { data, error } = await getClient()
    .from('skin_profile_series')
    .select('sub_tag, sub_tag_sort, skin_profiles:skin_profile_id(*)')
    .eq('series_id', sid);
  if (error) return fail(error.message);
  const profiles = (data || [])
    .map(r => r.skin_profiles ? ({
      ...r.skin_profiles,
      quality: normalizeQuality(r.skin_profiles.quality),
      sub_tag: r.sub_tag || '',
      sub_tag_sort: r.sub_tag_sort || 0,
    }) : null)
    .filter(Boolean)
    .sort((a, b) =>
      String(a.hero || '').localeCompare(String(b.hero || ''), 'zh-Hans-CN') ||
      String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'));
  return ok({ profiles, total: profiles.length });
}

async function buildSeriesSkinLink(client, seriesId, profileId, body) {
  const sid = parseInt(seriesId, 10);
  const pid = parseInt(profileId, 10);
  const { data: series, error } = await client
    .from('skin_series')
    .select('id, series_type')
    .eq('id', sid)
    .maybeSingle();
  if (error) throw error;
  if (!series) throw new Error('套系不存在');
  const needsSubTag = seriesNeedsSubTag(series.series_type);
  const subTag = needsSubTag ? String(body?.sub_tag || '').trim() : '';
  if (needsSubTag && !subTag) throw new Error('请填写该皮肤在此套系下的细分');
  const rawSort = body?.sub_tag_sort;
  const subTagSort = rawSort === '' || rawSort === undefined || rawSort === null ? 0 : Number(rawSort);
  if (!Number.isInteger(subTagSort)) throw new Error('细分排序值必须是整数');
  return {
    skin_profile_id: pid,
    series_id: sid,
    sub_tag: needsSubTag ? subTag : null,
    sub_tag_sort: needsSubTag ? subTagSort : 0,
  };
}

async function bindSeriesSkins(seriesId, body, user) {
  const ids = normalizeSeriesIds(body?.skin_profile_ids);
  if (!ids || !ids.length) return fail('请选择要添加的皮肤');
  const client = getClient();
  let rows;
  try {
    rows = await Promise.all(ids.map(pid => buildSeriesSkinLink(client, seriesId, pid, body)));
  } catch (e) {
    return fail(e.message);
  }
  const sid = parseInt(seriesId, 10);
  const { error } = await client
    .from('skin_profile_series')
    .upsert(rows, { onConflict: 'skin_profile_id,series_id' });
  if (error) return fail(error.message);
  await log(client, user.username, 'bind_series_skins', sid, { series_id: sid, skin_profile_ids: ids, sub_tag: rows[0]?.sub_tag || null });
  return ok({ added: ids.length });
}

async function updateSeriesSkinMeta(seriesId, profileId, body, user) {
  const client = getClient();
  let link;
  try {
    link = await buildSeriesSkinLink(client, seriesId, profileId, body);
  } catch (e) {
    return fail(e.message);
  }
  const { data, error } = await client
    .from('skin_profile_series')
    .update({ sub_tag: link.sub_tag, sub_tag_sort: link.sub_tag_sort })
    .eq('series_id', link.series_id)
    .eq('skin_profile_id', link.skin_profile_id)
    .select()
    .maybeSingle();
  if (error) return fail(error.message);
  if (!data) return fail('皮肤未绑定到该套系', 404);
  await log(client, user.username, 'update_series_skin_meta', link.series_id, link);
  return ok({ link: data });
}

async function unbindSeriesSkin(seriesId, profileId, user) {
  const sid = parseInt(seriesId, 10);
  const pid = parseInt(profileId, 10);
  const client = getClient();
  const { error } = await client
    .from('skin_profile_series')
    .delete()
    .eq('series_id', sid)
    .eq('skin_profile_id', pid);
  if (error) return fail(error.message);
  await log(client, user.username, 'unbind_series_skin', sid, { series_id: sid, skin_profile_id: pid });
  return ok({ ok: true });
}

async function updateSkin(id, updates, user) {
  const ALLOWED = new Set(['date','name','quality','tag','hero','price','obtain','type','permanent','skin_img_url','tag_img_url','hero_id','notes','skin_profile_id','series_ids','series_links','skin_value_points']);
  const clean = Object.fromEntries(Object.entries(updates).filter(([k]) => ALLOWED.has(k)));
  if (clean.quality) clean.quality = normalizeQuality(clean.quality);
  const seriesLinks = normalizeSeriesLinks(clean.series_links ?? clean.series_ids);
  delete clean.series_ids;
  delete clean.series_links;
  if (!Object.keys(clean).length && seriesLinks === null) return fail('没有可更新的字段');
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
    await syncProfileSeries(client, profile.id, seriesLinks);
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
  const ALLOWED = new Set(['date','name','quality','tag','hero','price','obtain','type','permanent','skin_img_url','tag_img_url','hero_id','notes','skin_profile_id','series_ids','series_links','skin_value_points']);
  const clean = Object.fromEntries(Object.entries(data||{}).filter(([k]) => ALLOWED.has(k)));
  if (clean.quality) clean.quality = normalizeQuality(clean.quality);
  const seriesLinks = normalizeSeriesLinks(clean.series_links ?? clean.series_ids);
  delete clean.series_ids;
  delete clean.series_links;
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
    await syncProfileSeries(client, profile.id, seriesLinks);
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

// ── 用户反馈 ─────────────────────────────────────────────────
function cleanText(value, maxLen) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return maxLen ? text.slice(0, maxLen) : text;
}

async function submitFeedback(data, headers) {
  const reporter = cleanText(data?.reporter || data?.contact, 80);
  const content = cleanText(data?.content, 200);
  if (!reporter) return fail('反馈人不能为空');
  if (!content) return fail('反馈内容不能为空');
  if (content.length > 150) return fail('反馈内容不能超过150字');

  const row = {
    reporter,
    content,
    source: cleanText(data?.source, 40) || 'miniprogram',
    page: cleanText(data?.page || data?.path, 120),
    user_agent: cleanText(headers?.['user-agent'], 300),
  };
  const { data: inserted, error } = await getClient()
    .from('feedback')
    .insert(row)
    .select('id,created_at')
    .maybeSingle();
  if (error) return fail('反馈提交失败：' + error.message);
  return ok({ ok: true, feedback: inserted });
}

async function listFeedback(params) {
  const page = Math.max(1, parseInt(params.page || '1'));
  const perPage = Math.min(100, Math.max(1, parseInt(params.per_page || '20')));
  const offset = (page - 1) * perPage;
  const search = cleanText(params.search ? decodeURIComponent(params.search) : '', 80)
    .replace(/[%,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const startDate = cleanText(params.start_date ? decodeURIComponent(params.start_date) : '', 20);
  const endDate = cleanText(params.end_date ? decodeURIComponent(params.end_date) : '', 20);

  let q = getClient()
    .from('feedback')
    .select('*', { count: 'exact' });
  if (search) q = q.or(`reporter.ilike.%${search}%,content.ilike.%${search}%`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(startDate)) q = q.gte('created_at', `${startDate}T00:00:00.000Z`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    const next = new Date(`${endDate}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    q = q.lt('created_at', next.toISOString());
  }
  const { data, count, error } = await q
    .order('created_at', { ascending: false })
    .range(offset, offset + perPage - 1);
  if (error) return fail(error.message);
  return ok({ feedback: data || [], total: count || 0, page, per_page: perPage });
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

  q = q.order('release_date', { ascending: false, nullsFirst: false }).order('id', { ascending: false }).range(offset, offset + perPage - 1);
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
  const ALLOWED = new Set(['type','name','quality','tag','tag_img_url','collab','obtain','price','release_type','parent_resource_id','permanent','date','img_url','notes','is_available']);
  const clean = Object.fromEntries(Object.entries(data || {}).filter(([k]) => ALLOWED.has(k)));
  const client = getClient();
  const releaseType = clean.release_type || TYPE_FIRST;
  if (![TYPE_FIRST, TYPE_RETURN].includes(releaseType)) return fail('首发/返场类型无效');
  if (releaseType === TYPE_RETURN) {
    const parentId = parseInt(clean.parent_resource_id, 10);
    if (!parentId) return fail('返场记录必须选择对应的首发资源');
    const { data: firstResource, error: parentError } = await client
      .from('resources').select('*').eq('id', parentId).eq('release_type', TYPE_FIRST).maybeSingle();
    if (parentError || !firstResource) return fail('对应的首发资源不存在，请重新选择');
    if (!clean.date || !clean.obtain || !clean.price) return fail('返场日期、获取方式和价格不能为空');
    Object.assign(clean, {
      parent_resource_id: firstResource.id,
      release_type: TYPE_RETURN,
      type: firstResource.type,
      name: firstResource.name,
      quality: firstResource.quality,
      tag: firstResource.tag,
      tag_img_url: firstResource.tag_img_url,
      collab: firstResource.collab,
      permanent: firstResource.permanent,
      img_url: firstResource.img_url,
      notes: firstResource.notes,
    });
  } else {
    clean.release_type = TYPE_FIRST;
    clean.parent_resource_id = null;
    if (!clean.type) return fail('资源类型为必填项');
    if (!clean.name) return fail('资源名称为必填项');
    if (!clean.date) return fail('上线日期为必填项');
    if (!['天幕','小兵'].includes(clean.type)) return fail('type 只能是 天幕 或 小兵');
  }
  const { data: inserted, error } = await client
    .from('resources').insert(clean).select().maybeSingle();
  if (error?.code === '23505') return fail('相同的资源记录已存在，请勿重复提交', 409);
  if (error) return fail('创建失败：' + error.message);
  await log(client, user.username, 'resource_insert', inserted?.id || null, { name: clean.name, type: clean.type });
  return ok({ resource: inserted });
}

// ── 编辑资源 ─────────────────────────────────────────────────
async function updateResource(id, updates, user) {
  const ALLOWED = new Set(['type','name','quality','tag','tag_img_url','collab','obtain','price','release_type','parent_resource_id','permanent','date','img_url','notes','is_available']);
  const clean = Object.fromEntries(Object.entries(updates).filter(([k]) => ALLOWED.has(k)));
  const client = getClient();
  const { data: before } = await client.from('resources').select('*').eq('id', id).maybeSingle();
  if (!before) return fail('资源不存在');
  const releaseType = clean.release_type || before.release_type || TYPE_FIRST;
  if (![TYPE_FIRST, TYPE_RETURN].includes(releaseType)) return fail('首发/返场类型无效');

  if (releaseType === TYPE_RETURN) {
    const parentId = parseInt(clean.parent_resource_id || before.parent_resource_id, 10);
    if (!parentId) return fail('返场记录必须选择对应的首发资源');
    if (parentId === parseInt(id, 10)) return fail('返场资源不能关联自身');
    const { data: firstResource, error: parentError } = await client
      .from('resources').select('*').eq('id', parentId).eq('release_type', TYPE_FIRST).maybeSingle();
    if (parentError || !firstResource) return fail('对应的首发资源不存在，请重新选择');
    const date = clean.date ?? before.date;
    const obtain = clean.obtain ?? before.obtain;
    const price = clean.price ?? before.price;
    if (!date || !obtain || !price) return fail('返场日期、获取方式和价格不能为空');
    Object.assign(clean, {
      parent_resource_id: firstResource.id,
      release_type: TYPE_RETURN,
      date,
      obtain,
      price,
      type: firstResource.type,
      name: firstResource.name,
      quality: firstResource.quality,
      tag: firstResource.tag,
      tag_img_url: firstResource.tag_img_url,
      collab: firstResource.collab,
      permanent: firstResource.permanent,
      img_url: firstResource.img_url,
      notes: firstResource.notes,
    });
  } else {
    clean.release_type = TYPE_FIRST;
    clean.parent_resource_id = null;
    const merged = { ...before, ...clean };
    if (!merged.type || !merged.name || !merged.date) return fail('资源类型、名称和上线日期不能为空');
    if (!['天幕','小兵'].includes(merged.type)) return fail('type 只能是 天幕 或 小兵');
  }
  if (!Object.keys(clean).length) return fail('没有可更新的字段');
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

// ── 套装资源（星传说 / 星元套装 / 元流套装）────────────────────
function getSpecialResourceConfig(category) {
  return SPECIAL_RESOURCE_CONFIG[String(category || '').trim()] || null;
}

function normalizeSpecialResourceRow(row) {
  if (!row) return row;
  const skinProfile = Array.isArray(row.skin_profile) ? row.skin_profile[0] : row.skin_profile;
  return { ...row, skin_profile: skinProfile || null };
}

function cleanSpecialResourceInput(data, config) {
  const allowed = new Set(config.fields);
  const clean = Object.fromEntries(Object.entries(data || {}).filter(([key]) => allowed.has(key)));
  const stringFields = ['name','date','release_type','quality','tag','collab','obtain','price','permanent','img_url','tag_img_url','notes'];
  stringFields.forEach(key => {
    if (Object.prototype.hasOwnProperty.call(clean, key)) {
      clean[key] = clean[key] === null || clean[key] === undefined ? '' : String(clean[key]).trim();
    }
  });
  ['skin_profile_id','parent_resource_id'].forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(clean, key)) return;
    const id = parseInt(clean[key], 10);
    clean[key] = Number.isInteger(id) && id > 0 ? id : null;
  });
  ['img_url','tag_img_url','notes','collab'].forEach(key => {
    if (Object.prototype.hasOwnProperty.call(clean, key) && !clean[key]) clean[key] = null;
  });
  return clean;
}

async function ensureSpecialResourceSkin(client, skinProfileId) {
  if (!skinProfileId) return false;
  const { data, error } = await client
    .from('skin_profiles')
    .select('id')
    .eq('id', skinProfileId)
    .maybeSingle();
  return !error && !!data;
}

async function listSpecialResources(params) {
  const category = decodeURIComponent(params.category || 'star_legend');
  const config = getSpecialResourceConfig(category);
  if (!config) return fail('不支持的套装资源类型');
  const select = config.requiresSkin
    ? '*, skin_profile:skin_profile_id(id,name,hero,hero_id,skin_img_url)'
    : '*';
  const { data, error } = await getClient()
    .from(config.table)
    .select(select)
    .order('date', { ascending: false })
    .order('id', { ascending: false })
    .limit(500);
  if (error) return fail(error.message);
  let resources = (data || []).map(normalizeSpecialResourceRow);
  if (category === 'star_outfit') {
    resources = resources.map(resource => ({ ...resource, quality: '' }));
  }
  if (params.release_type) {
    const releaseType = decodeURIComponent(params.release_type);
    resources = resources.filter(resource => resource.release_type === releaseType);
  }
  if (params.search) {
    const search = decodeURIComponent(params.search).toLowerCase();
    resources = resources.filter(resource => {
      const skin = resource.skin_profile || {};
      return [resource.name, resource.quality, resource.tag, resource.obtain, skin.name, skin.hero]
        .some(value => String(value || '').toLowerCase().includes(search));
    });
  }
  return ok({ category, label: config.label, resources, total: resources.length });
}

function validateFirstSpecialResource(clean, config, category) {
  if (!clean.name) return '资源名称不能为空';
  if (!clean.date) return '上线日期不能为空';
  if (!clean.obtain) return '获取方式不能为空';
  if (!clean.price) return '价格不能为空';
  if (!clean.img_url) return '首发资源必须上传资源图片';
  if (config.requiresSkin && !clean.skin_profile_id) return `${config.label}必须关联皮肤`;
  if (category === 'yuanliu_suit') {
    if (!clean.quality) return '品质不能为空';
    if (!SPECIAL_RESOURCE_QUALITIES.has(clean.quality)) return '品质只能是绿色、蓝色、紫色或金色';
  }
  return '';
}

async function getFirstSpecialResource(client, config, id) {
  if (!id) return null;
  const { data, error } = await client
    .from(config.table)
    .select('*')
    .eq('id', id)
    .eq('release_type', TYPE_FIRST)
    .maybeSingle();
  return error ? null : data;
}

async function insertSpecialResource(data, user) {
  const category = String(data?.category || '');
  const config = getSpecialResourceConfig(category);
  if (!config) return fail('不支持的套装资源类型');
  const clean = cleanSpecialResourceInput(data, config);
  const client = getClient();
  const releaseType = clean.release_type || TYPE_FIRST;
  if (![TYPE_FIRST, TYPE_RETURN].includes(releaseType)) return fail('首发/返场类型无效');

  let insertRow;
  if (releaseType === TYPE_RETURN) {
    if (!clean.parent_resource_id) return fail('返场记录必须选择对应的首发资源');
    if (!clean.date) return fail('返场日期不能为空');
    if (!clean.obtain) return fail('返场获取方式不能为空');
    if (!clean.price) return fail('返场价格不能为空');
    const firstResource = await getFirstSpecialResource(client, config, clean.parent_resource_id);
    if (!firstResource) return fail('对应首发资源不存在，请重新选择');
    insertRow = {
      parent_resource_id: firstResource.id,
      release_type: TYPE_RETURN,
      date: clean.date,
      obtain: clean.obtain,
      price: clean.price,
      notes: clean.notes || null,
    };
    config.inheritedFields.forEach(field => { insertRow[field] = firstResource[field]; });
  } else {
    clean.release_type = TYPE_FIRST;
    clean.parent_resource_id = null;
    if (config.fields.includes('permanent')) clean.permanent = clean.permanent || PERMANENT_NO;
    const validationError = validateFirstSpecialResource(clean, config, category);
    if (validationError) return fail(validationError);
    if (clean.permanent && !['是', PERMANENT_NO].includes(clean.permanent)) return fail('常驻状态无效');
    if (config.requiresSkin && !(await ensureSpecialResourceSkin(client, clean.skin_profile_id))) {
      return fail('关联皮肤不存在，请重新选择');
    }
    insertRow = clean;
  }

  const { data: inserted, error } = await client
    .from(config.table)
    .insert(insertRow)
    .select()
    .maybeSingle();
  if (error) return fail('创建失败：' + error.message);
  await log(client, user.username, 'special_resource_insert', inserted?.id || null, {
    category,
    release_type: releaseType,
    name: insertRow.name,
    parent_resource_id: insertRow.parent_resource_id || null,
    skin_profile_id: insertRow.skin_profile_id || null,
  });
  return ok({ category, resource: inserted });
}

async function updateSpecialResource(category, id, updates, user) {
  const config = getSpecialResourceConfig(category);
  if (!config) return fail('不支持的套装资源类型');
  const client = getClient();
  const { data: before } = await client.from(config.table).select('*').eq('id', id).maybeSingle();
  if (!before) return fail('资源不存在');
  const targetCategory = String(updates?.category || category);
  const targetConfig = getSpecialResourceConfig(targetCategory);
  if (!targetConfig) return fail('不支持的套装资源类型');
  if (targetCategory !== category) {
    if (before.release_type === TYPE_FIRST) {
      const { count, error } = await client
        .from(config.table)
        .select('id', { count: 'exact', head: true })
        .eq('parent_resource_id', id);
      if (error) return fail(error.message);
      if (count) return fail('该首发资源已有返场记录，不能直接修改资源类型');
    }
    const created = await insertSpecialResource({ ...before, ...updates, category: targetCategory }, user);
    if (created.statusCode >= 400) return created;
    const { error: deleteError } = await client.from(config.table).delete().eq('id', id);
    if (deleteError) return fail(`资源类型迁移失败：${deleteError.message}`);
    const inserted = JSON.parse(created.body).resource;
    await log(client, user.username, 'special_resource_move', parseInt(id, 10), {
      from_category: category,
      to_category: targetCategory,
      new_resource_id: inserted?.id || null,
    });
    return ok({ category: targetCategory, resource: inserted, moved_from: { category, id: parseInt(id, 10) } });
  }
  const requested = cleanSpecialResourceInput(updates, config);
  const releaseType = requested.release_type || before.release_type || TYPE_FIRST;
  if (![TYPE_FIRST, TYPE_RETURN].includes(releaseType)) return fail('首发/返场类型无效');

  let clean;
  if (releaseType === TYPE_RETURN) {
    const parentId = requested.parent_resource_id || before.parent_resource_id;
    if (!parentId) return fail('返场记录必须选择对应的首发资源');
    if (parseInt(parentId, 10) === parseInt(id, 10)) return fail('返场资源不能关联自身');
    const firstResource = await getFirstSpecialResource(client, config, parentId);
    if (!firstResource) return fail('对应的首发资源不存在，请重新选择');
    const date = requested.date ?? before.date;
    const obtain = requested.obtain ?? before.obtain;
    const price = requested.price ?? before.price;
    if (!date) return fail('返场日期不能为空');
    if (!obtain) return fail('返场获取方式不能为空');
    if (!price) return fail('返场价格不能为空');
    clean = {
      parent_resource_id: firstResource.id,
      release_type: TYPE_RETURN,
      date,
      obtain,
      price,
      notes: requested.notes ?? before.notes ?? null,
    };
    config.inheritedFields.forEach(field => { clean[field] = firstResource[field]; });
  } else {
    clean = requested;
    const merged = { ...before, ...clean, release_type: TYPE_FIRST, parent_resource_id: null };
    const validationError = validateFirstSpecialResource(merged, config, category);
    if (validationError) return fail(validationError);
    if (merged.permanent && !['是', PERMANENT_NO].includes(merged.permanent)) return fail('常驻状态无效');
    if (config.requiresSkin && !(await ensureSpecialResourceSkin(client, merged.skin_profile_id))) {
      return fail('关联皮肤不存在，请重新选择');
    }
    clean.release_type = TYPE_FIRST;
    clean.parent_resource_id = null;
  }
  if (!Object.keys(clean).length) return fail('没有可更新的字段');
  const { data, error } = await client
    .from(config.table)
    .update(clean)
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) return fail('更新失败：' + error.message);
  await log(client, user.username, 'special_resource_update', parseInt(id, 10), {
    category,
    before: Object.fromEntries(Object.keys(clean).map(key => [key, before?.[key]])),
    after: clean,
  });
  return ok({ category, resource: data });
}

async function deleteSpecialResource(category, id, user) {
  const config = getSpecialResourceConfig(category);
  if (!config) return fail('不支持的套装资源类型');
  const client = getClient();
  const { data: before } = await client.from(config.table).select('*').eq('id', id).maybeSingle();
  const { error } = await client.from(config.table).delete().eq('id', id);
  if (error) return fail('删除失败：' + error.message);
  await log(client, user.username, 'special_resource_delete', parseInt(id, 10), { category, deleted: before });
  return ok({ ok: true });
}
