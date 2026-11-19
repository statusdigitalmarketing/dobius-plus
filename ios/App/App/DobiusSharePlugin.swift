import Capacitor
import Foundation

// The in-app half of the share sheet (docs/phone-share.md): the phone UI hands over its paired Macs whenever the
// pairing document changes (mobile/share-mirror.js) and this writes them where the Share Extension can read them.
@objc(DobiusSharePlugin)
public class DobiusSharePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DobiusSharePlugin"
    public let jsName = "DobiusShare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setPairings", returnType: CAPPluginReturnPromise),
    ]

    @objc func setPairings(_ call: CAPPluginCall) {
        let raw = call.getArray("pairings", JSObject.self) ?? []
        var list: [SharedPairing] = []
        for item in raw.prefix(SharedPairings.maxPairings) {
            guard let id = item["id"] as? String, let origin = item["origin"] as? String,
                  let token = item["token"] as? String else { continue }
            list.append(SharedPairing(id: id, name: (item["name"] as? String) ?? "", origin: origin, token: token))
        }
        let status = SharedPairings.save(SharedPairingsDoc(activeId: call.getString("activeId"), pairings: list))
        if status == errSecSuccess {
            call.resolve(["saved": list.filter(SharedPairings.valid).count])
        } else {
            call.reject("Keychain error \(status)", String(status))
        }
    }
}

// Capacitor 8 registers app-local plugins from the bridge view controller.
class DobiusBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(DobiusSharePlugin())
    }
}
