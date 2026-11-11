import CoreData
import Foundation

/// The Maps group of `make store-lane-check`: `MapsWriter` against a store built from the real
/// `DataModel_0_0_1.momd` in a temporary folder, holding synthetic places only.
///
/// Each write is held to what Maps itself saved for the same step, watched 2026-11-11
/// (`docs/maps.md`, "What Maps changes"): one transaction, the rows it names, and the exact set
/// of attributes a new item holds.
extension StoreLaneCheck {
  // MARK: - The fixture

  /// The fixture's items, by the name the history labels use.
  enum MapsID {
    static let recent = UUID(uuidString: "5E0C0000-0000-4000-8000-000000000001")!
    static let bareRecent = UUID(uuidString: "5E0C0000-0000-4000-8000-000000000002")!
    static let favorite = UUID(uuidString: "5E0C0000-0000-4000-8000-000000000003")!
    static let saved = UUID(uuidString: "5E0C0000-0000-4000-8000-000000000004")!
    static let guide = UUID(uuidString: "5E0C0000-0000-4000-8000-000000000005")!
    static let twinA = UUID(uuidString: "5E0C0000-0000-4000-8000-000000000006")!
    static let twinB = UUID(uuidString: "5E0C0000-0000-4000-8000-000000000007")!

    static let names: [UUID: String] = [
      recent: "recent", bareRecent: "bareRecent", favorite: "favorite", saved: "saved",
      guide: "guide", twinA: "twinA", twinB: "twinB",
    ]
  }

  /// Where each fixture item stands. The recent's is the watch's example pin.
  static let recentAt = (48.8553108, 2.3158494)
  /// The recent's record stands a few metres off the recent itself, so a pin keyed on the record
  /// (48.85540,2.31580) tells from one keyed on the item (48.85530,2.31580).
  static let recentRecordAt = (48.85536, 2.31576)
  static let favoriteAt = (41.4036, 2.1744)
  static let savedAt = (51.5007, -0.1246)

  /// The watch's newest pin: new pins land 5e7 above it.
  static let favoritePosition: Int64 = 9_218_868_438_090_581_837
  static let favoriteCreated = Date(timeIntervalSinceReferenceDate: 780_000_000)

