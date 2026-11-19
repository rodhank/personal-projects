"""Make a web-friendly mp4 (H.264, max 1280 wide, fast start) of every work in ../data.js
and store it as an asset of the GitHub release 'dorkane-media'. Works that have one get "m": 1,
so the site plays them directly instead of through the Google Drive player."""
import json, os, subprocess, sys, time

TAG = 'dorkane-media'
TIME_BUDGET = float(os.environ.get('MEDIA_BUDGET_MIN', '300')) * 60
t0 = time.time()

def sh(*a, check=True):
    return subprocess.run(a, check=check, capture_output=True, text=True)

if sh('gh', 'release', 'view', TAG, check=False).returncode != 0:
    sh('gh', 'release', 'create', TAG, '--title', 'Dor Kane – website videos',
       '--notes', 'Videos for the portfolio site, converted automatically from Google Drive. Do not edit by hand.')
have = {a['name'] for a in json.loads(sh('gh', 'release', 'view', TAG, '--json', 'assets').stdout)['assets']}

src = open('../data.js', encoding='utf-8').read()
data = json.loads(src[src.index('{'):src.rindex('}') + 1])
items = ([data['reel']] if data.get('reel') else []) + data['td'] + data['films']

todo = [it for it in items if it['id'] + '.mp4' not in have]
print(len(items), 'works,', len(todo), 'to convert')
for it in todo:
    if time.time() - t0 > TIME_BUDGET:
        print('time budget reached; the rest will be done on the next run'); break
    fid = it['id']; name = fid + '.mp4'
    try:
        sh('gdown', '--quiet', fid, '-O', 'in.bin')
        crf = '27' if it in data['films'] else '24'
        sh('ffmpeg', '-v', 'error', '-y', '-i', 'in.bin', '-map', '0:v:0', '-map', '0:a:0?',
           '-vf', "scale='min(1280,iw)':-2:flags=lanczos,format=yuv420p",
           '-c:v', 'libx264', '-preset', 'veryfast', '-crf', crf, '-profile:v', 'high',
           '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', name)
        sh('gh', 'release', 'upload', TAG, name, '--clobber')
        have.add(name)
        print('ok', it['t'], os.path.getsize(name) // 1024, 'KB')
    except subprocess.CalledProcessError as e:
        print('FAILED', it['t'], fid, (e.stderr or '')[-400:])
    finally:
        for f in ('in.bin', name):
            if os.path.exists(f): os.remove(f)

for it in items:
    if it['id'] + '.mp4' in have: it['m'] = 1
    else: it.pop('m', None)
open('../data.js', 'w', encoding='utf-8').write(src[:src.index('{')] + json.dumps(data, ensure_ascii=False, indent=1) + ';\n')
print(sum('m' in it for it in items), 'of', len(items), 'works play directly')
