'use strict';

const crypto = require('node:crypto');
const ROUTES = new Set(['/api/skins', '/api/heroes', '/api/resources']);

// Exactly three public, unpaginated snapshots. No arbitrary query keys, private
// credentials or per-user state enter this cache. No new service is required.
function createPublicCache({ ttl = 60000, refreshFloor = 5000, maxBytes = 12 * 1024 * 1024,
  now = Date.now, transform = value => value } = {}) {
  const entries = new Map();
  const pending = new Map();
  let generation = 0;
  let bytes = 0;
  const counters = { hits: 0, misses: 0, coalesced: 0, revalidated: 0, invalidations: 0 };

  function eligible(req, route) {
    return ROUTES.has(route) && ['GET', 'HEAD'].includes(req.method) &&
      !req.headers.authorization && !req.headers.cookie &&
      Object.keys(req.query || {}).every(key => key === 'v' || key === 'refresh');
  }

  function invalidate() {
    generation++;
    entries.clear();
    pending.clear();
    bytes = 0;
    counters.invalidations++;
  }

  async function load(req, handler) {
    const headers = {};
    let value;
    const capture = {
      statusCode: 200,
      setHeader(name, content) { headers[name.toLowerCase()] = content; },
      getHeader(name) { return headers[name.toLowerCase()]; },
      status(code) { this.statusCode = code; return this; },
      json(body) { value = body; return this; },
    };
    // Build a full representation even for a conditional or HEAD request.
    await handler({ ...req, headers: req.headers, method: 'GET' }, capture);
    if (capture.statusCode !== 200 || !Array.isArray(value)) {
      return { status: capture.statusCode === 200 ? 502 : capture.statusCode,
        body: Buffer.from(JSON.stringify(value || { error: '数据暂不可用' })), cacheable: false };
    }
    const body = Buffer.from(JSON.stringify(transform(value)));
    const etag = 'W/"' + crypto.createHash('sha256').update(body).digest('hex') + '"';
    return { status: 200, body, etag, at: now(), cacheable: body.length <= maxBytes,
      headers: Object.fromEntries(Object.entries(headers).filter(([key]) =>
        key === 'x-total' || key.startsWith('access-control-'))) };
  }

  async function respond(req, res, route, handler) {
    if (!eligible(req, route)) return false;
    let entry = entries.get(route);
    let cacheState = 'HIT';
    const forced = !!(req.query && req.query.refresh);
    if (!entry || now() - entry.at >= ttl || (forced && now() - entry.at >= refreshFloor)) {
      cacheState = 'MISS';
      let task = pending.get(route);
      if (task) { counters.coalesced++; cacheState = 'COALESCED'; }
      else {
        counters.misses++;
        const startedGeneration = generation;
        task = load(req, handler).then(result => {
          if (generation === startedGeneration && result.cacheable) {
            const previous = entries.get(route);
            if (previous) bytes -= previous.body.length;
            entries.delete(route);
            while (bytes + result.body.length > maxBytes && entries.size) {
              const key = entries.keys().next().value;
              bytes -= entries.get(key).body.length;
              entries.delete(key);
            }
            entries.set(route, result);
            bytes += result.body.length;
          }
          return result;
        }).finally(() => { if (pending.get(route) === task) pending.delete(route); });
        pending.set(route, task);
      }
      entry = await task;
    } else counters.hits++;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // A manual refresh must reach the application even when repeated from a cache.
    res.setHeader('Cache-Control', entry.etag && !forced ? 'public, max-age=60, must-revalidate' : 'no-store');
    res.setHeader('X-Public-Cache', cacheState);
    if (entry.etag) {
      res.setHeader('ETag', entry.etag);
      for (const [key, value] of Object.entries(entry.headers || {})) res.setHeader(key, value);
      const matches = String(req.headers['if-none-match'] || '').split(',').map(value => value.trim().replace(/^W\//, ''));
      if (matches.includes('*') || matches.includes(entry.etag.replace(/^W\//, ''))) {
        counters.revalidated++;
        res.statusCode = 304;
        res.end();
        return true;
      }
    }
    res.statusCode = entry.status;
    res.end(req.method === 'HEAD' ? undefined : entry.body);
    return true;
  }

  return { respond, invalidate, stats: () => ({ ...counters, entries: entries.size, bytes, pending: pending.size }) };
}

module.exports = { createPublicCache };