  /// 1–2 KB of arbitrary bytes, a different run per record: never a real place record.
  static func syntheticRecord(_ seed: Int) -> Data {
    Data((0..<(1_000 + seed * 300)).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ seed &* 97) })
  }

  /// The real Maps model, copied as the writer loads it (Maps needs no patch).
  static func mapsModel() throws -> NSManagedObjectModel {
    guard let loaded = NSManagedObjectModel(contentsOf: MapsWriter.modelURL),
      let model = loaded.copy() as? NSManagedObjectModel
    else { throw Failure(why: "the Maps model did not load") }
    return model
  }

  /// A Maps store from the real model, synthetic rows only: a recent with a record and one
  /// without, a favourite, a saved place filed in "Synthetic guide", and two Guides titled
  /// "Synthetic twin".
  static func makeMapsStore(at url: URL, model: NSManagedObjectModel) throws {
    let coordinator = NSPersistentStoreCoordinator(managedObjectModel: model)
    let store = try coordinator.addPersistentStore(type: .sqlite, at: url, options: storeOptions)
    let context = NSManagedObjectContext(.privateQueue)
    context.persistentStoreCoordinator = coordinator
    try withExtendedLifetime(model) {
      try context.performAndWait {
        @discardableResult
        func insert(_ entity: String, _ values: [String: Any]) -> NSManagedObject {
          let object = NSEntityDescription.insertNewObject(forEntityName: entity, into: context)
          for (key, value) in values { object.setValue(value, forKey: key) }
          return object
        }
        func record(_ seed: Int, _ at: (Double, Double)) -> NSManagedObject {
          insert(
            "MixinMapItem",
            ["mapItemStorage": syntheticRecord(seed), "latitude": at.0, "longitude": at.1])
        }
        let created = Date(timeIntervalSinceReferenceDate: 779_000_000)
        insert(
          "HistoryPlaceItem",
          [
            "identifier": MapsID.recent, "createTime": created, "modificationTime": created,
            "latitude": recentAt.0, "longitude": recentAt.1, "muid": Int64(1001),
            "mapItem": record(1, recentRecordAt),
          ])
        insert(
          "HistoryPlaceItem",
          [
            "identifier": MapsID.bareRecent, "createTime": created, "latitude": 40.0,
            "longitude": -3.0,
          ])
        insert(
          "FavoriteItem",
          [
            "identifier": MapsID.favorite, "createTime": favoriteCreated,
            "modificationTime": favoriteCreated, "mapItemLastRefreshed": favoriteCreated,
            "latitude": favoriteAt.0, "longitude": favoriteAt.1,
            "mapItemName": "Synthetic favourite", "mapItemAddress": "1 Synthetic Street",
            "mapItemCategory": "Synthetic category", "muid": Int64(1002),
            "shortcutIdentifier": "41.40360,2.17440", "positionIndex": favoritePosition,
            "type": Int16(1), "version": Int16(2), "source": Int16(0), "hidden": false,
            "mapItem": record(2, favoriteAt),
          ])
        let guide = insert(
          "Collection",
          [
            "identifier": MapsID.guide, "title": "Synthetic guide", "createTime": created,
            "modificationTime": created,
          ])
        for twin in [MapsID.twinA, MapsID.twinB] {
          insert(
            "Collection",
            [
              "identifier": twin, "title": "Synthetic twin", "createTime": created,
              "modificationTime": created,
            ])
        }
        let saved = insert(
          "CollectionPlaceItem",
          [
            "identifier": MapsID.saved, "createTime": created, "modificationTime": created,
            "latitude": savedAt.0, "longitude": savedAt.1,
            "mapItemName": "Synthetic saved place", "mapItemAddress": "2 Synthetic Road",
            "mapItemCategory": "Synthetic category", "muid": Int64(1003),
            "mapItem": record(3, savedAt),
          ])
        saved.mutableSetValue(forKey: "collections").add(guide)
        try context.save()
      }
    }
    try coordinator.remove(store)
  }

  static func mapsFixture(_ name: String) throws -> (MapsWriter, URL) {
    let storeURL = try folder("maps-\(name)").appendingPathComponent("MapsSync_0.0.1")
    try makeMapsStore(at: storeURL, model: mapsModel())
    return (MapsWriter(store: MapsWriter.store(at: storeURL)), storeURL)
  }

  /// Runs `body` on the fixture on an independent coordinator, saving if it changed anything.
  static func maps<T>(_ storeURL: URL, _ body: (NSManagedObjectContext) throws -> T) throws -> T {
    try reading(storeURL, model: mapsModel()) { context in
      let result = try body(context)
      if context.hasChanges { try context.save() }
      return result
    }
  }

  /// The one `entity` named `uuid`, as the check reads it (not through the writer).
  static func mapsRow(_ entity: String, _ uuid: UUID, in context: NSManagedObjectContext) throws
    -> NSManagedObject
  {
    let request = NSFetchRequest<NSManagedObject>(entityName: entity)
    request.predicate = NSPredicate(format: "identifier == %@", uuid as NSUUID)
    let rows = try context.fetch(request)
    guard rows.count == 1, let row = rows.first else {
      throw Failure(why: "\(rows.count) \(entity) rows named \(uuid)")
    }
    return row
  }

  /// `entity` `uuid`'s attributes that hold a value, and those values.
  static func mapsValues(_ storeURL: URL, _ entity: String, _ uuid: UUID) throws -> [String: Any] {
    try maps(storeURL) { context in
      let row = try mapsRow(entity, uuid, in: context)
      return row.entity.attributesByName.keys.reduce(into: [:]) { values, key in
        if let value = row.value(forKey: key) { values[key] = value }
      }
    }
  }

  /// `entity` `uuid`'s record bytes, nil without a record.
  static func mapsRecord(_ storeURL: URL, _ entity: String, _ uuid: UUID) throws -> Data? {
    try maps(storeURL) { context in
      let record = try mapsRow(entity, uuid, in: context).value(forKey: "mapItem")
      return (record as? NSManagedObject)?.value(forKey: "mapItemStorage") as? Data
    }
  }

  /// `entity` `uuid`'s record's coordinate.
  static func mapsRecordAt(_ storeURL: URL, _ entity: String, _ uuid: UUID) throws -> (
    Double?, Double?
  ) {
    try maps(storeURL) { context in
      let record =
        try mapsRow(entity, uuid, in: context).value(forKey: "mapItem")
        as? NSManagedObject
      return (
        record?.value(forKey: "latitude") as? Double, record?.value(forKey: "longitude") as? Double
      )
    }
  }

  /// What a record the writer inserts holds: the source record's bytes and coordinate, and
  /// `createTime` and `modificationTime` at now, as Maps set them on every record it inserted
  /// (850, 851, 857, 862 in the watch). The live check found the lane's 869 without them.
  static let newRecordKeys: Set<String> = [
    "mapItemStorage", "latitude", "longitude", "createTime", "modificationTime",
  ]

  /// `entity` `uuid`'s record holds exactly `newRecordKeys`, both times now.
  static func expectNewRecord(_ storeURL: URL, _ entity: String, _ uuid: UUID) throws {
    let values = try maps(storeURL) { context -> [String: Any] in
      guard
        let record = try mapsRow(entity, uuid, in: context).value(forKey: "mapItem")
          as? NSManagedObject
      else { throw Failure(why: "the new \(entity) has no record") }
      return record.entity.attributesByName.keys.reduce(into: [:]) { values, key in
        if let value = record.value(forKey: key) { values[key] = value }
      }
    }
    try expect(Set(values.keys) == newRecordKeys, "the record holds \(values.keys.sorted())")
    for key in ["createTime", "modificationTime"] {
      let date = values[key] as? Date
      try expect(
        date.map { abs($0.timeIntervalSinceNow) < 60 } == true,
        "the record's \(key) is \(date as Any), not now")
    }
  }

  /// Inserts `entity` with `values` straight into the fixture, and a record with `record`'s
  /// bytes and coordinate when given; returns nothing the writer saw.
  static func mapsInsert(
    _ storeURL: URL, _ entity: String, _ values: [String: Any],
    record: (seed: Int, at: (Double, Double))? = nil
  ) throws {
    try maps(storeURL) { context in
      let object = NSEntityDescription.insertNewObject(forEntityName: entity, into: context)
      for (key, value) in values { object.setValue(value, forKey: key) }
      if let record {
        let mixin = NSEntityDescription.insertNewObject(
          forEntityName: "MixinMapItem", into: context)
        mixin.setValue(syntheticRecord(record.seed), forKey: "mapItemStorage")
        mixin.setValue(record.at.0, forKey: "latitude")
        mixin.setValue(record.at.1, forKey: "longitude")
        object.setValue(mixin, forKey: "mapItem")
      }
    }
  }

  static func mapsCount(_ storeURL: URL, _ entity: String) throws -> Int {
    try maps(storeURL) { try $0.count(for: NSFetchRequest<NSManagedObject>(entityName: entity)) }
  }

  static func placesCount(_ storeURL: URL, _ guide: UUID) throws -> Int? {
    try maps(storeURL) {
      (try mapsRow("Collection", guide, in: $0).value(forKey: "placesCount") as? NSNumber)?.intValue
    }
  }

  /// The Guides `uuid` (a saved place) is filed in, by fixture name.
  static func guidesOf(_ storeURL: URL, _ uuid: UUID) throws -> Set<String> {
    try maps(storeURL) { context in
      let collections =
        try mapsRow("CollectionPlaceItem", uuid, in: context)
        .value(forKey: "collections") as? Set<NSManagedObject> ?? []
      return Set(
        collections.map { guide in
          (guide.value(forKey: "identifier") as? UUID).flatMap { MapsID.names[$0] } ?? "?"
        })
    }
  }

  /// A label for every object now in the store, by its object id: `"<Entity> <name>"`, the name
  /// from the fixture or `extra`, and a record by its owner's name. Taken before a call, so a
  /// row the call deletes is still named in its history.
  static func mapsLabels(_ storeURL: URL, extra: [UUID: String] = [:]) throws -> [URL: String] {
    try maps(storeURL) { context in
      var labels: [URL: String] = [:]
      func name(_ object: NSManagedObject?) -> String {
        guard let object, let uuid = object.value(forKey: "identifier") as? UUID else {
          return "?"
        }
        return MapsID.names[uuid] ?? extra[uuid] ?? "unnamed"
      }
      for entity in ["FavoriteItem", "CollectionPlaceItem", "HistoryPlaceItem", "Collection"] {
        for object in try context.fetch(NSFetchRequest<NSManagedObject>(entityName: entity)) {
          labels[object.objectID.uriRepresentation()] = "\(entity) \(name(object))"
        }
      }
      for record in try context.fetch(NSFetchRequest<NSManagedObject>(entityName: "MixinMapItem")) {
        let owner = ["favoriteItem", "collectionPlaceItem", "historyPlaceItem"].lazy
          .compactMap { record.value(forKey: $0) as? NSManagedObject }.first
        labels[record.objectID.uriRepresentation()] = "MixinMapItem \(name(owner))"
      }
      return labels
    }
  }

  /// The fixture's history, each row named by `labels`, and a row it does not name as
  /// `"<Entity> new"`.
  static func mapsHistory(_ storeURL: URL, labels: [URL: String]) throws -> History {
    try history(storeURL, model: mapsModel()) { change, _ in
      labels[change.changedObjectID.uriRepresentation()]
        ?? "\(change.changedObjectID.entity.name ?? "?") new"
    }
  }

  /// `call` saved one transaction, by `cupertino`, whose changes are exactly `expected`.
  static func expectMapsHistory(
    _ storeURL: URL, _ label: String, extra: [UUID: String] = [:], _ expected: [HistoryChange],
    _ call: () throws -> Void
  ) throws {
    let labels = try mapsLabels(storeURL, extra: extra)
    let rows = try oneTransaction(
      storeURL, label, reader: { try mapsHistory($0, labels: labels) }, call)
    let sorted = expected.sorted { $0.row < $1.row }
    try expect(rows == sorted, "\(label) recorded \(rows), not \(sorted)")
  }

  /// `call` saved nothing.
  static func expectNoMapsHistory(_ storeURL: URL, _ label: String, _ call: () throws -> Void)
    throws
  {
    let before = try mapsHistory(storeURL, labels: [:]).count
    try call()
    let after = try mapsHistory(storeURL, labels: [:]).count
    try expect(after == before, "\(label) saved \(after - before) history transactions")
  }

  static func inserted(_ entity: String) -> HistoryChange {
    HistoryChange(row: "\(entity) new", properties: ["insert"])
  }

  /// What every new item holds, beside the columns copied from its source.
  static let newItemKeys: Set<String> = [
    "identifier", "createTime", "modificationTime", "mapItemLastRefreshed", "latitude",
    "longitude", "positionIndex", "type",
  ]
  static let newFavoriteKeys = newItemKeys.union([
    "shortcutIdentifier", "version", "source", "hidden",
  ])
  static let newSavedPlaceKeys = newItemKeys.union(["origin", "droppedPinFloorOrdinal"])

  static func uuid(_ result: MapsWriter.Result) throws -> UUID {
    guard let uuid = UUID(uuidString: result.id) else {
      throw Failure(why: "the result's id \(result.id) is not a uuid")
    }
    return uuid
  }

  static func int(_ values: [String: Any], _ key: String) -> Int64? {
    (values[key] as? NSNumber)?.int64Value
  }

  /// A coordinate `metres` north of `at`.
  static func north(of at: (Double, Double), metres: Double) -> (Double, Double) {
    (at.0 + metres / 111_195, at.1)
  }

  /// What the writer and the fixture touch. A model without one of these (another macOS's Maps)
  /// cannot exercise the writer, so the group skips rather than fails.
  static let mapsNeeds: [String: [String]] = [
    "FavoriteItem": [
      "identifier", "createTime", "modificationTime", "mapItemLastRefreshed", "latitude",
      "longitude", "mapItemName", "mapItemAddress", "mapItemCategory", "muid",
      "shortcutIdentifier", "positionIndex", "type", "version", "source", "hidden", "customName",
      "originatingAddressString", "mapItem",
    ],
    "CollectionPlaceItem": [
      "identifier", "createTime", "modificationTime", "mapItemLastRefreshed", "latitude",
      "longitude", "mapItemName", "mapItemAddress", "mapItemCategory", "muid", "type", "origin",
      "positionIndex", "droppedPinFloorOrdinal", "customName", "droppedPinCoordinate",
      "placeItemNote", "originalIdentifier", "mapItem", "collections",
    ],
    "HistoryPlaceItem": [
      "identifier", "createTime", "modificationTime", "latitude", "longitude", "muid", "mapItem",
    ],
    "MixinMapItem": [
      "mapItemStorage", "latitude", "longitude", "createTime", "modificationTime",
      "favoriteItem", "collectionPlaceItem", "historyPlaceItem",
    ],
    "Collection": [
      "identifier", "title", "createTime", "modificationTime", "places", "placesCount",
    ],
  ]

  static func mapsLacks(_ model: NSManagedObjectModel) -> [String] {
    mapsNeeds.flatMap { entity, names in
      let properties = model.entitiesByName[entity]?.propertiesByName ?? [:]
      return names.filter { properties[$0] == nil }.map { "\(entity).\($0)" }
    }.sorted()
  }

  /// The `.momd`'s checksum for `DataModel_0_0_1`, read here rather than through the opener.
  static func mapsChecksum() -> String? {
    let info = MapsWriter.modelURL.appendingPathComponent("VersionInfo.plist")
    guard let data = try? Data(contentsOf: info),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil)
        as? [String: Any],
      let checksums = plist["NSManagedObjectModel_VersionChecksums"] as? [String: Any]
    else { return nil }
    return checksums["DataModel_0_0_1"] as? String
  }

  // MARK: - The cases

  static func mapsCases() {
    // The door and the namespace reach no store: they run on any machine.
    mapsLaneDoorCases()
    guard FileManager.default.fileExists(atPath: MapsWriter.modelURL.path) else {
      print("SKIP maps: model not on this machine")
      return
    }
    guard let model = try? mapsModel() else {
      print("FAIL maps: the model is on this machine but did not load")
      failures += 1
      return
    }
    let lacks = mapsLacks(model)
    guard lacks.isEmpty else {
      print("SKIP maps: the model lacks \(lacks.joined(separator: ", "))")
      return
    }

    check("addFavoriteCopiesRecord") {
      let (writer, storeURL) = try mapsFixture("add-favorite")
      var result: MapsWriter.Result?
      try expectMapsHistory(
        storeURL, "addFavorite", [inserted("FavoriteItem"), inserted("MixinMapItem")]
      ) {
        result = try writer.addFavorite(
          source: .recent, sourceId: MapsID.recent.uuidString, query: "Synthetic recent place",
          name: nil, near: recentAt)
      }
      guard let result else { throw Failure(why: "addFavorite returned nothing") }
      try expect(result.created, "created is false")
      try expect(result.filed == nil, "filed is \(String(describing: result.filed))")
      let id = try uuid(result)
      let values = try mapsValues(storeURL, "FavoriteItem", id)
      // A recent has only `muid` among the display columns: the query stands in as
      // `mapItemName` until a device refreshes the place, the address and category stay nil, and
      // with no name given there is no `customName`.
      let keys = newFavoriteKeys.union(["mapItemName", "muid"])
      try expect(Set(values.keys) == keys, "the favourite holds \(values.keys.sorted())")
      try expect(result.changed == keys.sorted(), "changed is \(result.changed)")
      try expect(
        values["mapItemName"] as? String == "Synthetic recent place",
        "mapItemName is \(values["mapItemName"] ?? "nil"), not the query")
      try expect(int(values, "muid") == 1001, "muid is \(int(values, "muid") ?? -1)")
      try expect(int(values, "type") == 1, "type is \(int(values, "type") ?? -1)")
      try expect(int(values, "version") == 2, "version is \(int(values, "version") ?? -1)")
      try expect(int(values, "source") == 0, "source is \(int(values, "source") ?? -1)")
      try expect(values["hidden"] as? Bool == false, "hidden is \(values["hidden"] ?? "nil")")
      try expect(
        values["shortcutIdentifier"] as? String == "48.85540,2.31580",
        "shortcutIdentifier is \(values["shortcutIdentifier"] ?? "nil")")
      try expect(
        int(values, "positionIndex") == favoritePosition + 50_000_000,
        "positionIndex is \(int(values, "positionIndex") ?? -1)")
      try expect(
        values["latitude"] as? Double == recentRecordAt.0
          && values["longitude"] as? Double == recentRecordAt.1,
        "the coordinate is \(values["latitude"] ?? "nil"), \(values["longitude"] ?? "nil")")
      let now = Date()
      for key in ["createTime", "modificationTime", "mapItemLastRefreshed"] {
        let date = values[key] as? Date
        try expect(
          date.map { abs($0.timeIntervalSince(now)) < 60 } == true, "\(key) is \(date as Any)")
      }
      let record = try mapsRecord(storeURL, "FavoriteItem", id)
      try expect(record == syntheticRecord(1), "the record is not the recent's bytes")
      try expectNewRecord(storeURL, "FavoriteItem", id)
      let recordAt = try mapsRecordAt(storeURL, "FavoriteItem", id)
      try expect(
        recordAt.0 == recentRecordAt.0 && recordAt.1 == recentRecordAt.1,
        "the record's coordinate is \(recordAt)")
      try expect(
        try mapsRecord(storeURL, "HistoryPlaceItem", MapsID.recent) == syntheticRecord(1),
        "the recent's own record changed")
      try expect(try mapsCount(storeURL, "MixinMapItem") == 4, "not one new MixinMapItem")
    }

    check("addFavoriteIsIdempotent") {
      let (writer, storeURL) = try mapsFixture("add-favorite-again")
      let first = try writer.addFavorite(
        source: .recent, sourceId: MapsID.recent.uuidString, query: "Synthetic recent place",
        name: nil, near: nil)
      var again: MapsWriter.Result?
      try expectNoMapsHistory(storeURL, "a second addFavorite") {
        again = try writer.addFavorite(
          source: .recent, sourceId: MapsID.recent.uuidString, query: "Synthetic query",
          name: "Another name", near: recentAt)
      }
      try expect(again?.id == first.id, "the second call answers \(again?.id ?? "nil")")
      try expect(again?.created == false, "the second call created one")
      try expect(again?.changed == [], "the second call changed \(again?.changed ?? [])")
      // The fixture favourite, from itself: already there.
      let own = try writer.addFavorite(
        source: .favorite, sourceId: MapsID.favorite.uuidString, query: "Synthetic query",
        name: nil, near: nil)
      try expect(
        own.id.lowercased() == MapsID.favorite.uuidString.lowercased() && !own.created,
        "the favourite from itself answers \(own)")
      try expect(try mapsCount(storeURL, "FavoriteItem") == 2, "a duplicate favourite was saved")
    }

    check("addFavoriteRefusesFarResolution") {
      let (writer, storeURL) = try mapsFixture("add-favorite-far")
      try expectNoMapsHistory(storeURL, "a far addFavorite") {
        try expectRefusal("invalid", "300 m away") {
          _ = try writer.addFavorite(
            source: .recent, sourceId: MapsID.recent.uuidString, query: "Synthetic recent place",
            name: nil, near: north(of: recentAt, metres: 300))
        }
      }
      try expect(try mapsCount(storeURL, "FavoriteItem") == 1, "a favourite was saved")
      // 200 m is within Maps' usual drift.
      let close = try writer.addFavorite(
        source: .recent, sourceId: MapsID.recent.uuidString, query: "Synthetic recent place",
        name: nil, near: north(of: recentAt, metres: 200))
      try expect(close.created, "200 m away was not saved")
    }

    check("addFavoritePositionIndex") {
      let (writer, storeURL) = try mapsFixture("add-favorite-position")
      func setPosition(_ value: Int64) throws {
        try maps(storeURL) {
          try mapsRow("FavoriteItem", MapsID.favorite, in: $0).setValue(
            value, forKey: "positionIndex")
        }
      }
      // Past Int64 by the step: one above the maximum instead.
      try setPosition(Int64.max - 1_000)
      let near = try writer.addFavorite(
        source: .recent, sourceId: MapsID.recent.uuidString, query: "Synthetic query",
        name: "Synthetic", near: nil)
      let position = int(try mapsValues(storeURL, "FavoriteItem", try uuid(near)), "positionIndex")
      try expect(position == Int64.max - 999, "positionIndex is \(position ?? -1)")
      // No room at all: refused, nothing saved.
      _ = try writer.removeFavorite(id: near.id)
      try setPosition(Int64.max)
      try expectNoMapsHistory(storeURL, "an addFavorite past Int64") {
        try expectRefusal("failed", "positionIndex at Int64.max") {
          _ = try writer.addFavorite(
            source: .recent, sourceId: MapsID.recent.uuidString, query: "Synthetic query",
            name: "Synthetic", near: nil)
        }
      }
    }

    check("removeFavoriteUnpinsIntoLibrary") {
      let (writer, storeURL) = try mapsFixture("remove-favorite")
      // A renamed pin: the name goes into the library with it.
      try maps(storeURL) {
        try mapsRow("FavoriteItem", MapsID.favorite, in: $0).setValue(
          "Synthetic pin name", forKey: "customName")
      }
      var result: MapsWriter.Result?
      try expectMapsHistory(
        storeURL, "removeFavorite",
        [
          HistoryChange(row: "FavoriteItem favorite", properties: ["delete"]),
          HistoryChange(row: "MixinMapItem favorite", properties: ["delete"]),
          inserted("CollectionPlaceItem"), inserted("MixinMapItem"),
        ]
      ) { result = try writer.removeFavorite(id: MapsID.favorite.uuidString) }
      guard let result else { throw Failure(why: "removeFavorite returned nothing") }
      try expect(
        result.id.lowercased() == MapsID.favorite.uuidString.lowercased(), "id is \(result.id)")
      try expect(result.changed == ["favorite", "savedPlace"], "changed is \(result.changed)")
      try expect(result.created, "created is false")
      try expect(try mapsCount(storeURL, "FavoriteItem") == 0, "the favourite is still there")
      // The new saved place: the one row the fixture does not name.
      let placeID = try maps(storeURL) { context -> UUID in
        let rows = try context.fetch(
          NSFetchRequest<NSManagedObject>(entityName: "CollectionPlaceItem"))
        let ids = rows.compactMap { $0.value(forKey: "identifier") as? UUID }
          .filter { $0 != MapsID.saved }
        guard ids.count == 1, let id = ids.first else {
          throw Failure(why: "\(ids.count) new saved places")
        }
        return id
      }
      let values = try mapsValues(storeURL, "CollectionPlaceItem", placeID)
      let keys = newSavedPlaceKeys.union([
        "customName", "mapItemName", "mapItemAddress", "mapItemCategory", "muid",
      ])
      try expect(Set(values.keys) == keys, "the saved place holds \(values.keys.sorted())")
      try expect(
        values["createTime"] as? Date == favoriteCreated, "createTime is not the pin's")
      let modified = values["modificationTime"] as? Date
      try expect(
        modified.map { abs($0.timeIntervalSinceNow) < 60 } == true,
        "modificationTime is \(modified as Any), not now")
      let recordAt = try mapsRecordAt(storeURL, "CollectionPlaceItem", placeID)
      try expect(
        recordAt.0 == favoriteAt.0 && recordAt.1 == favoriteAt.1,
        "the record's coordinate is \(recordAt), not the pin record's")
      for (key, value) in [
        ("customName", "Synthetic pin name"),
        ("mapItemName", "Synthetic favourite"), ("mapItemAddress", "1 Synthetic Street"),
        ("mapItemCategory", "Synthetic category"),
      ] {
        try expect(values[key] as? String == value, "\(key) is \(values[key] ?? "nil")")
      }
      try expect(int(values, "muid") == 1002, "muid is \(int(values, "muid") ?? -1)")
      for key in ["type", "origin", "positionIndex", "droppedPinFloorOrdinal"] {
        try expect(int(values, key) == 0, "\(key) is \(int(values, key) ?? -1)")
      }
      try expect(
        values["latitude"] as? Double == favoriteAt.0
          && values["longitude"] as? Double == favoriteAt.1, "the coordinate moved")
      let refreshed = values["mapItemLastRefreshed"] as? Date
      try expect(
        refreshed.map { abs($0.timeIntervalSinceNow) < 60 } == true, "mapItemLastRefreshed")
      try expect(
        try mapsRecord(storeURL, "CollectionPlaceItem", placeID) == syntheticRecord(2),
        "the saved place's record is not the pin's bytes")
      try expectNewRecord(storeURL, "CollectionPlaceItem", placeID)
      try expect(try guidesOf(storeURL, placeID).isEmpty, "the saved place is in a Guide")
      try expect(try mapsCount(storeURL, "MixinMapItem") == 3, "the record count moved")
    }

    check("removeFavoriteCascadesOwnRecordOnly") {
      let (writer, storeURL) = try mapsFixture("remove-favorite-onto-saved")
      // A saved place already stands at the pin, with its own record.
      let there = UUID()
      try maps(storeURL) { context in
        let record = NSEntityDescription.insertNewObject(
          forEntityName: "MixinMapItem", into: context)
        record.setValue(syntheticRecord(4), forKey: "mapItemStorage")
        let place = NSEntityDescription.insertNewObject(
          forEntityName: "CollectionPlaceItem", into: context)
        place.setValue(there, forKey: "identifier")
        place.setValue(favoriteAt.0 + 5e-6, forKey: "latitude")
        place.setValue(favoriteAt.1 - 5e-6, forKey: "longitude")
        place.setValue(record, forKey: "mapItem")
      }
      let before = try mapsValues(storeURL, "CollectionPlaceItem", there)
      var result: MapsWriter.Result?
      try expectMapsHistory(
        storeURL, "removeFavorite onto a saved place", extra: [there: "there"],
        [
          HistoryChange(row: "FavoriteItem favorite", properties: ["delete"]),
          HistoryChange(row: "MixinMapItem favorite", properties: ["delete"]),
        ]
      ) { result = try writer.removeFavorite(id: MapsID.favorite.uuidString) }
      try expect(result?.changed == ["favorite"], "changed is \(result?.changed ?? [])")
      try expect(result?.created == false, "created is true")
      try expect(try mapsCount(storeURL, "MixinMapItem") == 3, "not exactly the pin's record went")
      try expect(
        try mapsRecord(storeURL, "CollectionPlaceItem", there) == syntheticRecord(4),
        "the saved place lost its record")
      let after = try mapsValues(storeURL, "CollectionPlaceItem", there)
      try expect(
        (before as NSDictionary).isEqual(to: after), "the saved place changed: \(after)")
      try expectRefusal("notFound", "removing it twice") {
        _ = try writer.removeFavorite(id: MapsID.favorite.uuidString)
      }
    }

    check("savePlaceUnfiled") {
      let (writer, storeURL) = try mapsFixture("save-place")
      var result: MapsWriter.Result?
      try expectMapsHistory(
        storeURL, "savePlace", [inserted("CollectionPlaceItem"), inserted("MixinMapItem")]
      ) {
        result = try writer.savePlace(
          source: .favorite, sourceId: MapsID.favorite.uuidString, query: "Synthetic query",
          name: "Synthetic favourite", near: favoriteAt)
      }
      guard let result else { throw Failure(why: "savePlace returned nothing") }
      try expect(result.created, "created is false")
      let id = try uuid(result)
      let values = try mapsValues(storeURL, "CollectionPlaceItem", id)
      // The caller's name is the source's: no customName.
      let keys = newSavedPlaceKeys.union([
        "mapItemName", "mapItemAddress", "mapItemCategory", "muid",
      ])
      try expect(Set(values.keys) == keys, "the saved place holds \(values.keys.sorted())")
      try expect(result.changed == keys.sorted(), "changed is \(result.changed)")
      for key in ["type", "origin", "positionIndex", "droppedPinFloorOrdinal"] {
        try expect(int(values, key) == 0, "\(key) is \(int(values, key) ?? -1)")
      }
      try expect(int(values, "muid") == 1002, "muid is \(int(values, "muid") ?? -1)")
      try expect(
        values["mapItemAddress"] as? String == "1 Synthetic Street", "the address is not copied")
      try expect(
        (values["createTime"] as? Date).map { abs($0.timeIntervalSinceNow) < 60 } == true,
        "createTime is not now")
      try expect(try guidesOf(storeURL, id).isEmpty, "the new place is in a Guide")
      try expect(
        try mapsRecord(storeURL, "CollectionPlaceItem", id) == syntheticRecord(2),
        "the record is not the favourite's bytes")
      try expectNewRecord(storeURL, "CollectionPlaceItem", id)
      try expect(try mapsCount(storeURL, "FavoriteItem") == 1, "the favourite went")
      // A saved place from itself, and the same favourite again: already there.
      let own = try writer.savePlace(
        source: .savedPlace, sourceId: MapsID.saved.uuidString, query: "Synthetic query",
        name: "Synthetic own name", near: nil)
      try expect(
        own.id.lowercased() == MapsID.saved.uuidString.lowercased() && !own.created,
        "the fixture's saved place, from itself, answers \(own)")
      let other = try writer.savePlace(
        source: .favorite, sourceId: MapsID.favorite.uuidString, query: "Synthetic query",
        name: nil, near: nil)
      try expect(other.id == result.id && !other.created, "a second save answers \(other)")
    }

    check("savePlaceKeepsCallersName") {
      let (writer, storeURL) = try mapsFixture("save-place-name")
      let result = try writer.savePlace(
        source: .favorite, sourceId: MapsID.favorite.uuidString, query: "Synthetic query",
        name: "  Synthetic own name ", near: nil)
      let values = try mapsValues(storeURL, "CollectionPlaceItem", try uuid(result))
      try expect(
        values["customName"] as? String == "Synthetic own name",
        "customName is \(values["customName"] ?? "nil")")
      try expect(
        values["mapItemName"] as? String == "Synthetic favourite", "mapItemName is not copied")
      try expect(result.changed.contains("customName"), "changed is \(result.changed)")
    }

    // `mapItemName` belongs to whichever device refreshes the place next (the 870 import replaced
    // the lane's), so a label the caller chose lives in `customName`, and the query is only the
    // placeholder a recent's copy shows until then.
    check("recentWithNameKeepsItAsCustomName") {
      let calls: [(String, String, (MapsWriter) throws -> MapsWriter.Result)] = [
        (
          "addFavorite", "FavoriteItem",
          {
            try $0.addFavorite(
              source: .recent, sourceId: MapsID.recent.uuidString, query: "Synthetic query",
              name: "Synthetic label", near: nil)
          }
        ),
        (
          "savePlace", "CollectionPlaceItem",
          {
            try $0.savePlace(
              source: .recent, sourceId: MapsID.recent.uuidString, query: "Synthetic query",
              name: "Synthetic label", near: nil)
          }
        ),
        (
          "fileInGuide", "CollectionPlaceItem",
          {
            try $0.fileInGuide(
              guideTitle: "Synthetic guide", placeId: nil, source: .recent,
              sourceId: MapsID.recent.uuidString, query: "Synthetic query",
              name: "Synthetic label", near: nil)
          }
        ),
      ]
      for (label, entity, call) in calls {
        let (writer, storeURL) = try mapsFixture("label-recent-\(label)")
        let result = try call(writer)
        try expect(result.created, "\(label) created nothing")
        let values = try mapsValues(storeURL, entity, try uuid(result))
        try expect(
          values["customName"] as? String == "Synthetic label",
          "\(label): customName is \(values["customName"] ?? "nil")")
        try expect(
          values["mapItemName"] as? String == "Synthetic query",
          "\(label): mapItemName is \(values["mapItemName"] ?? "nil"), not the query")
        if label != "fileInGuide" {
          try expect(result.changed.contains("customName"), "\(label) changed \(result.changed)")
        }
      }
    }

    check("donorWithoutNameSetsNoCustomName") {
      let calls: [(String, (MapsWriter) throws -> MapsWriter.Result)] = [
        (
          "savePlace",
          {
            try $0.savePlace(
              source: .favorite, sourceId: MapsID.favorite.uuidString, query: "Synthetic query",
              name: nil, near: nil)
          }
        ),
        (
          "fileInGuide",
          {
            try $0.fileInGuide(
              guideTitle: "Synthetic guide", placeId: nil, source: .favorite,
              sourceId: MapsID.favorite.uuidString, query: "Synthetic query", name: nil,
              near: nil)
          }
        ),
      ]
      for (label, call) in calls {
        let (writer, storeURL) = try mapsFixture("label-donor-\(label)")
        let result = try call(writer)
        try expect(result.created, "\(label) created nothing")
        let values = try mapsValues(storeURL, "CollectionPlaceItem", try uuid(result))
        try expect(
          values["customName"] == nil,
          "\(label): the query became a customName: \(values["customName"] ?? "")")
        try expect(
          values["mapItemName"] as? String == "Synthetic favourite",
          "\(label): mapItemName is \(values["mapItemName"] ?? "nil"), not the favourite's")
      }
    }

    check("removeSavedPlace") {
      let (writer, storeURL) = try mapsFixture("remove-saved")
      try expect(try placesCount(storeURL, MapsID.guide) == 1, "the guide does not start at 1")
      var result: MapsWriter.Result?
      try expectMapsHistory(
        storeURL, "removeSavedPlace",
        [
          HistoryChange(row: "CollectionPlaceItem saved", properties: ["delete"]),
          HistoryChange(row: "MixinMapItem saved", properties: ["delete"]),
          HistoryChange(row: "Collection guide", properties: ["places"]),
        ]
      ) { result = try writer.removeSavedPlace(id: MapsID.saved.uuidString) }
      try expect(result?.changed == ["savedPlace"], "changed is \(result?.changed ?? [])")
      try expect(result?.created == false, "created is true")
      try expect(
        result?.id.lowercased() == MapsID.saved.uuidString.lowercased(), "the id differs")
      try expect(try placesCount(storeURL, MapsID.guide) == 0, "the guide still counts it")
      try expect(try mapsCount(storeURL, "MixinMapItem") == 2, "the record is still there")
      try expect(try mapsCount(storeURL, "Collection") == 3, "a Guide went with it")
      try expectRefusal("notFound", "removing it twice") {
        _ = try writer.removeSavedPlace(id: MapsID.saved.uuidString)
      }
    }

    check("fileInGuideByPlaceId") {
      let (writer, storeURL) = try mapsFixture("file-by-id")
      let saved = try writer.savePlace(
        source: .recent, sourceId: MapsID.recent.uuidString, query: "Synthetic recent place",
        name: nil, near: nil)
      let placeID = try uuid(saved)
      var result: MapsWriter.Result?
      try expectMapsHistory(
        storeURL, "fileInGuide", extra: [placeID: "place"],
        [
          HistoryChange(
            row: "CollectionPlaceItem place", properties: ["collections", "modificationTime"]),
          HistoryChange(row: "Collection guide", properties: ["modificationTime", "places"]),
        ]
      ) {
        result = try writer.fileInGuide(
          guideTitle: "Synthetic guide", placeId: saved.id, source: nil, sourceId: nil,
          query: nil, name: nil, near: nil)
      }
      try expect(result?.filed == true, "filed is \(String(describing: result?.filed))")
      try expect(result?.changed == ["collections"], "changed is \(result?.changed ?? [])")
      try expect(result?.created == false, "created is true")
      try expect(result?.id == saved.id, "id is \(result?.id ?? "nil")")
      try expect(try placesCount(storeURL, MapsID.guide) == 2, "placesCount is not 2")
      try expect(try guidesOf(storeURL, placeID) == ["guide"], "the place is not in the guide")
      // Again: already there, nothing saved.
      for (label, id) in [
        ("again", saved.id), ("the fixture's filed place", MapsID.saved.uuidString),
      ] {
        var again: MapsWriter.Result?
        try expectNoMapsHistory(storeURL, label) {
          again = try writer.fileInGuide(
            guideTitle: "Synthetic guide", placeId: id, source: nil, sourceId: nil, query: nil,
            name: nil, near: nil)
        }
        try expect(again?.changed == [], "\(label) changed \(again?.changed ?? [])")
        try expect(again?.filed == true, "\(label) filed is \(String(describing: again?.filed))")
      }
    }

    check("fileInGuideSavesThenFiles") {
      let (writer, storeURL) = try mapsFixture("file-from-source")
      var result: MapsWriter.Result?
      try expectMapsHistory(
        storeURL, "fileInGuide from a source",
        [
          inserted("CollectionPlaceItem"), inserted("MixinMapItem"),
          HistoryChange(row: "Collection guide", properties: ["modificationTime", "places"]),
        ]
      ) {
        result = try writer.fileInGuide(
          guideTitle: "Synthetic guide", placeId: nil, source: .recent,
          sourceId: MapsID.recent.uuidString, query: "Synthetic recent place", name: nil,
          near: recentAt)
      }
      guard let result else { throw Failure(why: "fileInGuide returned nothing") }
      try expect(result.created, "created is false")
      try expect(result.filed == true, "filed is \(String(describing: result.filed))")
      try expect(result.changed == ["collections"], "changed is \(result.changed)")
      let id = try uuid(result)
      try expect(try guidesOf(storeURL, id) == ["guide"], "the new place is not in the guide")
      try expect(try placesCount(storeURL, MapsID.guide) == 2, "placesCount is not 2")
      let values = try mapsValues(storeURL, "CollectionPlaceItem", id)
      let keys = newSavedPlaceKeys.union(["mapItemName", "muid"])
      try expect(Set(values.keys) == keys, "the saved place holds \(values.keys.sorted())")
      try expect(
        try mapsRecord(storeURL, "CollectionPlaceItem", id) == syntheticRecord(1),
        "the record is not the recent's bytes")
      try expectNewRecord(storeURL, "CollectionPlaceItem", id)
    }

    check("removeFavoriteRefusesSlots") {
      let (writer, storeURL) = try mapsFixture("remove-favorite-slot")
      for type in [Int16(0), Int16(2)] {
        try maps(storeURL) {
          try mapsRow("FavoriteItem", MapsID.favorite, in: $0).setValue(type, forKey: "type")
        }
        try expectNoMapsHistory(storeURL, "removing a type \(type) favourite") {
          let message = try expectRefusal("invalid", "type \(type)") {
            _ = try writer.removeFavorite(id: MapsID.favorite.uuidString)
          }
          try expect(
            !message.lowercased().contains(MapsID.favorite.uuidString.lowercased()),
            "the refusal repeats the id: \(message)")
        }
      }
      try expect(try mapsCount(storeURL, "FavoriteItem") == 1, "the slot went")
      try expect(try mapsCount(storeURL, "CollectionPlaceItem") == 1, "a saved place was made")
    }

    check("addFavoriteNegativeCoordinate") {
      let (writer, storeURL) = try mapsFixture("add-favorite-west")
      // West of Greenwich, off the four-decimal grid: -0.12454 rounds to -0.1245, not -0.1246.
      let west = UUID()
      try mapsInsert(
        storeURL, "CollectionPlaceItem", ["identifier": west], record: (7, (51.50072, -0.12454)))
      let result = try writer.addFavorite(
        source: .savedPlace, sourceId: west.uuidString, query: "Synthetic query", name: "Synthetic",
        near: nil)
      let values = try mapsValues(storeURL, "FavoriteItem", try uuid(result))
      try expect(
        values["shortcutIdentifier"] as? String == "51.50070,-0.12450",
        "shortcutIdentifier is \(values["shortcutIdentifier"] ?? "nil")")
    }

    check("sameSpotLookup") {
      // A saved place whose coordinate lives only in its record is the one at that spot.
      let (writer, storeURL) = try mapsFixture("same-spot-record")
      let recordOnly = UUID()
      try mapsInsert(
        storeURL, "CollectionPlaceItem", ["identifier": recordOnly],
        record: (5, recentRecordAt))
      var saved: MapsWriter.Result?
      try expectNoMapsHistory(storeURL, "savePlace onto a record-only saved place") {
        saved = try writer.savePlace(
          source: .recent, sourceId: MapsID.recent.uuidString, query: "Synthetic query", name: nil,
          near: nil)
      }
      try expect(
        saved?.id == recordOnly.uuidString.lowercased() && saved?.created == false,
        "savePlace answers \(String(describing: saved))")
      // A Home or Work slot at the spot is not a pin: a pin is made beside it.
      try mapsInsert(
        storeURL, "FavoriteItem",
        [
          "identifier": UUID(), "type": Int16(0), "latitude": recentRecordAt.0,
          "longitude": recentRecordAt.1,
        ])
      let pinned = try writer.addFavorite(
        source: .recent, sourceId: MapsID.recent.uuidString, query: "Synthetic query",
        name: "Synthetic", near: nil)
      try expect(pinned.created, "the slot was taken for a pin")
      // A row with no identifier there cannot be named: failed, not the caller's mistake.
      let (other, otherURL) = try mapsFixture("same-spot-unnamed")
      try mapsInsert(
        otherURL, "CollectionPlaceItem",
        ["latitude": recentRecordAt.0, "longitude": recentRecordAt.1])
      try expectNoMapsHistory(otherURL, "savePlace onto an unnamed saved place") {
        try expectRefusal("failed", "an unnamed saved place") {
          _ = try other.savePlace(
            source: .recent, sourceId: MapsID.recent.uuidString, query: "Synthetic query",
            name: nil, near: nil)
        }
      }
    }

    check("zeroRecordIsNoCoordinate") {
      let (writer, storeURL) = try mapsFixture("zero-record")
      let zero = UUID()
      try mapsInsert(storeURL, "HistoryPlaceItem", ["identifier": zero], record: (6, (0, 0)))
      try expectNoMapsHistory(storeURL, "addFavorite from a (0, 0) record") {
        try expectRefusal("notFound", "a (0, 0) record") {
          _ = try writer.addFavorite(
            source: .recent, sourceId: zero.uuidString, query: "Synthetic query", name: "Synthetic",
            near: nil)
        }
      }
    }

    check("fileInGuideFilesTheSavedPlaceThere") {
      let (writer, storeURL) = try mapsFixture("file-onto-saved")
      let saved = try writer.savePlace(
        source: .favorite, sourceId: MapsID.favorite.uuidString, query: "Synthetic query",
        name: nil, near: nil)
      let placeID = try uuid(saved)
      var result: MapsWriter.Result?
      try expectMapsHistory(
        storeURL, "fileInGuide from a source with a saved place there",
        extra: [placeID: "place"],
        [
          HistoryChange(
            row: "CollectionPlaceItem place", properties: ["collections", "modificationTime"]),
          HistoryChange(row: "Collection guide", properties: ["modificationTime", "places"]),
        ]
      ) {
        result = try writer.fileInGuide(
          guideTitle: "Synthetic guide", placeId: nil, source: .favorite,
          sourceId: MapsID.favorite.uuidString, query: "Synthetic query",
          name: "Synthetic favourite", near: favoriteAt)
      }
      try expect(result?.id == saved.id, "id is \(result?.id ?? "nil"), not the saved place")
      try expect(result?.created == false, "created is true")
      try expect(result?.filed == true, "filed is \(String(describing: result?.filed))")
      try expect(result?.changed == ["collections"], "changed is \(result?.changed ?? [])")
      try expect(try mapsCount(storeURL, "CollectionPlaceItem") == 2, "a second place was saved")
      try expect(try guidesOf(storeURL, placeID) == ["guide"], "the place is not in the guide")
    }

    check("fileInGuideRefusesAmbiguousTitle") {
      let (writer, storeURL) = try mapsFixture("file-ambiguous")
      try expectNoMapsHistory(storeURL, "an ambiguous Guide") {
        let message = try expectRefusal("invalid", "Synthetic twin") {
          _ = try writer.fileInGuide(
            guideTitle: "Synthetic twin", placeId: MapsID.saved.uuidString, source: nil,
            sourceId: nil, query: nil, name: nil, near: nil)
        }
        for twin in [MapsID.twinA, MapsID.twinB] {
          try expect(
            message.lowercased().contains(twin.uuidString.lowercased()),
            "the refusal does not name \(twin): \(message)")
        }
        try expect(!message.contains("Synthetic"), "the refusal repeats a title: \(message)")
      }
    }

    check("fileInGuideRefusesUnknownTitle") {
      let (writer, storeURL) = try mapsFixture("file-unknown")
      try expectNoMapsHistory(storeURL, "an unknown Guide") {
        let message = try expectRefusal("invalid", "Synthetic none") {
          _ = try writer.fileInGuide(
            guideTitle: "Synthetic none", placeId: nil, source: .recent,
            sourceId: MapsID.recent.uuidString, query: "Synthetic recent place", name: nil,
            near: nil)
        }
        for guide in [MapsID.guide, MapsID.twinA, MapsID.twinB] {
          try expect(
            message.lowercased().contains(guide.uuidString.lowercased()),
            "the refusal does not name \(guide): \(message)")
        }
        try expect(!message.contains("Synthetic"), "the refusal repeats a title: \(message)")
      }
      try expect(try mapsCount(storeURL, "CollectionPlaceItem") == 1, "a place was saved")
    }

    check("fileInGuideRefusesBadArguments") {
      let (writer, storeURL) = try mapsFixture("file-arguments")
      try expectNoMapsHistory(storeURL, "malformed fileInGuide calls") {
        let place = MapsID.saved.uuidString
        let recent = MapsID.recent.uuidString
        let calls: [(String, () throws -> Void)] = [
          (
            "both a placeId and a source",
            {
              _ = try writer.fileInGuide(
                guideTitle: "Synthetic guide", placeId: place, source: .recent, sourceId: recent,
                query: "Synthetic query", name: nil, near: nil)
            }
          ),
          (
            "neither",
            {
              _ = try writer.fileInGuide(
                guideTitle: "Synthetic guide", placeId: nil, source: nil, sourceId: nil,
                query: nil, name: nil, near: nil)
            }
          ),
          (
            "a source without its id",
            {
              _ = try writer.fileInGuide(
                guideTitle: "Synthetic guide", placeId: nil, source: .recent, sourceId: nil,
                query: "Synthetic query", name: nil, near: nil)
            }
          ),
          (
            "a name with a placeId",
            {
              _ = try writer.fileInGuide(
                guideTitle: "Synthetic guide", placeId: place, source: nil, sourceId: nil,
                query: nil, name: "Synthetic", near: nil)
            }
          ),
          (
            "a query with a placeId",
            {
              _ = try writer.fileInGuide(
                guideTitle: "Synthetic guide", placeId: place, source: nil, sourceId: nil,
                query: "Synthetic query", name: nil, near: nil)
            }
          ),
          (
            "a source without its query",
            {
              _ = try writer.fileInGuide(
                guideTitle: "Synthetic guide", placeId: nil, source: .recent, sourceId: recent,
                query: nil, name: "Synthetic", near: nil)
            }
          ),
          (
            "a blank Guide title",
            {
              _ = try writer.fileInGuide(
                guideTitle: "  ", placeId: place, source: nil, sourceId: nil, query: nil, name: nil,
                near: nil)
            }
          ),
        ]
        for (label, call) in calls {
          let message = try expectRefusal("invalid", label, call)
          try expect(!message.contains(place), "\(label): the refusal repeats the id")
        }
      }
    }

    check("sourceVanished") {
      let (writer, storeURL) = try mapsFixture("vanished")
      let gone = UUID().uuidString
      try expectNoMapsHistory(storeURL, "calls naming nothing") {
        let calls: [(String, () throws -> Void)] = [
          (
            "addFavorite from a gone recent",
            {
              _ = try writer.addFavorite(
                source: .recent, sourceId: gone, query: "Synthetic query", name: nil, near: nil)
            }
          ),
          (
            "savePlace from a gone recent",
            {
              _ = try writer.savePlace(
                source: .recent, sourceId: gone, query: "Synthetic query", name: nil, near: nil)
            }
          ),
          (
            // Entity-scoped: a favourite's id does not name a saved place.
            "savePlace from the favourite, called a saved place",
            {
              _ = try writer.savePlace(
                source: .savedPlace, sourceId: MapsID.favorite.uuidString, query: "Synthetic query",
                name: nil, near: nil)
            }
          ),
          (
            "a recent with no record",
            {
              _ = try writer.addFavorite(
                source: .recent, sourceId: MapsID.bareRecent.uuidString, query: "Synthetic query",
                name: "Synthetic", near: nil)
            }
          ),
          ("removeFavorite of nothing", { _ = try writer.removeFavorite(id: gone) }),
          (
            "removeFavorite of a saved place",
            { _ = try writer.removeFavorite(id: MapsID.saved.uuidString) }
          ),
          ("removeSavedPlace of nothing", { _ = try writer.removeSavedPlace(id: gone) }),
          (
            "removeSavedPlace of a favourite",
            { _ = try writer.removeSavedPlace(id: MapsID.favorite.uuidString) }
          ),
          (
            "fileInGuide of nothing",
            {
              _ = try writer.fileInGuide(
                guideTitle: "Synthetic guide", placeId: gone, source: nil, sourceId: nil,
                query: nil, name: nil, near: nil)
            }
          ),
        ]
        for (label, call) in calls {
          let message = try expectRefusal("notFound", label, call)
          try expect(!message.contains(gone), "\(label): the refusal repeats the id")
        }
      }
    }

    check("badIds") {
      let (writer, storeURL) = try mapsFixture("bad-ids")
      let bad = "not-a-uuid-secret"
      let recent = MapsID.recent.uuidString
      try expectNoMapsHistory(storeURL, "calls with bad ids") {
        let calls: [(String, () throws -> Void)] = [
          (
            "addFavorite",
            {
              _ = try writer.addFavorite(
                source: .recent, sourceId: bad, query: "Synthetic query", name: nil, near: nil)
            }
          ),
          (
            "savePlace",
            {
              _ = try writer.savePlace(
                source: .recent, sourceId: bad, query: "Synthetic query", name: nil, near: nil)
            }
          ),
          ("removeFavorite", { _ = try writer.removeFavorite(id: bad) }),
          ("removeSavedPlace", { _ = try writer.removeSavedPlace(id: "") }),
          (
            "fileInGuide placeId",
            {
              _ = try writer.fileInGuide(
                guideTitle: "Synthetic guide", placeId: bad, source: nil, sourceId: nil,
                query: nil, name: nil, near: nil)
            }
          ),
          (
            "fileInGuide sourceId",
            {
              _ = try writer.fileInGuide(
                guideTitle: "Synthetic guide", placeId: nil, source: .recent, sourceId: bad,
                query: "Synthetic query", name: nil, near: nil)
            }
          ),
          (
            "a blank name",
            {
              _ = try writer.addFavorite(
                source: .recent, sourceId: recent, query: "Synthetic query", name: " ", near: nil)
            }
          ),
          (
            "a name with a line break",
            {
              _ = try writer.savePlace(
                source: .recent, sourceId: recent, query: "Synthetic query", name: "a\nb", near: nil
              )
            }
          ),
          (
            "a blank query",
            {
              _ = try writer.addFavorite(
                source: .recent, sourceId: recent, query: "  ", name: nil, near: nil)
            }
          ),
          (
            "a query with a line break",
            {
              _ = try writer.fileInGuide(
                guideTitle: "Synthetic guide", placeId: nil, source: .recent, sourceId: recent,
                query: "a\nb", name: nil, near: nil)
            }
          ),
          (
            "a query over 500 characters",
            {
              _ = try writer.savePlace(
                source: .recent, sourceId: recent, query: String(repeating: "q", count: 501),
                name: nil, near: nil)
            }
          ),
          (
            "a latitude past 90",
            {
              _ = try writer.addFavorite(
                source: .recent, sourceId: recent, query: "Synthetic query", name: nil,
                near: (91, 2))
            }
          ),
          (
            "a NaN longitude",
            {
              _ = try writer.savePlace(
                source: .recent, sourceId: recent, query: "Synthetic query", name: nil,
                near: (48, .nan))
            }
          ),
        ]
        for (label, call) in calls {
          let message = try expectRefusal("invalid", label, call)
          try expect(!message.contains(bad), "\(label): the refusal repeats the id")
        }
      }
    }

    check("versionKeyIsChecksum") {
      let (writer, _) = try mapsFixture("version")
      // Measured 2026-11-11 on macOS 27.2: the one checksum, and no other.
      try expect(
        MapsWriter.measuredVersions == ["CaxhFkDDBEvVUHzx/wKUv4k+QehKTgcfEuPWR91+uhk="],
        "measuredVersions is \(MapsWriter.measuredVersions.sorted())")
      let status = writer.status()
      try expect(status.compatible, "the fixture is incompatible: \(status)")
      try expect(status.modelVersion != nil, "no model version")
      try expect(
        status.modelVersion == mapsChecksum(),
        "modelVersion \(status.modelVersion ?? "nil") is not the .momd's checksum")
      let measured = MapsWriter.measuredVersions.contains(mapsChecksum() ?? "")
      try expect(
        status.syncMeasured == measured,
        "syncMeasured is \(status.syncMeasured) for \(status.modelVersion ?? "nil")")
      let result = try writer.removeSavedPlace(id: MapsID.saved.uuidString)
      try expect(
        result.modelVersion == status.modelVersion && result.syncMeasured == measured,
        "a write reports \(result.modelVersion ?? "nil"), \(result.syncMeasured)")
      try expect(
        MapsWriter.storePath == "Library/Containers/com.apple.Maps/Data/Maps/MapsSync_0.0.1",
        "storePath is \(MapsWriter.storePath)")
    }

    mapsLaneCases()
  }
}

