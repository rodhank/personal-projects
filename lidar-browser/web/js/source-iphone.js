// Connection to the LiDAR Bridge iPhone app (WebSocket, auto-reconnect).
import { MSG, parseMessage, frameFromMessage, meshFromMessage } from './protocol.js';

export class IPhoneSource {
  constructor(handlers) {
    this.h = handlers; // { onFrame, onMesh, onHello, onStatus, onError }
    this.ws = null;
    this.url = null;
    this.wantOpen = false;
    this.retryTimer = null;
    this.bytes = 0;
  }

  connect(url) {
    this.url = url;
    this.wantOpen = true;
    this.open();
  }

  disconnect() {
    this.wantOpen = false;
    clearTimeout(this.retryTimer);
    if (this.ws) this.ws.close();
    this.ws = null;
    this.h.onStatus('disconnected');
  }

  get connected() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  open() {
    clearTimeout(this.retryTimer);
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
    this.h.onStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.h.onError(`Bad address: ${this.url}`);
      this.h.onStatus('disconnected');
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => this.h.onStatus('connected');
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.h.onStatus('disconnected');
      if (this.wantOpen) this.retryTimer = setTimeout(() => this.open(), 2000);
    };
    ws.onerror = () => { /* close follows */ };
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') return;
      this.bytes += ev.data.byteLength;
      let msg;
      try { msg = parseMessage(ev.data); } catch (e) { this.h.onError(`Bad message: ${e.message}`); return; }
      if (msg.type === MSG.FRAME) this.h.onFrame(frameFromMessage(msg));
      else if (msg.type === MSG.MESH) this.h.onMesh(meshFromMessage(msg));
      else if (msg.type === MSG.HELLO) this.h.onHello(msg.header);
    };
  }

  send(obj) {
    if (this.connected) this.ws.send(JSON.stringify(obj));
  }
}
