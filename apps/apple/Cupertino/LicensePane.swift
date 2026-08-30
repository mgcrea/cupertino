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
/// do next.
///
/// Every sentence here has to be true of *this* build. It said one thing that
/// was not — that compiling the source needs no key — and the gate in
/// `ServerHost` does not care how the binary was produced, so a reader who
/// acted on it would have spent an evening reaching the same refusal. Copy that
/// describes some other build is worse than no copy: it is read at exactly the
/// moment someone is deciding whether to trust the app with their whole disk.
struct LicensePane: View {
  @State private var entry = ""
  @State private var problem: String?
  /// Bumped by anything that changes the answer — a key entered, a key
  /// removed, a trial started. The status block reads `Entitlement.current`
  /// live rather than holding a copy, so what it needs is a reason to rebuild,
  /// not somewhere to store the result. Holding a copy is how the pane and the
  /// gate come to disagree.
  @State private var revision = 0

  var body: some View {
    // The same grouped form as the other three panes. This one is mostly prose
    // rather than controls, which is why the sections carry it in their footers:
    // a footer is where a form puts an explanation, and it keeps the two things
    // somebody came here to *do* — read the status, paste a key — as the only
    // rows in the cards.
    Form {
      Section {
        status
      } footer: {
        footer
      }

      Section {
        editor
      } header: {
        Text("Licence key")
      } footer: {
        Text("Paste your key, or drop the Cupertino.license file anywhere in this window.")
      }
    }
    .formStyle(.grouped)
    .onAppear { entry = LicenseStore.raw ?? "" }
    .onDrop(of: [.fileURL], isTargeted: nil, perform: accept)
  }

