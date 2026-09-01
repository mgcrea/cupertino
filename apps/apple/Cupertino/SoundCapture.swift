import AVFoundation
import Foundation

/// Recording from the microphone, behind `allowRecording` and nothing else.
///
/// Split from `SoundDevices` on the permission line: everything there needs no
/// grant at all, everything here needs `kTCCServiceMicrophone`. Keeping them in
/// one file would make it easy to reach the second while meaning the first.
///
/// ## This is the first stateful thing in the project
///
/// Every other tool is request/response. A recording outlives the call that
/// started it, which is only possible because a swift-hosted surface is served
/// in-process by a host that does not respawn between requests. Three
/// consequences, and all three are load-bearing:
///
/// - `status()` reads the live recorder rather than a cached struct, so a
///   recording that died on its own is reported as stopped rather than as
///   still running.
/// - `start` REFUSES when one is already running. Opening a second recorder
///   would leave the first orphaned and its file unfinalised — the audio
///   analogue of the stranded screenshot instance that strands a bundle id.
/// - `finishForTermination()` must run when the app quits. See below; this is
///   the difference between a file and nothing.
///
/// ## CAF, never m4a, and it is not a style preference
///
/// Measured in `docs/sound.md`: the same AAC codec in the two containers
/// produces byte-identical output, and then
///
///     afinfo trunc-out.m4a  ->  Fail: AudioFileOpenURL failed
///     afinfo trunc-out.caf  ->  estimated duration: 3.503991 sec
///
/// An MPEG-4 writes its `moov` atom on close, so a recording interrupted by the
/// app dying cannot be opened AT ALL — not a short file, no file. A CAF opens
/// with its header intact and only fails at the missing tail. For a tool whose
/// whole point is "record the meeting", that is the difference between losing an
/// hour and losing the last few seconds, and it costs nothing.
///
/// ## Nothing here is invisible
///
/// macOS shows a non-suppressible orange indicator naming Cupertino for as long
/// as the microphone is live, and the copy must never imply otherwise. Routing
/// this through QuickTime would have made that indicator say *QuickTime* —
/// borrowed visibility that hides the agent behind an app the user never asked
/// to record. See `docs/sound.md`.
@MainActor
final class SoundCapture: NSObject {
  static let shared = SoundCapture()

  enum Failure: Error, CustomStringConvertible {
    case alreadyRecording(path: String)
    case notRecording
    case permissionDenied
    case noInputDevice
    case destinationRefused(String)
    case recorderRefused(String)

    var description: String {
      switch self {
      case .alreadyRecording(let path):
        return
          "A recording is already running, writing to \(path). Stop it before starting another."
      case .notRecording:
        return "Nothing is recording."
      case .permissionDenied:
        return
          "Microphone access is denied. Grant it in System Settings › Privacy & Security › "
          + "Microphone, for Cupertino."
      case .noInputDevice:
        return "No audio input device on this Mac."
      case .destinationRefused(let path):
        return "Refusing to write to \(path): recordings stay inside \(SoundCapture.root.path)."
      case .recorderRefused(let why):
        return "The recorder refused to start: \(why)"
      }
    }
  }

  struct Status {
    let recording: Bool
    let path: String?
    let seconds: Double
    let peakDBFS: Float
    let deviceUID: String?

    /// A capture whose peak never rose above this is reported as silent. The
    /// probe measured −19.1 dBFS speaking normally and −32.2 dBFS in a quiet
    /// room, so this sits below both: it separates "a dead or muted device"
    /// from "a quiet room", not speech from silence.
    static let silenceFloor: Float = -55

    var silent: Bool { peakDBFS <= Status.silenceFloor }
  }

  private var recorder: AVAudioRecorder?
  private var target: URL?
  private var deviceUID: String?
  /// Peak is sampled while running because `AVAudioRecorder` only reports the
  /// level at the instant it is asked. A single reading at `stop` would say
  /// whatever the last moment happened to be.
  private var peak: Float = -160
  private var meterTimer: Timer?

  // ─── destination ──────────────────────────────────────────────────────────

