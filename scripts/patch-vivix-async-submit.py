"""Return a durable video job before waiting on the slow provider submission."""
from pathlib import Path
import argparse

def patch_source(source):
    marker = 'name=f"submit-{job_id}"'
    if marker in source:
        return source
    route = source.index('@router.post("/v1/videos")')
    start = source.index('    t0 = time.perf_counter()\n', route)
    end = source.index('    with db() as conn:\n', start)
    original = source[start:end]
    expected = '        return oai_error(e.message, e.status, e.code)'
    assert original.count(expected) == 1
    original = original.replace(expected, '        return')
    original = original.replace('    if vivix_id:\n', '''    if not vivix_id:
        upsert_job({"id": job_id, "status": "failed", "error": "upstream returned no video id",
                    "updated_at": int(time.time()), "completed_at": int(time.time())})
        return
    if vivix_id:
''')
    worker = '    def submit_worker():\n        nonlocal session_email\n'
    worker += ''.join('    ' + line if line.strip() else line for line in original.splitlines(keepends=True))
    worker += '''    def guarded_submit():
        try:
            submit_worker()
        except Exception as error:
            upsert_job({"id": job_id, "status": "failed", "error": "video submission failed",
                        "updated_at": int(time.time()), "completed_at": int(time.time())})
            log_event(job_id, "error", {"where": "submit", "type": type(error).__name__})

    threading.Thread(target=guarded_submit, daemon=True, name=f"submit-{job_id}").start()

'''
    result = source[:start] + worker + source[end:]
    compile(result, '<vivix-async-submit>', 'exec')
    return result

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source'); parser.add_argument('output')
    args = parser.parse_args()
    Path(args.output).write_text(patch_source(Path(args.source).read_text(encoding='utf-8')), encoding='utf-8')
    print('Vivix asynchronous submission prepared')