// MARK: - The lane's dispatch, for Maps

extension StoreLaneCheck {
  /// `line` through the lane as a maps server sends it, parsed. Voice Memos' writer is one over
  /// no store, so a call that strayed into it would fail rather than touch anything.
  static func mapsReply(
    _ line: String, borrower: String = "maps", allowWrites: Bool = true, _ writer: MapsWriter
  ) throws -> [String: Any] {
    try parse(
      StoreLane.handle(
        line, borrower: borrower, allowWrites: allowWrites, voiceMemos: absentWriter(),
        maps: writer))
  }

  /// A Maps writer over a store that is not there.
  static func absentMapsWriter() -> MapsWriter {
    MapsWriter(store: MapsWriter.store(at: scratch.appendingPathComponent("absent/MapsSync")))
  }

  /// `near` as the node client puts it on the wire.
  static func near(_ at: (Double, Double)) -> [String: Any] {
    ["latitude": at.0, "longitude": at.1]
  }

  /// The reply's result, checked to hold exactly the keys lane.ts reads for a write: `filed`
  /// only where the method files.
  static func mapsWrite(_ answer: [String: Any], _ label: String, filed: Bool = false) throws
    -> [String: Any]
  {
    guard let result = answer["result"] as? [String: Any], answer["error"] == nil else {
      throw Failure(why: "\(label) is not a result: \(answer)")
    }
    var keys: Set<String> = ["id", "changed", "created", "modelVersion", "syncMeasured"]
    if filed { keys.insert("filed") }
    try expect(Set(result.keys) == keys, "\(label) result keys are \(result.keys.sorted())")
    try expect(
      (result["id"] as? String).flatMap(UUID.init(uuidString:)) != nil,
      "\(label) id is not a uuid: \(result["id"] ?? "absent")")
    try expect(result["changed"] is [String], "\(label) changed is \(result["changed"] ?? "")")
    try expect(isJSONBool(result["created"]), "\(label) created is not a boolean")
    if filed { try expect(isJSONBool(result["filed"]), "\(label) filed is not a boolean") }
    try expect(
      result["modelVersion"] as? String == mapsChecksum(),
      "\(label) modelVersion is \(result["modelVersion"] ?? "absent")")
    try expect(isJSONBool(result["syncMeasured"]), "\(label) syncMeasured is not a boolean")
    let measured = MapsWriter.measuredVersions.contains(mapsChecksum() ?? "")
    try expect(
      result["syncMeasured"] as? Bool == measured, "\(label) syncMeasured is not \(measured)")
    return result
  }

