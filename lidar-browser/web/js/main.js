// LiDAR Bridge website – wires the data source, processing, 2D/3D views, measuring, exports and recording.
import { IPhoneSource } from './source-iphone.js';
import { webxrDepthAvailable, startWebXRDepth } from './source-webxr.js';
import { NativeSource, nativeLidarAvailable } from './source-native.js';
import { DepthView } from './depthview.js';
import { COLORMAPS } from './colormap.js';
import { sampleDepth, unprojectWorld, dist3, cameraPosition, cameraAngles } from './geometry.js';
import * as ex from './exporters.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);

// ---------------- state ----------------
let current = null;          // latest processed frame
let dirty = false;           // needs 2D redraw
let source = null;
let xrSession = null;
let hello = null;
const rate = { frames: 0, bytes: 0, fps: 0, kbps: 0, last: performance.now() };
const measure = { points: [], distance: NaN };
const rec = { on: false, frames: [], every: 1, counter: 0, bytes: 0 };
const MAX_REC = 1800;
let autoMin = null, autoMax = null;
let lastStats = null;
let decodeBusy = false, decodeQueued = null;

const depthView = new DepthView($('depthCanvas'));
let scene3d = null;          // created lazily (WebGL)
const rgbCanvas = document.createElement('canvas');
const rgbCtx = rgbCanvas.getContext('2d', { willReadFrequently: true });

// ---------------- options from the UI ----------------
function displayOptions() {
  return {
    mode: $('mode').value,
    colormap: $('colormap').value,
    min: parseFloat($('rangeMin').value),
    max: Math.max(parseFloat($('rangeMin').value) + 0.05, parseFloat($('rangeMax').value)),
    confMin: parseInt($('confMin').value, 10),
    rotation: $('rotation').value,
    blend: parseFloat($('blend').value),
    contourStep: parseFloat($('contourStep').value) / 100,
    smoothPixels: $('smoothPixels').checked,
  };
}

function sceneOptions() {
  const d = displayOptions();
  return {
    ...d,
    showLive: $('showLive').checked,
    accumulate: $('accumulate').checked,
    showAccumulated: $('showAccumulated').checked,
    showMesh: $('showMesh').checked,
    meshWireframe: $('meshWireframe').checked,
    showPlanes: $('showPlanes').checked,
    showCamera: $('showCamera').checked,
    followDevice: $('followDevice').checked,
    colorBy: $('colorBy').value,
    pointSize: parseFloat($('pointSize').value),
    voxelSize: parseFloat($('voxel').value) / 100,
    maxRange: parseFloat($('maxRange').value),
    liveStep: 2,
  };
}

function streamConfig() {
  return {
    type: 'config',
    fps: parseInt($('fps').value, 10),
    rgb: $('rgb').checked,
    rgbWidth: parseInt($('rgbWidth').value, 10),
    jpegQuality: parseFloat($('jpegQuality').value),
    smoothed: $('smoothed').checked,
    mesh: $('meshStream').checked,
    planes: $('planesStream').checked,
  };
}

// ---------------- 3D (lazy) ----------------
async function ensureScene() {
  if (scene3d) return scene3d;
  try {
    const { Scene3D } = await import('./scene3d.js');
    scene3d = new Scene3D($('view3d'));
    scene3d.setOptions(sceneOptions());
  } catch (e) {
    toast('3D view unavailable: ' + e.message);
  }
  return scene3d;
}

// ---------------- frames ----------------
function onFrame(f) {
  rate.frames++;
  rate.bytes += f.bytes || 0;
  if (f.rgbBlob && typeof createImageBitmap === 'function') {
    if (decodeBusy) { decodeQueued = f; return; }   // keep only the newest while decoding
    decode(f);
  } else {
    acceptFrame(f);
  }
}

function decode(f) {
  decodeBusy = true;
  createImageBitmap(f.rgbBlob).then(bm => { f.rgbBitmap = bm; }).catch(() => {}).finally(() => {
    acceptFrame(f);
    decodeBusy = false;
    if (decodeQueued) { const n = decodeQueued; decodeQueued = null; decode(n); }
  });
}

