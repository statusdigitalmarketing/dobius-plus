import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

// Talks to the paired Mac's phone server exactly as the app does (docs/phone-share.md): the pairing's own origin and
// bearer token, no cookies, no redirects followed (a token must never follow a redirect to another host).

struct ShareTarget: Decodable, Identifiable, Equatable {
    let id: String
    let label: String
    let project: String
    let claude: Bool
    let status: String
    let lastActivityAt: Double
    let orchestrator: Bool
}

struct TargetsReply: Decodable {
    let ok: Bool
    let mac: String?
    let orchestrator: String?
    let tabs: [ShareTarget]?
    let error: String?
}

struct ShareReply: Decodable {
    let ok: Bool
    let sent: Bool?
    let typed: Bool?
    let label: String?
    let note: String?
    let error: String?
    let reason: String?
}

enum SharePayload {
    case image(Data, preview: UIImage)
    case text(String)
}

enum ShareError: LocalizedError {
    case unreachable(String)
    case refused(String)
    var errorDescription: String? {
        switch self {
        case .unreachable(let s), .refused(let s): return s
        }
    }
}

/// The demo pairing App Review uses (mobile/demo.js): answered here, never sent anywhere.
enum Demo {
    static let origin = "http://demo.dobius:8420"
    static func isDemo(_ p: SharedPairing) -> Bool { p.origin == origin }
    static let targets: [ShareTarget] = [
        ShareTarget(id: "demo-orch", label: "Orchestrator", project: "my-app", claude: true, status: "idle", lastActivityAt: 0, orchestrator: true),
        ShareTarget(id: "demo-login", label: "Fix the login bug", project: "my-app", claude: true, status: "working", lastActivityAt: 0, orchestrator: false),
        ShareTarget(id: "demo-docs", label: "Write the API docs", project: "website", claude: true, status: "idle", lastActivityAt: 0, orchestrator: false),
    ]
}

final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class ShareClient {
    private let session: URLSession

    init() {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpCookieStorage = nil
        cfg.urlCache = nil
        cfg.timeoutIntervalForRequest = 20
        cfg.timeoutIntervalForResource = 60
        cfg.waitsForConnectivity = false
        session = URLSession(configuration: cfg, delegate: NoRedirect(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    private func request(_ pairing: SharedPairing, path: String, query: [URLQueryItem] = []) throws -> URLRequest {
        guard var comps = URLComponents(string: pairing.origin) else { throw ShareError.unreachable("That Mac's address is not valid.") }
        comps.path = path
        comps.queryItems = query.isEmpty ? nil : query
        guard let url = comps.url, url.host == URL(string: pairing.origin)?.host else { throw ShareError.unreachable("That Mac's address is not valid.") }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        req.httpShouldHandleCookies = false
        return req
    }

    private func send(_ req: URLRequest, body: Data? = nil) async throws -> (Data, Int) {
        do {
            let (data, resp): (Data, URLResponse)
            if let body { (data, resp) = try await session.upload(for: req, from: body) }
            else { (data, resp) = try await session.data(for: req) }
            return (data, (resp as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            throw ShareError.unreachable("Could not reach the Mac. Check that Tailscale is on and Dobius+ is running there.")
        }
    }

    func targets(_ pairing: SharedPairing) async throws -> TargetsReply {
        if Demo.isDemo(pairing) { return TargetsReply(ok: true, mac: "Demo Mac", orchestrator: "demo-orch", tabs: Demo.targets, error: nil) }
        var req = try request(pairing, path: "/share/targets")
        req.timeoutInterval = 10
        let (data, status) = try await send(req)
        if status == 401 { throw ShareError.refused("This Mac no longer knows this phone. Open Dobius+ and pair again.") }
        if status == 404 { throw ShareError.refused("Update Dobius+ on the Mac to share from the phone.") }
        guard let reply = try? JSONDecoder().decode(TargetsReply.self, from: data), reply.ok else {
            throw ShareError.unreachable("The Mac did not answer as expected (\(status)).")
        }
        return reply
    }

    func share(_ pairing: SharedPairing, tab: String, payload: SharePayload, note: String, shareId: String) async throws -> ShareReply {
        if Demo.isDemo(pairing) {
            try? await Task.sleep(nanoseconds: 400_000_000)
            return ShareReply(ok: true, sent: true, typed: nil, label: Demo.targets.first { $0.id == tab }?.label, note: nil, error: nil, reason: nil)
        }
        let body: Data
        let kind: String
        switch payload {
        case .image(let d, _): body = d; kind = "image"
        case .text(let t): body = Data(t.utf8); kind = "text"
        }
        var query = [URLQueryItem(name: "kind", value: kind), URLQueryItem(name: "tab", value: tab), URLQueryItem(name: "id", value: shareId)]
        let n = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if !n.isEmpty { query.append(URLQueryItem(name: "note", value: String(n.prefix(2000)))) }
        var req = try request(pairing, path: "/share", query: query)
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 45
        let (data, status) = try await send(req, body: body)
        if status == 401 { throw ShareError.refused("This Mac no longer knows this phone. Open Dobius+ and pair again.") }
        if status == 404, (try? JSONDecoder().decode(ShareReply.self, from: data))?.reason == nil {
            throw ShareError.refused("Update Dobius+ on the Mac to share from the phone.")
        }
        guard let reply = try? JSONDecoder().decode(ShareReply.self, from: data) else {
            throw ShareError.unreachable("The Mac did not answer as expected (\(status)).")
        }
        if !reply.ok { throw ShareError.refused(reply.error ?? "The Mac did not take it.") }
        return reply
    }
}

/// Images are made small before they leave the phone: longest side 2048 px, JPEG 0.85. ImageIO builds the thumbnail
/// straight from the encoded data, so a big photo is never decoded at full size (the extension's memory is limited).
enum ImagePrep {
    static let maxPixels = 2048
    static let maxBytes = 12 * 1024 * 1024

    static func fromData(_ data: Data) -> (Data, UIImage)? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return encode(cg)
    }

    static func fromImage(_ image: UIImage) -> (Data, UIImage)? {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = min(1, CGFloat(maxPixels) / (max(size.width, size.height) * image.scale))
        let target = CGSize(width: floor(size.width * image.scale * scale), height: floor(size.height * image.scale * scale))
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        fmt.opaque = true
        let drawn = UIGraphicsImageRenderer(size: target, format: fmt).image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
        guard let cg = drawn.cgImage else { return nil }
        return encode(cg)
    }

    private static func encode(_ cg: CGImage) -> (Data, UIImage)? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(dest), out.length > 0, out.length <= maxBytes else { return nil }
        return (out as Data, UIImage(cgImage: cg))
    }
}
