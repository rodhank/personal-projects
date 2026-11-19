import ARKit
import CoreImage
import Foundation
import ImageIO
import UIKit

/// What the browser asked for. Changed at runtime by {"type":"config"} messages.
struct StreamConfig {
    var fps: Double = 15
    var rgb: Bool = true
    var rgbWidth: Int = 640
    var jpegQuality: Double = 0.6
    var smoothed: Bool = false
    var mesh: Bool = true
    var planes: Bool = true
    /// Lightweight pose messages on every ARKit frame (used by the WebXR polyfill).
    var pose: Bool = false

    var dictionary: [String: Any] {
        ["fps": fps, "rgb": rgb, "rgbWidth": rgbWidth, "jpegQuality": jpegQuality,
         "smoothed": smoothed, "mesh": mesh, "planes": planes, "pose": pose]
    }

    mutating func apply(_ d: [String: Any]) {
        if let v = (d["fps"] as? NSNumber)?.doubleValue { fps = min(60, max(1, v)) }
        if let v = d["rgb"] as? Bool { rgb = v }
        if let v = (d["rgbWidth"] as? NSNumber)?.intValue { rgbWidth = min(1920, max(160, v)) }
        if let v = (d["jpegQuality"] as? NSNumber)?.doubleValue { jpegQuality = min(1, max(0.1, v)) }
        if let v = d["smoothed"] as? Bool { smoothed = v }
        if let v = d["mesh"] as? Bool { mesh = v }
        if let v = d["planes"] as? Bool { planes = v }
        if let v = d["pose"] as? Bool { pose = v }
    }
}

/// Runs ARKit with every LiDAR-related output turned on and encodes frames / mesh updates
/// into protocol messages.
final class ARCapture: NSObject, ARSessionDelegate {
    let session = ARSession()

    /// Called with an encoded frame message (any queue).
    var onFrame: ((Data) -> Void)?
    /// Called with an encoded mesh message (any queue).
    var onMesh: ((Data) -> Void)?
    /// Called with a small pose message on every ARKit frame when `config.pose` is on (any queue).
    var onPose: ((Data) -> Void)?
    /// Returns true when at least one browser is connected (frames are skipped otherwise).
    var hasClients: () -> Bool = { false }
    /// Status text for the native UI.
    var onStatus: ((String) -> Void)?

    // All state below is only touched on `delegateQueue`, except `config` (lock).
    private let delegateQueue = DispatchQueue(label: "lidar.ar.delegate", qos: .userInteractive)
    private let encodeQueue = DispatchQueue(label: "lidar.encode", qos: .userInitiated)
    private let meshQueue = DispatchQueue(label: "lidar.mesh", qos: .utility)
    private let configLock = NSLock()
    private var _config = StreamConfig()

    // Screen orientation + web view size, set from the main thread; used for WebXR view/projection data.
    private let displayLock = NSLock()
    private var displayOrientation: UIInterfaceOrientation = .portrait
    private var displayViewport: CGSize = .zero

    private var frameEncoding = false
    private var lastFrameTime: TimeInterval = 0
    private var seq: Int = 0

    private var dirtyMesh = Set<UUID>()
    private var removedMesh = Set<UUID>()
    private var fullMeshRequested = false
    private var meshEncoding = false
    private var lastMeshTime: TimeInterval = 0

    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

    // MARK: capabilities

