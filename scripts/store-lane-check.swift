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
/// an app's iCloud exporter reads, and a fetch by id that quietly picks one of two rows.
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

    // Not a `defer`: `exit` never returns, so a deferred removal would never run.
    try? FileManager.default.removeItem(at: scratch)
    exit(failures == 0 ? 0 : 1)
  }
}
