import AppKit
import SwiftUI

/// One MCP client, and the file Cupertino writes into.
///
/// This was seven rows in a Settings form, each with a name, a glyph and one
/// button. As a detail pane it can afford the thing a form row could only
/// summarise: exactly which entries would be written, under which keys, pointing
/// at which copy of the app, and what is sitting under those keys right now.
/// The whole feature writes into files somebody else owns — `~/.claude.json` on
/// the machine this was written against holds twelve global servers and
/// ninety-eight project blocks — so the pane's job is as much reassurance as
/// action.
///
/// It also reports on the part of the file Cupertino does **not** write. A
/// config still holding hand-configured Apple servers is one where those servers
/// run under whoever launched the client rather than under this app's grants,
/// carry no write gate, and put no line in the log — and this is the only screen
/// in the app with the file open.
///
/// Modelled on Bastion's `ClientDetail`, which solves the same problem one repo
/// over. What is different here is the shape of an entry: Cupertino writes a
/// bridge command and no URL, so there is no transport to choose and no token to
/// explain.
struct ClientDetail: View {
  let client: ClientWiring.Client
  /// Read for its invalidation, not for its answers — see `read()`.
  let model: StatusModel

  @State private var result: String?
  /// The keys a refused Configure named. Non-empty is the alert being up.
  @State private var collision: [String] = []
  /// The foreign entry whose removal is waiting to be confirmed.
  @State private var pending: Removal?
  /// Narrows the project list. Claude Code has ninety-eight folders in it.
  @State private var projectFilter = ""

  /// One entry Cupertino would write — or one it wrote and no longer would — and
  /// what is under its key right now.
  private struct Row: Identifiable {
    let surface: Surface
    let key: String
    let state: ClientWiringMerge.EntryState
    /// The surface is switched off in Cupertino. The entry is in the file and
    /// points at the right bridge, so it audits as fine; the server it names is
    /// never started. Kept out of what Configure writes.
    var isOff = false
    /// The CLIENT has switched this entry off — `enabled = false`, a key only
    /// Codex has.
    ///
    /// Not an `EntryState` case: adding it would make six JSON clients carry a
    /// state describing something their files cannot say. It is the same blind
    /// spot as a client silently dropping a config, except visible, because the
    /// fact is written in the file rather than decided quietly at load. The
    /// ChatGPT app is reported to set it on servers it did not expect.
    var isDisabled = false

    var id: String { surface.id }
  }

  /// Which entry a Remove button names, and where it lives.
  private struct Removal {
    let key: String
    /// A Claude Code project folder, or nil for the user scope.
    let folder: String?
  }

  /// Everything this pane knows about the config, from one read of it.
  private struct Snapshot {
    var status: ClientWiring.Status
    var rows: [Row]
    var others: [ClientWiringMerge.ForeignEntry]
    var projects: [(folder: String, entries: [ClientWiringMerge.ForeignEntry])]
    var hasOurEntries: Bool
  }