function acceptFrame(f) {
  if (current && current !== f && current.rgbBitmap && current.rgbBitmap !== f.rgbBitmap) {
    try { current.rgbBitmap.close(); } catch { /* ignore */ }
  }
  current = f;
  dirty = true;
  $('emptyState').hidden = true;
  processFrame(f);
}

function rgbAtDepthRes(f) {
  if (!f.rgbBitmap) return null;
  if (f.rgbData) return f.rgbData;
  if (rgbCanvas.width !== f.w || rgbCanvas.height !== f.h) { rgbCanvas.width = f.w; rgbCanvas.height = f.h; }
  rgbCtx.drawImage(f.rgbBitmap, 0, 0, f.w, f.h);
  f.rgbData = rgbCtx.getImageData(0, 0, f.w, f.h);
  return f.rgbData;
}

function processFrame(f) {
  const o = displayOptions();
  const s = computeStats(f, o.confMin);
  lastStats = s;

  if ($('autoRange').checked && Number.isFinite(s.p05)) {
    autoMin = autoMin == null ? s.p05 : autoMin * 0.85 + s.p05 * 0.15;
    autoMax = autoMax == null ? s.p95 : autoMax * 0.85 + s.p95 * 0.15;
    const lo = Math.max(0, autoMin - 0.05), hi = Math.max(lo + 0.2, autoMax + 0.1);
    $('rangeMin').value = lo.toFixed(2); $('rangeMax').value = hi.toFixed(2);
    $('rangeMinOut').textContent = lo.toFixed(2); $('rangeMaxOut').textContent = hi.toFixed(2);
  }

  if (scene3d) {
    const so = sceneOptions();
    const needRGB = so.colorBy === 'rgb' && (scene3d.visible || so.accumulate);
    scene3d.updateFrame(f, needRGB ? rgbAtDepthRes(f) : null, so);
    scene3d.updatePlanes(f.planes || []);
    $('sMap').textContent = scene3d.accCount.toLocaleString();
  } else if ($('accumulate').checked) {
    ensureScene();
  }

  if (rec.on) recordFrame(f);
  if (measure.points.length) updateMeasureReadout();
}

function computeStats(f, confMin) {
  const n = f.w * f.h;
  const bins = new Uint32Array(1000); // 1 cm bins up to 10 m
  let valid = 0, sum = 0, min = Infinity, max = -Infinity;
  const confCounts = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (f.conf) confCounts[Math.min(2, f.conf[i])]++;
    const d = f.depth[i];
    if (!(d > 0) || !Number.isFinite(d) || (f.conf && f.conf[i] < confMin)) continue;
    valid++; sum += d;
    if (d < min) min = d;
    if (d > max) max = d;
    bins[Math.min(999, Math.floor(d * 100))]++;
  }
  const pct = q => {
    if (!valid) return NaN;
    let target = valid * q, acc = 0;
    for (let i = 0; i < bins.length; i++) { acc += bins[i]; if (acc >= target) return (i + 0.5) / 100; }
    return NaN;
  };
  return {
    valid, total: n, mean: valid ? sum / valid : NaN, min: valid ? min : NaN, max: valid ? max : NaN,
    median: pct(0.5), p05: pct(0.05), p95: pct(0.95), bins, confCounts,
    center: sampleDepth(f, f.w / 2, f.h / 2, 3, confMin),
  };
}

// ---------------- render loop ----------------
let lastView = '';
function frameLoop() {
  requestAnimationFrame(frameLoop);
  const viewKey = $('main').className + depthView.canvas.clientWidth + 'x' + depthView.canvas.clientHeight;
  if (viewKey !== lastView) { lastView = viewKey; dirty = true; }
  if (!dirty) return;
  dirty = false;
  if ($('main').classList.contains('view-3d')) return;
  const o = displayOptions();
  depthView.render(current, o);
  if (current) depthView.drawOverlay(current, lastStats ? lastStats.center : NaN, measure);
}
requestAnimationFrame(frameLoop);

