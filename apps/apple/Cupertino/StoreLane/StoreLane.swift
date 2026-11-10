import CoreFoundation
import Foundation

/// The store lane's door and its dispatch: who may use a surface's lane, and what one JSON-RPC
/// request line does once they are in.
///
/// Admission is the security boundary. A lane saves into an Apple app's own store, so only the
/// node server the app itself spawned for that surface may borrow it: the host passes the
/// handshake's `for=` and the surface the connecting process was spawned for, and `admit` refuses
/// unless they are the same surface and that surface has a lane.
///
/// `handle` is called off the main actor, from the socket's own thread, once per line. It never
/// puts a params value (a title, an id) into an error message: messages name the method and the
/// param, so a reply logged or shown is safe to read.
nonisolated enum StoreLane {
  /// The surfaces with a lane.
  static let surfaces: Set<String> = ["voice-memos"]

  /// The message every write gets while the surface's writes are off.
  static let voiceMemosWritesOff = "writes are off for Voice Memos in Cupertino"

  /// Nil to admit `borrowerId`'s server, else why not, without the `err ` prefix.
  static func admit(borrowerId: String, peerSurface: String?) -> String? {
    guard surfaces.contains(borrowerId) else { return "'\(borrowerId)' has no store lane" }
    guard peerSurface == borrowerId else { return "this connection is not a \(borrowerId) server" }
    return nil
  }

  /// One JSON-RPC 2.0 reply line for one request line, with no trailing newline.
  ///
  /// `allowWrites` is read per request by the caller, so switching writes off takes effect on
  /// the next line; `status` still answers while they are off.
  static func handle(
    _ line: String, borrower: String, allowWrites: Bool, voiceMemos: VoiceMemosWriter = .live
  ) -> String {
    var id: Any = NSNull()
    do {
      guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) else {
        throw Refusal(code: Code.parseError, error: .invalid("the line is not JSON"))
      }
      guard let request = object as? [String: Any] else {
        throw Refusal(
          code: Code.invalidRequest, error: .invalid("the line is not a request object"))
      }
      // Read first, so the other refusals below can echo it.
      if let raw = request["id"] {
        guard isValidId(raw) else {
          throw Refusal(
            code: Code.invalidRequest, error: .invalid("the id is not a string, a number or null"))
        }
        id = raw
      }
      guard request["jsonrpc"] as? String == "2.0" else {
        throw Refusal(code: Code.invalidRequest, error: .invalid("the request is not JSON-RPC 2.0"))
      }
      guard let method = request["method"] as? String else {
        throw Refusal(code: Code.invalidRequest, error: .invalid("the request has no method"))
      }
      let result = try dispatch(
        method, request["params"], borrower: borrower, allowWrites: allowWrites,
        voiceMemos: voiceMemos)
      return encode(["jsonrpc": "2.0", "id": id, "result": result])
    } catch let refusal as Refusal {
      return failure(id: id, code: refusal.code, refusal.error)
    } catch let error as StoreLaneError {
      return failure(id: id, code: Code.lane, error)
    } catch {
      return failure(id: id, code: Code.lane, .failed(error.localizedDescription))
    }
  }

  // MARK: - Dispatch

  /// JSON-RPC's codes, and the lane's own for a call it refused.
  private enum Code {
    static let parseError = -32700
    static let invalidRequest = -32600
    static let methodNotFound = -32601
    static let lane = -32000
  }

  /// A refusal with a code other than the lane's own.
  private struct Refusal: Error {
    let code: Int
    let error: StoreLaneError
  }

  /// Each surface's method prefix. A method outside the borrower's prefix is unknown to it.
  private static let namespaces: [String: String] = ["voice-memos": "voiceMemos."]

  private static let voiceMemosVerbs: Set<String> = [
    "rename", "setFavorite", "move", "delete", "restore", "status",
  ]

  private static func dispatch(
    _ method: String, _ params: Any?, borrower: String, allowWrites: Bool,
    voiceMemos: VoiceMemosWriter
  ) throws -> [String: Any] {
    guard let prefix = namespaces[borrower], method.hasPrefix(prefix),
      case let verb = String(method.dropFirst(prefix.count)), voiceMemosVerbs.contains(verb)
    else {
      throw Refusal(
        code: Code.methodNotFound, error: .invalid("\(borrower) has no method \(method)"))
    }
    // Before the params are read: a malformed write is still a write.
    guard verb == "status" || allowWrites else {
      throw StoreLaneError.writesOff(voiceMemosWritesOff)
    }
    let params = try Params(method: method, params)
    switch verb {
    case "rename":
      return json(try voiceMemos.rename(id: params.string("id"), title: params.string("title")))
    case "setFavorite":
      return json(
        try voiceMemos.setFavorite(id: params.string("id"), favorite: params.bool("favorite")))
    case "move":
      return json(
        try voiceMemos.move(id: params.string("id"), folderId: params.stringOrNull("folderId")))
    case "delete":
      return json(try voiceMemos.delete(id: params.string("id")))
    case "restore":
      return json(try voiceMemos.restore(id: params.string("id")))
    default:
      return json(voiceMemos.status())
    }
  }

  /// A request's params, read by name. The errors name the method and the param, never a value.
  private struct Params {
    let method: String
    let values: [String: Any]

    /// Absent is no params; anything but an object is refused.
    init(method: String, _ raw: Any?) throws {
      self.method = method
      if let raw {
        guard let values = raw as? [String: Any] else {
          throw StoreLaneError.invalid("\(method)'s params are not an object")
        }
        self.values = values
      } else {
        values = [:]
      }
    }

    func string(_ name: String) throws -> String {
      guard let value = values[name] as? String else {
        throw StoreLaneError.invalid("\(method) needs \(name), a string")
      }
      return value
    }

    /// A JSON `true` or `false` only: `JSONSerialization` hands `1` back as an `NSNumber` that
    /// would also cast to `Bool`.
    func bool(_ name: String) throws -> Bool {
      guard let value = values[name] as? NSNumber, isBoolean(value) else {
        throw StoreLaneError.invalid("\(method) needs \(name), true or false")
      }
      return value.boolValue
    }

    /// The key must be there: null is an explicit "none", and a missing key is refused.
    func stringOrNull(_ name: String) throws -> String? {
      switch values[name] {
      case is NSNull: return nil
      case let value as String: return value
      default: throw StoreLaneError.invalid("\(method) needs \(name), a string or null")
      }
    }
  }

  // MARK: - Replies

  private static func json(_ result: VoiceMemosWriter.Result) -> [String: Any] {
    [
      "id": result.id, "changed": result.changed, "modelVersion": orNull(result.modelVersion),
      "syncMeasured": result.syncMeasured,
    ]
  }

  private static func json(_ status: CoreDataStore.Status) -> [String: Any] {
    [
      "compatible": status.compatible, "modelVersion": orNull(status.modelVersion),
      "syncMeasured": status.syncMeasured, "refusal": orNull(status.refusal),
    ]
  }

  private static func orNull(_ value: String?) -> Any {
    value.map { $0 as Any } ?? NSNull()
  }

  private static func failure(id: Any, code: Int, _ error: StoreLaneError) -> String {
    encode([
      "jsonrpc": "2.0", "id": id,
      "error": ["code": code, "message": error.message, "data": ["reason": error.reason]],
    ])
  }

  /// One line: `JSONSerialization` escapes every line break inside a string and adds none after.
  private static func encode(_ reply: [String: Any]) -> String {
    // `data(withJSONObject:)` raises rather than throws on an object it cannot encode.
    guard JSONSerialization.isValidJSONObject(reply),
      let data = try? JSONSerialization.data(
        withJSONObject: reply, options: [.sortedKeys, .withoutEscapingSlashes])
    else {
      return
        #"{"error":{"code":-32000,"data":{"reason":"failed"},"message":"the reply did not encode"},"id":null,"jsonrpc":"2.0"}"#
    }
    return String(decoding: data, as: UTF8.self)
  }

  /// A JSON-RPC id: a string, a number or null. Not a boolean, an object or an array.
  private static func isValidId(_ value: Any) -> Bool {
    switch value {
    case is NSNull, is String: true
    case let number as NSNumber: !isBoolean(number)
    default: false
    }
  }

  private static func isBoolean(_ number: NSNumber) -> Bool {
    CFGetTypeID(number) == CFBooleanGetTypeID()
  }
}
