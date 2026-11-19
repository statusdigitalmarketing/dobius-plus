import SwiftUI
import UIKit
import UniformTypeIdentifiers

// The share sheet's "Dobius+" entry (docs/phone-share.md): pick a tab, add a note, Send. One image (downscaled) or
// one text/link per share, one request at a time.

@MainActor
final class ShareModel: ObservableObject {
    enum Phase: Equatable { case loading, ready, sending, sent(String), typed(String), failed(String) }

    @Published var pairings: [SharedPairing] = []
    @Published var pairingId: String?
    @Published var targets: [ShareTarget] = []
    // Changing the tab or the note after a failed Send makes the next Send a new share (a receipt answers only for the
    // exact share it was made for).
    @Published var selected: String? { didSet { if selected != oldValue { shareId = UUID().uuidString } } }
    // Compared as sent (trimmed): a stray space must not turn a retry of the same share into a second paste.
    @Published var note = "" { didSet { if Self.sentNote(note) != Self.sentNote(oldValue) { shareId = UUID().uuidString } } }
    nonisolated static func sentNote(_ s: String) -> String { normalizeNote(s) }
    @Published var payload: SharePayload?
    @Published var payloadProblem: String?
    @Published var payloadNotice: String?
    @Published var listProblem: String?
    @Published var loadingTargets = false
    @Published var phase: Phase = .loading
    @Published var macName = ""

    let client = ShareClient()
    var finish: (Bool) -> Void = { _ in }
    private var shareId = UUID().uuidString
    private var listSeq = 0

    var pairing: SharedPairing? { pairings.first { $0.id == pairingId } }
    var canSend: Bool {
        if case .sending = phase { return false }
        if case .sent = phase { return false }
        if case .typed = phase { return false }
        return payload != nil && selected != nil && pairing != nil
    }

    private static func lastKey(_ id: String) -> String { "lastTab:\(id)" }

    func start(items: [NSExtensionItem]) {
        let doc = SharedPairings.load()
        pairings = doc?.pairings ?? []
        let active = doc?.activeId.flatMap { id in pairings.first { $0.id == id } } ?? pairings.first
        pairingId = active?.id
        Task { await loadPayload(items) }
        if pairing != nil { Task { await loadTargets() } }
        phase = .ready
    }

    func switchMac(_ id: String) {
        guard id != pairingId else { return }
        pairingId = id
        selected = nil
        targets = []
        shareId = UUID().uuidString
        Task { await loadTargets() }
    }

    func loadTargets() async {
        guard let p = pairing else { return }
        listSeq += 1
        let mine = listSeq
        loadingTargets = true
        listProblem = nil
        defer { if mine == listSeq { loadingTargets = false } }
        do {
            let reply = try await client.targets(p)
            guard mine == listSeq, p.id == pairingId else { return }
            targets = reply.tabs ?? []
            macName = p.name.isEmpty ? (reply.mac ?? "") : p.name // the name the user knows it by in the app
            let last = UserDefaults.standard.string(forKey: Self.lastKey(p.id))
            let ids = Set(targets.map(\.id))
            if let s = selected, ids.contains(s) { return }
            if let last, ids.contains(last) { selected = last }
            else if let o = reply.orchestrator, ids.contains(o) { selected = o }
            else { selected = targets.first { $0.claude }?.id ?? targets.first?.id }
            if targets.isEmpty { listProblem = "No tabs are open in Dobius+ on this Mac." }
        } catch {
            guard mine == listSeq else { return }
            listProblem = error.localizedDescription
        }
    }

