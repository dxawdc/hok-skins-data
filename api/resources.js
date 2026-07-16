const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

function getClient() {
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

const SPECIAL_RESOURCE_TYPES = [
  {
    category: 'star_legend',
    label: '星传说',
    table: 'star_legend_resources',
    select: '*, skin_profile:skin_profile_id(id,name,hero,hero_id,skin_img_url)',
  },
  {
    category: 'star_outfit',
    label: '星元套装',
    table: 'star_outfit_resources',
    select: '*, skin_profile:skin_profile_id(id,name,hero,hero_id,skin_img_url)',
  },
  {
    category: 'yuanliu_suit',
    label: '元流套装',
    table: 'yuanliu_suit_resources',
    select: '*',
  },
];

function normalizeRelation(row, key) {
  const value = row && row[key];
  return Array.isArray(value) ? (value[0] || null) : (value || null);
}

function normalizeBaseResource(row) {
  return {
    ...row,
    source_category: 'resource',
    resource_category: '普通资源',
    display_type: row.type || '',
  };
}

function normalizeSpecialResource(row, config) {
  const resource = {
    ...row,
    id: `${config.category}-${row.id}`,
    source_id: row.id,
    source_category: config.category,
    resource_category: '套装资源',
    type: config.label,
    display_type: config.label,
    skin_profile: normalizeRelation(row, 'skin_profile'),
  };
  // 星元套装不再定义资源品质，历史列仅为兼容旧数据保留。
  if (config.category === 'star_outfit') resource.quality = '';
  return resource;
}

async function fetchSpecialResources(client) {
  const results = await Promise.all(SPECIAL_RESOURCE_TYPES.map(async config => {
    const { data, error } = await client
      .from(config.table)
      .select(config.select)
      .order('date', { ascending: false })
      .order('id', { ascending: false })
      .limit(500);
    if (error) throw new Error(`${config.label}加载失败：${error.message}`);
    return (data || []).map(row => normalizeSpecialResource(row, config));
  }));
  return results.flat();
}

module.exports = async function handler(req, res) {
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

  const client = getClient();
  const { data, error } = await client
    .from('resources')
    .select('*')
    .eq('is_available', true)
    .order('date', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  let specialResources = [];
  try {
    specialResources = await fetchSpecialResources(client);
  } catch (specialError) {
    res.status(500).json({ error: specialError.message });
    return;
  }

  const payload = [
    ...(data || []).map(normalizeBaseResource),
    ...specialResources,
  ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  res.setHeader('Cache-Control', 'public, max-age=14400, s-maxage=7200');
  res.setHeader('X-Total', String(payload.length));
  res.status(200).json(payload);
};
