import Foundation

/// The MCP server for the `sound` surface, served by the app itself.
///
/// The second in-process surface, and it is in-process for a different reason
/// from `screen`. There, ScreenCaptureKit was simply unreachable from node.
/// Here the free half *could* have been node — `osascript` answers the volume
/// and `/usr/sbin/system_profiler` lists devices by absolute path even under
/// `PATH=/usr/bin:/bin`. What forces Swift is the rest: **switching the default
/// output device has no CLI and no AppleScript equivalent anywhere**, and
/// AVFoundation and Speech are as unreachable as ScreenCaptureKit was. Splitting
/// the surface across two runtimes to save one process would have been worse
/// than either.
///
/// ## Two gates, deliberately independent
///
/// `allowWrites` covers volume, mute, the default device, speaking and playing.
/// `allowRecording` covers the microphone and nothing else. Neither implies the
/// other, following the `allowCodes` precedent in `docs/passwords.md`: a change
/// of tier gets "its own switch rather than `allowWrites`". Someone may want an
/// agent that can mute their Mac and never listen to it, or one that can take a
/// memo and never touch their volume.
///
/// Both are pure functions of static configuration. A tool behind a gate that
/// is off is **not registered** — invisible rather than refused, which is what
/// `docs/alternatives.md` claims as a differentiator.
enum SoundServer {

  /// Shared with every other in-process surface — see `InProcessRPC`.
  static let protocolVersion = InProcessRPC.protocolVersion

  static func nextLine(_ fd: Int32) -> String? { InProcessRPC.nextLine(fd) }

  // ─── dispatch ──────────────────────────────────────────────────────────────

  static func handle(
    _ line: String, surface: Surface, writesAllowed: Bool, recordingAllowed: Bool
  ) -> String? {
    guard let data = line.data(using: .utf8),
      let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let method = msg["method"] as? String
    else { return nil }

    let id = msg["id"]
    // No id means a notification. Answering one is a protocol error.
    let isNotification = id == nil

    switch method {
    case "initialize":
      return isNotification
        ? nil
        : InProcessRPC.result(id, [
          "protocolVersion": protocolVersion,
          "capabilities": ["tools": [String: Any](), "resources": [String: Any]()],
          "serverInfo": ["name": "cupertino-sound", "version": AppInfo.shortVersion],
        ])

    case "ping":
      return isNotification ? nil : InProcessRPC.result(id, [String: Any]())

    case "tools/list":
      return isNotification
        ? nil
        : InProcessRPC.result(
          id, ["tools": tools(writesAllowed: writesAllowed, recordingAllowed: recordingAllowed)])

    case "resources/list":
      return isNotification ? nil : InProcessRPC.result(id, ["resources": resources()])

    case "resources/read":
      guard !isNotification else { return nil }
      let uri = ((msg["params"] as? [String: Any])?["uri"] as? String) ?? ""
      return readResource(
        uri, id: id, writesAllowed: writesAllowed, recordingAllowed: recordingAllowed)

    case "prompts/list":
      return isNotification ? nil : InProcessRPC.result(id, ["prompts": [Any]()])

    case "tools/call":
      guard !isNotification else { return nil }
      let params = msg["params"] as? [String: Any] ?? [:]
      let name = params["name"] as? String ?? ""
      let args = params["arguments"] as? [String: Any] ?? [:]
      return call(
        name, args: args, id: id, writesAllowed: writesAllowed, recordingAllowed: recordingAllowed)

    default:
      guard !isNotification else { return nil }
      return InProcessRPC.error(id, code: -32601, message: "unknown method '\(method)'")
    }
  }

  // ─── tools ─────────────────────────────────────────────────────────────────

  private static let deviceArg: [String: Any] = [
    "type": "string",
    "description":
      "The device's uid from apple_sound_list_devices. Omitted means the current default. "
      + "Names are not accepted: they are not unique, and two identical pairs of AirPods "
      + "produce the same string.",
  ]

