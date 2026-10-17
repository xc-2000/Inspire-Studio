"""Preserve model schemas while carrying reference audio through the existing bridge."""
import argparse
from pathlib import Path


def patch_source(source):
    if 'def _reference_audio_list(' in source:
        return source
    replacements = [
        ('resolution=None, generate_audio=True):', 'resolution=None, generate_audio=True, ref_audios=None):'),
        ('audio_enabled=generate_audio, logf=logf)', 'audio_enabled=False if ref_audios else generate_audio, ref_audios=ref_audios, logf=logf)'),
        ('cost_hint=None, generate_audio=True):', 'cost_hint=None, generate_audio=True, ref_audios=None):'),
        ('resolution=_res_of(model, size), generate_audio=generate_audio)', 'resolution=_res_of(model, size), generate_audio=False if ref_audios else generate_audio, ref_audios=ref_audios)'),
        ('        generate_audio = _native_video_audio(audio_fields)', '''        ref_audios = _reference_audio_list(audio_fields)
        if request.content_type and "multipart/form-data" in request.content_type:
            uploads = request.files.getlist("reference_audios") or request.files.getlist("audio")
            if uploads:
                ref_audios = [_data_url_of(f) for f in uploads if f and f.filename]
        if len(ref_audios) > 3:
            raise ValueError("At most 3 reference audio files are supported")
        generate_audio = False if ref_audios else _native_video_audio(audio_fields)'''),
        ('    allow = caps.get("allow") or []\n\n    # seconds', '''    allow = caps.get("allow") or []
    if ref_audios and "referenceAudios" not in allow:
        return err(f"Model '{oai_model}' does not accept reference_audios", 400,
                   "invalid_request_error", param="reference_audios")

    # seconds'''),
        ('        cost_hint, generate_audio), daemon=True).start()', '        cost_hint, generate_audio, ref_audios), daemon=True).start()'),
    ]
    for before, after in replacements:
        if source.count(before) != 1:
            raise ValueError('Source changed: '+before[:80])
        source = source.replace(before, after, 1)
    helper = '''def _reference_audio_list(fields):
    value = fields.get("reference_audios") or fields.get("audio") or []
    if isinstance(value, str):
        value = json.loads(value) if value.lstrip().startswith("[") else [value]
    if not isinstance(value, list):
        raise ValueError("reference_audios must be an array")
    refs = []
    for item in value:
        url = item.get("url") if isinstance(item, dict) else item
        if not isinstance(url, str) or not url.startswith(("https://", "http://", "data:audio/")):
            raise ValueError("reference_audios requires audio URLs or data URLs")
        refs.append(url)
    return refs


'''
    source = source.replace('def _native_video_audio(fields):', helper+'def _native_video_audio(fields):', 1)
    compile(source, '<arcads-reference-audio>', 'exec')
    return source


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source'); parser.add_argument('output')
    args = parser.parse_args()
    Path(args.output).write_text(patch_source(Path(args.source).read_text(encoding='utf-8')),encoding='utf-8')
    print('Reference audio patch prepared')
