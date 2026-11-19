// TEST ONLY: stands in for the iOS app's native bridge so lidar-shim.js can be tested in a desktop browser.
// It forwards commands to tools/protocol_test_server.py and pushes its protocol messages into the page
// exactly like the app does (base64 -> window.__lidarBrowserReceive).
window.__lidarBrowserInfo = { app: 'LidarBrowser', version: 1, device: 'TestDevice', systemVersion: 'test', sceneDepth: true, smoothedDepth: true, mesh: true };
(function () {
  let ws = null;
  const log = (window.__mockLog = []);
  function toB64(buf) {
    let s = ''; const u = new Uint8Array(buf);
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const reply = v => Promise.resolve(v);
  window.webkit = { messageHandlers: { lidarBrowser: { postMessage(msg) {
    log.push(msg.cmd);
    switch (msg.cmd) {
      case 'requestAccess': return reply(window.__mockDeny ? 'denied' : 'granted');
      case 'start': return new Promise(res => {
        if (ws) ws.close();
        ws = new WebSocket('ws://localhost:8081');
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => { ws.send(JSON.stringify({ type: 'config', ...msg.options })); res({ ok: true, info: window.__lidarBrowserInfo }); };
        ws.onmessage = ev => {
          if (typeof ev.data === 'string') return;
          const type = new Uint8Array(ev.data)[4];
          if (type !== 3) window.__lidarBrowserReceive(type, toB64(ev.data));
        };
      });
      case 'configure': if (ws) ws.send(JSON.stringify({ type: 'config', ...msg.options })); return reply({ ok: true });
      case 'stop': if (ws) ws.close(); ws = null; return reply({ ok: true });
      case 'resetTracking': if (ws) ws.send('{"type":"resetTracking"}'); return reply({ ok: true });
      case 'requestMesh': if (ws) ws.send('{"type":"requestMesh"}'); return reply({ ok: true });
      default: return reply({ ok: false, error: 'unknown command' });
    }
  } } } };
})();
