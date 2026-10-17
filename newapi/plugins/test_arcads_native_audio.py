"""Verify the real bridge -> worker -> strict model payload without paid generations."""
import ast
import json
import os
import types
import unittest
import uuid
from pathlib import Path


def functions(path, names):
    tree = ast.parse(Path(path).read_text(encoding="utf-8"))
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert len(selected) == len(names)
    for node in selected:
        node.decorator_list = []
    return compile(ast.Module(body=selected, type_ignores=[]), str(path), "exec")


class Response(dict):
    def __init__(self, data):
        super().__init__(data)
        self.headers = {}


class Files(dict):
    def getlist(self, key):
        return []


class ImmediateThread:
    def __init__(self, target, args, **kwargs):
        self.target, self.args = target, args

    def start(self):
        self.target(*self.args)


class NativeAudioTest(unittest.TestCase):
    def setUp(self):
        bridge = os.environ.get("ARCADS_API_SOURCE", "tmp/arcads-audio-after.py")
        core_source = os.environ.get("ARCADS_CORE_SOURCE", "tmp/arcads-core-audio-before.py")
        tree = ast.parse(Path(core_source).read_text(encoding="utf-8"))
        caps = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id == "GEN_CAPS" for target in node.targets))
        self.bodies, self.jobs = [], {}
        def submit(*args, **kwargs):
            self.bodies.append(kwargs["json_body"])
            return types.SimpleNamespace(ok=True, json=lambda: [{"id": "mock-asset", "data": {}}])
        namespace = {
            "GEN_CAPS": caps, "GEN_ASPECTS_VIDEO": ["16:9"], "json": json,
            "gen_token": lambda _: ("test", "fake"), "get_brand_project": lambda *args: ("p", "prj", "w"),
            "_cap_label": lambda model: model, "validate_inputs": lambda *args: (True, ""),
            "upload_local_media": lambda token, refs, *args: refs,
            "describe_mode": lambda *args: "video", "arcads_api": submit,
            "gen_insert": lambda data: "g", "gen_update": lambda *args, **kwargs: None,
        }
        exec(functions(core_source, ["submit_generation"]), namespace)
        core = types.SimpleNamespace(GEN_CAPS=caps, submit_generation=namespace["submit_generation"],
            gen_cost_of=lambda *args, **kwargs: 0, new_job=lambda *args: None,
            poll_generation=lambda *args, **kwargs: "generated", log=lambda *args: None)
        def insert(jid, *args, **kwargs):
            self.jobs[jid] = {"id": jid, "account_id": 1, **kwargs}
        self.ns = {
            "core": core, "json": json, "uuid": uuid, "time": types.SimpleNamespace(time=lambda: 0),
            "threading": types.SimpleNamespace(Thread=ImmediateThread), "GEN_VIDEO_TIMEOUT": 10,
            "require_key": lambda: ({"id": 1}, None), "key_touch": lambda *args: None,
            "pick_account": lambda *args, **kwargs: 1,
            "resolve_model": lambda model, kind: (model, model), "size_to_ratio": lambda size: "16:9",
            "_res_of": lambda model, size: "480p", "job_insert": insert,
            "job_update": lambda jid, **kwargs: self.jobs[jid].update(kwargs),
            "job_get": lambda jid: self.jobs[jid], "video_object": lambda job: job,
            "jsonify": Response, "err": lambda message, status, *args, **kwargs: (message, status),
            "_data_url_of": lambda file: "data:image/png;base64,AA==",
        }
        names = ["_native_video_audio", "videos_create", "video_worker", "submit_video_with_failover"]
        if "def _reference_audio_list(" in Path(bridge).read_text(encoding="utf-8"):
            names.append("_reference_audio_list")
        exec(functions(bridge, names), self.ns)

    def request(self, model, fields, multipart=False, image=False):
        data = {"model": model, "prompt": "Ambient sound", "seconds": "5", **fields}
        files = Files()
        if image:
            if multipart:
                files["input_reference"] = types.SimpleNamespace(filename="frame.png")
            else:
                data["input_reference"] = "https://example.invalid/frame.png"
        self.ns["request"] = types.SimpleNamespace(
            content_type="multipart/form-data" if multipart else "application/json",
            form=data, files=files, get_json=lambda **kwargs: data)
        return self.ns["videos_create"]()

    def test_actual_model_payloads_for_default_true_and_explicit_false(self):
        for model, key in [("seedance_20", "audioEnabled"), ("seedance_20_mini", "audioEnabled"),
                           ("kling_30_4k", "generateAudio"), ("minimax_h3", None)]:
            for multipart in [False, True]:
                for image in [False, True]:
                    for field in [{}, {"generate_audio": True}, {"generate_audio": "false"}, {"with_audio": False}]:
                        with self.subTest(model=model, multipart=multipart, image=image, field=field):
                            result, status = self.request(model, field, multipart, image)
                            self.assertEqual(status, 200)
                            self.assertEqual(result["status"], "completed", result)
                            body = self.bodies[-1]
                            expected = not field or field.get("generate_audio") is True
                            if key:
                                self.assertEqual(body[key], expected)
                            for unsupported in {"generateAudio", "audioEnabled"} - {key}:
                                self.assertNotIn(unsupported, body)
                            self.assertNotIn("generate_audio", body)
                            self.assertEqual(bool(body.get("referenceImages") or body.get("startFrame")), image)

    def test_invalid_value_fails_before_account_or_generation(self):
        self.ns["pick_account"] = lambda *args, **kwargs: self.fail("must validate before selecting account")
        for multipart in [False, True]:
            _, status = self.request("seedance_20", {"generate_audio": "invalid"}, multipart)
            self.assertEqual(status, 400)
        self.assertFalse(self.jobs)
        self.assertFalse(self.bodies)

    def test_reference_audio_reaches_model_and_disables_native_sound(self):
        for multipart in [False, True]:
            for model in ["seedance_20", "seedance_20_mini", "minimax_h3", "wan_30", "seedance_25"]:
                refs = ["https://example.invalid/reference.wav"]
                result, status = self.request(model, {"generate_audio": True, "reference_audios": json.dumps(refs) if multipart else refs}, multipart)
                self.assertEqual(status, 200)
                self.assertEqual(result["status"], "completed", result)
                body = self.bodies[-1]
                self.assertEqual(body["referenceAudios"], refs)
                if "audioEnabled" in body: self.assertIs(body["audioEnabled"], False)

    def test_unsupported_audio_fails_before_creating_task(self):
        result, status = self.request("grok_video", {"reference_audios": ["https://example.invalid/ref.wav"]})
        self.assertEqual(status, 400)
        self.assertFalse(self.jobs)


if __name__ == "__main__":
    unittest.main()
