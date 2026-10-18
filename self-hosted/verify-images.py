"""Verify the entire isolated copy; archive only files excluded by its manifest."""
import hashlib
import json
import os
import pathlib
from PIL import Image

root = pathlib.Path('/opt/hokskins/storage')
originals = root / 'public/originals/hokskins/img'
manifest = json.loads((root / 'migration/manifest.json').read_text())
keys = set(manifest['paths'])
sizes = [60, 80, 120, 160, 200, 320]
records, repaired, archived, thumbnails = [], [], [], 0
for key in sorted(keys):
    source = originals / key
    assert source.resolve().is_relative_to(originals.resolve())
    data = source.read_bytes()
    with Image.open(source) as image:
        image.verify()
    with Image.open(source) as image:
        dimensions = image.size
        animated = getattr(image, 'is_animated', False)
        for size in sizes:
            if animated or max(dimensions) <= size:
                continue
            dest = root / 'public' / f'thumbs/{size}/hokskins/img' / key
            try:
                with Image.open(dest) as thumb:
                    thumb.verify()
                with Image.open(dest) as thumb:
                    assert max(thumb.size) <= size
            except Exception:
                image.load()
                thumb = image.copy()
                thumb.thumbnail((size,size),Image.Resampling.LANCZOS)
                dest.parent.mkdir(parents=True,exist_ok=True)
                temp = dest.with_name(dest.name + '.verify')
                thumb.save(temp,format=image.format,quality=75,compress_level=3)
                temp.chmod(0o644)
                os.replace(temp,dest)
                repaired.append(str(dest.relative_to(root)))
            thumbnails += 1
    records.append({'path':key,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'dimensions':dimensions})

# Keep discarded pre-dedup downloads as rollback evidence outside the public root.
for file in originals.rglob('*'):
    if not file.is_file():
        continue
    key = str(file.relative_to(originals))
    if key in keys:
        continue
    assert file.resolve().is_relative_to(originals.resolve())
    target = root / 'migration/excluded-before-dedup' / key
    assert target.resolve().is_relative_to((root/'migration/excluded-before-dedup').resolve())
    target.parent.mkdir(parents=True,exist_ok=True)
    assert not target.exists()
    file.rename(target)
    archived.append(key)
summary={'originals':len(records),'bytes':sum(r['bytes'] for r in records),'thumbnails':thumbnails,'repaired':repaired,'archived':archived,'files':records}
(root / 'migration/verification.json').write_text(json.dumps(summary,indent=2))
print(json.dumps({k:v for k,v in summary.items() if k!='files'}))
