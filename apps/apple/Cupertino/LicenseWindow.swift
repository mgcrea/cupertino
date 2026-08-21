import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Identifies the Licence scene to `openWindow`.
enum LicenseWindow {
  static let id = "license"

  /// Where to buy one. A redirect rather than the checkout URL itself, so the
  /// destination can move without shipping a new build — see the website's
  /// `public/_redirects`.
  static let buyURL = URL(string: "https://cupertino.mgcrea.io/buy")!
}

/// Entering a licence key, and seeing what happened to it.
///
/// A window rather than a row in the popover, for the same reason `ActivityView`
/// is one: the menu is 320pt wide and dismisses on focus loss, and a key is 224
/// characters that arrive by paste or by drop from a mail client — precisely the
/// two gestures a popover interrupts.
///
/// The honest note at the bottom is not a disclaimer. `apps/apple/LICENSE` §1(c)
/// really does let anyone compile this and run it without a key, and saying so
/// where somebody is deciding whether to pay is the whole positioning: what is
/// sold is a signed build and the work behind it, never access.
struct LicenseView: View {
  @State private var entry = ""
  @State private var check = LicenseStore.check
  @State private var problem: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      status
      Divider()
      editor
      Divider()
      footer
    }
    .padding(16)
    .frame(minWidth: 520, minHeight: 340)
    .onAppear { entry = LicenseStore.raw ?? "" }
    .onDrop(of: [.fileURL], isTargeted: nil, perform: accept)
  }

  private var status: some View {
    VStack(alignment: .leading, spacing: 4) {
      switch check {
      case .valid(let license):
        Label("Licensed to \(license.email)", systemImage: "checkmark.seal")
          .foregroundStyle(.green)
        Text("Licence \(license.id) · covers \(license.major).x · issued \(day(license.issuedAt))")
          .font(.caption)
          .foregroundStyle(.secondary)
      case .refused(let reason):
        Label("Unlicensed", systemImage: "exclamationmark.triangle")
          .foregroundStyle(.orange)
        Text(reason)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        Text("Servers will not start until a key is entered. Nothing else is affected.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .textSelection(.enabled)
  }

  private var editor: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Paste your key, or drop the Cupertino.license file anywhere in this window.")
        .font(.caption)
        .foregroundStyle(.secondary)

      TextEditor(text: $entry)
        .font(.system(.caption, design: .monospaced))
        .frame(height: 92)
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))

      if let problem {
        Text(problem)
          .font(.caption)
          .foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      }

      HStack {
        Button("Use this key") { apply(entry) }
          .keyboardShortcut(.defaultAction)
          .disabled(entry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        Button("Remove") {
          LicenseStore.clear()
          entry = ""
          problem = nil
          check = LicenseStore.check
        }
        .disabled(LicenseStore.raw == nil)
        Spacer()
        Button("Buy a licence…") { NSWorkspace.shared.open(LicenseWindow.buyURL) }
      }
      .controlSize(.small)
    }
  }

  private var footer: some View {
    Text(
      "Building Cupertino yourself from the public source needs no key and no fee. "
        + "A licence pays for the signed, notarized build and the work of keeping it working."
    )
    .font(.caption)
    .foregroundStyle(.secondary)
    .fixedSize(horizontal: false, vertical: true)
  }

  /// Store it, or say why not. Refusing to persist a bad key is what stops the
  /// field and the status line disagreeing about what is installed.
  private func apply(_ text: String) {
    switch LicenseStore.store(text) {
    case .valid:
      problem = nil
      entry = LicenseStore.raw ?? ""
    case .refused(let reason):
      problem = reason
    }
    check = LicenseStore.check
  }

  private func accept(_ providers: [NSItemProvider]) -> Bool {
    guard let provider = providers.first else { return false }
    provider.loadDataRepresentation(forTypeIdentifier: UTType.fileURL.identifier) { data, _ in
      guard
        let data,
        let url = URL(dataRepresentation: data, relativeTo: nil),
        let text = try? String(contentsOf: url, encoding: .utf8)
      else { return }
      Task { @MainActor in
        entry = text.trimmingCharacters(in: .whitespacesAndNewlines)
        apply(entry)
      }
    }
    return true
  }

  /// The date half of an ISO timestamp. The clock time is noise on a receipt.
  private func day(_ issuedAt: String) -> String {
    String(issuedAt.prefix(10))
  }
}
