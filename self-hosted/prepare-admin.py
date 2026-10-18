"""Adapt the current admin handler to the independent site's data/JSON adapters."""
import pathlib
import sys


def prepare(source):
    old = "const { createClient } = require('@supabase/supabase-js');"
    new = "const { createClient } = require('../lib/data-client');"
    if old in source:
        assert source.count(old) == 1
        source = source.replace(old, new)
    assert source.count(new) == 1, 'Unknown admin data client'
    old = 'res.status(r.statusCode).end(r.body);'
    new = 'res.status(r.statusCode).json(JSON.parse(r.body));'
    if old in source:
        assert source.count(old) == 1
        source = source.replace(old, new)
    assert source.count(new) == 1, 'Unknown admin response adapter'
    return source


def prepare_html(source):
    old = "const res = await api('GET', '/me', null, true);"
    new = "const res = await api('GET', '/me');"
    if old in source:
        assert source.count(old) == 1
        source = source.replace(old, new)
    assert source.count(new) == 1, 'Unknown admin session restore call'
    return source


if __name__ == '__main__':
    source, destination = map(pathlib.Path, sys.argv[1:])
    destination.write_text(prepare(source.read_text(encoding='utf-8-sig')), encoding='utf-8')
