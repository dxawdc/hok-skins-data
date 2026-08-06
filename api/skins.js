const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const OLD_COMPANION_QUALITY = '\u4f34\u751f';
const QUALITY_OTHER = '\u5176\u4ed6';
const PERMANENT_NO = '\u5426';
const SKIN_SELECT = '*, skin_profiles:skin_profile_id(*, skin_profile_series(series:series_id(*)))';

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

function toPositiveInt(value, fallback, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return max ? Math.min(n, max) : n;
}

async function fetchAllSkinRows(client, options = {}) {
  const pageLimit = options.limit;
  const pageOffset = options.offset || 0;
  const selectRows = async (select) => {
    if (pageLimit) {
      const { data, error } = await client
        .from('skins')
        .select(select)
        .order('date', { ascending: false })
        .range(pageOffset, pageOffset + pageLimit - 1);
      if (error) throw error;
      return data || [];
    }

    const rows = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await client
        .from('skins')
        .select(select)
        .order('date', { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    return rows;
  };

  try {
    return await selectRows(SKIN_SELECT);
  } catch (error) {
    return await selectRows('*, skin_profiles:skin_profile_id(*)');
  }
}

function normalizeQuality(q) {
  return q === OLD_COMPANION_QUALITY ? QUALITY_OTHER : q;
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
      series_type: s.series_type || 'other',
      sub_tag: s.sub_tag || '',
      sub_tag_sort: s.sub_tag_sort || 0,
    }))
    .sort((a, b) => (a.sort_order - b.sort_order) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
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
    skin_value_points: profile?.skin_value_points ?? null,
    obtain: row.obtain || '',
    type: row.type,
    permanent: profile?.permanent || row.permanent || PERMANENT_NO,
    skin_img_url: profile?.skin_img_url || row.skin_img_url || '',
    tag_img_url: profile?.tag_img_url || row.tag_img_url || '',
    notes: row.notes || profile?.notes || null,
    skin_profile_id: row.skin_profile_id || profile?.id || null,
    series: profileSeries(profile),
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

  const query = getQuery(req);
  const limit = query.limit === undefined ? null : toPositiveInt(query.limit, null, 1000);
  const offset = toPositiveInt(query.offset, 0);

  let data;
  try {
    data = await fetchAllSkinRows(getClient(), { limit, offset });
  } catch (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const rows = (data || []).map(flattenSkin);
  res.setHeader('Cache-Control', 'public, max-age=14400, s-maxage=1800');
  res.setHeader('X-Total', String(rows.length));
  if (limit) {
    res.setHeader('X-Limit', String(limit));
    res.setHeader('X-Offset', String(offset));
  }
  res.status(200).json(rows);
};
