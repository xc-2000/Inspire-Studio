"""Prepare the Infinite Canvas snapshot for import; never connects to a database.

Run from any directory with Python 3 and Pillow:
    python scripts/import-infinite-canvas-prompts.py

Original prompts stay byte-for-byte identical as strings. NFKC plus collapsed
Unicode whitespace is used only for grouping. Images retain their original bytes.
The manifest is saved atomically during downloads, so rerunning resumes safely.
Failed URLs are retried on the next run and are always listed in report.json.
"""
from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import posixpath
import re
import threading
import time
import unicodedata
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from PIL import Image, ImageSequence


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SNAPSHOT = ROOT / 'third-party/prompts/infinite-canvas-20261006'
COVERS = ROOT / 'web/public/prompts/covers'
OLD_MANIFEST = ROOT / 'third-party/prompts/local-covers.json'
EXTENSIONS = {'JPEG': 'jpg', 'PNG': 'png', 'WEBP': 'webp', 'GIF': 'gif',
              'AVIF': 'avif', 'BMP': 'bmp', 'TIFF': 'tiff'}
# Reviewed against the complete source tag inventory. Model names and ordinary
# purpose/style tags are retained; attribution stays in source.json and mapping.
ATTRIBUTION_TAGS = {
    'freestylefly', 'awesome-gpt-image-2', 'moosl', 'awsome-gpt-image-2-prompts',
    'open-design', 'rezzycheck (sora)', 'photis (sora)', 'terry623', 'gizakdag',
    'animeai', '老板原创',
}


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write_json(path, value):
    temp = path.with_name(path.name + f'.{threading.get_ident()}.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)


def folded(value):
    return ' '.join(unicodedata.normalize('NFKC', value).split())


def canonical_url(url):
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.netloc:
        raise ValueError('Cover URL must be HTTP(S) with a hostname')
    path = posixpath.normpath(parts.path)
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(),
                      quote(path, safe="/%:@!$&'()*+,;=-._~"), parts.query, ''))


def inspect_image(data):
    with Image.open(io.BytesIO(data)) as image:
        image_format = image.format
        width, height = image.size
        image.verify()
    # verify() checks structure; load() also verifies that actual pixel data decodes.
    with Image.open(io.BytesIO(data)) as image:
        frames = 0
        for frame in ImageSequence.Iterator(image):
            frame.load()
            frames += 1
    if image_format not in EXTENSIONS:
        raise ValueError(f'Unsupported image format: {image_format}')
    return {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
            'width': width, 'height': height, 'format': image_format, 'frames': frames}


def existing_image(entry):
    local_url = entry.get('localUrl', '')
    if not local_url.startswith('/prompts/covers/'):
        return None
    path = COVERS / Path(local_url).name
    if not path.is_file():
        return None
    try:
        metadata = inspect_image(path.read_bytes())
        if metadata['sha256'] != path.stem:
            return None
        provenance = {key: entry[key] for key in ('derivation', 'derived', 'frameSeconds', 'sourceSha256',
                                                 'sourceBytes', 'originalMedia', 'notes', 'resolvedUrl') if key in entry}
        return {**metadata, **provenance, 'localUrl': local_url, 'status': 'ok'}
    except Exception:
        return None


def download_image(url, timeout, retries):
    attempts = []
    for attempt in range(retries):
        try:
            request = Request(canonical_url(url), headers={
                'User-Agent': 'Mozilla/5.0 (compatible; PromptLibraryArchive/1.0)',
                'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
            })
            with urlopen(request, timeout=timeout) as response:
                data = response.read()
                resolved_url = response.geturl()
            metadata = inspect_image(data)
            filename = metadata['sha256'] + '.' + EXTENSIONS[metadata['format']]
            destination = COVERS / filename
            if not destination.exists() or hashlib.sha256(destination.read_bytes()).hexdigest() != metadata['sha256']:
                temporary = COVERS / (filename + f'.{threading.get_ident()}.tmp')
                temporary.write_bytes(data)
                temporary.replace(destination)
            return {**metadata, 'localUrl': '/prompts/covers/' + filename,
                    'resolvedUrl': resolved_url, 'status': 'ok', 'origin': 'download',
                    'attempts': attempt + 1}
        except Exception as error:
            attempts.append({'attempt': attempt + 1, 'type': type(error).__name__,
                             'message': str(error),
                             'httpStatus': error.code if isinstance(error, HTTPError) else None})
            # A missing/forbidden file needs source repair, not repeated identical traffic.
            if isinstance(error, HTTPError) and error.code in (400, 401, 403, 404, 410):
                break
            if attempt + 1 < retries:
                time.sleep(min(2 ** attempt, 8))
    return {'status': 'error', 'attempts': len(attempts), 'errors': attempts}


