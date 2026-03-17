"""
api/admin.py  —  Vercel Serverless Function（Python runtime）
处理后台所有请求：登录、数据编辑、Excel 导入
"""

import json, os, re, base64, io, hashlib
from http.server import BaseHTTPRequestHandler

# ── 依赖（Vercel 自动安装）──────────────────────────────────
try:
    from supabase import create_client
    import bcrypt, jwt
    from openpyxl import load_workbook
    from PIL import Image
    import zipfile, xml.etree.ElementTree as ET
except ImportError:
    pass  # Vercel 会从 requirements.txt 安装

SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')  # service_role key
JWT_SECRET   = os.environ.get('JWT_SECRET', 'change-me-in-env')

def get_client():
    return create_client(SUPABASE_URL, SUPABASE_KEY)

# ── JWT 验证 ────────────────────────────────────────────────
def verify_token(headers):
    auth = headers.get('Authorization', '') or headers.get('authorization', '')
    if not auth.startswith('Bearer '):
        return None
    token = auth[7:]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])
        return payload  # {'username': ..., 'role': ..., 'display_name': ...}
    except Exception:
        return None

def require_auth(headers):
    user = verify_token(headers)
    if not user:
        return None, json_response({'error': '未登录或登录已过期'}, 401)
    return user, None

def require_admin(headers):
    user, err = require_auth(headers)
    if err: return None, err
    if user.get('role') != 'admin':
        return None, json_response({'error': '需要管理员权限'}, 403)
    return user, None

# ── 响应工具 ────────────────────────────────────────────────
def json_response(data, status=200):
    return {
        'statusCode': status,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        },
        'body': json.dumps(data, ensure_ascii=False, default=str)
    }

# ── 路由处理 ────────────────────────────────────────────────
def handle(event):
    method  = event.get('httpMethod', 'GET')
    path    = event.get('path', '/')
    headers = event.get('headers', {})
    body_str = event.get('body', '') or ''
    body    = {}
    if body_str:
        try: body = json.loads(body_str)
        except: pass

    # CORS preflight
    if method == 'OPTIONS':
        return json_response({})

    # ── POST /api/admin/login ──
    if path.endswith('/login') and method == 'POST':
        return handle_login(body)

    # ── GET /api/admin/me ──
    if path.endswith('/me') and method == 'GET':
        user, err = require_auth(headers)
        if err: return err
        return json_response({'user': user})

    # ── GET /api/admin/users ── (admin only)
    if path.endswith('/users') and method == 'GET':
        user, err = require_admin(headers)
        if err: return err
        return handle_list_users()

    # ── POST /api/admin/users ── (admin only: create user)
    if path.endswith('/users') and method == 'POST':
        user, err = require_admin(headers)
        if err: return err
        return handle_create_user(body, user)

    # ── DELETE /api/admin/users/{id} ──
    if '/users/' in path and method == 'DELETE':
        user, err = require_admin(headers)
        if err: return err
        uid = path.split('/')[-1]
        return handle_delete_user(uid, user)

    # ── GET /api/admin/skins ──
    if path.endswith('/skins') and method == 'GET':
        user, err = require_auth(headers)
        if err: return err
        params = event.get('queryStringParameters') or {}
        return handle_list_skins(params)

    # ── PUT /api/admin/skins/{id} ──
    if '/skins/' in path and method == 'PUT':
        user, err = require_auth(headers)
        if err: return err
        skin_id = path.split('/')[-1]
        return handle_update_skin(skin_id, body, user)

    # ── DELETE /api/admin/skins/{id} ──
    if '/skins/' in path and method == 'DELETE':
        user, err = require_auth(headers)
        if err: return err
        skin_id = path.split('/')[-1]
        return handle_delete_skin(skin_id, user)

    # ── POST /api/admin/skins/batch-update ──
    if path.endswith('/batch-update') and method == 'POST':
        user, err = require_auth(headers)
        if err: return err
        return handle_batch_update(body, user)

    # ── POST /api/admin/import ──
    if path.endswith('/import') and method == 'POST':
        user, err = require_auth(headers)
        if err: return err
        return handle_import(body, user)

    return json_response({'error': '接口不存在'}, 404)

