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
    m = re.match(r'^\s*(\d+)[\s._-]+', name)
    return (int(m.group(1)) if m else 10**6, name.lower())
def title(name):
    return clean(re.sub(r'^\s*\d+[\s._-]+', '', name))
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
        for sub, sid in folders(fid):
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
