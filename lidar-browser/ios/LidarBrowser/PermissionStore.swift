import Foundation
import WebKit

/// Which websites the user has allowed to use the LiDAR scanner (remembered across launches).
final class PermissionStore: ObservableObject {
    static let shared = PermissionStore()

    @Published private(set) var allowedOrigins: [String] = []
    private let key = "lidar.allowedOrigins"

    private init() {
        allowedOrigins = (UserDefaults.standard.stringArray(forKey: key) ?? []).sorted()
    }

    func isAllowed(_ origin: String) -> Bool {
        origin == PermissionStore.builtInOrigin || allowedOrigins.contains(origin)
    }

    func allow(_ origin: String) {
        guard !allowedOrigins.contains(origin) else { return }
        allowedOrigins = (allowedOrigins + [origin]).sorted()
        save()
    }

    func revoke(_ origin: String) {
        allowedOrigins.removeAll { $0 == origin }
        save()
    }

    func revokeAll() {
        allowedOrigins = []
        save()
    }

    private func save() {
        UserDefaults.standard.set(allowedOrigins, forKey: key)
    }

    // MARK: origins

    static let appScheme = "lidarbrowser"
    static let builtInOrigin = "lidarbrowser://app"

    static func origin(_ o: WKSecurityOrigin) -> String {
        var s = "\(o.protocol)://\(o.host)"
        if o.port != 0 { s += ":\(o.port)" }
        return s
    }

    /// LiDAR is offered to https sites, the app's own pages, and local development servers.
    static func isEligible(_ o: WKSecurityOrigin) -> Bool {
        switch o.protocol {
        case "https", appScheme: return true
        case "http": return o.host == "localhost" || o.host == "127.0.0.1" || o.host.hasSuffix(".local")
        default: return false
        }
    }
}
