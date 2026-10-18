'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY = new RegExp('^avatars/' + UUID + '/' + UUID + '\\.(png|jpg|webp)$');
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const PREFIX = '/hokskins/avatar/';

// Private files never live below the public image directory. Only expiring,
// purpose-bound signed URLs can read them; all responses prohibit caching.
function createAvatarStorage(options = {}) {
  const root = options.root || '/opt/hokskins/storage/private/miniprogram-avatars';
  const secret = options.secret || process.env.JWT_SECRET;
  const now = options.now || (() => Math.floor(Date.now() / 1000));
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Avatar signing key unavailable');
  function check(key) { if (typeof key !== 'string' || !KEY.test(key)) throw new Error('Invalid avatar path'); }
  function sign(key, expires) {
    return crypto.createHmac('sha256', secret).update('hokskins-private-avatar-v1\n' + key + '\n' + expires).digest('base64url');
  }
  const failure = () => ({ data: null, error: { message: 'Private avatar storage unavailable' } });
  return {
    from(bucket) {
      function validate(key) { if (bucket !== 'miniprogram-avatars') throw new Error('Invalid bucket'); check(key); }
      return {
        async upload(key, bytes, uploadOptions = {}) {
          try {
            validate(key);
            const extension = key.split('.').pop();
            if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 2 * 1024 * 1024 || uploadOptions.upsert !== false || uploadOptions.contentType !== TYPES[extension]) throw new Error('Invalid avatar');
            const magic = extension === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
              : extension === 'jpg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
                : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
            if (!magic) throw new Error('Invalid image bytes');
            const file = path.join(root, key);
            await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
            // A new random immutable filename is linked to the profile only after
            // this write completes. Existing files are never overwritten.
            await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
            return { data: { path: key }, error: null };
          } catch { return failure(); }
        },
        async remove(keys) {
          try {
            if (!Array.isArray(keys) || keys.length > 20) throw new Error('Invalid keys');
            keys.forEach(validate);
            for (const key of keys) await fs.rm(path.join(root, key), { force: true });
            return { data: keys.map(name => ({ name })), error: null };
          } catch { return failure(); }
        },
        async createSignedUrl(key, ttl) {
          try {
            validate(key);
            if (!Number.isInteger(ttl) || ttl < 1 || ttl > 3600) throw new Error('Invalid expiry');
            if (!(await fs.stat(path.join(root, key))).isFile()) throw new Error('Missing avatar');
            const expires = now() + ttl;
            return { data: { signedUrl: 'https://youtiao.fun' + PREFIX + key + '?expires=' + expires + '&signature=' + sign(key, expires) }, error: null };
          } catch { return failure(); }
        },
      };
    },
    async serve(req, res, url) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (!['GET', 'HEAD'].includes(req.method)) { res.statusCode = 405; res.end(); return; }
      try {
        const key = url.pathname.slice(PREFIX.length);
        check(key);
        const expires = url.searchParams.get('expires') || '';
        const signature = url.searchParams.get('signature') || '';
        if (!/^\d{10}$/.test(expires) || Number(expires) <= now() || Number(expires) > now() + 3600 || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new Error('Invalid signature');
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(sign(key, expires)))) throw new Error('Invalid signature');
        const bytes = await fs.readFile(path.join(root, key));
        if (bytes.length > 2 * 1024 * 1024) throw new Error('Invalid size');
        res.setHeader('Content-Type', TYPES[key.split('.').pop()]);
        res.setHeader('Content-Length', bytes.length);
        res.statusCode = 200;
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } catch { res.statusCode = 404; res.end(); }
    },
  };
}

module.exports = { createAvatarStorage };
