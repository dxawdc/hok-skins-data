const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

const OLD_COMPANION_QUALITY = '伴生'; // 伴生
const QUALITY_OTHER = '其他';        // 其他
const RELEASE_TYPES = ['首发', '返场']; // 首发 / 返场

// 统一事件流的列顺序（同时用于 CSV 表头与数据字典展示）
const COLUMNS = [
  'category', 'category_label', 'event_id', 'name', 'hero', 'hero_id',
  'quality', 'tag', 'release_type', 'date', 'permanent', 'price', 'obtain',
  'collab', 'sub_type', 'series', 'roles', 'lanes', 'gender', 'notes',
  'source_table',
];

// 数据字典：每个字段的中文含义，随 JSON 一起返回，方便 AI 直接理解
const DICTIONARY = {
  category: '资源大类标识：hero=英雄 / skin=皮肤 / star_legend=星传说·典藏 / star_outfit=星元套装 / yuanliu_suit=元流套装 / resource=普通资源',
  category_label: '资源大类中文名',
  event_id: '事件唯一标识，格式为「类别-原始ID」',
  name: '名称（皮肤名 / 资源名 / 英雄名）',
  hero: '归属英雄；资源无归属时为空',
  hero_id: '归属英雄 ID；无则为 null',
  quality: '品质（如传说、史诗、勇者，或星元套装的绿/蓝/紫/金）',
  tag: '标签说明',
  release_type: '上线类型：首发 / 返场；英雄上线统一记为首发',
  date: '事件发生日期（首发或返场当日，YYYY-MM-DD）',
  permanent: '是否永久上架：是 / 否',
  price: '价格（原始文本，可能含点券/代币等单位）',
  obtain: '获取方式',
  collab: '联动 / IP 合作说明（如有）',
  sub_type: '细分类型（普通资源：天幕 / 小兵）',
  series: '所属皮肤系列；JSON 中为数组，CSV 中以竖线 | 分隔',
  roles: '英雄定位（仅英雄事件）；JSON 中为数组，CSV 中以竖线 | 分隔',
  lanes: '英雄分路（仅英雄事件）；JSON 中为数组，CSV 中以竖线 | 分隔',
  gender: '英雄性别（仅英雄事件）',
  notes: '备注',
  source_table: '数据来源表',
};

// 特殊资源表配置（星传说·典藏 / 星元套装 / 元流套装）
const SPECIAL_RESOURCES = [
  {
    category: 'star_legend',
    label: '星传说·典藏', // 星传说·典藏
    table: 'star_legend_resources',
    select: '*, skin_profile:skin_profile_id(id,name,hero,hero_id)',
    hasHero: true,
  },
  {
    category: 'star_outfit',
    label: '星元套装', // 星元套装
    table: 'star_outfit_resources',
    select: '*, skin_profile:skin_profile_id(id,name,hero,hero_id)',
    hasHero: true,
  },
  {
    category: 'yuanliu_suit',
    label: '元流套装', // 元流套装
    table: 'yuanliu_suit_resources',
    select: '*',
    hasHero: false,
  },
];