# ── 登录 ─────────────────────────────────────────────────────
def handle_login(body):
    username = body.get('username', '').strip()
    password = body.get('password', '')
    if not username or not password:
        return json_response({'error': '请填写用户名和密码'}, 400)

    client = get_client()
    res = client.table('admin_users').select('*').eq('username', username).execute()
    if not res.data:
        return json_response({'error': '用户名或密码错误'}, 401)

    user = res.data[0]
    if not bcrypt.checkpw(password.encode(), user['password_hash'].encode()):
        return json_response({'error': '用户名或密码错误'}, 401)

    token = jwt.encode({
        'username':     user['username'],
        'display_name': user['display_name'],
        'role':         user['role'],
        'exp':          int(__import__('time').time()) + 86400 * 7  # 7天
    }, JWT_SECRET, algorithm='HS256')

    return json_response({'token': token, 'user': {
        'username': user['username'],
        'display_name': user['display_name'],
        'role': user['role'],
    }})

# ── 用户管理 ─────────────────────────────────────────────────
def handle_list_users():
    client = get_client()
    res = client.table('admin_users').select('id,username,display_name,role,created_at').execute()
    return json_response({'users': res.data})

def handle_create_user(body, operator):
    username     = body.get('username', '').strip()
    password     = body.get('password', '')
    display_name = body.get('display_name', username)
    role         = body.get('role', 'editor')
    if not username or not password:
        return json_response({'error': '用户名和密码不能为空'}, 400)
    if role not in ('admin', 'editor'):
        return json_response({'error': '角色只能是 admin 或 editor'}, 400)

    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    client = get_client()
    try:
        res = client.table('admin_users').insert({
            'username': username, 'password_hash': pw_hash,
            'display_name': display_name, 'role': role
        }).execute()
        _log(client, operator['username'], 'create_user', None, {'new_user': username})
        return json_response({'user': res.data[0]})
    except Exception as e:
        return json_response({'error': f'创建失败，用户名可能已存在：{e}'}, 400)

def handle_delete_user(uid, operator):
    client = get_client()
    client.table('admin_users').delete().eq('id', uid).execute()
    _log(client, operator['username'], 'delete_user', None, {'user_id': uid})
    return json_response({'ok': True})

# ── 皮肤数据 ─────────────────────────────────────────────────
def handle_list_skins(params):
    client = get_client()
    q = client.table('skins').select('*')

    if params.get('hero'):   q = q.eq('hero',    params['hero'])
    if params.get('quality'): q = q.eq('quality', params['quality'])
    if params.get('type'):   q = q.eq('type',    params['type'])
    if params.get('search'):
        s = params['search']
        q = q.or_(f'name.ilike.%{s}%,hero.ilike.%{s}%')

    page     = int(params.get('page', 1))
    per_page = int(params.get('per_page', 50))
    offset   = (page - 1) * per_page
    q = q.order('date', desc=True).range(offset, offset + per_page - 1)

    res = client.table('skins').select('*', count='exact')
    # re-apply filters for count
    if params.get('hero'):    res = res.eq('hero',    params['hero'])
    if params.get('quality'): res = res.eq('quality', params['quality'])
    if params.get('type'):    res = res.eq('type',    params['type'])

    data_res  = q.execute()
    count_res = res.execute()

    return json_response({
        'skins': data_res.data,
        'total': count_res.count,
        'page': page, 'per_page': per_page
    })

def handle_update_skin(skin_id, body, user):
    allowed = {'date','name','quality','tag','hero','job','price','obtain','type','permanent'}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        return json_response({'error': '没有可更新的字段'}, 400)

    client = get_client()
    # 记录修改前的值
    before = client.table('skins').select('*').eq('id', skin_id).execute()
    before_data = before.data[0] if before.data else {}

    res = client.table('skins').update(updates).eq('id', skin_id).execute()
    _log(client, user['username'], 'update', int(skin_id), {
        'before': {k: before_data.get(k) for k in updates},
        'after':  updates
    })
    return json_response({'skin': res.data[0] if res.data else {}})