  /// Rebuilt on every redraw rather than cached. The file belongs to another
  /// application that may have rewritten it a second ago, so a remembered status
  /// is a claim about a file this app does not own and did not watch.
  ///
  /// One read, though. The status, the per-entry badges, the other servers and
  /// "is there anything of ours to remove" are four questions about one file, and
  /// four independent reads of it are four answers free to disagree.
  private func read() -> Snapshot {
    // Two load-bearing reads, neither of them for its value.
    //
    // The revision subscribes this pane to Cupertino's own writes to the file.
    // `model.clients` subscribes it to the app's own inputs changing: what gets
    // written is `SurfaceSettings.enabledSurfaces`, which is a `UserDefaults`
    // read and does not publish, and every switch that moves it calls
    // `model.refresh()`. Without the second, turning a surface off leaves this
    // pane listing it until something else invalidates the view.
    //
    // The status is still computed below, from the file, on every pass. What is
    // observed here is "something changed", never "here is the answer".
    _ = ClientConfigRevision.shared.value
    _ = model.clients

    let enabled = SurfaceSettings.enabledSurfaces

    // What the rows say when there is no file to compare them against. Not an
    // empty list: "here is what would be written" is the useful answer for a
    // client that has never been configured.
    func unread(_ status: ClientWiring.Status) -> Snapshot {
      Snapshot(
        status: status,
        rows: enabled.map {
          Row(surface: $0, key: ClientWiring.serverKey(for: $0), state: .missing)
        },
        others: [], projects: [], hasOurEntries: false)
    }

    guard client.isInstalled else { return unread(.notInstalled) }
    let config: ClientWiring.Config?
    do {
      config = try ClientWiring.read(client)
    } catch {
      return unread(.unreadable(error.localizedDescription))
    }
    guard let config else { return unread(.notConfigured) }

    let servers = config.servers
    var rows = enabled.map { surface in
      let key = ClientWiring.serverKey(for: surface)
      return Row(
        surface: surface, key: key,
        state: ClientWiringMerge.state(
          of: servers, key: key, expectedCommand: ClientWiring.bridgePath),
        isDisabled: config.disabled.contains(key))
    }
    // A switched-off surface earns a row only for an entry of ours that is
    // really in this file — the one thing about it worth showing, since the
    // server it names will not start. Not for an absence, which would be a row
    // promising a write Configure will not make.
    for surface in Surface.all where !SurfaceSettings.isEnabled(surface) {
      // Both spellings, because a config written before the rename holds the
      // old one and it is exactly as stale. `audit` only reports `.extra` for
      // the current key; a row can afford to name the key it actually found.
      let candidates = [
        ClientWiring.serverKey(for: surface), ClientWiring.legacyServerKey(for: surface),
      ]
      guard let key = candidates.first(where: { ClientWiringMerge.isOurs(servers[$0]) })
      else { continue }
      rows.append(
        Row(
          surface: surface, key: key,
          state: ClientWiringMerge.state(
            of: servers, key: key, expectedCommand: ClientWiring.bridgePath),
          isOff: true))
    }

    return Snapshot(
      // The same file the rows were read from, reduced by the same function
      // `status(of:)` uses. The header sentence and the badges cannot disagree,
      // because there is one computation and one read behind both.
      status: ClientWiring.audit(servers: servers),
      rows: rows,
      others: ClientWiringMerge.foreignEntries(in: servers),
      // Claude Code's alone. A `projects` key in anybody else's config is not an
      // MCP scope, and a card drawn from one would be describing servers the
      // file does not hold.
      projects: ClientWiring.hasLocalScope(client)
        ? ClientWiringMerge.foreignLocalScopeEntries(in: config.root) : [],
      // Including an entry for a surface this build has never heard of, which is
      // exactly the case worth being able to clean up.
      hasOurEntries: servers.values.contains { ClientWiringMerge.isOurs($0) })
  }

