const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const OLD_COMPANION_QUALITY = '\u4f34\u751f';
const QUALITY_OTHER = '\u5176\u4ed6';
const PERMANENT_NO = '\u5426';

function getClient() {
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

async function fetchAllSkinRows(client) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from('skins')
      .select('*, skin_profiles:skin_profile_id(*), heroes:hero_id(id,name,roles,lanes,gender,avatar_url,release_date,notes)')
      .order('date', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

function normalizeQuality(q) {
  return q === OLD_COMPANION_QUALITY ? QUALITY_OTHER : q;
}

function flattenSkin(row) {
  const profile = Array.isArray(row.skin_profiles) ? row.skin_profiles[0] : row.skin_profiles;
  return {
    id: row.id,
    date: row.date,
    name: profile?.name || row.name,
    quality: normalizeQuality(profile?.quality || row.quality),
    tag: profile?.tag ?? row.tag ?? '',
    hero: profile?.hero || row.hero,
    hero_id: profile?.hero_id || row.hero_id || null,
    price: row.price || '',
    obtain: row.obtain || '',
    type: row.type,
    permanent: profile?.permanent || row.permanent || PERMANENT_NO,
    skin_img_url: profile?.skin_img_url || row.skin_img_url || '',
    tag_img_url: profile?.tag_img_url || row.tag_img_url || '',
    notes: row.notes || profile?.notes || null,
    skin_profile_id: row.skin_profile_id || profile?.id || null,
    heroes: row.heroes || null,
  };
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

  let data;
  try {
    data = await fetchAllSkinRows(getClient());
  } catch (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const rows = (data || []).map(flattenSkin);
  res.setHeader('Cache-Control', 'public, max-age=14400, s-maxage=1800');
  res.setHeader('X-Total', String(rows.length));
  res.status(200).json(rows);
};
