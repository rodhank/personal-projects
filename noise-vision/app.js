// NOISE VISION — the world is visible only while it moves.
// Camera -> grayscale pyramid -> block-matching optical flow (GPU) ->
// a field of "material coordinates" that is advected by the flow every frame ->
// random noise looked up through those coordinates.
// Standing still: noise is frozen and looks like pure static. Moving: surfaces drag
// their noise along at different speeds (parallax), so shapes pop out. A screenshot
// shows only noise. PULSE lights a travelling ring; lit pixels slide their noise.

const $ = (id) => document.getElementById(id);
const canvas = $('gl');
const video = $('cam');

const P = {             // live parameters (bound to the settings panel)
  mode: 0, sens: 0.55, sep: 0.35, grain: 3, speed: 1, thr: 0.5, pdur: 1.8, decay: 0.975,
  colA: [0, 0, 0], colB: [1, 1, 1], ai: false, clap: false, debug: false,
};

// ---------------------------------------------------------------- WebGL setup
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
if (!gl) fatal('WebGL2 לא נתמך בדפדפן הזה.');
const hasFloatRT = gl && !!gl.getExtension('EXT_color_buffer_float');
if (gl && !hasFloatRT) fatal('הדפדפן לא תומך ב-EXT_color_buffer_float.');

const VS = `#version 300 es
in vec2 a; void main(){ gl_Position = vec4(a,0.,1.); }`;

