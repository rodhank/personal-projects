# Using the iPhone LiDAR from your website (LiDAR Browser)

When your page is opened in the **LiDAR Browser** app on a LiDAR iPhone or iPad, it gets real LiDAR
depth in one of two ways. The first time, the user is asked to allow your site. Only `https://` sites
(and `http://localhost` during development) are eligible.

## Option 1 – WebXR (same code as Android Chrome)

LiDAR Browser implements the WebXR `immersive-ar` session with the **`depth-sensing`** feature
(`cpu-optimized`, `float32`). Code written for Android Chrome's WebXR depth works unchanged, and so does
three.js (`renderer.xr`).

```js
const session = await navigator.xr.requestSession('immersive-ar', {
  requiredFeatures: ['depth-sensing'],
  optionalFeatures: ['dom-overlay', 'local-floor'],
  domOverlay: { root: document.getElementById('ui') },
  depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: ['float32'] },
});
const gl = document.createElement('canvas').getContext('webgl', { xrCompatible: true });
await session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
const space = await session.requestReferenceSpace('local');

session.requestAnimationFrame(function onFrame(t, frame) {
  session.requestAnimationFrame(onFrame);
  const pose = frame.getViewerPose(space);
  if (!pose) return;
  const depth = frame.getDepthInformation(pose.views[0]);
  if (depth) console.log('centre distance', depth.getDepthInMeters(0.5, 0.5), 'm');
});
```

* The live camera is drawn by the app **behind** your page. During the session your canvas is made
  full-screen and the page background transparent, so 3D content appears over the camera.
* **Supported:** reference spaces `viewer`, `local`, `local-floor` (uses the detected floor) and
  `unbounded`; `dom-overlay`; `XRWebGLLayer`; `getViewerPose`, `getPose`, `getDepthInformation`
  (`width`, `height`, `data`, `rawValueToMeters`, `getDepthInMeters`, `normDepthBufferFromNormView`).
* **Not supported (yet):** hit-test, anchors, input sources/`select` events, WebXR Layers,
  `gpu-optimized` depth. Requesting one of these as a *required* feature rejects the session.
* Working examples: `web/examples/webxr-depth.html` (plain WebXR) and `web/examples/three-ar.html` (three.js).

## Option 2 – `navigator.lidar` (everything ARKit offers)

```js
if (navigator.lidar && navigator.lidar.available) {
  navigator.lidar.addEventListener('frame', e => {
    const f = e.detail;
    console.log(f.width, f.height, f.depthAtScreen(0.5, 0.5));
  });
  await navigator.lidar.start({ fps: 30, rgb: true, mesh: true });
}
```

| Member | Description |
|---|---|
| `available` | `true` on devices with a LiDAR scanner |
| `info` | `{ device, systemVersion, sceneDepth, smoothedDepth, mesh }` |
| `requestAccess()` | asks the user → `'granted'` or `'denied'` (`start()` calls it for you) |
| `start(options)` | starts streaming; rejects `NotAllowedError` if denied |
| `configure(options)` | change options while running |
| `stop()` | stop streaming |
| `resetTracking()` | restart ARKit tracking and clear the mesh |
| `requestMesh()` | resend all mesh anchors |
| `latestFrame` | most recent frame |
| events `frame`, `mesh`, `status` | `event.detail` holds the data; or set `onframe` / `onmesh` / `onstatus` |

**Options:** `fps` (1–60, default 30), `rgb` (camera JPEG, default false), `rgbWidth` (default 640),
`jpegQuality` (0.1–1), `smoothed` (ARKit temporally smoothed depth), `mesh` (scene reconstruction),
`planes` (default true), `camera` (draw the live camera behind the page), `pose` (60 fps pose updates for
`latestPose`).

**Frame** (`event.detail`):

| Field | |
|---|---|
| `depth` | `Float32Array`, metres, `width`×`height` (256×192), row-major, camera sensor orientation (landscape) |
| `confidence` | `Uint8Array`, 0 low · 1 medium · 2 high |
| `intrinsics` | `{fx, fy, cx, cy}` at depth resolution |
| `cameraIntrinsics` | `{fx, fy, cx, cy, width, height}` at full camera resolution |
| `cameraTransform` | camera→world 4×4, column-major (ARKit convention: x right, y up, looks down −z) |
| `viewTransform`, `projectionMatrix` | screen-oriented camera pose and projection for the current viewport |
| `normDepthBufferFromNormView` | maps normalised screen coords → normalised depth-buffer coords |
| `depthAt(u, v)`, `depthAtScreen(x, y)` | metres at a depth pixel / at normalised screen coords |
| `rgb`, `rgbWidth`, `rgbHeight` | camera JPEG `Blob` (when `rgb: true`) |
| `planes` | detected planes `{id, alignment, classification, center, extent, transform}` |
| `light` | `{ambientIntensity, colorTemperature}` |
| `tracking`, `timestamp`, `seq`, `smoothed` | |
| `raw` | the original binary message (see PROTOCOL.md) |

To turn a depth pixel into a 3D world point:
```js
const { fx, fy, cx, cy } = f.intrinsics, T = f.cameraTransform, d = f.depth[v * f.width + u];
const x = (u - cx) * d / fx, y = -(v - cy) * d / fy, z = -d;            // camera space
const world = [T[0]*x + T[4]*y + T[8]*z + T[12], T[1]*x + T[5]*y + T[9]*z + T[13], T[2]*x + T[6]*y + T[10]*z + T[14]];
```

**Mesh** (`event.detail`): `{ anchors: [{ id, transform, vertices (Float32 xyz), indices (Uint32), classes (Uint8 per triangle) }], removed: [ids], full }`.
Classes: 0 none, 1 wall, 2 floor, 3 ceiling, 4 table, 5 seat, 6 window, 7 door.

## Feature detection

```js
const inLidarBrowser = !!(navigator.lidar && navigator.lidar.available);
const webxrAR = navigator.xr && await navigator.xr.isSessionSupported('immersive-ar'); // Android Chrome or LiDAR Browser
```

On a normal iPhone browser neither exists. You can show a link that tells users to open your page in
LiDAR Browser.
