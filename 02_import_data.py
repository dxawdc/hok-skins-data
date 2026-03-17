#!/usr/bin/env python3
"""
王者荣耀皮肤数据库 - 初始数据导入脚本（修复版）
将现有 Excel 数据 + 图片一次性导入到 Supabase

使用前：
  pip install supabase pandas openpyxl pillow requests

运行：
  python 02_import_data.py
"""

import re, base64, io, sys, hashlib
import zipfile, xml.etree.ElementTree as ET

# ── 填写你的 Supabase 信息 ──────────────────────────────────
SUPABASE_URL = "https://YOUR_PROJECT.supabase.co"   # 改成你的
SUPABASE_KEY = "YOUR_SERVICE_ROLE_KEY"               # 改成 service_role key（不是 anon key）
EXCEL_PATH   = "王者荣耀皮肤数据统计__含图片_.xlsx"   # Excel 文件路径
# ────────────────────────────────────────────────────────────

try:
    from supabase import create_client
    import pandas as pd
    from PIL import Image
except ImportError as e:
    print(f"缺少依赖：{e}")
    print("请运行：pip install supabase pandas openpyxl pillow")
    sys.exit(1)

client = create_client(SUPABASE_URL, SUPABASE_KEY)

# ── Step 1: 读取 Excel 数据 ──────────────────────────────────
print("📖 读取 Excel 数据...")
df = pd.read_excel(EXCEL_PATH)
df['日期'] = df['日期'].dt.strftime('%Y-%m-%d')

def extract_img_id(val):
    if pd.isna(val) or not isinstance(val, str): return ''
    m = re.search(r'ID_([A-Fa-f0-9]+)', val)
    return m.group(1) if m else ''

df['si'] = df['皮肤图片'].apply(extract_img_id)
df['qi'] = df['皮肤品质图片'].apply(extract_img_id)
print(f"  → 共 {len(df)} 条记录")

# ── Step 2: 提取 Excel 嵌入图片 ─────────────────────────────
print("🖼️  提取嵌入图片...")
id_to_raw = {}

with zipfile.ZipFile(EXCEL_PATH) as z:
    all_files = z.namelist()
    has_cellimages = 'xl/cellimages.xml' in all_files

    if has_cellimages:
        print("  → 检测到 WPS cellimages 格式，解析图片映射...")
        ci_xml  = z.read('xl/cellimages.xml').decode('utf-8')
        ci_rels = z.read('xl/_rels/cellimages.xml.rels').decode('utf-8')
        rels_root  = ET.fromstring(ci_rels)
        rid_to_file = {r.get('Id'): r.get('Target') for r in rels_root}
        ci_root = ET.fromstring(ci_xml)
        ns = {
            'etc': 'http://www.wps.cn/officeDocument/2017/etCustomData',
            'xdr': 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
            'r':   'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
            'a':   'http://schemas.openxmlformats.org/drawingml/2006/main'
        }
        for ci in ci_root.findall('etc:cellImage', ns):
            pic  = ci.find('xdr:pic', ns)
            nvpr = pic.find('xdr:nvPicPr/xdr:cNvPr', ns)
            blip = pic.find('xdr:blipFill/a:blip', ns)
            name = nvpr.get('name', '')
            rid  = blip.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed')
            if rid and rid in rid_to_file and name.startswith('ID_'):
                try:
                    id_to_raw[name[3:]] = z.read('xl/' + rid_to_file[rid])
                except Exception:
                    pass
        print(f"  → 解析到 {len(id_to_raw)} 张图片")

    else:
        # 没有 cellimages.xml，文件可能用 Excel 重新保存过，尝试按顺序重建映射
        media_files = sorted(
            [f for f in all_files if f.startswith('xl/media/image') and f.endswith('.png')],
            key=lambda x: int(re.search(r'image(\d+)', x).group(1))
        )
        print(f"  → 未检测到 cellimages.xml，xl/media/ 中有 {len(media_files)} 张图片")
        print(f"  → 尝试按顺序重建 ID 映射...")

        # 收集所有非空 ID（按它们在表格中首次出现的顺序）
        all_ids_ordered = []
        seen = set()
        for _, row in df.iterrows():
            for img_id in [row['si'], row['qi']]:
                if img_id and img_id not in seen:
                    all_ids_ordered.append(img_id)
                    seen.add(img_id)

        print(f"  → 表格引用了 {len(all_ids_ordered)} 个唯一图片 ID，media 文件 {len(media_files)} 个")

        if len(media_files) >= len(all_ids_ordered):
            for i, img_id in enumerate(all_ids_ordered):
                try:
                    id_to_raw[img_id] = z.read(media_files[i])
                except Exception:
                    pass
            print(f"  → 顺序映射完成，成功读取 {len(id_to_raw)} 张")
        else:
            print(f"  ⚠️  数量不匹配，跳过图片导入，仅导入文字数据")

