import Combine
import Foundation
import UIKit
import WebKit

/// State behind the browser UI (address bar, navigation buttons, LiDAR status).
struct PageLink: Identifiable {
    let title: String
    let url: URL
    var id: String { title }
}

final class BrowserModel: ObservableObject {
    static let homeURL = URL(string: "lidarbrowser://app/index.html")!
    static let examples: [PageLink] = [
        PageLink(title: "LiDAR Viewer (home)", url: homeURL),
        PageLink(title: "Example: WebXR depth", url: URL(string: "lidarbrowser://app/examples/webxr-depth.html")!),
        PageLink(title: "Example: three.js AR", url: URL(string: "lidarbrowser://app/examples/three-ar.html")!),
    ]

    let container = WebContainerView(frame: .zero)

    @Published var addressText = ""
    @Published var isEditingAddress = false
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var isLoading = false
    @Published private(set) var progress: Double = 0
    @Published private(set) var lidarOrigin: String? = nil
    @Published var showSettings = false

    private var observations: [NSKeyValueObservation] = []

    var webView: WKWebView { container.webView }

    init() {
        let wv = container.webView
        observations = [
            wv.observe(\.url, options: [.initial, .new]) { [weak self] wv, _ in
                DispatchQueue.main.async { self?.syncAddress(wv.url) }
            },
            wv.observe(\.canGoBack, options: [.initial, .new]) { [weak self] wv, _ in
                DispatchQueue.main.async { self?.canGoBack = wv.canGoBack }
            },
            wv.observe(\.canGoForward, options: [.initial, .new]) { [weak self] wv, _ in
                DispatchQueue.main.async { self?.canGoForward = wv.canGoForward }
            },
            wv.observe(\.isLoading, options: [.initial, .new]) { [weak self] wv, _ in
                DispatchQueue.main.async { self?.isLoading = wv.isLoading }
            },
            wv.observe(\.estimatedProgress, options: [.initial, .new]) { [weak self] wv, _ in
                DispatchQueue.main.async { self?.progress = wv.estimatedProgress }
            },
        ]
        container.bridge.onActiveOriginChange = { [weak self] origin in self?.lidarOrigin = origin }
        wv.load(URLRequest(url: BrowserModel.homeURL))
    }

    private func syncAddress(_ url: URL?) {
        guard !isEditingAddress else { return }
        guard let url = url else { addressText = ""; return }
        addressText = url.scheme == PermissionStore.appScheme ? "" : url.absoluteString
    }

    /// Loads what the user typed: a URL, a bare domain, or a web search.
    func go() {
        let text = addressText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        load(BrowserModel.url(from: text))
    }

    func load(_ url: URL) {
        webView.load(URLRequest(url: url))
    }

    static func url(from text: String) -> URL {
        if let u = URL(string: text), let scheme = u.scheme?.lowercased(),
           ["http", "https", PermissionStore.appScheme].contains(scheme), u.host != nil {
            return u
        }
        if !text.contains(" "), text.contains("."), let u = URL(string: "https://" + text), u.host != nil {
            return u
        }
        if text.hasPrefix("localhost") || text.hasPrefix("127.0.0.1"), let u = URL(string: "http://" + text) {
            return u
        }
        var c = URLComponents(string: "https://duckduckgo.com/")!
        c.queryItems = [URLQueryItem(name: "q", value: text)]
        return c.url!
    }

    func back() { webView.goBack() }
    func forward() { webView.goForward() }
    func reloadOrStop() { isLoading ? webView.stopLoading() : webView.reload() }
    func home() { load(BrowserModel.homeURL) }
    func stopLidar() { container.bridge.stop(notifyPage: true) }
    func appBecameActive() { container.bridge.resumeIfNeeded() }

    var lidarHost: String? {
        guard let o = lidarOrigin else { return nil }
        if o == PermissionStore.builtInOrigin { return "LiDAR Viewer" }
        return URL(string: o)?.host ?? o
    }
}
