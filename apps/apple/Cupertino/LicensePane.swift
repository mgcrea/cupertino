import AppKit
import SwiftUI
import UniformTypeIdentifiers

enum LicenseLinks {
  /// Where to buy one. A redirect rather than the checkout URL itself, so the
  /// destination can move without shipping a new build — see the website's
  /// `public/_redirects`.
  static let buy = URL(string: "https://cupertino.mgcrea.io/buy")!
}

/// Entering a licence key, seeing what happened to it, and — when there is none
/// — finding out what that actually means.
///
/// A Settings tab rather than a row in the popover: a key is 224 characters that
/// arrive by paste or by drop from a mail client, and both gestures move focus
/// away from a popover, which closes it. The same reason `ActivityView` is a
/// window.
///
/// Most of this pane is explanation, deliberately. Somebody arrives here because
/// their assistant just said "server failed to start", and the useful thing to
/// give them is the whole shape of it: what stopped, what did not, and what to
/// do. The honest note at the bottom is part of that rather than a disclaimer —
/// `apps/apple/LICENSE` §1(c) really does let anyone compile this and run it
/// without a key, and saying so where somebody is deciding whether to pay is the
/// entire positioning: what is sold is a signed build and the work behind it.
struct LicensePane: View {
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
    .padding(20)
    .frame(minWidth: 520, maxWidth: .infinity, minHeight: 400, alignment: .topLeading)
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
        explanation
      }
    }
    .textSelection(.enabled)
  }

  /// What "unlicensed" costs, in the words someone needs when their assistant
  /// has just failed to start a server.
  private var explanation: some View {
    VStack(alignment: .leading, spacing: 3) {
      row("Cupertino will not start the MCP servers, so Mail, Notes, Reminders and Calendar are unavailable to your assistant.")
      row("Everything else works: permissions stay granted, your settings are untouched, and no data has moved.")
      row("The write controls are a safety feature, not a paid one. They behave the same either way.")
      row("Building Cupertino yourself from source needs no key. See the licence in the repository.")
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .padding(.top, 4)
  }

  private func row(_ text: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text("·")
      Text(text).fixedSize(horizontal: false, vertical: true)
    }
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
          .buttonStyle(.glassProminent)
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
        Button("Buy a licence…") { NSWorkspace.shared.open(LicenseLinks.buy) }
          .buttonStyle(.glass)
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