setInterval(() => {
  const now = performance.now(), dt = (now - rate.last) / 1000;
  rate.fps = rate.frames / dt; rate.kbps = rate.bytes / 1024 / dt;
  rate.frames = 0; rate.bytes = 0; rate.last = now;
  updateStatsPanel();
}, 500);

function fmt(x, d = 2, unit = ' m') { return Number.isFinite(x) ? x.toFixed(d) + unit : '—'; }

function updateStatsPanel() {
  const f = current, s = lastStats;
  if (!f || !s) { $('sRate').textContent = `${rate.fps.toFixed(1)} fps`; return; }
  $('sCenter').textContent = fmt(s.center, 3);
  $('sMinMax').textContent = `${fmt(s.min)} / ${fmt(s.max)}`;
  $('sMean').textContent = `${fmt(s.mean)} / ${fmt(s.median)}`;
  $('sValid').textContent = `${(100 * s.valid / s.total).toFixed(1)} %`;
  const cc = s.confCounts, ct = cc[0] + cc[1] + cc[2];
  $('sConf').textContent = f.conf && ct ? `${(100 * cc[2] / ct).toFixed(0)} / ${(100 * cc[1] / ct).toFixed(0)} / ${(100 * cc[0] / ct).toFixed(0)} %` : 'n/a';
  const tr = $('sTracking');
  tr.textContent = f.tracking || '—';
  tr.style.color = f.tracking === 'normal' ? 'var(--good)' : 'var(--warn)';
  const p = cameraPosition(f);
  $('sPos').textContent = `${p[0].toFixed(2)}, ${p[1].toFixed(2)}, ${p[2].toFixed(2)}`;
  const a = cameraAngles(f);
  $('sAngles').textContent = `${a.yaw.toFixed(0)}° / ${a.pitch.toFixed(0)}°`;
  $('sLight').textContent = f.light ? `${Math.round(f.light.ambientIntensity)} lm, ${Math.round(f.light.colorTemperature)} K` : '—';
  const ms = scene3d ? scene3d.meshStats() : null;
  $('sScene').textContent = `${(f.planes || []).length} planes / ${ms ? `${ms.anchors} anchors, ${ms.tris.toLocaleString()} tris` : `${f.meshAnchors} anchors`}`;
  $('sRate').textContent = `${rate.fps.toFixed(1)} fps · ${rate.kbps >= 1024 ? (rate.kbps / 1024).toFixed(1) + ' MB/s' : rate.kbps.toFixed(0) + ' KB/s'}`;
  const lat = Date.now() - f.wall;
  $('sLatency').textContent = f.source === 'iphone' ? (lat >= 0 && lat < 5000 ? `${lat.toFixed(0)} ms` : 'clocks differ') : '—';
  $('sRes').textContent = `${f.w}×${f.h}${f.smoothed ? ' (smoothed)' : ''}${f.rgbW ? ` · RGB ${f.rgbW}×${f.rgbH}` : ''}`;
  drawHistogram(s);
  drawLegend();
  if (rec.on) $('recInfo').textContent = `Recording… ${rec.frames.length} frames, ${(rec.bytes / 1048576).toFixed(0)} MB in memory (max ${MAX_REC}).`;
}

