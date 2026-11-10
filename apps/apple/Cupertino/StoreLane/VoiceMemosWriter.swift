import CoreData
import Foundation

/// Renames, favourites, moves, deletes and restores a Voice Memo by saving through Voice Memos'
/// own Core Data model, so the save lands in the persistent history the app's iCloud exporter
/// reads, and the change syncs when Voice Memos next runs.
///
/// Each method changes only what the app itself changed for the same step (watched 2026-11-10,
/// one transaction per step):
///
/// - rename: `encryptedTitle` and `customLabelForSorting`, both to the trimmed title.
/// - favourite: bit 0 of `sharedFlags`, nothing else. `flags` is never written.
/// - move: the recording's `folder`, and each affected folder's `countOfRecordings` set to its
///   `recordings.count`.
/// - delete: `evictionDate` to now; the folder count keeps the deleted memo.
/// - restore: `evictionDate` to nil.
///
/// A call that would change nothing sets nothing, so the opener sees no changes and does not
/// save. Values are compared before they are set: Core Data counts some same-value sets as
/// changes.
nonisolated struct VoiceMemosWriter: Sendable {
  /// What a call did. `changed` lists the recording's own attributes it set, sorted; a move's
  /// folder counts are bookkeeping and are not listed.
  struct Result: Equatable {
    var id: String
    var changed: [String]
    var modelVersion: String?
    var syncMeasured: Bool
  }

  /// The memberwise `init(store:)` is the one the lane and the check use.
  let store: CoreDataStore

  static let modelURL = URL(
    fileURLWithPath:
      "/System/iOSSupport/System/Library/PrivateFrameworks/VoiceMemos.framework/Versions/A/Resources/VoiceMemos.momd"
  )

  /// Relative to the home folder.
  static let storePath =
    "Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/CloudRecordings.db"

  /// The model versions whose sync was measured on two devices.
  static let measuredVersions: Set<String> = ["VoiceMemos14"]

  /// The runtime patch the app applies before it opens its store: without it the model's
  /// `CloudRecording` hash does not match the store's.
  static let patch: @Sendable (NSManagedObjectModel) -> Void = { model in
    let audioFuture = model.entitiesByName["CloudRecording"]?
      .attributesByName["audioFuture"]
    audioFuture?.allowsExternalBinaryDataStorage = true
  }

  /// The opener over the store at `storeURL`, with Voice Memos' model and patch.
  static func store(at storeURL: URL) -> CoreDataStore {
    CoreDataStore(
      modelURL: modelURL, storeURL: storeURL, patch: patch, measuredVersions: measuredVersions)
  }

  static let live = VoiceMemosWriter(
    store: store(
      at: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(storePath)))

  static let maxTitleLength = 500

  func status() -> CoreDataStore.Status {
    store.status()
  }

  func rename(id: String, title: String) throws -> Result {
    let title = try Self.validTitle(title)
    return try update(id) { recording, _ in
      var changed: [String] = []
      for key in ["encryptedTitle", "customLabelForSorting"]
      where Self.set(recording, key, to: title) {
        changed.append(key)
      }
      return changed
    }
  }

  func setFavorite(id: String, favorite: Bool) throws -> Result {
    try update(id) { recording, _ in
      let old = (recording.value(forKey: "sharedFlags") as? NSNumber)?.int64Value
      // Clearing a favourite that was never set leaves the nil alone rather than writing 0.
      if old == nil && !favorite { return [] }
      let flags = old ?? 0
      let new = favorite ? flags | 1 : flags & ~1
      return Self.set(recording, "sharedFlags", to: new) ? ["sharedFlags"] : []
    }
  }

  func move(id: String, folderId: String?) throws -> Result {
    try update(id) { recording, context in
      let destination = try folderId.map {
        try CoreDataStore.fetchOne("Folder", key: "uuid", value: $0, in: context)
      }
      let source = recording.value(forKey: "folder") as? NSManagedObject
      if source?.objectID == destination?.objectID { return [] }
      recording.setValue(destination, forKey: "folder")
      // Inverse relationships are maintained here, so each folder's `recordings` is current.
      context.processPendingChanges()
      for folder in [source, destination].compactMap({ $0 }) {
        let count = (folder.value(forKey: "recordings") as? NSSet)?.count ?? 0
        _ = Self.set(folder, "countOfRecordings", to: Int64(count))
      }
      return ["folder"]
    }
  }

  func delete(id: String) throws -> Result {
    try update(id) { recording, _ in
      guard recording.value(forKey: "evictionDate") == nil else { return [] }
      recording.setValue(Date(), forKey: "evictionDate")
      return ["evictionDate"]
    }
  }

  func restore(id: String) throws -> Result {
    try update(id) { recording, _ in
      guard recording.value(forKey: "evictionDate") != nil else { return [] }
      recording.setValue(nil, forKey: "evictionDate")
      return ["evictionDate"]
    }
  }

  /// Trimmed, 1 to 500 characters, one line.
  static func validTitle(_ title: String) throws -> String {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw StoreLaneError.invalid("the title is empty") }
    guard trimmed.count <= maxTitleLength else {
      throw StoreLaneError.invalid("the title is longer than \(maxTitleLength) characters")
    }
    guard !trimmed.contains(where: \.isNewline) else {
      throw StoreLaneError.invalid("the title has a line break")
    }
    return trimmed
  }

  /// Fetches the recording `id` and runs `body` on it in one write; `body` returns the
  /// attributes it changed.
  private func update(
    _ id: String,
    _ body: (NSManagedObject, NSManagedObjectContext) throws -> [String]
  ) throws -> Result {
    let changed = try store.write { context in
      let recording = try CoreDataStore.fetchOne(
        "CloudRecording", key: "uniqueID", value: id, in: context)
      return try body(recording, context)
    }
    let status = store.status()
    return Result(
      id: id, changed: changed.sorted(), modelVersion: status.modelVersion,
      syncMeasured: status.syncMeasured)
  }

  /// Sets `key` to `value` only if it differs; true when it did.
  private static func set<Value: Equatable>(
    _ object: NSManagedObject, _ key: String, to value: Value
  ) -> Bool {
    if object.value(forKey: key) as? Value == value { return false }
    object.setValue(value, forKey: key)
    return true
  }
}
