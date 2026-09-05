import AppKit
import Foundation

/// Spike: does the `desktop` surface's press verb actually perform a Maps write?
///
/// docs/maps.md:619 flags this as "a write half is now plausible and unbuilt".
/// docs/desktop.md closes the read half with numbers; this is the one thing a
/// probe cannot answer, because answering it means changing something.
///
/// ## RUN 2026-09-05, and it falsified the plan it was written to execute
///
/// This file was written to press `FavoriteButton` and check `ZFAVORITEITEM`.
/// It did press it, and four of docs/maps.md's claims turned out to be wrong.
/// The full account is in docs/desktop.md; what changed HERE:
///
/// 1. **`FavoriteButton` does not write a favourite.** It opens a "Name This
///    Location" SHEET — text field, Cancel, Save — and nothing is written until
///    Save. The place then lands as an unfiled SAVED PLACE.
///    `apple_maps_list_favorites` returned 26 before and 26 after.
/// 2. **It is not a toggle.** A second press on a saved place opens no sheet and
///    removes nothing. Removal is `MoreButton` → `delete_from_places`.
/// 3. **The state bit exists**, on the sibling: `AddButton` is named "Add" when
///    the place is not saved and "Added" when it is.
/// 4. **A modal sheet REPLACES the window list.** With the sheet up, a full walk
///    of Maps returned 19 elements — the sheet alone. And the sheet's `Save`
///    carries no `AXIdentifier`, so it must be addressed by name.
///
/// ## What makes this safe to run
///
/// **`AddButton`'s name is read first, and the run refuses if the place is
/// already saved.** That is the state check docs/maps.md concluded was
/// impossible, and it is why this no longer needs the operator to check the
/// store in between.
///
/// **Nothing is pressed without --press.** The default run stages the card,
/// finds the control and reports both its state and the sequence it would
/// perform.
///
/// **The card is POLLED for, never waited on.** A single read four seconds after
/// opening the URL found the control on one run and not the next: the card's
/// chrome — `PlaceCardViewController`, `CardButtonTypeShare` — is in the tree
/// while the card still renders blank. Cheap to poll; a whole Maps walk is
/// ~0.2 s.
///
/// ## Addressing
///
/// By `AXIdentifier`, never by the English title. Both controls carry a
/// developer-set, unlocalised identifier — `FavoriteButton`, `AddButton` — and a
/// verb that matched on the word "Favorite" would break on the first non-English
/// Mac. docs/desktop.md measured 86% of Maps' pressable elements as invisible to
/// a role filter, so this searches by identifier over the whole tree.
///
/// Usage:
///   swift scripts/spike-desktop-maps-write.swift [--press]
///
/// Compiled by `make maps-write-spike`, which is not part of any gate: a check
/// that toggles a saved place does not belong in CI.

@main
struct MapsWriteSpike {
  static let shouldPress = CommandLine.arguments.contains("--press")

  /// The Eiffel Tower, chosen because it is not in this Mac's favourites and its
  /// name resolves unambiguously with the coordinate attached.
  static let subject = "Eiffel Tower"
  static let coordinate = "48.8584,2.2945"

  static func section(_ title: String) {
    print(
      "\n\u{2500}\u{2500} \(title) "
        + String(repeating: "\u{2500}", count: max(0, 56 - title.count)))
  }
  static func row(_ key: String, _ value: String) {
    print("  \(key.padding(toLength: 24, withPad: " ", startingAt: 0)) \(value)")
  }

