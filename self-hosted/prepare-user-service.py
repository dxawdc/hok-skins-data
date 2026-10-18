"""Adapt inspected independent server files; never deploy the destructive schema rebuild."""
import hashlib
import pathlib
import sys

source, output = map(pathlib.Path, sys.argv[1:])
output.mkdir(parents=True, exist_ok=True)


def read(name, digest):
    value = (source / name).read_bytes()
    if hashlib.sha256(value).hexdigest() != digest:
        raise ValueError('Inspected source changed: ' + name)
    return value.decode('utf-8').replace('\r\n', '\n')


def replace(text, old, new):
    if text.count(old) != 1:
        raise ValueError('Patch anchor changed: ' + old[:70])
    return text.replace(old, new, 1)


server = read('server.before.cjs', '6c886e0ccf16a659394f638c8df6fe109a2eee2b0af6875219b7f6174f57d831')
server = replace(server, "const adminHandler = require('./api/admin');", "const adminHandler = require('./api/admin');\nconst userHandler = require('./api/user');\nconst { createAvatarStorage } = require('./lib/avatar-store.cjs');\nconst avatars = createAvatarStorage();")
server = replace(server, "    if (route === '/api/user' || route.startsWith('/api/user/')) {\n      res.status(503).json({ error: { code: 'MINIPROGRAM_NOT_SWITCHED', message: '此独立网页未接管原小程序登录和同步入口' } }); return;\n    }", """    if (route.startsWith('/avatar/')) { await avatars.serve(req, res, url); return; }
    const user = route === '/api/user' || route.startsWith('/api/user/');
    if (user && !fs.existsSync('/opt/hokskins/storage/migration/users-active')) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', '30');
      res.status(503).json({ error: { code: 'MIGRATION_IN_PROGRESS', message: '用户服务迁移中，请稍后重试' } }); return;
    }""")
server = replace(server, 'const handler = admin ? adminHandler : handlers.get(route);', 'const handler = user ? userHandler : admin ? adminHandler : handlers.get(route);')
server = replace(server, 'if (admin) {', 'if (admin || user) {')
server = replace(server, "if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) req.body = await readJson(req);", "if (!user && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) req.body = await readJson(req);")
(output / 'server.cjs').write_text(server, encoding='utf-8', newline='\n')

client = read('data-client.before.js', '8e25fc7d8a5cd528caab324412555fce4692230e3e0d186900a8a8a46526e287')
client = replace(client, 'const storage = createLocalStorage();', "const { createAvatarStorage } = require('./avatar-store.cjs');\nconst publicStorage = createLocalStorage();\nconst privateStorage = createAvatarStorage();\nconst storage = { from(bucket) {\n  return (bucket === 'miniprogram-avatars' ? privateStorage : publicStorage).from(bucket);\n} };")
(output / 'data-client.js').write_text(client, encoding='utf-8', newline='\n')

user = (pathlib.Path(__file__).parent.parent / 'api/user.js').read_text(encoding='utf-8')
user = replace(user, "require('@supabase/supabase-js')", "require('../lib/data-client')")
(output / 'user.js').write_text(user, encoding='utf-8', newline='\n')

nginx = (source / 'nginx.before.conf').read_text(encoding='utf-8')
# Avatar uploads may exceed 1 MB. Override only this exact endpoint, retaining
# the existing generic proxy limit for every other route and the GDN site.
upload_proxy = (source / 'proxy.before.conf').read_text(encoding='utf-8').replace('client_max_body_size 1m;', 'client_max_body_size 3m;')
if 'client_max_body_size 3m;' not in upload_proxy:
    raise ValueError('Unexpected proxy body limit')
(output / 'hokskins-avatar-proxy.conf').write_text(upload_proxy, encoding='utf-8', newline='\n')
nginx += """
location = /hokskins/api/user/profile/avatar {
    limit_req zone=hokskins_requests burst=10 nodelay;
    access_log off;
    include /etc/nginx/snippets/hokskins-avatar-proxy.conf;
}
location ^~ /hokskins/avatar/ {
    limit_req zone=hokskins_requests burst=20 nodelay;
    access_log off;
    include /etc/nginx/snippets/hokskins-proxy.conf;
}
"""
(output / 'hokskins.conf').write_text(nginx, encoding='utf-8', newline='\n')
