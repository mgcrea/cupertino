// Names what each save changed in a Core Data store, from its persistent history, against the
// app's own compiled model.
//
//   swiftc -O scripts/history-columns.swift -o <scratch>/history-columns
//   history-columns <model.momd> <store.sqlite> <since-tx>
//
// One JSON line per `ACHANGE` whose transaction is after `since-tx`:
//
//   {"tx":172,"author":…,"bundle":…,"process":…,"entity":"CloudRecording","pk":81,
//    "type":"update","columns":["customLabelForSorting","encryptedTitle","flags"],
//    "values":{…}}
//
// An insert's `ZCOLUMNS` is null, so its `columns` are empty and its `values` say what the
// row holds. `values` (inserts and updates) is every stored attribute and to-one foreign key
// of the row AS IT IS NOW, not as the transaction left it: run this right after the save you
// are watching. A row deleted since has `"values":null`.
//
// ## The store holds personal data
//
// A string prints as "<string len N>" and a blob as "<data len N>", never their contents:
// names, addresses and titles stay out of the output and out of anything it is pasted into.
// Numbers print as they are (a Core Data date is seconds since 2001-01-01).
//
// ## Read-only
//
// The store is opened with SQLITE_OPEN_READONLY and only SELECTed from. It needs Full Disk
// Access for an Apple app's store, which the agent's shell does not have: run it through
// Cupertino's shell tool.
//
// ## Reading a column mask
//
// `ACHANGE.ZCOLUMNS` numbers the changed entity's to-one relationships, then its attributes,
// then its to-many relationships, each group sorted by name; bit i is byte i / 8 under mask
// 0x80 >> (i % 8). Measured on Voice Memos (docs/voice-memos.md).
//
// A sub-entity does NOT sort its full property list. Each group is its superentity's group in
// the superentity's order, then its own properties of that group by name: `HistoryPlaceItem`
// is `mapItem`, then `HistoryItem`'s five attributes, then its own six. Sorting the full list
// names the wrong columns on 58 of Maps' 328 changes. Checked 2026-11-11 against Core Data's
// own `updatedProperties`, one save per attribute and to-one relationship of every concrete
// entity, on stores built from the Maps and Voice Memos models: 367 of 367 agree.
//
// The entity is `Z_PRIMARYKEY.Z_NAME` for `ACHANGE.ZENTITY`. Its rows live in its root
// entity's table, `Z` + the root's name uppercased; a column is `Z` + the property's name
// uppercased, and when two entities sharing a table both declare a name Core Data numbers
// the later ones (`ZLATITUDE1`). Each such attribute prints the one candidate that is not
// null, or all of them by column when more than one is.

import CoreData
import Foundation
import SQLite3

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("history-columns: \(message)\n".utf8))
  exit(1)
}

func note(_ message: String) {
  FileHandle.standardError.write(Data("history-columns: \(message)\n".utf8))
}

let args = CommandLine.arguments
guard args.count == 4, let sinceTx = Int64(args[3]) else {
  fail("usage: history-columns <model.momd> <store.sqlite> <since-tx>")
}
let momdURL = URL(fileURLWithPath: args[1])
let storePath = args[2]

// MARK: - SQLite, read-only

var db: OpaquePointer?
guard sqlite3_open_v2(storePath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
  fail("cannot open \(storePath) read-only: \(String(cString: sqlite3_errmsg(db)))")
}

enum Cell {
  case null
  case integer(Int64)
  case real(Double)
  case text(Int)  // length in bytes; the contents are never read out
  case blob(Data)  // kept for the store's own metadata plist; printed as a length only

  var isNull: Bool { if case .null = self { return true } else { return false } }

  /// The cell as printable JSON, with strings and blobs as their lengths.
  var json: Any {
    switch self {
    case .null: return NSNull()
    case .integer(let v): return NSNumber(value: v)
    case .real(let v): return NSNumber(value: v)
    case .text(let n): return "<string len \(n)>"
    case .blob(let d): return "<data len \(d.count)>"
    }
  }
}

