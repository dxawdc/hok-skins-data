"""Apply bounded public caching to an inspected independent-site server copy."""
import pathlib
import sys


def prepare(source):
    marker = "const { createPublicCache } = require('./lib/public-cache.cjs');"
    if marker in source:
        return source
    anchor = "const { localImageUrls } = require('./lib/image-store.cjs');"
    assert source.count(anchor) == 1, 'Unknown image mapper import'
    source = source.replace(anchor, anchor + '\n' + marker +
        '\nconst publicCache = createPublicCache({ transform: localImageUrls });')
    anchor = '    await handler(req, res);'
    assert source.count(anchor) == 1, 'Unknown handler dispatch'
    source = source.replace(anchor, '''    // Public snapshots only; successful catalog writes invalidate all three.
    if (admin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        !['/api/admin/login', '/api/admin/feedback'].includes(route)) {
      res.once('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          publicCache.invalidate();
          localImageUrls.clear();
        }
      });
    }
    if (await publicCache.respond(req, res, route, handler)) return;
    await handler(req, res);''')
    return source


if __name__ == '__main__':
    source, destination = map(pathlib.Path, sys.argv[1:])
    destination.write_text(prepare(source.read_text(encoding='utf-8-sig')), encoding='utf-8')
