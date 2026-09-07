import SwiftUI

/// What changed, in the build that is running.
///
/// Until this existed, release notes were reachable from exactly one place: the
/// sheet Sparkle puts up while it asks permission to install. That sheet is gone
/// the moment you press Install, which leaves the one audience that most wants
/// to know what changed — somebody who has just updated — with nowhere to look
/// but `CHANGELOG.md` on GitHub, a file written for the repository rather than
/// for them.
///
/// A pane rather than a window that appears after an update. Cupertino is an
/// `LSUIElement` app whose whole promise is that it stays out of the way; a
/// window that seizes focus the first time you launch a new build would be the
/// single most intrusive thing in it, and for news that can wait. The
/// indicators in the menu bar and the main window say there is something here,
/// and going to look stays the user's decision.
///
/// Its own file rather than another `private struct` in `SettingsWindow.swift`,
/// following `LicensePane` — which is already the pane that moved out for the
/// same reason, being the one too big to read alongside the others.
struct WhatsNewPane: View {
  /// Which releases were unread when this pane was opened.
  ///
  /// Captured once in `onAppear`, before `markSeen()` runs, and then held.
  /// Reading `Changelog.unseen` live would clear every "New" badge in the same
  /// frame that draws them — the user would arrive to find the thing they came
  /// to read already marked as read, which is both wrong and unsettling.
  @State private var wasUnseen: Set<String> = []
  @State private var expanded: Set<String> = []

  private var recent: [Changelog.Release] {
    Changelog.releases.filter {
      $0.version == Changelog.releases.first?.version || wasUnseen.contains($0.version)
    }
  }

  private var earlier: [Changelog.Release] {
    Changelog.releases.filter { release in !recent.contains { $0.version == release.version } }
  }

  var body: some View {
    Form {
      // Debug only, and the section says so rather than relying on the reader
      // noticing an unusual version string. In a tagged build this is nil: CI
      // asserts the CHANGELOG's head section is the tag's own version, so there
      // is nothing left under `[Unreleased]` by the time a release is cut.
      if Changelog.showsUnreleased, let unreleased = Changelog.unreleased {
        Section {
          ReleaseBody(release: unreleased)
        } header: {
          HStack(spacing: 6) {
            Text("Unreleased")
            Badge("not in any build", tint: .orange)
          }
        }
      }

      ForEach(recent) { release in
        Section {
          ReleaseBody(release: release)
        } header: {
          ReleaseHeader(release: release, isNew: wasUnseen.contains(release.version))
        }
      }

      if !earlier.isEmpty {
        Section {
          ForEach(earlier) { release in
            DisclosureGroup(isExpanded: binding(for: release.version)) {
              ReleaseBody(release: release)
            } label: {
              ReleaseHeader(release: release, isNew: false)
            }
          }
        } header: {
          Text("Earlier releases")
        }
      }

      Section {
        Link("Full changelog on GitHub", destination: Changelog.historyURL)
        Text(
          "The most recent \(Changelog.releases.count) releases are shown here. Every release "
            + "Cupertino has ever had is in CHANGELOG.md, which is where these notes come from."
        )
        .font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      }
    }
    .formStyle(.grouped)
    // Somebody reading a fix wants to paste its symbol name into a search.
    .textSelection(.enabled)
    .onAppear {
      // Order matters: capture what was unread, then mark it read.
      wasUnseen = Set(Changelog.unseen.map(\.version))
      guard !DemoSeed.isEnabled else { return }
      Changelog.markSeen()
    }
    .task { DemoSeed.signalReady(from: .settings) }
  }

  private func binding(for version: String) -> Binding<Bool> {
    Binding(
      get: { expanded.contains(version) },
      set: { isExpanded in
        if isExpanded {
          expanded.insert(version)
        } else {
          expanded.remove(version)
        }
      })
  }
}

// MARK: - One release

private struct ReleaseHeader: View {
  let release: Changelog.Release
  let isNew: Bool

  var body: some View {
    HStack(spacing: 6) {
      Text(release.version)
      if isNew { Badge("new", tint: .accentColor) }
      if release.version == Changelog.marketingVersion { Badge("installed", tint: .secondary) }
      Spacer()
      Text(formattedDate)
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }

  /// Absolute, never relative.
  ///
  /// `.relative` would read better — "3 days ago" — and would be computed
  /// against `Date()`, which makes this pane render differently every day and
  /// the screenshot goldens unreproducible. The same trap `DemoSeed` documents
  /// for the two clocks it has to freeze.
  private var formattedDate: String {
    guard
      let date = try? Date(
        release.date, strategy: .iso8601.year().month().day().dateSeparator(.dash))
    else { return release.date }
    return date.formatted(date: .abbreviated, time: .omitted)
  }
}

private struct ReleaseBody: View {
  let release: Changelog.Release