  var body: some View {
    let snapshot = read()

    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        header(snapshot)
        fileCard
        entriesCard(snapshot)
        if !snapshot.others.isEmpty { othersCard(snapshot) }
        if ClientWiring.hasLocalScope(client) { ProjectFoldersCard() }
        if !snapshot.projects.isEmpty { projectsCard(snapshot) }
        if let result {
          Text(result)
            .font(.caption).foregroundStyle(.secondary)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(20)
    }
    .alert(
      removalTitle,
      isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } })
    ) {
      Button("Cancel", role: .cancel) {}
      Button("Remove", role: .destructive) { if let pending { remove(pending) } }
    } message: {
      Text(removalMessage)
    }
    .alert(
      collisionTitle,
      isPresented: Binding(get: { !collision.isEmpty }, set: { if !$0 { collision = [] } })
    ) {
      Button("Cancel", role: .cancel) {}
      Button("Overwrite anyway", role: .destructive) { configure(force: true) }
    } message: {
      Text(collisionMessage)
    }
  }

  // MARK: - Header

  private func header(_ snapshot: Snapshot) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        ClientIconView(client: client, size: 28)
        Text(client.displayName).font(.title2).bold()
      }

      HStack(spacing: 8) {
        Circle()
          .fill(StatusStyle.clientTint(snapshot.status))
          .frame(width: 8, height: 8)
        Text(snapshot.status.summary).font(.callout)
        Spacer()
      }
      .fixedSize(horizontal: false, vertical: true)

      HStack(spacing: 8) {
        Button(configureLabel(snapshot.status)) { configure() }
          .disabled(!client.isInstalled)
          // Named, because it is no longer the only Remove on this screen: every
          // foreign entry below carries one that takes out exactly that entry.
          // Offered only when there is something of ours to take out — a Remove
          // that rewrites somebody's config to make no change is a write for
          // nothing.
        Button("Remove Cupertino's entries") { unwire() }
          .disabled(!snapshot.hasOurEntries)
        Button("Reveal in Finder") { ClientWiring.reveal(client) }
        Spacer()
      }
    }
  }

  /// The same three verbs the Settings row used, for the same reasons: an
  /// existing config that is missing a surface, points at a previous build or
  /// holds a leftover is finished by one write, and calling that "Configure"
  /// implied there was nothing there yet.
  private func configureLabel(_ status: ClientWiring.Status) -> String {
    switch status {
    case .stale, .incomplete, .extra: "Update"
    case .configured: "Rewrite"
    default: "Configure"
    }
  }

  // MARK: - The file

  private var fileCard: some View {
    Card("Config file") {
      // The path, always. Someone about to let an app write to a config is owed
      // the name of the file.
      Text(ClientWiring.configFile(of: client).path.path)
        .font(.system(.caption, design: .monospaced))
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)

      Text(
        "Cupertino writes only the entries below, under the '\(rootKey)' key. Everything else in "
          + "the file is left alone, and the previous version is saved beside it as \(backupName) "
          + "first.")
        .font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var rootKey: String { ClientWiring.configFile(of: client).rootKey }

  private var backupName: String {
    ClientWiring.configFile(of: client).path.lastPathComponent + ".cupertino-backup"
  }

  // MARK: - What gets written

  private func entriesCard(_ snapshot: Snapshot) -> some View {
    Card("Entries") {
      if snapshot.rows.isEmpty {
        // Every surface switched off. The file is not the problem, and Configure
        // has nothing to put in it.
        Text("Every surface is switched off. Nothing to write.")
          .font(.callout).foregroundStyle(.secondary)
      } else {
        ForEach(snapshot.rows) { row in
          entryRow(row)
          if row.id != snapshot.rows.last?.id { Divider() }
        }
        Divider()
        // The sentence that makes writing another app's config defensible at
        // all. Cupertino's entry is a path and a surface name; the permissions
        // it spends are this app's, granted once, and revocable in System
        // Settings.
        Text(
          "Each entry names the bridge inside this app and one surface. No credential, no token "
            + "and no permission is written into the file.")
          .font(.caption).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func entryRow(_ row: Row) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        SurfaceIconView(surface: row.surface)
        Text(row.key)
          .font(.system(.caption, design: .monospaced)).bold()
          .textSelection(.enabled)
        Spacer(minLength: 8)
        // No wiring badge for a switched-off surface. Every one of them would be
        // a claim about the wiring, and the wiring is not what is wrong: the
        // entry is right and the server behind it is not running.
        if row.isOff {
          Badge("surface off", tint: .secondary)
        } else {
          stateBadge(row.state)
        }
      }
      Text(reachLine(for: row.surface))
        .font(.system(.caption2, design: .monospaced))
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
      // Only the states with something to add. "configured" and "not written"
      // are fully said by the badge, and a sentence repeating a badge is noise
      // on a pane that already has a lot to say.
      switch row.state {
      case .stale(let found):
        Text("Points at \(found) right now. \(row.isOff ? "Switching the surface back on and updating rewrites it." : "Update rewrites it.")")
          .font(.caption2)
          .foregroundStyle(row.isOff ? AnyShapeStyle(.secondary) : AnyShapeStyle(.red))
          .fixedSize(horizontal: false, vertical: true)
      case .foreign(let what):
        Text(
          "Already taken by \(what ?? "an entry Cupertino did not write"). Configure refuses "
            + "rather than replacing it.")
          .font(.caption2).foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      case .matches, .missing:
        EmptyView()
      }
      // The blind spot this pane CAN see. The entry still points where it should,
      // so it audits as configured while the client runs none of it — but unlike
      // a silently dropped config, the fact is a key in the file.
      if row.isDisabled, !row.isOff {
        Text(
          "\(client.displayName) has this entry switched off. Configure rewrites the block "
            + "without it, which turns it back on.")
          .font(.caption2).foregroundStyle(.orange)
          .fixedSize(horizontal: false, vertical: true)
      }
      if row.isOff {
        Text(
          "\(row.surface.displayName) is switched off, so this server is never started. Update "
            + "takes the entry out.")
          .font(.caption2).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    // Dimmed the way the sidebar dims a switched-off surface, so the two screens
    // say the same thing about it without either having to explain the other.
    .opacity(row.isOff ? 0.55 : 1)
  }

  /// The per-entry counterpart to the header dot, in the same colours, so a row
  /// and the sidebar never describe the same file differently.
  @ViewBuilder
  private func stateBadge(_ state: ClientWiringMerge.EntryState) -> some View {
    switch state {
    case .matches: Badge("configured", tint: .green)
    case .missing: Badge("not written", tint: .secondary)
    case .stale: Badge("points elsewhere", tint: .red)
    case .foreign: Badge("taken", tint: .red)
    }
  }

  private func reachLine(for surface: Surface) -> String {
    "\(ClientWiring.bridgePath) --server=\(surface.id)"
  }

  // MARK: - What Cupertino did not write

  /// The servers in this file that go around Cupertino.
  ///
  /// The point of the app, stated against somebody's actual config: these are
  /// the ones the client starts itself, under whatever grants the client happens
  /// to hold, with no write gate and no line in the log. Removing one is the last
  /// step of moving it over, so the button is here rather than in that client's
  /// own settings screen.
  private func othersCard(_ snapshot: Snapshot) -> some View {
    // What Configure would write, so a foreign entry is only flagged as being in
    // the way of a key something is actually going to claim.
    let wanted = Set(SurfaceSettings.enabledSurfaces.map { ClientWiring.serverKey(for: $0) })
    let count = snapshot.others.count

    return Card("Other servers in this file (\(count))") {
      Text(
        "\(client.displayName) starts \(count == 1 ? "this one" : "these") itself. "
          + "\(count == 1 ? "It runs" : "They run") outside Cupertino, so nothing "
          + "\(count == 1 ? "it does" : "they do") is gated by the write switches or reaches the "
          + "log. Remove one once the same job is being done through Cupertino.")
        .font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      ForEach(snapshot.others, id: \.key) { entry in
        Divider()
        foreignRow(entry, folder: nil, colliding: wanted.contains(entry.key))
      }
    }
  }

  /// The same question asked of Claude Code's per-folder blocks.
  ///
  /// Its own card rather than more rows above, because these are a different
  /// scope with a different remedy: a project server is wired for one folder and
  /// invisible everywhere else, which is exactly why they accumulate. Scrolling,
  /// and filterable, because there can be a hundred folders.
  private func projectsCard(_ snapshot: Snapshot) -> some View {
    let folders = snapshot.projects.count
    let servers = snapshot.projects.reduce(0) { $0 + $1.entries.count }
    let shown = filtered(snapshot.projects)

    return Card(
      "Other servers per folder (\(servers) across \(folders) folder\(folders == 1 ? "" : "s"))"
    ) {
      Text(
        "\(client.displayName) also keeps servers per project folder. These go around Cupertino "
          + "the same way, and only apply inside the folder they are filed under.")
        .font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      // Only once there are enough folders for scrolling to be worse than
      // typing. Below that the field is a control with nothing to do.
      if folders > 6 {
        TextField("Filter by folder or server", text: $projectFilter)
          .textFieldStyle(.roundedBorder)
          .controlSize(.small)
      }

      if shown.isEmpty {
        Text("No folder matches \u{201C}\(projectFilter)\u{201D}.")
          .font(.caption).foregroundStyle(.secondary)
      } else {
        // A nested scroller, with a ceiling. Ninety-eight folders inline would
        // push the rest of the pane — including the result line these buttons
        // write to — permanently off the bottom of the window.
        ScrollView {
          VStack(alignment: .leading, spacing: 12) {
            ForEach(shown, id: \.folder) { group in
              VStack(alignment: .leading, spacing: 6) {
                Text(abbreviate(group.folder))
                  .font(.caption).bold()
                  .foregroundStyle(.secondary)
                  .lineLimit(1).truncationMode(.head)
                  .textSelection(.enabled)
                ForEach(group.entries, id: \.key) { entry in
                  foreignRow(entry, folder: group.folder, colliding: false)
                }
              }
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 240)
      }
    }
  }

  private func filtered(
    _ groups: [(folder: String, entries: [ClientWiringMerge.ForeignEntry])]
  ) -> [(folder: String, entries: [ClientWiringMerge.ForeignEntry])] {
    let needle = projectFilter.trimmingCharacters(in: .whitespaces)
    guard !needle.isEmpty else { return groups }
    return groups.filter { group in
      group.folder.localizedCaseInsensitiveContains(needle)
        || group.entries.contains { $0.key.localizedCaseInsensitiveContains(needle) }
    }
  }

  private func foreignRow(
    _ entry: ClientWiringMerge.ForeignEntry,
    folder: String?,
    colliding: Bool
  ) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(entry.key)
          .font(.system(.caption, design: .monospaced)).bold()
          .textSelection(.enabled)
        // Truncated in the middle: an `npx` line's useful half is the package at
        // the end, and a URL's is the host at the start.
        Text(entry.identity ?? "no command or url in this entry")
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(.secondary)
          .lineLimit(2).truncationMode(.middle)
          .textSelection(.enabled)
        if colliding {
          Text("This is the entry standing in the way of Cupertino's own \u{2018}\(entry.key)\u{2019}.")
            .font(.caption2).foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 8)
      Button("Remove…") { pending = Removal(key: entry.key, folder: folder) }
        .controlSize(.small)
    }
  }

  /// `/Users/olivier/Projects/…` as `~/Projects/…`. These paths are long enough
  /// that the home prefix is the least useful part of every one of them.
  private func abbreviate(_ path: String) -> String {
    (path as NSString).abbreviatingWithTildeInPath
  }

  // MARK: - The refusal

  private var collisionTitle: String {
    let what = collision.count == 1 ? "an entry" : "\(collision.count) entries"
    return "Overwrite \(what) in \(ClientWiring.configFile(of: client).path.lastPathComponent)?"
  }

  /// Written out rather than inlined into the alert: it names what is about to
  /// be destroyed, which is the one sentence in this pane worth being sure of.
  private var collisionMessage: String {
    let one = collision.count == 1
    let names = collision.joined(separator: ", ")
    return
      "\(names) \(one ? "was" : "were") not written by Cupertino. Overwriting replaces "
      + "\(one ? "that server" : "those servers") with Cupertino's own. The previous file is kept "
      + "as \(backupName)."
  }

  // MARK: - The removal

  private var removalTitle: String {
    "Remove \u{2018}\(pending?.key ?? "")\u{2019} from \(ClientWiring.configFile(of: client).path.lastPathComponent)?"
  }

  /// Names the one key, where it lives, and what survives. The same care the
  /// collision alert takes, for the same reason: this writes somebody else's
  /// file, and this time it takes something out of it.
  private var removalMessage: String {
    guard let pending else { return "" }
    let scope =
      pending.folder.map { "the block for \(abbreviate($0))" } ?? "the \u{2018}\(rootKey)\u{2019} key"
    return
      "\u{2018}\(pending.key)\u{2019} is taken out of \(scope) in "
      + "\(ClientWiring.configFile(of: client).path.path). Nothing else in the file "
      + "changes, and the previous version is kept as \(backupName). Restart "
      + "\(client.displayName) afterwards."
  }

  // MARK: - Actions

  private func configure(force: Bool = false) {
    do {
      let backup = try ClientWiring.configure(client, force: force)
      collision = []
      let count = SurfaceSettings.enabledSurfaces.count
      result =
        "Wrote \(count) entr\(count == 1 ? "y" : "ies") to "
        + "\(ClientWiring.configFile(of: client).path.path)."
        + (backup.map { " Previous version saved as \($0.lastPathComponent)." } ?? "")
        + " Restart \(client.displayName) to pick them up."
    } catch ClientWiring.WriteError.collision(let name, let keys) {
      // The refusal is the feature. It also lands in `result`, so the reason
      // survives after the alert is dismissed.
      result = ClientWiring.WriteError.collision(client: name, keys: keys).localizedDescription
      collision = keys
    } catch {
      result = "Could not write the config: \(error.localizedDescription)"
    }
  }

  private func unwire() {
    do {
      let backup = try ClientWiring.unwire(client)
      result =
        "Removed Cupertino's entries from \(ClientWiring.configFile(of: client).path.path)."
        + (backup.map { " Previous version saved as \($0.lastPathComponent)." } ?? "")
        + " Restart \(client.displayName) to pick it up."
    } catch {
      result = "Could not write the config: \(error.localizedDescription)"
    }
  }

  private func remove(_ removal: Removal) {
    do {
      let backup = try ClientWiring.removeEntry(
        removal.key, from: client, inLocalScope: removal.folder)
      let scope = removal.folder.map { " in \(abbreviate($0))" } ?? ""
      result =
        "Removed \u{2018}\(removal.key)\u{2019}\(scope) from "
        + "\(ClientWiring.configFile(of: client).path.path)."
        + (backup.map { " Previous version saved as \($0.lastPathComponent)." } ?? "")
        + " Restart \(client.displayName) to pick it up."
    } catch {
      result = "Could not write the config: \(error.localizedDescription)"
    }
    pending = nil
  }
}

/// A word and a colour, for a fact too small to be a sentence.
///
/// Sized against `Card`'s own caption text rather than against a control: these
/// sit at the end of a monospaced key, and a bordered capsule at control size
/// would out-weigh the key it describes.
struct Badge: View {
  let text: String
  let tint: Color

  init(_ text: String, tint: Color) {
    self.text = text
    self.tint = tint
  }

  var body: some View {
    Text(text)
      .font(.caption2)
      .padding(.horizontal, 6).padding(.vertical, 1)
      .background(tint.opacity(0.15), in: Capsule())
      .foregroundStyle(tint)
  }
}

/// Wiring one folder rather than the whole machine.
///
/// ## Why this exists at all
///
/// Every client is wired once per user, which is right for an app on this Mac.
/// It is wrong for a CLI run in 93 directories: measured on a real install, 12
/// of them had ever called a Cupertino tool, so 87% of sessions were carrying
/// ~73 tool definitions they never used. Wiring a folder is how someone opts the
/// other 81 out without giving up the 12.
///
/// ## Why it lives here
///
/// It was a section in Settings, beside a list of every client. Both files it
/// writes are Claude Code's — `~/.claude.json` under `projects[<dir>]`, or a
/// `.mcp.json` inside the folder — so as a card in Claude Code's own pane it is
/// filed under the client it was always about, next to the user-scope entries it
/// is the alternative to. `ClientWiring.hasLocalScope` is the gate.
///
/// ## Why the scope is a control and not a setting
///
/// It was nearly a preference, and that is the wrong shape. The choice is
/// genuinely per-folder — this repo wants the entry committed, the client's repo
/// very much does not — so one global answer would be wrong half the time. More
/// to the point, `project` scope writes a file into somebody's git working tree,
/// and a preference set once and applied silently months later is the worst
/// possible way to make that decision.
///
/// So it is a radio, resolved before the open panel appears. The last choice is
/// remembered, which is the part a setting would have bought — without moving the
/// decision away from the moment it matters.
struct ProjectFoldersCard: View {
  @AppStorage("wiring.projectScope") private var scopeRaw = ClientWiring.ProjectScope.local
    .rawValue
  @State private var folders: [URL] = ProjectFoldersCard.remembered
  @State private var error: String?

  /// Demo mode answers from a table, like every other fact these captures show.
  static var remembered: [URL] {
    DemoSeed.isEnabled ? DemoSeed.wiredFolders : ClientWiring.rememberedFolders
  }

  private var scope: ClientWiring.ProjectScope {
    ClientWiring.ProjectScope(rawValue: scopeRaw) ?? .local
  }

  var body: some View {
    Card("Project folders") {
      Text(
        "Wire a folder when you want these servers in one project rather than everywhere. A "
          + "Claude Code session started in that folder gets them; every other session stays as "
          + "it was.")
        .font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      Picker("Write to", selection: Binding(get: { scope }, set: { scopeRaw = $0.rawValue })) {
        ForEach(ClientWiring.ProjectScope.allCases) { option in
          Text(option.displayName).tag(option)
        }
      }
      .pickerStyle(.radioGroup)
      .controlSize(.small)

      Text(scope.detail)
        .font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      ForEach(folders, id: \.path) { folder in
        Divider()
        FolderRow(
          folder: folder,
          scope: scope,
          wire: { wire(folder) },
          unwire: { unwire(folder) },
          forget: {
            ClientWiring.forget(folder)
            folders = ProjectFoldersCard.remembered
          })
      }

      Divider()
      HStack(spacing: 8) {
        Button("Add a folder…") { choose() }
          .controlSize(.small)
        Spacer()
      }

      if let error {
        Text(error).font(.caption).foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func choose() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Wire"
    panel.message = "Choose the project folder to wire Cupertino into."
    guard panel.runModal() == .OK, let folder = panel.url else { return }
    ClientWiring.remember(folder)
    folders = ProjectFoldersCard.remembered
    wire(folder)
  }

  /// One button, one behaviour. The scope picks which file is merged into — see
  /// `ClientWiring.ProjectScope`.
  private func wire(_ folder: URL) {
    error = nil
    do { try ClientWiring.configure(folder: folder, scope: scope) } catch {
      self.error = error.localizedDescription
    }
    // Redrawn either way: a failed write leaves the row's status telling the
    // truth about the file, which is what the red line above is beside.
    folders = ProjectFoldersCard.remembered
  }

  /// Takes the entries out of the file, which forgetting the folder never did.
  ///
  /// The two stayed confused for as long as there was only one button: a folder
  /// dropped from the list went on giving every session opened there a tool list
  /// nobody had asked for, and the only way to find out was to open the file.
  private func unwire(_ folder: URL) {
    error = nil
    do { try ClientWiring.unwire(folder: folder, scope: scope) } catch {
      self.error = error.localizedDescription
    }
    folders = ProjectFoldersCard.remembered
  }
}

private struct FolderRow: View {
  let folder: URL
  let scope: ClientWiring.ProjectScope
  let wire: () -> Void
  let unwire: () -> Void
  let forget: () -> Void

  private var status: ClientWiring.Status {
    // Subscribed to this app's own writes, like every other reader of these
    // files. See `ClientConfigRevision`.
    _ = ClientConfigRevision.shared.value
    return ClientWiring.projectStatus(folder, scope: scope)
  }

  var body: some View {
    let status = status
    return VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: status == .configured ? "checkmark.circle.fill" : "folder")
          .font(.caption)
          .foregroundStyle(status == .configured ? Color.green : .secondary)
        VStack(alignment: .leading, spacing: 1) {
          Text(folder.lastPathComponent)
            .font(.caption).bold()
          // The full path, because two repos called `app` is the normal case and
          // the last component alone would make them indistinguishable.
          Text((folder.path as NSString).abbreviatingWithTildeInPath)
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(1).truncationMode(.head)
        }
        Spacer(minLength: 8)
        if status == .configured {
          Button("Reveal") { ClientWiring.reveal(folder: folder, scope: scope) }
            .controlSize(.small)
        } else {
          Button(status == .notConfigured ? "Write" : "Update", action: wire)
            .controlSize(.small)
        }
        // Two buttons, because they are two different acts: one edits a file,
        // the other edits a list in this app. Collapsing them into "Remove" is
        // what left entries behind for as long as there was one.
        if status != .notConfigured {
          Button("Unwire", action: unwire)
            .controlSize(.small)
        }
        Button("Forget", action: forget)
          .buttonStyle(.borderless)
          .controlSize(.small)
          .foregroundStyle(.secondary)
      }
      if case .stale = status {
        Text("Points at another copy of Cupertino. Update rewrites it.")
          .font(.caption2).foregroundStyle(.red)
      }
    }
  }
}
