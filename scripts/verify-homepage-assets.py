"""Verify the actual homepage cover URLs and bytes after a web deployment."""
import argparse
import hashlib
import pathlib
import re
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--base-url", required=True)
parser.add_argument("--source", default="web/src/app/(user)/page.tsx")
parser.add_argument("--public-root", default="web/public")
args = parser.parse_args()
root = pathlib.Path(args.public_root).resolve()
covers = re.findall(r'cover:\s*"(/homepage/entries/[^"]+)"', pathlib.Path(args.source).read_text(encoding="utf-8"))
assert len(covers) == 4, "Homepage cover references are missing or changed; update this deployment check."
for cover in covers:
    source = (root / cover.lstrip("/")).resolve()
    assert source.is_relative_to(root), "Invalid public asset path"
    request = urllib.request.Request(args.base_url.rstrip("/") + cover, headers={"User-Agent": "InspireStudio-Asset-Check/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        assert response.status == 200, cover
        assert response.headers.get_content_type() == "image/webp", cover
        content = response.read()
    assert hashlib.sha256(content).digest() == hashlib.sha256(source.read_bytes()).digest(), "Asset differs: " + cover
    print("Verified:", cover, len(content), "bytes")