/// Runs a SELECT and returns each row as column name → cell.
func query(_ sql: String, _ bind: [Int64] = []) -> [[String: Cell]] {
  var stmt: OpaquePointer?
  guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
    fail("cannot prepare \(sql): \(String(cString: sqlite3_errmsg(db)))")
  }
  defer { sqlite3_finalize(stmt) }
  for (i, value) in bind.enumerated() { sqlite3_bind_int64(stmt, Int32(i + 1), value) }
  var rows: [[String: Cell]] = []
  while true {
    let rc = sqlite3_step(stmt)
    if rc == SQLITE_DONE { break }
    guard rc == SQLITE_ROW else { fail("cannot step \(sql): \(String(cString: sqlite3_errmsg(db)))") }
    var row: [String: Cell] = [:]
    for c in 0..<sqlite3_column_count(stmt) {
      let name = String(cString: sqlite3_column_name(stmt, c))
      switch sqlite3_column_type(stmt, c) {
      case SQLITE_INTEGER: row[name] = .integer(sqlite3_column_int64(stmt, c))
      case SQLITE_FLOAT: row[name] = .real(sqlite3_column_double(stmt, c))
      case SQLITE_TEXT: row[name] = .text(Int(sqlite3_column_bytes(stmt, c)))
      case SQLITE_BLOB:
        let n = Int(sqlite3_column_bytes(stmt, c))
        row[name] = .blob(n == 0 ? Data() : Data(bytes: sqlite3_column_blob(stmt, c), count: n))
      default: row[name] = .null
      }
    }
    rows.append(row)
  }
  return rows
}

/// Reads a short identifying string (bundle id, process, author) that is not personal data.
func label(_ sql: String, _ bind: Int64) -> [String: String] {
  var stmt: OpaquePointer?
  guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [:] }
  defer { sqlite3_finalize(stmt) }
  sqlite3_bind_int64(stmt, 1, bind)
  var out: [String: String] = [:]
  if sqlite3_step(stmt) == SQLITE_ROW {
    for c in 0..<sqlite3_column_count(stmt) where sqlite3_column_type(stmt, c) == SQLITE_TEXT {
      out[String(cString: sqlite3_column_name(stmt, c))] = String(cString: sqlite3_column_text(stmt, c))
    }
  }
  return out
}

/// Column names via PRAGMA, read as text (the one place a string's contents are read: they are
/// the schema's own column names).
func tableColumns(_ table: String) -> [String] {
  var stmt: OpaquePointer?
  guard sqlite3_prepare_v2(db, "PRAGMA table_info(\"\(table)\")", -1, &stmt, nil) == SQLITE_OK else { return [] }
  defer { sqlite3_finalize(stmt) }
  var names: [String] = []
  while sqlite3_step(stmt) == SQLITE_ROW { names.append(String(cString: sqlite3_column_text(stmt, 1))) }
  return names
}

// MARK: - The model, the version that matches the store

/// The store's own model version hashes, from `Z_METADATA.Z_PLIST`.
func storeVersionHashes() -> [String: Data]? {
  guard case .blob(let plist)? = query("SELECT Z_PLIST FROM Z_METADATA LIMIT 1").first?["Z_PLIST"],
    let dict = try? PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any]
  else { return nil }
  return dict["NSStoreModelVersionHashes"] as? [String: Data]
}

