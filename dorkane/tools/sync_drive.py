"""Rebuild ../data.js from the public Google Drive folder that is the site.

Drive layout (folder names are matched loosely, Hebrew or English):
  <root folder>                        <- shared "anyone with the link"
    TouchDesigner/                     files here = shown under "הכל"
      נבחרות/   מגיב לסאונד/   אבסטרקט/   (any other subfolder = regular)
      a file with "reel" or "תיק עבודות" in its name = the reel button
    וידאו/                             files here = "סרטים"
      קצרים/                           = "קצרים וניסויים"
File name = title on the site. Put "1 ", "2 "... in front to set the order (the number is hidden).
Run: python3 sync_drive.py <root folder id>
"""
import html, json, re, sys, urllib.request
sys.path.insert(0, __file__.rsplit('/', 1)[0] if '/' in __file__ else '.')
from titles import clean

def listing(fid):
    req = urllib.request.Request('https://drive.google.com/embeddedfolderview?id=' + fid,
                                 headers={'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en'})
    page = urllib.request.urlopen(req, timeout=30).read().decode('utf-8')
    out = []
    for m in re.finditer(r'<a href="https://drive\.google\.com/(file/d|drive/folders)/([\w-]+)[^"]*".*?flip-entry-title">([^<]*)<', page, re.S):
        out.append(('folder' if 'folders' in m.group(1) else 'file', m.group(2), html.unescape(m.group(3)).strip()))
    return out

VIDEO_EXT = re.compile(r'\.(mov|mp4|m4v|webm|avi|mkv)$', re.I)
def order_key(name):
    name = re.sub(r'^(עותק של )+', '', name).strip()
    m = re.match(r'^\s*(\d+)[\s_-]+', name)
    return (int(m.group(1)) if m else 10**6, name.lower())
FILM_FIX = {'heavy matirials': 'Heavy materials', 'בעולם אחר- in another world': 'בעולם אחר – In another world',
            'i dreamt i was a butterfly': 'I dreamt I was a butterfly', 'working late waking early': 'Working late, waking early',
            'kanaan': 'Kanaan', 'faith': 'Faith'}
def title(name):
    n = re.sub(r'^(עותק של )+', '', name).strip()
    n = re.sub(r'^\s*\d+[\s_-]+(?=\D)', '', n)
    n = re.sub(r'\.(mp4|mov|m4v|webm|avi|mkv)\b', ' ', n, flags=re.I)
    n = re.sub(r'\b(dor kane|movie|final)\b|\b\d\d\.\d\d\s*$', ' ', n, flags=re.I)
    n = re.sub(r'\s+', ' ', n).strip()
    return FILM_FIX.get(n.lower()) or clean(n)
def files(fid):
    return sorted([(n, i) for k, i, n in listing(fid) if k == 'file' and VIDEO_EXT.search(n)], key=lambda x: order_key(x[0]))
def folders(fid):
    return [(n, i) for k, i, n in listing(fid) if k == 'folder']
def has(name, *words):
    n = name.lower()
    return any(w in n for w in words)

root = sys.argv[1]
td, films, reel = [], [], None
for name, fid in folders(root):
    if has(name, 'touch'):
        for fname, i in files(fid):
            if has(fname, 'reel', 'תיק עבודות'):
                reel = {'t': 'TouchDesigner reel', 'id': i}
            else:
                td.append({'t': title(fname), 'id': i, 'tag': 'td', 'sel': False})
        subs = folders(fid)
        if not any(has(sub, 'נבחר', 'select', 'best') for sub, _ in subs):
            for x in td: x['sel'] = True   # no "נבחרות" folder: files directly in the folder are the selected ones
        for sub, sid in subs:
            sel = has(sub, 'נבחר', 'select', 'best')
            tag = 'sound' if has(sub, 'סאונד', 'sound', 'music') else 'abstract' if has(sub, 'אבסטרקט', 'abstract') else 'td'
            for fname, i in files(sid):
                td.append({'t': title(fname), 'id': i, 'tag': tag, 'sel': sel})
    elif has(name, 'וידאו', 'video', 'סרט', 'film'):
        for fname, i in files(fid):
            films.append({'t': title(fname), 'id': i, 'kind': 'film'})
        for sub, sid in folders(fid):
            kind = 'short' if has(sub, 'קצר', 'short', 'ניסוי') else 'film'
            for fname, i in files(sid):
                films.append({'t': title(fname), 'id': i, 'kind': kind})

td.sort(key=lambda x: not x['sel'])  # selected first, keep order otherwise
if not td and not films:
    sys.exit('Nothing found in the Drive folder (is it shared "anyone with the link"?). data.js left unchanged.')
old = open('../data.js', encoding='utf-8').read()
prev = json.loads(old[old.index('{'):old.rindex('}') + 1])
data = {'reel': reel or prev.get('reel'), 'td': td or prev['td'], 'films': films or prev['films']}
open('../data.js', 'w', encoding='utf-8').write(
    '// Built automatically from the Google Drive folder. Edit the Drive folder, not this file.\n'
    'window.SITE = ' + json.dumps(data, ensure_ascii=False, indent=1) + ';\n')
print(len(td), 'TouchDesigner works,', sum(x['sel'] for x in td), 'selected,', len(films), 'films')
