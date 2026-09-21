import AppKit

/// The sounds the on-screen notice can make, and the playing of them.
///
/// **The Mac's own alert sounds, played quietly.** They ship with every Mac, so
/// there is nothing to bundle and nothing to license, and somebody who already
/// knows what Sosumi means gets to keep knowing. They play at the volume set in
/// Settings, a third of full by default and relative to the Mac's own output,
/// where an alert sound reads as a cue under what you are doing rather than as
/// an alert.
///
/// The list is READ from the system folder rather than written out here, so it
/// is whatever this macOS has rather than whatever the last macOS had. The
/// fallback covers a folder that cannot be listed, which is the sandboxed case
/// and not a hypothetical: the list going empty would silently leave a picker
/// with nothing but None in it, and no reason visible for why.
///
/// Separate from `NoticeStyle`, which holds what somebody chose, because this
/// needs AppKit and that is pinned by `make unit`.
///
/// Nothing here is the `sound` SURFACE. That records a microphone;
/// this plays fourteen files that come with the operating system.
@MainActor
enum NoticeSounds {
  private static let folder = URL(filePath: "/System/Library/Sounds", directoryHint: .isDirectory)

  /// macOS 26's set, which is also macOS 13's. Only reached when the folder
  /// cannot be listed.
  private static let fallbackNames = [
    "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr",
    "Sosumi", "Submarine", "Tink",
  ]

  /// Every sound that can be picked, by name, alphabetically.
  static let names: [String] = {
    let files =
      (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil))
      ?? []
    let listed =
      files
      .filter { $0.pathExtension == "aiff" }
      .map { $0.deletingPathExtension().lastPathComponent }
    return listed.isEmpty ? fallbackNames : listed.sorted()
  }()

  /// Held rather than made per play, for two reasons. An `NSSound` that nothing
  /// retains can be collected mid-playback, which is silence that comes and
  /// goes with the allocator. And `stop()` below can only restart a sound this
  /// side still has a handle on.
  private static var cache: [String: NSSound] = [:]

  /// Play a sound by name, silently doing nothing for an empty name or one this
  /// Mac does not have.
  ///
  /// An empty name is the "None" row in the picker rather than a mistake, which
  /// is why it is not worth a log line. A name that resolves to nothing is the
  /// same outcome — see `NoticeStyle.read` on why stored names are not
  /// validated.
  static func play(_ name: String, volume: Double) {
    guard let sound = sound(named: name) else { return }
    // Two cards in quick succession restart the sound rather than stacking two
    // copies of one file over each other.
    if sound.isPlaying { sound.stop() }
    sound.volume = Float(min(1, max(0, volume)))
    sound.play()
  }

  private static func sound(named name: String) -> NSSound? {
    guard !name.isEmpty else { return nil }
    if let cached = cache[name] { return cached }
    guard let sound = NSSound(named: NSSound.Name(name)) else { return nil }
    cache[name] = sound
    return sound
  }
}
