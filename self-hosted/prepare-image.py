"""Validate one admin upload and atomically publish its local image variants."""
import os
import pathlib
import re
import shutil
import sys
import tempfile
import warnings
from PIL import Image

SIZES = [60, 80, 120, 160, 200, 320]
Image.MAX_IMAGE_PIXELS = 16_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)

def prepare(source, root, key):
    if '..' in key or not re.fullmatch(r'(skin|tag|hero|resource)/[A-Za-z0-9][A-Za-z0-9_.-]*\.(png|jpe?g|webp|gif)', key, re.I):
        raise ValueError('invalid image path')
    source, root = pathlib.Path(source), pathlib.Path(root)
    if not 0 < source.stat().st_size <= 400 * 1024:
        raise ValueError('image size exceeds limit')
    formats = {'png':'PNG','jpg':'JPEG','jpeg':'JPEG','webp':'WEBP','gif':'GIF'}
    with Image.open(source) as image:
        if image.format != formats[key.rsplit('.', 1)[1].lower()]:
            raise ValueError('extension does not match image')
        image.verify()
    with tempfile.TemporaryDirectory(dir=root / '.staging') as stage:
        stage = pathlib.Path(stage)
        variants = []
        with Image.open(source) as image:
            image.load()
            if not getattr(image, 'is_animated', False):
                for size in SIZES:
                    if max(image.size) <= size:
                        continue
                    copy = image.copy()
                    copy.thumbnail((size, size), Image.Resampling.LANCZOS)
                    target = stage / str(size)
                    copy.save(target, format=image.format, quality=75, compress_level=3)
                    variants.append((target, root / 'public' / f'thumbs/{size}/hokskins/img' / key))
        original = stage / 'original'
        shutil.copyfile(source, original)
        # Finish every conversion before replacing the existing public files.
        for size in SIZES:
            target = root / 'public' / f'thumbs/{size}/hokskins/img' / key
            if not any(dest == target for _, dest in variants):
                target.unlink(missing_ok=True)
        for source_file, destination in variants + [(original, root / 'public/originals/hokskins/img' / key)]:
            destination.parent.mkdir(parents=True, exist_ok=True)
            # The service's restrictive umask must not hide public images from Nginx.
            parent = destination.parent
            public = root / 'public'
            while parent != public:
                parent.chmod(0o755)
                parent = parent.parent
            os.chmod(source_file, 0o644)
            os.replace(source_file, destination)

if __name__ == '__main__':
    prepare(*sys.argv[1:])
