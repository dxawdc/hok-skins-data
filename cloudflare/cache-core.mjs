// Public data/image caching only. Never route authentication or admin data here.
export const BUILD = '2026-10-18-image-cookie-fix';
export const API_TTL = { '/api/skins': 1800, '/api/heroes': 7200, '/api/resources': 7200 };
const HOSTS = new Set(['skinsdata.top', 'www.skinsdata.top']);
const SIZES = [60, 80, 120, 160, 240, 320, 480, 640, 960, 1280];
const STORAGE = 'https://erphrsydujqrcvtpdtnf.supabase.co/storage/v1';
const QUOTA_KEY = 'https://skinsdata.top/__edge-cache/quota-v2';
const MAX_JSON_BYTES = 8 * 1024 * 1024;

function dimension(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return SIZES.find(size => size >= n) || 1280;
}

export function canonicalRequest(request, now = Date.now()) {
  const url = new URL(request.url);
  if (!HOSTS.has(url.hostname)) return null;
  const normalized = new URL(url.pathname, 'https://skinsdata.top');
  const isImage = url.pathname.startsWith('/img/');
  if (!isImage && !Object.hasOwn(API_TTL, url.pathname)) return null;
  if (isImage) {
    // Keep raw originals available; transformed variants share a bounded set of sizes.
    if (!/^\/img\/(skin|tag|hero|resource)\/[^/]+\.(png|jpe?g|webp|gif|avif)$/i.test(url.pathname)) {
      throw new Error('INVALID_IMAGE_PATH');
    }
    if (['width', 'height', 'quality'].some(key => url.searchParams.has(key))) {
      const width = dimension(url.searchParams.get('width'), 320);
      normalized.searchParams.set('width', String(width));
      normalized.searchParams.set('height', String(dimension(url.searchParams.get('height'), width)));
      normalized.searchParams.set('quality', width <= 320 ? '70' : '80');
      normalized.searchParams.set('resize', url.searchParams.get('resize') === 'cover' ? 'cover' : 'contain');
      // Accept affects Supabase's encoded output, so it must also affect the cache key.
      normalized.searchParams.set('format', (request.headers.get('Accept') || '').includes('image/webp') ? 'webp' : 'origin');
    }
  } else {
    if (url.pathname === '/api/skins') {
      for (const key of ['limit', 'offset']) {
        const value = url.searchParams.get(key);
        if (value !== null) {
          if (!/^\d+$/.test(value)) throw new Error('INVALID_PAGINATION');
          const n = Number(value);
          if (!Number.isSafeInteger(n) || n > (key === 'limit' ? 1000 : 1000000)) throw new Error('INVALID_PAGINATION');
          if (n > 0) normalized.searchParams.set(key, String(n));
        }
      }
    }
    // A manual refresh can fill at most one new cache entry per minute, not per timestamp.
    if (url.searchParams.has('refresh')) normalized.searchParams.set('refresh', String(Math.floor(now / 60000)));
  }
  return new Request(normalized, { method: 'GET' });
}

function failure(status, code, message) {
  return Response.json({ error: message, code }, { status, headers: {
    'Cache-Control': 'no-store', 'Retry-After': '60',
    'Access-Control-Allow-Origin': '*', 'X-Edge-Build': BUILD,
  } });
}

function finish(response, request, cacheLabel) {
  const headers = new Headers(response.headers);
  headers.set('X-Edge-Build', BUILD);
  if (cacheLabel) headers.set('X-Cache', cacheLabel);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
}

async function legacyImage(request, cache) {
  if (!cache) return null;
  const url = new URL(request.url);
  url.hostname = 'skinsdata.top';
  url.searchParams.delete('format');
  const cached = await cache.match(new Request(url));
  if (!cached || cached.status !== 200 || !cached.headers.get('Content-Type')?.startsWith('image/')) return null;
  if (cached.headers.get('Content-Type').includes('webp') && !(request.headers.get('Accept') || '').includes('image/webp')) return null;
  return cached;
}

export async function gateway(request, ctx, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const url = new URL(request.url);
  let canonical;
  try { canonical = canonicalRequest(request); }
  catch { return failure(400, 'INVALID_REQUEST', '图片或分页参数无效'); }
  // Wildcard routes can also match /api/skinsXYZ: pass these to the original server.
  if (!canonical) return fetchImpl(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store',
  } });
  if (!['GET', 'HEAD'].includes(request.method)) return failure(405, 'METHOD_NOT_ALLOWED', '仅支持读取');
  if (request.headers.has('Authorization')) {
    const origin = await fetchImpl(request);
    const headers = new Headers(origin.headers);
    headers.set('Cache-Control', 'private, no-store');
    return new Response(origin.body, { status: origin.status, headers });
  }
  let response;
  try { response = await ctx.exports.PublicCache.fetch(canonical); }
  catch { response = failure(503, 'UPSTREAM_UNAVAILABLE', '数据服务暂不可用，请稍后重试'); }
  if (!response.ok && url.pathname.startsWith('/img/')) {
    // Preserve already populated, pre-upgrade edge images during the source outage.
    const cache = deps.cache || globalThis.caches?.default;
    const previous = await legacyImage(request, cache);
    if (previous) {
      await response.body?.cancel();
      return finish(previous, request, 'LEGACY-HIT');
    }
  }
  return finish(response, request);
}

