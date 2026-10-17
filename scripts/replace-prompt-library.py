"""Back up and atomically replace the local Docker prompt catalog.

Run import-infinite-canvas-prompts.py and deploy its public assets first.
Default is validation only; --apply is the explicit database mutation.
Original rows are archived using the application's deleted_at convention.
Every apply saves a complete pg_dump, JSON snapshot, and scoped undo SQL.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unicodedata
from datetime import datetime, timezone
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CATALOG = ROOT / 'third-party/prompts/infinite-canvas-20261006/normalized.json'


def psql(container, sql):
    proc = subprocess.run([
        'docker', 'exec', '-i', container, 'sh', '-c',
        'exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    ], input=sql.encode('utf-8'), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode:
        # SQL can contain imported content. Do not echo that input on failure.
        raise RuntimeError(proc.stderr.decode('utf-8', errors='replace')[-2000:])
    return proc.stdout.decode('utf-8').strip()


def json_sql(value):
    encoded = json.dumps(value, ensure_ascii=False).encode('utf-8').hex()
    return f"convert_from(decode('{encoded}', 'hex'), 'UTF8')::jsonb"


def fingerprint_sql():
    return "SELECT md5(COALESCE(jsonb_agg(to_jsonb(p) ORDER BY id)::text, '[]')) FROM public.prompt_library p"


def write_durable(path, content, exclusive=False):
    # Pending plans use exclusive creation so concurrent callers cannot replace
    # each other's allocated IDs. Every recovery dependency is flushed first.
    temporary = path.with_name(path.name + '.' + uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8', newline='\n') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if exclusive:
            # Publishing a fully written hard link is atomic and refuses an
            # existing plan; a crash cannot leave a truncated pending receipt.
            os.link(temporary, path)
        else:
            temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def write_json(path, value, exclusive=False):
    write_durable(path, json.dumps(value, ensure_ascii=False, indent=2), exclusive)


def backup(container):
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    folder = ROOT / 'outputs/backups' / ('prompt-library-' + stamp)
    folder.mkdir(parents=True, exist_ok=False)
    before = psql(container, fingerprint_sql())
    rows = json.loads(psql(container, "SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY id), '[]') FROM public.prompt_library p"))
    write_json(folder / 'rows.json', rows)
    with (folder / 'prompt-library.sql').open('wb') as stream:
        subprocess.run(['docker', 'exec', container, 'sh', '-c',
                        'exec pg_dump --data-only --column-inserts --table=public.prompt_library -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
                       stdout=stream, stderr=subprocess.PIPE, check=True)
        stream.flush()
        os.fsync(stream.fileno())
    if psql(container, fingerprint_sql()) != before:
        raise RuntimeError('Catalog changed during backup; retry with a fresh backup.')
    metadata = {'fingerprint': before, 'count': len(rows), 'active': sum(r['deleted_at'] is None for r in rows),
                'enabled': sum(r['deleted_at'] is None and r['status'] == 1 for r in rows), 'createdAt': stamp}
    write_json(folder / 'backup.json', metadata)
    return folder, rows, metadata


def validate(path, content=None):
    rows = json.loads((path.read_bytes() if content is None else content).decode('utf-8-sig'))
    if not isinstance(rows, list) or not rows:
        raise ValueError('Expected nonempty normalized catalog.')
    seen = set()
    for row in rows:
        key = ' '.join(unicodedata.normalize('NFKC', row['prompt']).split())
        if not key or key in seen:
            raise ValueError('Empty or duplicate normalized prompt.')
        seen.add(key)
        if not 0 < len(row['title']) <= 200 or not 0 < len(row['category']) <= 100:
            raise ValueError('Invalid title/category length.')
        if row['status'] != 1 or not isinstance(row['tags'], list):
            raise ValueError('Invalid status/tags.')
        cover = row['coverUrl']
        if cover:
            if not cover.startswith('/prompts/covers/') or '..' in cover:
                raise ValueError('Expected a local, content-addressed cover.')
            file = ROOT / 'web/public' / cover.lstrip('/')
            if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != file.stem:
                raise ValueError('Missing/corrupt cover: ' + cover)
    return rows


def prepare_plan(container, catalog, rows, content, pending, marker):
    folder, old, metadata = backup(container)
    allocated = json.loads(psql(container, f"""
