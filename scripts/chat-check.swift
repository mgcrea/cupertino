import Foundation

/// The Chat pane's arithmetic, with no model, no server and no window.
///
/// Everything asserted here is silent when it is wrong. A budget off by two
/// tokens drops one tool; an ordering that sorts by cost alone loads a dozen
/// `get_*` tools and none that list anything, and the model then answers as
/// though the surface were empty; a schema rule that rejects one construct too
/// many quietly shrinks what the pane can offer. None of it crashes, none of it
/// is visible in a screenshot, and all of it is arithmetic — which is why
/// `ChatTools.swift` imports `Foundation` and nothing else.
///
/// A standalone `swiftc` binary rather than an XCTest bundle, for the reason
/// `wiring-check.swift` gives: the Xcode project has no test target. It also
/// has to run on a machine with no Apple Intelligence, which is every CI
/// machine — so the half of the feature that needs `FoundationModels` lives in
/// `ChatModelTool.swift` and deliberately makes no decisions.
///
/// Run with `make chat-check`. With server paths as arguments it also runs
/// `make chat-check-real`, which puts every REAL tool schema through the same
/// rule — see `main`.

@main
struct ChatCheck {
  static var failures = 0
  static var checks = 0

  static func check(_ label: String, _ condition: @autoclosure () -> Bool) {
    checks += 1
    if condition() {
      print("  ok   \(label)")
    } else {
      print("  FAIL \(label)")
      failures += 1
    }
  }

  /// A tool whose schema is a real object schema, padded towards `bytes`.
  ///
  /// It has to be a schema the subset actually accepts, or these fixtures
  /// measure the cost of something the pane would refuse to offer — which is
  /// how the first draft of this file "proved" a greedy fill that was in fact
  /// selecting from an empty list. The padding goes in a property description,
  /// where real schema bulk lives.
  static func tool(
    _ name: String, summary: String = "", bytes: Int = 0, required: Int = 0,
    readOnly: Bool? = true
  ) -> ChatTool {
    let skeleton = #"{"type":"object","properties":{"a":{"type":"string","description":""}}}"#
    let padding = String(repeating: "a", count: max(0, bytes - skeleton.utf8.count))
    let json =
      #"{"type":"object","properties":{"a":{"type":"string","description":"\#(padding)"}}}"#
    return ChatTool(
      name: name, summary: summary, schema: Data(json.utf8), readOnlyHint: readOnly,
      requiredCount: required)
  }

  static func parses(_ json: [String: Any]) -> Bool {
    (try? ChatSchema.parse(json, name: "t", path: "t", depth: 0)) != nil
  }

  // MARK: - The real servers

  /// One server's `tools/list`, read the way `MCPChatClient` reads it.
  ///
  /// Writes ON, deliberately: that is the larger set, and the two tools that
  /// defeated the converter before the `anyOf` collapse landed were both
  /// write tools. Lazy tools OFF for the reason `SurfaceCatalog.probe` gives —
  /// a lazy server answers with a search tool and a dispatcher, so this would
  /// otherwise check four schemas per surface and call it a pass.
  static func listTools(_ script: String, envPrefix: String) throws -> [ChatTool] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", script]
    var environment = ProcessInfo.processInfo.environment
    environment["\(envPrefix)_ALLOW_WRITES"] = "1"
    environment["\(envPrefix)_LAZY_TOOLS"] = "0"
    process.environment = environment

    let toChild = Pipe()
    let fromChild = Pipe()
    let childErr = Pipe()
    process.standardInput = toChild
    process.standardOutput = fromChild
    process.standardError = childErr
    try process.run()