  /// Where recordings may be written. The same confinement `ScreenCapture` and
  /// the three `save_attachment` tools use: a root, and a caller may only
  /// SELECT inside it.
  nonisolated static var root: URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
  }

  private static func destination(in directory: URL?) throws -> URL {
    let base = root.resolvingSymlinksInPath()
    var dir = base
    if let directory {
      let asked = directory.resolvingSymlinksInPath()
      // Lexical containment after resolving, with a trailing separator on the
      // prefix so `/Downloads-evil` cannot pass as being inside `/Downloads`.
      guard asked.path == base.path || asked.path.hasPrefix(base.path + "/") else {
        throw Failure.destinationRefused(directory.path)
      }
      dir = asked
    }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

    let stamp = ISO8601DateFormatter()
    stamp.formatOptions = [.withYear, .withMonth, .withDay, .withTime]
    let leaf =
      "cupertino-sound-"
      + stamp.string(from: Date()).replacingOccurrences(of: ":", with: "") + ".caf"
    return dir.appendingPathComponent(leaf)
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  func start(deviceUID uid: String?, directory: URL?) throws -> String {
    if let recorder, recorder.isRecording {
      throw Failure.alreadyRecording(path: target?.path ?? "an unknown path")
    }

    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
      throw Failure.permissionDenied
    }

    // Selecting a device means making it the default input for the duration:
    // AVAudioRecorder records from the system default and offers no per-recorder
    // device selection. Stated plainly because it is a side effect a caller
    // would not expect from "record from this microphone".
    if let uid {
      guard let device = SoundDevices.device(uid: uid), device.canRecord else {
        throw Failure.noInputDevice
      }
      try? SoundDevices.setDefaultDevice(uid: uid, forInput: true)
    }

    let url = try SoundCapture.destination(in: directory)

    // AAC in a CAF container. `AVAudioRecorder` picks the container from the
    // file extension, so the `.caf` leaf above is not cosmetic.
    let settings: [String: Any] = [
      AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
      AVSampleRateKey: 44100.0,
      AVNumberOfChannelsKey: 1,
      AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
    ]

    let made: AVAudioRecorder
    do {
      made = try AVAudioRecorder(url: url, settings: settings)
    } catch {
      throw Failure.recorderRefused(error.localizedDescription)
    }
    made.isMeteringEnabled = true
    guard made.record() else {
      throw Failure.recorderRefused(
        "AVAudioRecorder.record() returned false. The grant may belong to a different copy of "
          + "this bundle.")
    }

    recorder = made
    target = url
    deviceUID = uid
    peak = -160
    let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.sampleMeter() }
    }
    RunLoop.main.add(timer, forMode: .common)
    meterTimer = timer

    return url.path
  }

  private func sampleMeter() {
    guard let recorder, recorder.isRecording else { return }
    recorder.updateMeters()
    peak = max(peak, recorder.peakPower(forChannel: 0))
  }

  struct Finished {
    let path: String
    let bytes: Int
    let seconds: Double
    let silent: Bool
    let peakDBFS: Float
  }

  @discardableResult
  func stop() throws -> Finished {
    guard let recorder, let url = target else { throw Failure.notRecording }
    sampleMeter()
    let seconds = recorder.currentTime
    // `stop()` is what finalises the container. Everything after this line is
    // reporting; everything before it is a file that does not exist yet.
    recorder.stop()
    meterTimer?.invalidate()
    meterTimer = nil
    self.recorder = nil
    self.target = nil
    self.deviceUID = nil

    let bytes =
      (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
    return Finished(
      path: url.path,
      bytes: bytes,
      seconds: seconds,
      silent: peak <= Status.silenceFloor,
      peakDBFS: peak)
  }

  func status() -> Status {
    // Read the recorder, never a cached flag: a recording that stopped on its
    // own — the device unplugged, the session interrupted — must report as
    // stopped rather than as still running.
    guard let recorder, recorder.isRecording else {
      return Status(recording: false, path: nil, seconds: 0, peakDBFS: peak, deviceUID: nil)
    }
    sampleMeter()
    return Status(
      recording: true,
      path: target?.path,
      seconds: recorder.currentTime,
      peakDBFS: peak,
      deviceUID: deviceUID)
  }

  /// Called from the app's termination handler. Without this a quit during a
  /// recording leaves an unfinalised file — and for the m4a container this
  /// project deliberately does NOT use, that would be a total loss rather than
  /// a truncated one. CAF survives it; finalising properly is still correct.
  func finishForTermination() {
    guard let recorder, recorder.isRecording else { return }
    recorder.stop()
    meterTimer?.invalidate()
    meterTimer = nil
  }
}
