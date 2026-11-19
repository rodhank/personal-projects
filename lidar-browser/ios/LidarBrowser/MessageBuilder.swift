import Foundation
import simd

/// Message types of the LiDAR Bridge wire protocol (see PROTOCOL.md).
enum MessageType: UInt8 {
    case frame = 1
    case mesh = 2
    case hello = 3
    case pose = 4
}

/// Builds one binary WebSocket message:
/// "LDR1" | type | 3 reserved bytes | UInt32 LE header length | JSON header (space padded) | 4-byte aligned buffers.
struct MessageBuilder {
    private var header: [String: Any]
    private var payload = Data()
    private var buffers: [[String: Any]] = []

    init(header: [String: Any]) {
        self.header = header
    }

    mutating func setHeader(_ key: String, _ value: Any) {
        header[key] = value
    }

    mutating func addBuffer(_ name: String, _ data: Data) {
        let pad = (4 - payload.count % 4) % 4
        if pad > 0 { payload.append(Data(count: pad)) }
        buffers.append(["name": name, "offset": payload.count, "length": data.count])
        payload.append(data)
    }

    func build(_ type: MessageType) -> Data {
        var h = header
        h["buffers"] = buffers
        var json: Data
        if JSONSerialization.isValidJSONObject(h), let d = try? JSONSerialization.data(withJSONObject: h, options: []) {
            json = d
        } else {
            json = Data("{\"buffers\":[]}".utf8)
        }
        let pad = (4 - (12 + json.count) % 4) % 4
        if pad > 0 { json.append(contentsOf: [UInt8](repeating: 0x20, count: pad)) }

        var out = Data(capacity: 12 + json.count + payload.count)
        out.append(contentsOf: Array("LDR1".utf8))
        out.append(type.rawValue)
        out.append(contentsOf: [0, 0, 0])
        var len = UInt32(json.count).littleEndian
        withUnsafeBytes(of: &len) { out.append(contentsOf: $0) }
        out.append(json)
        out.append(payload)
        return out
    }
}

// MARK: - JSON-safe number helpers (JSONSerialization crashes on NaN / infinity)

@inline(__always) func jnum(_ x: Float) -> Double { x.isFinite ? Double(x) : 0 }
@inline(__always) func jnum(_ x: Double) -> Double { x.isFinite ? x : 0 }
@inline(__always) func jnum(_ x: CGFloat) -> Double { jnum(Double(x)) }

/// Column-major 4x4 matrix as 16 numbers (same layout as WebGL / three.js).
func jmatrix(_ m: simd_float4x4) -> [Double] {
    let c = [m.columns.0, m.columns.1, m.columns.2, m.columns.3]
    var out: [Double] = []
    out.reserveCapacity(16)
    for col in c {
        out.append(jnum(col.x)); out.append(jnum(col.y)); out.append(jnum(col.z)); out.append(jnum(col.w))
    }
    return out
}
