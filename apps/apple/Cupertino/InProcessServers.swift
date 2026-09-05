import Foundation

/// Which Swift type serves which surface, and what each one has to be told.
///
/// One fact in one place. Two callers need it — `ServerHost.serveInProcess`
/// answers a live MCP client, and `SurfaceCatalog.inProcess` asks the same
/// server what it registers so the Capabilities card can show it — and the
/// second copy is exactly what shipped broken: it handed EVERY `.swift` surface
/// to `ScreenServer`, so the Sound pane advertised `apple_screen_list_targets`
/// and `cupertino://screen/guide`. A card whose whole claim is "read from the
/// server, never written down here" was reading the wrong server.
///
/// Deliberately not folded into `InProcessRPC`. That file's contract is stated
/// in its own header — *nothing here knows about a surface* — and this file is
/// nothing but that knowledge. The wire is shared; the table of servers is not
/// the wire.
enum InProcessServers {

  /// What one request produced.
  ///
  /// Three cases rather than a `String?`, because the two nils a `String?`
  /// collapses are different facts. A notification draws no reply and the
  /// session carries on. A surface with no case below is a bug in this table,
  /// and the host has to log it and close rather than sit there — the
  /// distinction `ServerHost` made by hand and `SurfaceCatalog` could not make
  /// at all.
  ///
  /// `noReply` rather than `none`: a case called `none` shadows `Optional.none`
  /// the day anything wraps this in an optional, and the mistake compiles.
  enum Reply {
    /// A JSON-RPC message to write back.
    case message(String)
    /// A notification. Answering one is the protocol error, not the silence.
    case noReply
    /// No in-process server for this surface. Unreachable while `runtime` comes
    /// from the closed table in `surfaces.json`; kept because that table and
    /// the switch below are two places one fact lives, and a new `.swift`
    /// surface that forgets a case here must say so rather than hang.
    case noServer
  }

  /// Hand one request to this surface's server.
  ///
  /// Dispatched on `surface.id` rather than through a protocol, because the two
  /// servers deliberately do not share a signature: `screen` has one gate and
  /// no writes, `sound` has a write flag AND a gate that are independent. A
  /// common signature would have to pass both to both and pretend that is one
  /// idea. This adapts each, in the one place that knows the mapping.
  ///
  /// `gateOn` takes a gate ID and NEVER a position. `surface.gates.first` was
  /// correct while every surface had at most one gate and became silently wrong
  /// the moment two surfaces had different ones — read by position, switching
  /// Sound's `allowRecording` on registered Screen's `capture_surface`.
  ///
  /// Gates and writes arrive as values rather than being read from
  /// `UserDefaults` here, for the reason `scripts/sound-check.swift` gives: it
  /// is what lets a check pin every combination without touching a preference,
  /// and what lets the Capabilities card answer for the setting it was keyed on
  /// rather than for the setting at the instant of the render.
  static func handle(
    _ line: String, surface: Surface, allowWrites: Bool, gateOn: (String) -> Bool
  ) -> Reply {
    switch surface.id {
    case "screen":
      return reply(
        ScreenServer.handle(
          line, surface: surface,
          captureAllowed: gateOn("allowCapture")))
    case "sound":
      return reply(
        SoundServer.handle(
          line, surface: surface,
          writesAllowed: allowWrites,
          recordingAllowed: gateOn("allowRecording")))
    // `desktop` has a write flag and NO gate, which is a third shape again --
    // and the reason it needs none is that Accessibility does not scope. Screen
    // Recording gates `capture_surface` because capture is a tier past reading a
    // window list; here the grant that lets the surface READ a control is the
    // same grant that lets it PRESS one, so a second switch would suggest a
    // boundary the system does not have. `allowWrites` alone decides.
    case "desktop":
      return reply(DesktopServer.handle(line, surface: surface, writesAllowed: allowWrites))
    default:
      return .noServer
    }
  }

  private static func reply(_ line: String?) -> Reply {
    guard let line else { return .noReply }
    return .message(line)
  }
}
