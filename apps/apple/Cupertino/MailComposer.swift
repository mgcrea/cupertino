import AppKit
import ApplicationServices
import Foundation

/// A Mail compose window, as far as listing and editing need to know it.
///
/// The seam the checks fake: everything above it (handles, the listing's shape)
/// is plain Swift and can be asserted without Mail running.
protocol ComposerWindow: AnyObject {
  var subject: String { get }
  /// Display names, never addresses: Mail's recipient tokens carry only the name.
  var recipientNames: [String] { get }
  /// The body's top-level blocks, in order, quote included.
  func blocks() throws -> [ComposerBlock]
  /// False once the window has been sent or closed.
  var isAlive: Bool { get }
  /// Whether `other` is this same window. Identity for a fake; `CFEqual` on the
  /// `AXUIElement` for the live type, since AX hands back a new wrapper on every read.
  func isSame(as other: ComposerWindow) -> Bool
}

extension ComposerWindow {
  func isSame(as other: ComposerWindow) -> Bool { self === other }
}

struct ComposerBlock {
  let text: String
  /// `AXBlockQuoteLevel`; nil when Mail would not say.
  let quoteLevel: Int?
  /// Names of images and attachments inside the block.
  let fileNames: [String]
}

/// Handles for compose windows, and the listing the Mail server reads.
///
/// ## Why handles live here and not in the driver's `HandleStore`
///
/// Two composers can carry the same subject, so neither the title nor the
/// subject names one. A handle is minted per window the first time it is seen
/// and kept for as long as the process lives; `mc-<n>` numbers are never reused,
/// so a handle held across a send can only go stale, never point at another draft.
nonisolated enum MailComposer {

  /// `@unchecked Sendable` for the reason `AccessibilityDriver.HandleStore` is:
  /// the lock is the invariant.
  private final class Registry: @unchecked Sendable {
    private var entries: [(number: Int, window: ComposerWindow)] = []
    private var next = 0
    private let lock = NSLock()

    func register(_ windows: [ComposerWindow]) -> [String] {
      lock.lock()
      defer { lock.unlock() }
      // Dead windows are dropped so a long session does not hold every composer
      // it ever saw. Their numbers are not recycled: `next` only goes up.
      entries.removeAll { !$0.window.isAlive }
      return windows.map { window in
        if let known = entries.first(where: { $0.window.isSame(as: window) }) {
          return "mc-\(known.number)"
        }
        next += 1
        entries.append((next, window))
        return "mc-\(next)"
      }
    }

    func resolve(_ handle: String) -> ComposerWindow? {
      lock.lock()
      defer { lock.unlock() }
      guard handle.hasPrefix("mc-"), let number = Int(handle.dropFirst(3)),
        let entry = entries.first(where: { $0.number == number }), entry.window.isAlive
      else { return nil }
      return entry.window
    }
  }

  private static let registry = Registry()

  static func register(_ windows: [ComposerWindow]) -> [String] {
    registry.register(windows)
  }

  static func resolve(_ handle: String) -> ComposerWindow? {
    registry.resolve(handle)
  }

  /// One entry per window: its handle, subject, recipients and own text.
  ///
  /// `quoted` is a Bool when every block's level was readable, and NSNull when
  /// one was not, in which case own text stops before that block: a body that
  /// cannot be split is not offered as if it had been.
  static func listing(_ windows: [ComposerWindow]) -> [[String: Any]] {
    let handles = register(windows)
    return zip(windows, handles).map { window, handle in
      var own: [String] = []
      var files: [String] = []
      var quoted: Any = NSNull()
      if let blocks = try? window.blocks() {
        var boundary = false
        var unreadable = false
        for block in blocks {
          guard let level = block.quoteLevel else {
            unreadable = true
            break
          }
          if level > 0 {
            boundary = true
            break
          }
          own.append(block.text)
          files += block.fileNames
        }
        if !unreadable { quoted = boundary }
      }
      return [
        "composer": handle,
        "subject": window.subject,
        "recipients": window.recipientNames,
        "text": own.joined(separator: "\n"),
        "quoted": quoted,
        "files": files,
      ]
    }
  }
}

/// A compose window read through Accessibility.
///
/// Recognised by its subject FIELD (`Mail.subjectField`, three levels down), not
/// its title: a viewer showing a message with the same subject has the same
/// title and no field.
final class AXComposerWindow: ComposerWindow, @unchecked Sendable {
  static let bundleId = "com.apple.mail"
  private static let tokenChar: Character = "\u{FFFC}"
  /// Roles whose name marks a file in the body, as `FILE_ROLES` in ax.ts.
  private static let fileRoles: Set<String> = ["AXImage", "AXButton"]