  static func main() {
    section("identity")
    row("AXIsProcessTrusted()", AccessibilityDriver.isTrusted() ? "true" : "FALSE")
    guard AccessibilityDriver.isTrusted() else {
      print("\n  Accessibility is not granted to whatever is responsible for this")
      print("  process. Nothing to do, and this file will not ask for it.")
      exit(3)
    }

    // docs/maps.md: the COMBINED form is the only one that stages a card. ?ll=
    // alone centres the map and shows no card; ?q=<name> alone can resolve to
    // the wrong place. A coordinate positions the map, a NAME selects a place.
    section("staging")
    let url = URL(
      string: "maps://?q=\(subject.replacingOccurrences(of: " ", with: "+"))&ll=\(coordinate)")!
    row("url", url.absoluteString)
    NSWorkspace.shared.open(url)

    section("finding the control")
    do {
      // POLLED, not sampled once, and the first version of this file got that
      // wrong. A single read four seconds after opening the URL found the
      // control on one run and not on the next: the card was present both times
      // -- PlaceCardViewController and CardButtonTypeShare were in the tree --
      // but Favorite had not been laid out yet. Re-opening the URL while a card
      // is already up makes it slower still, because Maps rebuilds the card.
      //
      // A driver reading a live interface has to wait for a control rather than
      // assume a settle time, exactly as `findBodyArea` waits for Mail's
      // composer in packages/mail/src/client/jxa/core.ts. Cheap here because a
      // whole Maps walk is ~0.2 s.
      var tree = try AccessibilityDriver.tree(
        bundleId: "com.apple.Maps", windowIndex: nil, detail: .all,
        bounds: AccessibilityDriver.Bounds())
      var waited = 0.0
      while !tree.elements.contains(where: { $0.identifier == "FavoriteButton" }), waited < 15 {
        Thread.sleep(forTimeInterval: 0.5)
        waited += 0.5
        tree = try AccessibilityDriver.tree(
          bundleId: "com.apple.Maps", windowIndex: nil, detail: .all,
          bounds: AccessibilityDriver.Bounds())
      }
      row("waited for the card", String(format: "%.1f s", waited))
      row("elements walked", "\(tree.visited) in \(String(format: "%.3f s", tree.seconds))")
      row("stopped by", tree.stoppedBy ?? "nothing \u{2014} the whole tree")

      let identified = tree.elements.filter { $0.identifier != nil }
      row("carrying an AXIdentifier", "\(identified.count)")

      guard let favorite = tree.elements.first(where: { $0.identifier == "FavoriteButton" })
      else {
        print("\n  FavoriteButton not found. The card may not have opened \u{2014} check that")
        print("  Maps is showing a place card for \(subject), and re-run.")
        let sample = identified.prefix(12).compactMap(\.identifier).joined(separator: ", ")
        print("  Identifiers seen: \(sample)")
        exit(4)
      }

      row("handle", favorite.handle)
      row("role", favorite.role)
      row("name", favorite.name ?? "(none)")
      row("pressable", favorite.pressable ? "yes (has AXPress)" : "NO")
      row("rect", favorite.rect.map { "\($0)" } ?? "(none)")

      // The state bit, on the sibling control rather than on this one.
      let addButton = tree.elements.first { $0.identifier == "AddButton" }
      let alreadySaved = addButton?.name == "Added"
      row("AddButton name", addButton?.name ?? "(not found)")
      row("already saved", alreadySaved ? "YES" : "no")

      guard shouldPress else {
        section("dry run")
        print(
          """
            Found and NOT pressed. Addressing by unlocalised AXIdentifier works,
            and `AddButton`'s name carries the saved state.

            With --press this would: press FavoriteButton, wait for the "Name
            This Location" sheet in its OWN window, then press its Save button
            \u{2014} by NAME, because that button carries no identifier.

            Re-run with --press.
          """)
        exit(0)
      }

      guard !alreadySaved else {
        print(
          """

            REFUSED: \(subject) is already saved. Pressing would not remove it
            \u{2014} that is `MoreButton` \u{2192} `delete_from_places` \u{2014} and this file only
            proves the ADD path. Delete it by hand and re-run.
          """)
        exit(5)
      }

      section("pressing")
      try AccessibilityDriver.press(handle: favorite.handle)
      row("FavoriteButton", "AXPress performed")

      // The sheet is its own window, and while it is up it is the ONLY window
      // Maps offers. Polled for the same reason the card is.
      var sheet = try AccessibilityDriver.tree(
        bundleId: "com.apple.Maps", windowIndex: nil, detail: .all,
        bounds: AccessibilityDriver.Bounds())
      var sheetWait = 0.0
      while !sheet.elements.contains(where: { $0.name == "Save" }), sheetWait < 10 {
        Thread.sleep(forTimeInterval: 0.5)
        sheetWait += 0.5
        sheet = try AccessibilityDriver.tree(
          bundleId: "com.apple.Maps", windowIndex: nil, detail: .all,
          bounds: AccessibilityDriver.Bounds())
      }
      guard let save = sheet.elements.first(where: { $0.name == "Save" && $0.pressable }) else {
        print("\n  No Save button appeared. Nothing was written.")
        exit(6)
      }
      row("sheet elements", "\(sheet.visited) \u{2014} the sheet replaces the window list")
      row("Save identifier", save.identifier ?? "(none \u{2014} addressed by name)")

      try AccessibilityDriver.press(handle: save.handle)
      row("Save", "AXPress performed")
      print(
        """

          Confirm through the FILE LANE \u{2014} apple_maps_search_places. Expect a
          SAVED PLACE, not a favourite: apple_maps_list_favorites will not move.

          To undo: MoreButton \u{2192} delete_from_places, which takes AddButton's name
          back to "Add".
        """)
    } catch {
      print("\n  FAILED: \(error.localizedDescription)")
      exit(1)
    }
  }
}
