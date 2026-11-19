import json, re, sys
sys.path.insert(0, '.')
from raw import *

FIX = {'alldancers': 'All dancers', 'alldancers2': 'All dancers 2', 'gravityboxes': 'Gravity boxes', 'gridcolor': 'Grid colour',
       'gridimages': 'Grid images', 'interactivewater-mouse': 'Interactive water (mouse)', 'miamivice': 'Miami vice',
       'flashyman': 'Flashy man', 'homerdesitigrate': 'Homer disintegrate', '3d_displacement': '3D displacement',
       'liquidlight': 'Liquid light', 'tdmovieout.0heart': 'Heart', 'sidebysidesdxl.11': 'Side by side (SDXL)',
       'rndom lines': 'Random lines', 'branacles': 'Barnacles', 'invisebily2': 'Invisibly', 'disintigrade': 'Disintegrate',
       'spagetti': 'Spaghetti', 'missles': 'Missiles', 'fongus': 'Fungus', 'graffity': 'Graffiti', 'tenticles': 'Tentacles',
       'tentacles2': 'Tentacles 2', 'mettalicflow': 'Metallic flow', 'caos': 'Chaos', 'caos2': 'Chaos 2', 'bb': 'BB',
       'vj loop': 'VJ loop', 'aiwithmusic': 'AI with music', 'aiwithmusic2': 'AI with music 2', 'ballsin': 'Balls in',
       'changeimagetry2': 'Changing image', 'copiedfromshow': 'From the show', 'cosmicfire': 'Cosmic fire',
       'faceswap': 'Face swap', 'inin': 'In in', 'inwardvortex': 'Inward vortex', 'vortexin': 'Vortex in', 'imageinimage': 'Image in image',
       'jogo head no lag': 'Gojo head', 'space gojo': 'Space Gojo', 'glitcheffectsred': 'Glitch effects red',
       'glitcheffectsrefull': 'Glitch effects (full)', 'glitcheffects': 'Glitch effects', 'glitchvideo': 'Glitch video',
       'glitchparticles': 'Glitch particles', 'guitarfullinin2': 'Guitar in', 'guitartry': 'Guitar', 'metalguitar': 'Metal guitar',
       'napoleonfall': 'Napoleon fall', 'particlesspread': 'Particles spread', 'pixelman': 'Pixel man', 'spacerock': 'Space rock',
       'stringpig': 'String pig', 'shapeslibrary': 'Shapes library', 'spinball': 'Spin ball', 'swirlline': 'Swirl line',
       'movingtorus': 'Moving torus', 'purplesea': 'Purple sea', 'gaussiansplat': 'Gaussian splat', 'lightroom': 'Light room',
       'lightspace': 'Light space', 'lightballs': 'Light balls', 'lightshow': 'Light show', 'inkwaters': 'Ink waters',
       'flowcolor': 'Flow colour', 'flowstring': 'Flow string', 'fastlines': 'Fast lines', 'kinect work': 'Kinect',
       'smoke fill word': 'Smoke-filled word', 'mapping': 'Projection mapping', 'amebas': 'Amoebas', 'ink2': 'Ink',
       '3dhead': '3D head', '3d worm': '3D worm', 'liquid fluo': 'Liquid fluo', 'liquid fluo2': 'Liquid fluo 2'}

def clean(name):
    n = re.sub(r'^(עותק של )+', '', name).strip()
    n = re.sub(r'\.(mov|mp4)$', '', n, flags=re.I).strip()
    key = n.lower()
    if key in FIX:
        return FIX[key]
    m = re.match(r'^3dobjects(\d*)$', key)
    if m:
        return '3D objects' + (' ' + m.group(1) if m.group(1) else '')
    m = re.match(r'^memory_?(\d+)$', key)
    if m:
        return 'Memory ' + m.group(1)
    m = re.match(r'^(music|extra|particles)(\d+)$', key)
    if m:
        return m.group(1).capitalize() + ' ' + m.group(2)
    n = n.replace('_', ' ').replace('-', ' ')
    n = n.lower()
    return n[:1].upper() + n[1:]

seen = {}
items = []
def add(lst, tag, selected=False):
    for name, fid in lst:
        t = clean(name)
        k = t.lower()
        if k in seen:
            if selected:
                items[seen[k]]['sel'] = True
            continue
        seen[k] = len(items)
        items.append({'t': t, 'id': fid, 'tag': tag, 'sel': selected})
add(CURATED, 'td', True)
add(SOUND, 'sound')
add(ABSTRACT, 'abstract')
add(TD, 'td')
# tag curated items that are sound reactive / abstract by name
for it in items:
    if it['t'].lower().startswith(('music', 'metal guitar', 'guitar', 'ai with music')):
        it['tag'] = 'sound'

films = [{'t': t, 'id': i, 'kind': k} for t, i, k in FILMS]
data = {'reel': {'t': 'TouchDesigner reel', 'id': REEL[1]}, 'td': items, 'films': films}
open('../data.js', 'w', encoding='utf-8').write(
    '// Site content. To add a work: copy a line, paste the Google Drive file id (the part after /file/d/),\n'
    '// change the title. Drive files must be shared as "anyone with the link".\n'
    'window.SITE = ' + json.dumps(data, ensure_ascii=False, indent=1) + ';\n')
print(len(items), 'td clips;', sum(i['sel'] for i in items), 'selected;', len(films), 'films')
print([i['t'] for i in items][:60])