    static var supportsSceneDepth: Bool { ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) }
    static var supportsSmoothedDepth: Bool { ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) }
    static var supportsMesh: Bool { ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) }

    var config: StreamConfig {
        get { configLock.lock(); defer { configLock.unlock() }; return _config }
        set { configLock.lock(); _config = newValue; configLock.unlock() }
    }

    func updateConfig(_ d: [String: Any]) {
        configLock.lock()
        _config.apply(d)
        configLock.unlock()
    }

    // MARK: session control

    func start(reset: Bool = false) {
        guard ARWorldTrackingConfiguration.isSupported else {
            onStatus?("ARKit world tracking is not supported on this device")
            return
        }
        let c = ARWorldTrackingConfiguration()
        var semantics: ARConfiguration.FrameSemantics = []
        if ARCapture.supportsSceneDepth { semantics.insert(.sceneDepth) }
        if ARCapture.supportsSmoothedDepth { semantics.insert(.smoothedSceneDepth) }
        c.frameSemantics = semantics
        c.planeDetection = [.horizontal, .vertical]
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification) {
            c.sceneReconstruction = .meshWithClassification
        } else if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
            c.sceneReconstruction = .mesh
        }
        c.isLightEstimationEnabled = true
        c.environmentTexturing = .none

        session.delegate = self
        session.delegateQueue = delegateQueue
        if reset {
            delegateQueue.async {
                self.dirtyMesh.removeAll()
                self.removedMesh.removeAll()
            }
            session.run(c, options: [.resetTracking, .removeExistingAnchors])
        } else {
            session.run(c)
        }
        if !ARCapture.supportsSceneDepth {
            onStatus?("This device has no LiDAR scanner (scene depth unavailable)")
        } else {
            onStatus?("LiDAR running")
        }
    }

    func pause() { session.pause() }

    func setDisplay(orientation: UIInterfaceOrientation, viewport: CGSize) {
        displayLock.lock()
        if orientation != .unknown { displayOrientation = orientation }
        displayViewport = viewport
        displayLock.unlock()
    }

    /// Screen-oriented view transform, projection and depth-buffer mapping for the current viewport.
    private func displayDict(_ frame: ARFrame) -> [String: Any]? {
        displayLock.lock()
        let orientation = displayOrientation
        let size = displayViewport
        displayLock.unlock()
        guard size.width > 1, size.height > 1 else { return nil }
        let cam = frame.camera
        let viewTransform = cam.viewMatrix(for: orientation).inverse
        let projection = cam.projectionMatrix(for: orientation, viewportSize: size, zNear: 0.01, zFar: 1000)
        // displayTransform maps normalised image coords -> normalised view coords; WebXR wants the reverse.
        let t = frame.displayTransform(for: orientation, viewportSize: size).inverted()
        let normDepth: [Double] = [jnum(t.a), jnum(t.b), 0, 0, jnum(t.c), jnum(t.d), 0, 0, 0, 0, 1, 0, jnum(t.tx), jnum(t.ty), 0, 1]
        let viewport: [Double] = [jnum(size.width), jnum(size.height)]
        var d: [String: Any] = [:]
        d["orientation"] = ARCapture.orientationName(orientation)
        d["viewport"] = viewport
        d["viewTransform"] = jmatrix(viewTransform)
        d["projection"] = jmatrix(projection)
        d["normDepthBufferFromNormView"] = normDepth
        return d
    }

    static func orientationName(_ o: UIInterfaceOrientation) -> String {
        switch o {
        case .portrait: return "portrait"
        case .portraitUpsideDown: return "portraitUpsideDown"
        case .landscapeLeft: return "landscapeLeft"
        case .landscapeRight: return "landscapeRight"
        default: return "unknown"
        }
    }

    func requestFullMesh() {
        delegateQueue.async { self.fullMeshRequested = true }
    }

    /// Capabilities, injected into every page as window.__lidarBrowserInfo.
    func infoDictionary() -> [String: Any] {
        var sysinfo = utsname()
        uname(&sysinfo)
        let model = withUnsafePointer(to: &sysinfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
        var d: [String: Any] = [:]
        d["app"] = "LidarBrowser"
        d["version"] = 1
        d["device"] = model
        d["systemVersion"] = UIDevice.current.systemVersion
        d["sceneDepth"] = ARCapture.supportsSceneDepth
        d["smoothedDepth"] = ARCapture.supportsSmoothedDepth
        d["mesh"] = ARCapture.supportsMesh
        return d
    }

    func helloMessage() -> Data {
        var sysinfo = utsname()
        uname(&sysinfo)
        let model = withUnsafePointer(to: &sysinfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
        var header: [String: Any] = [:]
        header["app"] = "LidarBridge"
        header["version"] = 1
        header["device"] = model
        header["systemVersion"] = UIDevice.current.systemVersion
        header["sceneDepth"] = ARCapture.supportsSceneDepth
        header["smoothedDepth"] = ARCapture.supportsSmoothedDepth
        header["mesh"] = ARCapture.supportsMesh
        header["config"] = config.dictionary
        return MessageBuilder(header: header).build(.hello)
    }

    // MARK: ARSessionDelegate

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let cfg = config
        guard hasClients() else { return }
        if cfg.pose { sendPose(frame) }
        sendFrameIfDue(frame, cfg)
        sendMeshIfDue(frame, cfg)
    }

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) { markMesh(anchors) }
    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) { markMesh(anchors) }
    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        for a in anchors where a is ARMeshAnchor {
            dirtyMesh.remove(a.identifier)
            removedMesh.insert(a.identifier)
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        onStatus?("ARKit error: \(error.localizedDescription)")
    }

    func sessionWasInterrupted(_ session: ARSession) { onStatus?("ARKit interrupted") }
    func sessionInterruptionEnded(_ session: ARSession) { onStatus?("LiDAR running") }

    private func markMesh(_ anchors: [ARAnchor]) {
        for a in anchors where a is ARMeshAnchor {
            dirtyMesh.insert(a.identifier)
            removedMesh.remove(a.identifier)
        }
    }

    // MARK: frames

    private func sendFrameIfDue(_ frame: ARFrame, _ cfg: StreamConfig) {
        guard !frameEncoding, frame.timestamp - lastFrameTime >= (1.0 / cfg.fps) - 0.002 else { return }
        let depthSource = (cfg.smoothed ? frame.smoothedSceneDepth : nil) ?? frame.sceneDepth
        guard let depthData = depthSource else { return }
        lastFrameTime = frame.timestamp
        seq += 1

        // Copy depth + confidence now so the ARFrame is not retained.
        let depth = ARCapture.copyPixels(depthData.depthMap, bytesPerPixel: 4)
        let conf = depthData.confidenceMap.map { ARCapture.copyPixels($0, bytesPerPixel: 1) }

        let cam = frame.camera
        let K = cam.intrinsics
        let meshCount: Int = frame.anchors.filter { $0 is ARMeshAnchor }.count
        let usedSmoothed: Bool = cfg.smoothed && frame.smoothedSceneDepth != nil
        let depthInfo: [String: Any] = ["w": depth.w, "h": depth.h, "smoothed": usedSmoothed]
        let imageSize: [Double] = [jnum(cam.imageResolution.width), jnum(cam.imageResolution.height)]
        let intrinsics: [Double] = [jnum(K[0][0]), jnum(K[1][1]), jnum(K[2][0]), jnum(K[2][1])]
        var header: [String: Any] = [:]
        header["seq"] = seq
        header["t"] = jnum(frame.timestamp)
        header["wall"] = jnum(Date().timeIntervalSince1970 * 1000)
        header["tracking"] = ARCapture.trackingString(cam.trackingState)
        header["depth"] = depthInfo
        header["imageSize"] = imageSize
        header["intrinsics"] = intrinsics
        header["transform"] = jmatrix(cam.transform)
        header["meshAnchors"] = meshCount
        if let display = displayDict(frame) { header["display"] = display }
        if let conf = conf { header["confidence"] = ["w": conf.w, "h": conf.h] }
        if let le = frame.lightEstimate {
            let light: [String: Double] = ["ambientIntensity": jnum(le.ambientIntensity),
                                           "colorTemperature": jnum(le.ambientColorTemperature)]
            header["light"] = light
        }
        if cfg.planes {
            header["planes"] = frame.anchors.compactMap { $0 as? ARPlaneAnchor }.map { ARCapture.planeDict($0) }
        }

        let pixelBuffer: CVPixelBuffer? = cfg.rgb ? frame.capturedImage : nil
        let frameHeader = header
        frameEncoding = true
        encodeQueue.async { [weak self] in
            guard let self = self else { return }
            var builder = MessageBuilder(header: frameHeader)
            builder.addBuffer("depth", depth.data)
            if let conf = conf { builder.addBuffer("confidence", conf.data) }
            if let pb = pixelBuffer, let jpeg = self.encodeJPEG(pb, width: cfg.rgbWidth, quality: cfg.jpegQuality) {
                let w = cfg.rgbWidth
                let h = Int((Double(CVPixelBufferGetHeight(pb)) * Double(w) / Double(CVPixelBufferGetWidth(pb))).rounded())
                builder.addRGBHeader(w: w, h: h)
                builder.addBuffer("rgb", jpeg)
            }
            let msg = builder.build(.frame)
            self.onFrame?(msg)
            self.delegateQueue.async { self.frameEncoding = false }
        }
    }

    private func sendPose(_ frame: ARFrame) {
        guard let display = displayDict(frame) else { return }
        var header: [String: Any] = [:]
        header["t"] = jnum(frame.timestamp)
        header["tracking"] = ARCapture.trackingString(frame.camera.trackingState)
        header["transform"] = jmatrix(frame.camera.transform)
        header["display"] = display
        onPose?(MessageBuilder(header: header).build(.pose))
    }

    private func encodeJPEG(_ pb: CVPixelBuffer, width: Int, quality: Double) -> Data? {
        let image = CIImage(cvPixelBuffer: pb)
        let scale = CGFloat(width) / image.extent.width
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let key = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        return ciContext.jpegRepresentation(of: scaled, colorSpace: srgb, options: [key: quality])
    }

    // MARK: mesh

    private func sendMeshIfDue(_ frame: ARFrame, _ cfg: StreamConfig) {
        guard cfg.mesh, !meshEncoding, frame.timestamp - lastMeshTime >= 1.0 else { return }
        guard fullMeshRequested || !dirtyMesh.isEmpty || !removedMesh.isEmpty else { return }
        lastMeshTime = frame.timestamp

        let all = frame.anchors.compactMap { $0 as? ARMeshAnchor }
        let full = fullMeshRequested
        fullMeshRequested = false
        var toSend = full ? all : all.filter { dirtyMesh.contains($0.identifier) }
        // Keep messages a reasonable size; leftovers go out next time.
        let limit = 40
        if toSend.count > limit {
            for a in toSend[limit...] { dirtyMesh.insert(a.identifier) }
            toSend = Array(toSend[..<limit])
        }
        for a in toSend { dirtyMesh.remove(a.identifier) }
        if !full { dirtyMesh.subtract(dirtyMesh.filter { id in !all.contains { $0.identifier == id } }) }
        let removed = removedMesh.map { $0.uuidString }
        removedMesh.removeAll()

        meshEncoding = true
        meshQueue.async { [weak self] in
            guard let self = self else { return }
            let msg = ARCapture.encodeMesh(toSend, removed: removed, full: full)
            self.onMesh?(msg)
            self.delegateQueue.async { self.meshEncoding = false }
        }
    }

    static func encodeMesh(_ anchors: [ARMeshAnchor], removed: [String], full: Bool) -> Data {
        var list: [[String: Any]] = []
        var blobs: [(String, Data)] = []
        for anchor in anchors {
            let g = anchor.geometry
            let id = anchor.identifier.uuidString

            // vertices -> packed Float32 xyz
            let vs = g.vertices
            var vData = Data(count: vs.count * 12)
            let vBase = vs.buffer.contents()
            vData.withUnsafeMutableBytes { raw in
                let dst = raw.bindMemory(to: Float.self)
                for i in 0..<vs.count {
                    let p = vBase.advanced(by: vs.offset + vs.stride * i).assumingMemoryBound(to: Float.self)
                    dst[i * 3] = p[0]; dst[i * 3 + 1] = p[1]; dst[i * 3 + 2] = p[2]
                }
            }

            // faces -> packed UInt32 indices
            let f = g.faces
            let indexCount = f.count * f.indexCountPerPrimitive
            var iData = Data(count: indexCount * 4)
            let fBase = f.buffer.contents()
            iData.withUnsafeMutableBytes { raw in
                let dst = raw.bindMemory(to: UInt32.self)
                if f.bytesPerIndex == 4 {
                    let src = fBase.assumingMemoryBound(to: UInt32.self)
                    for i in 0..<indexCount { dst[i] = src[i] }
                } else if f.bytesPerIndex == 2 {
                    let src = fBase.assumingMemoryBound(to: UInt16.self)
                    for i in 0..<indexCount { dst[i] = UInt32(src[i]) }
                }
            }

            // classification -> UInt8 per face (0 when unavailable)
            var cData = Data(count: f.count)
            if let cls = g.classification {
                let cBase = cls.buffer.contents()
                cData.withUnsafeMutableBytes { raw in
                    let dst = raw.bindMemory(to: UInt8.self)
                    for i in 0..<min(f.count, cls.count) {
                        dst[i] = cBase.advanced(by: cls.offset + cls.stride * i).assumingMemoryBound(to: UInt8.self).pointee
                    }
                }
            }

            var entry: [String: Any] = [:]
            entry["id"] = id
            entry["transform"] = jmatrix(anchor.transform)
            entry["vertexCount"] = vs.count
            entry["faceCount"] = f.count
            list.append(entry)
            blobs.append(("v:" + id, vData))
            blobs.append(("i:" + id, iData))
            blobs.append(("c:" + id, cData))
        }
        var builder = MessageBuilder(header: ["anchors": list, "removed": removed, "full": full])
        for (name, data) in blobs { builder.addBuffer(name, data) }
        return builder.build(.mesh)
    }

    // MARK: helpers

    struct Plane { let data: Data; let w: Int; let h: Int }

    /// Copies a single-plane pixel buffer row by row (rows may be padded).
    static func copyPixels(_ pb: CVPixelBuffer, bytesPerPixel: Int) -> Plane {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        let w = CVPixelBufferGetWidth(pb)
        let h = CVPixelBufferGetHeight(pb)
        let bpr = CVPixelBufferGetBytesPerRow(pb)
        var data = Data(count: w * h * bytesPerPixel)
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return Plane(data: data, w: w, h: h) }
        let rowBytes = w * bytesPerPixel
        data.withUnsafeMutableBytes { raw in
            guard let dst = raw.baseAddress else { return }
            for y in 0..<h {
                memcpy(dst.advanced(by: y * rowBytes), base.advanced(by: y * bpr), rowBytes)
            }
        }
        return Plane(data: data, w: w, h: h)
    }

    static func trackingString(_ s: ARCamera.TrackingState) -> String {
        switch s {
        case .normal: return "normal"
        case .notAvailable: return "notAvailable"
        case .limited(let reason):
            switch reason {
            case .initializing: return "limited:initializing"
            case .excessiveMotion: return "limited:excessiveMotion"
            case .insufficientFeatures: return "limited:insufficientFeatures"
            case .relocalizing: return "limited:relocalizing"
            @unknown default: return "limited:unknown"
            }
        }
    }

    static func planeDict(_ p: ARPlaneAnchor) -> [String: Any] {
        let cls: String
        switch p.classification {
        case .wall: cls = "wall"
        case .floor: cls = "floor"
        case .ceiling: cls = "ceiling"
        case .table: cls = "table"
        case .seat: cls = "seat"
        case .window: cls = "window"
        case .door: cls = "door"
        default: cls = "none"
        }
        let center: [Double] = [jnum(p.center.x), jnum(p.center.y), jnum(p.center.z)]
        let extent: [Double] = [jnum(p.planeExtent.width), jnum(p.planeExtent.height)]
        var d: [String: Any] = [:]
        d["id"] = p.identifier.uuidString
        d["alignment"] = p.alignment == .horizontal ? "horizontal" : "vertical"
        d["classification"] = cls
        d["center"] = center
        d["extent"] = extent
        d["rotationY"] = jnum(p.planeExtent.rotationOnYAxis)
        d["transform"] = jmatrix(p.transform)
        return d
    }
}

extension MessageBuilder {
    /// Records the RGB size in the header (kept separate so the header dictionary stays a plain value).
    mutating func addRGBHeader(w: Int, h: Int) {
        setHeader("rgb", ["w": w, "h": h])
    }
}