# ── Step 3: 处理图片（压缩 + 去重）──────────────────────────
print("⚙️  处理图片...")

skin_ids = set(df['si'].dropna()) - {''}
tag_ids  = set(df['qi'].dropna()) - {''}

def compress_skin(raw):
    img = Image.open(io.BytesIO(raw)).convert('RGB')
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=80, optimize=True)
    return buf.getvalue(), 'image/jpeg'

def compress_tag(raw):
    img = Image.open(io.BytesIO(raw))
    w, h = img.size
    img = img.resize((int(w * 30 / h), 30), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, 'PNG', optimize=True)
    return buf.getvalue(), 'image/png'

img_records = []
seen_hashes = {}

def process_img(img_id, raw, img_type, compress_fn):
    try:
        data, mime = compress_fn(raw)
        h = hashlib.md5(data).hexdigest()
        if h in seen_hashes:
            return
        seen_hashes[h] = img_id
        img_records.append({
            'img_id':    img_id,
            'img_type':  img_type,
            'data':      base64.b64encode(data).decode(),
            'mime_type': mime,
        })
    except Exception:
        pass

for img_id in skin_ids:
    if img_id in id_to_raw:
        process_img(img_id, id_to_raw[img_id], 'skin', compress_skin)
for img_id in tag_ids:
    if img_id in id_to_raw:
        process_img(img_id, id_to_raw[img_id], 'tag', compress_tag)

skin_count = len([r for r in img_records if r['img_type'] == 'skin'])
tag_count  = len([r for r in img_records if r['img_type'] == 'tag'])
print(f"  → 皮肤图: {skin_count} 张，标签图: {tag_count} 张（去重后）")

# ── Step 4: 批量上传图片 ────────────────────────────────────
if img_records:
    print(f"⬆️  上传 {len(img_records)} 张图片到 Supabase...")
    BATCH = 100
    for i in range(0, len(img_records), BATCH):
        client.table('images').upsert(img_records[i:i+BATCH], on_conflict='img_id').execute()
        print(f"  → {min(i+BATCH, len(img_records))}/{len(img_records)}")
else:
    print("⚠️  无图片可上传，跳过")

# ── Step 5: 上传皮肤数据 ────────────────────────────────────
print(f"⬆️  上传 {len(df)} 条皮肤记录...")

def safe(val, default=''):
    if pd.isna(val): return default
    s = str(val).strip()
    return default if s in ('nan', 'None') else s

skin_records = []
for _, row in df.iterrows():
    skin_records.append({
        'date':        row['日期'],
        'name':        safe(row['皮肤名称']),
        'quality':     safe(row['皮肤品质']),
        'tag':         safe(row.get('皮肤标签', '')),
        'hero':        safe(row['归属英雄']),
        'job':         safe(row.get('英雄职业', '')),
        'price':       safe(row.get('价格', '')),
        'obtain':      safe(row.get('获取方式', '')),
        'type':        safe(row['首发or返场']),
        'permanent':   safe(row['是否常驻'], '否'),
        'skin_img_id': row['si'],
        'tag_img_id':  row['qi'],
    })

BATCH = 100
for i in range(0, len(skin_records), BATCH):
    client.table('skins').insert(skin_records[i:i+BATCH]).execute()
    print(f"  → {min(i+BATCH, len(skin_records))}/{len(skin_records)}")

print(f"\n✅ 导入完成！")
print(f"   皮肤记录：{len(skin_records)} 条")
print(f"   图片：    {len(img_records)} 张")
if not has_cellimages:
    print(f"\n💡 提示：检测到图片映射缺失（文件用 Excel 重存后丢失）")
    print(f"   建议使用原始 WPS 文件重新执行导入，图片会显示更准确")
