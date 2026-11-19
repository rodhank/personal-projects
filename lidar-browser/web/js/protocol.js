// LiDAR Bridge wire protocol (see PROTOCOL.md).
export const MSG = { FRAME: 1, MESH: 2, HELLO: 3 };
const MAGIC = 0x3152444c; // "LDR1" read as little-endian uint32
const textDecoder = new TextDecoder();

/** Parses one binary message into { type, header, buffers, buf }. Throws on malformed data. */
export function parseMessage(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 12) throw new Error('message too short');
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('bad magic');
  const type = dv.getUint8(4);
  const headerLength = dv.getUint32(8, true);
  if (12 + headerLength > buf.byteLength) throw new Error('bad header length');
  const header = JSON.parse(textDecoder.decode(new Uint8Array(buf, 12, headerLength)));
  const base = 12 + headerLength;
  const buffers = {};
  for (const b of header.buffers || []) {
    if (base + b.offset + b.length > buf.byteLength) throw new Error(`buffer ${b.name} out of range`);
    buffers[b.name] = { offset: base + b.offset, length: b.length };
  }
  return { type, header, buffers, buf };
}

/** Typed view of a named buffer (copied if not aligned). */
export function typed(msg, name, Ctor) {
  const b = msg.buffers[name];
  if (!b) return null;
  const n = Math.floor(b.length / Ctor.BYTES_PER_ELEMENT);
  if (b.offset % Ctor.BYTES_PER_ELEMENT === 0) return new Ctor(msg.buf, b.offset, n);
  return new Ctor(msg.buf.slice(b.offset, b.offset + n * Ctor.BYTES_PER_ELEMENT));
}

export function bytes(msg, name) {
  const b = msg.buffers[name];
  return b ? new Uint8Array(msg.buf, b.offset, b.length) : null;
}

/**
 * Converts an iPhone frame message into the app's internal frame object:
 * { source, seq, t, wall, tracking, w, h, depth(Float32 m), conf(Uint8|null), K{fx,fy,cx,cy} at depth res,
 *   T(Float32Array16 camera->world), rgbBlob, rgbW, rgbH, planes, light, meshAnchors, smoothed }
 */
export function frameFromMessage(msg) {
  const h = msg.header;
  const w = h.depth.w, hh = h.depth.h;
  const depth = typed(msg, 'depth', Float32Array);
  const conf = typed(msg, 'confidence', Uint8Array);
  const sx = w / h.imageSize[0], sy = hh / h.imageSize[1];
  const [fx, fy, cx, cy] = h.intrinsics;
  const rgbBytes = bytes(msg, 'rgb');
  return {
    source: 'iphone',
    seq: h.seq, t: h.t, wall: h.wall, tracking: h.tracking,
    w, h: hh, depth, conf,
    K: { fx: fx * sx, fy: fy * sy, cx: cx * sx, cy: cy * sy },
    Kfull: { fx, fy, cx, cy, width: h.imageSize[0], height: h.imageSize[1] },
    T: new Float32Array(h.transform),
    rgbBlob: rgbBytes ? new Blob([rgbBytes], { type: 'image/jpeg' }) : null,
    rgbW: h.rgb ? h.rgb.w : 0, rgbH: h.rgb ? h.rgb.h : 0,
    planes: h.planes || [], light: h.light || null,
    meshAnchors: h.meshAnchors || 0, smoothed: !!(h.depth && h.depth.smoothed),
    bytes: msg.buf.byteLength,
  };
}

/** Mesh message -> { anchors: [{id, transform, vertices, indices, classes}], removed, full } */
export function meshFromMessage(msg) {
  const h = msg.header;
  const anchors = (h.anchors || []).map(a => ({
    id: a.id,
    transform: new Float32Array(a.transform),
    vertices: typed(msg, 'v:' + a.id, Float32Array),
    indices: typed(msg, 'i:' + a.id, Uint32Array),
    classes: bytes(msg, 'c:' + a.id),
    vertexCount: a.vertexCount, faceCount: a.faceCount,
  }));
  return { anchors, removed: h.removed || [], full: !!h.full };
}