SELECT jsonb_agg(id ORDER BY ordinal) FROM (
  SELECT ordinal, nextval(pg_get_serial_sequence('public.prompt_library', 'id')) AS id
  FROM generate_series(1, {len(rows)}) AS ordinal
) allocated;
"""))
    ids = [int(value) for value in allocated]
    if len(ids) != len(rows) or len(set(ids)) != len(ids):
        raise RuntimeError('Identity allocation did not return the expected unique IDs.')
    plan = {'planId': str(uuid4()), 'container': container, 'catalog': str(catalog.resolve()),
            'catalogSha256': hashlib.sha256(content).hexdigest(), 'backup': str(folder.resolve()),
            'previous': metadata, 'insertedIds': ids, 'insertedCount': len(ids),
            'preparedAt': datetime.now(timezone.utc).isoformat()}
    # Save the exact input for a retry even if the normalizer updates its output.
    write_durable(folder / 'catalog.json', content.decode('utf-8-sig'))
    # Hash the stored bytes too: a BOM is deliberately removed from the snapshot.
    plan['snapshotSha256'] = hashlib.sha256((folder / 'catalog.json').read_bytes()).hexdigest()
    fields = [key for key in old[0] if key != 'id'] if old else []
    assignments = ','.join(f'{key}=EXCLUDED.{key}' for key in fields)
    id_sql = ','.join(str(value) for value in ids)
    undo = "\\set ON_ERROR_STOP on\nBEGIN;\nSET LOCAL lock_timeout = '10s';\nLOCK TABLE public.prompt_library IN EXCLUSIVE MODE;\n"
    undo += f"DO $guard$ BEGIN IF (SELECT count(*) FROM public.prompt_library WHERE id IN ({id_sql})) <> {len(ids)} THEN RAISE EXCEPTION 'Replacement is absent or incomplete'; END IF; END $guard$;\n"
    undo += f'UPDATE public.prompt_library SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id IN ({id_sql});\n'
    if old:
        undo += f'INSERT INTO public.prompt_library SELECT * FROM jsonb_populate_recordset(NULL::public.prompt_library, {json_sql(old)}) ON CONFLICT(id) DO UPDATE SET {assignments};\n'
    undo += 'COMMIT;\n'
    write_durable(folder / 'undo-replacement.sql', undo)
    write_json(folder / 'operation.json', plan)
    write_json(pending, plan, exclusive=True)
    # A concurrent process could have completed between our initial marker check
    # and exclusive creation of pending.json. It must never trigger a new import.
    if marker.exists():
        pending.unlink()
        raise RuntimeError('A replacement completed while this plan was being prepared.')
    return plan


def complete_plan(plan, pending, marker, recovered=False):
    receipt = {**plan, 'appliedAt': datetime.now(timezone.utc).isoformat(), 'recovered': recovered}
    # Keep the pending plan until both receipts have been saved. A crash at any
    # point can then be resolved by checking the preallocated IDs in PostgreSQL.
    write_json(Path(plan['backup']) / 'applied.json', receipt)
    write_json(marker, receipt)
    pending.unlink(missing_ok=True)
    return receipt


def apply_or_recover(plan, container, pending, marker):
    if plan['container'] != container:
        raise RuntimeError('Pending replacement belongs to a different database container.')
    if marker.exists():
        existing = json.loads(marker.read_text(encoding='utf-8'))
        if existing.get('planId') != plan['planId']:
            raise RuntimeError('The completed receipt belongs to a different replacement plan.')
    ids = [int(value) for value in plan['insertedIds']]
    if not ids or len(ids) != plan['insertedCount'] or len(set(ids)) != len(ids):
        raise RuntimeError('Invalid pending replacement IDs.')
    id_sql = ','.join(str(value) for value in ids)
    present = int(psql(container, f'SELECT count(*) FROM public.prompt_library WHERE id IN ({id_sql})'))
    if present == len(ids):
        return complete_plan(plan, pending, marker, recovered=True)
    if present:
        raise RuntimeError('Only some pending replacement IDs exist; manual recovery is required.')
    if marker.exists():
        raise RuntimeError('Completed receipt exists but its inserted rows are absent.')
    snapshot = Path(plan['backup']) / 'catalog.json'
    content = snapshot.read_bytes()
    if hashlib.sha256(content).hexdigest() != plan['snapshotSha256']:
        raise RuntimeError('Pending replacement input snapshot is corrupt.')
    rows = validate(snapshot, content)
    if len(rows) != len(ids):
        raise RuntimeError('Pending replacement input count does not match allocated IDs.')
    rows = [dict(row, _importId=id_value) for row, id_value in zip(rows, ids)]
    fingerprint = plan['previous']['fingerprint']
    if len(fingerprint) != 32 or any(c not in '0123456789abcdef' for c in fingerprint):
        raise RuntimeError('Invalid backup fingerprint.')
    sql = f"""
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE public.prompt_library IN EXCLUSIVE MODE;
DO $guard$ BEGIN
  IF ({fingerprint_sql()}) <> '{fingerprint}' THEN
    RAISE EXCEPTION 'Catalog changed since backup';
  END IF;
END $guard$;
CREATE TEMP TABLE incoming_prompts ON COMMIT DROP AS
SELECT value AS row FROM jsonb_array_elements({json_sql(rows)});
UPDATE public.prompt_library SET deleted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE deleted_at IS NULL;
INSERT INTO public.prompt_library (id,title,prompt_content,cover_url,preview_content,category,tags_data,source_url,status,sort_order)
SELECT (row->>'_importId')::bigint, row->>'title', row->>'prompt', row->>'coverUrl', row->>'preview', row->>'category', row->'tags',
       row->>'sourceUrl', 1, (row->>'sortOrder')::integer FROM incoming_prompts ORDER BY (row->>'sortOrder')::integer;
COMMIT;
"""
    psql(container, sql)
    return complete_plan(plan, pending, marker)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=DEFAULT_CATALOG)
    parser.add_argument('--container', default='inspirestudio-postgres')
    parser.add_argument('--backup-only', action='store_true')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.backup_only:
        folder, _, metadata = backup(args.container)
        print(json.dumps({'backup': str(folder), **metadata}))
        return
    marker = args.catalog.parent / 'applied.json'
    pending = args.catalog.parent / 'pending.json'
    if not args.apply:
        content = args.catalog.read_bytes()
        rows = validate(args.catalog, content)
        digest = hashlib.sha256(content).hexdigest()
        print(json.dumps({'validated': len(rows), 'localCovers': sum(bool(r['coverUrl']) for r in rows), 'sha256': digest}))
        return
    if pending.exists():
        plan = json.loads(pending.read_text(encoding='utf-8'))
    else:
        if marker.exists():
            raise RuntimeError('An applied.json receipt already exists. Review it before attempting another replacement.')
        content = args.catalog.read_bytes()
        rows = validate(args.catalog, content)
        plan = prepare_plan(args.container, args.catalog, rows, content, pending, marker)
    result = apply_or_recover(plan, args.container, pending, marker)
    print(json.dumps({'insertedCount': result['insertedCount'], 'archivedCount': result['previous']['active'],
                      'backup': result['backup'], 'recovered': result['recovered']}))


if __name__ == '__main__':
    main()