def handle_delete_skin(skin_id, user):
    client = get_client()
    before = client.table('skins').select('*').eq('id', skin_id).execute()
    client.table('skins').delete().eq('id', skin_id).execute()
    _log(client, user['username'], 'delete', int(skin_id), {'deleted': before.data[0] if before.data else {}})
    return json_response({'ok': True})

def handle_batch_update(body, user):
    ids     = body.get('ids', [])
    updates = body.get('updates', {})
    allowed = {'quality','tag','hero','job','price','obtain','type','permanent'}
    updates = {k: v for k, v in updates.items() if k in allowed}
    if not ids or not updates:
        return json_response({'error': '请提供 ids 和 updates'}, 400)

    client = get_client()
    res = client.table('skins').update(updates).in_('id', ids).execute()
    _log(client, user['username'], 'batch_update', None, {'ids': ids, 'updates': updates})
    return json_response({'updated': len(res.data)})

# ── Excel 导入 ───────────────────────────────────────────────
def handle_import(body, user):
    """
    body: {
      file_b64: <base64 of xlsx>,
      mode: 'append' | 'overwrite'   (append=只加新记录, overwrite=先清空再导入)
    }
    """
    file_b64 = body.get('file_b64', '')
    mode     = body.get('mode', 'append')
    if not file_b64:
        return json_response({'error': '请提供 file_b64'}, 400)

    try:
        xlsx_bytes = base64.b64decode(file_b64)
    except Exception:
        return json_response({'error': 'base64 解码失败'}, 400)

    # 解析 Excel
    try:
        records, img_records = parse_excel(io.BytesIO(xlsx_bytes))
    except Exception as e:
        return json_response({'error': f'Excel 解析失败：{e}'}, 400)

    client = get_client()

    # 上传图片（upsert，重复忽略）
    BATCH = 50
    for i in range(0, len(img_records), BATCH):
        client.table('images').upsert(img_records[i:i+BATCH], on_conflict='img_id').execute()

    if mode == 'overwrite':
        client.table('skins').delete().neq('id', 0).execute()
        for i in range(0, len(records), BATCH):
            client.table('skins').insert(records[i:i+BATCH]).execute()
        inserted = len(records); skipped = 0
    else:
        # append: 跳过已存在的（按 hero+name+date+type 判断）
        existing = client.table('skins').select('hero,name,date,type').execute().data
        existing_keys = {(r['hero'], r['name'], r['date'], r['type']) for r in existing}
        new_records = [r for r in records
                       if (r['hero'], r['name'], r['date'], r['type']) not in existing_keys]
        for i in range(0, len(new_records), BATCH):
            client.table('skins').insert(new_records[i:i+BATCH]).execute()
        inserted = len(new_records); skipped = len(records) - len(new_records)

    _log(client, user['username'], 'import', None, {
        'mode': mode, 'total': len(records), 'inserted': inserted, 'skipped': skipped
    })
    return json_response({'inserted': inserted, 'skipped': skipped, 'images': len(img_records)})


