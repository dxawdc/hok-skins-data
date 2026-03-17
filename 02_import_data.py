#!/usr/bin/env python3
"""
王者荣耀皮肤数据库 - 初始数据导入脚本
将现有 Excel 数据 + 图片一次性导入到 Supabase

使用前：
  pip install supabase pandas openpyxl pillow requests

运行：
  python 02_import_data.py
"""

import json, re, base64, io, os, sys
from datetime import datetime

# ── 填写你的 Supabase 信息 ──────────────────────────────────
SUPABASE_URL = "https://YOUR_PROJECT.supabase.co"   # 改成你的
SUPABASE_KEY = "YOUR_SERVICE_ROLE_KEY"               # 改成 service_role key（不是 anon key）
EXCEL_PATH   = "王者荣耀皮肤数据统计__含图片_.xlsx"   # Excel 文件路径
# ────────────────────────────────────────────────────────────

try:
    from supabase import create_client
    import pandas as pd
    from PIL import Image
    import zipfile, xml.etree.ElementTree as ET
except ImportError as e:
    print(f"缺少依赖：{e}")
    print("请运行：pip install supabase pandas openpyxl pillow")
    sys.exit(1)

client = create_client(SUPABASE_URL, SUPABASE_KEY)

# ── Step 1: 读取 Excel 数据 ──────────────────────────────────
print("📖 读取 Excel...")
df = pd.read_excel(EXCEL_PATH)
df['日期'] = df['日期'].dt.strftime('%Y-%m-%d')

def extract_img_id(val):
    if pd.isna(val) or not isinstance(val, str): return ''
    m = re.search(r'ID_([A-Fa-f0-9]+)', val)
    return m.group(1) if m else ''

df['si'] = df['皮肤图片'].apply(extract_img_id)
df['qi'] = df['皮肤品质图片'].apply(extract_img_id)

# ── Step 2: 提取 Excel 嵌入图片 ─────────────────────────────
print("🖼️  提取嵌入图片...")
id_to_raw = {}
with zipfile.ZipFile(EXCEL_PATH) as z:
    ci_xml     = z.read('xl/cellimages.xml').decode('utf-8')
    ci_rels    = z.read('xl/_rels/cellimages.xml.rels').decode('utf-8')
    rels_root  = ET.fromstring(ci_rels)
    rid_to_file = {r.get('Id'): r.get('Target') for r in rels_root}
    ci_root    = ET.fromstring(ci_xml)
    ns = {
        'etc': 'http://www.wps.cn/officeDocument/2017/etCustomData',
        'xdr': 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
        'r':   'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
        'a':   'http://schemas.openxmlformats.org/drawingml/2006/main'
    }
    for ci in ci_root.findall('etc:cellImage', ns):
        pic   = ci.find('xdr:pic', ns)
        nvpr  = pic.find('xdr:nvPicPr/xdr:cNvPr', ns)
        blip  = pic.find('xdr:blipFill/a:blip', ns)
        name  = nvpr.get('name', '')
        rid   = blip.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed')
        if rid and rid in rid_to_file and name.startswith('ID_'):
            id_to_raw[name[3:]] = z.read('xl/' + rid_to_file[rid])

# ── Step 3: 压缩并去重图片 ──────────────────────────────────
print("⚙️  处理图片...")
import hashlib

skin_ids    = set(df['si'].dropna()) - {''}
tag_ids     = set(df['qi'].dropna()) - {''}

def compress_skin(raw):
    img = Image.open(io.BytesIO(raw)).convert('RGB')
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=80, optimize=True)
    return buf.getvalue(), 'image/jpeg'

def compress_tag(raw):
    img = Image.open(io.BytesIO(raw))
    w, h = img.size
    new_h = 30; new_w = int(w * new_h / h)
    img = img.resize((new_w, new_h), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, 'PNG', optimize=True)
    return buf.getvalue(), 'image/png'

# 收集所有需要上传的图片
img_records = []
seen_hashes = {}  # hash -> img_id（去重用）

def process_img(img_id, raw, img_type, compress_fn):
    data, mime = compress_fn(raw)
    h = hashlib.md5(data).hexdigest()
    if h in seen_hashes:
        return seen_hashes[h]  # 已有，复用
    b64 = base64.b64encode(data).decode()
    img_records.append({
        'img_id':    img_id,
        'img_type':  img_type,
        'data':      b64,
        'mime_type': mime,
    })
    seen_hashes[h] = img_id
    return img_id

for img_id in skin_ids:
    if img_id in id_to_raw:
        process_img(img_id, id_to_raw[img_id], 'skin', compress_skin)

for img_id in tag_ids:
    if img_id in id_to_raw:
        process_img(img_id, id_to_raw[img_id], 'tag', compress_tag)

print(f"  → 皮肤图: {len([r for r in img_records if r['img_type']=='skin'])} 张")
print(f"  → 标签图: {len([r for r in img_records if r['img_type']=='tag'])} 张")

# ── Step 4: 批量上传图片 ────────────────────────────────────
print("⬆️  上传图片到 Supabase...")
BATCH = 100
for i in range(0, len(img_records), BATCH):
    batch = img_records[i:i+BATCH]
    client.table('images').upsert(batch, on_conflict='img_id').execute()
    print(f"  → 已上传 {min(i+BATCH, len(img_records))}/{len(img_records)}")

# ── Step 5: 上传皮肤数据 ────────────────────────────────────
print("⬆️  上传皮肤数据...")
skin_records = []
for _, row in df.iterrows():
    skin_records.append({
        'date':       row['日期'],
        'name':       str(row['皮肤名称']),
        'quality':    str(row['皮肤品质']),
        'tag':        str(row['皮肤标签']) if pd.notna(row['皮肤标签']) else '',
        'hero':       str(row['归属英雄']),
        'job':        str(row['英雄职业']) if pd.notna(row['英雄职业']) else '',
        'price':      str(row['价格']) if pd.notna(row['价格']) else '',
        'obtain':     str(row['获取方式']) if pd.notna(row['获取方式']) else '',
        'type':       str(row['首发or返场']),
        'permanent':  str(row['是否常驻']),
        'skin_img_id': row['si'],
        'tag_img_id':  row['qi'],
    })

for i in range(0, len(skin_records), BATCH):
    batch = skin_records[i:i+BATCH]
    client.table('skins').insert(batch).execute()
    print(f"  → 已上传 {min(i+BATCH, len(skin_records))}/{len(skin_records)}")

print(f"\n✅ 导入完成！共 {len(skin_records)} 条记录，{len(img_records)} 张图片")
