import json, subprocess, urllib.parse, pathlib, sys

def sql(query):
    return subprocess.check_output(['sudo','-u','postgres','psql','-d','hokskins','-Atc',query], text=True).strip()

columns = sql("SELECT table_name || '|' || column_name FROM information_schema.columns WHERE table_schema='public' AND column_name LIKE '%url%' ORDER BY 1").splitlines()
refs = {}
others = set()
counts = {}
for column in columns:
    table, field = column.split('|')
    if '--canonical' in sys.argv and table == 'skins': continue
    values = json.loads(sql(f'SELECT coalesce(json_agg(DISTINCT "{field}"),\'[]\'::json) FROM "{table}" WHERE "{field}" IS NOT NULL'))
    counts[column] = len(values)
    for value in values:
        if not value: continue
        url = urllib.parse.urlsplit(value)
        path = None
        if url.hostname == 'erphrsydujqrcvtpdtnf.supabase.co' and '/public/skin-images/' in url.path:
            path = url.path.split('/public/skin-images/',1)[1]
        elif url.hostname in ('skinsdata.top','www.skinsdata.top') and url.path.startswith('/img/'):
            path = url.path[5:]
        elif url.path.startswith('/hokskins/img/'):
            path = url.path[len('/hokskins/img/'):]
        if path:
            refs.setdefault(path, []).append(column)
        else: others.add(value)
output = {'paths':sorted(refs),'references':refs,'column_counts':counts,'other_urls':sorted(others)}
pathlib.Path('/tmp/hokskins-image-manifest.json').write_text(json.dumps(output,ensure_ascii=False,indent=2))
print(json.dumps({'images':len(refs),'by_type':{t:sum(p.startswith(t+'/') for p in refs) for t in ['skin','tag','hero','resource']},'other_urls':sorted(others),'column_counts':counts},ensure_ascii=False))
