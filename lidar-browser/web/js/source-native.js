// Data source when this site runs inside the LiDAR Browser app (navigator.lidar).
// The app delivers the same protocol messages as the Wi-Fi bridge, so the rest of the site is unchanged.
import { parseMessage, frameFromMessage, meshFromMessage } from './protocol.js';

export const nativeLidarAvailable = () => !!(navigator.lidar && navigator.lidar.available);

export class NativeSource {
  constructor(handlers) {
    this.h = handlers; // { onFrame, onMesh, onHello, onStatus, onError }
    this.running = false;
    const L = navigator.lidar;
    L.addEventListener('frame', e => {
      try { this.h.onFrame(frameFromMessage(parseMessage(e.detail.raw))); } catch (err) { this.h.onError(err.message); }
    });
    L.addEventListener('mesh', e => {
      try { this.h.onMesh(meshFromMessage(parseMessage(e.detail.raw))); } catch (err) { this.h.onError(err.message); }
    });
    L.addEventListener('status', e => {
      if (e.detail && e.detail.running === false) { this.running = false; this.h.onStatus('disconnected'); }
    });
  }

  get connected() { return this.running; }

  async start(config) {
    this.h.onStatus('connecting');
    try {
      const res = await navigator.lidar.start(toOptions(config));
      this.running = true;
      this.h.onHello({ ...(navigator.lidar.info || {}), ...(res && res.info ? res.info : {}) });
      this.h.onStatus('connected');
    } catch (e) {
      this.h.onStatus('disconnected');
      this.h.onError(e.message);
    }
  }

  stop() {
    navigator.lidar.stop();
    this.running = false;
    this.h.onStatus('disconnected');
  }

  /** Same command objects the Wi-Fi source accepts. */
  send(obj) {
    if (!navigator.lidar) return;
    if (obj.type === 'config') navigator.lidar.configure(toOptions(obj));
    else if (obj.type === 'resetTracking') navigator.lidar.resetTracking();
    else if (obj.type === 'requestMesh') navigator.lidar.requestMesh();
  }
}

function toOptions(c) {
  return {
    fps: c.fps, rgb: c.rgb, rgbWidth: c.rgbWidth, jpegQuality: c.jpegQuality,
    smoothed: c.smoothed, mesh: c.mesh, planes: c.planes, camera: false, pose: false,
  };
}
