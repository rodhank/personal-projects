// 2D view: depth heatmap and processed images (normals, contours, confidence), plus camera blend,
// crosshair reading and AR-style measurement markers.
import { COLORMAPS } from './colormap.js';
import { isValid, projectWorld, unprojectCamera } from './geometry.js';

export class DepthView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.work = document.createElement('canvas');
    this.wctx = this.work.getContext('2d', { willReadFrequently: false });
    this.image = null;
    this.layout = null; // mapping between screen and depth pixels
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W; this.canvas.height = H;
    }
    this.dpr = dpr;
  }

  /** Effective rotation in degrees (auto = portrait screens show the landscape sensor upright). */
  rotation(opt) {
    if (opt !== 'auto') return Number(opt) || 0;
    const r = this.canvas.getBoundingClientRect();
    return r.height > r.width ? 90 : 0;
  }

  render(frame, o) {
    this.resize();
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, 0, W, H);
    if (!frame) { this.layout = null; return; }

    const w = frame.w, h = frame.h;
    if (this.work.width !== w || this.work.height !== h) {
      this.work.width = w; this.work.height = h;
      this.image = this.wctx.createImageData(w, h);
    }
    const rot = this.rotation(o.rotation);
    const rw = rot % 180 ? h : w, rh = rot % 180 ? w : h;
    const s = Math.min(W / rw, H / rh);
    this.layout = { W, H, w, h, rot, s };

    const showRGB = (o.mode === 'camera' || o.mode === 'blend') && frame.rgbBitmap;
    if (o.mode !== 'camera') this.fillImage(frame, o);

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(rot * Math.PI / 180);
    ctx.imageSmoothingEnabled = o.smoothPixels;
    if (showRGB) ctx.drawImage(frame.rgbBitmap, -w * s / 2, -h * s / 2, w * s, h * s);
    if (o.mode !== 'camera') {
      ctx.globalAlpha = o.mode === 'blend' ? o.blend : 1;
      ctx.drawImage(this.work, -w * s / 2, -h * s / 2, w * s, h * s);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    if (o.mode === 'camera' && !frame.rgbBitmap) {
      ctx.fillStyle = '#8a93a0';
      ctx.font = `${14 * this.dpr}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText('No camera image (turn on RGB in Stream settings)', W / 2, H / 2);
    }
  }

  /** 3x3 mean of valid neighbours (cached per frame) – removes sensor noise for normals / contours. */
  smoothDepth(frame, confMin, r = 1) {
    const key = confMin + ':' + r;
    if (frame._smooth && frame._smoothKey === key) return frame._smooth;
    const { w, h, depth } = frame;
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!isValid(frame, i, confMin)) continue;
        let s = 0, n = 0;
        const d0 = depth[i];
        for (let dy = -r; dy <= r; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            const d = depth[j];
            if (isValid(frame, j, confMin) && Math.abs(d - d0) < 0.05 * d0) { s += d; n++; }
          }
        }
        out[i] = s / n;
      }
    }
    frame._smooth = out; frame._smoothKey = key;
    return out;
  }

  fillImage(frame, o) {
    const { w, h, conf } = frame;
    let depth = frame.depth;
    const px = this.image.data;
    const lut = COLORMAPS[o.colormap] || COLORMAPS.turbo;
    const min = o.min, max = o.max, span = Math.max(1e-6, max - min);
    const confMin = o.confMin;
    const mode = o.mode;
    const blendAlpha = 255;

    if (mode === 'confidence') {
      const cols = [[220, 60, 60], [235, 200, 60], [70, 200, 90]];
      for (let i = 0, p = 0; i < w * h; i++, p += 4) {
        const c = conf ? cols[Math.min(2, conf[i])] : [120, 120, 120];
        px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255;
      }
    } else if (mode === 'normals') {
      const K = frame.K;
      depth = this.smoothDepth(frame, confMin);
      const ok = j => depth[j] > 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x, p = i * 4;
          const k = 2; // baseline in pixels
          if (x < k || y < k || x >= w - k || y >= h - k ||
              !ok(i) || !ok(i - k) || !ok(i + k) || !ok(i - k * w) || !ok(i + k * w)) {
            px[p] = px[p + 1] = px[p + 2] = 0; px[p + 3] = 255; continue;
          }
          const l = unprojectCamera(K, x - k, y, depth[i - k]), r = unprojectCamera(K, x + k, y, depth[i + k]);
          const u = unprojectCamera(K, x, y - k, depth[i - k * w]), d = unprojectCamera(K, x, y + k, depth[i + k * w]);
          const ax = r[0] - l[0], ay = r[1] - l[1], az = r[2] - l[2];
          const bx = u[0] - d[0], by = u[1] - d[1], bz = u[2] - d[2];
          let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
          const n = Math.hypot(nx, ny, nz) || 1;
          nx /= n; ny /= n; nz /= n;
          px[p] = (nx * 0.5 + 0.5) * 255; px[p + 1] = (ny * 0.5 + 0.5) * 255; px[p + 2] = (nz * 0.5 + 0.5) * 255;
          px[p + 3] = 255;
        }
      }
    } else {
      const contours = mode === 'contours';
      const step = Math.max(0.01, o.contourStep);
      const sm = contours ? this.smoothDepth(frame, confMin, 3) : null;
      for (let i = 0, p = 0; i < w * h; i++, p += 4) {
        if (!isValid(frame, i, confMin)) {
          px[p] = px[p + 1] = px[p + 2] = 0; px[p + 3] = mode === 'blend' ? 0 : 255; continue;
        }
        const d = depth[i];
        let t = (d - min) / span;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const k = Math.round(t * 255) * 3;
        let r = lut[k], g = lut[k + 1], b = lut[k + 2];
        if (contours) {
          const f = (sm[i] / step) % 1;
          if (f < 0.08 || f > 0.92) { r = g = b = 255; } else { r *= 0.55; g *= 0.55; b *= 0.55; }
        }
        px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = blendAlpha;
      }
    }
    this.wctx.putImageData(this.image, 0, 0);
  }

  /** Screen (CSS px relative to canvas) -> depth pixel coords, or null if outside the image. */
  screenToDepth(cssX, cssY) {
    const L = this.layout;
    if (!L) return null;
    const x = cssX * this.dpr - L.W / 2, y = cssY * this.dpr - L.H / 2;
    const a = -L.rot * Math.PI / 180;
    const xr = x * Math.cos(a) - y * Math.sin(a), yr = x * Math.sin(a) + y * Math.cos(a);
    const u = xr / L.s + L.w / 2, v = yr / L.s + L.h / 2;
    if (u < 0 || v < 0 || u >= L.w || v >= L.h) return null;
    return { u, v };
  }

  /** Depth pixel coords -> canvas pixels. */
  depthToScreen(u, v) {
    const L = this.layout;
    if (!L) return null;
    const x = (u - L.w / 2) * L.s, y = (v - L.h / 2) * L.s;
    const a = L.rot * Math.PI / 180;
    return { x: L.W / 2 + x * Math.cos(a) - y * Math.sin(a), y: L.H / 2 + x * Math.sin(a) + y * Math.cos(a) };
  }

  /** Crosshair, centre distance and measurement points (re-projected every frame). */
  drawOverlay(frame, centerDepth, measure) {
    if (!frame || !this.layout) return;
    const ctx = this.ctx, dpr = this.dpr;
    const c = this.depthToScreen(frame.w / 2, frame.h / 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(c.x - 12 * dpr, c.y); ctx.lineTo(c.x - 4 * dpr, c.y);
    ctx.moveTo(c.x + 4 * dpr, c.y); ctx.lineTo(c.x + 12 * dpr, c.y);
    ctx.moveTo(c.x, c.y - 12 * dpr); ctx.lineTo(c.x, c.y - 4 * dpr);
    ctx.moveTo(c.x, c.y + 4 * dpr); ctx.lineTo(c.x, c.y + 12 * dpr);
    ctx.stroke();
    label(ctx, Number.isFinite(centerDepth) ? `${centerDepth.toFixed(3)} m` : '—', c.x + 16 * dpr, c.y - 14 * dpr, dpr);

    const pts = measure.points.map(p => {
      const q = projectWorld(frame, p.world);
      return q.d > 0 ? { ...this.depthToScreen(q.u, q.v), ...p } : null;
    });
    if (pts.length === 2 && pts[0] && pts[1]) {
      ctx.strokeStyle = '#ffd34d';
      ctx.lineWidth = 3 * dpr;
      ctx.setLineDash([8 * dpr, 6 * dpr]);
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
      ctx.setLineDash([]);
      label(ctx, `${(measure.distance * 100).toFixed(1)} cm`, (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2 - 10 * dpr, dpr, '#ffd34d');
    }
    pts.forEach((p, i) => {
      if (!p) return;
      ctx.fillStyle = i === 0 ? '#4dd2ff' : '#ff6b9a';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.arc(p.x, p.y, 7 * dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      label(ctx, `${i === 0 ? 'A' : 'B'} ${p.depthAtTap.toFixed(2)} m`, p.x + 10 * dpr, p.y + 18 * dpr, dpr);
    });
  }
}

function label(ctx, text, x, y, dpr, color = '#fff') {
  ctx.font = `600 ${13 * dpr}px system-ui, sans-serif`;
  const m = ctx.measureText(text);
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(x - 4 * dpr, y - 13 * dpr, m.width + 8 * dpr, 18 * dpr);
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.fillText(text, x, y);
}
