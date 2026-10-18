"""Copy the four private user tables and referenced avatars into isolated hokskins.

Run on the destination as root. Source credentials stay in /run, never in command
arguments or output. Import requires a write-fenced source and an inactive target.
Use --apply only after a backup; the default import rolls back its transaction.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

TABLES = {
    'miniprogram_users': 'id',
    'miniprogram_sessions': 'id',
    'miniprogram_skin_marks': 'user_id,skin_key',
    'miniprogram_mark_mutations': 'user_id,mutation_id',
}
PRIVATE = Path('/opt/hokskins/storage/private/miniprogram-avatars')
ACTIVE = Path('/opt/hokskins/storage/migration/users-active')


def config():
    value = json.loads(Path('/run/hokskins-migration/source-config.json').read_text())
    if value['SUPABASE_URL'] != 'https://erphrsydujqrcvtpdtnf.supabase.co':
        raise ValueError('Unexpected source')
    return value


def request(route, extra_headers=None):
    cfg = config()
    headers = {'apikey': cfg['SUPABASE_SERVICE_KEY'], 'Authorization': 'Bearer ' + cfg['SUPABASE_SERVICE_KEY']}
    headers.update(extra_headers or {})
    for attempt in range(3):
        try:
            with urlopen(Request(cfg['SUPABASE_URL'] + route, headers=headers), timeout=30) as response:
                return response.read(), {k.lower(): v for k, v in response.headers.items()}
        except (HTTPError, URLError, TimeoutError):
            if attempt == 2:
                raise RuntimeError('Source request failed; response intentionally redacted') from None
            time.sleep(attempt + 1)


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False)


def export(destination):
    output = {}
    for table, order in TABLES.items():
        def page_at(offset):
            raw, headers = request('/rest/v1/' + table + '?select=*&order=' + order + '&limit=500&offset=' + str(offset), {'Prefer': 'count=exact'})
            page = json.loads(raw)
            if not isinstance(page, list):
                raise ValueError('Invalid source result')
            return page, int(headers['content-range'].split('/')[-1])
        rows, count = page_at(0)
        if not 0 < count < 200000:
            raise ValueError('Export limit exceeded')
        with ThreadPoolExecutor(max_workers=4) as pool:
            for page, page_count in pool.map(page_at, range(500, count, 500)):
                if page_count != count:
                    raise ValueError('Source changed during export')
                rows.extend(page)
        if len(rows) != count:
            raise ValueError('Source count changed or incomplete: ' + table)
        output[table] = rows
        print(json.dumps({'exported': table, 'rows': len(rows)}), flush=True)
    save(destination, output)


def avatars(manifest_path):
    manifest = json.loads(Path(manifest_path).read_text(encoding='utf-8-sig'))
    results = []
    for item in manifest:
        key = item['name']
        if not re.fullmatch(r'avatars/[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp)', key):
            raise ValueError('Unsupported avatar key')
        target = PRIVATE / key
        raw, headers = request('/storage/v1/object/authenticated/miniprogram-avatars/' + key)
        if len(raw) != item['size'] or not 0 < len(raw) <= 2 * 1024 * 1024 or not headers.get('content-type', '').startswith('image/'):
            raise ValueError('Avatar size/type mismatch')
        from PIL import Image
        import io
        with Image.open(io.BytesIO(raw)) as img:
            img.verify()
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(target, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
        results.append({'name': key, 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    save('/opt/hokskins/storage/migration/private-avatar-manifest.json', results)
    subprocess.run(['chown', '-R', 'hokskins:hokskins', str(PRIVATE)], check=True)
    print(json.dumps({'avatars_copied_and_verified': len(results)}))


def sql_run(sql):
    result = subprocess.run(['sudo', '-u', 'postgres', 'psql', '-X', '-qAt', '-d', 'hokskins', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True, capture_output=True)
    if result.returncode:
        # PostgreSQL errors can contain private row values; never echo stderr.
        raise RuntimeError('Private data transaction failed; diagnostic redacted')
    return result.stdout.strip()


def import_users(source, apply):
    if ACTIVE.exists():
        raise ValueError('Target already active; refusing to overwrite live users')
    data = json.loads(Path(source).read_text())
    if set(data) != set(TABLES):
        raise ValueError('Unexpected export tables')
    users = {row['id'] for row in data['miniprogram_users']}
    if len(users) != len(data['miniprogram_users']) or len(users) < 335:
        raise ValueError('Incomplete user export')
    for table in list(TABLES)[1:]:
        if any(row['user_id'] not in users for row in data[table]):
            raise ValueError('Missing owning user')
    for row in data['miniprogram_users']:
        avatar = row.get('avatar_path')
        if avatar and (not re.fullmatch(r'avatars/[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp)', avatar) or not (PRIVATE / avatar).is_file()):
            raise ValueError('Missing referenced avatar')
    statements = ["BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s';",
                  'LOCK TABLE ' + ','.join(TABLES) + ' IN ACCESS EXCLUSIVE MODE;',
                  # Imported expired sessions and receipts must not fire pruning
                  # or timestamp triggers. FK membership is validated above.
                  "SET LOCAL session_replication_role='replica';"]
    for table in reversed(TABLES):
        statements.append('DELETE FROM public.' + table + ';')
    for table in TABLES:
        payload = json.dumps(data[table], ensure_ascii=False).replace("'", "''")
        statements.append(f"INSERT INTO public.{table} SELECT * FROM json_populate_recordset(NULL::public.{table}, '{payload}'::json);")
    statements.append("SET LOCAL session_replication_role='origin';")
    statements.append('COMMIT;' if apply else 'ROLLBACK;')
    sql_run('\n'.join(statements))
    print(json.dumps({'import': 'applied' if apply else 'dry-run-passed', 'counts': {k: len(v) for k, v in data.items()}}))


def normalize(value):
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize(v) for v in value]
    if isinstance(value, str) and re.match(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d', value):
        from datetime import datetime, timezone
        try:
            return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc).isoformat(timespec='microseconds')
        except ValueError:
            pass
    return value


def verify(source):
    data = json.loads(Path(source).read_text())
    for table, order in TABLES.items():
        local = json.loads(sql_run(f'SELECT coalesce(json_agg(t),\'[]\'::json) FROM (SELECT * FROM public.{table} ORDER BY {order}) t;'))
        expected = sorted(data[table], key=lambda row: tuple(row[k] for k in order.split(',')))
        actual = sorted(local, key=lambda row: tuple(row[k] for k in order.split(',')))
        def digest(rows):
            return hashlib.sha256(json.dumps(normalize(rows), sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        if digest(expected) != digest(actual):
            raise ValueError('Imported values differ: ' + table)
        print(json.dumps({'verified': table, 'rows': len(actual), 'sha256': digest(actual)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['export', 'avatars', 'import', 'verify'])
    parser.add_argument('path')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    {'export': export, 'avatars': avatars, 'verify': verify, 'import': lambda p: import_users(p, args.apply)}[args.action](args.path)
