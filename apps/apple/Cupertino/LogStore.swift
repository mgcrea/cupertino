import Foundation
import Observation

/// What the log window shows.
///
/// This is the GUI rendering of what `apple_mail_diagnostics` reports on the
/// tool side, and it deliberately reuses that vocabulary — lane names, error
/// text — rather than inventing a second one.
@MainActor
@Observable
final class LogStore {
  static let shared = LogStore()

  enum Level: String {
    case info, call, error
  }

  struct Entry: Identifiable {
    let id = UUID()
    let at: Date
    let surface: String
    let level: Level
    let text: String
  }

  /// Bounded: this runs for as long as the machine is up, and an unbounded log
  /// is a memory leak with a nice name.
  private let limit = 1000
  private(set) var entries: [Entry] = []

  func append(surface: String, level: Level, _ text: String) {
    entries.append(Entry(at: Date(), surface: surface, level: level, text: text))
    if entries.count > limit { entries.removeFirst(entries.count - limit) }
  }

  func clear() { entries.removeAll() }

  /// Seed one entry at a fixed instant, for `DemoSeed` only.
  ///
  /// Separate from `append` rather than an optional `at:` parameter on it: the
  /// live path must never be able to pass a date, because a caller that could
  /// choose the timestamp is a caller that could get it wrong, and every real
  /// line is stamped when it happens.
  func appendDemo(at: Date, surface: String, level: Level, _ text: String) {
    entries.append(Entry(at: at, surface: surface, level: level, text: text))
  }
}

/// Post a log line from any thread.
///
/// Also mirrored to stderr, which is where it shows up when the app is launched
/// from a terminal instead of by LaunchServices — the difference between being
/// able to debug the host and guessing at it.
/// The stderr mirror goes through `write(2)` for the same reason the bridge's
/// `warn` does: `-[NSFileHandle writeData:]` raises an Objective-C exception on
/// a failed write, Swift cannot catch it, and the process aborts. The bridge was
/// seen dying that way. A GUI app's stderr is usually a pipe LaunchServices
/// keeps open, so this end is far less exposed — but "usually" is the whole
/// problem, and a logging call is not something that should be able to take the
/// app down. A dropped line is the correct failure here.
func hostLog(_ surface: String, _ level: LogStore.Level, _ text: String) {
  let bytes = Array("[\(surface)] \(level.rawValue): \(text)\n".utf8)
  var offset = 0
  while offset < bytes.count {
    let written = bytes.withUnsafeBufferPointer {
      write(STDERR_FILENO, $0.baseAddress! + offset, bytes.count - offset)
    }
    if written <= 0 {
      if errno == EINTR { continue }
      break
    }
    offset += written
  }
  Task { @MainActor in LogStore.shared.append(surface: surface, level: level, text) }
}