    // Killing the child is what unblocks a read that would otherwise wait
    // forever; the reader sees EOF rather than a timeout it has to model.
    let watchdog = DispatchWorkItem { if process.isRunning { process.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + 15, execute: watchdog)
    defer {
      watchdog.cancel()
      if process.isRunning { process.terminate() }
      try? childErr.fileHandleForReading.close()
    }

    func send(_ id: Int?, _ method: String, _ params: [String: Any] = [:]) throws {
      var message: [String: Any] = ["jsonrpc": "2.0", "method": method, "params": params]
      if let id { message["id"] = id }
      var line = try JSONSerialization.data(withJSONObject: message)
      line.append(0x0A)
      try toChild.fileHandleForWriting.write(contentsOf: line)
    }

    var buffer = Data()
    func awaitResult(_ id: Int) throws -> [String: Any] {
      while true {
        while let newline = buffer.firstIndex(of: 0x0A) {
          let line = buffer[buffer.startIndex..<newline]
          buffer = buffer[buffer.index(after: newline)...]
          if let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
            object["id"] as? Int == id
          {
            return object["result"] as? [String: Any] ?? [:]
          }
        }
        let chunk = fromChild.fileHandleForReading.availableData
        if chunk.isEmpty {
          throw ChatSchema.Failure.unsupported(path: script, why: "gave no answer")
        }
        buffer.append(chunk)
      }
    }

    try send(
      1, "initialize",
      [
        "protocolVersion": "2025-06-18", "capabilities": [:],
        "clientInfo": ["name": "chat-check", "version": "0"],
      ])
    _ = try awaitResult(1)
    try send(nil, "notifications/initialized")
    try send(2, "tools/list")
    let raw = try awaitResult(2)["tools"] as? [[String: Any]] ?? []
    return raw.compactMap(ChatTool.init(json:))
  }

  /// Prove every shipped tool schema converts, and print what the budget does
  /// with it.
  ///
  /// Fixtures rot. The rule above is asserted against schemas written by hand
  /// in this file; this is the half that notices when somebody adds a zod
  /// construct nobody here has seen. It is also the only place the fit table
  /// is visible — a new tool, or a longer description, silently pushes another
  /// tool out of the budget, and that should show up in CI rather than in the
  /// pane.
  static func real(_ scripts: [String]) throws {
    print("Real servers: every schema converts")
    let budget = ChatBudget.budget(contextSize: 4096)
    var rows: [String] = []

    for script in scripts {
      // packages/<surface>/dist/cli.js
      let surface = URL(fileURLWithPath: script).deletingLastPathComponent()
        .deletingLastPathComponent().lastPathComponent
      let prefix = "APPLE_\(surface.uppercased())"
      let tools: [ChatTool]
      do {
        tools = try listTools(script, envPrefix: prefix)
      } catch {
        check("\(surface): answers tools/list", false)
        continue
      }
      check("\(surface): lists tools at all", !tools.isEmpty)
      // Four tools means the facade answered. Passing that would be a green
      // check over an unmeasured surface.
      check("\(surface): is not answering through the lazy facade", tools.count > 5)

      var usable: [ChatTool] = []
      for tool in tools {
        do {
          _ = try ChatSchema.parse(tool)
          usable.append(tool)
        } catch {
          check("\(surface): \(tool.name) — \(error.localizedDescription)", false)
        }
      }
      let filled = ChatBudget.fill(usable, budget: budget)
      let total = tools.reduce(0) { $0 + ChatBudget.cost(of: $1) }
      rows.append(
        "  \(surface.padding(toLength: 12, withPad: " ", startingAt: 0))"
          + "\(usable.count)/\(tools.count) usable   "
          + "\(filled.selected.count) fit in \(filled.used)/\(budget)   "
          + "(\(total) tokens listed)")
    }

    print("\nReal servers: what fits, writes on")
    for row in rows { print(row) }
  }