def title_score(row):
    title = folded(row.get('title') or '')
    return (bool(title), 2 <= len(title) <= 100, len(title) <= 200,
            not bool(re.search(r'https?://|!\[|```', title)), -len(title))


def shorten_title(title):
    title = folded(title)
    if len(title) <= 200:
        return title
    text = title[:199]
    # Prefer a word boundary when it does not discard too much information.
    if ' ' in text[-30:]:
        text = text.rsplit(' ', 1)[0]
    return text.rstrip(' ,;:，；：') + '…'


def category_for(title, tags):
    lowered = {folded(tag).lower() for tag in tags}
    if any(tag.startswith('视频模板') for tag in lowered):
        return '视频与动画'
    rules = [
        ('摄影与写实', {'摄影', '照片级写实', '真实摄影', '食物摄影', 'photography', 'photorealistic', 'photorealism'}),
        ('人像与头像', {'头像', '个人资料', '人像', '角色肖像', 'portrait', 'avatar', 'profile', 'character-portrait'}),
        ('产品与电商', {'电商主图', '产品营销', '电商', '产品', '产品展示图', 'product', 'product design', 'packaging', 'ecommerce', 'e-commerce'}),
        ('海报与排版', {'海报设计', '品牌海报设计', '字体排版', '创意字体', 'poster', 'poster design', 'typography'}),
        ('插画与分镜', {'漫画', '故事板', '插画', '动漫', 'illustration', 'comic', 'storyboard', 'sticker'}),
        ('信息图与教育', {'信息图', '信息图设计', '教育视觉图', '教育', '文档', '文档设计', '知识科普', 'infographic', 'infographics education', 'education', 'diagram', 'document', 'documents'}),
        ('游戏与角色', {'游戏素材', '游戏', '角色', 'character design', 'character', 'game', 'game asset', 'game_ui'}),
        ('图像编辑', {'图像编辑', '图片编辑', '风格迁移', '一致性', 'image editing', 'style transfer', 'consistency'}),
        ('界面设计', {'ui', 'ux', 'ui与界面', 'ui 界面复刻', 'ui design', 'web design', 'interface'}),
        ('视频与动画', {'视频', '动画', 'video', 'animation', 'video animation'}),
        ('社媒配图', {'社交媒体帖子', 'youtube 缩略图', '社交媒体', 'social media', 'social media mockup', 'thumbnail'}),
    ]
    for category, words in rules:
        if lowered & words:
            return category
    patterns = [
        ('海报与排版', r'海报|排版|杂志|封面|poster|typography'),
        ('产品与电商', r'商品|产品|电商|包装|product|packaging'),
        ('人像与头像', r'人像|头像|肖像|写真|portrait|avatar'),
        ('插画与分镜', r'插画|漫画|分镜|绘本|贴纸|动漫|像素|illustration|comic|sticker'),
        ('摄影与写实', r'摄影|写实|照片|拍摄|photo'),
        ('游戏与角色', r'游戏|角色|game|character'),
        ('信息图与教育', r'信息图|教育|图解|infographic|diagram'),
        ('界面设计', r'界面|网页|\bui\b|\bux\b'),
    ]
    for category, pattern in patterns:
        if re.search(pattern, title, re.I):
            return category
    return '创意图像'


def prepare_groups(rows):
    groups = {}
    for index, row in enumerate(rows):
        if not isinstance(row.get('prompt'), str) or not folded(row['prompt']):
            raise ValueError(f'Empty or invalid prompt at source row {index}')
        key = folded(row['prompt'])
        if key not in groups:
            groups[key] = {'id': 'ic-' + hashlib.sha256(key.encode()).hexdigest()[:24],
                           'keySha256': hashlib.sha256(key.encode()).hexdigest(), 'members': []}
        groups[key]['members'].append((index, row))
    return list(groups.values())