  static func isJSONBool(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber else { return false }
    return CFGetTypeID(number) == CFBooleanGetTypeID()
  }

  static func uuid(_ result: [String: Any]) throws -> UUID {
    guard let uuid = (result["id"] as? String).flatMap(UUID.init(uuidString:)) else {
      throw Failure(why: "the result's id is not a uuid: \(result)")
    }
    return uuid
  }

  static func sameId(_ a: Any?, _ b: String) -> Bool {
    (a as? String)?.lowercased() == b.lowercased()
  }

  /// The checks that reach no writer: who is admitted, and which methods a borrower has.
  static func mapsLaneDoorCases() {
    check("mapsAdmission") {
      try expect(
        StoreLane.surfaces == ["voice-memos", "maps"], "surfaces is \(StoreLane.surfaces)")
      try expect(
        StoreLane.admit(borrowerId: "maps", peerSurface: "maps") == nil,
        "the maps server is refused its own lane")
      // A voice-memos server claiming `for=maps`, another surface's, and no spawned server.
      for peer in ["voice-memos", "mail", nil] as [String?] {
        let refusal = StoreLane.admit(borrowerId: "maps", peerSurface: peer)
        try expect(
          refusal == "this connection is not a maps server",
          "peer \(peer ?? "nil") gets \(refusal ?? "admitted")")
      }
      let borrowed = StoreLane.admit(borrowerId: "voice-memos", peerSurface: "maps")
      try expect(
        borrowed == "this connection is not a voice-memos server",
        "a maps server claiming voice-memos gets \(borrowed ?? "admitted")")
    }

    check("mapsNamespace") {
      for (borrower, method) in [
        ("maps", "voiceMemos.rename"), ("maps", "voiceMemos.status"),
        ("maps", "maps.rename"), ("maps", "maps.nope"), ("maps", "maps."),
        ("maps", "Maps.status"), ("maps", "mapsaddFavorite"),
        ("voice-memos", "maps.status"), ("voice-memos", "maps.addFavorite"),
        ("voice-memos", "voiceMemos.addFavorite"), ("voice-memos", "voiceMemos.fileInGuide"),
      ] {
        // Writes on and well-formed params: only the namespace can refuse it.
        let answer = try mapsReply(
          request(
            8, method,
            ["id": MapsID.saved.uuidString, "title": "Synthetic", "source": "recent"]),
          borrower: borrower, absentMapsWriter())
        let (code, _, _) = try failure(answer)
        try expect(code == -32601, "\(method) from \(borrower): code \(code)")
        try expect(answer["id"] as? Int == 8, "\(method) from \(borrower): id not echoed")
      }
    }
  }

