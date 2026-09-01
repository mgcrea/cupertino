import CoreAudio
import Foundation

/// The audio graph: what devices exist, which are default, and how loud they are.
///
/// **The half of `sound` that needs no permission at all.** There is no TCC
/// class for enumerating devices or setting the volume, and measured on
/// macOS 26.6 a full enumeration costs 28 ms — see `docs/sound.md`. That makes
/// this the first thing in the project that works before any grant, which is
/// why it is deliberately kept apart from `SoundCapture`: one file that needs
/// nothing, one that needs `kTCCServiceMicrophone`.
///
/// Why CoreAudio rather than `osascript`, which the node surfaces would have
/// used: `set volume` is one global number and cannot name a device, and
/// **switching the default output device has no CLI and no AppleScript
/// equivalent anywhere**. `/usr/sbin/system_profiler -json SPAudioDataType`
/// answers the read half in ~115 ms but reports no settability at all. The one
/// capability people actually want here — "use my headphones" — is reachable
/// only from this API.
///
/// Every accessor fails soft. A device that refuses a property is a real state
/// rather than an error: 3 of 4 devices on the probed machine expose no volume
/// control at all, because HDMI, DisplayPort and most inputs genuinely have
/// none. Reporting that per device is the honest answer; failing the call is
/// not.
enum SoundDevices {

  // ─── model ────────────────────────────────────────────────────────────────

  struct Device: Identifiable, Hashable {
    let id: AudioObjectID
    let uid: String
    let name: String
    let transport: String
    let inputChannels: Int
    let outputChannels: Int
    /// `nil` when the device exposes no scalar volume — not zero, which would
    /// read as "silent" and is a different fact.
    let volume: Float?
    let muted: Bool?
    let isDefaultInput: Bool
    let isDefaultOutput: Bool

    var canRecord: Bool { inputChannels > 0 }
    var canPlay: Bool { outputChannels > 0 }
  }

  // ─── property plumbing ────────────────────────────────────────────────────