def parse_excel(file_obj):
    """解析 Excel，返回 (skin_records, image_records)"""
    import pandas as pd
    df = pd.read_excel(file_obj)
    df['日期'] = df['日期'].dt.strftime('%Y-%m-%d')

    def extract_img_id(val):
        if not isinstance(val, str): return ''
        m = re.search(r'ID_([A-Fa-f0-9]+)', val)
        return m.group(1) if m else ''

    df['si'] = df['皮肤图片'].apply(extract_img_id)
    df['qi'] = df['皮肤品质图片'].apply(extract_img_id)

    # 提取图片（Excel 需要重新打开为 zipfile）
    file_obj.seek(0)
    id_to_raw = {}
    try:
        with zipfile.ZipFile(file_obj) as z:
            ci_xml  = z.read('xl/cellimages.xml').decode('utf-8')
            ci_rels = z.read('xl/_rels/cellimages.xml.rels').decode('utf-8')
            rels    = ET.fromstring(ci_rels)
            rid2f   = {r.get('Id'): r.get('Target') for r in rels}
            root    = ET.fromstring(ci_xml)
            ns = {
                'etc': 'http://www.wps.cn/officeDocument/2017/etCustomData',
                'xdr': 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
                'r':   'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
                'a':   'http://schemas.openxmlformats.org/drawingml/2006/main'
            }
            for ci in root.findall('etc:cellImage', ns):
                pic  = ci.find('xdr:pic', ns)
                nvpr = pic.find('xdr:nvPicPr/xdr:cNvPr', ns)
                blip = pic.find('xdr:blipFill/a:blip', ns)
                name = nvpr.get('name', '')
                rid  = blip.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed')
                if rid and rid in rid2f and name.startswith('ID_'):
                    id_to_raw[name[3:]] = z.read('xl/' + rid2f[rid])
    except Exception:
        pass  # 没有图片也继续

    # 处理图片
    img_records = []
    seen = {}
    def add_img(img_id, raw, img_type):
        if not img_id or not raw: return
        try:
            img = Image.open(io.BytesIO(raw))
            if img_type == 'skin':
                img = img.convert('RGB')
                buf = io.BytesIO(); img.save(buf, 'JPEG', quality=80, optimize=True)
                mime = 'image/jpeg'
            else:
                w,h = img.size; new_w = int(w*30/h)
                img = img.resize((new_w,30), Image.LANCZOS)
                buf = io.BytesIO(); img.save(buf, 'PNG', optimize=True)
                mime = 'image/png'
            data = buf.getvalue()
            h_key = hashlib.md5(data).hexdigest()
            if h_key not in seen:
                seen[h_key] = img_id
                img_records.append({'img_id': img_id, 'img_type': img_type,
                                    'data': base64.b64encode(data).decode(), 'mime_type': mime})
        except Exception:
            pass

    skin_ids = set(df['si'].dropna()) - {''}
    tag_ids  = set(df['qi'].dropna()) - {''}
    for iid in skin_ids:
        if iid in id_to_raw: add_img(iid, id_to_raw[iid], 'skin')
    for iid in tag_ids:
        if iid in id_to_raw: add_img(iid, id_to_raw[iid], 'tag')

    # 组织皮肤记录
    records = []
    for _, row in df.iterrows():
        records.append({
            'date':       row['日期'],
            'name':       str(row['皮肤名称']),
            'quality':    str(row['皮肤品质']),
            'tag':        str(row['皮肤标签']) if pd.notna(row.get('皮肤标签')) else '',
            'hero':       str(row['归属英雄']),
            'job':        str(row['英雄职业']) if pd.notna(row.get('英雄职业')) else '',
            'price':      str(row['价格']) if pd.notna(row.get('价格')) else '',
            'obtain':     str(row['获取方式']) if pd.notna(row.get('获取方式')) else '',
            'type':       str(row['首发or返场']),
            'permanent':  str(row['是否常驻']),
            'skin_img_id': row['si'],
            'tag_img_id':  row['qi'],
        })
    return records, img_records


# ── 操作日志 ─────────────────────────────────────────────────
def _log(client, operator, action, target_id, detail):
    try:
        client.table('audit_log').insert({
            'operator':  operator,
            'action':    action,
            'target_id': target_id,
            'detail':    detail,
        }).execute()
    except Exception:
        pass


# ── Vercel handler 入口 ──────────────────────────────────────
class handler(BaseHTTPRequestHandler):
    def do_GET(self):    self._handle()
    def do_POST(self):   self._handle()
    def do_PUT(self):    self._handle()
    def do_DELETE(self): self._handle()
    def do_OPTIONS(self): self._handle()

    def _handle(self):
        content_len = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_len).decode() if content_len else ''
        event = {
            'httpMethod': self.command,
            'path': self.path.split('?')[0],
            'headers': dict(self.headers),
            'body': body,
            'queryStringParameters': dict(
                p.split('=', 1) for p in (self.path.split('?')[1].split('&') if '?' in self.path else []) if '=' in p
            )
        }
        result = handle(event)
        self.send_response(result['statusCode'])
        for k, v in result['headers'].items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(result['body'].encode())
