import Foundation

/// The request line and headers of one HTTP request, before its body is read.
///
/// Header names are lowercased at construction, so a lookup by any spelling of
/// a name finds it: HTTP header names are case-insensitive, and a client that
/// sends `HOST` must be judged the same as one that sends `host`.
nonisolated struct HTTPHead: Equatable {
  let method: String
  /// The request target. `HTTPHeadParser` drops the query string, as the
  /// kit's parser does; the gate drops one again if it is handed one.
  let path: String
  /// Keyed by lowercased name.
  let headers: [String: String]

  /// Two spellings of one name (`Host` and `host`) are joined with `,`, as
  /// the parser joins a field sent twice, so neither copy is picked over the
  /// other. Joined in sorted order of the spelling, so the result does not
  /// depend on a dictionary's order.
  init(method: String, path: String, headers: [String: String]) {
    self.method = method
    self.path = path
    var lowered: [String: String] = [:]
    for name in headers.keys.sorted() {
      guard let value = headers[name] else { continue }
      let key = name.lowercased()
      lowered[key] = lowered[key].map { "\($0),\(value)" } ?? value
    }
    self.headers = lowered
  }

  /// The value of a header, by any spelling of its name.
  func header(_ name: String) -> String? { headers[name.lowercased()] }
}

/// What the gate decided about one request.
nonisolated enum GateVerdict: Equatable {
  /// Serve it: `surface` is a `Surface.id`, `client` what the token names.
  case admit(surface: String, client: String)
  /// Answer `status` and close. `reason` is for the log: it names the check
  /// that failed and never carries the token or the Authorization value.
  case refuse(status: Int, reason: String)
}

/// The check every request to `http://127.0.0.1:<port>/s/<surface>` passes
/// before its body is read.
///
/// The order is Bastion's: `Host`, then `Origin`, then the token, then the
/// path. `Host` comes first because it is what stops DNS rebinding: a page on
/// another name that resolves to 127.0.0.1 sends its own name here, and must be
/// refused before anything else about the request is looked at. A browser
/// sends `Origin` on every cross-origin request and no MCP client sends one at
/// all, so any `Origin` is refused, even our own. The token is checked before
/// the path so that an unauthenticated caller cannot learn which surfaces
/// exist from the difference between 401 and 404.
nonisolated struct HTTPGate {
  let port: Int
  /// The client id a bearer token belongs to, or nil for a token nobody holds.
  let verify: @Sendable (String) -> String?

  func check(_ head: HTTPHead) -> GateVerdict {
    guard let host = head.header("host"), host.lowercased() == "127.0.0.1:\(port)" else {
      return .refuse(status: 400, reason: "Host is not 127.0.0.1:\(port)")
    }
    if head.header("origin") != nil {
      return .refuse(status: 403, reason: "Origin present; no browser may call")
    }
    guard let token = Self.bearer(head.header("authorization")) else {
      return .refuse(status: 401, reason: "token missing or not a Bearer credential")
    }
    guard let client = verify(token) else {
      return .refuse(status: 401, reason: "token not recognised")
    }
    guard let surface = Self.surface(in: head.path) else {
      return .refuse(status: 404, reason: "path is not /s/<surface>")
    }
    guard Surface.named(surface) != nil else {
      return .refuse(status: 404, reason: "path names no surface")
    }
    return .admit(surface: surface, client: client)
  }

  /// The token from `Bearer <token>`: the scheme in any case, then exactly one
  /// space, then a non-empty token.
  static func bearer(_ authorization: String?) -> String? {
    guard let authorization else { return nil }
    let scheme = "bearer "
    guard authorization.count > scheme.count,
      authorization.prefix(scheme.count).lowercased() == scheme
    else { return nil }
    let token = String(authorization.dropFirst(scheme.count))
    guard !token.isEmpty, !token.hasPrefix(" ") else { return nil }
    return token
  }

  /// The `<surface>` of exactly `/s/<surface>`, query string ignored. A
  /// trailing slash, an empty name or a further segment gives nil.
  static func surface(in target: String) -> String? {
    let path = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0]
    let prefix = "/s/"
    guard path.hasPrefix(prefix) else { return nil }
    let name = path.dropFirst(prefix.count)
    guard !name.isEmpty, !name.contains("/") else { return nil }
    return String(name)
  }
}

/// The HTTP status that carries the `-32601` answer to a `server/discover`
/// POSTed without a session id, the signal the 2026-07-28 spec gives a client
/// to fall back to `initialize` and the 2025 handshake.
///
/// 404 is a placeholder, after Bastion's `Dialect`, which answers
/// method-not-found on the modern transport as a 404. Nobody has yet watched a
/// client fall back over HTTP, and clients choose between retrying and falling
/// back from the status and the code; the client measurement (plan step 1)
/// replaces this value with the status that makes each one fall back.
nonisolated enum DiscoverRefusal {
  static let status = 404
}
