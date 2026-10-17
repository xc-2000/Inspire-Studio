"""Patch the Arcads OpenAI bridge to pass native audio through its strict model schemas."""
import argparse
from pathlib import Path


def patch_source(source):
    if "def _native_video_audio(" in source:
        return source
    replacements = [
        ("start_frame, cost_hint, logf, tries=3, resolution=None):",
         "start_frame, cost_hint, logf, tries=3, resolution=None, generate_audio=True):"),
        ("start_frame=start_frame, logf=logf)",
         "start_frame=start_frame, generate_audio=generate_audio,\n"
         "                audio_enabled=generate_audio, logf=logf)"),
        ("start_frame=None, cost_hint=None):",
         "start_frame=None, cost_hint=None, generate_audio=True):"),
        ("cost_hint, logf, resolution=_res_of(model, size))",
         "cost_hint, logf, resolution=_res_of(model, size), generate_audio=generate_audio)"),
        ('        prompt = (request.form.get("prompt") or "").strip()\n        model_raw = request.form.get("model")\n        size =',
         '        audio_fields = request.form\n        prompt = (request.form.get("prompt") or "").strip()\n        model_raw = request.form.get("model")\n        size ='),
        ('        body = request.get_json(silent=True) or {}\n        prompt = (body.get("prompt") or "").strip()\n        model_raw = body.get("model")\n        size =',
         '        body = request.get_json(silent=True) or {}\n        audio_fields = body\n        prompt = (body.get("prompt") or "").strip()\n        model_raw = body.get("model")\n        size ='),
        ('        ref_list = body.get("reference_images")\n    if not prompt:',
         '        ref_list = body.get("reference_images")\n'
         '    try:\n        generate_audio = _native_video_audio(audio_fields)\n'
         '    except ValueError as exc:\n'
         '        return err(str(exc), 400, "invalid_request_error", param="generate_audio")\n'
         '    if not prompt:'),
        ("        cost_hint), daemon=True).start()", "        cost_hint, generate_audio), daemon=True).start()"),
    ]
    for before, after in replacements:
        if source.count(before) != 1:
            raise ValueError("Arcads source differs; review the audio patch before applying: " + before[:60])
        source = source.replace(before, after, 1)
    helper = '''
def _native_video_audio(fields):
    """Native video sound defaults on. Reference audio remains a separate input."""
    for name in ("generate_audio", "with_audio", "audio_enabled", "generateAudio", "audioEnabled"):
        value = fields.get(name)
        if value is None:
            continue
        if isinstance(value, bool):
            return value
        normalized = str(value).strip().lower()
        if normalized in ("true", "1"):
            return True
        if normalized in ("false", "0"):
            return False
        raise ValueError("generate_audio must be a boolean")
    return True


'''
    marker = '@v1.route("/v1/videos", methods=["POST"])'
    if source.count(marker) != 1:
        raise ValueError("Video route was not found")
    return source.replace(marker, helper + marker, 1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("output")
    args = parser.parse_args()
    source = Path(args.source).read_text(encoding="utf-8")
    result = patch_source(source)
    compile(result, args.output, "exec")
    Path(args.output).write_text(result, encoding="utf-8")
    print("Arcads native audio patch prepared")
