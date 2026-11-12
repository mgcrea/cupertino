import CoreData
import Foundation

/// Pins and unpins Maps favourites, saves and removes places in the library, and files a saved
/// place in a Guide, by saving through Maps' own Core Data model, so the save lands in the
/// persistent history Maps' iCloud exporter reads.
///
/// Each method sets what Maps itself set for the same step, watched 2026-11-11 (`docs/maps.md`,
/// "What Maps changes"), one transaction per call:
///
/// - addFavorite (851): a `FavoriteItem` and its own `MixinMapItem` holding a copy of the
///   source's place record. `type 1`, `version 2`, `source 0`, `hidden 0`, the record's
///   coordinate and a `shortcutIdentifier` from it, and a `positionIndex` above every pin's.
/// - removeFavorite (856–858): pins (`type 1`) only. Maps does not delete a pin, it moves it into
///   the library. A `CollectionPlaceItem` in no Guide copies the pin, its `customName` included,
///   then the pin goes, and its record by the model's cascade. A saved place already at that
///   spot is left as it is, and only the pin goes.
/// - savePlace (862): a `CollectionPlaceItem` in no Guide and its own `MixinMapItem`.
/// - removeSavedPlace (867): the `CollectionPlaceItem`; its record goes by cascade, and each
///   Guide's side of the relationship by nullify.
/// - fileInGuide (866): the `Collection` added to the item's `collections`, and
///   `modificationTime` on both. `placesCount` is derived from `places`.
///
/// Only Maps can mint a place record, so a new item's record is only ever copied, byte for byte,
/// from one already in the store, with `createTime` and `modificationTime` at now as each record
/// Maps inserted had (the 2026-11-11 live check found the lane's without them). The display
/// columns (`mapItemName`, `mapItemAddress`, `mapItemCategory`, `muid`) are copied from the source
/// item when it has them and left nil otherwise: Maps renders a missing one from the record. A
/// source with no `mapItemName` (a recent) gets the caller's query there as a placeholder, and a
/// label the caller chose goes in `customName`, never in `mapItemName`.
///
/// Every fetch is scoped to the entity the id is meant to name, so a favourite's id never deletes
/// a saved place. Messages never repeat a value the caller passed.
nonisolated struct MapsWriter: Sendable {
  /// Where the place record to copy comes from, as the node side names it.
  enum SourceKind: String, Sendable {
    case favorite, savedPlace, recent

    var entity: String {
      switch self {
      case .favorite: "FavoriteItem"
      case .savedPlace: "CollectionPlaceItem"
      case .recent: "HistoryPlaceItem"
      }
    }
  }

  /// What a call did.
  ///
  /// `id` is the item written, removed or filed, or the one that already stood there; `changed`
  /// is empty when nothing was saved. `created` is true only when a new item was inserted.
  /// `filed` is fileInGuide's alone, read back after the save.
  struct Result: Equatable {
    var id: String
    var changed: [String]
    var created: Bool
    var filed: Bool?
    var modelVersion: String?
    var syncMeasured: Bool
  }

  /// The memberwise `init(store:)` is the one the lane and the check use.
  let store: CoreDataStore

  static let modelURL = URL(
    fileURLWithPath:
      "/System/Library/PrivateFrameworks/MapsSync.framework/Versions/A/Resources/DataModel_0_0_1.momd"
  )

  /// Relative to the home folder. No file extension: that is the store's name.
  static let storePath = "Library/Containers/com.apple.Maps/Data/Maps/MapsSync_0.0.1"

  /// The model checksums whose sync was measured on two devices: `DataModel_0_0_1` on macOS 27.2,
  /// every write seen on a Mac and an iPhone on 2026-11-11, one with Maps quit (`docs/maps.md`,
  /// "Measured 2026-11-11").
  static let measuredVersions: Set<String> = ["CaxhFkDDBEvVUHzx/wKUv4k+QehKTgcfEuPWR91+uhk="]

  /// Every property this writer reads, sets or fetches by, per entity, key paths as its
  /// predicates walk them. The opener refuses a model without one (`CoreDataStore.requires`),
  /// so another macOS's Maps model is reported incompatible rather than raising mid-write. A
  /// source's display columns are read only where its entity has them, so they are not here
  /// for `HistoryPlaceItem`.
  static let needs: [String: [String]] = [
    "FavoriteItem": [
      "identifier", "createTime", "modificationTime", "mapItemLastRefreshed", "latitude",
      "longitude", "mapItemName", "mapItemAddress", "mapItemCategory", "muid", "customName",
      "shortcutIdentifier", "positionIndex", "type", "version", "source", "hidden", "mapItem",
      "mapItem.latitude", "mapItem.longitude",
    ],
    "CollectionPlaceItem": [
      "identifier", "createTime", "modificationTime", "mapItemLastRefreshed", "latitude",
      "longitude", "mapItemName", "mapItemAddress", "mapItemCategory", "muid", "customName",
      "type", "origin", "positionIndex", "droppedPinFloorOrdinal", "mapItem", "mapItem.latitude",
      "mapItem.longitude", "collections",
    ],
    "HistoryPlaceItem": ["identifier", "latitude", "longitude", "mapItem"],
    "MixinMapItem": [
      "mapItemStorage", "latitude", "longitude", "createTime", "modificationTime",
    ],
    "Collection": ["identifier", "title", "modificationTime"],
  ]

  /// The opener over the store at `storeURL`, with Maps' model. Maps needs no patch, and its
  /// `.momd` names no current version, so the version is the model's checksum.
  static func store(at storeURL: URL) -> CoreDataStore {
    CoreDataStore(
      modelURL: modelURL, storeURL: storeURL, patch: { _ in }, measuredVersions: measuredVersions,
      versionKey: CoreDataStore.versionChecksum("DataModel_0_0_1"), app: "Maps", requires: needs)
  }

  static let live = MapsWriter(
    store: store(
      at: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(storePath)))

  /// How far the place Maps resolved may sit from the caller's coordinate: a building's width
  /// and the entrance-versus-pin drift, not a different street.
  static let maxResolutionMetres = 250.0

  /// Two items within this of each other on both axes stand at the same spot: ~1.1 m.
  static let sameSpot = 1e-5

  /// The gap Maps leaves between pins' `positionIndex` (watched: ~5e7).
  static let positionStep: Int64 = 50_000_000

  static let maxNameLength = 500

  func status() -> CoreDataStore.Status {
    store.status()
  }

  // MARK: - Writes

  func addFavorite(
    source: SourceKind, sourceId: String, query: String, name: String?, near: (Double, Double)?
  ) throws -> Result {
    let sourceUUID = try Self.uuid(sourceId)
    let query = try Self.validText(query, "query")
    let name = try name.map(Self.validName)
    let near = try near.map(Self.validCoordinate)
    let (id, changed, created) = try store.write { context in
      let place = try Place(source, sourceUUID, near: near, in: context)
      if let existing = try Self.item(
        "FavoriteItem", at: place.coordinate, pinsOnly: true, in: context)
      {
        return (Self.text(try Self.identifier(of: existing)), [String](), false)
      }
      let now = Date()
      let identifier = UUID()
      let favorite = NSEntityDescription.insertNewObject(
        forEntityName: "FavoriteItem", into: context)
      var values = place.displayColumns(query: query, name: name)
      values["identifier"] = identifier
      values["createTime"] = now
      values["modificationTime"] = now
      values["mapItemLastRefreshed"] = now
      values["latitude"] = place.coordinate.latitude
      values["longitude"] = place.coordinate.longitude
      values["shortcutIdentifier"] = Self.shortcutIdentifier(place.coordinate)
      values["positionIndex"] = try Self.nextPinPosition(in: context)
      values["type"] = Int16(1)
      values["version"] = Int16(2)
      values["source"] = Int16(0)
      values["hidden"] = false
      Self.setAll(favorite, values)
      favorite.setValue(place.copyRecord(in: context), forKey: "mapItem")
      return (Self.text(identifier), values.keys.sorted(), true)
    }
    return result(id: id, changed: changed, created: created)
  }

  func removeFavorite(id: String) throws -> Result {
    let uuid = try Self.uuid(id)
    let (changed, created) = try store.write { context in
      let pin = try CoreDataStore.fetchOne("FavoriteItem", uuid: uuid, in: context)
      // Only a pin (`type 1`): Home, Work and the other slots are not what this removes.
      guard (pin.value(forKey: "type") as? NSNumber)?.intValue == 1 else {
        throw StoreLaneError.invalid("that favourite is not a pin, and only pins are removed here")
      }
      var changed = ["favorite"]
      var created = false
      // Unpinning moves the place into the library, as Maps does, unless one is there already.
      // A pin with no record or no coordinate has nothing to move.
      let record = pin.value(forKey: "mapItem") as? NSManagedObject
      if let record, let storage = record.value(forKey: "mapItemStorage") as? Data,
        let coordinate = Self.ownCoordinate(of: pin) ?? Self.recordCoordinate(of: record),
        try Self.item("CollectionPlaceItem", at: coordinate, in: context) == nil
      {
        let now = Date()
        let place = NSEntityDescription.insertNewObject(
          forEntityName: "CollectionPlaceItem", into: context)
        var values: [String: Any] = [:]
        // A renamed pin keeps its name in the library.
        for key in [
          "createTime", "customName", "mapItemName", "mapItemAddress", "mapItemCategory", "muid",
        ] {
          values[key] = pin.value(forKey: key)
        }
        values["identifier"] = UUID()
        values["modificationTime"] = now
        values["mapItemLastRefreshed"] = now
        values["latitude"] = coordinate.latitude
        values["longitude"] = coordinate.longitude
        values["type"] = Int16(0)
        values["origin"] = Int16(0)
        values["positionIndex"] = Int64(0)
        Self.setAll(place, values)
        place.setValue(
          Self.insertRecord(
            storage, latitude: record.value(forKey: "latitude"),
            longitude: record.value(forKey: "longitude"), in: context),
          forKey: "mapItem")
        changed.append("savedPlace")
        created = true
      }
      // Its own record goes by the model's cascade.
      context.delete(pin)
      return (changed, created)
    }
    return result(id: Self.text(uuid), changed: changed, created: created)
  }

  func savePlace(
    source: SourceKind, sourceId: String, query: String, name: String?, near: (Double, Double)?
  ) throws -> Result {
    let sourceUUID = try Self.uuid(sourceId)
    let query = try Self.validText(query, "query")
    let name = try name.map(Self.validName)
    let near = try near.map(Self.validCoordinate)
    let (id, changed, created) = try store.write { context in
      let place = try Place(source, sourceUUID, near: near, in: context)
      if let existing = try Self.item("CollectionPlaceItem", at: place.coordinate, in: context) {
        return (Self.text(try Self.identifier(of: existing)), [String](), false)
      }
      let (item, changed) = Self.insertSavedPlace(place, query: query, name: name, in: context)
      return (Self.text(try Self.identifier(of: item)), changed, true)
    }
    return result(id: id, changed: changed, created: created)
  }

  func removeSavedPlace(id: String) throws -> Result {
    let uuid = try Self.uuid(id)
    try store.write { context in
      // Its record goes by cascade; each Guide's `places` by nullify.
      context.delete(try CoreDataStore.fetchOne("CollectionPlaceItem", uuid: uuid, in: context))
    }
    return result(id: Self.text(uuid), changed: ["savedPlace"], created: false)
  }

  /// Files a saved place in the one Guide titled `guideTitle`: the place `placeId`, or one saved
  /// first from `source`/`sourceId` (or the saved place already at its spot), in the same save.
  func fileInGuide(
    guideTitle: String, placeId: String?, source: SourceKind?, sourceId: String?,
    query: String?, name: String?, near: (Double, Double)?
  ) throws -> Result {
    guard !guideTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw StoreLaneError.invalid("the Guide title is empty")
    }
    enum Target {
      case place(UUID)
      case source(SourceKind, UUID, query: String, name: String?, Coordinate?)
    }
    let target: Target
    switch (placeId, source, sourceId) {
    case (let placeId?, .none, .none):
      guard query == nil, name == nil, near == nil else {
        throw StoreLaneError.invalid(
          "a query, a name or a coordinate goes with a source, not a placeId")
      }
      target = .place(try Self.uuid(placeId))
    case (.none, let source?, let sourceId?):
      guard let query else { throw StoreLaneError.invalid("a source needs its query") }
      target = .source(
        source, try Self.uuid(sourceId), query: try Self.validText(query, "query"),
        name: try name.map(Self.validName), try near.map(Self.validCoordinate))
    default:
      throw StoreLaneError.invalid("name either a placeId, or a source and its sourceId")
    }
    let (id, changed, created, filed) = try store.write { context in
      let guide = try Self.guide(titled: guideTitle, in: context)
      let item: NSManagedObject
      var created = false
      switch target {
      case .place(let uuid):
        item = try CoreDataStore.fetchOne("CollectionPlaceItem", uuid: uuid, in: context)
      case .source(let source, let uuid, let query, let name, let near):
        let place = try Place(source, uuid, near: near, in: context)
        if let existing = try Self.item("CollectionPlaceItem", at: place.coordinate, in: context) {
          item = existing
        } else {
          item = Self.insertSavedPlace(place, query: query, name: name, in: context).item
          created = true
        }
      }
      let placeUUID = try Self.identifier(of: item)
      let guideUUID = try Self.identifier(of: guide)
      var changed: [String] = []
      let collections = item.mutableSetValue(forKey: "collections")
      if !collections.contains(guide) {
        // Both sides, as Maps' own filing saved them.
        let now = Date()
        collections.add(guide)
        item.setValue(now, forKey: "modificationTime")
        guide.setValue(now, forKey: "modificationTime")
        changed = ["collections"]
      }
      // Saved here rather than by the opener, so `filed` can be read back from the store on
      // this same coordinator: what the store holds, not what was asked. Nothing is left for
      // the opener to save.
      if context.hasChanges { try context.save() }
      context.stalenessInterval = 0
      context.refreshAllObjects()
      let fresh = try CoreDataStore.fetchOne("CollectionPlaceItem", uuid: placeUUID, in: context)
      let filedIn = fresh.value(forKey: "collections") as? Set<NSManagedObject> ?? []
      let filed = filedIn.contains { $0.value(forKey: "identifier") as? UUID == guideUUID }
      return (Self.text(placeUUID), changed, created, filed)
    }
    return result(id: id, changed: changed, created: created, filed: filed)
  }

  // MARK: - The source

  /// A latitude and longitude, in degrees.
  struct Coordinate: Equatable {
    var latitude: Double
    var longitude: Double
  }

  /// The source item and its place record, read once inside the write.
  private struct Place {
    let item: NSManagedObject
    let storage: Data
    let record: NSManagedObject
    /// The record's coordinate, or the item's own where the record has none: Maps' pin took its
    /// record's exactly (851).
    let coordinate: Coordinate

    init(
      _ kind: SourceKind, _ uuid: UUID, near: Coordinate?, in context: NSManagedObjectContext
    ) throws {
      item = try CoreDataStore.fetchOne(kind.entity, uuid: uuid, in: context)
      guard let record = item.value(forKey: "mapItem") as? NSManagedObject,
        let storage = record.value(forKey: "mapItemStorage") as? Data
      else {
        throw StoreLaneError.notFound("the source has no place record to copy")
      }
      guard
        let coordinate = MapsWriter.recordCoordinate(of: record)
          ?? MapsWriter.ownCoordinate(of: item)
      else {
        throw StoreLaneError.notFound("the source has no coordinate")
      }
      if let near {
        let metres = MapsWriter.metres(coordinate, near)
        guard metres <= MapsWriter.maxResolutionMetres else {
          throw StoreLaneError.invalid(
            "the place Maps resolved is about \(Int(metres.rounded())) m from the coordinate "
              + "asked for, more than \(Int(MapsWriter.maxResolutionMetres)) m")
        }
      }
      self.record = record
      self.storage = storage
      self.coordinate = coordinate
    }

    /// `key` of the source, nil where its entity has no such attribute: a recent has only
    /// `muid` of the display columns, and asking for a key an entity lacks raises.
    func value(_ key: String) -> Any? {
      item.entity.attributesByName[key] == nil ? nil : item.value(forKey: key)
    }

    /// The display columns a new item copies, and `customName` for the caller's own label.
    ///
    /// `mapItemName` is the place's, and belongs to whichever device refreshes the place next
    /// (the 870 import replaced the lane's): the source's own, or for a source with none (a
    /// recent) the query, as a placeholder until then. A label the caller chose is `customName`,
    /// which no refresh touches, set only when the caller gave one and it differs from that
    /// `mapItemName`; the query never becomes one.
    func displayColumns(query: String, name: String?) -> [String: Any] {
      var values: [String: Any] = [:]
      for key in ["mapItemAddress", "mapItemCategory", "muid"] {
        if let value = value(key) { values[key] = value }
      }
      let mapItemName = value("mapItemName") as? String ?? query
      values["mapItemName"] = mapItemName
      if let name, name != mapItemName { values["customName"] = name }
      return values
    }

    /// A new `MixinMapItem` holding a copy of this record's bytes and coordinate.
    func copyRecord(in context: NSManagedObjectContext) -> NSManagedObject {
      MapsWriter.insertRecord(
        storage, latitude: record.value(forKey: "latitude"),
        longitude: record.value(forKey: "longitude"), in: context)
    }
  }

  // MARK: - Helpers

  /// A new `MixinMapItem` with `storage`'s bytes and that coordinate, and `createTime` and
  /// `modificationTime` at now, as Maps set them on every record it inserted (850, 851, 857, 862).
  private static func insertRecord(
    _ storage: Data, latitude: Any?, longitude: Any?, in context: NSManagedObjectContext
  ) -> NSManagedObject {
    let now = Date()
    let record = NSEntityDescription.insertNewObject(forEntityName: "MixinMapItem", into: context)
    record.setValue(storage, forKey: "mapItemStorage")
    record.setValue(latitude, forKey: "latitude")
    record.setValue(longitude, forKey: "longitude")
    record.setValue(now, forKey: "createTime")
    record.setValue(now, forKey: "modificationTime")
    return record
  }

  /// A saved place in no Guide, as Maps' 862 saved it; returns it and the attributes it holds.
  private static func insertSavedPlace(
    _ place: Place, query: String, name: String?, in context: NSManagedObjectContext
  ) -> (item: NSManagedObject, changed: [String]) {
    let now = Date()
    let item = NSEntityDescription.insertNewObject(
      forEntityName: "CollectionPlaceItem", into: context)
    var values = place.displayColumns(query: query, name: name)
    values["identifier"] = UUID()
    values["createTime"] = now
    values["modificationTime"] = now
    values["mapItemLastRefreshed"] = now
    values["latitude"] = place.coordinate.latitude
    values["longitude"] = place.coordinate.longitude
    values["type"] = Int16(0)
    values["origin"] = Int16(0)
    values["positionIndex"] = Int64(0)
    values["droppedPinFloorOrdinal"] = Int32(0)
    setAll(item, values)
    item.setValue(place.copyRecord(in: context), forKey: "mapItem")
    return (item, values.keys.sorted())
  }

  private static func setAll(_ object: NSManagedObject, _ values: [String: Any]) {
    for (key, value) in values { object.setValue(value, forKey: key) }
  }

  /// An item's own coordinate, nil unless it has both halves.
  private static func ownCoordinate(of item: NSManagedObject) -> Coordinate? {
    guard let latitude = item.value(forKey: "latitude") as? Double,
      let longitude = item.value(forKey: "longitude") as? Double
    else { return nil }
    return Coordinate(latitude: latitude, longitude: longitude)
  }

  /// A record's coordinate. Exactly (0, 0) is the model's default, not a place: nil.
  private static func recordCoordinate(of record: NSManagedObject) -> Coordinate? {
    guard let latitude = record.value(forKey: "latitude") as? Double,
      let longitude = record.value(forKey: "longitude") as? Double,
      latitude != 0 || longitude != 0
    else { return nil }
    return Coordinate(latitude: latitude, longitude: longitude)
  }

  /// An item of `entity` within `sameSpot` of `coordinate` on both axes, if any: by its own
  /// coordinate, or by its record's when it has none of its own. `pinsOnly` keeps to
  /// `type 1`, so a Home or Work slot is not taken for a pin.
  private static func item(
    _ entity: String, at coordinate: Coordinate, pinsOnly: Bool = false,
    in context: NSManagedObjectContext
  ) throws -> NSManagedObject? {
    let bounds: [CVarArg] = [
      coordinate.latitude - sameSpot, coordinate.latitude + sameSpot,
      coordinate.longitude - sameSpot, coordinate.longitude + sameSpot,
    ]
    let own = NSPredicate(
      format: "latitude >= %lf AND latitude <= %lf AND longitude >= %lf AND longitude <= %lf",
      argumentArray: bounds)
    let byRecord = NSPredicate(
      format: "(latitude == nil OR longitude == nil) AND mapItem.latitude >= %lf "
        + "AND mapItem.latitude <= %lf AND mapItem.longitude >= %lf AND mapItem.longitude <= %lf",
      argumentArray: bounds)
    var predicate: NSPredicate = NSCompoundPredicate(orPredicateWithSubpredicates: [own, byRecord])
    if pinsOnly {
      predicate = NSCompoundPredicate(
        andPredicateWithSubpredicates: [NSPredicate(format: "type == 1"), predicate])
    }
    let request = NSFetchRequest<NSManagedObject>(entityName: entity)
    request.predicate = predicate
    request.fetchLimit = 1
    do {
      return try context.fetch(request).first
    } catch {
      throw StoreLaneError.failed("the fetch failed: \(error.localizedDescription)")
    }
  }

  /// The one Guide titled `title`; `invalid` naming the candidates' identifiers otherwise. The
  /// title itself stays out of the message.
  private static func guide(titled title: String, in context: NSManagedObjectContext) throws
    -> NSManagedObject
  {
    let request = NSFetchRequest<NSManagedObject>(entityName: "Collection")
    let all: [NSManagedObject]
    do {
      all = try context.fetch(request)
    } catch {
      throw StoreLaneError.failed("the fetch failed: \(error.localizedDescription)")
    }
    let matches = all.filter { $0.value(forKey: "title") as? String == title }
    if matches.count == 1, let guide = matches.first { return guide }
    func ids(_ guides: [NSManagedObject]) -> String {
      let ids = guides.map { ($0.value(forKey: "identifier") as? UUID).map(text) ?? "(none)" }
      return ids.isEmpty ? "none" : ids.sorted().joined(separator: ", ")
    }
    if matches.isEmpty {
      throw StoreLaneError.invalid("no Guide has that title; the Guides are \(ids(all))")
    }
    throw StoreLaneError.invalid("\(matches.count) Guides have that title: \(ids(matches))")
  }

  /// Above every pin, by Maps' step; one above when the step would pass Int64.
  private static func nextPinPosition(in context: NSManagedObjectContext) throws -> Int64 {
    let request = NSFetchRequest<NSManagedObject>(entityName: "FavoriteItem")
    request.predicate = NSPredicate(format: "positionIndex != nil")
    request.sortDescriptors = [NSSortDescriptor(key: "positionIndex", ascending: false)]
    request.fetchLimit = 1
    let top: NSManagedObject?
    do {
      top = try context.fetch(request).first
    } catch {
      throw StoreLaneError.failed("the fetch failed: \(error.localizedDescription)")
    }
    let max = (top?.value(forKey: "positionIndex") as? NSNumber)?.int64Value ?? 0
    let (stepped, overflow) = max.addingReportingOverflow(positionStep)
    if !overflow { return stepped }
    let (next, full) = max.addingReportingOverflow(1)
    guard !full else { throw StoreLaneError.failed("no pin position is left above the others") }
    return next
  }

  /// The coordinate rounded to four decimals and printed with five, as Maps keys a pin:
  /// 48.8553108, 2.3158494 → "48.85530,2.31580".
  static func shortcutIdentifier(_ coordinate: Coordinate) -> String {
    func rounded(_ degrees: Double) -> Double { (degrees * 10_000).rounded() / 10_000 }
    return String(format: "%.5f,%.5f", rounded(coordinate.latitude), rounded(coordinate.longitude))
  }

  /// Haversine, on a 6371 km sphere.
  static func metres(_ a: Coordinate, _ b: Coordinate) -> Double {
    let radians = Double.pi / 180
    let dLat = (b.latitude - a.latitude) * radians
    let dLon = (b.longitude - a.longitude) * radians
    let h =
      sin(dLat / 2) * sin(dLat / 2)
      + cos(a.latitude * radians) * cos(b.latitude * radians) * sin(dLon / 2) * sin(dLon / 2)
    return 6_371_000 * 2 * asin(min(1, h.squareRoot()))
  }

  /// An item with no identifier is not the caller's mistake: the store holds a row the lane
  /// cannot name.
  private static func identifier(of object: NSManagedObject) throws -> UUID {
    guard let uuid = object.value(forKey: "identifier") as? UUID else {
      throw StoreLaneError.failed("the \(object.entity.name ?? "item") there has no identifier")
    }
    return uuid
  }

  /// Lowercase, as the node side reads every id from the store.
  private static func text(_ uuid: UUID) -> String {
    uuid.uuidString.lowercased()
  }

  private static func uuid(_ id: String) throws -> UUID {
    guard let uuid = UUID(uuidString: id) else {
      throw StoreLaneError.invalid("the id is not a uuid")
    }
    return uuid
  }

  /// Trimmed, 1 to 500 characters, one line.
  static func validName(_ name: String) throws -> String {
    try validText(name, "name")
  }

  /// `text` trimmed, 1 to 500 characters, one line; a refusal names `what`, never the text.
  static func validText(_ text: String, _ what: String) throws -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw StoreLaneError.invalid("the \(what) is empty") }
    guard trimmed.count <= maxNameLength else {
      throw StoreLaneError.invalid("the \(what) is longer than \(maxNameLength) characters")
    }
    guard !trimmed.contains(where: \.isNewline) else {
      throw StoreLaneError.invalid("the \(what) has a line break")
    }
    return trimmed
  }

  static func validCoordinate(_ near: (Double, Double)) throws -> Coordinate {
    let (latitude, longitude) = near
    guard latitude.isFinite, longitude.isFinite, abs(latitude) <= 90, abs(longitude) <= 180
    else { throw StoreLaneError.invalid("the coordinate is not a latitude and longitude") }
    return Coordinate(latitude: latitude, longitude: longitude)
  }

  private func result(id: String, changed: [String], created: Bool, filed: Bool? = nil) -> Result {
    let status = store.status()
    return Result(
      id: id, changed: changed.sorted(), created: created, filed: filed,
      modelVersion: status.modelVersion, syncMeasured: status.syncMeasured)
  }
}