  static func main() throws {
    let scripts = Array(CommandLine.arguments.dropFirst())

    print("Budget: the window share")

    // Exactly 1800 at 4096, and the reason it is written as a ratio rather than
    // a percentage: 44% gives 1802, which sounds identical and moves the line.
    check("1800 at a 4096-token window", ChatBudget.budget(contextSize: 4096) == 1800)
    check("3600 at 8192", ChatBudget.budget(contextSize: 8192) == 3600)
    check("0 at 0", ChatBudget.budget(contextSize: 0) == 0)
    check("not 1802 — the 44% spelling", ChatBudget.budget(contextSize: 4096) != 1802)

    print("\nBudget: what a tool costs")

    let priced = tool("ab", bytes: 400)
    check(
      "bytes over four",
      ChatBudget.cost(of: priced) == (2 + 2 + priced.schema.count) / 4)
    // The summary cap has to bind BEFORE the division, or a tool with a long
    // description is charged for text the model never receives.
    let verbose = tool("t", summary: String(repeating: "z", count: 900), bytes: 20)
    check(
      "a 900-character description is charged as 300",
      ChatBudget.cost(of: verbose) == (1 + 300 + verbose.schema.count) / 4)
    check("and is actually truncated", ChatBudget.summary(of: verbose).count == 300)
    check(
      "an empty description falls back to the name",
      ChatBudget.summary(of: tool("apple_mail_query")) == "apple_mail_query")

    print("\nBudget: the ordering")

    // The measured Mail regression, named because cheapest-first inverts it.
    let cold = tool("apple_mail_check_for_new_mail", bytes: 300, required: 0)
    let warm = tool("apple_mail_get_message", bytes: 100, required: 1)
    check("callable-cold sorts before cheaper-but-needs-an-id", ChatBudget.before(cold, warm))
    check("and not the other way", !ChatBudget.before(warm, cold))
    check(
      "within a group, cheapest first",
      ChatBudget.before(tool("a", bytes: 40), tool("b", bytes: 400)))
    check("irreflexive", !ChatBudget.before(cold, cold))
    // A total order, or the same listing selects a different set twice running.
    let twins = (tool("b", bytes: 40), tool("a", bytes: 40))
    check(
      "ties broken by name",
      ChatBudget.before(twins.1, twins.0) && !ChatBudget.before(twins.0, twins.1))

    print("\nBudget: the greedy fill")

    let cheap = tool("cheap", bytes: 40)  // cost 12
    let huge = tool("huge", bytes: 4000)  // cost 1001
    let mid = tool("mid", bytes: 400)  // cost 101
    let filled = ChatBudget.fill([huge, cheap, mid], budget: 200)
    check("takes what fits", filled.selected == ["cheap", "mid"])
    check(
      "and reports the exact total",
      filled.used == ChatBudget.cost(of: cheap) + ChatBudget.cost(of: mid))
    // The one that is easy to get wrong: a `break` here rather than a `continue`
    // would let one oversized tool hide every cheaper one behind it.
    let blocked = ChatBudget.fill(
      [tool("z_huge", bytes: 4000), tool("z_small", bytes: 40)], budget: 200)
    check("an oversized tool does not block a later cheaper one", blocked.selected == ["z_small"])
    check("a zero budget takes nothing", ChatBudget.fill([cheap], budget: 0).selected.isEmpty)
    check(
      "used() agrees with fill()",
      ChatBudget.used([huge, cheap, mid], selected: filled.selected) == filled.used)

    print("\nSchema: what the subset accepts")

    check("a flat object", parses(["type": "object", "properties": ["a": ["type": "string"]]]))
    check("no properties at all", parses(["type": "object"]))
    check(
      "the four primitives",
      parses(["type": "string"]) && parses(["type": "integer"])
        && parses(["type": "number"]) && parses(["type": "boolean"]))
    check("a string enum", parses(["type": "string", "enum": ["a", "b"]]))
    check(
      "an array of objects",
      parses([
        "type": "array", "items": ["type": "object", "properties": ["a": ["type": "string"]]],
      ]))
    check("properties implying object", parses(["properties": ["a": ["type": "string"]]]))
    check(
      "depth 4",
      parses([
        "type": "array",
        "items": [
          "type": "array",
          "items":
            ["type": "array", "items": ["type": "array", "items": ["type": "string"]]],
        ],
      ]))

    print("\nSchema: zod's .nullable()")

    // The Contacts case. Two of ninety-three write-enabled node tools were
    // unusable before this rule, both of them for this and nothing else.
    let nullable: [String: Any] = [
      "type": "object",
      "properties": ["firstName": ["anyOf": [["type": "string"], ["type": "null"]]]],
    ]
    check("anyOf [T, null] collapses to T", parses(nullable))
    check(
      "in either order",
      parses([
        "type": "object",
        "properties": ["x": ["anyOf": [["type": "null"], ["type": "integer"]]]],
      ]))
    // Narrowing in the right direction only. A genuine union is still refused.
    check(
      "a real union is still refused",
      !parses(["anyOf": [["type": "string"], ["type": "integer"]]]))
    check(
      "three members are still refused",
      !parses([
        "anyOf": [["type": "string"], ["type": "null"], ["type": "integer"]]
      ]))

    print("\nSchema: what it refuses")

    check("oneOf", !parses(["oneOf": [["type": "string"]]]))
    check("allOf", !parses(["allOf": [["type": "string"]]]))
    check("not", !parses(["not": ["type": "string"]]))
    check("$ref", !parses(["$ref": "#/definitions/x"]))
    check("a mixed enum", !parses(["enum": ["a", 1]]))
    check("an empty enum", !parses(["enum": [String]()]))
    // The other spelling of nullable, which must NOT be read as a type named
    // something unprintable.
    check(#"{"type": ["string","null"]}"#, !parses(["type": ["string", "null"]]))
    check("an unknown type", !parses(["type": "null"]))
    check("no type at all", !parses([:]))
    check("an array with no items", !parses(["type": "array"]))
    check(
      "a property that is not a schema object",
      !parses([
        "type": "object", "properties": ["a": "string"],
      ]))
    check(
      "depth 5",
      !parses([
        "type": "array",
        "items": [
          "type": "array",
          "items":
            [
              "type": "array",
              "items": [
                "type": "array",
                "items":
                  ["type": "array", "items": ["type": "string"]],
              ],
            ],
        ],
      ]))

    print("\nSchema: the failure says which part")

    do {
      _ = try ChatSchema.parse(
        ["type": "object", "properties": ["ids": ["oneOf": [["type": "string"]]]]],
        name: "t", path: "apple_mail_get_message", depth: 0)
      check("throws on oneOf", false)
    } catch let error as ChatSchema.Failure {
      check("names the path", "\(error)".contains("apple_mail_get_message.ids"))
      check("names the construct", "\(error)".contains("oneOf"))
    }

    check(
      "tool names are sanitised to identifiers",
      ChatSchema.sanitised("apple.mail/get-message") == "apple_mail_get_message")

    print("\nOrder of operations: parse before fill")

    // The bug this ports around. Bastion fills the budget from every listed
    // tool and only discovers at bind time which schemas will not convert, so
    // an unusable tool spends budget a usable one could have had. Measured on
    // Contacts with writes on: 766 of 1313 tokens went to two tools that could
    // not be bound. Here the cheapest tool in the list is the unusable one.
    let unusable = ChatTool(
      name: "create_contact", summary: "", schema: Data(#"{"anyOf":[{},{},{}]}"#.utf8),
      readOnlyHint: false, requiredCount: 0)
    let usable = tool("list_contacts", bytes: 400)
    let usableOnly = [unusable, usable].filter { (try? ChatSchema.parse($0)) != nil }
    check("the unusable tool is dropped first", usableOnly.map(\.name) == ["list_contacts"])
    let after = ChatBudget.fill(usableOnly, budget: 200)
    check("and its cost is not charged", after.used == ChatBudget.cost(of: usable))
    check("so the usable one still fits", after.selected == ["list_contacts"])

    print("\nRendering a result")

    check(
      "content text is joined",
      renderMCPResult(["content": [["text": "a"], ["text": "b"]]]) == "a\nb")
    check(
      "a result with no content falls back to its JSON",
      renderMCPResult(["isError": true]).contains("isError"))
    let long = renderMCPResult(["content": [["text": String(repeating: "x", count: 5000)]]])
    check("capped at 1200 characters", long.hasSuffix("… (truncated)") && long.count < 1300)

    if !scripts.isEmpty {
      print("")
      try real(scripts)
    }

    print("\n\(checks - failures)/\(checks) passed")
    if failures > 0 {
      print("\(failures) failed")
      exit(1)
    }
  }
}
