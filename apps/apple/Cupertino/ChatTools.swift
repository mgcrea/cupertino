import Foundation

/// The tool budget and the JSON Schema subset, as values — with no model, no
/// server and no window attached.
///
/// ## Why this is its own file
///
/// Everything here is a decision the Chat pane makes before it can talk to
/// anything: which tools fit in the context window, in what order, and which
/// ones can be expressed to the model at all. Every one of those is silent when
/// it is wrong. A budget that is off by two tokens does not crash, it quietly
/// drops the tool a person was about to look for; an ordering that sorts by
/// cost alone loads a dozen `get_*` tools and none of the tools that list
/// things, and the model then answers as though the surface were empty.
///
/// So this imports `Foundation` and nothing else — no `FoundationModels`, no
/// SwiftUI, no `ServerHost` — for exactly the reason `CallCapture` and
/// `ClientWiringMerge` are written that way: `make chat-check` compiles this
/// one file against `scripts/chat-check.swift` with `swiftc` and asserts the
/// arithmetic, on a machine that may have no Apple Intelligence at all.
///
/// The sibling app this is ported from fuses the two halves: Bastion's
/// `ToolProbe.node` validates a schema and builds a `DynamicGenerationSchema`
/// in one pass, so its accept/reject rule cannot be compiled without the
/// framework and has never been tested. Splitting the decision out from the
/// construction is the whole point. `ChatModelTool` holds the other half and
/// makes no decisions.

// MARK: - One tool, as listed

/// One entry from a live `tools/list`.
///
/// The schema is kept as `Data` rather than a dictionary because it crosses a
/// thread boundary — the listing is read on a dedicated thread and handed to
/// the main actor — and `[String: Any]` cannot make that trip.
///
/// `SurfaceCatalog.Item` deliberately does NOT hold this. That type feeds the
/// capabilities card, which renders a name and one sentence; fattening its
/// permanently-cached list with ~1.8 KB of schema per tool to serve a different
/// feature would make one list answer to two masters.
struct ChatTool: Identifiable, Sendable, Hashable {
  let name: String
  let summary: String
  /// The server's own JSON Schema for this tool's arguments, as it arrived.
  let schema: Data
  /// `annotations.readOnlyHint`, and `nil` when the server did not say.
  ///
  /// The absence is meaningful and is never read as "no". Measured on this
  /// repo's own servers: thirteen mutating tools ship with no hint at all,
  /// which is why `packages/core/src/facade.ts` classifies writes by running
  /// the registrar twice rather than by believing this field.
  let readOnlyHint: Bool?
  /// How many arguments the tool insists on. Cached because `before` reads it
  /// on every comparison and it means parsing the schema.
  let requiredCount: Int

  var id: String { name }

  init?(json: [String: Any]) {
    guard let name = json["name"] as? String else { return nil }
    self.name = name
    let annotations = json["annotations"] as? [String: Any]
    summary =
      json["description"] as? String
      ?? annotations?["title"] as? String
      ?? json["title"] as? String
      ?? ""
    let raw = json["inputSchema"] as? [String: Any] ?? [:]
    schema = (try? JSONSerialization.data(withJSONObject: raw)) ?? Data("{}".utf8)
    readOnlyHint = annotations?["readOnlyHint"] as? Bool
    requiredCount = (raw["required"] as? [String])?.count ?? 0
  }

  /// The literal initialiser, for fixtures and for the harness.
  ///
  /// `DemoSeed` builds its tools through `init?(json:)` instead, so the
  /// screenshot's budget line is computed by `ChatBudget.cost` rather than
  /// typed into a plate. This exists for tests that want a cost without
  /// inventing a plausible schema to reach it.
  init(name: String, summary: String, schema: Data, readOnlyHint: Bool?, requiredCount: Int) {
    self.name = name
    self.summary = summary
    self.schema = schema
    self.readOnlyHint = readOnlyHint
    self.requiredCount = requiredCount
  }
}

// MARK: - The budget

/// What fits in the context window, and in what order.
///
/// ## The context window is the design
///
/// The on-device model reports a 4096-token window. Mail with writes on lists
/// twenty-one tools whose schemas come to 4854 tokens — the tool list alone is
/// more than the whole window, before a single word of conversation. So "load
/// the server's tools" is not a thing that can be done, and the interesting
/// question is which ones.
enum ChatBudget {
  /// The share of the window the tool list may take.
  ///
  /// Written as the ratio the pane shipped with rather than a percentage, so it
  /// is exactly 1800 at 4096 and scales from there — 3600 at 8192. 44% would
  /// give 1802 at the same window, which sounds identical and silently changes
  /// which tools fit.
  static func budget(contextSize: Int) -> Int { contextSize * 1800 / 4096 }

