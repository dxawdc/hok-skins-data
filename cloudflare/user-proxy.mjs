const ROUTES = new Map([
  ['/api/user/session', ['POST', 'DELETE']],
  ['/api/user/profile', ['GET', 'PATCH']],
  ['/api/user/profile/avatar', ['POST']],
  ['/api/user/marks', ['GET']],
  ['/api/user/marks/batch', ['POST']],
]);

function privateHeaders() {
  return new Headers({
    'Cache-Control': 'private, no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    'CDN-Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'X-Content-Type-Options': 'nosniff',
    'X-Hokskins-User-Origin': 'youtiao',
  });
}
function failure(status, code) {
  const headers = privateHeaders();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify({ error: { code, message: '用户服务暂不可用，请稍后重试' } }), { status, headers });
}

// Old published Mini Programs retain their sessions and use the same user DB
// as the new client. This handler never invokes the public cache entrypoint.
export async function proxyUser(request, fetchImpl = fetch) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/\/+$/, '');
  const methods = ROUTES.get(route);
  if (!methods) return failure(404, 'NOT_FOUND');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: privateHeaders() });
  if (!methods.includes(request.method)) return failure(405, 'METHOD_NOT_ALLOWED');
  const limit = route.endsWith('/avatar') ? 2 * 1024 * 1024 + 64 * 1024 : 256 * 1024;
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) return failure(413, 'REQUEST_TOO_LARGE');
  const target = new URL('https://youtiao.fun/hokskins' + route);
  if (route === '/api/user/marks' && url.searchParams.has('revision')) target.searchParams.set('revision', url.searchParams.get('revision'));
  const headers = new Headers({ Accept: 'application/json' });
  for (const name of ['Authorization', 'Content-Type', 'Content-Length']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  try {
    const upstream = await fetchImpl(target.toString(), {
      method: request.method, headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(20000),
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return failure(502, 'INVALID_USER_UPSTREAM');
    }
    if (upstream.status !== 204 && !/application\/json/i.test(upstream.headers.get('Content-Type') || '')) {
      await upstream.body?.cancel();
      return failure(502, 'INVALID_USER_UPSTREAM');
    }
    const resultHeaders = privateHeaders();
    for (const name of ['Content-Type', 'Retry-After', 'Allow']) {
      const value = upstream.headers.get(name);
      if (value !== null) resultHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: resultHeaders });
  } catch { return failure(503, 'USER_UPSTREAM_UNAVAILABLE'); }
}
