#!/usr/bin/env python3
"""
Protocol test server for the LiDAR Bridge website – for developing the site WITHOUT a phone.

It serves ../web on http://localhost:8080 and streams frames on ws://localhost:8081 using exactly
the same binary protocol as the iPhone app (see PROTOCOL.md). The depth comes from ray-casting a
simple synthetic room, so you can check every feature of the website on a computer.
The real data source is the iPhone app; this file is only a test harness.

    pip install websockets numpy pillow
    python3 tools/protocol_test_server.py
    open http://localhost:8080
"""
import asyncio, io, json, math, os, struct, threading, time, uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial

import numpy as np
from PIL import Image
import websockets

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web')
DW, DH = 256, 192                    # ARKit LiDAR depth resolution
IW, IH = 1920, 1440                  # captured image resolution the intrinsics refer to
FX = FY = 1450.0; CX, CY = 960.0, 720.0
ROOM = dict(x0=-2.0, x1=2.0, y0=-1.4, y1=1.6, z0=-4.5, z1=1.5)
SPHERE = (np.array([0.4, -0.9, -2.2]), 0.45)
TABLE = (np.array([-1.1, -1.4, -3.0]), np.array([-0.3, -0.65, -2.2]))  # axis-aligned box


def build(msg_type, header, buffers):
    payload = bytearray(); entries = []
    for name, data in buffers:
        payload += b'\0' * ((4 - len(payload) % 4) % 4)
        entries.append({'name': name, 'offset': len(payload), 'length': len(data)})
        payload += data
    header = dict(header, buffers=entries)
    js = json.dumps(header).encode()
    js += b' ' * ((4 - (12 + len(js)) % 4) % 4)
    return b'LDR1' + bytes([msg_type, 0, 0, 0]) + struct.pack('<I', len(js)) + js + bytes(payload)


def camera_pose(t):
    yaw = 0.55 * math.sin(t * 0.35)
    pitch = -0.12 + 0.08 * math.sin(t * 0.5)
    pos = np.array([0.6 * math.sin(t * 0.25), 0.05 * math.sin(t * 0.9), 0.4 + 0.3 * math.cos(t * 0.2)])
    cy_, sy_ = math.cos(yaw), math.sin(yaw); cp, sp = math.cos(pitch), math.sin(pitch)
    Ry = np.array([[cy_, 0, sy_], [0, 1, 0], [-sy_, 0, cy_]])
    Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    R = Ry @ Rx
    T = np.eye(4); T[:3, :3] = R; T[:3, 3] = pos
    return T


def raycast(T, w, h):
    sx, sy = w / IW, h / IH
    fx, fy, cx, cy = FX * sx, FY * sy, CX * sx, CY * sy
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    dc = np.stack([(u - cx) / fx, -(v - cy) / fy, -np.ones_like(u)], -1)       # camera rays, z = -1
    R, o = T[:3, :3], T[:3, 3]
    d = dc @ R.T                                                               # world directions
    t = np.full(u.shape, np.inf); kind = np.zeros(u.shape, np.int8)
    # room (inside box): exit distance per axis
    for ax, (lo, hi), code in [(0, (ROOM['x0'], ROOM['x1']), 1), (1, (ROOM['y0'], ROOM['y1']), 2), (2, (ROOM['z0'], ROOM['z1']), 3)]:
        with np.errstate(divide='ignore', invalid='ignore'):
            tt = np.where(d[..., ax] > 0, (hi - o[ax]) / d[..., ax], (lo - o[ax]) / d[..., ax])
        tt = np.where(np.isfinite(tt) & (tt > 0), tt, np.inf)
        better = tt < t
        t = np.where(better, tt, t)
        floor_or_ceiling = code if ax != 1 else np.where(d[..., 1] < 0, 2, 4)
        kind = np.where(better, floor_or_ceiling, kind)
    # sphere
    c, r = SPHERE
    oc = o - c
    a = (d * d).sum(-1); b = 2 * (d @ oc); cc = oc @ oc - r * r
    disc = b * b - 4 * a * cc
    ts = np.where(disc > 0, (-b - np.sqrt(np.maximum(disc, 0))) / (2 * a), np.inf)
    ts = np.where(ts > 0, ts, np.inf)
    better = ts < t; t = np.where(better, ts, t); kind = np.where(better, 5, kind)
    # table box (slab test)
    lo, hi = TABLE
    with np.errstate(divide='ignore', invalid='ignore'):
        t1 = (lo - o) / d; t2 = (hi - o) / d
    tmin = np.nanmax(np.minimum(t1, t2), -1); tmax = np.nanmin(np.maximum(t1, t2), -1)
    tb = np.where((tmax >= tmin) & (tmin > 0), tmin, np.inf)
    better = tb < t; t = np.where(better, tb, t); kind = np.where(better, 6, kind)
    pts = o + d * t[..., None]
    return t.astype(np.float32), kind, pts           # depth == t because camera-space z of the ray is -t