function drawHistogram(s) {
  const c = $('histogram'), ctx = c.getContext('2d');
  const W = c.width = c.clientWidth * 2 || 300, H = c.height = 140;
  ctx.clearRect(0, 0, W, H);
  const o = displayOptions();
  const top = Math.min(10, Math.max(1, Math.ceil(Number.isFinite(s.p95) ? s.p95 * 1.4 : 5)));
  const nb = 100, per = Math.max(1, Math.round(top * 100 / nb));
  const vals = new Array(nb).fill(0);
  for (let i = 0; i < nb; i++) for (let k = 0; k < per; k++) vals[i] += s.bins[i * per + k] || 0;
  const mx = Math.max(1, ...vals);
  const lut = COLORMAPS[o.colormap];
  for (let i = 0; i < nb; i++) {
    const d = (i + 0.5) * per / 100;
    let t = (d - o.min) / Math.max(1e-6, o.max - o.min); t = Math.max(0, Math.min(1, t));
    const k = Math.round(t * 255) * 3;
    ctx.fillStyle = `rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]})`;
    const h = (vals[i] / mx) * (H - 22);
    ctx.fillRect(i * W / nb, H - 18 - h, W / nb - 1, h);
  }
  ctx.fillStyle = '#8a93a0';
  ctx.font = '20px system-ui';
  ctx.fillText('0 m', 4, H - 2);
  ctx.textAlign = 'right';
  ctx.fillText(`${(nb * per / 100).toFixed(1)} m`, W - 4, H - 2);
}

function drawLegend() {
  const o = displayOptions();
  const c = $('legendCanvas'), ctx = c.getContext('2d');
  const lut = COLORMAPS[o.colormap];
  for (let x = 0; x < c.width; x++) {
    const k = Math.round((x / (c.width - 1)) * 255) * 3;
    ctx.fillStyle = `rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]})`;
    ctx.fillRect(x, 0, 1, c.height);
  }
  $('legendMin').textContent = o.min.toFixed(1) + ' m';
  $('legendMax').textContent = o.max.toFixed(1) + ' m';
  $('legend').style.display = ['depth', 'blend', 'contours'].includes(o.mode) ? '' : 'none';
}

// ---------------- measuring ----------------
$('depthCanvas').addEventListener('pointerdown', ev => {
  if (!current) return;
  const r = ev.target.getBoundingClientRect();
  const uv = depthView.screenToDepth(ev.clientX - r.left, ev.clientY - r.top);
  if (!uv) return;
  const d = sampleDepth(current, uv.u, uv.v, 2, parseInt($('confMin').value, 10));
  if (!Number.isFinite(d)) { toast('No reliable depth at that point'); return; }
  const world = unprojectWorld(current, uv.u, uv.v, d);
  if (measure.points.length >= 2) measure.points = [];
  measure.points.push({ world, depthAtTap: d });
  updateMeasureReadout();
  if (scene3d) scene3d.setMeasure(measure.points);
  dirty = true;
});

function updateMeasureReadout() {
  const [a, b] = measure.points;
  measure.distance = a && b ? dist3(a.world, b.world) : NaN;
  $('mDist').textContent = Number.isFinite(measure.distance) ? `${(measure.distance * 100).toFixed(1)} cm` : (a ? 'tap point B' : '—');
  $('mHeight').textContent = a && b ? `${((b.world[1] - a.world[1]) * 100).toFixed(1)} cm` : '—';
  if (current && a) {
    const cam = cameraPosition(current);
    $('mCam').textContent = `${dist3(cam, a.world).toFixed(2)} m` + (b ? ` / ${dist3(cam, b.world).toFixed(2)} m` : '');
  } else $('mCam').textContent = '—';
}

$('measureClear').onclick = () => {
  measure.points = []; measure.distance = NaN;
  updateMeasureReadout();
  if (scene3d) scene3d.setMeasure([]);
  dirty = true;
};

// ---------------- recording ----------------
function recordFrame(f) {
  if (rec.counter++ % rec.every !== 0) return;
  if (rec.frames.length >= MAX_REC) { stopRecording(); toast(`Recording stopped at ${MAX_REC} frames`); return; }
  const item = {
    w: f.w, h: f.h, depth: f.depth.slice(), conf: f.conf ? f.conf.slice() : null,
    rgbBlob: f.rgbBlob, meta: ex.frameMetadata(f),
  };
  rec.bytes += item.depth.byteLength + (item.conf ? item.conf.byteLength : 0) + (f.rgbBlob ? f.rgbBlob.size : 0);
  rec.frames.push(item);
}