  private static func address(
    _ selector: AudioObjectPropertySelector,
    _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
    _ element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain
  ) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
  }

  private static let system = AudioObjectID(kAudioObjectSystemObject)

  private static func stringProperty(
    _ id: AudioObjectID, _ selector: AudioObjectPropertySelector
  ) -> String? {
    var addr = address(selector)
    var value: CFString?
    var size = UInt32(MemoryLayout<CFString?>.size)
    let status = withUnsafeMutablePointer(to: &value) {
      AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0)
    }
    guard status == noErr, let value else { return nil }
    return value as String
  }

  private static func channelCount(_ id: AudioObjectID, scope: AudioObjectPropertyScope) -> Int {
    var addr = address(kAudioDevicePropertyStreamConfiguration, scope)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else {
      return 0
    }
    let raw = UnsafeMutableRawPointer.allocate(
      byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
    let list = UnsafeMutableAudioBufferListPointer(
      raw.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) }
  }

  private static func transportName(_ id: AudioObjectID) -> String {
    var addr = address(kAudioDevicePropertyTransportType)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr else {
      return "unknown"
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

  /// Volume for a device, trying the main element and then the two front
  /// channels. A device can expose per-channel volume with no master, and
  /// asking only the main element reports "no volume" about something that has
  /// one.
  private static func volume(_ id: AudioObjectID, scope: AudioObjectPropertyScope) -> Float? {
    for element: AudioObjectPropertyElement in [kAudioObjectPropertyElementMain, 1, 2] {
      var addr = address(kAudioDevicePropertyVolumeScalar, scope, element)
      guard AudioObjectHasProperty(id, &addr) else { continue }
      var value: Float32 = 0
      var size = UInt32(MemoryLayout<Float32>.size)
      if AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr { return value }
    }
    return nil
  }

  private static func muted(_ id: AudioObjectID, scope: AudioObjectPropertyScope) -> Bool? {
    var addr = address(kAudioDevicePropertyMute, scope)
    guard AudioObjectHasProperty(id, &addr) else { return nil }
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr else { return nil }
    return value != 0
  }

  private static func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioObjectID? {
    var addr = address(selector)
    var id = AudioObjectID(0)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &id) == noErr, id != 0 else {
      return nil
    }
    return id
  }

  // ─── reads ────────────────────────────────────────────────────────────────

  static func all() -> [Device] {
    var addr = address(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else {
      return []
    }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }

    let defaultIn = defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
    let defaultOut = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)

    return ids.compactMap { id in
      let ins = channelCount(id, scope: kAudioObjectPropertyScopeInput)
      let outs = channelCount(id, scope: kAudioObjectPropertyScopeOutput)
      // A device with no channels either way is plumbing, not something a
      // caller can choose. Dropping it keeps the list to what can be named.
      guard ins > 0 || outs > 0 else { return nil }
      let scope: AudioObjectPropertyScope =
        outs > 0 ? kAudioObjectPropertyScopeOutput : kAudioObjectPropertyScopeInput
      return Device(
        id: id,
        uid: stringProperty(id, kAudioDevicePropertyDeviceUID) ?? "",
        name: stringProperty(id, kAudioObjectPropertyName) ?? "(unnamed)",
        transport: transportName(id),
        inputChannels: ins,
        outputChannels: outs,
        volume: volume(id, scope: scope),
        muted: muted(id, scope: scope),
        isDefaultInput: id == defaultIn,
        isDefaultOutput: id == defaultOut)
    }
  }

  /// Resolved by UID, never by name. Names are not unique — two identical pairs
  /// of AirPods produce two identical strings — and they are also the one field
  /// here that carries a person's name, so matching on them is both ambiguous
  /// and the thing `docs/sound.md` redacts.
  static func device(uid: String) -> Device? {
    all().first { $0.uid == uid }
  }

  // ─── writes ───────────────────────────────────────────────────────────────
  // Everything below sits behind `allowWrites`. None of it needs a TCC grant,
  // and none of it can reach the microphone: that is `SoundCapture`, behind its
  // own gate.

  enum SoundError: Error, CustomStringConvertible {
    case noSuchDevice(String)
    case notSettable(String)
    case failed(String, OSStatus)

    var description: String {
      switch self {
      case .noSuchDevice(let uid): return "No audio device with uid '\(uid)' on this Mac."
      case .notSettable(let what): return "\(what) is not settable on this device."
      case .failed(let what, let status): return "\(what) failed (OSStatus \(status))."
      }
    }
  }

  static func setDefaultDevice(uid: String, forInput: Bool) throws {
    guard let device = device(uid: uid) else { throw SoundError.noSuchDevice(uid) }
    if forInput, !device.canRecord {
      throw SoundError.notSettable("\(device.name) has no input channels, so it")
    }
    if !forInput, !device.canPlay {
      throw SoundError.notSettable("\(device.name) has no output channels, so it")
    }
    var addr = address(
      forInput
        ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice)
    var id = device.id
    let status = AudioObjectSetPropertyData(
      system, &addr, 0, nil, UInt32(MemoryLayout<AudioObjectID>.size), &id)
    guard status == noErr else { throw SoundError.failed("Switching the default device", status) }
  }

  static func setVolume(_ level: Float, uid: String?) throws {
    let device = try resolveOutput(uid)
    let clamped = min(max(level, 0), 1)
    var wrote = false
    for element: AudioObjectPropertyElement in [kAudioObjectPropertyElementMain, 1, 2] {
      var addr = address(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeOutput, element)
      guard AudioObjectHasProperty(device.id, &addr) else { continue }
      var settable: DarwinBoolean = false
      guard AudioObjectIsPropertySettable(device.id, &addr, &settable) == noErr, settable.boolValue
      else { continue }
      var value = clamped
      let status = AudioObjectSetPropertyData(
        device.id, &addr, 0, nil, UInt32(MemoryLayout<Float32>.size), &value)
      if status == noErr { wrote = true }
    }
    // Per-channel devices need every channel written, so "did any succeed" is
    // the honest test rather than the first one's status.
    guard wrote else {
      throw SoundError.notSettable("Volume on \(device.name)")
    }
  }

  static func setMuted(_ muted: Bool, uid: String?) throws {
    let device = try resolveOutput(uid)
    var addr = address(kAudioDevicePropertyMute, kAudioObjectPropertyScopeOutput)
    guard AudioObjectHasProperty(device.id, &addr) else {
      throw SoundError.notSettable("Mute on \(device.name)")
    }
    var settable: DarwinBoolean = false
    guard AudioObjectIsPropertySettable(device.id, &addr, &settable) == noErr, settable.boolValue
    else { throw SoundError.notSettable("Mute on \(device.name)") }
    var value: UInt32 = muted ? 1 : 0
    let status = AudioObjectSetPropertyData(
      device.id, &addr, 0, nil, UInt32(MemoryLayout<UInt32>.size), &value)
    guard status == noErr else { throw SoundError.failed("Muting \(device.name)", status) }
  }

  private static func resolveOutput(_ uid: String?) throws -> Device {
    if let uid {
      guard let device = device(uid: uid) else { throw SoundError.noSuchDevice(uid) }
      return device
    }
    guard let device = all().first(where: \.isDefaultOutput) else {
      throw SoundError.noSuchDevice("default output")
    }
    return device
  }
}
