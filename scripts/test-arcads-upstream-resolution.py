"""Verify the Arcads OpenAI endpoint through its worker without paid generation."""
import ast
import base64
import importlib.util
import io
import os
import pathlib
import types
import unittest
from unittest.mock import Mock, patch
from flask import Flask

SOURCE=pathlib.Path(os.environ.get('ARCADS_API_SOURCE','D:/deepseekP/openai_api.py'))
CORE=pathlib.Path(os.environ.get('ARCADS_CORE_SOURCE',str(SOURCE.with_name('arcads_web.py'))))

class VideoResolutionTests(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('arcads_resolution_test',SOURCE)
        self.api=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.api)
        caps=next(ast.literal_eval(node.value) for node in ast.parse(CORE.read_text(encoding='utf-8-sig')).body
                  if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='GEN_CAPS' for t in node.targets))
        self.core=types.SimpleNamespace(GEN_CAPS=caps,GEN_DEFAULT_VIDEO='seedance_20_mini',
            gen_cost_of=Mock(return_value=15),new_job=Mock(),log=Mock(),
            submit_generation=Mock(return_value=('generation-1','asset-1','video','workspace-1','text-to-video')),
            poll_generation=Mock(return_value='generated'))
        app=Flask(__name__)
        self.api.init(app,self.core)
        self.client=app.test_client()
        self.jobs={}
        self.pending=[]
        self.api.require_key=lambda:({'id':999},None)
        self.api.key_touch=Mock()
        self.api.pick_account=Mock(return_value=1)
        self.api.job_insert=lambda jid,key,kind,model,aid,prompt,**kw:self.jobs.update({jid:dict(id=jid,model=model,account_id=aid,prompt=prompt,**kw)})
        self.api.job_get=lambda jid:self.jobs[jid]
        self.api.job_update=lambda jid,**kw:self.jobs[jid].update(kw)
        pending=self.pending
        class PendingThread:
            def __init__(self,*,target,args,daemon):self.target,self.args=target,args
            def start(self):pending.append(self)
        thread=patch.object(self.api.threading,'Thread',PendingThread)
        thread.start();self.addCleanup(thread.stop)

    def generate(self,*,size='480x854',image=False,multipart=False,model='seedance-2.0-mini'):
        payload=dict(model=model,prompt='Keep the reference subject and animate the scene.',seconds='5',size=size)
        if image:payload['input_reference']='https://example.invalid/reference.png'
        if multipart:
            payload['input_reference']=(io.BytesIO(b'image-fixture'),'reference.png')
            response=self.client.post('/v1/videos',data=payload,content_type='multipart/form-data')
        else:response=self.client.post('/v1/videos',json=payload)
        self.assertEqual(response.status_code,200,response.get_json())
        result=response.get_json()
        self.assertEqual(result['status'],'queued')
        self.assertEqual(result['seconds'],'5')
        self.assertEqual(result['size'],size)
        self.assertEqual(len(self.pending),1)
        thread=self.pending.pop()
        thread.target(*thread.args)
        self.assertEqual(self.jobs[result['id']]['status'],'completed',self.jobs[result['id']])
        return result

    def test_documented_size_drives_both_cost_and_generation_in_portrait_and_landscape(self):
        for size,resolution,ratio in [('480x854','480p','9:16'),('854x480','480p','16:9'),
                                      ('720x1280','720p','9:16'),('1280x720','720p','16:9')]:
            with self.subTest(size=size):
                self.generate(size=size)
                expected=self.core.gen_cost_of.call_args.kwargs['resolution']
                sent=self.core.submit_generation.call_args.kwargs
                self.assertEqual(expected,resolution)
                self.assertEqual(sent['resolution'],expected)
                self.assertEqual(sent['aspect_ratio'],ratio)
                self.assertEqual(sent['duration'],5)

    def test_json_image_reference_is_preserved_with_480p(self):
        self.generate(image=True)
        sent=self.core.submit_generation.call_args.kwargs
        self.assertEqual(sent['resolution'],'480p')
        self.assertEqual(sent['ref_images'],['https://example.invalid/reference.png'])
        self.assertIsNone(sent['start_frame'])
        self.assertEqual(self.core.submit_generation.call_count,1)

    def test_multipart_image_is_preserved_with_480p(self):
        self.generate(multipart=True)
        sent=self.core.submit_generation.call_args.kwargs
        self.assertEqual(sent['resolution'],'480p')
        self.assertEqual(sent['ref_images'],['data:image/png;base64,'+base64.b64encode(b'image-fixture').decode()])

    def test_first_frame_model_preserves_start_frame_and_480p(self):
        self.generate(image=True,model='seedance-2.5')
        sent=self.core.submit_generation.call_args.kwargs
        self.assertEqual(sent['resolution'],'480p')
        self.assertEqual(sent['start_frame'],'https://example.invalid/reference.png')
        self.assertIsNone(sent['ref_images'])

    def test_credit_failover_retains_resolution_and_reference(self):
        self.api.pick_account.side_effect=[1,2]
        self.core.submit_generation.side_effect=[RuntimeError('HTTP 402 NOT_ENOUGH_CREDITS'),
            ('generation-2','asset-2','video','workspace-2','image-to-video')]
        result=self.generate(image=True)
        self.assertEqual(self.core.submit_generation.call_count,2)
        for call in self.core.submit_generation.call_args_list:
            self.assertEqual(call.kwargs['resolution'],'480p')
            self.assertEqual(call.kwargs['ref_images'],['https://example.invalid/reference.png'])
        self.assertEqual(self.jobs[result['id']]['account_id'],2)

if __name__=='__main__':unittest.main(verbosity=2)
