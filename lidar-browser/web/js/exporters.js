// File exports: 16-bit depth PNG, confidence PNG, PLY point clouds, OBJ mesh, ZIP recordings.
import { isValid, transformPoint, unprojectWorld } from './geometry.js';
import { MESH_CLASS_NAMES } from './colormap.js';

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- PNG ----------
async function zlib(data) {
  const cs = new CompressionStream('deflate'); // RFC 1950 zlib stream, as PNG requires
  const stream = new Blob([data]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Grayscale PNG. `samples` is Uint8Array (bitDepth 8) or Uint16Array (bitDepth 16). */
export async function encodeGrayPNG(width, height, samples, bitDepth) {
  const bpp = bitDepth / 8;
  const raw = new Uint8Array(height * (1 + width * bpp));
  for (let y = 0; y < height; y++) {
    let o = y * (1 + width * bpp);
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const v = samples[y * width + x];
      if (bitDepth === 16) { raw[o++] = v >> 8; raw[o++] = v & 0xff; } else raw[o++] = v;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = bitDepth; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array(0))];
  return new Blob(parts, { type: 'image/png' });
}

/** Depth in millimetres as 16-bit PNG (the usual RGB-D dataset format). Invalid = 0. */
export function depthToMillimetres(frame, confMin = 0) {
  const out = new Uint16Array(frame.w * frame.h);
  for (let i = 0; i < out.length; i++) {
    out[i] = isValid(frame, i, confMin) ? Math.min(65535, Math.round(frame.depth[i] * 1000)) : 0;
  }
  return out;
}

export function depthPNG(frame, confMin = 0) {
  return encodeGrayPNG(frame.w, frame.h, depthToMillimetres(frame, confMin), 16);
}

export function confidencePNG(frame) {
  // 0/1/2 scaled to 0/127/254 so it is visible in image viewers
  const c = new Uint8Array(frame.w * frame.h);
  if (frame.conf) for (let i = 0; i < c.length; i++) c[i] = frame.conf[i] * 127;
  return encodeGrayPNG(frame.w, frame.h, c, 8);
}

export function frameMetadata(frame) {
  return {
    seq: frame.seq, timestamp: frame.t, wallClockMs: frame.wall, tracking: frame.tracking,
    depthWidth: frame.w, depthHeight: frame.h, depthUnits: 'millimetres in PNG, metres in raw',
    smoothedDepth: frame.smoothed,
    intrinsicsDepth: frame.K, intrinsicsFull: frame.Kfull || null,
    cameraToWorld_columnMajor: Array.from(frame.T),
    planes: frame.planes, light: frame.light,
  };
}

// ---------- PLY ----------
export function plyFromArrays(positions, colors, count) {
  const header = `ply\nformat binary_little_endian 1.0\ncomment LiDAR Bridge export\nelement vertex ${count}\n` +
    'property float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n';
  const head = new TextEncoder().encode(header);
  const body = new ArrayBuffer(count * 15);
  const dv = new DataView(body);
  for (let i = 0; i < count; i++) {
    const o = i * 15;
    dv.setFloat32(o, positions[i * 3], true);
    dv.setFloat32(o + 4, positions[i * 3 + 1], true);
    dv.setFloat32(o + 8, positions[i * 3 + 2], true);
    dv.setUint8(o + 12, Math.round(colors[i * 3] * 255));
    dv.setUint8(o + 13, Math.round(colors[i * 3 + 1] * 255));
    dv.setUint8(o + 14, Math.round(colors[i * 3 + 2] * 255));
  }
  return new Blob([head, body], { type: 'application/octet-stream' });
}

/** Full-resolution world-space point cloud of one frame. */
export function framePLY(frame, rgb, confMin) {
  const pos = [], col = [];
  for (let v = 0; v < frame.h; v++) {
    for (let u = 0; u < frame.w; u++) {
      const i = v * frame.w + u;
      if (!isValid(frame, i, confMin)) continue;
      pos.push(...unprojectWorld(frame, u, v, frame.depth[i]));
      if (rgb) col.push(rgb.data[i * 4] / 255, rgb.data[i * 4 + 1] / 255, rgb.data[i * 4 + 2] / 255);
      else col.push(0.8, 0.8, 0.8);
    }
  }
  return plyFromArrays(pos, col, pos.length / 3);
}

// ---------- OBJ ----------
export function meshOBJ(meshRaw) {
  const lines = ['# LiDAR Bridge – ARKit scene mesh (world coordinates, metres)'];
  let base = 1;
  let k = 0;
  for (const a of meshRaw.values()) {
    lines.push(`o anchor_${k++}`);
    const v = a.vertices;
    for (let i = 0; i < v.length; i += 3) {
      const p = transformPoint(a.transform, v[i], v[i + 1], v[i + 2]);
      lines.push(`v ${p[0].toFixed(5)} ${p[1].toFixed(5)} ${p[2].toFixed(5)}`);
    }
    let lastCls = -1;
    for (let f = 0; f < a.indices.length / 3; f++) {
      const cls = a.classes ? a.classes[f] : 0;
      if (cls !== lastCls) { lines.push(`g ${MESH_CLASS_NAMES[cls] || 'none'}`); lastCls = cls; }
      lines.push(`f ${a.indices[f * 3] + base} ${a.indices[f * 3 + 1] + base} ${a.indices[f * 3 + 2] + base}`);
    }
    base += v.length / 3;
  }
  return new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
}

// ---------- ZIP (stored, no compression – PNG/JPEG are already compressed) ----------
export class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.offset = 0; }

  async add(name, data) {
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer())
      : typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(bytes);
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true); dv.setUint16(10, 0, true); dv.setUint16(12, 0x21, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, bytes.length, true); dv.setUint32(22, bytes.length, true);
    dv.setUint16(26, nameBytes.length, true); dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    this.parts.push(local, bytes);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, bytes.length, true); cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, this.offset, true);
    cen.set(nameBytes, 46);
    this.central.push(cen);
    this.offset += local.length + bytes.length;
  }

  finish() {
    const size = this.central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22);
    const dv = new DataView(end.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(8, this.central.length, true); dv.setUint16(10, this.central.length, true);
    dv.setUint32(12, size, true); dv.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end], { type: 'application/zip' });
  }
}

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

export function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