  static func tools(writesAllowed: Bool, recordingAllowed: Bool) -> [[String: Any]] {
    let empty: [String: Any] = [
      "type": "object", "properties": [String: Any](), "required": [Any](),
    ]

    // Ungated. None of these needs any permission at all — the first tools in
    // the project that work before a single grant.
    var list: [[String: Any]] = [
      [
        "name": "apple_sound_list_devices",
        "description":
          "List the Mac's audio devices: name, uid, transport, channel counts, volume and which "
          + "are the current default input and output. Many devices have no volume control at "
          + "all, which is reported as null rather than as zero.",
        "inputSchema": empty,
        "annotations": ["readOnlyHint": true, "idempotentHint": true],
      ],
      [
        "name": "apple_sound_get_volume",
        "description":
          "The output volume and mute state of one device, or of the current default output.",
        "inputSchema": [
          "type": "object", "properties": ["device": deviceArg], "required": [Any](),
        ],
        "annotations": ["readOnlyHint": true, "idempotentHint": true],
      ],
      [
        "name": "apple_sound_diagnostics",
        "description":
          "Whether this surface can see the audio graph, what the microphone permission is, "
          + "and which gates are on. Answers even when everything is denied.",
        "inputSchema": empty,
        "annotations": ["readOnlyHint": true],
      ],
    ]

    if writesAllowed {
      list += [
        [
          "name": "apple_sound_set_volume",
          "description":
            "Set the output volume of one device, or of the current default output. "
            + "Refuses on a device with no volume control rather than pretending to succeed.",
          "inputSchema": [
            "type": "object",
            "properties": [
              "level": [
                "type": "number", "minimum": 0, "maximum": 1,
                "description": "0 to 1, where 1 is full volume.",
              ],
              "device": deviceArg,
            ],
            "required": ["level"],
          ],
          "annotations": ["readOnlyHint": false, "idempotentHint": true],
        ],
        [
          "name": "apple_sound_set_muted",
          "description": "Mute or unmute one device, or the current default output.",
          "inputSchema": [
            "type": "object",
            "properties": [
              "muted": ["type": "boolean", "description": "true to mute."],
              "device": deviceArg,
            ],
            "required": ["muted"],
          ],
          "annotations": ["readOnlyHint": false, "idempotentHint": true],
        ],
        [
          "name": "apple_sound_set_default_device",
          "description":
            "Make a device the default output or input — 'switch to my headphones'. This is the "
            + "one capability with no command-line or AppleScript equivalent on macOS.",
          "inputSchema": [
            "type": "object",
            "properties": [
              "device": deviceArg,
              "input": [
                "type": "boolean",
                "description": "true to set the default INPUT. Omitted means the output.",
              ],
            ],
            "required": ["device"],
          ],
          "annotations": ["readOnlyHint": false, "idempotentHint": true],
        ],
        [
          "name": "apple_sound_speak",
          "description":
            "Speak text aloud through the current output device, using the system voice. "
            + "Returns once speaking has finished.",
          "inputSchema": [
            "type": "object",
            "properties": [
              "text": [
                "type": "string", "maxLength": 2000,
                "description": "What to say. Bounded, because this call waits for it to finish.",
              ],
              "voice": [
                "type": "string",
                "description": "An installed voice name. Omitted means the system default.",
              ],
            ],
            "required": ["text"],
          ],
          "annotations": ["readOnlyHint": false, "idempotentHint": false],
        ],
      ]
    }

    if recordingAllowed {
      list += [
        [
          "name": "apple_sound_start_recording",
          "description":
            "Start recording from the microphone to a file and return its path. macOS shows its "
            + "orange recording indicator, naming Cupertino, for as long as this runs. Refuses "
            + "if a recording is already running.",
          "inputSchema": [
            "type": "object",
            "properties": [
              "device": deviceArg,
              "directory": [
                "type": "string",
                "description":
                  "Optional directory to write into. Must be inside "
                  + SoundCapture.root.path + ".",
              ],
            ],
            "required": [Any](),
          ],
          "annotations": [
            "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false,
          ],
        ],
        [
          "name": "apple_sound_stop_recording",
          "description":
            "Stop the running recording and return its path, size, duration and whether it is "
            + "silent. Nothing is opened or revealed — the path is the result.",
          "inputSchema": empty,
          "annotations": [
            "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false,
          ],
        ],
        [
          "name": "apple_sound_recording_status",
          "description":
            "Whether a recording is running, and if so for how long and at what level. Read from "
            + "the live recorder, so a recording that stopped on its own reports as stopped.",
          "inputSchema": empty,
          "annotations": ["readOnlyHint": true],
        ],
      ]
    }

    return list
  }

