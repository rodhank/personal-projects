# LiDAR Browser

An iPhone/iPad web browser that lets websites use the **real LiDAR scanner**, with the user's permission.
Safari blocks websites from the LiDAR. LiDAR Browser opens any website and gives it live depth data,
the same way Android Chrome lets websites use its depth sensor.

* **Address bar** – open any website, or search.
* **Per-site permission** – "Allow “example.com” to use the LiDAR scanner?" Choices are remembered
  and can be revoked in **Site Permissions**.
* **"LiDAR in use by …" banner** with a Stop button whenever a site is using the scanner.
* **For websites:**
  * standard **WebXR** (`immersive-ar` + `depth-sensing`), so code written for Android Chrome and
    three.js works unchanged, drawn over the live camera;
  * **`navigator.lidar`** for everything ARKit provides: depth, confidence, camera image, intrinsics,
    pose, planes, light, and the 3D scene mesh. See **API.md**.
* **Built-in home page: LiDAR Viewer.** Depth heatmap, normals, contours, 3D point cloud and room mesh,
  tap-to-measure, and exports (PNG/PLY/OBJ/ZIP recordings, saved through the iOS share sheet).
* **Examples** in the ⋯ menu: plain WebXR depth, and three.js AR with LiDAR depth.

## How it works

```
 Website (any https page)             LiDAR Browser app
 ┌──────────────────────────┐        ┌──────────────────────────────────────────┐
 │ navigator.xr  (WebXR)     │◀──────▶│ injected script (lidar-shim.js)          │
 │ navigator.lidar           │        │   ⇅ WKScriptMessageHandlerWithReply      │
 └──────────────────────────┘        │ LidarBridge – permissions, start/stop    │
        drawn over ▲                  │ ARCapture – ARKit: sceneDepth, smoothed, │
 ┌──────────────────────────┐        │   confidence, camera, pose, planes, mesh │
 │ live camera (ARSCNView)   │        └──────────────────────────────────────────┘
 └──────────────────────────┘
```

Data goes straight from ARKit into the page inside the phone. Nothing is sent over a network.

## Build and install

### Option A — Windows PC, no Mac (free)

**1. Build the .ipa on GitHub (cloud Mac, free for public repos)**
1. Create a free account at github.com → **New repository** → name it `lidar-browser`, set it **Public**,
   and create it.
