/*
 * Phase-0 probe: what can Cupertino do with the speakers and the microphone,
 * and what does each half cost?
 *
 * docs/surfaces.md: "Start with a probe, not a package." This is that probe for
 * the proposed `sound` surface. Swift rather than .mjs because CoreAudio,
 * AVFoundation and Speech are all unreachable from node — which is itself one
 * of the findings that decides the architecture, exactly as ScreenCaptureKit
 * was for `screen`.
 *
 * ## The surface splits in two by permission, and the probe is built that way
 *
 * Measured from a shell before this file existed:
 *
 *   osascript -e 'get volume settings'   answers with NO TCC grant, ~127 ms
 *   system_profiler -json SPAudioDataType  4 devices, ~115 ms
 *   /usr/bin/af*  ->  afclip afconvert afhash afida afinfo afktool afplay
 *                     afscexpand.  THERE IS NO afrecord.
 *
 * So the output half is free and the input half is not, and the interesting
 * question is not "can we record" but "what does the recording half drag in
 * that the free half would otherwise never need". Sections A and B answer the
 * free half; C and D answer the microphone; E answers transcription.
 *
 * ## Read the two identities separately
 *
 * TCC attributes the microphone to the RESPONSIBLE PROCESS, so this binary
 * answers a different question depending on who runs it:
 *
 *   swift scripts/probe-sound.swift          responsible = your terminal
 *   scripts/spike-app-tcc/build.sh run       responsible = the signed .app
 *
 * The second is the one the design depends on. spike-app-tcc measured that
 * inheritance for Full Disk Access and Apple Events, the codebase generalised
 * it to every TCC service, and it was WRONG for Accessibility — a day was lost
 * to it. probe-screen.swift re-measured rather than inherit; so does this.
 *
 * ## Two answers that are allowed to disagree
 *
 * `AVCaptureDevice.authorizationStatus(for: .audio)` is a CLAIM about an
 * identity; getting non-silent samples out of a recorder is the thing the
 * feature actually does. A green flag over a silent buffer is a real state —
 * a muted or in-use device, or a grant belonging to a different copy of the
 * bundle — and reporting only the flag would hide it.
 *
 * ## A DEVICE NAME IS THE DATA
 *
 * docs/surfaces.md: "A filename can be the data." A device name is worse.
 * AirPods are named after their owner by default, so this list is a personal
 * name plus a hardware inventory of the room. The default output reports
 * COUNTS, TRANSPORTS and ROLES and never a device name. `--unsafe-names`
 * prints them, and exists so the leak can be inspected deliberately rather
 * than by accident — the same escape hatch probe-screen.swift gives window
 * titles.
 *
 * Nothing recorded is kept. Section D writes ~1 s to a temp file, reports its
 * duration, its byte count and whether it is non-silent, and deletes it. It
 * never plays back, never transcribes, and never prints a sample.
 *
 * ## It refuses to report a negative it cannot stand behind
 *
 * probe-maps.mjs exits 3 rather than print a result it cannot support, after
 * "no file lane" was declared three times about a store that was there. Same
 * ladder: 3 for UNDETERMINED, 4 for a measured NO-GO, 0 for GO.
 *
 * Usage:
 *   swift scripts/probe-sound.swift [--unsafe-names] [--force] [--seconds=N]
 *
 * Without a microphone grant section D STOPS rather than prompt: the prompt
 * would be attributed to whatever launched it, and granting the microphone to
 * a terminal is the misattribution the whole project exists to avoid.
 * --force overrides.
 */

import AVFoundation
import CoreAudio
import Foundation
import Speech

// ─── arguments ───────────────────────────────────────────────────────────────

let argv = CommandLine.arguments
func flag(_ name: String) -> Bool { argv.contains("--\(name)") }
func option(_ name: String) -> String? {
  argv.first { $0.hasPrefix("--\(name)=") }.map { String($0.dropFirst(name.count + 3)) }
}

let unsafeNames = flag("unsafe-names")
let force = flag("force")
let captureSeconds = Double(option("seconds") ?? "") ?? 1.0

