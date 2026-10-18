'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const SIZES = [60, 80, 120, 160, 200, 320];
const PREFIX = 'https://youtiao.fun/hokskins/img/';
const SOURCES = [
  'https://erphrsydujqrcvtpdtnf.supabase.co/storage/v1/object/public/skin-images/',
  'https://erphrsydujqrcvtpdtnf.supabase.co/storage/v1/render/image/public/skin-images/',
  'https://skinsdata.top/img/', 'https://www.skinsdata.top/img/',
];
function validKey(key) {
  return typeof key === 'string' && key.length <= 220 && !key.includes('..') &&
    /^(skin|tag|hero|resource)\/[A-Za-z0-9][A-Za-z0-9_.-]*\.(png|jpe?g|webp|gif)$/i.test(key);
}
function localImageUrls(value) {
  if (typeof value === 'string') {
    const source = SOURCES.find(prefix => value.startsWith(prefix));
    if (source) {
      const suffix = value.slice(source.length);
      if (validKey(suffix.split(/[?#]/)[0])) return PREFIX + suffix;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(localImageUrls);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localImageUrls(v)]));
  return value;
}
function createLocalStorage(options = {}) {
  const root = options.root || '/opt/hokskins/storage';
  const python = options.python || '/usr/bin/python3';
  const helper = options.helper || path.join(__dirname, 'prepare-image.py');
  let queue = Promise.resolve();
  let pending = 0;
  function serialize(operation) {
    if (pending >= 8) return Promise.resolve({ data: null, error: { message: '图片队列繁忙，请稍后重试' } });
    pending++;
    const result = queue.then(operation).catch(() => ({ data: null, error: { message: '图片处理失败，请确认图片格式和尺寸' } }));
    queue = result.finally(() => { pending--; });
    return result;
  }
  return { from(bucket) {
    function check(key) {
      if (bucket !== 'skin-images' || !validKey(key)) throw new Error('无效的本地图片路径');
    }
    return {
      upload(key, bytes, options = {}) { return serialize(async () => {
        check(key);
        const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 400 * 1024 || options.contentType !== types[key.split('.').pop().toLowerCase()]) throw new Error('无效图片');
        const staging = path.join(root, '.staging');
        await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
        const input = path.join(staging, crypto.randomUUID());
        try {
          await fsp.writeFile(input, bytes, { flag: 'wx', mode: 0o600 });
          await execute(python, [helper, input, root, key], { timeout: 25000, maxBuffer: 4096, windowsHide: true });
          return { data: { path: key }, error: null };
        } finally { await fsp.rm(input, { force: true }); }
      }); },
      getPublicUrl(key) {
        check(key);
        const file = path.join(root, 'public', 'originals', 'hokskins', 'img', key);
        const version = fs.existsSync(file) ? Math.trunc(fs.statSync(file).mtimeMs) : 0;
        return { data: { publicUrl: PREFIX + key + (version ? '?v=' + version : '') } };
      },
      remove(keys) { return serialize(async () => {
        if (!Array.isArray(keys) || keys.length > 20) throw new Error('无效图片列表');
        keys.forEach(check);
        for (const key of keys) {
          for (const variant of ['originals', ...SIZES.map(size => 'thumbs/' + size)]) {
            await fsp.rm(path.join(root, 'public', variant, 'hokskins', 'img', key), { force: true });
          }
        }
        return { data: keys.map(name => ({ name })), error: null };
      }); },
    };
  } };
}
module.exports = { createLocalStorage, localImageUrls, validKey };