  // ─── calls ─────────────────────────────────────────────────────────────────

  private static func call(
    _ name: String, args: [String: Any], id: Any?, writesAllowed: Bool, recordingAllowed: Bool
  ) -> String {
    // A gated tool is not registered, so reaching one here means the caller
    // guessed the name. Refusing by the same sentence the list would have given
    // keeps "off" from leaking as a different error than "no such tool".
    let visible = Set(
      tools(writesAllowed: writesAllowed, recordingAllowed: recordingAllowed).compactMap {
        $0["name"] as? String
      })
    guard visible.contains(name) else {
      return InProcessRPC.failure(id, "unknown tool '\(name)'")
    }

    let uid = args["device"] as? String

    switch name {
    case "apple_sound_list_devices":
      let devices = SoundDevices.all()
      return InProcessRPC.ok(
        id,
        [
          "devices": devices.map(render),
          "count": devices.count,
        ])

    case "apple_sound_get_volume":
      guard let device = resolve(uid) else {
        return InProcessRPC.failure(id, missing(uid))
      }
      return InProcessRPC.ok(id, render(device))

    case "apple_sound_diagnostics":
      return InProcessRPC.ok(
        id, diagnostics(writesAllowed: writesAllowed, recordingAllowed: recordingAllowed))

    case "apple_sound_set_volume":
      guard let level = args["level"] as? Double else {
        return InProcessRPC.failure(id, "level is required, between 0 and 1.")
      }
      do {
        try SoundDevices.setVolume(Float(level), uid: uid)
        guard let device = resolve(uid) else { return InProcessRPC.failure(id, missing(uid)) }
        return InProcessRPC.ok(id, render(device))
      } catch { return InProcessRPC.failure(id, String(describing: error)) }

    case "apple_sound_set_muted":
      guard let muted = args["muted"] as? Bool else {
        return InProcessRPC.failure(id, "muted is required.")
      }
      do {
        try SoundDevices.setMuted(muted, uid: uid)
        guard let device = resolve(uid) else { return InProcessRPC.failure(id, missing(uid)) }
        return InProcessRPC.ok(id, render(device))
      } catch { return InProcessRPC.failure(id, String(describing: error)) }

    case "apple_sound_set_default_device":
      guard let uid else { return InProcessRPC.failure(id, "device is required.") }
      let forInput = args["input"] as? Bool ?? false
      do {
        try SoundDevices.setDefaultDevice(uid: uid, forInput: forInput)
        guard let device = SoundDevices.device(uid: uid) else {
          return InProcessRPC.failure(id, missing(uid))
        }
        return InProcessRPC.ok(id, render(device))
      } catch { return InProcessRPC.failure(id, String(describing: error)) }

    case "apple_sound_speak":
      guard let text = (args["text"] as? String), !text.isEmpty else {
        return InProcessRPC.failure(id, "text is required.")
      }
      return speak(text: text, voice: args["voice"] as? String, id: id)

    case "apple_sound_start_recording":
      let directory = (args["directory"] as? String).map { URL(fileURLWithPath: $0) }
      do {
        let path = try InProcessRPC.blocking {
          try await MainActor.run {
            try SoundCapture.shared.start(deviceUID: uid, directory: directory)
          }
        }
        return InProcessRPC.ok(id, ["recording": true, "path": path])
      } catch { return InProcessRPC.failure(id, String(describing: error)) }

    case "apple_sound_stop_recording":
      do {
        let done = try InProcessRPC.blocking {
          try await MainActor.run { try SoundCapture.shared.stop() }
        }
        return InProcessRPC.ok(
          id,
          [
            "path": done.path,
            "bytes": done.bytes,
            "seconds": (done.seconds * 100).rounded() / 100,
            "silent": done.silent,
            "peakDBFS": (Double(done.peakDBFS) * 10).rounded() / 10,
          ])
      } catch { return InProcessRPC.failure(id, String(describing: error)) }

    case "apple_sound_recording_status":
      let status = (try? InProcessRPC.blocking {
        await MainActor.run { SoundCapture.shared.status() }
      })
      guard let status else { return InProcessRPC.failure(id, "Could not read the recorder.") }
      var out: [String: Any] = [
        "recording": status.recording,
        "seconds": (status.seconds * 100).rounded() / 100,
      ]
      if let path = status.path { out["path"] = path }
      if let device = status.deviceUID { out["device"] = device }
      if status.recording {
        out["peakDBFS"] = (Double(status.peakDBFS) * 10).rounded() / 10
        out["silent"] = status.silent
      }
      return InProcessRPC.ok(id, out)

    default:
      return InProcessRPC.failure(id, "unknown tool '\(name)'")
    }
  }

