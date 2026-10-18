"""Adapt public-page refresh behavior without changing routine cache lifetimes."""
import pathlib
import re
import sys


def prepare_html(html):
    old = "async function refreshData(refreshVersion = '') {"
    new = "async function refreshData(refreshVersion = Date.now()) {"
    if old in html:
        assert html.count(old) == 1, 'Ambiguous public refresh handler'
        html = html.replace(old, new, 1)
    assert html.count(new) == 1, 'Unknown public refresh handler'
    # A temporarily incomplete public catalog must never delete personal marks.
    html = re.sub(r'^\s*reconcileMarks\(\[\.\.\.new Set\(RAW\.map\(markKey\)\)\]\);[^\n]*', '', html, flags=re.M)
    html = html.replace('当前筛选 ${filtered.length} 款 · 已拥有 ${owned} 款',
                        '当前筛选 ${filtered.length} 条记录 / ${keys.length} 款皮肤 · 已拥有 ${owned} 款')
    html = html.replace('当前筛选 0 款', '当前筛选 0 条记录 / 0 款皮肤')
    html = re.sub(r'<title>王者荣耀皮肤数据库[^<]*</title>', '<title>王者荣耀皮肤数据库</title>', html, count=1)
    for field, label in [('f-hero', '按英雄筛选'), ('f-quality', '按品质筛选'), ('f-year', '按年份筛选')]:
        html = html.replace(f'id="{field}" onchange=', f'id="{field}" aria-label="{label}" onchange=')
    html = html.replace('title="拥有"', 'title="拥有" aria-label="拥有"') if 'aria-label="拥有"' not in html else html
    html = html.replace('title="关注"', 'title="关注" aria-label="关注"') if 'aria-label="关注"' not in html else html
    # Preserve uploaded-image versions; 240px rounds to the existing 320px file.
    thumb = '''function thumbUrl(url, width) {
  if (!url) return '';
  const cdn = toCdnUrl(url);
  if (!cdn.startsWith(CDN_BASE + '/')) return cdn;
  const sizes = [60, 80, 120, 160, 200, 320, 480, 640, 960, 1280];
  const size = sizes.find(n => n >= (Number(width) || 120)) || 1280;
  const [base, query = ''] = cdn.split('#')[0].split('?');
  const params = new URLSearchParams(query);
  ['width', 'height', 'quality', 'resize', 'format'].forEach(key => params.delete(key));
  params.set('width', size); params.set('height', size);
  params.set('quality', size <= 320 ? 70 : 80); params.set('resize', 'contain');
  return base + '?' + params.toString();
}
'''
    html, count = re.subn(r'function thumbUrl\(url, width(?:, quality = 70)?\) \{.*?\n\}', lambda _: thumb.rstrip(), html, count=1, flags=re.S)
    assert count == 1, 'Unknown thumbnail helper'
    if 'id="mobile-more-panel"' not in html:
        nav = re.search(r'<nav class="bottom-nav" id="bottom-nav">(.*?)</nav>', html, re.S)
        assert nav, 'Unknown mobile navigation'
        items = re.findall(r'<div class="bottom-nav-item[^>]*>.*?</div>', nav.group(1), re.S)
        assert len(items) == 11, 'Unknown mobile navigation entries'
        primary, extra = [], []
        for item in items:
            item = item.replace('<div ', '<button type="button" ', 1).replace('</div>', '</button>')
            (primary if any(f'id="bnav-{key}"' in item for key in ['list', 'hero-list', 'resources', 'mine']) else extra).append(item)
        replacement = '<div id="mobile-more-panel" class="mobile-more-panel" aria-label="更多导航" hidden>' + ''.join(extra) + '</div>'
        replacement += '<nav class="bottom-nav" id="bottom-nav">' + ''.join(primary)
        replacement += '''<button type="button" class="bottom-nav-item" id="bnav-more" aria-expanded="false" aria-controls="mobile-more-panel" onclick="setMobileMore()"><span class="bn-icon">☰</span>更多</button></nav>'''
        html = html[:nav.start()] + replacement + html[nav.end():]
        anchor = 'function setBottomNav(v) {'
        assert html.count(anchor) == 1
        html = html.replace(anchor, '''function setMobileMore(open) {
  const panel = document.getElementById('mobile-more-panel');
  const button = document.getElementById('bnav-more');
  panel.hidden = open === undefined ? !panel.hidden : !open;
  button.setAttribute('aria-expanded', String(!panel.hidden));
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.getElementById('mobile-more-panel').hidden) {
    setMobileMore(false); document.getElementById('bnav-more').focus();
  }
});
document.addEventListener('click', event => {
  if (!event.target.closest('#mobile-more-panel, #bnav-more')) setMobileMore(false);
});
function setBottomNav(v) {
  setMobileMore(false);''', 1)
    nav_marker = '/* mobile-navigation-v1 */'
    if nav_marker not in html:
        html = html.replace('</style>', '''
/* mobile-navigation-v1 */
.mobile-more-panel { display: none; }
.bottom-nav-item { background: none; border: 0; font-family: inherit; }
@media (max-width: 899px) {
  .bottom-nav .bottom-nav-item { flex: 1 1 20%; min-width: 0; }
  .mobile-more-panel:not([hidden]) { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
    position: fixed; left: 12px; right: 12px; bottom: calc(70px + env(safe-area-inset-bottom));
    z-index: 95; padding: 12px; border: 1px solid var(--border); border-radius: 12px;
    background: var(--bg2); box-shadow: var(--shadow); }
  .mobile-more-panel .bottom-nav-item { min-height: 56px; font-size: 12px; }
}
</style>''', 1)
    marker = '/* public-usability-v1 */'
    if marker not in html:
        css = '''
/* public-usability-v1 */
[data-theme="light"] { --text3: #64748b; }
@media (prefers-color-scheme: light) { [data-theme="auto"] { --text3: #64748b; } }
button:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--gold); outline-offset: 3px;
}
@media (max-width: 899px) {
  .filter-bar { flex-wrap: wrap; }
  .filter-bar .search-box { flex: 1 0 100%; width: 100%; min-width: 0 !important; max-width: none; }
  .filter-bar .filter-select { flex: 1 1 100px; min-width: 100px; min-height: 40px; }
  .batch-info { flex-basis: 100%; line-height: 1.6; }
}
'''
        html = html.replace('</style>', css + '</style>', 1)
    return html


if __name__ == '__main__':
    source, destination = map(pathlib.Path, sys.argv[1:])
    destination.write_text(prepare_html(source.read_text(encoding='utf-8-sig')), encoding='utf-8')