function getClient() {
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

function getQuery(req) {
  if (req.query) return req.query;
  try {
    return Object.fromEntries(new URL(req.url || '', 'http://localhost').searchParams.entries());
  } catch (e) {
    return {};
  }
}

function normalizeQuality(q) {
  return q === OLD_COMPANION_QUALITY ? QUALITY_OTHER : (q || '');
}

function firstRelation(value) {
  return Array.isArray(value) ? (value[0] || null) : (value || null);
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

// 组装一条统一事件记录，保证所有列都存在（缺省用空值），便于扁平化到 CSV
function makeEvent(fields) {
  return {
    category: fields.category,
    category_label: fields.category_label,
    event_id: fields.event_id,
    name: fields.name || '',
    hero: fields.hero || '',
    hero_id: fields.hero_id ?? null,
    quality: fields.quality || '',
    tag: fields.tag || '',
    release_type: fields.release_type || '',
    date: fields.date || '',
    permanent: fields.permanent || '',
    price: fields.price || '',
    obtain: fields.obtain || '',
    collab: fields.collab || '',
    sub_type: fields.sub_type || '',
    series: fields.series || [],
    roles: fields.roles || [],
    lanes: fields.lanes || [],
    gender: fields.gender || '',
    notes: fields.notes || '',
    source_table: fields.source_table,
  };
}

function flattenHero(row) {
  return makeEvent({
    category: 'hero',
    category_label: '英雄', // 英雄
    event_id: `hero-${row.id}`,
    name: row.name,
    hero: row.name,
    hero_id: row.id,
    release_type: RELEASE_TYPES[0], // 首发
    date: row.release_date || '',
    roles: asArray(row.roles),
    lanes: asArray(row.lanes),
    gender: row.gender || '',
    notes: row.notes || '',
    source_table: 'heroes',
  });
}

function skinSeries(profile) {
  return (profile?.skin_profile_series || [])
    .map(item => item.series || null)
    .filter(Boolean)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .map(s => s.name)
    .filter(Boolean);
}

function flattenSkin(row) {
  const profile = firstRelation(row.skin_profiles);
  return makeEvent({
    category: 'skin',
    category_label: '皮肤', // 皮肤
    event_id: `skin-${row.id}`,
    name: profile?.name || row.name,
    hero: profile?.hero || row.hero,
    hero_id: profile?.hero_id ?? row.hero_id ?? null,
    quality: normalizeQuality(profile?.quality || row.quality),
    tag: profile?.tag ?? row.tag ?? '',
    release_type: row.type, // skins 表用 type 区分首发/返场
    date: row.date,
    permanent: profile?.permanent || row.permanent || '',
    price: row.price || '',
    obtain: row.obtain || '',
    series: skinSeries(profile),
    notes: row.notes || profile?.notes || '',
    source_table: 'skins',
  });
}

function flattenSpecial(row, config) {
  const profile = config.hasHero ? firstRelation(row.skin_profile) : null;
  return makeEvent({
    category: config.category,
    category_label: config.label,
    event_id: `${config.category}-${row.id}`,
    name: row.name,
    hero: profile?.hero || '',
    hero_id: profile?.hero_id ?? null,
    quality: row.quality || '',
    tag: row.tag || '',
    release_type: row.release_type || '',
    date: row.date,
    permanent: row.permanent || '',
    price: row.price || '',
    obtain: row.obtain || '',
    collab: row.collab || '',
    notes: row.notes || '',
    source_table: config.table,
  });
}

function flattenResource(row) {
  return makeEvent({
    category: 'resource',
    category_label: '普通资源', // 普通资源
    event_id: `resource-${row.id}`,
    name: row.name,
    quality: row.quality || '',
    tag: row.tag || '',
    release_type: row.release_type || '',
    date: row.date,
    permanent: row.permanent || '',
    price: row.price || '',
    obtain: row.obtain || '',
    collab: row.collab || '',
    sub_type: row.type || '', // 天幕 / 小兵
    notes: row.notes || '',
    source_table: 'resources',
  });
}

function parseFilters(query) {
  const q = query || {};
  const categories = String(q.category || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const releaseType = RELEASE_TYPES.includes(q.release_type) ? q.release_type : null;
  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  return {
    format: q.format === 'csv' ? 'csv' : 'json',
    categories,
    releaseType,
    hero: q.hero ? String(q.hero).trim() : null,
    from: isDate(q.from) ? q.from : null,
    to: isDate(q.to) ? q.to : null,
    includeHeroes: q.include_heroes !== 'false',
  };
}

function applyFilters(events, filters) {
  const catSet = filters.categories.length ? new Set(filters.categories) : null;
  return events.filter(ev => {
    if (catSet && !catSet.has(ev.category)) return false;
    if (filters.releaseType && ev.release_type !== filters.releaseType) return false;
    if (filters.hero && ev.hero !== filters.hero && ev.name !== filters.hero) return false;
    if (filters.from && String(ev.date) < filters.from) return false;
    if (filters.to && String(ev.date) > filters.to) return false;
    return true;
  });
}

function buildMeta(events, filters) {
  const byCategory = {};
  const byReleaseType = {};
  let minDate = null;
  let maxDate = null;
  for (const ev of events) {
    byCategory[ev.category] = (byCategory[ev.category] || 0) + 1;
    if (ev.release_type) byReleaseType[ev.release_type] = (byReleaseType[ev.release_type] || 0) + 1;
    const d = ev.date ? String(ev.date) : '';
    if (d) {
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }
  }
  return {
    generated_at: new Date().toISOString(),
    total_events: events.length,
    counts_by_category: byCategory,
    counts_by_release_type: byReleaseType,
    date_range: { from: minDate, to: maxDate },
    filters: {
      category: filters.categories,
      release_type: filters.releaseType,
      hero: filters.hero,
      from: filters.from,
      to: filters.to,
      include_heroes: filters.includeHeroes,
    },
  };
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(events) {
  const lines = [COLUMNS.join(',')];
  for (const ev of events) {
    const cells = COLUMNS.map(col => {
      const v = ev[col];
      if (Array.isArray(v)) return csvEscape(v.join('|'));
      return csvEscape(v);
    });
    lines.push(cells.join(','));
  }
  // 前置 BOM，确保 Excel 正确识别 UTF-8 中文
  return '﻿' + lines.join('\r\n');
}

async function fetchAll(client, { table, select, order = 'date', filterAvailable = false }) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let builder = client.from(table).select(select);
    if (filterAvailable) builder = builder.eq('is_available', true);
    const { data, error } = await builder
      .order(order, { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

async function fetchSkins(client) {
  const withSeries = '*, skin_profiles:skin_profile_id(id,name,hero,hero_id,quality,tag,permanent,notes,skin_profile_series(series:series_id(name,sort_order)))';
  try {
    return await fetchAll(client, { table: 'skins', select: withSeries });
  } catch (e) {
    return await fetchAll(client, { table: 'skins', select: '*, skin_profiles:skin_profile_id(*)' });
  }
}

async function collectEvents(client, filters) {
  const tasks = [];

  if (filters.includeHeroes) {
    tasks.push(
      fetchAll(client, { table: 'heroes', select: '*', order: 'release_date', filterAvailable: true })
        .then(rows => rows.map(flattenHero)),
    );
  }

  tasks.push(fetchSkins(client).then(rows => rows.map(flattenSkin)));

  // 特殊资源表没有 is_available 列（仅 heroes / resources 有），不能加该过滤
  for (const config of SPECIAL_RESOURCES) {
    tasks.push(
      fetchAll(client, { table: config.table, select: config.select })
        .then(rows => rows.map(row => flattenSpecial(row, config))),
    );
  }

  tasks.push(
    fetchAll(client, { table: 'resources', select: '*', filterAvailable: true })
      .then(rows => rows.map(flattenResource)),
  );

  const grouped = await Promise.all(tasks);
  const events = grouped.flat();
  events.sort((a, b) => {
    const byDate = String(b.date || '').localeCompare(String(a.date || ''));
    if (byDate !== 0) return byDate;
    return String(a.category).localeCompare(String(b.category));
  });
  return events;
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const filters = parseFilters(getQuery(req));

  let events;
  try {
    events = applyFilters(await collectEvents(getClient(), filters), filters);
  } catch (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const meta = buildMeta(events, filters);
  res.setHeader('Cache-Control', 'public, max-age=14400, s-maxage=3600');
  res.setHeader('X-Total', String(events.length));

  if (filters.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="hok-analytics.csv"');
    res.status(200).send(toCsv(events));
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json({ meta, dictionary: DICTIONARY, columns: COLUMNS, events });
}

module.exports = handler;
module.exports._private = {
  COLUMNS,
  DICTIONARY,
  SPECIAL_RESOURCES,
  normalizeQuality,
  flattenHero,
  flattenSkin,
  flattenSpecial,
  flattenResource,
  parseFilters,
  applyFilters,
  buildMeta,
  csvEscape,
  toCsv,
  makeEvent,
};