function stopRecording() {
  rec.on = false;
  $('recBtn').classList.remove('on');
  $('recBtn').textContent = '● Record';
  $('recSave').disabled = rec.frames.length === 0;
  $('recInfo').textContent = `${rec.frames.length} frames recorded (${(rec.bytes / 1048576).toFixed(0)} MB). Save as ZIP.`;
}

$('recBtn').onclick = () => {
  if (rec.on) { stopRecording(); return; }
  rec.frames = []; rec.bytes = 0; rec.counter = 0;
  rec.every = Math.max(1, parseInt($('recEvery').value, 10) || 1);
  rec.on = true;
  $('recBtn').classList.add('on');
  $('recBtn').textContent = '■ Stop';
  $('recSave').disabled = true;
};

$('recSave').onclick = async () => {
  if (!rec.frames.length) return;
  $('recSave').disabled = true;
  const zip = new ex.ZipWriter();
  const meta = { app: 'LiDAR Bridge', device: hello ? hello.device : null, frames: [] };
  for (let i = 0; i < rec.frames.length; i++) {
    const fr = rec.frames[i];
    const name = String(i + 1).padStart(6, '0');
    await zip.add(`depth/${name}.png`, await ex.depthPNG(fr, 0));
    if (fr.conf) await zip.add(`confidence/${name}.png`, await ex.confidencePNG(fr));
    if (fr.rgbBlob) await zip.add(`rgb/${name}.jpg`, fr.rgbBlob);
    meta.frames.push({ file: name, ...fr.meta });
    if (i % 20 === 0) toast(`Packing ZIP… ${i + 1}/${rec.frames.length}`);
  }
  if (scene3d && scene3d.meshRaw.size) await zip.add('mesh.obj', ex.meshOBJ(scene3d.meshRaw));
  if (scene3d && scene3d.accCount) {
    const c = scene3d.accumulatedCloud();
    await zip.add('map.ply', ex.plyFromArrays(c.positions, c.colors, c.count));
  }
  await zip.add('metadata.json', JSON.stringify(meta, null, 1));
  await zip.add('README.txt', 'depth/*.png: 16-bit depth in millimetres (0 = no data).\n' +
    'confidence/*.png: 0 low, 127 medium, 254 high.\nrgb/*.jpg: camera image.\n' +
    'metadata.json: per-frame intrinsics (depth and full resolution), camera-to-world pose (column-major 4x4), tracking, planes.\n');
  ex.download(zip.finish(), `lidar_recording_${ex.stamp()}.zip`);
  toast('Recording saved');
  $('recSave').disabled = false;
};

// ---------------- exports ----------------
function needFrame() { if (!current) { toast('No frame yet'); return false; } return true; }
$('exDepth').onclick = async () => { if (needFrame()) ex.download(await ex.depthPNG(current, displayOptions().confMin), `depth_${ex.stamp()}.png`); };
$('exConf').onclick = async () => { if (needFrame()) ex.download(await ex.confidencePNG(current), `confidence_${ex.stamp()}.png`); };
$('exRGB').onclick = () => { if (needFrame()) current.rgbBlob ? ex.download(current.rgbBlob, `camera_${ex.stamp()}.jpg`) : toast('No camera image in this frame'); };
$('exView').onclick = () => { if (needFrame()) depthView.canvas.toBlob(b => ex.download(b, `view_${ex.stamp()}.png`)); };
$('exMeta').onclick = () => { if (needFrame()) ex.download(new Blob([JSON.stringify(ex.frameMetadata(current), null, 2)]), `frame_${ex.stamp()}.json`); };
$('exRaw').onclick = () => {
  if (!needFrame()) return;
  ex.download(new Blob([current.depth.slice().buffer]), `depth_${current.w}x${current.h}_float32_${ex.stamp()}.bin`);
};
$('exFramePly').onclick = () => { if (needFrame()) ex.download(ex.framePLY(current, rgbAtDepthRes(current), displayOptions().confMin), `frame_${ex.stamp()}.ply`); };
$('exMapPly').onclick = () => {
  if (!scene3d || !scene3d.accCount) { toast('3D map is empty – turn on "Build 3D map" first'); return; }
  const c = scene3d.accumulatedCloud();
  ex.download(ex.plyFromArrays(c.positions, c.colors, c.count), `map_${ex.stamp()}.ply`);
};
$('exMesh').onclick = () => {
  if (!scene3d || !scene3d.meshRaw.size) { toast('No scene mesh received yet'); return; }
  ex.download(ex.meshOBJ(scene3d.meshRaw), `mesh_${ex.stamp()}.obj`);
};
$('ex3d').onclick = async () => {
  const s = await ensureScene();
  if (s) ex.download(await s.snapshotPNG(), `view3d_${ex.stamp()}.png`);
};