// Exit codes, mirroring scripts/probe-maps.mjs and scripts/probe-screen.swift.
let GO: Int32 = 0
let UNDETERMINED: Int32 = 3
let NO_GO: Int32 = 4

func section(_ title: String) {
  print("\n── \(title) " + String(repeating: "─", count: max(0, 60 - title.count)))
}
func row(_ key: String, _ value: String) {
  print("  \(key.padding(toLength: 30, withPad: " ", startingAt: 0)) \(value)")
}

/// Every device name goes through here. The redaction is at the PRINT boundary
/// rather than at each call site, for the reason probe-home.mjs gives for its
/// `assertRedacted` walk: a check that each caller has to remember is a check
/// that eventually one caller forgets.
func safeName(_ name: String) -> String {
  if unsafeNames { return name }
  // Keep the shape — length is a weak signal and useful when a device list
  // looks wrong — without keeping a single character of it.
  return "<\(name.count) chars>"
}

/// The parent chain, names only, nearest first. `ps` rather than `sysctl` because
/// this is a probe and the reader has to be able to check the answer by hand.
func processAncestry() -> String {
  var names: [String] = []
  var pid = getppid()
  while pid > 1, names.count < 6 {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/ps")
    // ppid FIRST: it is the only field guaranteed free of spaces, and `comm` is
    // a full path — "/Applications/Visual Studio Code.app/…" splits into three.
    task.arguments = ["-o", "ppid=,comm=", "-p", "\(pid)"]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = FileHandle.nullDevice
    guard (try? task.run()) != nil else { break }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    let line = String(decoding: data, as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let parts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
    guard parts.count == 2, let next = Int32(parts[0]) else { break }
    names.append(URL(fileURLWithPath: String(parts[1])).lastPathComponent)
    pid = next
  }
  return names.isEmpty ? "unknown" : names.joined(separator: " <- ")
}

var blockers: [String] = []
var notes: [String] = []

// ─── CoreAudio helpers ───────────────────────────────────────────────────────
// The C API is four lines per question, so each question gets a function
// rather than four lines inline. All of them fail soft: a device that refuses
// a property is a real state (an aggregate device has no transport, a display
// has no volume control) and must read as "unavailable", never as an error.

func address(
  _ selector: AudioObjectPropertySelector,
  _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
  _ element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain
) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
}

func deviceIDs() -> [AudioObjectID] {
  var addr = address(kAudioHardwarePropertyDevices)
  var size: UInt32 = 0
  let system = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else {
    return []
  }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}

func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioObjectID? {
  var addr = address(selector)
  var id = AudioObjectID(0)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  let system = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &id) == noErr, id != 0 else {
    return nil
  }
  return id
}

func stringProperty(
  _ id: AudioObjectID, _ selector: AudioObjectPropertySelector,
  _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> String? {
  var addr = address(selector, scope)
  var value: CFString?
  var size = UInt32(MemoryLayout<CFString?>.size)
  let status = withUnsafeMutablePointer(to: &value) {
    AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0)
  }
  guard status == noErr, let value else { return nil }
  return value as String
}