def build_outputs(rows, groups, covers, snapshot, started_at):
    normalized, mapping, title_changes = [], [], []
    all_missing = []
    for order, group in enumerate(groups):
        members = group['members']
        best_index, best = max(members, key=lambda pair: (bool(pair[1].get('coverUrl')), title_score(pair[1]), -pair[0]))
        _, title_source = max(members, key=lambda pair: (title_score(pair[1]), -pair[0]))
        original_title = title_source.get('title') or '创意图像提示词'
        title = shorten_title(original_title)
        if title != original_title:
            title_changes.append({'normalizedId': group['id'], 'sourceId': title_source['id'],
                                  'originalTitle': original_title, 'title': title})
        merged_tags, seen_tags = [], set()
        for _, row in members:
            for tag in row.get('tags') or []:
                if not isinstance(tag, str) or not tag.strip():
                    continue
                key = folded(tag).casefold()
                if key not in seen_tags and key not in ATTRIBUTION_TAGS and not key.startswith('@'):
                    seen_tags.add(key)
                    merged_tags.append(tag)
        cover_url = ''
        chosen_cover = None
        for _, row in sorted(members, key=lambda pair: (pair[0] != best_index, pair[0])):
            cover = covers.get(row.get('coverUrl'))
            if cover and cover.get('status') == 'ok':
                cover_url = cover['localUrl']
                chosen_cover = row['coverUrl']
                break
        if not cover_url:
            all_missing.append({'normalizedId': group['id'], 'sourceIds': [row['id'] for _, row in members],
                                'title': title, 'reason': 'no-source-cover' if not any(row.get('coverUrl') for _, row in members) else 'download-failed'})
        source_url = best.get('githubUrl') or best.get('sourceUrl') or ''
        normalized.append({'id': group['id'], 'title': title, 'prompt': best['prompt'],
                           'coverUrl': cover_url, 'preview': '', 'category': category_for(title, merged_tags),
                           'tags': merged_tags, 'sourceUrl': source_url, 'status': 1, 'sortOrder': order})
        mapping.append({'normalizedId': group['id'], 'dedupKeySha256': group['keySha256'],
                        'selectedPromptSourceId': best['id'], 'selectedTitleSourceId': title_source['id'],
                        'selectedCoverOriginalUrl': chosen_cover,
                        'sourceIds': [row['id'] for _, row in members],
                        'sourceIndexes': [index for index, _ in members],
                        'provenance': [{'sourceId': row['id'], 'sourceUrl': row.get('githubUrl') or row.get('sourceUrl') or '',
                                        'originalCategory': row.get('category'), 'originalTitle': row.get('title'),
                                        'originalTags': row.get('tags') or [],
                                        'originalCoverUrl': row.get('coverUrl'), 'createdAt': row.get('createdAt'),
                                        'updatedAt': row.get('updatedAt')} for _, row in members]})
    unique_files = {entry['sha256']: entry for entry in covers.values() if entry.get('status') == 'ok'}
    report = {
        'source': 'https://p01--infinite-canvas--vv2f2lsn9vkn.code.run/',
        'startedAt': started_at, 'generatedAt': datetime.now(timezone.utc).isoformat(),
        'sourceFileSha256': hashlib.sha256((snapshot / 'source.json').read_bytes()).hexdigest(),
        'sourceCount': len(rows), 'normalizedCount': len(normalized),
        'duplicateRowsRemoved': len(rows) - len(normalized),
        'duplicateGroups': sum(len(g['members']) > 1 for g in groups),
        'sourceRowsWithoutCover': [{'sourceId': row['id'], 'title': row['title']} for row in rows if not row.get('coverUrl')],
        'coverUrlCount': len(covers), 'successfulCoverUrls': sum(e.get('status') == 'ok' for e in covers.values()),
        'uniqueImageFiles': len(unique_files), 'uniqueImageBytes': sum(e['bytes'] for e in unique_files.values()),
        'failedCoverUrls': [e for e in covers.values() if e.get('status') == 'error'],
        'pendingCoverUrls': sum(e.get('status') == 'pending' for e in covers.values()),
        'normalizedWithCover': sum(bool(r['coverUrl']) for r in normalized),
        'normalizedWithoutCover': all_missing, 'titleChanges': title_changes,
        'categories': dict(Counter(row['category'] for row in normalized)),
        'removedAttributionTags': dict(Counter(tag for row in rows for tag in row.get('tags', [])
                                              if folded(tag).casefold() in ATTRIBUTION_TAGS or folded(tag).startswith('@'))),
        'dedupRule': 'NFKC(prompt), then collapse all Unicode whitespace; preserve selected original prompt text',
        'imagePolicy': 'Unmodified source image bytes, SHA-256 filenames, Pillow verify plus full pixel decode; any explicitly repaired media are marked with derivation metadata',
        'derivedCoverUrls': [entry for entry in covers.values() if entry.get('derivation') or entry.get('derived')],
        'previewPolicy': 'Empty; coverUrl supplies local artwork and source preview remains in source.json',
    }
    write_json(snapshot / 'normalized.json', normalized)
    write_json(snapshot / 'duplicate-mapping.json', mapping)
    write_json(snapshot / 'report.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot-dir', type=Path, default=DEFAULT_SNAPSHOT)
    parser.add_argument('--workers', type=int, default=10, choices=range(1, 13))
    parser.add_argument('--timeout', type=int, default=45)
    parser.add_argument('--retries', type=int, default=4)
    parser.add_argument('--offline', action='store_true', help='Only validate cached files and rebuild outputs')
    args = parser.parse_args()
    snapshot = args.snapshot_dir.resolve()
    started_at = datetime.now(timezone.utc).isoformat()
    rows = read_json(snapshot / 'source.json')
    groups = prepare_groups(rows)
    COVERS.mkdir(parents=True, exist_ok=True)
    manifest_path = snapshot / 'cover-manifest.json'
    caches = {}
    previous_failures = {}
    for path in (OLD_MANIFEST, manifest_path, snapshot / 'recovered-video-cover.json', snapshot / 'cover-overrides.json'):
        if path.exists():
            entries = read_json(path)
            for entry in entries if isinstance(entries, list) else [entries]:
                if entry.get('originalUrl') and entry.get('status') == 'error':
                    previous_failures[canonical_url(entry['originalUrl'])] = entry
                if entry.get('originalUrl') and entry.get('localUrl'):
                    caches[canonical_url(entry['originalUrl'])] = entry
    covers = {}
    for row in rows:
        url = row.get('coverUrl')
        if url:
            if url not in covers:
                covers[url] = {'originalUrl': url, 'sourceIds': [], 'status': 'pending'}
            covers[url]['sourceIds'].append(row['id'])
    pending, checked = [], {}
    for url, entry in covers.items():
        cache = caches.get(canonical_url(url))
        metadata = None
        if cache:
            cache_key = cache['localUrl']
            if cache_key not in checked:
                checked[cache_key] = existing_image(cache)
            metadata = checked[cache_key]
        if metadata:
            entry.update(metadata)
            entry['origin'] = 'cache'
        else:
            pending.append(url)
            if args.offline and canonical_url(url) in previous_failures:
                old_failure = previous_failures[canonical_url(url)]
                entry.update({key: old_failure[key] for key in ('status', 'errors', 'attempts') if key in old_failure})
    cached_count = len(covers) - len(pending)
    cached_bytes = sum(entry.get('bytes', 0) for entry in covers.values())
    estimated_total = cached_bytes / cached_count * len(covers) if cached_count else 0
    print(f'Prepared {len(rows)} source rows -> {len(groups)} unique prompts; {len(covers)} image URLs; '
          f'{cached_count} cached ({cached_bytes / 2**20:.1f} MiB), {len(pending)} pending. '
          f'Estimated total {estimated_total / 2**20:.1f} MiB.', flush=True)
    write_json(manifest_path, list(covers.values()))
    build_outputs(rows, groups, covers, snapshot, started_at)
    if not args.offline:
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(download_image, url, args.timeout, args.retries): url for url in pending}
            completed = 0
            for future in as_completed(futures):
                url = futures[future]
                result = future.result()
                covers[url].update(result)
                completed += 1
                if result['status'] == 'error':
                    print(f'FAILED {url}: {result["errors"][-1]["message"]}', flush=True)
                if completed % 10 == 0 or completed == len(pending):
                    write_json(manifest_path, list(covers.values()))
                if completed % 25 == 0 or completed == len(pending):
                    good = [e for e in covers.values() if e['status'] == 'ok']
                    bad = sum(e['status'] == 'error' for e in covers.values())
                    total_bytes = sum(e['bytes'] for e in good)
                    elapsed = time.monotonic() - started
                    print(f'Progress {cached_count + completed}/{len(covers)}; verified={len(good)}, '
                          f'failed={bad}, bytes={total_bytes / 2**20:.1f} MiB, elapsed={elapsed:.0f}s', flush=True)
    report = build_outputs(rows, groups, covers, snapshot, started_at)
    print(f'Complete: {report["normalizedCount"]} prompts; {report["normalizedWithCover"]} have local covers; '
          f'{report["uniqueImageFiles"]} distinct files ({report["uniqueImageBytes"] / 2**20:.1f} MiB); '
          f'{len(report["failedCoverUrls"])} failed URLs; {report["pendingCoverUrls"]} pending. '
          'See report.json for all omissions.', flush=True)


if __name__ == '__main__':
    main()