def shade(kind, pts):
    img = np.zeros(kind.shape + (3,), np.float32)
    chk = ((np.floor(pts[..., 0] * 2) + np.floor(pts[..., 2] * 2) + np.floor(pts[..., 1] * 2)) % 2)[..., None]
    img = np.where((kind == 1)[..., None] | (kind == 3)[..., None], [0.75, 0.72, 0.66] - 0.08 * chk, img)
    img = np.where((kind == 2)[..., None], [0.55, 0.38, 0.22] + 0.08 * chk, img)
    img = np.where((kind == 4)[..., None], [0.92, 0.92, 0.9], img)
    n = (pts - SPHERE[0]) / SPHERE[1]
    lam = np.clip(n @ np.array([0.4, 0.8, 0.45]), 0.15, 1)[..., None]
    img = np.where((kind == 5)[..., None], np.array([0.85, 0.25, 0.2]) * lam, img)
    img = np.where((kind == 6)[..., None], [0.3, 0.5, 0.75], img)
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)


def frame_message(seq, t, cfg):
    T = camera_pose(t)
    depth, kind, _ = raycast(T, DW, DH)
    depth = depth + np.random.normal(0, 0.004, depth.shape).astype(np.float32) * depth
    conf = np.where(depth < 3.0, 2, np.where(depth < 4.5, 1, 0)).astype(np.uint8)
    edges = np.zeros_like(depth, bool)
    edges[1:-1, 1:-1] = np.abs(depth[1:-1, 2:] - depth[1:-1, :-2]) > 0.15 * depth[1:-1, 1:-1]
    conf[edges] = 0
    header = {
        'seq': seq, 't': t, 'wall': time.time() * 1000, 'tracking': 'normal' if t > 1 else 'limited:initializing',
        'depth': {'w': DW, 'h': DH, 'smoothed': cfg['smoothed']}, 'confidence': {'w': DW, 'h': DH},
        'imageSize': [IW, IH], 'intrinsics': [FX, FY, CX, CY],
        'transform': T.T.flatten().tolist(),                     # column-major
        'light': {'ambientIntensity': 950.0, 'colorTemperature': 5600.0},
        'meshAnchors': 6, 'planes': [] if not cfg['planes'] else [
            {'id': 'floor', 'alignment': 'horizontal', 'classification': 'floor', 'center': [0, 0, 0], 'extent': [4, 6], 'rotationY': 0,
             'transform': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, ROOM['y0'], -1.5, 1]},
            {'id': 'table', 'alignment': 'horizontal', 'classification': 'table', 'center': [0, 0, 0], 'extent': [0.8, 0.8], 'rotationY': 0,
             'transform': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.7, -0.65, -2.6, 1]},
        ],
    }
    header['display'] = display_info(T)
    bufs = [('depth', depth.astype('<f4').tobytes()), ('confidence', conf.tobytes())]
    if cfg['rgb']:
        w = cfg['rgbWidth']; h = round(w * IH / IW)
        _, k2, p2 = raycast(T, w, h)
        jpg = io.BytesIO(); Image.fromarray(shade(k2, p2)).save(jpg, 'JPEG', quality=int(cfg['jpegQuality'] * 100))
        header['rgb'] = {'w': w, 'h': h}
        bufs.append(('rgb', jpg.getvalue()))
    return build(1, header, bufs)


