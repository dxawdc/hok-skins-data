"""Build scoped patches from an inspected copy of the independent hokskins app."""
import hashlib
import pathlib
import sys
from importlib.util import module_from_spec, spec_from_file_location

source, output = map(pathlib.Path, sys.argv[1:])
output.mkdir(parents=True, exist_ok=True)

def read(name, expected_hash=None):
    content = (source / name).read_bytes()
    if expected_hash and hashlib.sha256(content).hexdigest() != expected_hash:
        raise ValueError('Production source changed: ' + name)
    return content.decode('utf-8').replace('\r\n', '\n')

def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError('Patch anchor must match exactly once: ' + old[:60])
    return text.replace(old, new, 1)

server = read('server.before.cjs', '764af84b3f21b7f4984bc8452c43234546456bb589c6949a73c90f497ea83940')
server = replace_once(server, "const jwt = require('jsonwebtoken');", "const jwt = require('jsonwebtoken');\nconst { localImageUrls } = require('./lib/image-store.cjs');")
server = replace_once(server, 'res.end(JSON.stringify(value)); return res;', 'res.end(JSON.stringify(localImageUrls(value))); return res;')
server = replace_once(server, "      if (route === '/api/admin/images') { res.status(503).json({ error: '图片尚未迁移，此入口暂不开放上传或删除', code: 'STORAGE_NOT_MIGRATED' }); return; }\n", '')
(output / 'server.cjs').write_text(server, encoding='utf-8')

client = read('data-client.before.js', 'f3404e8c825b8e982097fa2a827361cc90524c36a28ea2ba1ad8b887dc625797')
client = replace_once(client, "const { createClient: createSupabaseClient } = require('@supabase/supabase-js');", "const { createClient: createSupabaseClient } = require('@supabase/supabase-js');\nconst { createLocalStorage } = require('./image-store.cjs');\nconst storage = createLocalStorage();")
client = replace_once(client, '  return createSupabaseClient(url, key, {', '  const client = createSupabaseClient(url, key, {')
client = replace_once(client, '  });\n}\n', "  });\n  Object.defineProperty(client, 'storage', { value: storage });\n  return client;\n}\n")
client = client.replace('图片迁移尚未完成，新站暂不提供图片上传、删除及头像服务', '独立数据接口仅允许本机 REST 请求').replace('STORAGE_NOT_MIGRATED', 'UNSUPPORTED_LOCAL_DATA_PATH')
(output / 'data-client.js').write_text(client, encoding='utf-8')

# Admin responses must use res.json as well, so previews receive local image URLs.
spec = spec_from_file_location('prepare_admin', pathlib.Path(__file__).with_name('prepare-admin.py'))
admin_adapter = module_from_spec(spec)
spec.loader.exec_module(admin_adapter)
(output / 'admin.js').write_text(admin_adapter.prepare(read('admin.before.js')), encoding='utf-8')

for name in ['index', 'admin']:
    html = read(name + '.before.html')
    if name == 'admin':
        html = admin_adapter.prepare_html(html)
    if 'https://skinsdata.top/img' not in html:
        raise ValueError('Image source anchor missing')
    html = html.replace('https://skinsdata.top/img', 'https://youtiao.fun/hokskins/img')
    html = replace_once(html, '图片迁移中', '图片已迁移 · 2026-10-18')
    # Preserve the upload's version parameter while selecting local thumbnails.
    html = html.replace('${cdnUrl}?width=', "${cdnUrl}${cdnUrl.includes('?') ? '&' : '?'}width=")
    html = html.replace('${cdn}?width=', "${cdn}${cdn.includes('?') ? '&' : '?'}width=")
    if name == 'index':
        # Keep list traffic small on the shared host; full-size detail images remain available.
        html = replace_once(html, 'const imgSrc = r.img_url ? toCdnUrl(r.img_url) : null;', 'const imgSrc = r.img_url ? thumbUrl(r.img_url, 320) : null;')
        html = replace_once(html, 'const tagImgSrc = r.tag_img_url ? toCdnUrl(r.tag_img_url) : null;', 'const tagImgSrc = r.tag_img_url ? thumbUrl(r.tag_img_url, 160) : null;')
        html = replace_once(html, 'const resourceImg = resource.img_url ? toCdnUrl(resource.img_url) : null;', 'const resourceImg = resource.img_url ? thumbUrl(resource.img_url, 200) : null;')
    (output / (name + '.html')).write_text(html, encoding='utf-8')

snippet = read('nginx.before.conf')
snippet = 'include /etc/nginx/snippets/hokskins-images.conf;\n' + snippet
(output / 'hokskins.conf').write_text(snippet, encoding='utf-8')