func channelCount(_ id: AudioObjectID, scope: AudioObjectPropertyScope) -> Int {
  var addr = address(kAudioDevicePropertyStreamConfiguration, scope)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
  let raw = UnsafeMutableRawPointer.allocate(
    byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
  defer { raw.deallocate() }
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
  let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
  return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func transportName(_ id: AudioObjectID) -> String {
  var addr = address(kAudioDevicePropertyTransportType)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr else {
    return "unavailable"
  }
  switch value {
  case kAudioDeviceTransportTypeBuiltIn: return "built-in"
  case kAudioDeviceTransportTypeUSB: return "usb"
  case kAudioDeviceTransportTypeBluetooth: return "bluetooth"
  case kAudioDeviceTransportTypeBluetoothLE: return "bluetooth-le"
  case kAudioDeviceTransportTypeHDMI: return "hdmi"
  case kAudioDeviceTransportTypeDisplayPort: return "displayport"
  case kAudioDeviceTransportTypeAirPlay: return "airplay"
  case kAudioDeviceTransportTypeVirtual: return "virtual"
  case kAudioDeviceTransportTypeAggregate: return "aggregate"
  case kAudioDeviceTransportTypeThunderbolt: return "thunderbolt"
  case kAudioDeviceTransportTypeContinuityCaptureWired: return "continuity-wired"
  case kAudioDeviceTransportTypeContinuityCaptureWireless: return "continuity-wireless"
  default: return "other"
  }
}

func isSettable(
  _ id: AudioObjectID, _ selector: AudioObjectPropertySelector,
  _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
  _ element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain
) -> Bool {
  var addr = address(selector, scope, element)
  var settable: DarwinBoolean = false
  guard AudioObjectHasProperty(id, &addr) else { return false }
  guard AudioObjectIsPropertySettable(id, &addr, &settable) == noErr else { return false }
  return settable.boolValue
}

/// `nil` when the device exposes no scalar volume at all — normal for HDMI,
/// aggregate and most display outputs, and the reason the tool has to report
/// "no volume control" rather than treating it as a failure.
func volumeScalar(_ id: AudioObjectID, scope: AudioObjectPropertyScope) -> Float? {
  // Main element first, then the two front channels: a device may expose
  // per-channel volume with no master, which reads as "no volume" if only the
  // main element is asked. Measured on real hardware, not defensive padding.
  for element: AudioObjectPropertyElement in [kAudioObjectPropertyElementMain, 1, 2] {
    var addr = address(kAudioDevicePropertyVolumeScalar, scope, element)
    guard AudioObjectHasProperty(id, &addr) else { continue }
    var value: Float32 = 0
    var size = UInt32(MemoryLayout<Float32>.size)
    if AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr { return value }
  }
  return nil
}

// ─── section A: can this process see the audio graph at all? ─────────────────
// Asked first, and a failure here stops the run — probe-maps.mjs's question 0.

func sectionA() -> Bool {
  section("A · device graph (no permission expected)")

  let start = Date()
  let ids = deviceIDs()
  let elapsed = Date().timeIntervalSince(start) * 1000

  guard !ids.isEmpty else {
    row("devices", "NONE — CoreAudio returned an empty device list")
    blockers.append(
      "CoreAudio enumerated no devices. That is not a permission failure — there is no TCC "
        + "class for device enumeration — so this is a broken audio stack or a headless boot, "
        + "and every negative below would be meaningless.")
    return false
  }

  row("devices", "\(ids.count)")
  row("enumeration cost", String(format: "%.1f ms", elapsed))

  let defaultOut = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
  let defaultIn = defaultDevice(kAudioHardwarePropertyDefaultInputDevice)

  var inputs = 0
  var outputs = 0
  for id in ids {
    let ins = channelCount(id, scope: kAudioObjectPropertyScopeInput)
    let outs = channelCount(id, scope: kAudioObjectPropertyScopeOutput)
    if ins > 0 { inputs += 1 }
    if outs > 0 { outputs += 1 }

    let name = stringProperty(id, kAudioObjectPropertyName) ?? "(unnamed)"
    var roles: [String] = []
    if id == defaultOut { roles.append("default-out") }
    if id == defaultIn { roles.append("default-in") }
    let volume = volumeScalar(id, scope: kAudioObjectPropertyScopeOutput)
    let volumeText = volume.map { String(format: "vol %.2f", $0) } ?? "no volume control"

    print(
      "    \(safeName(name).padding(toLength: 20, withPad: " ", startingAt: 0)) "
        + "\(transportName(id).padding(toLength: 16, withPad: " ", startingAt: 0)) "
        + "in:\(ins) out:\(outs)  \(volumeText)"
        + (roles.isEmpty ? "" : "  [\(roles.joined(separator: " "))]"))
  }

  row("input devices", "\(inputs)")
  row("output devices", "\(outputs)")

  if inputs == 0 {
    notes.append(
      "No input device on this Mac. Sections C and D cannot say anything about recording, "
        + "and their result must not be read as a NO-GO for the lane.")
  }
  return true
}

// ─── section B: what of the free half is actually writable? ──────────────────
// The point of the surface's ungated half. `AudioObjectIsPropertySettable` is
// ASKED rather than assumed, and nothing is ever switched: docs/maps.md's
// lesson is "Still unmeasured: whether `Favorite` really is a toggle. Nothing
// has been pressed." A declared rw is a claim; settable is the measurement.

func sectionB() {
  section("B · what the free half can change")

  let system = AudioObjectID(kAudioObjectSystemObject)
  let outSettable = isSettable(system, kAudioHardwarePropertyDefaultOutputDevice)
  let inSettable = isSettable(system, kAudioHardwarePropertyDefaultInputDevice)

  row("default output settable", outSettable ? "YES" : "no")
  row("default input settable", inSettable ? "YES" : "no")

  if outSettable {
    notes.append(
      "Switching the default output device is available and has NO CLI and NO AppleScript "
        + "equivalent — it is the one tool that justifies CoreAudio over osascript for the free "
        + "half. Nothing was switched by this probe.")
  }

  if let out = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice) {
    let hasVolume = volumeScalar(out, scope: kAudioObjectPropertyScopeOutput) != nil
    let volumeSettable = isSettable(
      out, kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeOutput)
    let muteSettable = isSettable(out, kAudioDevicePropertyMute, kAudioObjectPropertyScopeOutput)
    row("default out has volume", hasVolume ? "YES" : "no")
    row("  · volume settable", volumeSettable ? "YES" : "no")
    row("  · mute settable", muteSettable ? "YES" : "no")

    if hasVolume && !volumeSettable {
      notes.append(
        "The default output reports a volume it will not let anyone set. `set_volume` has to "
          + "report that per device rather than fail, and `get_volume` stays useful.")
    }
  }

  // The osascript lane is measured too, because it is what the free half would
  // use if this surface were node-hosted, and the comparison is the argument
  // for where it ends up living.
  let start = Date()
  let task = Process()
  task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
  task.arguments = ["-e", "get volume settings"]
  let pipe = Pipe()
  task.standardOutput = pipe
  task.standardError = FileHandle.nullDevice
  do {
    try task.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    let elapsed = Date().timeIntervalSince(start) * 1000
    let ok = task.terminationStatus == 0 && !data.isEmpty
    row("osascript volume read", ok ? String(format: "OK, %.0f ms", elapsed) : "FAILED")
    if ok {
      notes.append(
        "`get volume settings` answers with no TCC grant and no Automation prompt: the volume "
          + "commands are StandardAdditions handled inside osascript and target no app, so "
          + "there is no inter-app Apple Event to consent to. Same numbers CoreAudio gives, "
          + "one process spawn slower.")
    }
  } catch {
    row("osascript volume read", "could not run osascript")
  }
}

// ─── section C: the microphone grant, for THIS identity ──────────────────────

func authorizationName(_ status: AVAuthorizationStatus) -> String {
  switch status {
  case .notDetermined: return "notDetermined — nobody has been asked"
  case .restricted: return "restricted — policy forbids it"
  case .denied: return "denied"
  case .authorized: return "authorized"
  @unknown default: return "unknown"
  }
}

func sectionC() -> AVAuthorizationStatus {
  section("C · microphone grant")

  let status = AVCaptureDevice.authorizationStatus(for: .audio)

  // The PROCESS NAME is not the RESPONSIBLE PROCESS, and conflating the two is
  // how a probe reports a grant question it never asked. TCC attributes the
  // microphone to an ancestor — the .app when this runs inside one, the editor
  // or terminal when it does not — so the chain is printed and the reader is
  // told which end of it the status describes.
  row("process", "\(ProcessInfo.processInfo.processName) (pid \(getpid()))")
  row("ancestry", processAncestry())
  row("authorizationStatus", authorizationName(status))
  print(
    "    ^ this describes whichever ancestor TCC holds responsible, NOT necessarily the process "
      + "named above.")

  let discovered = AVCaptureDevice.DiscoverySession(
    deviceTypes: [.microphone, .external],
    mediaType: .audio,
    position: .unspecified
  ).devices

  row("AVCaptureDevice count", "\(discovered.count)")
  for device in discovered {
    print("    \(safeName(device.localizedName))  uid:\(device.uniqueID.count) chars")
  }

  if discovered.count > 1 {
    notes.append(
      "More than one input device is discoverable, so `start_recording` should take an optional "
        + "device argument rather than silently using the system default.")
  }
  if !discovered.isEmpty && status != .authorized {
    notes.append(
      "Devices ENUMERATE without the grant — only their samples are gated. So `list_devices` "
        + "belongs in the ungated half even though recording does not.")
  }

  return status
}

// ─── section D: does a capture produce non-silent bytes, and at what cost? ───

func sectionD(status: AVAuthorizationStatus) async -> Bool {
  section("D · capture")

  guard status == .authorized || force else {
    row("capture", "SKIPPED — no grant, and prompting here would misattribute it")
    print(
      """

        The prompt would name whatever launched this probe. Granting the
        microphone to a terminal is precisely the misattribution the app
        exists to prevent, so this stops instead. Re-run with --force to
        prompt deliberately, or run it through scripts/spike-app-tcc so the
        signed bundle is the identity being measured.
      """)
    blockers.append(
      "Capture is unmeasured for this identity. That is UNDETERMINED, not a NO-GO — "
        + "see the note above.")
    return false
  }

  let directory = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("cupertino-probe-sound", isDirectory: true)
  try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let target = directory.appendingPathComponent("probe.m4a")
  try? FileManager.default.removeItem(at: target)

  // Deleted on every path out of this function, including a throw. A probe
  // that leaves a recording of someone's room in /tmp has done more damage
  // than this surface would ever have been worth — docs/passwords.md's rule,
  // which asserts structure and never a credential.
  defer { try? FileManager.default.removeItem(at: target) }

  let settings: [String: Any] = [
    AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
    AVSampleRateKey: 44100.0,
    AVNumberOfChannelsKey: 1,
    AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
  ]

  let recorder: AVAudioRecorder
  do {
    recorder = try AVAudioRecorder(url: target, settings: settings)
  } catch {
    row("AVAudioRecorder", "FAILED to construct: \(error.localizedDescription)")
    blockers.append("AVAudioRecorder could not be constructed: \(error.localizedDescription)")
    return false
  }

  recorder.isMeteringEnabled = true

  // Await consent EXPLICITLY, outside the timed section. `record()` blocks on
  // the TCC prompt, so timing across it measures how fast a human clicks a
  // dialog: the first run of this lane reported a 48,542 ms "startup", which is
  // exactly that and nothing about the lane. Asking first separates the two.
  if status == .notDetermined {
    let consentStart = Date()
    let granted = await AVCaptureDevice.requestAccess(for: .audio)
    row(
      "consent prompt",
      String(
        format: "%@ after %.1f s", granted ? "ALLOWED" : "REFUSED",
        Date().timeIntervalSince(consentStart)))
    guard granted else {
      blockers.append("Consent was refused at the prompt, so capture is unmeasured.")
      return false
    }
  }

  let start = Date()
  guard recorder.record() else {
    row("record()", "REFUSED")
    blockers.append(
      "AVAudioRecorder.record() returned false. The grant may belong to a different copy of "
        + "this bundle — 'One identifier, four grants', spike-app-tcc/README.md.")
    return false
  }
  let startupMs = Date().timeIntervalSince(start) * 1000

  // Sample the meter while it runs. This is a LEVEL, never a sample: it says
  // whether the microphone is producing anything, which is the one thing a
  // green authorizationStatus cannot tell you.
  var peak: Float = -160
  let deadline = Date().addingTimeInterval(captureSeconds)
  while Date() < deadline {
    recorder.updateMeters()
    peak = max(peak, recorder.peakPower(forChannel: 0))
    try? await Task.sleep(nanoseconds: 50_000_000)
  }
  let duration = recorder.currentTime
  recorder.stop()

  let bytes = (try? FileManager.default.attributesOfItem(atPath: target.path)[.size] as? Int) ?? 0

  row("startup to record()", String(format: "%.0f ms", startupMs))
  row("captured duration", String(format: "%.2f s", duration))
  row("bytes", "\(bytes)")
  row("peak level", String(format: "%.1f dBFS", peak))

  let silent = peak <= -55
  row("non-silent", silent ? "NO — at or below -55 dBFS" : "yes")

  if bytes == 0 {
    blockers.append("The recorder produced a zero-byte file: the grant is green but nothing lands.")
    return false
  }
  if silent {
    notes.append(
      "The capture is silent. That is a real state — a muted or in-use device, or a quiet "
        + "room — and NOT necessarily a lane failure, which is why it is a note rather than a "
        + "blocker. Re-run while making noise before trusting it either way.")
  }

  notes.append(
    "Recording is STATEFUL, and this is the first such tool in the project. start/stop outlives "
      + "a tool call, so `recording_status` must read the live recorder rather than cache, and "
      + "`start` must refuse when one is already running instead of opening a second.")

  return true
}

// ─── section E: on-device transcription ──────────────────────────────────────
// Phase 2, measured now because whether the model is already installed decides
// whether the first call takes 200 ms or several minutes — a product fact.

func sectionE() async {
  section("E · transcription (phase 2)")

  let locale = Locale.current
  let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
  let status = await AssetInventory.status(forModules: [transcriber])

  let name: String
  switch status {
  case .unsupported: name = "unsupported for this locale"
  case .supported: name = "supported, NOT installed — first call downloads a model"
  case .downloading: name = "downloading"
  case .installed: name = "installed — ready"
  @unknown default: name = "unknown"
  }

  row("locale", locale.identifier)
  row("SpeechTranscriber asset", name)

  let supported = await SpeechTranscriber.supportedLocales
  row("supported locales", "\(supported.count)")

  if status == .supported {
    notes.append(
      "The transcription model is not installed. A first `transcribe` call would download it, "
        + "so the tool has to report that state rather than appear to hang — the same reasoning "
        + "that makes `indexAgeSeconds` part of a result rather than a footnote.")
  }
  if status == .unsupported {
    notes.append(
      "SpeechTranscriber does not support \(locale.identifier). Phase 2 needs an explicit locale "
        + "argument and a clear refusal, not a silent fallback to English.")
  }
}

// ─── verdict ─────────────────────────────────────────────────────────────────

func runProbe() async -> Int32 {
  print("Cupertino phase-0 probe · sound")
  print("  \(ProcessInfo.processInfo.operatingSystemVersionString)")
  if !unsafeNames { print("  device names redacted — pass --unsafe-names to see them") }

  guard sectionA() else {
    section("verdict")
    for b in blockers { print("    - \(b)") }
    print("\n  UNDETERMINED — cannot see the audio graph")
    return UNDETERMINED
  }

  sectionB()
  let status = sectionC()
  let captured = await sectionD(status: status)
  await sectionE()

  section("verdict")

  // The free half stands on its own: it needs no grant, so section A passing
  // IS its verdict. The recording half is what can be undetermined.
  print("  free half (devices, volume, speech, playback):  GO — no permission required")

  if captured {
    print("  recording half:                                GO")
  } else if status == .authorized || force {
    print("  recording half:                                NO-GO")
  } else {
    print("  recording half:                                UNDETERMINED — not measured")
  }

  if !notes.isEmpty {
    print("\n  NOTES:")
    for n in notes { print("    - \(n)") }
  }
  if !blockers.isEmpty {
    print("\n  BLOCKERS:")
    for b in blockers { print("    - \(b)") }
  }

  if captured { return GO }
  return (status == .authorized || force) ? NO_GO : UNDETERMINED
}

// ─── entry ───────────────────────────────────────────────────────────────────
// Task + RunLoop rather than a semaphore, matching probe-screen.swift: blocking
// the main thread and then waiting on an async framework is a deadlock waiting
// to happen.

Task {
  let code = await runProbe()
  exit(code)
}
RunLoop.main.run()
