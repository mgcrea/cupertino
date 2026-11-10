import CoreData
import Foundation

/// Asserts what the store lane's Core Data opener does with a store, with no app and no
/// Apple store.
///
/// A standalone `swiftc` binary for the reason `unit-check.swift` gives. Every store here is
/// built from a model made in code (entity `Thing`, string attributes `key` and `name`), in a
/// fresh temporary folder, so nothing touches a real Apple app's data.
///
/// The things worth holding still, all silent when they go wrong: a store the model does not
/// match being migrated rather than refused, a write that lands without the persistent history
/// an app's iCloud exporter reads, and a fetch by id that quietly picks one of two rows. And at
/// the lane's door: a connection admitted to a surface's lane that is not that surface's own
/// server, and a write answered while the surface's writes are off.
///
/// Run with `make store-lane-check`.
@main
struct StoreLaneCheck {
  static var failures = 0
  static let scratch = FileManager.default.temporaryDirectory
    .appendingPathComponent("store-lane-check-\(UUID().uuidString)")

  struct Failure: Error { let why: String }

  static func expect(_ condition: Bool, _ why: @autoclosure () -> String) throws {
    if !condition { throw Failure(why: why()) }
  }

  static func check(_ name: String, _ body: () throws -> Void) {
    do {
      try body()
      print("PASS \(name)")
    } catch let failure as Failure {
      print("FAIL \(name): \(failure.why)")
      failures += 1
    } catch {
      print("FAIL \(name): threw \(error)")
      failures += 1
    }
  }

  /// Model A: `Thing` with `key` and `name`. Model B adds `extra`, so B's `Thing` hash differs.
  static func thingModel(extra: Bool = false) -> NSManagedObjectModel {
    let entity = NSEntityDescription()
    entity.name = "Thing"
    entity.managedObjectClassName = NSStringFromClass(NSManagedObject.self)
    entity.properties = (["key", "name"] + (extra ? ["extra"] : [])).map { name in
      let attribute = NSAttributeDescription()
      attribute.name = name
      attribute.attributeType = .stringAttributeType
      attribute.isOptional = true
      return attribute
    }
    let model = NSManagedObjectModel()
    model.entities = [entity]
    return model
  }

