import Foundation

/// The Shell windows waiting to be answered, one on screen at a time, in arrival order.
///
/// `ShellConsent` draws; this decides. It is apart, and Foundation only, so `make shell-check`
/// pins the three things a screen would otherwise be needed to see:
///
/// - **The timer starts when the window shows.** A request queued behind another is waiting,
///   not being asked, and the person gets the full `timeout` for each window once it is in
///   front of them. A timer started at arrival would let the second window close itself a
///   moment after it appeared.
/// - **Arrival order.** Only the oldest request is in front; the next shows when it is gone.
/// - **A cancel can come first.** `ShellServer` marks a request as being asked and then calls
///   `ask`, and a cancel can land in between, on another thread. It is kept as a tombstone, and
///   the `ask` it names answers `.cancelled` at once with no window.
///
/// ## Threads
///
/// `ask` blocks the calling thread, a connection's worker, on this type's own condition until
/// the window is answered, times out or is cancelled. Nothing here waits for the main thread,
/// so a cancel or a timeout releases the worker even while the main thread is busy, and the
/// main thread never waits on a worker. `changed` is called, outside the lock, whenever the
/// request in front changes; the app hops to the main thread from it and redraws.
nonisolated final class ShellPromptQueue: @unchecked Sendable {

  /// How many early cancels one connection keeps. A client reaches it only by cancelling
  /// requests it never sent or that were already answered, so the oldest goes past it.
  static let tombstonesPerConnection = 8

  /// The request on screen, or due to be.
  struct Front {
    /// This queue's own number for the request, which `shown` and `answer` name. Never reused,
    /// so an answer from a window that has already closed cannot reach the next one.
    let id: Int
    let prompt: ShellPrompt
  }

  private struct Entry {
    let id: Int
    let prompt: ShellPrompt
    /// When the window went up. Nil while it waits behind another.
    var shownAt: Date?
  }

  private struct Tombstone {
    let connection: UUID
    let requestId: String
    let at: Date
  }

  private let timeout: TimeInterval
  private let tombstoneLife: TimeInterval
  private let changed: @Sendable () -> Void

  private let state = NSCondition()
  // Everything below is guarded by `state`.
  private var entries: [Entry] = []
  private var answers: [Int: ShellPromptAnswer] = [:]
  private var tombstoneList: [Tombstone] = []
  private var serial = 0

  /// `tombstoneLife` bounds how long an early cancel waits for its `ask`. The race it covers is
  /// a few instructions wide, so seconds are plenty, and a short life means a client that
  /// reuses a request id is not refused for a cancel it sent long ago.
  init(
    timeout: TimeInterval, tombstoneLife: TimeInterval = 10,
    changed: @escaping @Sendable () -> Void = {}
  ) {
    self.timeout = timeout
    self.tombstoneLife = tombstoneLife
    self.changed = changed
  }

  // MARK: - The worker's side

  /// Queue the request and wait for its answer: the person's, `.noAnswer` once `timeout` has
  /// passed since it showed, or `.cancelled`.
  func ask(_ prompt: ShellPrompt) -> ShellPromptAnswer {
    state.lock()
    let now = Date()
    prune(now)
    if let early = tombstoneList.firstIndex(where: {
      $0.connection == prompt.connection && $0.requestId == prompt.requestId
    }) {
      tombstoneList.remove(at: early)
      state.unlock()
      return .cancelled
    }
    serial += 1
    let id = serial
    entries.append(Entry(id: id, prompt: prompt, shownAt: nil))
    let inFront = entries.count == 1
    state.unlock()
    if inFront { changed() }

    state.lock()
    var answer: ShellPromptAnswer?
    var frontMoved = false
    while answer == nil {
      if let given = answers.removeValue(forKey: id) {
        answer = given
      } else if let shownAt = entries.first(where: { $0.id == id })?.shownAt {
        let deadline = shownAt.addingTimeInterval(timeout)
        if Date() >= deadline {
          frontMoved = finish(id, .noAnswer)
          answer = answers.removeValue(forKey: id)
        } else {
          state.wait(until: deadline)
        }
      } else {
        state.wait()
      }
    }
    state.unlock()
    if frontMoved { changed() }
    return answer ?? .cancelled
  }

  /// Answer the request `.cancelled`, whether it is on screen or still waiting. One not here
  /// yet leaves a tombstone, so its `ask` answers at once.
  func cancel(connection: UUID, requestId: String) {
    state.lock()
    let now = Date()
    prune(now)
    var frontMoved = false
    if let entry = entries.first(where: {
      $0.prompt.connection == connection && $0.prompt.requestId == requestId
    }) {
      frontMoved = finish(entry.id, .cancelled)
    } else if !tombstoneList.contains(where: {
      $0.connection == connection && $0.requestId == requestId
    }) {
      tombstoneList.append(Tombstone(connection: connection, requestId: requestId, at: now))
      let mine = tombstoneList.indices.filter { tombstoneList[$0].connection == connection }
      if mine.count > Self.tombstonesPerConnection { tombstoneList.remove(at: mine[0]) }
    }
    state.unlock()
    if frontMoved { changed() }
  }

  // MARK: - The window's side

  /// The request to show, the oldest still waiting.
  var front: Front? {
    state.withLock { entries.first.map { Front(id: $0.id, prompt: $0.prompt) } }
  }

  /// The window for `id` is on screen: its timer starts now. A second call changes nothing.
  func shown(_ id: Int) {
    state.lock()
    if let index = entries.firstIndex(where: { $0.id == id }), entries[index].shownAt == nil {
      entries[index].shownAt = Date()
      state.broadcast()
    }
    state.unlock()
  }

  /// The person answered the window for `id`. Ignored when that request is already over.
  func answer(_ id: Int, _ answer: ShellPromptAnswer) {
    state.lock()
    let frontMoved = finish(id, answer)
    state.unlock()
    if frontMoved { changed() }
  }

  // MARK: - For the checks

  /// Requests waiting, the one in front included.
  var waiting: Int { state.withLock { entries.count } }

  /// Early cancels held for a connection.
  func tombstones(_ connection: UUID) -> Int {
    state.withLock {
      prune(Date())
      return tombstoneList.filter { $0.connection == connection }.count
    }
  }

  // MARK: - Under the lock

  /// Take the request out with its answer and wake its `ask`. True when the front changed.
  private func finish(_ id: Int, _ answer: ShellPromptAnswer) -> Bool {
    guard let index = entries.firstIndex(where: { $0.id == id }) else { return false }
    entries.remove(at: index)
    answers[id] = answer
    state.broadcast()
    return index == 0
  }

  private func prune(_ now: Date) {
    tombstoneList.removeAll { now.timeIntervalSince($0.at) > tombstoneLife }
  }
}