  private var status: some View {
    // On a schedule, because one of the three states is a countdown. A pane
    // left open across the end of a trial window has to stop claiming the
    // servers are running — the gate will already have stopped starting them.
    // Fifteen seconds is comfortably inside the minute the label rounds to.
    TimelineView(.periodic(from: .now, by: 15)) { _ in
      // Read once. The badge and the words beside it are two renderings of one
      // answer, and a trial that ended between two reads of
      // `Entitlement.current` would have them contradict each other — a blue
      // clock next to a sentence saying nothing is running.
      let entitlement = Entitlement.current

      HStack(alignment: .top, spacing: 14) {
        badge(for: entitlement)

        VStack(alignment: .leading, spacing: 4) {
          switch entitlement {
          case .licensed(let license):
            Text("Licensed to \(license.email)")
              .foregroundStyle(.green)
            Text(
              "Licence \(license.id) · covers \(license.major).x · issued \(day(license.issuedAt))"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
          case .trial:
            Text("Trial · \(Trial.remainingText)")
              .foregroundStyle(.blue)
            trialExplanation
          case .refused(let reason):
            Text("Unlicensed")
              .foregroundStyle(.orange)
            Text(reason)
              .font(.caption)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
            explanation
            trialOffer
          }
        }
      }
    }
    .id(revision)
    .textSelection(.enabled)
  }

  /// The glyph, alone in a column to the left of everything the state has to
  /// say — rather than inline with the first line, where it used to sit and
  /// where it could never be taller than one line of text.
  ///
  /// Filled, because a filled symbol reads as a state where an outlined one
  /// reads as a control nobody has switched on yet. Fixed width, because a
  /// triangle is narrower than a seal and without it every sentence in the
  /// block shifted sideways the moment a licence expired.
  private func badge(for entitlement: Entitlement) -> some View {
    let (symbol, tint): (String, Color) =
      switch entitlement {
      case .licensed: ("checkmark.seal.fill", .green)
      case .trial: ("clock.fill", .blue)
      case .refused: ("exclamationmark.triangle.fill", .orange)
      }

    return Image(systemName: symbol)
      .font(.system(size: 28))
      .foregroundStyle(tint)
      .frame(width: 32, alignment: .leading)
  }

  /// What a trial is, said where somebody is watching it run.
  ///
  /// The first line is the point of the whole feature: this is not a demo, so
  /// what it proves about this Mac stays true after paying. The second is the
  /// one worth being blunt about — the window really does close, on servers
  /// that are already running, and finding that out from an assistant that
  /// suddenly lost its tools would be a worse way to learn it.
  private var trialExplanation: some View {
    VStack(alignment: .leading, spacing: 3) {
      row("Every surface is running, writes still obey their own switches, and nothing is held back. This is the app, not a demo.")
      row("When the window closes the servers stop, including any your assistant is already connected to. It will report the connection dropped.")
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .padding(.top, 4)
  }

  /// The offer, or the note that it has already been taken.
  ///
  /// The two states carry different messages on purpose, because they are
  /// different questions. Before: does this work on my Mac, which only a
  /// running server can answer. After: is it worth the money, which is what the
  /// refund is for — so that is the sentence at the end of the window rather
  /// than a second pitch for a trial that has already done its job.
  @ViewBuilder
  private var trialOffer: some View {
    if Trial.hasRun {
      VStack(alignment: .leading, spacing: 3) {
        Text("The trial window has closed.")
        Text("Buying comes with thirty days to change your mind, refunded in full, no reason needed.")
          .fixedSize(horizontal: false, vertical: true)
      }
      .font(.caption)
      .foregroundStyle(.secondary)
      .padding(.top, 6)
    } else {
      VStack(alignment: .leading, spacing: 6) {
        Button("Start a \(Int(Trial.duration / 60))-minute trial") {
          Trial.start()
          revision += 1
        }
        .buttonStyle(.glassProminent)
        .controlSize(.small)
        Text("Full function, every surface, no key — enough to see it working against your own \(trialSubject).")
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(.top, 6)
    }
  }

  /// What "unlicensed" costs, in the words someone needs when their assistant
  /// has just failed to start a server.
  private var explanation: some View {
    VStack(alignment: .leading, spacing: 3) {
      row(unavailableLine)
      row("Everything else works: permissions stay granted, your settings are untouched, and no data has moved.")
      row("The write controls are a safety feature, not a paid one. They behave the same either way.")
      row("A key takes effect at once. Nothing needs restarting — the next time your assistant connects, the servers start.")
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .padding(.top, 4)
  }

  /// What the trial is tried against. Falls back when every surface is off,
  /// which is reachable now that switching one off is a thing somebody can do.
  private var trialSubject: String {
    let names = SurfaceSettings.enabledSurfaces
    return names.isEmpty ? "data" : surfaceList.lowercased()
  }

  /// Number agreement, and the empty case, in the one sentence that names them.
  ///
  /// "so Mail are unavailable" was always latent — one surface would have done
  /// it — and switching surfaces off makes both that and the empty list
  /// reachable without shipping a new table.
  private var unavailableLine: String {
    let count = SurfaceSettings.enabledSurfaces.count
    if count == 0 {
      return "Cupertino will not start the MCP servers, so no surface is available to your assistant."
    }
    let verb = count == 1 ? "is" : "are"
    return "Cupertino will not start the MCP servers, so \(surfaceList) \(verb) unavailable to your assistant."
  }

  /// "Mail, Notes, Reminders and Calendar", read off the closed table rather
  /// than typed out. The sentence above is a promise about what stopped, and
  /// the fifth surface is the moment a hardcoded list would start lying.
  private var surfaceList: String {
    // The surfaces that are ON. The sentence above is a promise about what
    // stops, and naming Maps to somebody who has switched Maps off is simply
    // false — the same reason the list is read off the table rather than typed.
    let names = SurfaceSettings.enabledSurfaces.map(\.displayName)
    guard names.count > 1, let last = names.last else { return names.first ?? "" }
    return names.dropLast().joined(separator: ", ") + " and " + last
  }

  private func row(_ text: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text("·")
      Text(text).fixedSize(horizontal: false, vertical: true)
    }
  }

  private var editor: some View {
    VStack(alignment: .leading, spacing: 8) {
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
          revision += 1
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
      "One key covers every \(AppInfo.major).x release and every Mac you own — it is issued to you, "
        + "not to a machine, and nothing counts your installs."
    )
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
    revision += 1
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
