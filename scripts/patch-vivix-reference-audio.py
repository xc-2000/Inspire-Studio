"""Expose the official audio upload route through the existing authenticated gateway."""
from pathlib import Path
import argparse

def patch_source(source):
    if '@router.post("/v1/files/audios")' in source:
        return source
    marker='@router.post("/v1/files/images")'
    assert source.count(marker)==1
    route='''@router.post("/v1/files/audios")
async def upload_audio(request: Request):
    key = require_key(request)
    form = await request.form()
    up = form.get("file")
    if not isinstance(up, StarletteUpload):
        return oai_error("field 'file' is required", 400, "invalid_request_error", "file")
    content = await up.read()
    if not content or len(content) > 2 * 1024 * 1024:
        return oai_error("reference audio must be at most 2MB", 400, "invalid_request_error", "file")
    if (up.content_type or "").lower() not in ("audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"):
        return oai_error("reference audio must be MP3 or WAV", 415, "invalid_request_error", "file")
    result = _req("POST", f"{UPSTREAM}/v1/files/audios",
                  headers={"Authorization": f"Bearer {key}"},
                  files={"file": (up.filename or "reference.wav", content, up.content_type)}, timeout=120)
    if result.status_code != 200:
        return oai_error(_upstream_msg(result), result.status_code, "upstream_error")
    data = result.json().get("data") or {}
    return {"id": data.get("file_id"), "object": "file", "bytes": len(content),
            "created_at": int(time.time()), "filename": up.filename, "purpose": "audio", "url": data.get("url")}


'''
    source=source.replace(marker,route+marker,1)
    compile(source,'<vivix-audio-upload>','exec')
    return source

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('source');parser.add_argument('output');args=parser.parse_args()
    Path(args.output).write_text(patch_source(Path(args.source).read_text(encoding='utf-8')),encoding='utf-8')
    print('Vivix audio upload route prepared')
