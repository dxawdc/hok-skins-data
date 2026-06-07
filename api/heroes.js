const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

function getClient() {
  return createClient(SUPABASE_URL, SUPABASE_KEY);
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

  const { data, error } = await getClient()
    .from('heroes')
    .select('*')
    .eq('is_available', true)
    .order('release_date', { ascending: true, nullsFirst: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=14400, s-maxage=7200');
  res.setHeader('X-Total', String(data?.length || 0));
  res.status(200).json(data || []);
};
