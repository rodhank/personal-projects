import ARKit
import SceneKit
import UIKit
import WebKit

/// The browser surface: a WKWebView over a live AR camera view (shown only when a page asks for it).
/// Handles the JavaScript bridge, permission prompts, popups, JS dialogs and downloads.
final class WebContainerView: UIView {
    let bridge: LidarBridge
    let webView: WKWebView
    private let cameraView = ARSCNView(frame: .zero)
    private let schemeHandler: AppSchemeHandler
    private var downloads: [ObjectIdentifier: URL] = [:]

    override init(frame: CGRect) {
        let bridge = LidarBridge()
        self.bridge = bridge
        let root = Bundle.main.url(forResource: "web", withExtension: nil) ?? Bundle.main.bundleURL
        let handler = AppSchemeHandler(root: root)
        schemeHandler = handler

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.setURLSchemeHandler(handler, forURLScheme: PermissionStore.appScheme)
        config.preferences.javaScriptCanOpenWindowsAutomatically = false

        let ucc = config.userContentController
        let info = bridge.capture.infoDictionary()
        let infoJSON = (try? JSONSerialization.data(withJSONObject: info)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        ucc.addUserScript(WKUserScript(source: "window.__lidarBrowserInfo = \(infoJSON);",
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        if let url = Bundle.main.url(forResource: "lidar-shim", withExtension: "js"),
           let shim = try? String(contentsOf: url, encoding: .utf8) {
            ucc.addUserScript(WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        }

        let web = WKWebView(frame: .zero, configuration: config)
        webView = web
        super.init(frame: frame)

        ucc.addScriptMessageHandler(WeakMessageHandler(self), contentWorld: .page, name: "lidarBrowser")

        backgroundColor = .black
        cameraView.session = bridge.capture.session
        cameraView.automaticallyUpdatesLighting = false
        cameraView.isHidden = true
        addSubview(cameraView)

        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.allowsBackForwardNavigationGestures = true
        webView.navigationDelegate = self
        webView.uiDelegate = self
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        addSubview(webView)

        bridge.webView = webView
        bridge.onCameraVisibleChange = { [weak self] visible in self?.setCameraVisible(visible) }
        bridge.askPermission = { [weak self] origin, done in self?.presentPermissionPrompt(origin: origin, done: done) }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        cameraView.frame = bounds
        webView.frame = bounds
        let orientation = window?.windowScene?.interfaceOrientation ?? .portrait
        bridge.capture.setDisplay(orientation: orientation, viewport: webView.bounds.size)
    }

    private func setCameraVisible(_ visible: Bool) {
        cameraView.isHidden = !visible
        let bg: UIColor = visible ? .clear : .systemBackground
        webView.backgroundColor = bg
        webView.scrollView.backgroundColor = bg
    }

    // MARK: presenting UI

    private var topViewController: UIViewController? {
        var vc = window?.rootViewController
        while let presented = vc?.presentedViewController { vc = presented }
        return vc
    }

    private func presentPermissionPrompt(origin: String, done: @escaping (Bool) -> Void) {
        let host = URL(string: origin)?.host ?? origin
        let alert = UIAlertController(
            title: "Allow “\(host)” to use the LiDAR scanner?",
            message: "The site will receive live depth (3D distance) data from your camera, which can reveal the shape of your surroundings. You can change this later in Site Permissions.",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Don’t Allow", style: .cancel) { _ in done(false) })
        alert.addAction(UIAlertAction(title: "Allow", style: .default) { _ in done(true) })
        guard let top = topViewController else { done(false); return }
        top.present(alert, animated: true)
    }

    private func share(_ url: URL) {
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        vc.popoverPresentationController?.sourceView = self
        vc.popoverPresentationController?.sourceRect = CGRect(x: bounds.midX, y: bounds.midY, width: 1, height: 1)
        topViewController?.present(vc, animated: true)
    }

    // called by the message handler
    fileprivate func receive(_ message: WKScriptMessage, reply: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            reply(nil, "Malformed message"); return
        }
        bridge.handle(cmd: cmd, options: body["options"] as? [String: Any] ?? [:], frame: message.frameInfo, reply: reply)
    }
}

// MARK: - Navigation, downloads

extension WebContainerView: WKNavigationDelegate, WKDownloadDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        bridge.pageChanged()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        bridge.pageChanged()
        webView.reload()
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(suggestedFilename.isEmpty ? "download" : suggestedFilename)
        downloads[ObjectIdentifier(download)] = url
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) { share(url) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
    }
}

// MARK: - Popups and JavaScript dialogs

extension WebContainerView: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // Single-tab browser: open "new window" links in place.
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: frame.request.url?.host, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        if let top = topViewController { top.present(a, animated: true) } else { completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: frame.request.url?.host, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        if let top = topViewController { top.present(a, animated: true) } else { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: frame.request.url?.host, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        if let top = topViewController { top.present(a, animated: true) } else { completionHandler(nil) }
    }
}

// MARK: - Script message handler (weak, to avoid a retain cycle with WKUserContentController)

private final class WeakMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: WebContainerView?
    init(_ target: WebContainerView) { self.target = target }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let target = target else { replyHandler(nil, "Browser unavailable"); return }
        target.receive(message, reply: replyHandler)
    }
}
