import Foundation
import FoundationModels

/// The bridge between one MCP tool and the on-device model.
///
/// The only file in the app that imports `FoundationModels`, and deliberately
/// the smallest one. It makes no decisions: which tools are offered, in what
/// order, and whether a schema can be expressed at all are settled in
/// `ChatTools.swift`, which imports `Foundation` and is therefore testable by
/// `make chat-check` on a machine with no Apple Intelligence — which is every
/// machine CI runs on.
///
/// What is left here is a mechanical map from `ChatSchemaNode` to
/// `DynamicGenerationSchema`, and a `Tool` conformance that forwards a call to
/// a live MCP connection. If either grows a rule, the rule is in the wrong
/// file.
enum ChatModelTool {

  /// A model-facing tool backed by one MCP tool on one live connection.
  nonisolated struct MCPBridgeTool: FoundationModels.Tool {
    typealias Arguments = GeneratedContent
    typealias Output = String

    let name: String
    let description: String
    let parameters: GenerationSchema
    let perform: @Sendable (String) -> String

    func call(arguments: GeneratedContent) async throws -> String {
      let json = arguments.jsonString
      // `MCPChatClient.call` blocks, and this is on the cooperative pool — or
      // worse. The target builds with SWIFT_APPROACHABLE_CONCURRENCY, which
      // turns on NonisolatedNonsendingByDefault: a `nonisolated async` function
      // inherits its caller's isolation, and the caller here is a Task started
      // from the main actor. So without this hop the call really can run ON the
      // main actor — and for the four in-process surfaces, whose servers reach
      // the main actor through `InProcessRPC.blocking`, that is not a slow
      // frame but a hard deadlock with nothing in the log.
      //
      // The same bargain `ServerHost` makes for every connection it serves.
      return await withCheckedContinuation { continuation in
        onDedicatedThread("cupertino.chat.tool") {
          continuation.resume(returning: perform(json))
        }
      }
    }
  }

  /// Build the model-facing tool for one MCP tool, or throw saying why not.
  ///
  /// The throw comes from `ChatSchema.parse`, whose sentence is written to be
  /// shown: the pane lists what it could not offer, with the reason, rather
  /// than quietly serving a shorter list than the server has.
  static func bridge(
    _ tool: ChatTool, perform: @escaping @Sendable (String) -> String
  ) throws -> MCPBridgeTool {
    let name = ChatSchema.sanitised(tool.name)
    let root = try ChatSchema.parse(tool)
    return MCPBridgeTool(
      name: name,
      description: ChatBudget.summary(of: tool),
      parameters: try GenerationSchema(
        root: dynamic(root, name: name), dependencies: []),
      perform: perform)
  }

  /// `ChatSchemaNode` → `DynamicGenerationSchema`, one case at a time.
  ///
  /// Names are generated on the way down because a generation schema needs one
  /// per node and JSON Schema has none to give. They only have to be unique
  /// within a tool, which the path prefix guarantees.
  private static func dynamic(
    _ node: ChatSchemaNode, name: String, description: String? = nil
  ) -> DynamicGenerationSchema {
    switch node {
    case .string: DynamicGenerationSchema(type: String.self)
    case .integer: DynamicGenerationSchema(type: Int.self)
    case .number: DynamicGenerationSchema(type: Double.self)
    case .boolean: DynamicGenerationSchema(type: Bool.self)
    case .enumeration(let choices):
      DynamicGenerationSchema(name: name, description: description, anyOf: choices)
    case .array(let items, let min, let max):
      DynamicGenerationSchema(
        arrayOf: dynamic(items, name: "\(name)_item"),
        minimumElements: min, maximumElements: max)
    case .object(let properties):
      DynamicGenerationSchema(
        name: name, description: description,
        properties: properties.map {
          DynamicGenerationSchema.Property(
            name: $0.name, description: $0.description,
            schema: dynamic($0.node, name: "\(name)_\($0.name)"),
            isOptional: $0.isOptional)
        })
    }
  }
}