const COMMON = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
out vec4 o;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031,.1030,.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
`;

// video -> gray (gw x gh). Texture rows are "y down" image space everywhere.
const FS_GRAY = COMMON + `
uniform sampler2D vid; uniform vec2 size;
void main(){
  vec2 px = 1.0 / size;
  vec2 uv = gl_FragCoord.xy * px;
  vec3 w = vec3(.299,.587,.114);
  float g = dot(texture(vid, uv + px*vec2(-.25,-.25)).rgb, w) + dot(texture(vid, uv + px*vec2(.25,-.25)).rgb, w)
          + dot(texture(vid, uv + px*vec2(-.25,.25)).rgb, w) + dot(texture(vid, uv + px*vec2(.25,.25)).rgb, w);
  o = vec4(vec3(g*.25), 1.);
}`;

// gray -> coarse (1/4) box average
const FS_DOWN4 = COMMON + `
uniform sampler2D src; uniform ivec2 srcSize;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy) * 4; float s = 0.;
  for (int y=0;y<4;y++) for (int x=0;x<4;x++) s += texelFetch(src, min(p+ivec2(x,y), srcSize-1), 0).r;
  o = vec4(vec3(s/16.), 1.);
}`;

// coarse block matching: flow f such that cur(p) ~ prev(p - f)   (units: coarse px)
const FS_FLOW_COARSE = COMMON + `
uniform sampler2D cur, prv; uniform ivec2 size;
float C(ivec2 p){ return texelFetch(cur, clamp(p, ivec2(0), size-1), 0).r; }
float Q(ivec2 p){ return texelFetch(prv, clamp(p, ivec2(0), size-1), 0).r; }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  float best = 1e9; ivec2 bd = ivec2(0);
  for (int dy=-4; dy<=4; dy++) for (int dx=-4; dx<=4; dx++){
    ivec2 d = ivec2(dx,dy); float c = 0.;
    for (int ky=-2; ky<=2; ky++) for (int kx=-2; kx<=2; kx++){ ivec2 k = ivec2(kx,ky); c += abs(C(p+k) - Q(p+k-d)); }
    c += 0.004 * float(dx*dx + dy*dy);
    if (c < best){ best = c; bd = d; }
  }
  o = vec4(vec2(bd), best, 1.);
}`;

// fine refinement at gray resolution, +-2 px around 4*coarse, with sub-pixel parabola fit
const FS_FLOW_FINE = COMMON + `
uniform sampler2D cur, prv, coarse; uniform ivec2 size, csize;
float C(ivec2 p){ return texelFetch(cur, clamp(p, ivec2(0), size-1), 0).r; }
float Q(ivec2 p){ return texelFetch(prv, clamp(p, ivec2(0), size-1), 0).r; }
float cost(ivec2 p, ivec2 d){ float c = 0.;
  for (int ky=-2; ky<=2; ky++) for (int kx=-2; kx<=2; kx++){ ivec2 k = ivec2(kx,ky); c += abs(C(p+k) - Q(p+k-d)); }
  return c; }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 f0 = 4.0 * texelFetch(coarse, min(p/4, csize-1), 0).xy;
  ivec2 i0 = ivec2(round(f0));
  float cs[25]; float best = 1e9; int bi = 12;
  for (int j=0; j<25; j++){
    ivec2 e = ivec2(j%5 - 2, j/5 - 2); ivec2 d = i0 + e;
    float c = cost(p, d) + 0.002 * float(dot(vec2(d), vec2(d)));
    cs[j] = c; if (c < best){ best = c; bi = j; }
  }
  ivec2 be = ivec2(bi%5 - 2, bi/5 - 2);
  vec2 sub = vec2(0.);
  if (be.x > -2 && be.x < 2){ float l = cs[bi-1], r = cs[bi+1], m = cs[bi]; float den = l - 2.*m + r; if (den > 1e-5) sub.x = clamp(.5*(l - r)/den, -.5, .5); }
  if (be.y > -2 && be.y < 2){ float l = cs[bi-5], r = cs[bi+5], m = cs[bi]; float den = l - 2.*m + r; if (den > 1e-5) sub.y = clamp(.5*(l - r)/den, -.5, .5); }
  // texture (contrast) of the patch = confidence
  float mean = 0., sq = 0.;
  for (int ky=-2; ky<=2; ky++) for (int kx=-2; kx<=2; kx++){ float v = C(p+ivec2(kx,ky)); mean += v; sq += v*v; }
  mean /= 25.; float sd = sqrt(max(sq/25. - mean*mean, 0.));
  float conf = smoothstep(0.012, 0.05, sd) * (1.0 - smoothstep(0.08, 0.35, best/25.));
  o = vec4(vec2(i0 + be) + sub, conf, sd);
}`;

// confidence-weighted smoothing (fills flat, textureless areas from their neighbours)
const FS_FLOW_SMOOTH = COMMON + `
uniform sampler2D src, prevF; uniform ivec2 size;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy); vec2 acc = vec2(0.); float wsum = 0.;
  for (int y=-3; y<=3; y++) for (int x=-3; x<=3; x++){
    vec4 f = texelFetch(src, clamp(p+ivec2(x,y), ivec2(0), size-1), 0);
    float w = (f.z + 0.002) * exp(-float(x*x+y*y)/8.);
    acc += f.xy * w; wsum += w;
  }
  vec2 f = acc / wsum;
  vec4 c = texelFetch(src, p, 0);
  f = mix(f, c.xy, c.z * 0.35);
  // temporal smoothing: blend with last frame's flow unless the motion clearly changed
  vec2 pf = texelFetch(prevF, p, 0).xy;
  float same = 1. - smoothstep(.4, 1.2, length(f - pf));
  f = mix(f, pf, .45 * same);
  o = vec4(f, c.z, c.w);
}`;

// state: xy = material coordinate of the noise (in cells), z = pulse glow, w = accumulated stretch
const FS_INIT = COMMON + `
uniform float seed;
void main(){ vec2 c = gl_FragCoord.xy; o = vec4(c + floor(hash22(c + seed) * 4096.), 0., 0.); }`;

const FS_STATE = COMMON + `
uniform sampler2D prevS, flowT, grayT, depthT;
uniform vec2 gridRes, k, graySize;
uniform float frame, sens, speed, thr, mode, decay, sep;
uniform float pulseOn, pulseR, pulseBand, depthMode, aspect;
vec2 toVid(vec2 cell){ return (cell / gridRes - .5) * k + .5; }
vec2 flowCells(vec2 cell){
  vec2 uv = clamp(toVid(cell), vec2(0.), vec2(.9999));
  vec4 t = texelFetch(flowT, ivec2(uv * graySize), 0);
  vec2 f = t.xy;                                                  // gray px
  f *= smoothstep(sens, sens * 1.6 + 0.05, length(f));            // dead zone (kills sensor jitter)
  // separation: only textured / edgy parts carry their noise; flat areas stay frozen.
  // That keeps objects visible even when you only rotate the phone (no parallax).
  float e = sep * 0.12;
  f *= smoothstep(e, e * 1.8 + 1e-4, t.w);
  return f / graySize / k * gridRes;                              // -> cells
}
float gray(vec2 uv){ return texelFetch(grayT, ivec2(clamp(uv, vec2(0.), vec2(.9999)) * graySize), 0).r; }
void main(){
  vec2 cell = gl_FragCoord.xy;
  vec2 f = mode < .5 ? flowCells(cell) : vec2(0.);
  vec2 q = cell - f; vec2 qi = floor(q);
  bool outside = any(lessThan(qi, vec2(0.))) || any(greaterThanEqual(qi, gridRes));
  vec4 s = texelFetch(prevS, ivec2(clamp(qi, vec2(0.), gridRes - 1.)), 0);
  s.xy += q - (qi + .5);
  // local stretch / tearing of the flow field
  bool tear = false;
  if (mode < .5){
    // divergence over a wider baseline (robust to per-pixel flow jitter), accumulated signed
    vec2 fx1 = flowCells(cell + vec2(3.,0.)), fx0 = flowCells(cell - vec2(3.,0.));
    vec2 fy1 = flowCells(cell + vec2(0.,3.)), fy0 = flowCells(cell - vec2(0.,3.));
    float div = (fx1.x - fx0.x + fy1.y - fy0.y) / 6.;
    s.w += div;
    // occlusion / disocclusion edge: neighbouring motion differs a lot
    vec2 a = flowCells(cell + vec2(1.,0.)), b = flowCells(cell - vec2(1.,0.));
    vec2 c = flowCells(cell + vec2(0.,1.)), d = flowCells(cell - vec2(0.,1.));
    tear = max(length(a - b), length(c - d)) > 1.5;
  }
  float r = hash12(cell * 1.37 + frame * 7.31);
  if (outside || tear || abs(s.w) > 0.8 || r < 0.0004){
    s.xy = cell + floor(hash22(cell + frame * 3.17) * 4096.);
    s.w = 0.;
  }
  vec2 uv = toVid(cell);
  // ---- PULSE: a ring travelling outwards lights pixels; lit pixels slide their noise
  s.z *= decay;
  if (pulseOn > .5){
    float lit = 0.;
    if (depthMode > .5){                        // AI depth: depth texture bright = near
      float d = 1. - texture(depthT, clamp(uv, vec2(0.), vec2(1.))).r;
      lit = 1. - smoothstep(pulseBand * .5, pulseBand, abs(d - pulseR));
    } else {                                    // no depth: 2D ring from the centre, edges only
      vec2 sv = (cell / gridRes - .5) * vec2(aspect, 1.);
      float d = length(sv) / (.5 * length(vec2(aspect, 1.)));
      vec2 gp = 1. / graySize;
      float gx = gray(uv + vec2(gp.x,0.)) - gray(uv - vec2(gp.x,0.));
      float gy = gray(uv + vec2(0.,gp.y)) - gray(uv - vec2(0.,gp.y));
      float edge = smoothstep(.03, .12, length(vec2(gx, gy)));
      lit = (1. - smoothstep(pulseBand * .5, pulseBand, abs(d - pulseR))) * edge;
    }
    s.z = max(s.z, lit);
  }
  float slide = s.z * speed;
  // ---- classic MOTUS mode: bright parts of the camera image slide constantly
  if (mode > .5) slide += step(thr, gray(uv)) * speed;
  s.y -= slide;
  if (abs(s.x) > 60000. || abs(s.y) > 60000.) s.xy = cell + floor(hash22(cell + frame) * 4096.);
  o = s;
}`;

const FS_DISPLAY = COMMON + `
uniform sampler2D stateT, vid, flowT; uniform vec2 gridRes, canvasSize, k, graySize;
uniform vec3 colA, colB; uniform float debug;
void main(){
  vec2 suv = vec2(gl_FragCoord.x, canvasSize.y - gl_FragCoord.y) / canvasSize;   // y down
  vec2 cell = floor(suv * gridRes);
  vec4 s = texelFetch(stateT, ivec2(min(cell, gridRes - 1.)), 0);
  float n = step(.5, hash12(floor(s.xy) + 0.5));
  vec3 c = mix(colA, colB, n);
  if (debug > .5){
    vec2 uv = (suv - .5) * k + .5;
    vec3 cam = texture(vid, uv).rgb;
    vec2 f = texelFetch(flowT, ivec2(clamp(uv, vec2(0.), vec2(.9999)) * graySize), 0).xy;
    vec3 fc = vec3(.5 + f.x * .12, .5 + f.y * .12, .5);
    if (suv.x < .5) c = mix(c, cam, .85); else c = mix(c, fc, .85);
  }
  o = vec4(c, 1.);
}`;

function sh(type, src){ const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').slice(0, 5).join('\n'));
  return s; }
function prog(fs){ const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'a'); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++){ const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
  return { p, u }; }

function tex(w, h, float, linear){
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const f = linear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { t, w, h, fb: null };
}
function target(T){ if (!T.fb){ T.fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, T.fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, T.t, 0); }
  gl.bindFramebuffer(gl.FRAMEBUFFER, T.fb); gl.viewport(0, 0, T.w, T.h); }
function del(T){ if (!T) return; gl.deleteTexture(T.t); if (T.fb) gl.deleteFramebuffer(T.fb); }

let PR, quad;
let vidTex, depthTex;
let gray = [], coarse = [], flowC, flowF, flowSS = [], state = [];
let flowS;
let gw = 0, gh = 0, gridW = 0, gridH = 0, frame = 0, kx = 1, ky = 1;

function initGL(){
  PR = { gray: prog(FS_GRAY), down: prog(FS_DOWN4), fc: prog(FS_FLOW_COARSE), ff: prog(FS_FLOW_FINE),
         fs: prog(FS_FLOW_SMOOTH), init: prog(FS_INIT), state: prog(FS_STATE), disp: prog(FS_DISPLAY) };
  quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  vidTex = tex(2, 2, false, true);
  depthTex = tex(2, 2, false, true);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
}

function sizeFlow(vw, vh){
  const s = 160 / Math.max(vw, vh);
  const nw = Math.max(16, Math.round(vw * s / 4) * 4), nh = Math.max(16, Math.round(vh * s / 4) * 4);
  if (nw === gw && nh === gh) return;
  gw = nw; gh = nh;
  [...gray, ...coarse, flowC, flowF, ...flowSS].forEach(del);
  gray = [tex(gw, gh, false, true), tex(gw, gh, false, true)];
  coarse = [tex(gw/4, gh/4, false, false), tex(gw/4, gh/4, false, false)];
  flowC = tex(gw/4, gh/4, true, false); flowF = tex(gw, gh, true, false); flowSS = [tex(gw, gh, true, false), tex(gw, gh, true, false)]; flowS = flowSS[0];
}

function sizeGrid(){
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const cw = Math.round(innerWidth * dpr), ch = Math.round(innerHeight * dpr);
  if (canvas.width !== cw || canvas.height !== ch){ canvas.width = cw; canvas.height = ch; }
  const nw = Math.max(8, Math.round(innerWidth / P.grain)), nh = Math.max(8, Math.round(innerHeight / P.grain));
  if (nw === gridW && nh === gridH && state.length) return;
  gridW = nw; gridH = nh; state.forEach(del);
  state = [tex(gridW, gridH, true, false), tex(gridW, gridH, true, false)];
  for (const S of state){ target(S); use(PR.init); gl.uniform1f(PR.init.u.seed, Math.random() * 1000); draw(); }
}

let cur = null;
function use(pr){ cur = pr; gl.useProgram(pr.p); }
function bindTex(name, T, unit){ gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, T.t || T); gl.uniform1i(cur.u[name], unit); }
function draw(){ gl.drawArrays(gl.TRIANGLES, 0, 3); }

// ---------------------------------------------------------------- pulse
const pulse = { on: false, t0: 0, depthMode: 0 };
let lastPulse = 0;
async function firePulse(){
  const now = performance.now();
  if (now - lastPulse < 350) return; lastPulse = now;
  let dm = 0;
  if (P.ai && depthModel.ready){
    try { await depthModel.run(); dm = 1; } catch (e){ console.warn(e); setStatus('עומק AI נכשל — PULSE דו-ממדי'); }
  }
  pulse.on = true; pulse.t0 = performance.now(); pulse.depthMode = dm;
  if (navigator.vibrate) navigator.vibrate(30);
}

// ---------------------------------------------------------------- optional AI depth (Depth Anything V2 small, in-browser)
const depthModel = {
  ready: false, loading: false, pipe: null,
  async load(){
    if (this.ready || this.loading) return; this.loading = true;
    setStatus('טוען מודל עומק…');
    try {
      const T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5');
      T.env.allowLocalModels = false;
      const webgpu = !!navigator.gpu;
      const tries = webgpu ? [{ device: 'webgpu', dtype: 'fp16' }, { device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: 'q8' }] : [{ device: 'wasm', dtype: 'q8' }];
      let err;
      for (const opt of tries){
        try { this.pipe = await T.pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small', { ...opt,
                progress_callback: (p) => { if (p.status === 'progress' && p.total) setStatus(`מוריד מודל עומק ${Math.round(p.loaded / p.total * 100)}%`); } });
              this.device = opt.device; break; } catch (e){ err = e; }
      }
      if (!this.pipe) throw err;
      this.T = T; this.ready = true; setStatus(`עומק AI מוכן (${this.device})`, 2500);
    } catch (e){ console.warn(e); setStatus('לא הצלחתי לטעון עומק AI — PULSE דו-ממדי', 4000); P.ai = false; $('ai').checked = false; }
    this.loading = false;
  },
  async run(){
    const c = this.cv || (this.cv = document.createElement('canvas'));
    const s = 384 / Math.max(video.videoWidth, video.videoHeight);
    c.width = Math.round(video.videoWidth * s); c.height = Math.round(video.videoHeight * s);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    const img = await this.T.RawImage.fromCanvas(c);
    const out = await this.pipe(img);
    const d = out.depth;                               // RawImage, 1 channel, bright = near
    const n = d.width * d.height, rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++){ const v = d.data[i * d.channels]; rgba[i*4] = rgba[i*4+1] = rgba[i*4+2] = v; rgba[i*4+3] = 255; }
    gl.bindTexture(gl.TEXTURE_2D, depthTex.t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, d.width, d.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  },
};

// ---------------------------------------------------------------- clap detection
let audio = null;
async function setClap(on){
  if (!on){ if (audio){ audio.stream.getTracks().forEach(t => t.stop()); audio.ctx.close(); audio = null; } return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream); const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
    audio = { stream, ctx, an, buf: new Float32Array(an.fftSize), avg: 0.01 };
  } catch (e){ setStatus('אין גישה למיקרופון', 3000); P.clap = false; $('clap').checked = false; }
}
function checkClap(){
  if (!audio) return;
  audio.an.getFloatTimeDomainData(audio.buf);
  let s = 0; for (const v of audio.buf) s += v * v; const rms = Math.sqrt(s / audio.buf.length);
  if (rms > 0.12 && rms > audio.avg * 6) firePulse();
  audio.avg = audio.avg * 0.97 + rms * 0.03;
}

// ---------------------------------------------------------------- main loop
let running = false;
function frameLoop(){
  if (!running) return;
  if (!window.__nvManual) requestAnimationFrame(frameLoop);
  if (video.readyState < 2 || !video.videoWidth) return;
  checkClap();
  const vw = video.videoWidth, vh = video.videoHeight;
  sizeFlow(vw, vh); sizeGrid();

  // cover-fit: screen uv -> video uv scale
  const sa = innerWidth / innerHeight, va = vw / vh;
  if (sa > va){ kx = 1; ky = va / sa; } else { kx = sa / va; ky = 1; }

  gl.bindTexture(gl.TEXTURE_2D, vidTex.t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);

  const g = gray[frame & 1], gp = gray[(frame + 1) & 1];
  const c = coarse[frame & 1], cp = coarse[(frame + 1) & 1];
  target(g); use(PR.gray); bindTex('vid', vidTex, 0); gl.uniform2f(cur.u.size, gw, gh); draw();
  target(c); use(PR.down); bindTex('src', g, 0); gl.uniform2i(cur.u.srcSize, gw, gh); draw();
  if (P.mode === 0){
    target(flowC); use(PR.fc); bindTex('cur', c, 0); bindTex('prv', cp, 1); gl.uniform2i(cur.u.size, gw/4, gh/4); draw();
    target(flowF); use(PR.ff); bindTex('cur', g, 0); bindTex('prv', gp, 1); bindTex('coarse', flowC, 2);
      gl.uniform2i(cur.u.size, gw, gh); gl.uniform2i(cur.u.csize, gw/4, gh/4); draw();
    const fPrev = flowSS[frame & 1]; flowS = flowSS[(frame + 1) & 1];
    target(flowS); use(PR.fs); bindTex('src', flowF, 0); bindTex('prevF', fPrev, 1); gl.uniform2i(cur.u.size, gw, gh); draw();
  }

  // pulse timeline
  let pr = 0;
  if (pulse.on){ pr = (performance.now() - pulse.t0) / 1000 / P.pdur; if (pr > 1.15) pulse.on = false; }

  const sIn = state[frame & 1], sOut = state[(frame + 1) & 1];
  target(sOut); use(PR.state);
  bindTex('prevS', sIn, 0); bindTex('flowT', flowS, 1); bindTex('grayT', g, 2); bindTex('depthT', depthTex, 3);
  const u = cur.u;
  gl.uniform2f(u.gridRes, gridW, gridH); gl.uniform2f(u.k, kx, ky); gl.uniform2f(u.graySize, gw, gh);
  gl.uniform1f(u.frame, frame % 10000); gl.uniform1f(u.sens, P.sens); gl.uniform1f(u.speed, P.speed);
  gl.uniform1f(u.thr, P.thr); gl.uniform1f(u.sep, P.sep); gl.uniform1f(u.mode, P.mode); gl.uniform1f(u.decay, P.decay);
  gl.uniform1f(u.pulseOn, pulse.on ? 1 : 0); gl.uniform1f(u.pulseR, pr); gl.uniform1f(u.pulseBand, 0.06);
  gl.uniform1f(u.depthMode, pulse.depthMode); gl.uniform1f(u.aspect, innerWidth / innerHeight);
  draw();

  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
  use(PR.disp); bindTex('stateT', sOut, 0); bindTex('vid', vidTex, 1); bindTex('flowT', flowS, 2);
  gl.uniform2f(cur.u.gridRes, gridW, gridH); gl.uniform2f(cur.u.canvasSize, canvas.width, canvas.height);
  gl.uniform2f(cur.u.k, kx, ky); gl.uniform2f(cur.u.graySize, gw, gh);
  gl.uniform3fv(cur.u.colA, P.colA); gl.uniform3fv(cur.u.colB, P.colB); gl.uniform1f(cur.u.debug, P.debug ? 1 : 0);
  draw();
  frame++;
}

// ---------------------------------------------------------------- start / UI
async function start(){
  $('err').hidden = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } } });
    video.srcObject = stream; await video.play();
  } catch (e){ $('err').textContent = 'אין גישה למצלמה: ' + (e.message || e.name); $('err').hidden = false; return; }
  try { initGL(); } catch (e){ fatal('שגיאת שיידר: ' + e.message); return; }
  $('start').hidden = true; $('gear').hidden = false; $('pulseBtn').hidden = false;
  running = true; frameLoop();
  window.__nv = { P, firePulse, get frame(){ return frame; }, get grid(){ return [gridW, gridH]; }, get flowSize(){ return [gw, gh]; },
    step: frameLoop,
    readState(){ const S = state[frame & 1]; target(S); const a = new Float32Array(S.w * S.h * 4); gl.readPixels(0, 0, S.w, S.h, gl.RGBA, gl.FLOAT, a); return Array.from(a); },
    readFlow(){ target(flowS); const a = new Float32Array(gw * gh * 4); gl.readPixels(0, 0, gw, gh, gl.RGBA, gl.FLOAT, a); return Array.from(a); } };
}

let statusTimer;
function setStatus(t, ms){ const s = $('status'); s.textContent = t; s.hidden = false; clearTimeout(statusTimer); if (ms) statusTimer = setTimeout(() => s.hidden = true, ms); }
function fatal(msg){ const e = $('err'); e.textContent = msg; e.hidden = false; $('go').disabled = true; }

const hex = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
function bind(){
  $('go').addEventListener('click', start);
  $('gear').addEventListener('click', (e) => { e.stopPropagation(); $('panel').hidden = false; });
  $('close').addEventListener('click', () => $('panel').hidden = true);
  $('pulseBtn').addEventListener('click', (e) => { e.stopPropagation(); firePulse(); });
  canvas.addEventListener('pointerdown', () => { if (running) firePulse(); });
  const num = (id, key, f = parseFloat) => $(id).addEventListener('input', () => { P[key] = f($(id).value); });
  num('mode', 'mode', (v) => parseInt(v)); num('sens', 'sens'); num('sep', 'sep'); num('speed', 'speed'); num('thr', 'thr'); num('pdur', 'pdur'); num('decay', 'decay');
  $('grain').addEventListener('input', () => { P.grain = parseInt($('grain').value); });
  $('colA').addEventListener('input', () => P.colA = hex($('colA').value));
  $('colB').addEventListener('input', () => P.colB = hex($('colB').value));
  $('debug').addEventListener('change', () => P.debug = $('debug').checked);
  $('ai').addEventListener('change', () => { P.ai = $('ai').checked; if (P.ai) depthModel.load(); });
  $('clap').addEventListener('change', () => { P.clap = $('clap').checked; setClap(P.clap); });
  addEventListener('keydown', (e) => { if (e.code === 'Space') firePulse(); });
}
bind();