  /// A fresh folder per case, so no case reads another's store.
  static func folder(_ name: String) throws -> URL {
    let url = scratch.appendingPathComponent(name)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  /// A compiled model on disk, as the opener loads Apple's: a `.mom` is a keyed archive.
  static func writeMom(_ model: NSManagedObjectModel, to url: URL) throws {
    let data = try NSKeyedArchiver.archivedData(withRootObject: model, requiringSecureCoding: true)
    try data.write(to: url)
  }

  /// A versioned `.momd`: the `.mom` plus the `VersionInfo.plist` naming the current version.
  static func writeMomd(_ model: NSManagedObjectModel, version: String, to url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    try writeMom(model, to: url.appendingPathComponent("\(version).mom"))
    let info: [String: Any] = [
      "NSManagedObjectModel_CurrentVersionName": version,
      "NSManagedObjectModel_VersionHashes": [version: model.entityVersionHashesByName],
    ]
    let plist = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
    try plist.write(to: url.appendingPathComponent("VersionInfo.plist"))
  }

  static let storeOptions: [String: Any] = [
    NSPersistentHistoryTrackingKey: true,
    NSPersistentStoreRemoteChangeNotificationPostOptionKey: true,
  ]

  /// A store created from `model` with two things, `k1` "Alpha" and `k2` "Beta", plus any `more`.
  static func makeStore(
    at url: URL, model: NSManagedObjectModel, more: [(String, String)] = []
  ) throws {
    let coordinator = NSPersistentStoreCoordinator(managedObjectModel: model)
    let store = try coordinator.addPersistentStore(
      type: .sqlite, at: url, options: storeOptions)
    let context = NSManagedObjectContext(.privateQueue)
    context.persistentStoreCoordinator = coordinator
    try context.performAndWait {
      for (key, name) in [("k1", "Alpha"), ("k2", "Beta")] + more {
        let thing = NSEntityDescription.insertNewObject(forEntityName: "Thing", into: context)
        thing.setValue(key, forKey: "key")
        thing.setValue(name, forKey: "name")
      }
      try context.save()
    }
    try coordinator.remove(store)
  }

  /// Opens `url` on its own coordinator and runs `body` there, as a reader independent of the
  /// opener would.
  static func reading<T>(
    _ url: URL, model: NSManagedObjectModel, _ body: (NSManagedObjectContext) throws -> T
  ) throws -> T {
    let coordinator = NSPersistentStoreCoordinator(managedObjectModel: model)
    let store = try coordinator.addPersistentStore(type: .sqlite, at: url, options: storeOptions)
    defer { try? coordinator.remove(store) }
    let context = NSManagedObjectContext(.privateQueue)
    context.persistentStoreCoordinator = coordinator
    return try withExtendedLifetime(model) { try context.performAndWait { try body(context) } }
  }

  static func currentName(of key: String, in context: NSManagedObjectContext) throws -> String? {
    let request = NSFetchRequest<NSManagedObject>(entityName: "Thing")
    request.predicate = NSPredicate(format: "key == %@", key)
    return try context.fetch(request).first?.value(forKey: "name") as? String
  }

  static func opener(
    _ modelURL: URL, _ storeURL: URL, measured: Set<String> = []
  ) -> CoreDataStore {
    CoreDataStore(
      modelURL: modelURL, storeURL: storeURL, patch: { _ in }, measuredVersions: measured)
  }

  /// Sets `k1`'s name through the opener.
  static func rename(_ store: CoreDataStore, to newName: String) throws {
    try store.write { context in
      let thing = try CoreDataStore.fetchOne("Thing", key: "key", value: "k1", in: context)
      thing.setValue(newName, forKey: "name")
    }
  }

  // MARK: - Voice Memos

  /// The real Voice Memos model, copied and patched exactly as the writer does it.
  static func voiceMemosModel() throws -> NSManagedObjectModel {
    guard let loaded = NSManagedObjectModel(contentsOf: VoiceMemosWriter.modelURL),
      let model = loaded.copy() as? NSManagedObjectModel
    else { throw Failure(why: "the Voice Memos model did not load") }
    VoiceMemosWriter.patch(model)
    return model
  }

  /// A Voice Memos store built from the real model, holding synthetic rows only: folders `F-ONE`
  /// (rank 0, count 1) and `F-TWO` (rank 1, count 0), recordings `R-ONE` ("Synthetic one", in
  /// `F-ONE`) and `R-TWO` ("Synthetic two", in no folder).
  static func makeVoiceMemosStore(at url: URL, model: NSManagedObjectModel) throws {
    let coordinator = NSPersistentStoreCoordinator(managedObjectModel: model)
    let store = try coordinator.addPersistentStore(type: .sqlite, at: url, options: storeOptions)
    let context = NSManagedObjectContext(.privateQueue)
    context.persistentStoreCoordinator = coordinator
    try withExtendedLifetime(model) {
      try context.performAndWait {
        var folders: [String: NSManagedObject] = [:]
        for (uuid, name, rank, count) in [
          ("F-ONE", "Synthetic folder one", 0, 1), ("F-TWO", "Synthetic folder two", 1, 0),
        ] {
          let folder = NSEntityDescription.insertNewObject(forEntityName: "Folder", into: context)
          folder.setValue(uuid, forKey: "uuid")
          folder.setValue(name, forKey: "encryptedName")
          folder.setValue(Int64(rank), forKey: "rank")
          folder.setValue(Int64(count), forKey: "countOfRecordings")
          folders[uuid] = folder
        }
        for (id, title, folder) in [
          ("R-ONE", "Synthetic one", folders["F-ONE"]), ("R-TWO", "Synthetic two", nil),
        ] {
          let recording = NSEntityDescription.insertNewObject(
            forEntityName: "CloudRecording", into: context)
          recording.setValue(id, forKey: "uniqueID")
          recording.setValue(title, forKey: "encryptedTitle")
          recording.setValue(title, forKey: "customLabelForSorting")
          recording.setValue(folder, forKey: "folder")
        }
        try context.save()
      }
    }
    try coordinator.remove(store)
  }

  /// A fresh fixture per case, and the writer over it with the production patch.
  static func voiceMemosFixture(_ name: String) throws -> (VoiceMemosWriter, URL) {
    let storeURL = try folder("voice-memos-\(name)").appendingPathComponent("CloudRecordings.db")
    try makeVoiceMemosStore(at: storeURL, model: voiceMemosModel())
    return (VoiceMemosWriter(store: VoiceMemosWriter.store(at: storeURL)), storeURL)
  }

  /// Runs `body` against the fixture on an independent coordinator, saving if it changed
  /// anything.
  static func voiceMemos<T>(_ storeURL: URL, _ body: (NSManagedObjectContext) throws -> T) throws
    -> T
  {
    try reading(storeURL, model: voiceMemosModel()) { context in
      let result = try body(context)
      if context.hasChanges { try context.save() }
      return result
    }
  }

  static func row(
    _ entity: String, _ key: String, _ value: String, in context: NSManagedObjectContext
  )
    throws -> NSManagedObject
  {
    let request = NSFetchRequest<NSManagedObject>(entityName: entity)
    request.predicate = NSPredicate(format: "%K == %@", key, value)
    guard let row = try context.fetch(request).first else {
      throw Failure(why: "no \(entity) \(value) in the fixture")
    }
    return row
  }

  static func recording(_ storeURL: URL, _ id: String, _ key: String) throws -> Any? {
    try voiceMemos(storeURL) {
      try row("CloudRecording", "uniqueID", id, in: $0).value(forKey: key)
    }
  }

  static func folderCount(_ storeURL: URL, _ uuid: String) throws -> Int64? {
    try voiceMemos(storeURL) {
      try row("Folder", "uuid", uuid, in: $0).value(forKey: "countOfRecordings") as? Int64
    }
  }

  /// The number of history transactions, and the last one's author and changed attribute names
  /// per change.
  static func history(_ storeURL: URL) throws -> (
    count: Int, author: String?, changes: [[String]]
  ) {
    try voiceMemos(storeURL) { context in
      let request = NSPersistentHistoryChangeRequest.fetchHistory(after: .distantPast)
      request.resultType = .transactionsAndChanges
      let result = try context.execute(request) as? NSPersistentHistoryResult
      let transactions = result?.result as? [NSPersistentHistoryTransaction] ?? []
      let changes = (transactions.last?.changes ?? []).map {
        ($0.updatedProperties ?? []).map(\.name).sorted()
      }
      return (transactions.count, transactions.last?.author, changes)
    }
  }

  /// `body` throws a `StoreLaneError` whose reason is `reason`; returns its message.
  @discardableResult
  static func expectRefusal(_ reason: String, _ label: String, _ body: () throws -> Void) throws
    -> String
  {
    do {
      try body()
    } catch let error as StoreLaneError {
      try expect(error.reason == reason, "\(label) threw \(error.reason), not \(reason)")
      return error.message
    }
    throw Failure(why: "\(label) did not throw")
  }

  // MARK: - The lane's dispatch

  /// One request line, as the node client sends it.
  static func request(_ id: Int, _ method: String, _ params: [String: Any]? = nil) throws
    -> String
  {
    var object: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
    if let params { object["params"] = params }
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    return String(decoding: data, as: UTF8.self)
  }

  /// `line` through the lane, parsed: one JSON object on one line, no trailing newline.
  static func reply(
    _ line: String, borrower: String = "voice-memos", allowWrites: Bool = true,
    _ writer: VoiceMemosWriter
  ) throws -> [String: Any] {
    try parse(
      StoreLane.handle(line, borrower: borrower, allowWrites: allowWrites, voiceMemos: writer))
  }

  static func parse(_ text: String) throws -> [String: Any] {
    try expect(!text.contains("\n"), "the reply has a line break: \(text)")
    guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
    else { throw Failure(why: "the reply is not a JSON object: \(text)") }
    try expect(object["jsonrpc"] as? String == "2.0", "the reply's jsonrpc is not 2.0: \(text)")
    return object
  }

  /// The reply's error code, `data.reason` and message; fails if the reply is a result.
  static func failure(_ reply: [String: Any]) throws -> (
    code: Int, reason: String?, message: String
  ) {
    guard let error = reply["error"] as? [String: Any], reply["result"] == nil,
      let code = error["code"] as? Int, let message = error["message"] as? String
    else { throw Failure(why: "not an error reply: \(reply)") }
    return (code, (error["data"] as? [String: Any])?["reason"] as? String, message)
  }

  /// A writer over a store that is not there: a case that reaches it fails with `notFound`.
  static func absentWriter() -> VoiceMemosWriter {
    VoiceMemosWriter(
      store: VoiceMemosWriter.store(at: scratch.appendingPathComponent("absent/none.db")))
  }

  /// What the writer and the fixture touch. A model without one of these (another macOS's
  /// Voice Memos) cannot exercise the writer, so the group skips rather than fails.
  static let voiceMemosNeeds: [String: [String]] = [
    "CloudRecording": [
      "uniqueID", "encryptedTitle", "customLabelForSorting", "sharedFlags", "evictionDate",
      "folder",
    ],
    "Folder": ["uuid", "countOfRecordings", "recordings"],
  ]

  /// `Entity.property` for each needed property `model` lacks, sorted.
  static func voiceMemosLacks(_ model: NSManagedObjectModel) -> [String] {
    voiceMemosNeeds.flatMap { entity, names in
      let properties = model.entitiesByName[entity]?.propertiesByName ?? [:]
      return names.filter { properties[$0] == nil }.map { "\(entity).\($0)" }
    }.sorted()
  }

  /// The `.momd`'s current version name, read the way the opener reads it.
  static func voiceMemosVersion() -> String {
    let info = VoiceMemosWriter.modelURL.appendingPathComponent("VersionInfo.plist")
    guard let data = try? Data(contentsOf: info),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil)
        as? [String: Any],
      let version = plist["NSManagedObjectModel_CurrentVersionName"] as? String
    else { return "unversioned" }
    return version
  }