  private static func resolve(_ uid: String?) -> SoundDevices.Device? {
    guard let uid else { return SoundDevices.all().first(where: \.isDefaultOutput) }
    return SoundDevices.device(uid: uid)
  }

  private static func missing(_ uid: String?) -> String {
    guard let uid else { return "This Mac reports no default output device." }
    return "No audio device with uid '\(uid)' on this Mac."
  }

  /// `null` for a device with no volume control, never 0 — a display output
  /// genuinely has none, and reporting it as silent would be a different claim.
  private static func render(_ d: SoundDevices.Device) -> [String: Any] {
    var out: [String: Any] = [
      "uid": d.uid,
      "name": d.name,
      "transport": d.transport,
      "inputChannels": d.inputChannels,
      "outputChannels": d.outputChannels,
      "isDefaultInput": d.isDefaultInput,
      "isDefaultOutput": d.isDefaultOutput,
    ]
    out["volume"] = d.volume.map { (Double($0) * 100).rounded() / 100 } ?? NSNull()
    out["muted"] = d.muted ?? NSNull()
    return out
  }

  /// Runs `/usr/bin/say` and waits. Bounded by the schema's `maxLength` rather
  /// than by a timeout, because the only thing that makes this slow is how much
  /// text the caller asked for.
  private static func speak(text: String, voice: String?, id: Any?) -> String {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    var arguments: [String] = []
    if let voice, !voice.isEmpty { arguments += ["-v", voice] }
    // `--` so a leading hyphen in the text cannot become a flag.
    arguments += ["--", text]
    task.arguments = arguments
    task.standardOutput = FileHandle.nullDevice
    let errors = Pipe()
    task.standardError = errors
    do { try task.run() } catch {
      return InProcessRPC.failure(id, "Could not run /usr/bin/say: \(error.localizedDescription)")
    }
    let stderr = errors.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    guard task.terminationStatus == 0 else {
      let detail = String(decoding: stderr, as: UTF8.self).trimmingCharacters(
        in: .whitespacesAndNewlines)
      return InProcessRPC.failure(
        id, detail.isEmpty ? "say exited \(task.terminationStatus)." : detail)
    }
    return InProcessRPC.ok(id, ["spoken": true, "characters": text.count])
  }

  // ─── resources ─────────────────────────────────────────────────────────────

