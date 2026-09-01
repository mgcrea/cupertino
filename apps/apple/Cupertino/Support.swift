import Foundation
import SupportKit

/// Cupertino's identity for the shared support package.
///
/// One constant; the feedback URL, the support page, the prefilled issue and the
/// mail draft are all derived from it. Nothing here can open a connection — the
/// package builds URLs and hands them to `openURL` — which is what keeps
/// `scripts/audit-network.sh` green with this dependency linked in. `URL` and
/// `URLComponents` are value types; the sweep's deny list is URL *loading*
/// (`URLSession`, `URLRequest`, `_CFHTTP`), and none of it is reachable from here.
///
/// `trackerURL` is this project's own repository rather than `mgcrea/support`.
/// The eight App Store apps share that tracker because none of them has a public
/// repo to file against; Cupertino does, the website's footer and feedback page
/// already point at it, and a second tracker would split the history in two.
///
/// It has to be the repository ROOT, not `/issues`. `SupportApp.issuesPath`
/// appends `issues/new` to whatever it is handed — for the other eight it slices
/// at `/tree/` first — so a URL that already ends in `/issues` would build
/// `/issues/issues/new`.
///
/// `preferIssueTracker` is true, unlike every app sold on the store. Cupertino is
/// wired into Cursor, VS Code and Claude Desktop by people who have a GitHub
/// account before they have this app, and `feedback.astro` says in as many words
/// that the tracker "remains the primary channel for this project". The form sits
/// one item below for the reports that cannot go there: a useful Cupertino bug
/// quotes a subject line, a chat or a contact, and the tracker is public and
/// permanent.
enum Support {
  static let app = SupportApp(
    slug: "cupertino",
    displayName: "Cupertino",
    siteURL: URL(string: "https://cupertino.mgcrea.io")!,
    trackerURL: URL(string: "https://github.com/mgcrea/cupertino")!
  )

  /// Whether the Help menu lists the public tracker above the feedback form.
  static let preferIssueTracker = true
}