// ---------------- UI wiring ----------------
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

function setConn(state, label) {
  const el = $('conn');
  el.className = 'pill ' + (state === 'connected' ? 'on' : state === 'connecting' ? 'wait' : 'off');
  el.textContent = label || { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected' }[state];
}

document.querySelectorAll('.tab').forEach(btn => btn.onclick = async () => {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
  const v = btn.dataset.view;
  $('main').className = 'view-' + v;
  if (v !== '2d') {
    const s = await ensureScene();
    if (s) { s.visible = true; s.resize(); }
  } else if (scene3d) scene3d.visible = false;
  dirty = true;
});

$('panelToggle').onclick = () => {
  const p = $('panel');
  if (window.matchMedia('(max-width: 820px)').matches) p.classList.toggle('open');
  else p.classList.toggle('closed');
  setTimeout(() => { dirty = true; if (scene3d) scene3d.resize(); }, 250);
};

// display controls
['mode', 'colormap', 'confMin', 'rotation', 'blend', 'smoothPixels'].forEach(id => $(id).addEventListener('input', () => { dirty = true; }));
['rangeMin', 'rangeMax'].forEach(id => $(id).addEventListener('input', () => {
  $('autoRange').checked = false;
  $(id + 'Out').textContent = parseFloat($(id).value).toFixed(2);
  dirty = true;
}));
$('autoRange').addEventListener('change', () => { autoMin = autoMax = null; });
$('contourStep').addEventListener('input', () => { $('contourOut').textContent = $('contourStep').value; dirty = true; });
$('voxel').addEventListener('input', () => { $('voxelOut').textContent = $('voxel').value; });
$('maxRange').addEventListener('input', () => { $('maxRangeOut').textContent = $('maxRange').value; });

// 3D controls
['showLive', 'accumulate', 'showAccumulated', 'showMesh', 'meshWireframe', 'showPlanes', 'showCamera', 'followDevice', 'colorBy', 'pointSize']
  .forEach(id => $(id).addEventListener('input', async () => {
    const s = id === 'accumulate' && $('accumulate').checked ? await ensureScene() : scene3d;
    if (s) s.setOptions(sceneOptions());
  }));
$('meshColor').addEventListener('input', () => { if (scene3d) scene3d.rebuildMeshColors($('meshColor').value); });
$('clearMap').onclick = () => { if (scene3d) { scene3d.clearAccumulated(); $('sMap').textContent = '0'; } };
$('resetView').onclick = () => { if (scene3d) scene3d.resetView(); };

// stream controls -> phone
['fps', 'rgb', 'rgbWidth', 'jpegQuality', 'smoothed', 'meshStream', 'planesStream'].forEach(id =>
  $(id).addEventListener('change', () => { if (source) source.send(streamConfig()); }));
$('resetTracking').onclick = () => {
  if (!source || !source.connected) { toast('Not connected to the phone'); return; }
  source.send({ type: 'resetTracking' });
  if (scene3d) { scene3d.clearAccumulated(); scene3d.clearMesh(); }
  $('measureClear').onclick();
  toast('Tracking reset');
};
$('requestMesh').onclick = () => { if (source) source.send({ type: 'requestMesh' }); };

// connection
function defaultWsUrl() {
  if (params.get('ws')) return params.get('ws');
  if (location.protocol === 'http:' && location.hostname) return `ws://${location.hostname}:8081`;
  return '';
}

function sourceHandlers() {
  return {
    onFrame,
    onMesh: async u => { const s = await ensureScene(); if (s) s.updateMesh(u, $('meshColor').value); },
    onHello: h => {
      hello = h;
      $('device').textContent = [h.device, h.systemVersion ? `iOS ${h.systemVersion}` : ''].filter(Boolean).join(' · ');
      if (h.sceneDepth === false) toast('This device has no LiDAR scanner');
      $('smoothed').disabled = h.smoothedDepth === false;
      $('meshStream').disabled = h.mesh === false;
      if (source) source.send(streamConfig());
    },
    onStatus: st => {
      const native = source instanceof NativeSource;
      setConn(st, native && st === 'connected' ? 'LiDAR on' : undefined);
      $('connMsg').textContent = st === 'connected' ? (native ? 'Streaming from this phone\'s LiDAR scanner' : `Streaming from ${source.url}`) :
        st === 'connecting' ? (native ? 'Starting LiDAR…' : `Connecting to ${source.url}…`) :
        (native ? 'LiDAR stopped. Tap Start.' : 'Not connected. Make sure the app is open and on the same Wi-Fi.');
    },
    onError: msg => toast(msg),
  };
}

function connect(url) {
  if (!url) { toast('Enter the phone address shown in the LiDAR Bridge app'); return; }
  if (!/^wss?:\/\//.test(url)) url = 'ws://' + url.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '') + ':8081';
  $('wsUrl').value = url;
  if (location.protocol === 'https:' && url.startsWith('ws:')) {
    $('connMsg').textContent = 'This page is on https, so the browser blocks the phone\'s ws:// stream. Open the page from the phone address instead (http://<phone-ip>:8080).';
  }
  if (!source) source = new IPhoneSource(sourceHandlers());
  source.connect(url);
}

$('connectBtn').onclick = () => connect($('wsUrl').value.trim());
$('disconnectBtn').onclick = () => { if (source) source.disconnect(); };

// Android WebXR depth
webxrDepthAvailable().then(ok => {
  if (!ok || nativeLidarAvailable()) return;
  $('xrRow').hidden = false;
  $('androidHint').hidden = false;
});
$('xrBtn').onclick = async () => {
  if (xrSession) { xrSession.end(); return; }
  try {
    if (source) source.disconnect();
    xrSession = await startWebXRDepth(onFrame, $('app'), () => { xrSession = null; $('xrBtn').textContent = 'Start Android AR depth'; setConn('disconnected'); });
    $('xrBtn').textContent = 'Stop Android AR depth';
    setConn('connected', 'Android AR depth');
    $('confMin').value = '0';
  } catch (e) {
    toast('Could not start WebXR depth: ' + e.message);
  }
};

// start
if (nativeLidarAvailable()) {
  // Running inside the LiDAR Browser app: use this phone's LiDAR directly.
  source = new NativeSource(sourceHandlers());
  $('wsUrl').closest('label').hidden = true;
  $('connectBtn').textContent = 'Start LiDAR';
  $('disconnectBtn').textContent = 'Stop';
  $('connectBtn').onclick = () => source.start(streamConfig());
  $('disconnectBtn').onclick = () => source.stop();
  $('emptyState').querySelector('p').textContent = 'Starting the LiDAR scanner… allow access when asked.';
  source.start(streamConfig());
} else {
  $('wsUrl').value = defaultWsUrl();
  if (params.get('embedded') && window.matchMedia('(max-width: 820px)').matches) $('panel').classList.remove('open');
  if ($('wsUrl').value) connect($('wsUrl').value);
  else setConn('disconnected');
}
drawLegend();
window.addEventListener('resize', () => { dirty = true; });

// for debugging in the console
window.lidar = { get frame() { return current; }, get stats() { return lastStats; }, get scene() { return scene3d; }, measure, rec };