    private func loadPayload(_ items: [NSExtensionItem]) async {
        let providers = items.flatMap { $0.attachments ?? [] }
        if let p = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }) {
            if let img = await Self.image(from: p) { payload = .image(img.0, preview: img.1) }
            else { payloadProblem = "Could not read that image." }
            return
        }
        if let p = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }),
           let url = await Self.load(p, UTType.url) as? URL {
            payload = .text(url.absoluteString)
            return
        }
        if let p = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) }),
           let text = await Self.load(p, UTType.plainText) as? String, !text.isEmpty {
            let clipped = clipUTF8(text, bytes: 30_000)
            if clipped.count < text.count { payloadNotice = "Long text: only the first \(clipped.count) of \(text.count) characters will be sent." }
            payload = .text(clipped)
            return
        }
        payloadProblem = "Dobius+ can send an image, text or a link."
    }

    /// The image as a FILE: ImageIO reads the size and a thumbnail straight from disk, so a huge image is never loaded
    /// whole into the extension's memory (loadDataRepresentation would copy all of it first). The file lives only for
    /// the duration of the callback, so the work happens there.
    private enum FileImage { case ok(Data, UIImage), unreadable, none }

    private static func thumbnailFromFile(_ p: NSItemProvider) async -> FileImage {
        await withCheckedContinuation { cont in
            _ = p.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
                guard let url else { cont.resume(returning: .none); return }
                if let out = ImagePrep.fromURL(url) { cont.resume(returning: .ok(out.0, out.1)) } else { cont.resume(returning: .unreadable) }
            }
        }
    }

    private static func load(_ p: NSItemProvider, _ type: UTType) async -> NSSecureCoding? {
        await withCheckedContinuation { cont in
            p.loadItem(forTypeIdentifier: type.identifier, options: nil) { item, _ in cont.resume(returning: item) }
        }
    }

    // Encoded bytes first (a file or data: ImageIO thumbnails it without a full decode); a UIImage (the screenshot
    // editor hands one over) is drawn down instead.
    private static func image(from p: NSItemProvider) async -> (Data, UIImage)? {
        switch await thumbnailFromFile(p) {
        case .ok(let d, let img): return (d, img)
        // The file was there and too big or not an image: loading it another way would only pull it into memory.
        case .unreadable: return nil
        case .none: break
        }
        // No file form at all: what is left is an image object (the screenshot editor) or a URL.
        let item = await load(p, UTType.image)
        if let url = item as? URL { return ImagePrep.fromURL(url) }
        // Data the host app already holds in memory: bounded so a huge one is not decoded on top of it.
        if let data = item as? Data, data.count <= ImagePrep.maxSourceBytes { return ImagePrep.fromData(data) }
        if let img = item as? UIImage { return ImagePrep.fromImage(img) }
        return nil
    }

    func send() {
        guard canSend, let cached = pairing, let tab = selected, let payload else { return }
        // Read again: the Mac may have been removed (or re-paired) in Dobius+ while this sheet stayed open.
        guard let p = SharedPairings.load()?.pairings.first(where: { $0.id == cached.id }),
              p.origin == cached.origin, p.token == cached.token else {
            phase = .failed("That Mac is no longer paired in Dobius+. Open Dobius+ to pair it again.")
            return
        }
        phase = .sending
        let id = shareId
        let note = self.note
        Task {
            do {
                let reply = try await client.share(p, tab: tab, payload: payload, note: note, shareId: id)
                UserDefaults.standard.set(tab, forKey: Self.lastKey(p.id))
                let label = reply.label ?? targets.first { $0.id == tab }?.label ?? "the tab"
                if reply.typed == true {
                    // In the prompt but not seen taken: say exactly that and leave the sheet up until Done. Never tell
                    // someone to press Enter when it was already pressed: the box may hold someone else's draft now.
                    phase = .typed(reply.enterPressed == true
                        ? "Enter was pressed in \(label), but Dobius could not confirm Claude took it. Check the tab before sending again."
                        : "It is in \(label)'s prompt but was not sent. Check the tab, then press Enter there if it is still waiting.")
                    return
                }
                phase = .sent("Sent to \(label)")
                try? await Task.sleep(nanoseconds: 900_000_000)
                finish(true)
            } catch {
                // Only a refusal (nothing typed) makes the next Send a fresh share. A lost answer, a busy Mac or an
                // uncertain outcome keeps the id, so the Mac answers a retry with the first result instead of pasting twice.
                if case ShareError.refused = error { shareId = UUID().uuidString }
                phase = .failed(error.localizedDescription)
            }
        }
    }
}

struct ShareView: View {
    @ObservedObject var model: ShareModel

