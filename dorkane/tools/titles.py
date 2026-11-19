import re

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

