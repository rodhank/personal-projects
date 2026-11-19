// Math helpers. Matrices are column-major Float32Array(16), like ARKit simd / WebGL / three.js.

export function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Inverse of a rigid transform (rotation + translation). */
export function invertRigid(m) {
  const r = new Float32Array(16);
  // transpose rotation
  r[0] = m[0]; r[1] = m[4]; r[2] = m[8];
  r[4] = m[1]; r[5] = m[5]; r[6] = m[9];
  r[8] = m[2]; r[9] = m[6]; r[10] = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  r[12] = -(r[0] * tx + r[4] * ty + r[8] * tz);
  r[13] = -(r[1] * tx + r[5] * ty + r[9] * tz);
  r[14] = -(r[2] * tx + r[6] * ty + r[10] * tz);
  r[15] = 1;
  return r;
}

/** Depth pixel (u, v) with depth d (m) -> camera space (ARKit: +x right, +y up, looks down -z). */
export function unprojectCamera(K, u, v, d) {
  return [(u - K.cx) * d / K.fx, -(v - K.cy) * d / K.fy, -d];
}

export function unprojectWorld(frame, u, v, d) {
  const c = unprojectCamera(frame.K, u, v, d);
  return transformPoint(frame.T, c[0], c[1], c[2]);
}

/** World point -> { u, v, d } in the frame's depth-pixel coordinates (d <= 0 means behind camera). */
export function projectWorld(frame, p) {
  if (!frame.Tinv) frame.Tinv = invertRigid(frame.T);
  const c = transformPoint(frame.Tinv, p[0], p[1], p[2]);
  const d = -c[2];
  return { u: frame.K.cx + frame.K.fx * c[0] / d, v: frame.K.cy - frame.K.fy * c[1] / d, d };
}

export function isValid(frame, i, confMin) {
  const d = frame.depth[i];
  if (!(d > 0) || !Number.isFinite(d)) return false;
  return !frame.conf || frame.conf[i] >= confMin;
}

/** Median of valid depths in a (2r+1)^2 window — robust single-point reading. */
export function sampleDepth(frame, u, v, r = 2, confMin = 0) {
  const vals = [];
  const u0 = Math.round(u), v0 = Math.round(v);
  for (let y = v0 - r; y <= v0 + r; y++) {
    if (y < 0 || y >= frame.h) continue;
    for (let x = u0 - r; x <= u0 + r; x++) {
      if (x < 0 || x >= frame.w) continue;
      const i = y * frame.w + x;
      if (isValid(frame, i, confMin)) vals.push(frame.depth[i]);
    }
  }
  if (!vals.length) return NaN;
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}

export function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function cameraPosition(frame) {
  return [frame.T[12], frame.T[13], frame.T[14]];
}

/** Euler-free heading/pitch readout of the camera (degrees) for the stats panel. */
export function cameraAngles(frame) {
  const T = frame.T;
  const fwd = [-T[8], -T[9], -T[10]];
  const yaw = Math.atan2(fwd[0], -fwd[2]) * 180 / Math.PI;
  const pitch = Math.asin(Math.max(-1, Math.min(1, fwd[1]))) * 180 / Math.PI;
  return { yaw, pitch };
}
