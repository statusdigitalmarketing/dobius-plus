import Foundation
import Security

// The paired Macs, as the Share Extension needs them (docs/phone-share.md). The app writes them, the extension reads
// them, through ONE Keychain item in a shared access group (keychain-access-groups in both entitlements files; the
// group's full name comes from Info.plist DobiusKeychainGroup, which the build expands with the team prefix).
// Compiled into both targets.

struct SharedPairing: Codable, Equatable {
    let id: String
    let name: String
    let origin: String
    let token: String
}

struct SharedPairingsDoc: Codable, Equatable {
    var version: Int = 1
    var activeId: String?
    var pairings: [SharedPairing]
}

enum SharedPairings {
    static let service = "com.statusdigital.dobiusplus.share"
    static let account = "pairings"
    static let maxPairings = 20

    static var accessGroup: String? {
        guard let g = Bundle.main.object(forInfoDictionaryKey: "DobiusKeychainGroup") as? String,
              !g.isEmpty, !g.hasPrefix("$(") else { return nil }
        return g
    }

    private static func baseQuery() -> [String: Any]? {
        guard let group = accessGroup else { return nil }
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: group,
        ]
    }

    /// A record the extension may use: an http(s) origin with no path, and a token of the shape every Mac issues.
    static func valid(_ p: SharedPairing) -> Bool {
        guard !p.id.isEmpty, p.id.count <= 128, p.name.count <= 200,
              p.token.count == 64, p.token.allSatisfy({ $0.isHexDigit }),
              let url = URL(string: p.origin), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host != nil,
              url.path.isEmpty || url.path == "/", url.query == nil, url.user == nil else { return false }
        return true
    }

    /// Replaces the stored document. An empty list deletes the item. Returns the Keychain status.
    @discardableResult
    static func save(_ doc: SharedPairingsDoc) -> OSStatus {
        guard let query = baseQuery() else { return errSecMissingEntitlement }
        let kept = Array(doc.pairings.filter(valid).prefix(maxPairings))
        if kept.isEmpty {
            let s = SecItemDelete(query as CFDictionary)
            return s == errSecItemNotFound ? errSecSuccess : s
        }
        let clean = SharedPairingsDoc(version: 1, activeId: kept.contains(where: { $0.id == doc.activeId }) ? doc.activeId : nil, pairings: kept)
        guard let data = try? JSONEncoder().encode(clean) else { return errSecParam }
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add.merge(attrs) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        return status
    }

    /// The stored document, or nil (nothing paired yet, or the Keychain could not be read).
    static func load() -> SharedPairingsDoc? {
        guard var query = baseQuery() else { return nil }
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data,
              data.count < 64 * 1024,
              var doc = try? JSONDecoder().decode(SharedPairingsDoc.self, from: data), doc.version == 1 else { return nil }
        doc.pairings = Array(doc.pairings.filter(valid).prefix(maxPairings))
        return doc
    }
}