  /// One row of a release, flattened, with an id that cannot collide.
  ///
  /// The sections are NOT a nested `ForEach` any more, and that is a bug fix
  /// rather than a tidy-up. SwiftUI flattens nested `ForEach`es inside a
  /// `Form`, so every id in them shares one space — and a lead paragraph keyed
  /// by its offset (0) collided with the release's first entry keyed by its
  /// ordinal (0). A collision does not drop a row or crash; it draws one of the
  /// two twice and the other never, which reads as a changelog that repeats
  /// itself. Building the rows here, with string ids carrying the section name,
  /// means there is only one id space and it is one this file controls.
  private struct Row: Identifiable {
    let id: String
    let section: String
    let lead: String?
    let entry: Changelog.Entry?
  }

  private var rows: [Row] {
    release.sections.flatMap { section in
      // The section's own prose, when it has any. Rare, and the reason a
      // release ever explains itself as a whole rather than bullet by bullet.
      section.lead.enumerated().map {
        Row(
          id: "\(section.name).lead.\($0.offset)", section: section.name, lead: $0.element,
          entry: nil)
      }
        + section.entries.map {
          Row(
            id: "\(section.name).entry.\($0.ordinal)", section: section.name, lead: nil, entry: $0)
        }
    }
  }

  var body: some View {
    ForEach(rows) { row in
      if let lead = row.lead {
        Text(Changelog.markdown(lead, .caption))
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      } else if let entry = row.entry {
        EntryRow(section: row.section, entry: entry)
      }
    }
  }
}

/// One bullet, with its section as a badge rather than as a heading.
///
/// A grouped `Form` already spends a header on each release; adding `Added` and
/// `Fixed` as a second heading level inside that is three levels of hierarchy in
/// a 660pt window, for a median release of five or six bullets across two
/// sections. The badge says the same thing in the space the bullet already
/// occupies. If a release ever lands with a dozen entries in one section and
/// this reads as soup, the fix is a heading per section — but that is a cost
/// worth paying only when the pixels say so.
private struct EntryRow: View {
  let section: String
  let entry: Changelog.Entry

  /// Whether the bold lead is a headline or just the start of a sentence.
  ///
  /// Both are written in this CHANGELOG. Most entries open with a complete
  /// sentence — "**A pruned audit log reported itself as tampered with.**" —
  /// which reads well pulled onto its own line. Others bold only the subject and
  /// run straight on: "**Messages search returned nothing recent once older
  /// results filled the page**, because the text column pass ran to the limit".
  /// Splitting that one puts a line break before a comma and strands the clause
  /// that explains it, so it is not split.
  ///
  /// Sentence-final punctuation is the test because it is the thing the author
  /// actually decided. A length heuristic would guess, and would guess wrong on
  /// the short flowing leads that are exactly the ones at risk.
  private var leadIsHeadline: Bool {
    guard let headline = entry.headline, let last = headline.last else { return false }
    return last == "." || last == "!" || last == "?" || last == ":"
  }

  /// The first paragraph, reassembled, for the case where it must stay whole.
  ///
  /// Re-wrapping the headline in `**` rather than styling it: the headline can
  /// itself contain a code span, and one markdown string keeps the emphasis and
  /// the monospacing under a single parse — the same string the appcast renders.
  ///
  /// The generator strips the whitespace between the two, so the space has to be
  /// put back — except before punctuation that never takes one. A flowing lead
  /// continues as ", because …", and "the page , because" is the artifact this
  /// avoids. It is a typographic rule rather than a guess about this file.
  private var flowingLead: String {
    guard let headline = entry.headline else { return entry.body.first ?? "" }
    guard let first = entry.body.first, let next = first.first else { return "**\(headline)**" }
    let joiner = ",.;:!?)".contains(next) ? "" : " "
    return "**\(headline)**\(joiner)\(first)"
  }

  private var trailingParagraphs: ArraySlice<String> {
    leadIsHeadline || entry.headline == nil ? entry.body[...] : entry.body.dropFirst()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Badge(section.lowercased(), tint: Self.tint(for: section))
        if leadIsHeadline, let headline = entry.headline {
          Text(Changelog.markdown(headline, .callout))
            .font(.callout).bold()
            .fixedSize(horizontal: false, vertical: true)
        } else if entry.headline != nil {
          Text(Changelog.markdown(flowingLead, .callout))
            .font(.callout)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      ForEach(Array(trailingParagraphs.enumerated()), id: \.offset) { _, paragraph in
        Text(Changelog.markdown(paragraph, .caption))
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.vertical, 2)
  }

  /// Colour carries the same information as the word, for the glance that does
  /// not read it. Red for Security specifically: it is the one section whose
  /// presence should change whether somebody defers an update.
  private static func tint(for section: String) -> Color {
    switch section {
    case "Added": .green
    case "Changed": .blue
    case "Fixed": .orange
    case "Security": .red
    default: .secondary
    }
  }
}
