"""Remove the obsolete migration banner from an independent site's HTML."""
import pathlib
import re
import sys


def prepare_html(html):
    pattern = r'(<body\b[^>]*>)\s*<div\b[^>]*>\s*GDN 独立副本[^<]*</div>'
    html = re.sub(pattern, r'\1', html, count=1)
    if any(text in html for text in ('GDN 独立副本', '数据同步于', '数据迁入于', '修改不影响原站', '图片已迁移', '图片迁移中')):
        raise ValueError('Unexpected migration notice markup; inspect the page before editing')
    return html


if __name__ == '__main__':
    source, destination = map(pathlib.Path, sys.argv[1:])
    destination.write_text(prepare_html(source.read_text(encoding='utf-8-sig')), encoding='utf-8')
