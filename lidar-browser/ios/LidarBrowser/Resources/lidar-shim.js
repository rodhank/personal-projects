/*
 * LiDAR Browser – injected into every page (main frame) at document start.
 *
 * Gives websites two ways to use the iPhone LiDAR scanner, after the user allows it per site:
 *   1. navigator.lidar          – simple API: depth (metres), confidence, camera image, pose, planes, mesh
 *   2. navigator.xr (polyfill)  – WebXR 'immersive-ar' subset with 'depth-sensing' (cpu-optimized, float32),
 *                                 so pages written for Android Chrome's WebXR depth work unchanged.
 *
 * Native side: window.webkit.messageHandlers.lidarBrowser (replies via promises), and it calls
 * window.__lidarBrowserReceive(type, base64) / window.__lidarBrowserStatus(obj) to push data.
 */
(function () {
  'use strict';
  if (window.__lidarBrowser) return;
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.lidarBrowser;
  if (!handler) return;
  const INFO = window.__lidarBrowserInfo || { sceneDepth: false };

  const call = msg => Promise.resolve(handler.postMessage(msg));
  let activeSession = null; // current polyfilled XRSession, if any

  // ---------------------------------------------------------------- protocol
  const MAGIC = 0x3152444c; // "LDR1"
  const textDecoder = new TextDecoder();

  function base64ToBuffer(b64) {
    const bin = atob(b64);
    const n = bin.length;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function parse(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength < 12 || dv.getUint32(0, true) !== MAGIC) throw new Error('LiDAR Browser: bad message');
    const type = dv.getUint8(4);
    const len = dv.getUint32(8, true);
    const header = JSON.parse(textDecoder.decode(new Uint8Array(buf, 12, len)));
    const base = 12 + len;
    const buffers = {};
    for (const b of header.buffers || []) buffers[b.name] = { offset: base + b.offset, length: b.length };
    const get = (name, Ctor) => {
      const b = buffers[name];
      if (!b) return null;
      const n = Math.floor(b.length / Ctor.BYTES_PER_ELEMENT);
      return b.offset % Ctor.BYTES_PER_ELEMENT === 0 ? new Ctor(buf, b.offset, n)
        : new Ctor(buf.slice(b.offset, b.offset + n * Ctor.BYTES_PER_ELEMENT));
    };
    return { type, header, buffers, get, buf };
  }

  const f32 = a => (a ? new Float32Array(a) : null);

  function makeFrame(m) {
    const h = m.header;
    const w = h.depth.w, hh = h.depth.h;
    const sx = w / h.imageSize[0], sy = hh / h.imageSize[1];
    const [fx, fy, cx, cy] = h.intrinsics;
    const rgbBytes = m.get('rgb', Uint8Array);
    const d = h.display || null;
    const frame = {
      seq: h.seq,
      timestamp: h.t,
      tracking: h.tracking,
      width: w,
      height: hh,
      depth: m.get('depth', Float32Array),          // metres, row-major, camera sensor orientation
      confidence: m.get('confidence', Uint8Array),   // 0 low, 1 medium, 2 high
      smoothed: !!h.depth.smoothed,
      intrinsics: { fx: fx * sx, fy: fy * sy, cx: cx * sx, cy: cy * sy },          // at depth resolution
      cameraIntrinsics: { fx, fy, cx, cy, width: h.imageSize[0], height: h.imageSize[1] },
      cameraTransform: f32(h.transform),             // camera -> world, column-major 4x4 (sensor orientation)
      viewTransform: d ? f32(d.viewTransform) : null,             // screen-oriented camera -> world
      projectionMatrix: d ? f32(d.projection) : null,             // for the current screen viewport
      normDepthBufferFromNormView: d ? f32(d.normDepthBufferFromNormView) : null,
      viewport: d ? d.viewport : null,
      rgb: rgbBytes ? new Blob([rgbBytes], { type: 'image/jpeg' }) : null,
      rgbWidth: h.rgb ? h.rgb.w : 0,
      rgbHeight: h.rgb ? h.rgb.h : 0,
      planes: h.planes || [],
      light: h.light || null,
      meshAnchorCount: h.meshAnchors || 0,
      raw: m.buf,                                    // the original protocol message (see PROTOCOL.md)
      /** depth in metres at depth-pixel (u, v); NaN if none */
      depthAt(u, v) {
        const x = Math.round(u), y = Math.round(v);
        if (x < 0 || y < 0 || x >= w || y >= hh) return NaN;
        const z = this.depth[y * w + x];
        return z > 0 ? z : NaN;
      },
      /** depth in metres at normalised screen coordinates (0..1, origin top-left) */
      depthAtScreen(x, y) {
        const M = this.normDepthBufferFromNormView;
        let u = x, v = y;
        if (M) { u = M[0] * x + M[4] * y + M[12]; v = M[1] * x + M[5] * y + M[13]; }
        return this.depthAt(u * w - 0.5, v * hh - 0.5);
      },
    };
    return frame;
  }

  function makeMesh(m) {
    const h = m.header;
    return {
      anchors: (h.anchors || []).map(a => ({
        id: a.id,
        transform: f32(a.transform),
        vertices: m.get('v:' + a.id, Float32Array),
        indices: m.get('i:' + a.id, Uint32Array),
        classes: m.get('c:' + a.id, Uint8Array),
      })),
      removed: h.removed || [],
      full: !!h.full,
      raw: m.buf,
    };
  }

  // ---------------------------------------------------------------- navigator.lidar
  class LidarAPI extends EventTarget {
    constructor() {
      super();
      this.available = !!INFO.sceneDepth;
      this.info = INFO;
      this.running = false;
      this.latestFrame = null;
      this.latestPose = null;
      this.onframe = null; this.onmesh = null; this.onstatus = null;
    }
    /** Ask the user for permission. Resolves 'granted' or 'denied'. */
    async requestAccess() {
      return call({ cmd: 'requestAccess' });
    }
    /**
     * Start streaming. Options: fps (1-60, default 30), rgb (camera JPEG, default false), rgbWidth, jpegQuality,
     * smoothed (ARKit temporally smoothed depth), mesh (scene mesh), planes, camera (show live camera behind
     * the page – make your page background transparent), pose (60 fps pose updates).
     */
    async start(options = {}) {
      if (!this.available) throw new DOMException('This device has no LiDAR scanner', 'NotSupportedError');
      const access = await this.requestAccess();
      if (access !== 'granted') throw new DOMException('LiDAR access denied', 'NotAllowedError');
      const res = await call({ cmd: 'start', options });
      if (!res || !res.ok) throw new DOMException((res && res.error) || 'Could not start LiDAR', 'InvalidStateError');
      this.running = true;
      return res;
    }
    async configure(options = {}) { return call({ cmd: 'configure', options }); }
    async stop() { this.running = false; return call({ cmd: 'stop' }); }
    async resetTracking() { return call({ cmd: 'resetTracking' }); }
    async requestMesh() { return call({ cmd: 'requestMesh' }); }
    _emit(type, detail) {
      const ev = new CustomEvent(type, { detail });
      const fn = this['on' + type];
      if (typeof fn === 'function') { try { fn.call(this, ev); } catch (e) { console.error(e); } }
      this.dispatchEvent(ev);
    }
  }
  const lidar = new LidarAPI();
  Object.defineProperty(navigator, 'lidar', { value: lidar, configurable: false, enumerable: true });
  window.__lidarBrowser = lidar;

  window.__lidarBrowserReceive = function (type, b64) {
    let m;
    try { m = parse(base64ToBuffer(b64)); } catch (e) { console.error(e); return; }
    if (m.type === 1) {
      const f = makeFrame(m);
      lidar.latestFrame = f;
      if (f.viewTransform) lidar.latestPose = { viewTransform: f.viewTransform, projectionMatrix: f.projectionMatrix, cameraTransform: f.cameraTransform, tracking: f.tracking, timestamp: f.timestamp };
      lidar._emit('frame', f);
    } else if (m.type === 2) {
      lidar._emit('mesh', makeMesh(m));
    } else if (m.type === 4) {
      const h = m.header;
      if (h.display) {
        lidar.latestPose = { viewTransform: f32(h.display.viewTransform), projectionMatrix: f32(h.display.projection),
          cameraTransform: f32(h.transform), tracking: h.tracking, timestamp: h.t };
      }
    }
  };

  window.__lidarBrowserStatus = function (s) {
    if (s && s.running === false) lidar.running = false;
    lidar._emit('status', s);
    if (s && s.running === false && activeSession) activeSession._shutdown(false);
  };

  // ---------------------------------------------------------------- WebXR polyfill (immersive-ar + depth-sensing subset)
  // iPhone Safari has no WebXR AR. On LiDAR devices, LiDAR Browser always provides its own implementation
  // (even if a future iOS exposes a partial navigator.xr without AR or depth).
  if (!lidar.available) return;

  const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  function invertRigid(m) {
    const r = new Float32Array(16);
    r[0] = m[0]; r[1] = m[4]; r[2] = m[8];
    r[4] = m[1]; r[5] = m[5]; r[6] = m[9];
    r[8] = m[2]; r[9] = m[6]; r[10] = m[10];
    r[12] = -(r[0] * m[12] + r[4] * m[13] + r[8] * m[14]);
    r[13] = -(r[1] * m[12] + r[5] * m[13] + r[9] * m[14]);
    r[14] = -(r[2] * m[12] + r[6] * m[13] + r[10] * m[14]);
    r[15] = 1;
    return r;
  }
  function quatFromMatrix(m) {
    const t = m[0] + m[5] + m[10];
    let x, y, z, w;
    if (t > 0) { const s = 0.5 / Math.sqrt(t + 1); w = 0.25 / s; x = (m[6] - m[9]) * s; y = (m[8] - m[2]) * s; z = (m[1] - m[4]) * s; }
    else if (m[0] > m[5] && m[0] > m[10]) { const s = 2 * Math.sqrt(1 + m[0] - m[5] - m[10]); w = (m[6] - m[9]) / s; x = 0.25 * s; y = (m[4] + m[1]) / s; z = (m[8] + m[2]) / s; }
    else if (m[5] > m[10]) { const s = 2 * Math.sqrt(1 + m[5] - m[0] - m[10]); w = (m[8] - m[2]) / s; x = (m[4] + m[1]) / s; y = 0.25 * s; z = (m[9] + m[6]) / s; }
    else { const s = 2 * Math.sqrt(1 + m[10] - m[0] - m[5]); w = (m[1] - m[4]) / s; x = (m[8] + m[2]) / s; y = (m[9] + m[6]) / s; z = 0.25 * s; }
    const n = Math.hypot(x, y, z, w) || 1;
    return { x: x / n, y: y / n, z: z / n, w: w / n };
  }
  function matrixFromPosQuat(p, q) {
    const { x, y, z, w } = q;
    const m = new Float32Array(16);
    m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w); m[2] = 2 * (x * z - y * w);
    m[4] = 2 * (x * y - z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w);
    m[8] = 2 * (x * z + y * w); m[9] = 2 * (y * z - x * w); m[10] = 1 - 2 * (x * x + y * y);
    m[12] = p.x; m[13] = p.y; m[14] = p.z; m[15] = 1;
    return m;
  }
  const point = (x, y, z, w) => (typeof DOMPointReadOnly === 'function' ? new DOMPointReadOnly(x, y, z, w) : { x, y, z, w });

  class XRRigidTransform {
    constructor(position, orientation) {
      if (position instanceof Float32Array && position.length === 16) {
        this._m = new Float32Array(position);
      } else {
        const p = position || {}, o = orientation || {};
        this._m = matrixFromPosQuat({ x: p.x || 0, y: p.y || 0, z: p.z || 0 },
          { x: o.x || 0, y: o.y || 0, z: o.z || 0, w: o.w === undefined ? 1 : o.w });
      }
      const q = quatFromMatrix(this._m);
      this.position = point(this._m[12], this._m[13], this._m[14], 1);
      this.orientation = point(q.x, q.y, q.z, q.w);
    }
    get matrix() { return new Float32Array(this._m); }
    get inverse() { return new XRRigidTransform(invertRigid(this._m)); }
  }

  class XRSpace extends EventTarget {}
  /** Floor height (y of the lowest detected floor plane), or null until ARKit has found one. */
  function floorHeight() {
    const planes = (lidar.latestFrame && lidar.latestFrame.planes || []).filter(p => p.classification === 'floor' || p.alignment === 'horizontal');
    const floors = planes.filter(p => p.classification === 'floor');
    const use = floors.length ? floors : planes;
    return use.length ? Math.min(...use.map(p => p.transform[13] + p.center[1])) : null;
  }
  class XRReferenceSpace extends XRSpace {
    constructor(type, offset, extra) {
      super();
      this._type = type; this._base = offset || IDENTITY; this._extra = extra || IDENTITY; this.onreset = null;
      this._floorY = null;
    }
    get _offset() {
      if (this._type !== 'local-floor') return mul(this._base, this._extra);
      if (this._floorY === null) { const y = floorHeight(); if (y !== null) this._floorY = y; }
      const b = new Float32Array(IDENTITY); b[13] = this._floorY === null ? -1.5 : this._floorY; // estimate until a floor is seen
      return mul(b, this._extra);
    }
    getOffsetReferenceSpace(originOffset) {
      const s = new XRReferenceSpace(this._type, this._base, mul(this._extra, originOffset._m));
      s._floorY = this._floorY;
      return s;
    }
  }
  class XRView {
    constructor(transform, projectionMatrix) {
      this.eye = 'none';
      this.transform = transform;
      this.projectionMatrix = projectionMatrix;
      this.recommendedViewportScale = null;
    }
    requestViewportScale() {}
  }
  class XRPose { constructor(t) { this.transform = t; this.emulatedPosition = false; } }
  class XRViewerPose extends XRPose { constructor(t, views) { super(t); this.views = views; } }

  class XRCPUDepthInformation {
    constructor(frame) {
      this.width = frame.width;
      this.height = frame.height;
      this.data = frame.depth.buffer.slice(frame.depth.byteOffset, frame.depth.byteOffset + frame.depth.byteLength);
      this._depth = new Float32Array(this.data);
      this.rawValueToMeters = 1;
      const M = frame.normDepthBufferFromNormView || IDENTITY;
      this.normDepthBufferFromNormView = { matrix: new Float32Array(M), inverse: null };
    }
    getDepthInMeters(x, y) {
      if (x < 0 || x > 1 || y < 0 || y > 1) throw new RangeError('coordinates out of range');
      const M = this.normDepthBufferFromNormView.matrix;
      const u = M[0] * x + M[4] * y + M[12], v = M[1] * x + M[5] * y + M[13];
      const px = Math.min(this.width - 1, Math.max(0, Math.floor(u * this.width)));
      const py = Math.min(this.height - 1, Math.max(0, Math.floor(v * this.height)));
      const d = this._depth[py * this.width + px];
      return d > 0 ? d : 0;
    }
  }

  class XRFrame {
    constructor(session, pose, depthFrame) {
      this.session = session;
      this._pose = pose;
      this._depthFrame = depthFrame;
      this._depthCache = null;
      this.trackedAnchors = new Set();
      this.predictedDisplayTime = performance.now();
    }
    _viewerMatrixIn(space) {
      if (!this._pose) return null;
      if (space && space._type === 'viewer') return IDENTITY;
      const offset = space ? space._offset : IDENTITY;
      return mul(invertRigid(offset), this._pose.viewTransform);
    }
    getViewerPose(space) {
      const m = this._viewerMatrixIn(space);
      if (!m) return null;
      const t = new XRRigidTransform(m);
      const view = new XRView(t, new Float32Array(this._pose.projectionMatrix));
      view._session = this.session;
      const pose = new XRViewerPose(t, [view]);
      pose.emulatedPosition = this._pose.tracking !== 'normal';
      return pose;
    }
    getPose(space, baseSpace) {
      if (!this._pose) return null;
      const spaceM = space._type === 'viewer' ? this._pose.viewTransform : space._offset;
      const baseM = baseSpace._type === 'viewer' ? this._pose.viewTransform : baseSpace._offset;
      return new XRPose(new XRRigidTransform(mul(invertRigid(baseM), spaceM)));
    }
    getDepthInformation(view) {
      if (!this.session._depthEnabled) throw new DOMException('depth-sensing not enabled', 'NotSupportedError');
      if (!this._depthFrame) return null;
      if (!this._depthCache) this._depthCache = new XRCPUDepthInformation(this._depthFrame);
      return this._depthCache;
    }
    getHitTestResults() { return []; }
    getHitTestResultsForTransientInput() { return []; }
  }

  class XRWebGLLayer {
    constructor(session, context, init = {}) {
      this.context = context;
      this.antialias = init.antialias !== false;
      this.ignoreDepthValues = true;
      this.fixedFoveation = null;
      this.framebuffer = null; // draw straight to the page canvas, which sits over the live camera
      this._session = session;
    }
    get framebufferWidth() { return this.context.drawingBufferWidth; }
    get framebufferHeight() { return this.context.drawingBufferHeight; }
    getViewport() { return { x: 0, y: 0, width: this.framebufferWidth, height: this.framebufferHeight }; }
    static getNativeFramebufferScaleFactor() { return window.devicePixelRatio || 1; }
  }

  const SUPPORTED_FEATURES = ['viewer', 'local', 'local-floor', 'unbounded', 'depth-sensing', 'dom-overlay'];

  class XRSession extends EventTarget {
    constructor(mode, init) {
      super();
      this._mode = mode;
      const req = init.requiredFeatures || [], opt = init.optionalFeatures || [];
      this.enabledFeatures = Object.freeze([...new Set([...req, ...opt.filter(f => SUPPORTED_FEATURES.includes(f)), 'viewer', 'local'])]);
      this._depthEnabled = this.enabledFeatures.includes('depth-sensing');
      this.depthUsage = this._depthEnabled ? 'cpu-optimized' : undefined;
      this.depthDataFormat = this._depthEnabled ? 'float32' : undefined;
      this.environmentBlendMode = 'alpha-blend';
      this.interactionMode = 'screen-space';
      this.visibilityState = 'visible';
      this.inputSources = [];
      this.supportedFrameRates = null;
      this.frameRate = null;
      this.renderState = { baseLayer: null, depthNear: 0.1, depthFar: 1000, inlineVerticalFieldOfView: null };
      this._overlayRoot = this.enabledFeatures.includes('dom-overlay') && init.domOverlay ? init.domOverlay.root : null;
      this.domOverlayState = this._overlayRoot ? { type: 'screen' } : null;
      this._callbacks = new Map();
      this._nextId = 1;
      this._ended = false;
      this._restore = [];
      this.onend = null; this.onselect = null; this.onvisibilitychange = null; this.oninputsourceschange = null;
      this._frameListener = e => { this._latestDepth = e.detail; };
      lidar.addEventListener('frame', this._frameListener);
      this._styleForAR();
    }
    updateRenderState(state = {}) {
      Object.assign(this.renderState, state);
      if (state.baseLayer) this._attachCanvas(state.baseLayer.context.canvas);
    }
    updateTargetFrameRate() { return Promise.resolve(); }
    requestReferenceSpace(type) {
      if (!['viewer', 'local', 'local-floor', 'unbounded'].includes(type)) {
        return Promise.reject(new DOMException(`Reference space "${type}" is not supported`, 'NotSupportedError'));
      }
      return Promise.resolve(new XRReferenceSpace(type));
    }
    requestAnimationFrame(cb) {
      const id = this._nextId++;
      this._callbacks.set(id, cb);
      if (!this._rafPending) {
        this._rafPending = true;
        window.requestAnimationFrame(t => this._tick(t));
      }
      return id;
    }
    cancelAnimationFrame(id) { this._callbacks.delete(id); }
    _tick(t) {
      this._rafPending = false;
      if (this._ended) return;
      const callbacks = this._callbacks;
      this._callbacks = new Map();
      const frame = new XRFrame(this, lidar.latestPose, this._latestDepth || lidar.latestFrame);
      for (const cb of callbacks.values()) {
        try { cb(t, frame); } catch (e) { console.error(e); }
      }
    }
    async end() { this._shutdown(true); }
    _shutdown(stopNative) {
      if (this._ended) return;
      this._ended = true;
      lidar.removeEventListener('frame', this._frameListener);
      if (stopNative) lidar.stop();
      for (const undo of this._restore.reverse()) { try { undo(); } catch { /* ignore */ } }
      this._restore = [];
      activeSession = null;
      const ev = new Event('end');
      ev.session = this;
      if (typeof this.onend === 'function') this.onend(ev);
      this.dispatchEvent(ev);
    }
    _styleForAR() {
      // The live camera is drawn natively behind the page, so the page must be see-through.
      for (const el of [document.documentElement, document.body].filter(Boolean)) {
        const prev = el.style.background;
        el.style.background = 'transparent';
        this._restore.push(() => { el.style.background = prev; });
      }
      if (this._overlayRoot) {
        const r = this._overlayRoot, prev = { position: r.style.position, zIndex: r.style.zIndex };
        if (getComputedStyle(r).position === 'static') r.style.position = 'relative';
        r.style.zIndex = '2';
        this._restore.push(() => { r.style.position = prev.position; r.style.zIndex = prev.zIndex; });
      }
    }
    _attachCanvas(canvas) {
      if (!canvas || canvas.__lidarAttached) return;
      canvas.__lidarAttached = true;
      const prevStyle = canvas.getAttribute('style');
      const wasInDom = canvas.isConnected;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      Object.assign(canvas.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', zIndex: '1', background: 'transparent' });
      if (!wasInDom) document.body.appendChild(canvas);
      this._restore.push(() => {
        canvas.__lidarAttached = false;
        if (prevStyle === null) canvas.removeAttribute('style'); else canvas.setAttribute('style', prevStyle);
        if (!wasInDom) canvas.remove();
      });
    }
  }

  class XRSystem extends EventTarget {
    constructor() { super(); this.ondevicechange = null; }
    async isSessionSupported(mode) {
      return mode === 'immersive-ar' && lidar.available;
    }
    async requestSession(mode, init = {}) {
      if (mode !== 'immersive-ar') throw new DOMException(`Session mode "${mode}" is not supported in LiDAR Browser`, 'NotSupportedError');
      if (!lidar.available) throw new DOMException('This device has no LiDAR scanner', 'NotSupportedError');
      if (activeSession) throw new DOMException('An XR session is already active', 'InvalidStateError');
      const unsupported = (init.requiredFeatures || []).filter(f => !SUPPORTED_FEATURES.includes(f));
      if (unsupported.length) throw new DOMException(`Unsupported required feature(s): ${unsupported.join(', ')}`, 'NotSupportedError');
      const wantsDepth = (init.requiredFeatures || []).concat(init.optionalFeatures || []).includes('depth-sensing');
      if (wantsDepth && init.depthSensing) {
        const usage = init.depthSensing.usagePreference || [];
        const fmt = init.depthSensing.dataFormatPreference || [];
        if (usage.length && !usage.includes('cpu-optimized') && (init.requiredFeatures || []).includes('depth-sensing')) {
          throw new DOMException('Only cpu-optimized depth is supported', 'NotSupportedError');
        }
        if (fmt.length && !fmt.includes('float32') && (init.requiredFeatures || []).includes('depth-sensing')) {
          throw new DOMException('Only float32 depth is supported', 'NotSupportedError');
        }
      }
      await lidar.start({ fps: wantsDepth ? 30 : 15, camera: true, pose: true, rgb: false, mesh: false, planes: true });
      activeSession = new XRSession(mode, init);
      return activeSession;
    }
  }

  // Libraries (e.g. three.js) switch to WebXR Layers when XRWebGLBinding exists; this implementation draws
  // through XRWebGLLayer, so make sure they take that path.
  try { delete window.XRWebGLBinding; } catch { /* ignore */ }
  if (window.XRWebGLBinding) { try { window.XRWebGLBinding = undefined; } catch { /* ignore */ } }

  const xr = new XRSystem();
  Object.defineProperty(navigator, 'xr', { value: xr, configurable: true, enumerable: true });
  Object.assign(window, {
    XRSystem, XRSession, XRFrame, XRView, XRPose, XRViewerPose, XRSpace, XRReferenceSpace,
    XRRigidTransform, XRWebGLLayer, XRCPUDepthInformation,
  });
  // Our sessions draw to an ordinary canvas, so every WebGL context is already "XR compatible".
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (C) C.prototype.makeXRCompatible = function () { return Promise.resolve(); };
  }
})();
