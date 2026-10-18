const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLocalStorage, localImageUrls, validKey } = require('../self-hosted/image-store.cjs');

test('self-hosted image URLs replace only the known public source, including nested admin data', () => {
  const source = 'https://erphrsydujqrcvtpdtnf.supabase.co/storage/v1/object/public/skin-images/skin/a.png';
  const result = localImageUrls({ rows: [{ image: source }], unrelated: 'https://example.com/img/a.png', note: 'text' });
  assert.equal(result.rows[0].image, 'https://youtiao.fun/hokskins/img/skin/a.png');
  assert.equal(result.unrelated, 'https://example.com/img/a.png');
  assert.equal(localImageUrls('https://skinsdata.top/img/tag/a.png?width=120'), 'https://youtiao.fun/hokskins/img/tag/a.png?width=120');
  assert.equal(result.note, 'text');
});

test('local storage rejects traversal, non-image files, invalid bytes and unknown buckets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hok-image-test-'));
  try {
    const store = createLocalStorage({ root, python: process.platform === 'win32' ? 'python' : 'python3' });
    for (const key of ['../app/server.cjs', 'skin/../a.png', 'skin/a.svg', 'skin/a.png/../../x', '/skin/a.png']) {
      assert.equal(validKey(key), false);
      assert.ok((await store.from('skin-images').remove([key])).error);
    }
    assert.ok((await store.from('other').upload('skin/a.png', Buffer.from('x'), { contentType: 'image/png' })).error);
    assert.ok((await store.from('skin-images').upload('skin/a.png', Buffer.from('<html>'), { contentType: 'image/png' })).error);
    assert.equal((await fs.readdir(root)).includes('public'), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('validated upload publishes originals and thumbnails locally; delete removes both', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hok-image-test-'));
  const bytes = require('node:child_process').execFileSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-c', "from PIL import Image; import sys; Image.new('RGB',(100,100),'red').save(sys.stdout.buffer,format='PNG')"], { windowsHide: true });
  try {
    const bucket = createLocalStorage({ root, python: process.platform === 'win32' ? 'python' : 'python3' }).from('skin-images');
    const uploaded = await bucket.upload('skin/test.png', bytes, { contentType: 'image/png' });
    assert.equal(uploaded.error, null);
    assert.deepEqual(await fs.readFile(path.join(root, 'public/originals/hokskins/img/skin/test.png')), bytes);
    assert.ok((await fs.stat(path.join(root, 'public/thumbs/80/hokskins/img/skin/test.png'))).size > 0);
    assert.match(bucket.getPublicUrl('skin/test.png').data.publicUrl, /^https:\/\/youtiao.fun\/hokskins\/img\/skin\/test.png\?v=\d+$/);
    assert.equal((await bucket.remove(['skin/test.png'])).error, null);
    await assert.rejects(fs.stat(path.join(root, 'public/originals/hokskins/img/skin/test.png')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(root, 'public/thumbs/80/hokskins/img/skin/test.png')), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