async function readJsonArray(response) {
  const length = Number(response.headers.get('Content-Length'));
  if (length > MAX_JSON_BYTES) { await response.body?.cancel(); throw new Error('PAYLOAD_TOO_LARGE'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('EMPTY_PAYLOAD');
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_JSON_BYTES) { await reader.cancel(); throw new Error('PAYLOAD_TOO_LARGE'); }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  if (!Array.isArray(JSON.parse(new TextDecoder().decode(body)))) throw new Error('INVALID_PAYLOAD');
  return body;
}

async function markQuota(cache, ctx) {
  if (!cache) return;
  ctx.waitUntil(cache.put(new Request(QUOTA_KEY), new Response('restricted', {
    headers: { 'Cache-Control': 'public, max-age=60' },
  })).catch(() => console.warn('quota_circuit_cache_write_failed')));
}

export async function fillPublicCache(request, ctx, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const cache = deps.cache || globalThis.caches?.default;
  const url = new URL(request.url);
  const isImage = url.pathname.startsWith('/img/');
  if (isImage) {
    const legacy = new Request(request, { headers: { Accept: url.searchParams.get('format') === 'webp' ? 'image/webp' : 'image/*' } });
    const cached = await legacyImage(legacy, cache);
    if (cached) return finish(cached, request, 'LEGACY-HIT');
  }
  if (cache && await cache.match(new Request(QUOTA_KEY))) {
    return failure(503, 'EGRESS_QUOTA_EXCEEDED', '数据服务流量额度已用尽，服务暂不可用 (exceed_egress_quota)');
  }
  const apiTtl = API_TTL[url.pathname];
  if (!isImage && !apiTtl) return failure(404, 'NOT_FOUND', 'Not found');
  let originUrl;
  const headers = new Headers();
  if (isImage) {
    const transformed = url.searchParams.has('width');
    originUrl = new URL(`${STORAGE}/${transformed ? 'render/image' : 'object'}/public/skin-images${url.pathname.slice(4)}`);
    if (transformed) {
      for (const key of ['width', 'height', 'quality', 'resize']) originUrl.searchParams.set(key, url.searchParams.get(key));
      if (url.searchParams.get('format') === 'origin') originUrl.searchParams.set('format', 'origin');
    }
    headers.set('Accept', url.searchParams.get('format') === 'webp' ? 'image/webp' : 'image/*');
  } else {
    // Same-zone fetch goes to the Vercel origin (global_fetch_private_origin flag).
    // The Vercel API owns schema mapping and special-resource categories.
    originUrl = new URL(url.pathname + url.search, 'https://www.skinsdata.top');
    headers.set('Accept', 'application/json');
  }
  let origin;
  try {
    origin = await fetchImpl(originUrl.toString(), { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  } catch {
    return failure(503, 'UPSTREAM_UNAVAILABLE', '数据服务暂不可用，请稍后重试');
  }
  if (!origin.ok) {
    // Vercel maps the quota error to 500; Storage returns 402 directly.
    let quota = origin.status === 402;
    if (!isImage && /json/.test(origin.headers.get('Content-Type') || '')) {
      try {
        const reader = origin.body?.getReader();
        let detail = '';
        let remaining = 4096;
        const decoder = new TextDecoder();
        while (reader && remaining > 0) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = value.subarray(0, remaining);
          detail += decoder.decode(chunk, { stream: true });
          remaining -= chunk.length;
          if (detail.includes('exceed_egress_quota')) { quota = true; break; }
        }
        await reader?.cancel();
      } catch { /* Preserve a bounded, public error response. */ }
    } else await origin.body?.cancel();
    if (quota) await markQuota(cache, ctx);
    return failure(quota ? 503 : origin.status === 404 ? 404 : 502,
      quota ? 'EGRESS_QUOTA_EXCEEDED' : 'UPSTREAM_UNAVAILABLE',
      quota ? '数据服务流量额度已用尽，服务暂不可用 (exceed_egress_quota)' : '数据服务暂不可用，请稍后重试');
  }
  // Supabase's public image responses can carry Cloudflare's bot cookie even
  // without user credentials. Allow only that cookie on images; responseHeaders
  // below deliberately omits it. APIs and unknown/session cookies stay rejected.
  const cookies = origin.headers.getSetCookie();
  const hasUnsafeCookie = cookies.some(cookie => !isImage || !/^__cf_bm=/.test(cookie.trimStart()));
  if (origin.status !== 200 || hasUnsafeCookie) {
    await origin.body?.cancel();
    return failure(502, 'INVALID_UPSTREAM', '数据服务返回异常');
  }
  const responseHeaders = new Headers({
    'Access-Control-Allow-Origin': '*', 'X-Edge-Build': BUILD,
    'X-Origin-Fetched-At': new Date().toISOString(),
    'X-Content-Type-Options': 'nosniff',
  });
  if (isImage) {
    const type = origin.headers.get('Content-Type') || '';
    if (!type.startsWith('image/')) { await origin.body?.cancel(); return failure(502, 'INVALID_IMAGE', '图片服务返回异常'); }
    responseHeaders.set('Content-Type', type);
    responseHeaders.set('Cache-Control', 'public, max-age=2592000, immutable, stale-if-error=604800');
    return new Response(origin.body, { headers: responseHeaders });
  }
  let body;
  try { body = await readJsonArray(origin); }
  catch { return failure(502, 'INVALID_PAYLOAD', '数据服务返回格式异常'); }
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  const ttl = url.searchParams.has('refresh') ? 60 : apiTtl;
  responseHeaders.set('Cache-Control', 'public, max-age=60');
  // s-maxage implies proxy-revalidate and disables stale-if-error in Workers Cache.
  responseHeaders.set('Cloudflare-CDN-Cache-Control', `public, max-age=${ttl}, stale-if-error=86400`);
  for (const key of ['X-Total', 'X-Limit', 'X-Offset']) {
    const value = origin.headers.get(key);
    if (value !== null) responseHeaders.set(key, value);
  }
  return new Response(body, { headers: responseHeaders });
}
