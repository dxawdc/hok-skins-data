"""Insert reviewed source exports into hokskins without overwriting local rows.

Input: [{"name": "skin_profiles", "rows": [...]}, {"name": "skins", "rows": [...]}].
Default is a transaction that rolls back. Back up the database and copy images
before running with --apply. Existing IDs or missing references abort the sync.
"""
import argparse
import json
import pathlib
import subprocess


def build_sql(exports, apply=False):
    if len(exports) != 2 or {item['name'] for item in exports} != {'skin_profiles', 'skins'}:
        raise ValueError('Only skin profiles and skin events can be synchronized')
    tables = {item['name']: item['rows'] for item in exports}
    profiles, skins = tables['skin_profiles'], tables['skins']
    profile_ids = {row['id'] for row in profiles}
    if not profiles or not skins:
        raise ValueError('Export must include profiles and events')
    for rows in [profiles, skins]:
        if any(type(row['id']) is not int or row['id'] <= 0 for row in rows):
            raise ValueError('Invalid row ID')
        if len({row['id'] for row in rows}) != len(rows):
            raise ValueError('Duplicate row IDs')
    if any(row['skin_profile_id'] not in profile_ids or row['type'] != '首发' for row in skins):
        raise ValueError('Only new profiles and their first release events are supported')
    by_id = {row['id']: row for row in profiles}
    for row in skins:
        profile = by_id[row['skin_profile_id']]
        for field in ['name', 'hero', 'hero_id', 'skin_img_url', 'tag_img_url']:
            if row.get(field) != profile.get(field):
                raise ValueError('First release must share its profile: ' + field)
    statements = ["BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';",
                  "LOCK TABLE skin_profiles, skins IN SHARE ROW EXCLUSIVE MODE;"]
    for table in ['skin_profiles', 'skins']:
        rows = tables[table]
        payload = json.dumps(rows, ensure_ascii=False).replace("'", "''")
        # SQL identifiers are fixed; exported values are a quoted JSON literal.
        statements.append(f"INSERT INTO public.{table} SELECT * FROM json_populate_recordset(NULL::public.{table}, '{payload}'::json);")
        if apply:
            # Preserve a sequence already ahead of the imported IDs.
            statements.append(f"SELECT setval('public.{table}_id_seq', GREATEST((SELECT last_value FROM public.{table}_id_seq), (SELECT max(id) FROM public.{table})), true);")
    statements.append("SELECT json_build_object('profiles',(SELECT count(*) FROM skin_profiles),'records',(SELECT count(*) FROM skins),'returns',(SELECT count(*) FROM skins WHERE type='返场'));")
    statements.append('COMMIT;' if apply else 'ROLLBACK;')
    return '\n'.join(statements)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('export', type=pathlib.Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    sql = build_sql(json.loads(args.export.read_text(encoding='utf-8-sig')), args.apply)
    subprocess.run(['sudo', '-u', 'postgres', 'psql', '-d', 'hokskins', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True, check=True)