  /// The description as the model will receive it.
  ///
  /// Capped, and the cap is applied here rather than at the point of use so
  /// that `cost` and the built tool cannot disagree about what was sent.
  static func summary(of tool: ChatTool) -> String {
    let text = tool.summary.isEmpty ? tool.name : tool.summary
    return text.count > 300 ? String(text.prefix(300)) : text
  }

  /// Estimated, not measured.
  ///
  /// `LanguageModelSession.tokenCount(for:)` is exact but needs a session that
  /// already exists, and this has to be right as a checkbox is ticked — before
  /// there is a session at all. Bytes over four, which is close enough to pick
  /// between tools and is never presented as anything else.
  static func cost(of tool: ChatTool) -> Int {
    (tool.name.count + summary(of: tool).count + tool.schema.count) / 4
  }

  /// Callable-cold first, then cheapest.
  ///
  /// The first key matters more than the second. A tool with no required
  /// arguments can be called cold; one that wants an id cannot be called until
  /// something else has produced that id, so a set of only `get_*(id)` tools
  /// gives the model nothing to open with. Measured on Mail:
  /// `apple_mail_check_for_new_mail` costs 94 and needs nothing,
  /// `apple_mail_get_message` costs 172 and needs an id — cheapest-first alone
  /// inverts them and the conversation cannot start.
  static func before(_ a: ChatTool, _ b: ChatTool) -> Bool {
    let (ra, rb) = (a.requiredCount == 0, b.requiredCount == 0)
    if ra != rb { return ra }
    if cost(of: a) != cost(of: b) { return cost(of: a) < cost(of: b) }
    // A total order, so the same listing selects the same set twice running.
    return a.name < b.name
  }

  /// Greedy over `before`: fill up with tools the model can open with, then
  /// spend what is left on the cheapest of the rest.
  ///
  /// A tool too big to fit does not stop a later, cheaper one from fitting —
  /// this keeps going rather than breaking, which is what lets Mail load seven
  /// cold tools after skipping `apple_mail_query` by 108 tokens.
  ///
  /// The caller must have removed tools whose schemas will not convert BEFORE
  /// calling this. Bastion fills first and discovers the failures when it binds
  /// the session, which spends the budget on tools that are then dropped:
  /// measured on Contacts with writes on, 766 of 1313 tokens went to
  /// `create_contact` and `update_contact`, neither of which could be bound.
  static func fill(_ tools: [ChatTool], budget: Int) -> (selected: Set<String>, used: Int) {
    var selected: Set<String> = []
    var used = 0
    for tool in tools.sorted(by: before) where used + cost(of: tool) <= budget {
      selected.insert(tool.name)
      used += cost(of: tool)
    }
    return (selected, used)
  }

  /// What a selection costs, for the header's running total.
  static func used(_ tools: [ChatTool], selected: Set<String>) -> Int {
    tools.filter { selected.contains($0.name) }.reduce(0) { $0 + cost(of: $1) }
  }
}

// MARK: - The schema subset

/// The JSON Schema subset these servers actually emit, as a value.
///
/// Deliberately not a `DynamicGenerationSchema`: see the file header. The map
/// from this to that is mechanical and lives in `ChatModelTool`.
indirect enum ChatSchemaNode: Equatable {
  case string
  case integer
  case number
  case boolean
  case enumeration([String])
  case array(ChatSchemaNode, min: Int?, max: Int?)
  case object([Property])

  struct Property: Equatable {
    let name: String
    let description: String?
    let node: ChatSchemaNode
    let isOptional: Bool
  }

  /// Carried separately from the case so `object` and `enumeration` can both
  /// have one without every case paying for it.
  static func described(_ json: [String: Any]) -> String? { json["description"] as? String }
}

enum ChatSchema {
  enum Failure: LocalizedError, Equatable {
    case unsupported(path: String, why: String)

    var errorDescription: String? {
      switch self {
      case .unsupported(let path, let why):
        "its schema is not one the pane can express (\(path) \(why))"
      }
    }
  }

  /// Type names in a generation schema are identifiers, and MCP tool names are
  /// not required to be.
  static func sanitised(_ name: String) -> String {
    String(name.map { $0.isLetter || $0.isNumber || $0 == "_" ? $0 : "_" })
  }

  /// Parse a tool's `inputSchema`, or throw saying which part defeated it.
  ///
  /// Anything outside the subset throws rather than guesses. A tool called with
  /// arguments shaped by a guess is a worse outcome than a tool reported as
  /// unusable, because only one of those two is honest about what happened —
  /// and the pane lists what it could not offer, with the reason.
  static func parse(_ tool: ChatTool) throws -> ChatSchemaNode {
    let root = (try? JSONSerialization.jsonObject(with: tool.schema)) as? [String: Any] ?? [:]
    let name = sanitised(tool.name)
    return try parse(root, name: name, path: name, depth: 0)
  }