  private static func resources() -> [[String: Any]] {
    [
      [
        "uri": "cupertino://sound/guide", "name": "Sound guide",
        "mimeType": "text/markdown",
      ],
      [
        "uri": "cupertino://sound/diagnostics", "name": "Sound diagnostics",
        "mimeType": "application/json",
      ],
    ]
  }

  private static func readResource(
    _ uri: String, id: Any?, writesAllowed: Bool, recordingAllowed: Bool
  ) -> String {
    switch uri {
    case "cupertino://sound/guide":
      return InProcessRPC.result(
        id,
        ["contents": [["uri": uri, "mimeType": "text/markdown", "text": guide]]])
    case "cupertino://sound/diagnostics":
      let text = InProcessRPC.jsonText(
        diagnostics(writesAllowed: writesAllowed, recordingAllowed: recordingAllowed))
      return InProcessRPC.result(
        id, ["contents": [["uri": uri, "mimeType": "application/json", "text": text]]])
    default:
      return InProcessRPC.error(id, code: -32602, message: "unknown resource '\(uri)'")
    }
  }

  private static let guide = """
    # Sound

    Two halves with very different costs.

    **Devices and volume need no permission at all.** `apple_sound_list_devices` and
    `apple_sound_get_volume` work on a Mac that has granted Cupertino nothing.

    **Recording needs the Microphone permission** and the `allowRecording` gate, which is
    off by default. While it runs, macOS shows its orange recording indicator naming
    Cupertino — this is never silent or hidden.

    ## Devices are named by `uid`, never by name

    Names are not unique and they are personal: AirPods are named after their owner by
    default. Every tool takes the `uid` from `apple_sound_list_devices`.

    A device with no volume control reports `volume: null`, not `0`. Most outputs that are
    not built-in speakers genuinely have none — that is hardware, not an error.

    ## Recording

    `apple_sound_start_recording` returns a path immediately and keeps recording.
    `apple_sound_stop_recording` finalises the file and returns its path, size, duration
    and `silent`. **Nothing is opened or revealed**: the path is the result.

    Check `silent` before trusting a recording. It means the peak never rose above
    -55 dBFS, which is a muted or dead input rather than a quiet room.

    Only one recording runs at a time; starting a second is refused rather than queued.
    Recordings are written as CAF, which stays readable if the app is interrupted — an
    m4a interrupted the same way cannot be opened at all.

    ## What this surface does NOT do

    It cannot record what the speakers are playing, only what the microphone hears. It
    does not transcribe. It cannot reach audio inside another app.
    """

  // ─── diagnostics ───────────────────────────────────────────────────────────

  static func diagnostics(writesAllowed: Bool, recordingAllowed: Bool) -> [String: Any] {
    let devices = SoundDevices.all()
    let status = Permissions.microphone()
    return [
      "server": ["name": "cupertino-sound", "version": AppInfo.shortVersion],
      "gates": ["allowWrites": writesAllowed, "allowRecording": recordingAllowed],
      "devices": [
        // Counts and roles only. A device NAME is the data here, and diagnostics
        // is the one result a user is most likely to paste into an issue.
        "total": devices.count,
        "inputs": devices.filter(\.canRecord).count,
        "outputs": devices.filter(\.canPlay).count,
        "withVolumeControl": devices.filter { $0.volume != nil }.count,
        "defaultOutput": devices.contains(where: \.isDefaultOutput),
        "defaultInput": devices.contains(where: \.isDefaultInput),
      ],
      "microphone": [
        "status": status.wireName,
        "usable": status == .granted,
      ],
      "recordingDirectory": SoundCapture.root.path,
      "caveats": [
        "Enumerating devices and reading the volume need no permission; only recording does.",
        "Most devices expose no volume control. That is reported as null, not as zero.",
        "macOS shows its orange microphone indicator, naming Cupertino, while recording.",
        "Selecting an input device switches the system default input for the recording.",
        "Recordings are CAF. An interrupted m4a cannot be opened at all; a CAF can.",
        "This surface cannot capture what the speakers play, and does not transcribe.",
      ],
    ]
  }
}