func loadModel() -> NSManagedObjectModel {
  guard let current = NSManagedObjectModel(contentsOf: momdURL) else { fail("cannot load the model at \(momdURL.path)") }
  guard let hashes = storeVersionHashes() else {
    note("the store has no model version hashes; using the bundle's current version")
    return current
  }
  if current.entityVersionHashesByName == hashes { return current }
  let moms = ((try? FileManager.default.contentsOfDirectory(at: momdURL, includingPropertiesForKeys: nil)) ?? [])
    .filter { $0.pathExtension == "mom" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
  for mom in moms {
    if let model = NSManagedObjectModel(contentsOf: mom), model.entityVersionHashesByName == hashes {
      note("the store matches \(mom.lastPathComponent), not the bundle's current version; using it")
      return model
    }
  }
  note("no version in \(momdURL.lastPathComponent) matches the store's hashes; using the current one, names may be wrong")
  return current
}

let model = loadModel()

/// The change mask's property order for an entity: its superentity's order, then its own.
func maskOrder(_ entity: NSEntityDescription) -> [String] {
  let groups = maskGroups(entity)
  return groups.toOne + groups.attrs + groups.toMany
}

/// Each group is the superentity's group, then the entity's own properties of that group by name.
func maskGroups(_ entity: NSEntityDescription) -> (toOne: [String], attrs: [String], toMany: [String]) {
  let parent = entity.superentity.map(maskGroups) ?? (toOne: [], attrs: [], toMany: [])
  let parentNames = Set(entity.superentity?.propertiesByName.keys.map { $0 } ?? [])
  let own = entity.properties.filter { !$0.isTransient && !parentNames.contains($0.name) }
  let rels = own.compactMap { $0 as? NSRelationshipDescription }
  return (
    parent.toOne + rels.filter { !$0.isToMany }.map(\.name).sorted(),
    parent.attrs + own.compactMap { $0 as? NSAttributeDescription }.map(\.name).sorted(),
    parent.toMany + rels.filter { $0.isToMany }.map(\.name).sorted()
  )
}

func decodeMask(_ mask: Data, _ order: [String]) -> [String] {
  var names: [String] = []
  for (byteIndex, byte) in mask.enumerated() {
    for bit in 0..<8 where byte & (0x80 >> UInt8(bit)) != 0 {
      let i = byteIndex * 8 + bit
      names.append(i < order.count ? order[i] : "?bit\(i)")
    }
  }
  return names
}

func root(_ entity: NSEntityDescription) -> NSEntityDescription {
  var e = entity
  while let parent = e.superentity { e = parent }
  return e
}

func allEntities(under entity: NSEntityDescription) -> [NSEntityDescription] {
  [entity] + entity.subentities.flatMap { allEntities(under: $0) }
}

// MARK: - Rows

struct Table {
  let name: String
  let columns: Set<String>
  /// Column names some property in the table's hierarchy claims exactly, so `ZADDRESS1` is not
  /// taken for a numbered `address` when an `address1` exists.
  let claimed: Set<String>
}

var tables: [String: Table] = [:]

func table(for entity: NSEntityDescription) -> Table {
  let r = root(entity)
  if let t = tables[r.name!] { return t }
  let name = "Z" + r.name!.uppercased()
  let claimed = Set(allEntities(under: r).flatMap { $0.properties.map { "Z" + $0.name.uppercased() } })
  let t = Table(name: name, columns: Set(tableColumns(name)), claimed: claimed)
  if t.columns.isEmpty { note("no table \(name) for \(entity.name!)") }
  tables[r.name!] = t
  return t
}

/// The columns a property may live in: `Z<NAME>`, then `Z<NAME>1`, `Z<NAME>2`… not claimed by
/// another property's exact name.
func candidates(_ property: String, in t: Table) -> [String] {
  let base = "Z" + property.uppercased()
  var out: [String] = []
  if t.columns.contains(base) { out.append(base) }
  var n = 1
  while t.columns.contains("\(base)\(n)") {
    if !t.claimed.contains("\(base)\(n)") { out.append("\(base)\(n)") }
    n += 1
  }
  return out
}

func values(of entity: NSEntityDescription, pk: Int64) -> Any {
  let t = table(for: entity)
  guard !t.columns.isEmpty, let row = query("SELECT * FROM \"\(t.name)\" WHERE Z_PK = ?", [pk]).first else {
    return NSNull()
  }
  var out: [String: Any] = [:]
  let stored = entity.properties.filter { !$0.isTransient }
  let toOne = stored.compactMap { $0 as? NSRelationshipDescription }.filter { !$0.isToMany }.map(\.name)
  let attrs = stored.compactMap { $0 as? NSAttributeDescription }.map(\.name)
  for name in toOne + attrs {
    let cells = candidates(name, in: t).map { ($0, row[$0] ?? .null) }
    let set = cells.filter { !$0.1.isNull }
    switch (cells.count, set.count) {
    case (0, _): out[name] = "<no column>"
    case (_, 0): out[name] = NSNull()
    case (_, 1): out[name] = set[0].1.json
    default: out[name] = Dictionary(uniqueKeysWithValues: set.map { ($0.0, $0.1.json) })
    }
  }
  return out
}

// MARK: - JSON, in a fixed key order for reading by eye

func encode(_ value: Any) -> String {
  if let dict = value as? [String: Any] {
    return "{" + dict.keys.sorted().map { "\(encode($0)):\(encode(dict[$0]!))" }.joined(separator: ",") + "}"
  }
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes])
  return String(decoding: data, as: UTF8.self)
}