  static func parse(
    _ json: [String: Any], name: String, path: String, depth: Int
  ) throws -> ChatSchemaNode {
    guard depth <= 4 else {
      throw Failure.unsupported(path: path, why: "nests deeper than the pane follows")
    }

    // `.nullable()` in zod, and nothing more exotic.
    //
    // Every node server here is zod-generated, and `z.string().nullable()`
    // emits `anyOf: [{"type":"string"},{"type":"null"}]`. A generation schema
    // has no null type, and "optional string" is exactly what that construct
    // means — so it is collapsed rather than refused. Measured before this
    // rule existed: two of ninety-three write-enabled node tools were
    // unusable, both of them Contacts', both for this and nothing else.
    //
    // Two members, one of them null. Every other `anyOf` still throws below:
    // a genuine union is not a thing this can narrow honestly.
    if let union = json["anyOf"] as? [[String: Any]], union.count == 2,
      let nullIndex = union.firstIndex(where: { $0["type"] as? String == "null" })
    {
      var collapsed = union[1 - nullIndex]
      // The description sits on the wrapper, not on the branch.
      if collapsed["description"] == nil, let outer = json["description"] {
        collapsed["description"] = outer
      }
      return try parse(collapsed, name: name, path: path, depth: depth)
    }

    for construct in ["oneOf", "allOf", "anyOf", "not", "$ref"] where json[construct] != nil {
      throw Failure.unsupported(path: path, why: "uses \(construct)")
    }

    if let choices = json["enum"] as? [Any] {
      let strings = choices.compactMap { $0 as? String }
      guard !strings.isEmpty, strings.count == choices.count else {
        throw Failure.unsupported(path: path, why: "has an enum that is not all strings")
      }
      return .enumeration(strings)
    }

    // `as? String` and not `as? Any`, so `{"type": ["string", "null"]}` — the
    // other shape a nullable can take — falls through to "declares no type"
    // rather than being read as a type named something unprintable.
    let declared = json["type"] as? String ?? (json["properties"] != nil ? "object" : nil)
    switch declared {
    case "object":
      let properties = json["properties"] as? [String: Any] ?? [:]
      let required = Set(json["required"] as? [String] ?? [])
      // Sorted so the same tool produces the same schema twice running.
      let members = try properties.keys.sorted().map { key -> ChatSchemaNode.Property in
        guard let child = properties[key] as? [String: Any] else {
          throw Failure.unsupported(path: "\(path).\(key)", why: "is not a schema object")
        }
        return ChatSchemaNode.Property(
          name: key,
          description: child["description"] as? String,
          node: try parse(
            child, name: "\(name)_\(key)", path: "\(path).\(key)", depth: depth + 1),
          isOptional: !required.contains(key))
      }
      return .object(members)

    case "array":
      guard let items = json["items"] as? [String: Any] else {
        throw Failure.unsupported(path: path, why: "is an array with no declared item type")
      }
      return .array(
        try parse(items, name: "\(name)_item", path: "\(path)[]", depth: depth + 1),
        min: json["minItems"] as? Int, max: json["maxItems"] as? Int)

    case "string": return .string
    case "integer": return .integer
    case "number": return .number
    case "boolean": return .boolean
    case .some(let other):
      throw Failure.unsupported(path: path, why: "declares the type '\(other)'")
    case .none:
      throw Failure.unsupported(path: path, why: "declares no type")
    }
  }
}

// MARK: - What a call produced

/// One `tools/call` the model made, as the pane renders it.
///
/// The arguments are kept as the JSON the model actually invented, not as a
/// re-encoding of a parse of it: the whole value of showing them is that they
/// are what was sent.
struct ChatCall: Identifiable, Sendable {
  let id = UUID()
  let tool: String
  let arguments: String
  let output: String
  let failed: Bool
  let seconds: TimeInterval
}

/// An MCP result rendered as the text the model will read.
///
/// Capped at 1200 characters rather than the 2000 the sibling app uses, and the
/// difference is forced: with 1800 tokens spent on the tool list, roughly 2300
/// are left for the instructions, the transcript and every result in it. One
/// `list_messages` answer at 2000 characters is ~500 tokens, and two turns of
/// that overflows a 4096-token window — which is survivable, because the
/// transcript trim catches it, but a trim that fires every other turn means the
/// model has forgotten the question.
func renderMCPResult(_ result: [String: Any], limit: Int = 1200) -> String {
  var text = ""
  if let content = result["content"] as? [[String: Any]] {
    text = content.compactMap { $0["text"] as? String }.joined(separator: "\n")
  }
  if text.isEmpty, let data = try? JSONSerialization.data(withJSONObject: result) {
    text = String(decoding: data, as: UTF8.self)
  }
  guard text.count > limit else { return text }
  return String(text.prefix(limit)) + "\n… (truncated)"
}