2. On the new repo page click **uploading an existing file**, then drag in *everything inside* this
   folder (`ios`, `web`, `tools`, `.github`, the `.md` files). Commit.
   - Windows Explorer hides folders starting with a dot. If `.github` doesn't upload, use
     [GitHub Desktop](https://desktop.github.com) instead, or create the file
     `.github/workflows/ios-build.yml` in the web UI (**Add file → Create new file**) and paste its contents.
3. Open the **Actions** tab → **Build iPhone app (.ipa)** → **Run workflow**. Wait ~5–10 minutes.
4. Open the finished run → under **Artifacts** download **LidarBrowser-ipa** → unzip → `LidarBrowser.ipa`.
   If the run is red, download **build-log** and send it for fixing.

**2. Install it on your iPhone with Sideloadly**
1. Install **iTunes from apple.com** (not the Microsoft Store version) and **Sideloadly** (sideloadly.io).
2. Plug the iPhone in with a cable, tap **Trust This Computer** on the phone.
3. In Sideloadly: drag in `LidarBrowser.ipa`, type your Apple ID, click **Start**, enter password/2FA code.
4. On the iPhone: **Settings → General → VPN & Device Management → your Apple ID → Trust**.
5. iOS 16+: also turn on **Settings → Privacy & Security → Developer Mode** (phone restarts).

Free Apple ID limits: the app stops opening after **7 days** — plug in and click Start in Sideloadly again
(don't delete the app first, so your settings stay). Max 3 sideloaded apps at once. A paid Apple Developer
account ($99/year) makes it last a year and is needed to share the app with other people (TestFlight /
App Store), which you can also do from Windows using Codemagic.

### Option B — on a Mac (Xcode 15 or later)

```bash
brew install xcodegen
cd ios && xcodegen generate && open LidarBrowser.xcodeproj
```
1. Select the **LidarBrowser** target → Signing & Capabilities → choose your Team.
2. Plug in a LiDAR iPhone or iPad (iPhone 12 Pro or later Pro, iPad Pro 2020 or later) and press **Run**.

**Without XcodeGen:** create an iOS App project in Xcode (SwiftUI, iOS 16). Add every `.swift` file from
`ios/LidarBrowser/`, plus `Resources/lidar-shim.js`, and add the `web` folder as a **folder reference**
(blue folder). Then use `ios/LidarBrowser/Info.plist`.

## Publishing on the App Store

1. Join the Apple Developer Program ($99/year).
2. In App Store Connect, create the app with bundle ID `com.dorkane.lidarbrowser` (or your own).
3. In Xcode: **Product → Archive → Distribute App → App Store Connect**.
4. Test with **TestFlight** (up to 10,000 testers by link), then submit for review.
5. **Review notes:** say that it is a web browser built on Apple's WebKit, and that LiDAR data goes only
   to websites the user explicitly allows, with a visible in-use banner and per-site revocation.
   Include a privacy policy URL that states depth data stays on-device and is passed only to
   user-approved websites.

**Instant access (optional, later):** an *App Clip* would let people open a LiDAR website from a link or QR
code without installing the full app. It needs your own website domain (Associated Domains) and an App Store
Connect setup, so it isn't included yet.

## Developing websites for it without a phone

`tools/shim_test/mock-bridge.js` stands in for the app's native bridge in a desktop browser.
`tools/protocol_test_server.py` streams test data in the app's exact format (a ray-cast synthetic room).
With both you can run the injected script and test `navigator.lidar`, the WebXR implementation, three.js
and the viewer site in Chrome:

```bash
pip install websockets numpy pillow playwright
python3 tools/protocol_test_server.py &          # http://localhost:8080 + test stream
python3 tools/shim_test/run_tests.py             # headless Chrome test of all of the above
```

## Files

```
ios/LidarBrowser/
  LidarBrowserApp.swift   app entry
  BrowserView.swift       SwiftUI: address bar, LiDAR banner, menu
  BrowserModel.swift      navigation state, URL/search handling
  WebContainerView.swift  WKWebView over the live camera; script bridge, permission prompt, downloads, dialogs
  LidarBridge.swift       page commands → ARKit; pushes frames into the page (with back-pressure)
  ARCapture.swift         ARKit session: LiDAR depth, smoothed depth, confidence, camera, pose, planes, mesh
  MessageBuilder.swift    binary message format (PROTOCOL.md)
  PermissionStore.swift   allowed sites
  AppSchemeHandler.swift  serves the built-in pages at lidarbrowser://app/
  SettingsView.swift      Site Permissions
  Resources/lidar-shim.js navigator.lidar + WebXR depth implementation injected into pages
web/                      built-in LiDAR Viewer + examples (also works in Android Chrome via WebXR)
API.md                    how websites use the LiDAR
PROTOCOL.md               data format
tools/                    test server and desktop test harness
```

## Limits

* **Depth data:** ARKit provides a 256×192 depth map fused from the LiDAR and the camera, reliable to about 5 m.
  No app can get raw LiDAR points.
* **Throughput:** depth reaches the page through WebKit's script bridge. Expect up to about 30 depth frames
  per second, and pose at the screen rate (60 fps).
* **Missing WebXR features:** hit-test, anchors and WebXR input events. Pages can use the depth map, or
  `navigator.lidar` planes and mesh, instead.
* **One page at a time:** LiDAR access is limited to the visible, top-level page. It stops when you navigate away.