def display_info(T, near=0.01, far=1000.0):
    """Screen-oriented view data, as the LiDAR Browser app sends it (here: landscape, same aspect as the camera)."""
    W, H = IW, IH
    P = np.zeros((4, 4))
    P[0, 0] = 2 * FX / W; P[0, 2] = 1 - 2 * CX / W
    P[1, 1] = 2 * FY / H; P[1, 2] = 2 * CY / H - 1
    P[2, 2] = -(far + near) / (far - near); P[2, 3] = -2 * far * near / (far - near)
    P[3, 2] = -1
    return {'orientation': 'landscapeRight', 'viewport': [W / 2, H / 2],
            'viewTransform': T.T.flatten().tolist(), 'projection': P.T.flatten().tolist(),
            'normDepthBufferFromNormView': np.eye(4).flatten().tolist()}


def grid_quad(origin, ax_u, ax_v, nu, nv, cls):
    verts = [origin + ax_u * (i / nu) + ax_v * (j / nv) for j in range(nv + 1) for i in range(nu + 1)]
    idx = []
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i; b = a + 1; c = a + nu + 1; d = c + 1
            idx += [a, c, b, b, c, d]
    return np.array(verts, '<f4'), np.array(idx, '<u4'), np.full(len(idx) // 3, cls, np.uint8)


def mesh_message():
    x0, x1, y0, y1, z0, z1 = (ROOM[k] for k in ('x0', 'x1', 'y0', 'y1', 'z0', 'z1'))
    quads = [
        (np.array([x0, y0, z0]), np.array([x1 - x0, 0, 0]), np.array([0, 0, z1 - z0]), 2),   # floor
        (np.array([x0, y1, z0]), np.array([x1 - x0, 0, 0]), np.array([0, 0, z1 - z0]), 3),   # ceiling
        (np.array([x0, y0, z0]), np.array([x1 - x0, 0, 0]), np.array([0, y1 - y0, 0]), 1),   # back wall
        (np.array([x0, y0, z0]), np.array([0, 0, z1 - z0]), np.array([0, y1 - y0, 0]), 1),   # left wall
        (np.array([x1, y0, z0]), np.array([0, 0, z1 - z0]), np.array([0, y1 - y0, 0]), 1),   # right wall
        (np.array([-1.1, -0.65, -3.0]), np.array([0.8, 0, 0]), np.array([0, 0, 0.8]), 4),   # table top
    ]
    anchors, bufs = [], []
    for k, (o, u, v, cls) in enumerate(quads):
        vid = str(uuid.UUID(int=k + 1))
        V, I, C = grid_quad(o, u, v, 12, 12, cls)
        anchors.append({'id': vid, 'transform': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                        'vertexCount': len(V), 'faceCount': len(C)})
        bufs += [('v:' + vid, V.tobytes()), ('i:' + vid, I.tobytes()), ('c:' + vid, C.tobytes())]
    return build(2, {'anchors': anchors, 'removed': [], 'full': True}, bufs)


async def handler(ws):
    cfg = {'fps': 15, 'rgb': True, 'rgbWidth': 640, 'jpegQuality': 0.6, 'smoothed': False, 'mesh': True, 'planes': True}
    await ws.send(build(3, {'app': 'LidarBridge', 'version': 1, 'device': 'TestServer', 'systemVersion': 'test',
                            'sceneDepth': True, 'smoothedDepth': True, 'mesh': True, 'config': cfg}, []))
    await ws.send(mesh_message())
    t0 = time.time(); seq = 0

    async def reader():
        async for m in ws:
            if isinstance(m, str):
                cmd = json.loads(m)
                if cmd.get('type') == 'config':
                    cfg.update({k: v for k, v in cmd.items() if k != 'type'})
                elif cmd.get('type') in ('requestMesh', 'resetTracking'):
                    await ws.send(mesh_message())
    task = asyncio.create_task(reader())
    try:
        while True:
            seq += 1
            await ws.send(frame_message(seq, time.time() - t0, cfg))
            await asyncio.sleep(1 / cfg['fps'])
    except websockets.ConnectionClosed:
        pass
    finally:
        task.cancel()


def http_thread():
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    ThreadingHTTPServer(('0.0.0.0', 8080), partial(Quiet, directory=WEB)).serve_forever()


async def main():
    threading.Thread(target=http_thread, daemon=True).start()
    async with websockets.serve(handler, '0.0.0.0', 8081, max_size=None):
        print('Website:   http://localhost:8080\nWebSocket: ws://localhost:8081  (test data, same protocol as the iPhone app)')
        await asyncio.Future()

if __name__ == '__main__':
    asyncio.run(main())