func line(_ pairs: [(String, Any)]) -> String {
  "{" + pairs.map { "\(encode($0.0)):\(encode($0.1))" }.joined(separator: ",") + "}"
}

// MARK: - The changes

// Z_NAME is the schema's own entity name, so it is read out as text.
var entityNames: [Int64: String] = [:]
do {
  var stmt: OpaquePointer?
  guard sqlite3_prepare_v2(db, "SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY", -1, &stmt, nil) == SQLITE_OK else {
    fail("no Z_PRIMARYKEY: is this a Core Data store?")
  }
  while sqlite3_step(stmt) == SQLITE_ROW {
    entityNames[sqlite3_column_int64(stmt, 0)] = String(cString: sqlite3_column_text(stmt, 1))
  }
  sqlite3_finalize(stmt)
}

let txColumns = Set(tableColumns("ATRANSACTION"))
guard !txColumns.isEmpty, !tableColumns("ACHANGE").isEmpty else {
  fail("no ATRANSACTION/ACHANGE: the store has no persistent history")
}
let txLabels = ["ZAUTHOR": "author", "ZBUNDLEID": "bundle", "ZPROCESSID": "process", "ZCONTEXTNAME": "context"]
  .filter { txColumns.contains($0.key) }
let txLabelSQL = txLabels.isEmpty ? nil
  : "SELECT \(txLabels.keys.sorted().joined(separator: ", ")) FROM ATRANSACTION WHERE Z_PK = ?"

let types: [Int64: String] = [0: "insert", 1: "update", 2: "delete"]
var labelsByTx: [Int64: [String: String]] = [:]

let changes = query(
  "SELECT ZTRANSACTIONID, ZENTITY, ZENTITYPK, ZCHANGETYPE, ZCOLUMNS FROM ACHANGE WHERE ZTRANSACTIONID > ? ORDER BY ZTRANSACTIONID, Z_PK",
  [sinceTx])
for change in changes {
  guard case .integer(let tx)? = change["ZTRANSACTIONID"], case .integer(let ent)? = change["ZENTITY"],
    case .integer(let pk)? = change["ZENTITYPK"], case .integer(let kind)? = change["ZCHANGETYPE"]
  else { continue }
  let entityName = entityNames[ent] ?? "?ent\(ent)"
  let entity = model.entitiesByName[entityName]
  if entity == nil { note("entity \(entityName) is not in the model") }
  let type = types[kind] ?? "?type\(kind)"
  var columnNames: [String] = []
  if case .blob(let mask)? = change["ZCOLUMNS"] {
    columnNames = decodeMask(mask, entity.map(maskOrder) ?? [])
  }
  var pairs: [(String, Any)] = [("tx", tx)]
  if let sql = txLabelSQL {
    if labelsByTx[tx] == nil { labelsByTx[tx] = label(sql, tx) }
    for (column, key) in txLabels.sorted(by: { $0.value < $1.value }) {
      if let v = labelsByTx[tx]?[column] { pairs.append((key, v)) }
    }
  }
  pairs += [("entity", entityName), ("pk", pk), ("type", type), ("columns", columnNames)]
  if kind != 2, let entity { pairs.append(("values", values(of: entity, pk: pk))) }
  print(line(pairs))
}
sqlite3_close(db)
