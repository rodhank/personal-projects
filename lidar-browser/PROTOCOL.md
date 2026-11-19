# LiDAR data format (v1)

Used by LiDAR Browser (messages are passed into the page by the app) and by the Wi-Fi LiDAR Bridge.
In LiDAR Browser you normally use `navigator.lidar` (API.md); `frame.raw` / `mesh.raw` hold these messages.

The iPhone app runs two local servers:

| Port | What |
|------|------|
| 8080 | HTTP – serves the website (the `web/` folder bundled in the app) |
| 8081 | WebSocket – streams LiDAR data, receives commands |

## Phone → browser: binary messages

Every binary WebSocket message has the same envelope (all integers little-endian):

```
offset  size  field
0       4     magic  "LDR1"
4       1     type   1 = frame, 2 = mesh, 3 = hello, 4 = pose
5       3     reserved (0)
8       4     headerLength (bytes of UTF-8 JSON, padded with spaces so 12+headerLength is a multiple of 4)
12      N     header JSON
12+N    ...   payload; every buffer starts at a 4-byte aligned offset
```

`header.buffers` is a list of `{ "name", "offset", "length" }`; `offset` is relative to the start of the payload.

### type 1 – frame (sent at the configured rate, default 15 fps)

```jsonc
{
  "seq": 1234,                 // frame counter
  "t": 5123.442,               // ARKit timestamp (seconds, device uptime)
  "wall": 1763550000000.0,     // phone wall clock (ms since epoch)
  "tracking": "normal",        // normal | notAvailable | limited:initializing | limited:excessiveMotion | limited:insufficientFeatures | limited:relocalizing
  "depth": { "w": 256, "h": 192, "smoothed": false },   // buffer "depth": Float32, metres, row-major, sensor (landscape) orientation
  "confidence": { "w": 256, "h": 192 },                 // buffer "confidence": UInt8, 0 = low, 1 = medium, 2 = high
  "rgb": { "w": 640, "h": 480 },                        // buffer "rgb": JPEG (omitted when RGB is off)
  "imageSize": [1920, 1440],   // resolution the intrinsics refer to
  "intrinsics": [fx, fy, cx, cy],
  "transform": [16 floats],    // camera → world, column-major (ARKit camera.transform)
  "light": { "ambientIntensity": 1000, "colorTemperature": 6500 },
  "planes": [ { "id", "alignment", "classification", "center": [x,y,z], "extent": [w,h], "transform": [16] } ],
  "meshAnchors": 12,
  "display": {                 // LiDAR Browser only: data for the current screen orientation / web view size
    "orientation": "portrait", "viewport": [390, 760],
    "viewTransform": [16],     // screen-oriented camera -> world
    "projection": [16],        // projection for the viewport
    "normDepthBufferFromNormView": [16]   // normalised screen coords -> normalised depth-buffer coords
  },
  "buffers": [ ... ]
}
```

Camera space follows ARKit: x right, y up, the camera looks down −z.
A depth pixel (u, v) with depth d (metres) unprojects to
`x = (u − cx)·d/fx`, `y = −(v − cy)·d/fy`, `z = −d` (intrinsics scaled to the depth resolution),
then `world = transform · [x, y, z, 1]`.

### type 2 – mesh (ARKit scene reconstruction, sent about once a second when it changes)

```jsonc
{
  "anchors": [ { "id": "UUID", "transform": [16], "vertexCount": n, "faceCount": m } ],
  "removed": [ "UUID", ... ],
  "full": false,               // true when this is a full resend
  "buffers": [ "v:<id>" Float32 xyz (anchor space), "i:<id>" Uint32 triangle indices, "c:<id>" Uint8 class per face ]
}
```

Classes: 0 none, 1 wall, 2 floor, 3 ceiling, 4 table, 5 seat, 6 window, 7 door.

### type 4 – pose (LiDAR Browser, every ARKit frame when `pose` is on)

`{ "t", "tracking", "transform": [16], "display": {...} }` – no buffers.

### type 3 – hello (sent once when a client connects)

`{ "app": "LidarBridge", "version": 1, "device": "iPhone15,3", "sceneDepth": true, "smoothedDepth": true, "mesh": true, "config": {...} }`

## Browser → phone: JSON text messages

```jsonc
{ "type": "config", "fps": 15, "rgb": true, "rgbWidth": 640, "jpegQuality": 0.6,
  "smoothed": false, "mesh": true, "planes": true }
{ "type": "resetTracking" }   // restarts ARKit tracking and clears the mesh
{ "type": "requestMesh" }     // resend every mesh anchor
```
