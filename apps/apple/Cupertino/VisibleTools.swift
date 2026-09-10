import Foundation

/// Which Node tools change what is on somebody's screen, and how loudly to say so.
///
/// ## Why a table, and why here
///
/// The in-process surfaces light the driving notice themselves, from inside
/// `AccessibilityDriver`, because that is where every synthetic event is posted.
/// The Node surfaces cannot: they run in another process and reach their apps by
/// Apple Event, System Events or the Safari extension, none of which passes
/// through the driver. Only Mail's native lane and Maps' card lane borrow it.
///
/// So the app decides from the one thing it sees for every Node call, the tool
/// name on the wire (`RequestObserver.note`), before the child has done anything.
/// A name is a coarse signal, which is why the table is explicit rather than a
/// rule over `readOnlyHint`: most writes change a store and nothing on screen.
///
/// No dependency on the rest of the app, so `make unit` can compile it.
enum VisibleTools {
  enum Notice: Equatable {
    /// Takes the foreground and posts input. The orange card: hands off.
    case driving
    /// Changes what is on screen without touching the keyboard or mouse.
    case showing(Action)
    /// Starts the surface's app. Shown only when it was not already running.
    case launching
  }

  enum Action: Equatable {
    case openingPage
    case clickingPage
    case fillingPage
    case scrollingPage
    case openingPlace
  }

  static func notice(forTool name: String) -> Notice? {
    if driving.contains(name) { return .driving }
    if let action = showing[name] { return .showing(action) }
    if launching.contains(name) { return .launching }
    return nil
  }

  /// Mail's compose paths. `stripCitation` (packages/mail/src/client/jxa/core.ts)
  /// raises Mail and sends Cmd-A and Format menu clicks through System Events on
  /// every send and draft; the System Events reply lane pastes with Cmd-V. The
  /// native reply lane also lights the card through the driver it borrows, which
  /// is harmless: the second light names the same app.
  private static let driving: Set<String> = [
    "apple_mail_send_message", "apple_mail_update_draft",
    "apple_mail_reply_to_message", "apple_mail_forward_message",
  ]

  /// Safari's page verbs go through the extension, and `open_url` switches the
  /// front window's tab; none of them activates Safari unless asked. Maps opens
  /// a search with `open -g`, so it moves behind whatever is in front.
  private static let showing: [String: Action] = [
    "apple_safari_open_url": .openingPage,
    "apple_safari_click": .clickingPage,
    "apple_safari_fill": .fillingPage,
    "apple_safari_scroll": .scrollingPage,
    "apple_maps_add_favorite": .openingPlace,
  ]

  /// Writes sent by Apple Event with launching allowed. They open no window and
  /// take no focus; the only thing a person can see is the app appearing.
  private static let launching: Set<String> = [
    "apple_notes_create_note", "apple_notes_update_note", "apple_notes_add_attachment",
    "apple_notes_move_note", "apple_notes_delete_notes",
    "apple_reminders_create_reminder", "apple_reminders_update_reminder",
    "apple_reminders_complete_reminders", "apple_reminders_move_reminders",
    "apple_reminders_delete_reminders",
    "apple_calendar_create_event", "apple_calendar_update_event", "apple_calendar_delete_events",
    "apple_contacts_create_contact", "apple_contacts_update_contact",
    "apple_messages_send_message", "apple_mail_check_for_new_mail",
    "apple_safari_add_reading_list_item",
  ]

  /// The notice for a call, given whether the surface's app was running when
  /// the request arrived.
  ///
  /// A launch is only visible when there was something to launch. The other
  /// tiers change the screen either way, so the answer does not touch them.
  static func notice(forTool name: String, appRunning: Bool) -> Notice? {
    let notice = notice(forTool: name)
    if notice == .launching, appRunning { return nil }
    return notice
  }

  /// Visible calls that have been asked for and not yet answered.
  ///
  /// The linger covers the gaps between presses, not a single call that runs
  /// for longer than it: Mail's send sits in `stripCitation` for seconds with
  /// Mail in front. So the observer holds the notice for as long as a call is
  /// here, and lets the linger take over from the reply.
  ///
  /// Not thread-safe on its own. `RequestObserver` sees requests and replies on
  /// two pump threads and keeps this behind its lock.
  struct InFlight {
    /// How long a call may hold the notice without an answer. A server that
    /// never replies must not keep the orange card up for the life of the
    /// connection.
    static let cap: TimeInterval = 30

    private var calls: [String: (bundleId: String, notice: Notice, since: Date)] = [:]

    var isEmpty: Bool { calls.isEmpty }

    mutating func started(_ key: String, bundleId: String, notice: Notice, at date: Date) {
      calls[key] = (bundleId, notice, date)
    }

    mutating func answered(_ key: String) {
      calls[key] = nil
    }

    func live(at now: Date) -> [(bundleId: String, notice: Notice)] {
      calls.values
        .filter { now.timeIntervalSince($0.since) <= Self.cap }
        .map { ($0.bundleId, $0.notice) }
    }

    mutating func prune(at now: Date) {
      calls = calls.filter { now.timeIntervalSince($0.value.since) <= Self.cap }
    }
  }
}
