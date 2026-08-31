import AppKit

/// The save panel behind every "Export…" in the app.
///
/// One function because there are two buttons — the Activity settings pane and
/// the log window — and the first attempt made the log window's button *open
/// the settings pane* rather than duplicate this, on the reasoning that two
/// places to start an export would be two places to keep the description of
/// what a file contains true.
///
/// That was the wrong fix for the right worry. A button labelled "Export…" that
/// produces a settings window is a button that lies, and the duplication it
/// avoided is avoided properly here instead: both callers get the same panel,
/// the same accessory checkbox and the same sentence, because there is only one
/// of each.
@MainActor
enum AuditExport {
  struct Outcome {
    let note: String
    let summary: AuditLog.Summary?
  }

  /// Nil when the user cancelled, which is not a result worth reporting.
  static func run() -> Outcome? {
    let panel = NSSavePanel()
    panel.title = "Export the audit log"
    panel.nameFieldStringValue = "cupertino-audit-\(stamp.string(from: Date()))"
    panel.canCreateDirectories = true
    // A folder, not a file: the export is the segments plus a manifest, and a
    // signature beside it rather than inside it — writing a signature into the
    // bytes it signs is what makes half the signed-JSON formats ambiguous.
    panel.prompt = "Export"

    let sign = NSButton(checkboxWithTitle: "Sign this export", target: nil, action: nil)
    sign.state = AuditSigning.hasKey ? .on : .off
    sign.toolTip =
      "Proves the export came from this Mac and was not altered afterwards. It does not prove "
      + "the log was not curated before it was signed."
    // An accessory view with no frame lays out at zero height and the checkbox
    // is simply not there — the panel opens looking as though the option does
    // not exist.
    sign.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
    let holder = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 34))
    holder.addSubview(sign)
    panel.accessoryView = holder

    guard panel.runModal() == .OK, let url = panel.url else { return nil }
    do {
      let written = try AuditLog.shared.export(to: url, sign: sign.state == .on)
      return Outcome(
        note: "Exported \(written.records) record\(written.records == 1 ? "" : "s") to "
          + "\(url.lastPathComponent)" + (sign.state == .on ? ", signed." : ", unsigned."),
        summary: written)
    } catch {
      return Outcome(note: "Could not export: \(error.localizedDescription)", summary: nil)
    }
  }

  /// Why the button is off, when it is.
  ///
  /// Said on the button rather than discovered by pressing it: there is nothing
  /// on disk to export until the log is switched on, and the place to do that
  /// is not this window.
  static let unavailable = "Turn on the audit log in Settings › Activity to export it."

  private static let stamp: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter
  }()
}