  static func voiceMemosCases() {
    guard FileManager.default.fileExists(atPath: VoiceMemosWriter.modelURL.path) else {
      print("SKIP voice-memos: model not on this machine")
      return
    }
    let version = voiceMemosVersion()
    guard let loaded = NSManagedObjectModel(contentsOf: VoiceMemosWriter.modelURL),
      let unpatchedModel = loaded.copy() as? NSManagedObjectModel,
      let patchedModel = try? voiceMemosModel()
    else {
      print("FAIL voice-memos: the model (\(version)) is on this machine but did not load")
      failures += 1
      return
    }
    let lacks = voiceMemosLacks(patchedModel)
    guard lacks.isEmpty else {
      print("SKIP voice-memos: model \(version) lacks \(lacks.joined(separator: ", "))")
      return
    }
    let patchChangesHash =
      unpatchedModel.entitiesByName["CloudRecording"]?.versionHash
      != patchedModel.entitiesByName["CloudRecording"]?.versionHash

    check("renameSetsTitleAndSortKey") {
      let (writer, storeURL) = try voiceMemosFixture("rename")
      let result = try writer.rename(id: "R-ONE", title: "  Synthetic renamed ")
      try expect(result.id == "R-ONE", "id is \(result.id)")
      try expect(
        result.changed == ["customLabelForSorting", "encryptedTitle"],
        "changed is \(result.changed)")
      try expect(result.modelVersion != nil, "no model version")
      try expect(
        result.syncMeasured == (result.modelVersion == "VoiceMemos14"),
        "syncMeasured \(result.syncMeasured) for \(result.modelVersion ?? "nil")")
      for key in ["encryptedTitle", "customLabelForSorting"] {
        let value = try recording(storeURL, "R-ONE", key) as? String
        try expect(value == "Synthetic renamed", "\(key) reads back as \(value ?? "nil")")
      }
      let other = try recording(storeURL, "R-TWO", "encryptedTitle") as? String
      try expect(other == "Synthetic two", "R-TWO's title changed to \(other ?? "nil")")
    }

    check("renameRefusesBadTitles") {
      let (writer, storeURL) = try voiceMemosFixture("rename-bad")
      for (title, label) in [
        ("", "empty"), ("   ", "blank"), ("a\nb", "newline"),
        (String(repeating: "a", count: 501), "501 characters"),
      ] {
        try expectRefusal("invalid", label) { _ = try writer.rename(id: "R-ONE", title: title) }
      }
      let title = try recording(storeURL, "R-ONE", "encryptedTitle") as? String
      try expect(title == "Synthetic one", "the title changed to \(title ?? "nil")")
      // 500 is the limit, not past it.
      let result = try writer.rename(id: "R-ONE", title: String(repeating: "a", count: 500))
      try expect(!result.changed.isEmpty, "500 characters changed nothing")
    }

    check("favoriteSetsAndClearsBitZero") {
      let (writer, storeURL) = try voiceMemosFixture("favorite")
      try expect(try recording(storeURL, "R-ONE", "sharedFlags") == nil, "sharedFlags is not nil")
      let on = try writer.setFavorite(id: "R-ONE", favorite: true)
      try expect(on.changed == ["sharedFlags"], "on changed \(on.changed)")
      let set = try recording(storeURL, "R-ONE", "sharedFlags") as? Int64
      try expect(set == 1, "on gives \(set.map(String.init) ?? "nil"), not 1")
      try voiceMemos(storeURL) {
        try row("CloudRecording", "uniqueID", "R-ONE", in: $0).setValue(
          Int64(5), forKey: "sharedFlags")
      }
      let off = try writer.setFavorite(id: "R-ONE", favorite: false)
      try expect(off.changed == ["sharedFlags"], "off changed \(off.changed)")
      let cleared = try recording(storeURL, "R-ONE", "sharedFlags") as? Int64
      try expect(cleared == 4, "off from 5 gives \(cleared.map(String.init) ?? "nil"), not 4")
      // Clearing a favourite that was never set is a no-op, not a 0.
      let never = try writer.setFavorite(id: "R-TWO", favorite: false)
      try expect(never.changed.isEmpty, "clearing nil changed \(never.changed)")
      try expect(
        try recording(storeURL, "R-TWO", "sharedFlags") == nil, "clearing nil wrote a value")
    }

    check("moveKeepsBothCounts") {
      let (writer, storeURL) = try voiceMemosFixture("move")
      let moved = try writer.move(id: "R-ONE", folderId: "F-TWO")
      try expect(moved.changed == ["folder"], "changed is \(moved.changed)")
      let (one, two) = (try folderCount(storeURL, "F-ONE"), try folderCount(storeURL, "F-TWO"))
      try expect(one == 0 && two == 1, "counts are F-ONE \(one ?? -1), F-TWO \(two ?? -1)")
      _ = try writer.delete(id: "R-ONE")
      try expect(try folderCount(storeURL, "F-TWO") == 1, "the delete changed F-TWO's count")
      let out = try writer.move(id: "R-ONE", folderId: nil)
      try expect(out.changed == ["folder"], "out changed \(out.changed)")
      let after = try folderCount(storeURL, "F-TWO")
      try expect(after == 0, "F-TWO counts \(after ?? -1) after the move out, not 0")
      let folder = try recording(storeURL, "R-ONE", "folder")
      try expect(folder == nil, "R-ONE is still in a folder")
    }

    check("moveRefusesUnknownFolder") {
      let (writer, storeURL) = try voiceMemosFixture("move-unknown")
      try expectRefusal("notFound", "F-NONE") {
        _ = try writer.move(id: "R-ONE", folderId: "F-NONE")
      }
      try expect(try folderCount(storeURL, "F-ONE") == 1, "F-ONE's count changed")
    }

    check("deleteAndRestoreTouchOnlyEvictionDate") {
      let (writer, storeURL) = try voiceMemosFixture("delete")
      for (label, call) in [
        ("delete", { try writer.delete(id: "R-ONE") }),
        ("restore", { try writer.restore(id: "R-ONE") }),
      ] as [(String, () throws -> VoiceMemosWriter.Result)] {
        let result = try call()
        try expect(result.changed == ["evictionDate"], "\(label) changed \(result.changed)")
        let evicted = try recording(storeURL, "R-ONE", "evictionDate") as? Date
        try expect(
          (evicted != nil) == (label == "delete"),
          "after \(label) evictionDate is \(evicted.map { "\($0)" } ?? "nil")")
        let last = try history(storeURL)
        try expect(last.author == "cupertino", "\(label) author is \(last.author ?? "nil")")
        try expect(
          last.changes == [["evictionDate"]], "\(label) history changes are \(last.changes)")
      }
    }

    check("noOpWritesNoHistory") {
      let (writer, storeURL) = try voiceMemosFixture("no-op")
      _ = try writer.delete(id: "R-ONE")
      _ = try writer.setFavorite(id: "R-ONE", favorite: true)
      let before = try history(storeURL).count
      let noOps: [(String, () throws -> VoiceMemosWriter.Result)] = [
        ("a second delete", { try writer.delete(id: "R-ONE") }),
        ("a repeated favourite", { try writer.setFavorite(id: "R-ONE", favorite: true) }),
        ("a move to the current folder", { try writer.move(id: "R-ONE", folderId: "F-ONE") }),
        ("a move out of no folder", { try writer.move(id: "R-TWO", folderId: nil) }),
        ("the same title", { try writer.rename(id: "R-TWO", title: "Synthetic two ") }),
        ("restoring a memo not deleted", { try writer.restore(id: "R-TWO") }),
      ]
      for (label, call) in noOps {
        let result = try call()
        try expect(result.changed.isEmpty, "\(label) changed \(result.changed)")
      }
      let after = try history(storeURL).count
      try expect(after == before, "the no-ops wrote \(after - before) history transactions")
    }

    check("unknownRecordingIsNotFound") {
      let (writer, _) = try voiceMemosFixture("unknown")
      try expectRefusal("notFound", "R-NONE") { _ = try writer.rename(id: "R-NONE", title: "x") }
    }

    check("renameRoundTrip") {
      let (writer, storeURL) = try voiceMemosFixture("lane-rename")
      let line = try request(
        41, "voiceMemos.rename", ["id": "R-ONE", "title": "Synthetic renamed"])
      let text = StoreLane.handle(
        line, borrower: "voice-memos", allowWrites: true, voiceMemos: writer)
      // As given: 41, not 41.0 or "41".
      try expect(
        text.range(of: #""id":41[,}]"#, options: .regularExpression) != nil,
        "id 41 is not echoed as given: \(text)")
      let answer = try parse(text)
      guard let result = answer["result"] as? [String: Any], answer["error"] == nil else {
        throw Failure(why: "not a result: \(answer)")
      }
      try expect(answer["id"] as? Int == 41, "id is \(answer["id"] ?? "absent")")
      try expect(
        Set(result.keys) == ["id", "changed", "modelVersion", "syncMeasured"],
        "result keys are \(result.keys.sorted())")
      try expect(result["id"] as? String == "R-ONE", "result id is \(result["id"] ?? "absent")")
      try expect(
        result["changed"] as? [String] == ["customLabelForSorting", "encryptedTitle"],
        "changed is \(result["changed"] ?? "absent")")
      let measured = VoiceMemosWriter.measuredVersions.contains(voiceMemosVersion())
      try expect(result["modelVersion"] as? String == voiceMemosVersion(), "modelVersion differs")
      try expect(result["syncMeasured"] as? Bool == measured, "syncMeasured differs")
      let title = try recording(storeURL, "R-ONE", "encryptedTitle") as? String
      try expect(title == "Synthetic renamed", "the title reads back as \(title ?? "nil")")

      // Every other write method, in one pass, with the params the node client sends.
      for (method, params, changed) in [
        ("voiceMemos.setFavorite", ["id": "R-ONE", "favorite": true], ["sharedFlags"]),
        ("voiceMemos.move", ["id": "R-ONE", "folderId": NSNull()], ["folder"]),
        ("voiceMemos.move", ["id": "R-ONE", "folderId": "F-TWO"], ["folder"]),
        ("voiceMemos.delete", ["id": "R-ONE"], ["evictionDate"]),
        ("voiceMemos.restore", ["id": "R-ONE"], ["evictionDate"]),
      ] as [(String, [String: Any], [String])] {
        let answer = try reply(request(2, method, params), writer)
        let result = answer["result"] as? [String: Any]
        try expect(
          result?["changed"] as? [String] == changed, "\(method) answered \(answer)")
      }
      try expect(try folderCount(storeURL, "F-TWO") == 1, "F-TWO's count is not 1 after the move")
    }

    check("writesOffRefusedStatusAnswers") {
      let (writer, storeURL) = try voiceMemosFixture("lane-writes-off")
      let before = try history(storeURL).count
      for (method, params) in [
        ("voiceMemos.rename", ["id": "R-ONE", "title": "Synthetic renamed"]),
        ("voiceMemos.setFavorite", ["id": "R-ONE", "favorite": true]),
        ("voiceMemos.move", ["id": "R-ONE", "folderId": "F-TWO"]),
        ("voiceMemos.delete", ["id": "R-ONE"]),
        ("voiceMemos.restore", ["id": "R-ONE"]),
        // Refused before its params are read: a malformed write is still a write.
        ("voiceMemos.rename", [:]),
      ] as [(String, [String: Any])] {
        let answer = try reply(request(3, method, params), allowWrites: false, writer)
        let (code, reason, message) = try failure(answer)
        try expect(code == -32000, "\(method) code is \(code)")
        try expect(reason == "writesOff", "\(method) reason is \(reason ?? "nil")")
        try expect(
          message == "writes are off for Voice Memos in Cupertino", "\(method) says \(message)")
        try expect(answer["id"] as? Int == 3, "\(method) id is \(answer["id"] ?? "absent")")
      }
      let after = try history(storeURL).count
      try expect(after == before, "writes-off calls wrote \(after - before) transactions")
      let title = try recording(storeURL, "R-ONE", "encryptedTitle") as? String
      try expect(title == "Synthetic one", "the title changed to \(title ?? "nil")")

      for params in [nil, [:]] as [[String: Any]?] {
        let answer = try reply(request(4, "voiceMemos.status", params), allowWrites: false, writer)
        guard let result = answer["result"] as? [String: Any] else {
          throw Failure(why: "status is not a result: \(answer)")
        }
        try expect(
          Set(result.keys) == ["compatible", "modelVersion", "syncMeasured", "refusal"],
          "status keys are \(result.keys.sorted())")
        try expect(result["compatible"] as? Bool == true, "status is not compatible: \(result)")
        try expect(
          result["refusal"] is NSNull, "status refusal is \(result["refusal"] ?? "absent")")
        try expect(
          result["modelVersion"] as? String == voiceMemosVersion(), "status version differs")
      }
    }

    check("missingParamsIsInvalid") {
      let (writer, storeURL) = try voiceMemosFixture("lane-invalid")
      let before = try history(storeURL).count
      let secret = "Synthetic secret title"
      for (label, line) in [
        ("rename {id}", try request(5, "voiceMemos.rename", ["id": "R-ONE"])),
        ("rename, no params", try request(5, "voiceMemos.rename")),
        ("rename, numeric id", try request(5, "voiceMemos.rename", ["id": 7, "title": secret])),
        (
          "rename, numeric title", try request(5, "voiceMemos.rename", ["id": "R-ONE", "title": 7])
        ),
        (
          "rename, blank title", try request(5, "voiceMemos.rename", ["id": "R-ONE", "title": " "])
        ),
        (
          "setFavorite 1, not true",
          try request(5, "voiceMemos.setFavorite", ["id": "R-ONE", "favorite": 1])
        ),
        ("move {id}", try request(5, "voiceMemos.move", ["id": "R-ONE"])),
        (
          "move, numeric folder", try request(5, "voiceMemos.move", ["id": "R-ONE", "folderId": 5])
        ),
        ("delete {}", try request(5, "voiceMemos.delete", [:])),
        (
          "params an array",
          #"{"jsonrpc":"2.0","id":5,"method":"voiceMemos.restore","params":["R-ONE"]}"#
        ),
      ] {
        let (code, reason, message) = try failure(reply(line, writer))
        try expect(code == -32000, "\(label): code \(code)")
        try expect(reason == "invalid", "\(label): reason \(reason ?? "nil")")
        for value in ["R-ONE", secret] {
          try expect(!message.contains(value), "\(label): the message repeats a value: \(message)")
        }
      }
      // An unknown recording names no value either.
      let line = try request(6, "voiceMemos.rename", ["id": "R-SECRET", "title": secret])
      let (_, reason, message) = try failure(reply(line, writer))
      try expect(reason == "notFound", "an unknown recording is \(reason ?? "nil")")
      try expect(
        !message.contains("R-SECRET") && !message.contains(secret),
        "the notFound message repeats a value: \(message)")
      let after = try history(storeURL).count
      try expect(after == before, "invalid calls wrote \(after - before) transactions")
    }

    // Only a patch that moves the hash makes an unpatched opener refuse the store.
    guard patchChangesHash else {
      print(
        "SKIP unpatchedModelIsRefused: the patch does not change this model's CloudRecording "
          + "hash (\(version))")
      return
    }
    check("unpatchedModelIsRefused") {
      let (_, storeURL) = try voiceMemosFixture("unpatched")
      let unpatched = VoiceMemosWriter(
        store: CoreDataStore(
          modelURL: VoiceMemosWriter.modelURL, storeURL: storeURL, patch: { _ in },
          measuredVersions: VoiceMemosWriter.measuredVersions))
      let message = try expectRefusal("incompatible", "the unpatched model") {
        _ = try unpatched.rename(id: "R-ONE", title: "Synthetic renamed")
      }
      try expect(message.contains("CloudRecording"), "the refusal does not name CloudRecording")
      let status = unpatched.status()
      try expect(!status.compatible, "status() calls the unpatched model compatible")
      try expect(
        VoiceMemosWriter(store: VoiceMemosWriter.store(at: storeURL)).status().compatible,
        "status() calls the patched model incompatible")
    }
  }

  static func main() {
    let modelA = thingModel()

    check("opensMatchingStore") {
      let dir = try folder("opens")
      let storeURL = dir.appendingPathComponent("Things.sqlite")
      let modelURL = dir.appendingPathComponent("Thing.mom")
      try makeStore(at: storeURL, model: modelA)
      try writeMom(modelA, to: modelURL)
      try rename(opener(modelURL, storeURL), to: "Gamma")
      let name = try reading(storeURL, model: modelA) { try currentName(of: "k1", in: $0) }
      try expect(name == "Gamma", "k1 reads back as \(name ?? "nil"), not Gamma")
      let other = try reading(storeURL, model: modelA) { try currentName(of: "k2", in: $0) }
      try expect(other == "Beta", "k2 changed to \(other ?? "nil")")
    }

    check("refusesMismatchedStore") {
      let dir = try folder("mismatch")
      let storeURL = dir.appendingPathComponent("Things.sqlite")
      let modelURL = dir.appendingPathComponent("ThingB.mom")
      try makeStore(at: storeURL, model: modelA)
      try writeMom(thingModel(extra: true), to: modelURL)
      let before = try NSPersistentStoreCoordinator.metadataForPersistentStore(
        type: .sqlite, at: storeURL)
      do {
        try rename(opener(modelURL, storeURL), to: "Gamma")
        try expect(false, "the write went ahead on a store model B does not match")
      } catch let error as StoreLaneError {
        guard case .incompatible(let message) = error else {
          throw Failure(why: "threw \(error.reason), not incompatible")
        }
        try expect(message.contains("Thing"), "the refusal does not name Thing: \(message)")
      }
      let after = try NSPersistentStoreCoordinator.metadataForPersistentStore(
        type: .sqlite, at: storeURL)
      try expect(
        (before as NSDictionary).isEqual(to: after), "the store's metadata changed (a migration)")
      let status = opener(modelURL, storeURL).status()
      try expect(!status.compatible, "status() calls the mismatched store compatible")
      try expect(status.refusal?.contains("Thing") == true, "status() refusal does not name Thing")
    }

    check("writesHistoryWithAuthor") {
      let dir = try folder("history")
      let storeURL = dir.appendingPathComponent("Things.sqlite")
      let modelURL = dir.appendingPathComponent("Thing.mom")
      try makeStore(at: storeURL, model: modelA)
      try writeMom(modelA, to: modelURL)
      try rename(opener(modelURL, storeURL), to: "Gamma")
      try reading(storeURL, model: modelA) { context in
        let request = NSPersistentHistoryChangeRequest.fetchHistory(after: .distantPast)
        request.resultType = .transactionsAndChanges
        let result = try context.execute(request) as? NSPersistentHistoryResult
        let transactions = result?.result as? [NSPersistentHistoryTransaction] ?? []
        guard let last = transactions.last else { throw Failure(why: "no history at all") }
        try expect(last.author == "cupertino", "the last author is \(last.author ?? "nil")")
        let changes = last.changes ?? []
        try expect(changes.count == 1, "the last transaction has \(changes.count) changes")
        let updated = Set(changes.first?.updatedProperties?.compactMap(\.name) ?? [])
        try expect(updated == ["name"], "updatedProperties is \(updated.sorted())")
      }
    }

    check("statusReportsVersion") {
      let dir = try folder("version")
      let storeURL = dir.appendingPathComponent("Things.sqlite")
      let momdURL = dir.appendingPathComponent("Thing.momd")
      try makeStore(at: storeURL, model: modelA)
      try writeMomd(modelA, version: "Thing3", to: momdURL)
      let measured = opener(momdURL, storeURL, measured: ["Thing2", "Thing3"]).status()
      try expect(
        measured
          == CoreDataStore.Status(
            compatible: true, modelVersion: "Thing3", syncMeasured: true, refusal: nil),
        "measured: \(measured)")
      let unmeasured = opener(momdURL, storeURL, measured: ["Thing2"]).status()
      try expect(
        unmeasured.modelVersion == "Thing3" && !unmeasured.syncMeasured && unmeasured.compatible,
        "unmeasured: \(unmeasured)")
      // A bare `.mom` has no VersionInfo.plist: no version, so sync is never promised.
      let momURL = dir.appendingPathComponent("Thing.mom")
      try writeMom(modelA, to: momURL)
      let bare = opener(momURL, storeURL, measured: ["Thing3"]).status()
      try expect(bare.modelVersion == nil && !bare.syncMeasured, "bare .mom: \(bare)")
    }

    check("fetchOneRefusesZeroAndTwo") {
      let dir = try folder("fetch")
      let storeURL = dir.appendingPathComponent("Things.sqlite")
      let modelURL = dir.appendingPathComponent("Thing.mom")
      try makeStore(at: storeURL, model: modelA, more: [("k2", "Beta again")])
      try writeMom(modelA, to: modelURL)
      let store = opener(modelURL, storeURL)
      for (key, label) in [("k9", "zero"), ("k2", "two")] {
        do {
          try store.write { context in
            _ = try CoreDataStore.fetchOne("Thing", key: "key", value: key, in: context)
          }
          throw Failure(why: "\(label) matches did not throw")
        } catch let error as StoreLaneError {
          guard case .notFound = error else {
            throw Failure(why: "\(label) matches threw \(error.reason), not notFound")
          }
        }
      }
    }

    check("admitsOnlyItsOwnServer") {
      try expect(
        StoreLane.admit(borrowerId: "voice-memos", peerSurface: "voice-memos") == nil,
        "the voice-memos server is refused its own lane")
      for peer in ["mail", nil] as [String?] {
        let refusal = StoreLane.admit(borrowerId: "voice-memos", peerSurface: peer)
        try expect(
          refusal == "this connection is not a voice-memos server",
          "peer \(peer ?? "nil") gets \(refusal ?? "admitted")")
      }
      let mail = StoreLane.admit(borrowerId: "mail", peerSurface: "mail")
      try expect(mail == "'mail' has no store lane", "mail gets \(mail ?? "admitted")")
      try expect(StoreLane.surfaces == ["voice-memos"], "surfaces is \(StoreLane.surfaces)")
    }

    check("garbageIsParseError") {
      for line in ["", "not json", #"{"jsonrpc":"2.0","id":1,"#, #"{"id":1}}"#] {
        let answer = try reply(line, absentWriter())
        let (code, reason, _) = try failure(answer)
        try expect(code == -32700, "\(line.debugDescription): code \(code)")
        try expect(answer["id"] is NSNull, "\(line.debugDescription): id is not null")
        try expect(reason == "invalid", "\(line.debugDescription): reason \(reason ?? "nil")")
      }
      // JSON, but not a request: a batch, no method, another protocol version, a bad id.
      for line in [
        #"[{"jsonrpc":"2.0","id":1,"method":"voiceMemos.status"}]"#,
        #"{"jsonrpc":"2.0","id":1}"#,
        #"{"jsonrpc":"1.0","id":1,"method":"voiceMemos.status"}"#,
        #"{"jsonrpc":"2.0","id":true,"method":"voiceMemos.status"}"#,
        #"{"jsonrpc":"2.0","id":{"a":1},"method":"voiceMemos.status"}"#,
      ] {
        let (code, reason, _) = try failure(reply(line, absentWriter()))
        try expect(code == -32600, "\(line): code \(code)")
        try expect(reason == "invalid", "\(line): reason \(reason ?? "nil")")
      }
    }

    check("foreignNamespaceIsUnknownMethod") {
      for (borrower, method) in [
        ("voice-memos", "maps.add"), ("voice-memos", "voiceMemos.nope"),
        ("voice-memos", "voiceMemos."), ("voice-memos", "voicememos.status"),
        ("mail", "voiceMemos.status"), ("mail", "voiceMemos.rename"),
      ] {
        let answer = try reply(
          request(7, method, ["id": "R-ONE", "title": "Synthetic"]), borrower: borrower,
          absentWriter())
        let (code, _, _) = try failure(answer)
        try expect(code == -32601, "\(method) from \(borrower): code \(code)")
        try expect(answer["id"] as? Int == 7, "\(method) from \(borrower): id not echoed")
      }
      // A string id is echoed too.
      let line = #"{"jsonrpc":"2.0","id":"q-1","method":"maps.add"}"#
      let answer = try reply(line, absentWriter())
      try expect(answer["id"] as? String == "q-1", "a string id is not echoed: \(answer)")
    }

    voiceMemosCases()

    // Not a `defer`: `exit` never returns, so a deferred removal would never run.
    try? FileManager.default.removeItem(at: scratch)
    exit(failures == 0 ? 0 : 1)
  }
}