  let window: AXUIElement
  private let subjectField: AXUIElement

  private init(window: AXUIElement, subjectField: AXUIElement) {
    self.window = window
    self.subjectField = subjectField
  }

  /// Every compose window Mail has open now. Reads only.
  static func all() -> [AXComposerWindow] {
    guard
      let mail = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
    else { return [] }
    let app = AXUIElementCreateApplication(mail.processIdentifier)
    let windows = (attr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    return windows.compactMap { window in
      field(in: window, "Mail.subjectField").map {
        AXComposerWindow(window: window, subjectField: $0)
      }
    }
  }

  var subject: String { Self.attr(subjectField, kAXValueAttribute as String) as? String ?? "" }

  var isAlive: Bool {
    var out: CFTypeRef?
    return AXUIElementCopyAttributeValue(window, kAXRoleAttribute as CFString, &out) == .success
  }

  func isSame(as other: ComposerWindow) -> Bool {
    guard let other = other as? AXComposerWindow else { return false }
    return CFEqual(window, other.window)
  }

  var recipientNames: [String] {
    ["Mail.toField", "Mail.ccField"].flatMap { id -> [String] in
      guard let field = Self.field(in: window, id) else { return [] }
      let value = Self.attr(field, kAXValueAttribute as String) as? String ?? ""
      var names: [String] = []
      if value.contains(Self.tokenChar) {
        for token in Self.descendants(of: field, depth: 2)
        where Self.attr(token, kAXSubroleAttribute as String) as? String == "AXTextAttachment" {
          if let name = (Self.attr(token, kAXValueAttribute as String) as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty
          {
            names.append(name)
          }
        }
      }
      // Whatever is still being typed sits between the tokens in the value.
      let typed =
        value.split(separator: Self.tokenChar, omittingEmptySubsequences: false)
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
      return names + typed
    }
  }

  struct NoBody: Error {}

  func blocks() throws -> [ComposerBlock] {
    guard let web = Self.find(window, depth: 10, where: { Self.role($0) == "AXWebArea" })
    else { throw NoBody() }
    return Self.children(web).map { block in
      ComposerBlock(
        text: Self.text(of: block),
        quoteLevel: (Self.attr(block, "AXBlockQuoteLevel") as? NSNumber)?.intValue,
        fileNames: Self.files(in: block))
    }
  }

  // MARK: AX reads

  private static func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var out: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &out) == .success ? out : nil
  }

  private static func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
  }

  private static func role(_ el: AXUIElement) -> String? {
    attr(el, kAXRoleAttribute as String) as? String
  }

  private static func find(_ el: AXUIElement, depth: Int, where test: (AXUIElement) -> Bool)
    -> AXUIElement?
  {
    if test(el) { return el }
    guard depth > 0 else { return nil }
    for child in children(el) {
      if let hit = find(child, depth: depth - 1, where: test) { return hit }
    }
    return nil
  }

  private static func field(in window: AXUIElement, _ id: String) -> AXUIElement? {
    find(window, depth: 3) { attr($0, kAXIdentifierAttribute as String) as? String == id }
  }

  private static func descendants(of el: AXUIElement, depth: Int) -> [AXUIElement] {
    guard depth > 0 else { return [] }
    return children(el).flatMap { [$0] + descendants(of: $0, depth: depth - 1) }
  }

  /// A block's own value plus its descendants', joined with nothing: inline runs
  /// share a line, as `ax.ts` reads them.
  private static func text(of el: AXUIElement, depth: Int = 8) -> String {
    var parts: [String] = []
    if let value = attr(el, kAXValueAttribute as String) as? String { parts.append(value) }
    if depth > 0 { for child in children(el) { parts.append(text(of: child, depth: depth - 1)) } }
    return parts.joined()
  }

  private static func files(in el: AXUIElement, depth: Int = 8) -> [String] {
    var names: [String] = []
    if let role = role(el), fileRoles.contains(role) {
      let name =
        (attr(el, kAXTitleAttribute as String) as? String).flatMap { $0.isEmpty ? nil : $0 }
        ?? (attr(el, kAXDescriptionAttribute as String) as? String)
      if let name, !name.isEmpty { names.append(name) }
    }
    if depth > 0 { for child in children(el) { names += files(in: child, depth: depth - 1) } }
    return names
  }
}
