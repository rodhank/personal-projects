import Foundation
import UIKit
import WebKit

/// Connects ARKit (ARCapture) to the page in the web view: handles the page's commands
/// (navigator.lidar / WebXR polyfill) and pushes protocol messages into the page.
final class LidarBridge: NSObject {
    let capture = ARCapture()
    weak var webView: WKWebView?

    /// The site currently using the LiDAR (nil when idle). Main thread.
    var onActiveOriginChange: ((String?) -> Void)?
    /// Show / hide the live camera behind the page. Main thread.
    var onCameraVisibleChange: ((Bool) -> Void)?
    /// Ask the user whether `origin` may use the LiDAR. Main thread.
    var askPermission: ((String, @escaping (Bool) -> Void) -> Void)?

    private(set) var activeOrigin: String?
    private var cameraVisible = false
    private var promptOpen = false

    // read on ARKit's queue
    private let streamingLock = NSLock()
    private var _streaming = false
    private var streaming: Bool {
        get { streamingLock.lock(); defer { streamingLock.unlock() }; return _streaming }
        set { streamingLock.lock(); _streaming = newValue; streamingLock.unlock() }
    }

    // back-pressure: never queue more than one frame / pose evaluation in the page
    private var frameInFlight = false
    private var poseInFlight = false

    override init() {
        super.init()
        capture.hasClients = { [weak self] in self?.streaming ?? false }
        capture.onFrame = { [weak self] data in DispatchQueue.main.async { self?.deliver(.frame, data) } }
        capture.onMesh = { [weak self] data in DispatchQueue.main.async { self?.deliver(.mesh, data) } }
        capture.onPose = { [weak self] data in DispatchQueue.main.async { self?.deliver(.pose, data) } }
    }

    var lidarSupported: Bool { ARCapture.supportsSceneDepth }

    // MARK: commands from the page

    func handle(cmd: String, options: [String: Any], frame: WKFrameInfo, reply: @escaping (Any?, String?) -> Void) {
        let securityOrigin = frame.securityOrigin
        let origin = PermissionStore.origin(securityOrigin)
        guard frame.isMainFrame else { reply(nil, "LiDAR is only available to the top-level page"); return }
        guard PermissionStore.isEligible(securityOrigin) else {
            reply(nil, "LiDAR is only available to secure (https) websites"); return
        }

        switch cmd {
        case "requestAccess":
            requestAccess(origin) { granted in reply(granted ? "granted" : "denied", nil) }

        case "start":
            guard lidarSupported else { reply(["ok": false, "error": "This device has no LiDAR scanner"] as [String: Any], nil); return }
            guard PermissionStore.shared.isAllowed(origin) else { reply(["ok": false, "error": "LiDAR access not granted"] as [String: Any], nil); return }
            start(origin: origin, options: options)
            reply(["ok": true, "info": capture.infoDictionary()] as [String: Any], nil)

        case "configure":
            guard activeOrigin == origin else { reply(["ok": false, "error": "LiDAR is not running"] as [String: Any], nil); return }
            capture.updateConfig(options)
            if let cam = options["camera"] as? Bool { setCamera(cam) }
            if (options["mesh"] as? Bool) == true { capture.requestFullMesh() }
            reply(["ok": true], nil)

        case "stop":
            if activeOrigin == origin { stop(notifyPage: false) }
            reply(["ok": true], nil)

        case "resetTracking":
            guard activeOrigin == origin else { reply(["ok": false], nil); return }
            capture.start(reset: true)
            reply(["ok": true], nil)

        case "requestMesh":
            guard activeOrigin == origin else { reply(["ok": false], nil); return }
            capture.requestFullMesh()
            reply(["ok": true], nil)

        default:
            reply(nil, "Unknown command \(cmd)")
        }
    }

    private func requestAccess(_ origin: String, completion: @escaping (Bool) -> Void) {
        if PermissionStore.shared.isAllowed(origin) { completion(true); return }
        guard !promptOpen, let ask = askPermission else { completion(false); return }
        promptOpen = true
        ask(origin) { [weak self] allowed in
            self?.promptOpen = false
            if allowed { PermissionStore.shared.allow(origin) }
            completion(allowed)
        }
    }

    private func start(origin: String, options: [String: Any]) {
        var cfg = StreamConfig()
        // defaults for web pages: depth only, 30 fps
        cfg.fps = 30; cfg.rgb = false; cfg.mesh = false; cfg.planes = true; cfg.smoothed = false; cfg.pose = false
        cfg.apply(options)
        capture.config = cfg
        frameInFlight = false
        poseInFlight = false
        let wasActive = activeOrigin != nil
        activeOrigin = origin
        streaming = true
        if !wasActive { capture.start(reset: false) }
        if cfg.mesh { capture.requestFullMesh() }
        setCamera((options["camera"] as? Bool) ?? false)
        onActiveOriginChange?(origin)
    }

    /// Stops the LiDAR. `notifyPage` tells the page (e.g. when the user taps Stop in the app).
    func stop(notifyPage: Bool) {
        guard activeOrigin != nil else { return }
        streaming = false
        capture.pause()
        activeOrigin = nil
        setCamera(false)
        onActiveOriginChange?(nil)
        if notifyPage {
            webView?.evaluateJavaScript("window.__lidarBrowserStatus && window.__lidarBrowserStatus({running:false, reason:'stopped'})")
        }
    }

    /// Called when the web view starts showing a different page.
    func pageChanged() {
        stop(notifyPage: false)
    }

    /// App returned to the foreground: ARKit was paused by iOS, resume if a page is still using it.
    func resumeIfNeeded() {
        if activeOrigin != nil { capture.start(reset: false) }
    }

    private func setCamera(_ visible: Bool) {
        guard visible != cameraVisible else { return }
        cameraVisible = visible
        onCameraVisibleChange?(visible)
    }

    // MARK: data to the page

    private func deliver(_ type: MessageType, _ data: Data) {
        guard streaming, let webView = webView else { return }
        switch type {
        case .frame:
            if frameInFlight { return }
            frameInFlight = true
        case .pose:
            if poseInFlight { return }
            poseInFlight = true
        default:
            break
        }
        let b64 = data.base64EncodedString()
        webView.callAsyncJavaScript(
            "if (window.__lidarBrowserReceive) window.__lidarBrowserReceive(t, d);",
            arguments: ["t": Int(type.rawValue), "d": b64],
            in: nil,
            in: .page
        ) { [weak self] _ in
            guard let self = self else { return }
            if type == .frame { self.frameInFlight = false }
            if type == .pose { self.poseInFlight = false }
        }
    }
}
