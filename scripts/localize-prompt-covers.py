"""Download the curated prompt covers. Requires Python 3 and Pillow.

Usage: python scripts/localize-prompt-covers.py path/to/prompt-export.json
The export contains id, title, prompt_content, source_url and cover_url.
Only writes the migration after every image has downloaded and decoded.
"""
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import sys
import time
import urllib.request

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'web/public/prompts/covers'
MANIFEST = ROOT / 'third-party/prompts/local-covers.json'


def download(row):
    url = row['cover_url']
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read()
            with Image.open(io.BytesIO(data)) as img:
                extension = {'JPEG': 'jpg', 'PNG': 'png', 'WEBP': 'webp', 'GIF': 'gif', 'AVIF': 'avif'}[img.format]
                width, height = img.size
                img.verify()
            digest = hashlib.sha256(data).hexdigest()
            name = f'{digest}.{extension}'
            (DEST / name).write_bytes(data)
            return {
                'id': row['id'], 'title': row['title'], 'sourceUrl': row['source_url'],
                'originalUrl': url, 'localUrl': f'/prompts/covers/{name}',
                'sha256': digest, 'bytes': len(data), 'width': width, 'height': height,
                'promptMd5': hashlib.md5(row['prompt_content'].encode()).hexdigest(),
            }
        except Exception:
            if attempt == 3:
                raise
            time.sleep(attempt + 1)


def main():
    migration = ROOT / 'server/src/main/resources/db/migration/V35__Localize_Prompt_Covers.sql'
    if migration.exists():
        raise FileExistsError('Do not overwrite an existing Flyway migration.')
    rows = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
    if not rows or any(not r['cover_url'].startswith('https://') for r in rows):
        raise ValueError('Expected a nonempty export with HTTPS cover URLs.')
    DEST.mkdir(parents=True, exist_ok=True)
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(download, row) for row in rows]
        for future in concurrent.futures.as_completed(futures):
            results.append(future.result())
            if len(results) % 25 == 0:
                print(f'Downloaded and verified {len(results)}/{len(rows)}', flush=True)
    results.sort(key=lambda row: row['id'])
    MANIFEST.write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    quote = lambda value: "'" + value.replace("'", "''") + "'"
    sql = ['-- Content-addressed local copies; original image URLs remain in third-party/prompts/local-covers.json.',
           '-- Deploy the matching web/public/prompts/covers assets before applying this migration.']
    for row in results:
        sql.append(f"UPDATE prompt_library SET cover_url = {quote(row['localUrl'])}, updated_at = CURRENT_TIMESTAMP\n"
                   f"WHERE source_url = {quote(row['sourceUrl'])} AND title = {quote(row['title'])}\n"
                   f"  AND md5(prompt_content) = '{row['promptMd5']}' AND cover_url = {quote(row['originalUrl'])}\n"
                   "  AND created_by IS NULL AND deleted_at IS NULL;\n")
    if migration.exists():
        raise FileExistsError('Do not overwrite an existing Flyway migration.')
    migration.write_text('\n'.join(sql), encoding='utf-8')
    print(f"Complete: {len(results)} covers, {sum(r['bytes'] for r in results) / 1024**2:.1f} MiB", flush=True)


if __name__ == '__main__':
    main()