  /// The checks over the fixture: every method with the params the node client sends.
  static func mapsLaneCases() {
    let recent = MapsID.recent.uuidString.lowercased()
    let favorite = MapsID.favorite.uuidString.lowercased()

    check("mapsRoundTrip") {
      let (writer, storeURL) = try mapsFixture("lane-round-trip")
      // As node sends a call that gave no name: the query, and no `name` key.
      let place: [String: Any] = [
        "source": "recent", "sourceId": recent, "query": "Synthetic recent place",
        "near": near(recentAt),
      ]

      // addFavorite, in one transaction, its request id given back as sent.
      var text = ""
      try expectMapsHistory(
        storeURL, "maps.addFavorite", [inserted("FavoriteItem"), inserted("MixinMapItem")]
      ) {
        text = StoreLane.handle(
          try request(51, "maps.addFavorite", place), borrower: "maps", allowWrites: true,
          voiceMemos: absentWriter(), maps: writer)
      }
      try expect(
        text.range(of: #""id":51[,}]"#, options: .regularExpression) != nil,
        "id 51 is not echoed as given: \(text)")
      let added = try mapsWrite(parse(text), "maps.addFavorite")
      try expect(added["created"] as? Bool == true, "addFavorite created is not true")
      try expect(
        added["changed"] as? [String] == newFavoriteKeys.union(["mapItemName", "muid"]).sorted(),
        "addFavorite changed is \(added["changed"] ?? "")")
      let pin = try uuid(added)
      let pinValues = try mapsValues(storeURL, "FavoriteItem", pin)
      try expect(
        pinValues["mapItemName"] as? String == "Synthetic recent place",
        "the query did not cross the lane as the placeholder name")
      try expect(pinValues["customName"] == nil, "no name was sent, yet the pin has a customName")

      // Again: the pin already there, nothing saved.
      try expectNoMapsHistory(storeURL, "maps.addFavorite again") {
        let again = try mapsWrite(
          mapsReply(request(52, "maps.addFavorite", place), writer), "addFavorite again")
        try expect(again["created"] as? Bool == false, "addFavorite again created a pin")
        try expect(again["changed"] as? [String] == [], "addFavorite again changed something")
        try expect(sameId(again["id"], pin.uuidString), "addFavorite again names another pin")
      }

      // fileInGuide from a source: saved and filed in one save.
      let fromSource = try mapsWrite(
        mapsReply(
          request(53, "maps.fileInGuide", place.merging(["guide": "Synthetic guide"]) { $1 }),
          writer), "fileInGuide from a source", filed: true)
      try expect(fromSource["created"] as? Bool == true, "fileInGuide from a source created none")
      try expect(fromSource["filed"] as? Bool == true, "fileInGuide from a source did not file")
      let filedPlace = try uuid(fromSource)
      try expect(try guidesOf(storeURL, filedPlace) == ["guide"], "the new place is not filed")

      // savePlace with no name and no near: both left off the wire.
      let saved = try mapsWrite(
        mapsReply(
          request(
            54, "maps.savePlace",
            ["source": "favorite", "sourceId": favorite, "query": "Synthetic query"]), writer),
        "maps.savePlace")
      try expect(saved["created"] as? Bool == true, "savePlace created none")
      let savedPlace = try uuid(saved)
      let values = try mapsValues(storeURL, "CollectionPlaceItem", savedPlace)
      try expect(
        values["mapItemName"] as? String == "Synthetic favourite",
        "savePlace did not keep the favourite's name: \(values["mapItemName"] ?? "nil")")
      try expect(try guidesOf(storeURL, savedPlace) == [], "the saved place is filed")

      // fileInGuide by placeId, the id spelled as node spells it: lowercase.
      let byId = try mapsWrite(
        mapsReply(
          request(
            55, "maps.fileInGuide",
            ["guide": "Synthetic guide", "placeId": savedPlace.uuidString.lowercased()]),
          writer), "fileInGuide by placeId", filed: true)
      try expect(byId["created"] as? Bool == false, "fileInGuide by placeId created one")
      try expect(byId["filed"] as? Bool == true, "fileInGuide by placeId did not file")
      try expect(byId["changed"] as? [String] == ["collections"], "byId answered \(byId)")
      try expect(sameId(byId["id"], savedPlace.uuidString), "fileInGuide names another place")
      try expect(try guidesOf(storeURL, savedPlace) == ["guide"], "the place is not filed")

      // removeFavorite: the library already holds the pin's spot, so nothing goes in.
      let removed = try mapsWrite(
        mapsReply(request(56, "maps.removeFavorite", ["id": pin.uuidString.lowercased()]), writer),
        "maps.removeFavorite")
      try expect(removed["changed"] as? [String] == ["favorite"], "removed answered \(removed)")
      try expect(removed["created"] as? Bool == false, "removeFavorite created a saved place")
      try expect(sameId(removed["id"], pin.uuidString), "removeFavorite names another pin")
      try expect(try mapsCount(storeURL, "FavoriteItem") == 1, "the pin is still there")

      let unsaved = try mapsWrite(
        mapsReply(
          request(57, "maps.removeSavedPlace", ["id": savedPlace.uuidString.lowercased()]),
          writer), "maps.removeSavedPlace")
      try expect(unsaved["changed"] as? [String] == ["savedPlace"], "unsaved answered \(unsaved)")
      try expect(unsaved["created"] as? Bool == false, "removeSavedPlace created something")
      try expect(try mapsCount(storeURL, "CollectionPlaceItem") == 2, "not one place removed")

      let answer = try mapsReply(request(58, "maps.status", [:]), writer)
      guard let status = answer["result"] as? [String: Any] else {
        throw Failure(why: "maps.status is not a result: \(answer)")
      }
      try expect(
        Set(status.keys) == ["compatible", "modelVersion", "syncMeasured", "refusal"],
        "status keys are \(status.keys.sorted())")
      try expect(status["compatible"] as? Bool == true, "status is not compatible: \(status)")
      try expect(status["modelVersion"] as? String == mapsChecksum(), "status version differs")
      try expect(
        status["syncMeasured"] as? Bool
          == MapsWriter.measuredVersions.contains(mapsChecksum() ?? ""),
        "status syncMeasured is \(status["syncMeasured"] ?? "absent")")
      try expect(status["refusal"] is NSNull, "status refusal is \(status["refusal"] ?? "")")
    }

    // `near`, `query` and `name` reach the writer: dropping one in the dispatch turns a check
    // off, or saves a place under another label, with every reply still well formed.
    check("mapsNearAndNameCrossTheLane") {
      let (writer, storeURL) = try mapsFixture("lane-near-name")
      // In range, and 1 km from the recent's record: the writer's 250 m guard refuses it.
      let far = near(north(of: recentAt, metres: 1_000))
      let favorites = try mapsCount(storeURL, "FavoriteItem")
      let places = try mapsCount(storeURL, "CollectionPlaceItem")
      try expectNoMapsHistory(storeURL, "a far near") {
        for (method, params) in [
          (
            "maps.addFavorite", ["source": "recent", "sourceId": recent, "query": "Q", "near": far]
          ),
          ("maps.savePlace", ["source": "recent", "sourceId": recent, "query": "Q", "near": far]),
          (
            "maps.fileInGuide",
            [
              "guide": "Synthetic guide", "source": "recent", "sourceId": recent, "query": "Q",
              "near": far,
            ]
          ),
        ] as [(String, [String: Any])] {
          let (code, reason, message) = try failure(mapsReply(request(12, method, params), writer))
          try expect(code == -32000, "\(method) with a far near: code \(code)")
          try expect(
            reason == "invalid", "\(method) with a far near: \(reason ?? "nil") (\(message))")
        }
      }
      try expect(try mapsCount(storeURL, "FavoriteItem") == favorites, "a favourite was saved")
      try expect(try mapsCount(storeURL, "CollectionPlaceItem") == places, "a place was saved")

      // The caller's query and name, read back from the place each call saved. A recent has no
      // name of its own, so the query stands in as `mapItemName` and the name is the custom one.
      let filed = try mapsWrite(
        mapsReply(
          request(
            13, "maps.fileInGuide",
            [
              "guide": "Synthetic guide", "source": "recent", "sourceId": recent,
              "query": "Synthetic filed query", "name": "Synthetic filed name",
            ]), writer), "fileInGuide with a name", filed: true)
      try expect(filed["created"] as? Bool == true, "fileInGuide with a name created none")
      let filedValues = try mapsValues(storeURL, "CollectionPlaceItem", uuid(filed))
      try expect(
        filedValues["mapItemName"] as? String == "Synthetic filed query",
        "the filed place's mapItemName is \(filedValues["mapItemName"] ?? "nil")")
      try expect(
        filedValues["customName"] as? String == "Synthetic filed name",
        "the filed place's customName is \(filedValues["customName"] ?? "nil")")
      let saved = try mapsWrite(
        mapsReply(
          request(
            14, "maps.savePlace",
            [
              "source": "favorite", "sourceId": favorite, "query": "Synthetic saved query",
              "name": "Synthetic saved name",
            ]),
          writer), "savePlace with a name")
      try expect(saved["created"] as? Bool == true, "savePlace with a name created none")
      // The favourite has a name of its own, so the caller's is the custom one.
      let savedValues = try mapsValues(storeURL, "CollectionPlaceItem", uuid(saved))
      try expect(
        savedValues["customName"] as? String == "Synthetic saved name",
        "the saved place's customName is \(savedValues["customName"] ?? "nil")")
      try expect(
        savedValues["mapItemName"] as? String == "Synthetic favourite",
        "the saved place's mapItemName is \(savedValues["mapItemName"] ?? "nil")")
    }

    // Every write as node sends it, and one with no params at all.
    let writes: [(String, [String: Any])] = [
      (
        "maps.addFavorite",
        ["source": "recent", "sourceId": recent, "query": "Synthetic", "near": near(recentAt)]
      ),
      (
        "maps.savePlace",
        ["source": "recent", "sourceId": recent, "query": "Synthetic", "name": "Synthetic"]
      ),
      ("maps.removeFavorite", ["id": favorite]),
      ("maps.removeSavedPlace", ["id": MapsID.saved.uuidString.lowercased()]),
      ("maps.fileInGuide", ["guide": "Synthetic guide", "placeId": favorite]),
      (
        "maps.fileInGuide",
        ["guide": "Synthetic guide", "source": "recent", "sourceId": recent, "query": "Synthetic"]
      ),
      // Refused before its params are read: a malformed write is still a write.
      ("maps.addFavorite", [:]),
    ]

    check("mapsWritesOff") {
      let (writer, storeURL) = try mapsFixture("lane-writes-off")
      try expectNoMapsHistory(storeURL, "writes-off calls") {
        for (method, params) in writes {
          let answer = try mapsReply(request(9, method, params), allowWrites: false, writer)
          let (code, reason, message) = try failure(answer)
          try expect(code == -32000, "\(method) code is \(code)")
          try expect(reason == "writesOff", "\(method) reason is \(reason ?? "nil")")
          try expect(
            message == "writes are off for Maps in Cupertino", "\(method) says \(message)")
          try expect(answer["id"] as? Int == 9, "\(method) id is \(answer["id"] ?? "absent")")
        }
      }
      try expect(
        StoreLane.mapsWritesOff == "writes are off for Maps in Cupertino",
        "mapsWritesOff is \(StoreLane.mapsWritesOff)")
      try expect(try mapsCount(storeURL, "FavoriteItem") == 1, "the favourite went")
      for params in [nil, [:]] as [[String: Any]?] {
        let answer = try mapsReply(request(10, "maps.status", params), allowWrites: false, writer)
        guard let result = answer["result"] as? [String: Any] else {
          throw Failure(why: "status is not a result: \(answer)")
        }
        try expect(result["compatible"] as? Bool == true, "status is not compatible: \(result)")
        try expect(result["modelVersion"] as? String == mapsChecksum(), "status version differs")
      }
    }

    check("mapsInvalidParams") {
      let (writer, storeURL) = try mapsFixture("lane-invalid")
      let secret = "Synthetic secret name"
      let secretQuery = "Synthetic secret query"
      let guide = "Synthetic guide"
      let placeId = MapsID.saved.uuidString.lowercased()
      let base: [String: Any] = ["source": "recent", "sourceId": recent, "query": secretQuery]
      func with(_ extra: [String: Any]) -> [String: Any] { base.merging(extra) { $1 } }
      let cases: [(String, String, Any)] = [
        ("addFavorite {}", "maps.addFavorite", [String: Any]()),
        ("no sourceId", "maps.addFavorite", ["source": "recent"]),
        ("no source", "maps.savePlace", ["sourceId": recent]),
        ("unknown source", "maps.addFavorite", with(["source": "bogusSecret"])),
        ("numeric source", "maps.addFavorite", with(["source": 1])),
        ("numeric sourceId", "maps.addFavorite", with(["sourceId": 7])),
        ("sourceId not a uuid", "maps.savePlace", with(["sourceId": "not-a-uuid-secret"])),
        ("numeric name", "maps.addFavorite", with(["name": 7])),
        ("null name", "maps.savePlace", with(["name": NSNull()])),
        ("blank name", "maps.savePlace", with(["name": "  "])),
        ("no query", "maps.addFavorite", ["source": "recent", "sourceId": recent]),
        ("savePlace, no query", "maps.savePlace", ["source": "recent", "sourceId": recent]),
        ("numeric query", "maps.addFavorite", with(["query": 7])),
        ("null query", "maps.savePlace", with(["query": NSNull()])),
        ("blank query", "maps.addFavorite", with(["query": "  "])),
        (
          "fileInGuide source, no query", "maps.fileInGuide",
          ["guide": guide, "source": "recent", "sourceId": recent]
        ),
        (
          "a query with a placeId", "maps.fileInGuide",
          ["guide": guide, "placeId": placeId, "query": secretQuery]
        ),
        ("near without longitude", "maps.addFavorite", with(["near": ["latitude": 48.85]])),
        ("near without latitude", "maps.savePlace", with(["near": ["longitude": 2.31]])),
        (
          "near's latitude a string", "maps.addFavorite",
          with(["near": ["latitude": "48.85", "longitude": 2.31]])
        ),
        (
          "near's latitude a boolean", "maps.addFavorite",
          with(["near": ["latitude": true, "longitude": 2.31]])
        ),
        (
          "latitude past 90", "maps.addFavorite",
          with(["near": ["latitude": 91.5, "longitude": 2.31]])
        ),
        (
          "longitude past 180", "maps.savePlace",
          with(["near": ["latitude": 48.85, "longitude": -181.25]])
        ),
        ("near a string", "maps.addFavorite", with(["near": "48.85,2.31"])),
        ("near an array", "maps.savePlace", with(["near": [48.85, 2.31]])),
        ("null near", "maps.addFavorite", with(["near": NSNull()])),
        ("removeFavorite {}", "maps.removeFavorite", [String: Any]()),
        ("numeric id", "maps.removeFavorite", ["id": 7]),
        ("id not a uuid", "maps.removeSavedPlace", ["id": "not-a-uuid-secret"]),
        ("removeSavedPlace {}", "maps.removeSavedPlace", [String: Any]()),
        ("fileInGuide, no guide", "maps.fileInGuide", ["placeId": placeId]),
        ("numeric guide", "maps.fileInGuide", ["guide": 7, "placeId": placeId]),
        ("neither placeId nor source", "maps.fileInGuide", ["guide": guide]),
        ("both", "maps.fileInGuide", with(["guide": guide, "placeId": placeId])),
        ("a source without its id", "maps.fileInGuide", ["guide": guide, "source": "recent"]),
        ("a sourceId alone", "maps.fileInGuide", ["guide": guide, "sourceId": recent]),
        ("numeric placeId", "maps.fileInGuide", ["guide": guide, "placeId": 7]),
        (
          "a name with a placeId", "maps.fileInGuide",
          ["guide": guide, "placeId": placeId, "name": secret]
        ),
        ("params an array", "maps.removeFavorite", [placeId]),
      ]
      try expectNoMapsHistory(storeURL, "invalid calls") {
        for (label, method, params) in cases {
          let object: [String: Any] = [
            "jsonrpc": "2.0", "id": 11, "method": method, "params": params,
          ]
          let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
          let answer = try mapsReply(String(decoding: data, as: UTF8.self), writer)
          let (code, reason, message) = try failure(answer)
          try expect(code == -32000, "\(label): code \(code)")
          try expect(reason == "invalid", "\(label): reason \(reason ?? "nil") (\(message))")
          for value in [
            recent, MapsID.recent.uuidString, placeId, secret, secretQuery, guide, "bogusSecret",
            "not-a-uuid-secret", "48.85", "91.5", "181.25",
          ] {
            try expect(
              !message.contains(value), "\(label): the message repeats a value: \(message)")
          }
        }
      }
    }
  }
}
