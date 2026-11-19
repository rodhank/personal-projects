// Experimental: WebXR Depth Sensing on Android Chrome (ARCore depth – not LiDAR, but a real sensor depth map).
// iPhone Safari does not support WebXR AR, so this path is Android only.

export async function webxrDepthAvailable() {
  if (!navigator.xr || !window.isSecureContext) return false;
  try { return await navigator.xr.isSessionSupported('immersive-ar'); } catch { return false; }
}

export async function startWebXRDepth(onFrame, overlayRoot, onEnd) {
  const session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['depth-sensing'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: overlayRoot },
    depthSensing: {
      usagePreference: ['cpu-optimized'],
      dataFormatPreference: ['float32', 'luminance-alpha'],
    },
  });
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { xrCompatible: true }) || canvas.getContext('webgl', { xrCompatible: true });
  await session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  const space = await session.requestReferenceSpace('local');
  let seq = 0;
  session.addEventListener('end', () => onEnd && onEnd());

  const loop = (time, xrFrame) => {
    session.requestAnimationFrame(loop);
    const pose = xrFrame.getViewerPose(space);
    if (!pose) return;
    const view = pose.views[0];
    let info;
    try { info = xrFrame.getDepthInformation(view); } catch { return; }
    if (!info) return;
    const w = info.width, h = info.height;
    const depth = new Float32Array(w * h);
    const scale = info.rawValueToMeters;
    if (session.depthDataFormat === 'float32') {
      const src = new Float32Array(info.data);
      for (let i = 0; i < depth.length; i++) depth[i] = src[i] * scale;
    } else {
      const src = new Uint16Array(info.data);
      for (let i = 0; i < depth.length; i++) depth[i] = src[i] * scale;
    }
    // Approximate pinhole intrinsics from the projection matrix (column-major).
    const P = view.projectionMatrix;
    const K = { fx: P[0] * w / 2, fy: P[5] * h / 2, cx: (1 - P[8]) * w / 2, cy: (1 + P[9]) * h / 2 };
    onFrame({
      source: 'webxr', seq: ++seq, t: time / 1000, wall: Date.now(), tracking: pose.emulatedPosition ? 'limited' : 'normal',
      w, h, depth, conf: null, K, Kfull: null,
      T: new Float32Array(view.transform.matrix),
      rgbBlob: null, rgbW: 0, rgbH: 0, planes: [], light: null, meshAnchors: 0, smoothed: false,
      bytes: depth.byteLength,
    });
  };
  session.requestAnimationFrame(loop);
  return session;
}