    var body: some View {
        NavigationView {
            Form {
                Section {
                    preview
                    TextField("Add a note (optional)", text: $model.note)
                        .disabled(!editable)
                }
                if model.pairings.count > 1 {
                    Section(header: Text("Mac")) {
                        Picker("Mac", selection: Binding(get: { model.pairingId ?? "" }, set: { model.switchMac($0) })) {
                            ForEach(model.pairings, id: \.id) { Text($0.name).tag($0.id) }
                        }
                        .disabled(!editable)
                    }
                }
                Section(header: Text(model.macName.isEmpty ? "Send to" : "Send to a tab on \(model.macName)"), footer: footer) {
                    targetRows
                }
            }
            .navigationTitle("Dobius+")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { model.finish(false) } }
                ToolbarItem(placement: .confirmationAction) {
                    if case .sending = model.phase { ProgressView() }
                    else if case .typed = model.phase { Button("Done") { model.finish(true) }.font(.body.weight(.semibold)) }
                    else { Button("Send") { model.send() }.font(.body.weight(.semibold)).disabled(!model.canSend) }
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    private var editable: Bool {
        switch model.phase { case .sending, .sent, .typed: return false; default: return true }
    }

    @ViewBuilder private var preview: some View {
        switch model.payload {
        case .image(_, let img):
            Image(uiImage: img).resizable().scaledToFit().frame(maxHeight: 180).frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 8)).accessibilityLabel("Image to send")
        case .text(let t):
            Text(t).font(.callout).lineLimit(4).foregroundColor(.secondary)
            if let n = model.payloadNotice { Text(n).font(.footnote).foregroundColor(.orange) }
        case nil:
            if let p = model.payloadProblem { Text(p).foregroundColor(.red) } else { ProgressView() }
        }
    }

    @ViewBuilder private var targetRows: some View {
        if model.pairing == nil {
            Text("Open Dobius+ and pair with your Mac first.").foregroundColor(.secondary)
        } else if model.loadingTargets && model.targets.isEmpty {
            HStack { ProgressView(); Text("Asking the Mac for its tabs").foregroundColor(.secondary) }
        } else if let problem = model.listProblem, model.targets.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(problem).foregroundColor(.secondary)
                Button("Try again") { Task { await model.loadTargets() } }
            }
        } else {
            ForEach(model.targets) { t in
                Button {
                    if editable { model.selected = t.id }
                } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(t.label.isEmpty ? "Tab" : t.label).foregroundColor(.primary).lineLimit(1)
                                if t.orchestrator {
                                    Text("ORCHESTRATOR").font(.caption2.weight(.bold)).padding(.horizontal, 5).padding(.vertical, 1)
                                        .background(Color.accentColor.opacity(0.15)).foregroundColor(.accentColor).clipShape(Capsule())
                                }
                            }
                            Text(t.claude ? "\(t.project) · \(t.status == "working" ? "working" : "Claude")" : "\(t.project) · no Claude running")
                                .font(.caption).foregroundColor(.secondary).lineLimit(1)
                        }
                        Spacer()
                        if model.selected == t.id { Image(systemName: "checkmark").foregroundColor(.accentColor).font(.body.weight(.semibold)) }
                    }
                    .contentShape(Rectangle())
                }
                .accessibilityAddTraits(model.selected == t.id ? .isSelected : [])
            }
        }
    }

    @ViewBuilder private var footer: some View {
        switch model.phase {
        case .sent(let msg): Label(msg, systemImage: "checkmark.circle.fill").foregroundColor(.green)
        case .typed(let msg): Label(msg, systemImage: "exclamationmark.triangle.fill").foregroundColor(.orange)
        case .failed(let msg): Text(msg).foregroundColor(.red)
        case .sending: Text("Sending…")
        default:
            if case .image = model.payload { Text("Goes into the tab's Claude prompt as an image it can read.") }
            else { EmptyView() }
        }
    }
}

@objc(ShareViewController)
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        model.finish = { [weak self] done in
            guard let ctx = self?.extensionContext else { return }
            if done { ctx.completeRequest(returningItems: nil) }
            else { ctx.cancelRequest(withError: NSError(domain: "com.statusdigital.dobiusplus.share", code: NSUserCancelledError)) }
        }
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
        model.start(items: (extensionContext?.inputItems as? [NSExtensionItem]) ?? [])
    }
}
