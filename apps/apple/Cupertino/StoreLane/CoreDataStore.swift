import CoreData
import Foundation

/// Opens an Apple app's Core Data store with that app's own compiled model, so a save writes the
/// persistent history the app's iCloud exporter reads, and never migrates the store.
///
/// The steps, in the order the design gives them: load the model and copy it, apply the
/// surface's measured runtime patch, refuse unless the store's metadata is compatible with the
/// patched model, then open with history tracking and remote-change notifications on and
/// migration off. A coordinator is opened per call and dropped after it, so the app never holds
/// Apple's store open between writes.
nonisolated struct CoreDataStore: Sendable {
  /// What diagnostics reports before anyone writes.
  struct Status: Equatable {
    /// The patched model is compatible with the store's metadata.
    var compatible: Bool
    /// The `.momd`'s current version name, nil without a `VersionInfo.plist`.
    var modelVersion: String?
    /// `modelVersion` is one whose sync was measured on two devices.
    var syncMeasured: Bool
    /// Why a write would be refused, nil when it would go ahead.
    var refusal: String?
  }

  let modelURL: URL
  let storeURL: URL
  let patch: @Sendable (NSManagedObjectModel) -> Void
  let measuredVersions: Set<String>

  init(
    modelURL: URL, storeURL: URL, patch: @escaping @Sendable (NSManagedObjectModel) -> Void,
    measuredVersions: Set<String>
  ) {
    self.modelURL = modelURL
    self.storeURL = storeURL
    self.patch = patch
    self.measuredVersions = measuredVersions
  }

  /// Exactly these: no migration of Apple's store, ever, and history on so the save is exported.
  /// Computed: a `[String: Any]` constant is not concurrency-safe.
  static var storeOptions: [String: Any] {
    [
      NSPersistentHistoryTrackingKey: true,
      NSPersistentStoreRemoteChangeNotificationPostOptionKey: true,
      NSMigratePersistentStoresAutomaticallyOption: false,
      NSInferMappingModelAutomaticallyOption: false,
    ]
  }

  static let transactionAuthor = "cupertino"

  func status() -> Status {
    let version = modelVersion()
    let measured = version.map { measuredVersions.contains($0) } ?? false
    do {
      _ = try prepare()
      return Status(compatible: true, modelVersion: version, syncMeasured: measured, refusal: nil)
    } catch {
      return Status(
        compatible: false, modelVersion: version, syncMeasured: measured,
        refusal: Self.lift(error).message)
    }
  }

  /// Opens the store, runs `body` on a private-queue context, saves once if `body` changed
  /// anything, and drops the coordinator.
  func write<T>(_ body: (NSManagedObjectContext) throws -> T) throws -> T {
    let (model, configuration) = try prepare()
    // An entity does not retain its model (found 2026-11-10): keep it alive for the whole call,
    // not only as long as the coordinator happens to.
    return try withExtendedLifetime(model) {
      let coordinator = NSPersistentStoreCoordinator(managedObjectModel: model)
      let store: NSPersistentStore
      do {
        store = try coordinator.addPersistentStore(
          type: .sqlite, configuration: configuration, at: storeURL, options: Self.storeOptions)
      } catch {
        throw StoreLaneError.failed("the store did not open: \(error.localizedDescription)")
      }
      defer { try? coordinator.remove(store) }
      let context = NSManagedObjectContext(.privateQueue)
      context.persistentStoreCoordinator = coordinator
      context.transactionAuthor = Self.transactionAuthor
      do {
        return try withoutActuallyEscaping(body) { body in
          // `performAndWait` takes a `@Sendable` block, but runs it before it returns and
          // never beside the caller, so `body` is not shared across threads.
          nonisolated(unsafe) let body = body
          return try context.performAndWait {
            let result = try body(context)
            if context.hasChanges { try context.save() }
            return result
          }
        }
      } catch {
        throw Self.lift(error)
      }
    }
  }

  /// The one object of `entity` whose `key` equals `value`; `.notFound` for none or several.
  static func fetchOne(
    _ entity: String, key: String, value: String, in context: NSManagedObjectContext
  ) throws -> NSManagedObject {
    let request = NSFetchRequest<NSManagedObject>(entityName: entity)
    request.predicate = NSPredicate(format: "%K == %@", key, value)
    // Two is enough to tell one from several.
    request.fetchLimit = 2
    let rows: [NSManagedObject]
    do {
      rows = try context.fetch(request)
    } catch {
      throw StoreLaneError.failed("the fetch failed: \(error.localizedDescription)")
    }
    guard rows.count == 1, let row = rows.first else {
      throw StoreLaneError.notFound(
        "expected one \(entity) with that \(key), found \(rows.isEmpty ? "none" : "more than one")")
    }
    return row
  }

  /// Steps 1 to 3: the patched model, and the first configuration the store is compatible with.
  private func prepare() throws -> (NSManagedObjectModel, String?) {
    guard let loaded = NSManagedObjectModel(contentsOf: modelURL),
      let model = loaded.copy() as? NSManagedObjectModel
    else {
      throw StoreLaneError.failed("the model did not load from \(modelURL.path)")
    }
    patch(model)
    // Checked first: adding a store at a missing path would create an empty one.
    guard FileManager.default.fileExists(atPath: storeURL.path) else {
      throw StoreLaneError.notFound("no store at \(storeURL.path)")
    }
    let metadata: [String: Any]
    do {
      metadata = try NSPersistentStoreCoordinator.metadataForPersistentStore(
        type: .sqlite, at: storeURL)
    } catch {
      throw StoreLaneError.failed(
        "the store's metadata did not read: \(error.localizedDescription)")
    }
    // The order the 2026-11-10 measurement used: the default configuration, then each named one.
    let configurations: [String?] = [nil] + model.configurations
    guard
      let configuration = configurations.first(where: {
        model.isConfiguration(withName: $0, compatibleWithStoreMetadata: metadata)
      })
    else {
      let names = Self.mismatchedEntities(model, metadata)
      throw StoreLaneError.incompatible(
        "the store does not match this macOS's model (\(names.joined(separator: ", "))), "
          + "and the lane does not migrate it")
    }
    return (model, configuration)
  }

  /// The entities whose hash differs from the store's, and any the store has that the model
  /// lacks.
  private static func mismatchedEntities(
    _ model: NSManagedObjectModel, _ metadata: [String: Any]
  ) -> [String] {
    let stored = metadata[NSStoreModelVersionHashesKey] as? [String: Data] ?? [:]
    let current = model.entityVersionHashesByName
    let differs = current.filter { stored[$0.key] != $0.value }.keys
    let missing = stored.keys.filter { current[$0] == nil }
    return Set(differs).union(missing).sorted()
  }

  /// `modelURL/VersionInfo.plist`'s current version name.
  private func modelVersion() -> String? {
    let info = modelURL.appendingPathComponent("VersionInfo.plist")
    guard let data = try? Data(contentsOf: info),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil)
        as? [String: Any]
    else { return nil }
    return plist["NSManagedObjectModel_CurrentVersionName"] as? String
  }

  /// A thrown error as the lane reports it: its own errors as they are, anything else as failed.
  private static func lift(_ error: Error) -> StoreLaneError {
    (error as? StoreLaneError) ?? .failed(error.localizedDescription)
  }
}
