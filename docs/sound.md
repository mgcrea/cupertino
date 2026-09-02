# Sound: what a `sound` surface would cost

Phase-0 probe for the proposed sound surface. Measured on **macOS 26.6 (Darwin 25.6.0), 2026-09-01**,
by [`scripts/probe-sound.swift`](../scripts/probe-sound.swift).

**Status: NOT BUILT, and deliberately no entry in `surfaces.json`.** One there would generate Swift, a
bridge allow-list, two Makefile regions, a CI handshake loop and a `smoke-swift` build for a server
that is not there — the same reason [passwords.md](passwords.md) and [home.md](home.md) stay out of the
manifest until their surface exists.

**Verdict: GO, both halves.** The free half needs no permission at all. The recording half was
measured through [`scripts/spike-app-tcc`](../scripts/spike-app-tcc/) — the grant lands on the bundle,
is inherited by a grandchild, survives a rebuild and re-sign, and a capture produces real audio at
**57 ms** of startup.

The split is still the finding, because it is what the design has to be built around: this surface is
two features wearing one name, and they have almost nothing in common. One needs no permission and the
other needs a TCC class the app has never held.

## The two halves

|        | Free half                                          | Recording half          |
| ------ | -------------------------------------------------- | ----------------------- |
| Tools  | devices, volume, mute, default-device, speak, play | start / stop / status   |
| Lane   | CoreAudio (+ `/usr/bin/say`, `afplay`)             | AVFoundation            |
| Grant  | **none**                                           | `kTCCServiceMicrophone` |
| Status | **GO**                                             | **GO**                  |

## The lane

The sixth lane, and like `screen` it is the "neither" row of [surfaces.md](surfaces.md)'s table: a
framework linked into the app. Apple Events is irrelevant and there is no file lane at all — this
surface reads hardware, not a store.

Node cannot reach any of it. `ServerLocator.environment` hands a server `PATH=/usr/bin:/bin` and `HOME`,
and while `/usr/sbin/system_profiler` **is** callable by absolute path under exactly that env (verified
with `env -i`), it is the slower, weaker answer:

```
CoreAudio enumeration                    42.5 ms      settable flags, per-device volume, UIDs
/usr/sbin/system_profiler -json          ~115 ms      names and rates, no settability, read-only
osascript -e 'get volume settings'       130 ms       one global volume, no devices
```

And **there is no `afrecord`**. `/usr/bin/af*` is `afclip afconvert afhash afida afinfo afktool afplay
afscexpand` — macOS ships a player, a converter and an inspector, and no recorder. So the recording
half has no shell lane at any price.

## Measured — the free half

| Question                                   | Answer                                          |
| ------------------------------------------ | ----------------------------------------------- |
| Devices enumerable with no grant?          | **Yes**, 4 devices in **42.5 ms**               |
| Default **output** device settable?        | **YES**                                         |
| Default **input** device settable?         | **YES**                                         |
| Default output volume readable / settable? | **Yes / YES** (0.56, matching `osascript`'s 56) |
| Mute settable?                             | **YES**                                         |
| Devices with no volume control at all      | **3 of 4**                                      |

### Switching the default device is the tool that justifies the lane

`AudioObjectIsPropertySettable` answers YES for both `kAudioHardwarePropertyDefaultOutputDevice` and
`…DefaultInputDevice`. Nothing was switched — the property was asked, not exercised, following
[maps.md](maps.md)'s standing correction that a declared `rw` is a claim and _"Nothing has been
pressed."_

This matters because it is the one capability with **no CLI and no AppleScript equivalent**. "Switch to
my headphones" is unreachable from `osascript`, from `system_profiler`, and from every binary in
`/usr/bin`. If the free half were node-hosted it would ship without it.

### Three of four devices have no volume control, and that is normal

Only the built-in speakers expose `kAudioDevicePropertyVolumeScalar`. The DisplayPort output, the
built-in microphone and the Continuity Capture input do not. This is a property of the hardware, not a
permission failure, so `get_volume` must report _"no volume control"_ per device rather than fail — the
same shape as the `degraded` fields the other surfaces already return.

The probe asks the main element and then channels 1 and 2, because a device can expose per-channel
volume with no master and reads as "no volume" if only the main element is asked.

## Measured — the microphone

Measured inside the spike bundle, where the responsible process is the app — `ancestry: sh <-
cupertino-spike`.

| Question                                         | Answer                                              |
| ------------------------------------------------ | --------------------------------------------------- |
| Does the grant land on the bundle?               | **Yes** — the prompt named "Cupertino Spike"        |
| Is it inherited by a grandchild?                 | **Yes** — `probe-sound` is app → `sh` → probe       |
| Does it survive a rebuild and re-sign?           | **Yes** — second run read `authorized`, no prompt   |
| Startup to `record()`                            | **57 ms**                                           |
| Capture produces non-silent bytes?               | **Yes** — −19.1 dBFS speaking, −32.2 dBFS quiet     |
| Size                                             | **73,579 B for 2.03 s** ≈ 36 KB/s ≈ **130 MB/hour** |
| Input devices discoverable **without** the grant | **2**                                               |

### Enumeration is not gated; samples are

`AVCaptureDevice.DiscoverySession` returned both input devices with their unique IDs while
`authorizationStatus` was `denied`. So **`list_devices` belongs in the ungated half** even though
recording does not, and two devices being discoverable means `start_recording` should take an optional
device argument rather than silently using the system default.

### The grant behaves exactly as the design needs

`notDetermined` on the first run, a consent dialog naming **"Cupertino Spike"**, then `authorized` —
and on a second run after `./build.sh` rebuilt and re-signed the bundle, still `authorized` with no
prompt. Same identifier-plus-certificate rule Full Disk Access and Screen Recording follow.

This had to be measured rather than inherited. `spike-app-tcc` measured grant inheritance for Full Disk
Access and Apple Events, the codebase generalised it to every TCC service, and **it was wrong for
Accessibility**. Screen Recording got its own lane for that reason; the microphone now has a fourth.

### An agent's shell cannot answer this, and it will confidently mislead you

Run from an agent shell the same probe reports `denied`. That is not Cupertino's answer — it is not
even `swift-frontend`'s. The ancestry says whose it is:

```
process     swift-frontend (pid 40307)
ancestry    timeout <- zsh <- claude <- Code Helper (Plugin) <- Code
```

TCC attributes the microphone to the responsible ancestor, so `denied` there describes **Visual Studio
Code**. The probe prints the chain beside the status for exactly this reason, and refuses to provoke
the prompt without `--force`: a grant given from a terminal belongs to the terminal, which is the
misattribution the whole project exists to avoid.

An earlier draft of the probe printed `ProcessInfo.processName` under the label "responsible process".
Those are different things, and conflating them reports a question the probe never asked.

### The trap the spike could not see: the hardened runtime

Everything above was measured in a bundle signed **without** `--options runtime`, and it is the one
place that mattered. The shipping app is hardened, and the hardened runtime gates resource access as
well as code — so the microphone needs `com.apple.security.device.audio-input` in
`apps/apple/Cupertino.entitlements`, exactly the way Apple Events needs
`com.apple.security.automation.apple-events`. 1.9.0 shipped without it.

Measured on macOS 26.6, two Developer ID bundles signed `--options runtime`, identical but for that
one key:

| Bundle             | `before`        | `requestAccess`        | `after`      |
| ------------------ | --------------- | ---------------------- | ------------ |
| no `audio-input`   | `notDetermined` | **`false`**, no dialog | `denied`     |
| with `audio-input` | `notDetermined` | `true`                 | `authorized` |

The failure is not a denial, it is a **refusal to ask** — the same shape the Apple Events entitlement
comment records, where macOS declines to prompt for an app that never declared it sends events.

Three consequences, all measured:

- **No dialog ever appears.** `requestAccess` returns `false` in well under a second, so the "Ask…"
  button reads as a button that does nothing.
- **The refusal writes no TCC row.** A second run reads `notDetermined` again, and Cupertino never
  appears in Privacy & Security › Microphone. That pane has **no "+" button** — unlike Full Disk
  Access, Screen Recording and Accessibility — so `openMicrophoneSettings()` opens a window with
  nothing in it to switch on. This was the user-visible bug: "Allow" opens the pane and you cannot add
  the app there.
- **Re-signing with the key is the whole fix.** The next launch prompts and grants, with no
  `tccutil reset` — the one good consequence of a denial that was never recorded.

`scripts/spike-app-tcc/build.sh` now signs hardened with the app's own entitlements, so a lane that
passes describes the app that ships. A spike signed unlike the app measures a different app.

### Two traps worth keeping

**A missing usage description is fatal, not a denial.** macOS **terminates** a process that touches the
microphone with no `NSMicrophoneUsageDescription`. Every other grant in this project denies and lets
you carry on; this one kills. A lane that returns a signal-kill with no output has a plist problem, not
a permission problem — and Screen Recording needs no such string, so this is the first lane where it
matters.

**Do not time across the consent prompt.** The first run of this lane reported a startup of
**48,542 ms**, which was a human reading a dialog. The probe now awaits
`AVCaptureDevice.requestAccess` explicitly outside the timed section, and the real number is 57 ms —
three orders of magnitude apart, and the wrong one looks plausible enough to ship in a doc.

## Measured — transcription

| Question                       | Answer                                                               |
| ------------------------------ | -------------------------------------------------------------------- |
| `SpeechTranscriber` available? | **Yes**, `@available(macOS 26.0)`; deployment target is already 26.0 |
| Asset installed?               | **No** — `AssetInventory.status` is `.supported`                     |
| Supported locales              | **30**                                                               |

The model is not installed, so a first `transcribe` call downloads one. That is a product fact: the tool
has to report the state rather than appear to hang, the same reasoning that makes `indexAgeSeconds` part
of a result rather than a footnote.

Note the probe's locale came back as `en_US@rg=frzzzz` — a US-English UI with French regional settings.
Phase 2 needs an explicit locale argument and a clear refusal, not a silent fallback to English.

## What happens when a recording stops

Nothing, deliberately. `stop_recording` returns a path and no side effect — the same shape
[screen.md](screen.md) settled on, whose capture tool returns `{path, bytes, width, height, surface}`
and contains no `NSWorkspace` call at all. Opening the file would steal focus and would fire on every
call in a chain, and the caller never asked for it. Discoverability belongs in Cupertino's own UI, next
to the recording indicator, not in a tool's side effects.

What the result must carry beyond the path is **whether the recording is silent**. The peak meter is
already sampled while capturing, and the difference between "40 minutes at /Users/…/x.caf" and the same
plus `silent: true` is the difference between handing back a dead file and saying so. Measured
reference points: **−19.1 dBFS** speaking normally, **−32.2 dBFS** in a quiet room, so the threshold
needs choosing rather than guessing.

### Record to CAF, never m4a

Same AAC codec, byte-identical output, and one of them survives the app dying mid-recording. Measured
by truncating both containers at 50%, which is what a killed process leaves behind:

```
$ afconvert -f m4af -d aac t.aiff out.m4a   ->  19658 bytes
$ afconvert -f caff -d aac t.aiff out.caf   ->  19658 bytes    identical

$ afinfo trunc-out.m4a
Fail: AudioFileOpenURL failed                     <- will not open. nothing.
$ afinfo trunc-out.caf
estimated duration: 3.503991 sec                  <- opens, header intact
audio bytes: 15562
```

An unfinalised MPEG-4 is not a short recording, it is **no** recording: the `moov` atom is written on
close, so a truncated m4a cannot be opened at all. The CAF opens with correct format and duration and
only fails decoding at the missing tail, so a partial read is possible. For a tool whose motivating
case is "record the meeting" that is the difference between losing an hour and losing a few seconds,
and it costs nothing.

Two consequences for the implementation: the container is CAF, and `stop()` must run on app termination
so the file is finalised rather than abandoned.

## The QuickTime lane: complete, and rejected on architecture

Worth recording because it was measured in full and because it is the fallback if the microphone grant
ever proves unobtainable.

[surfaces.md](surfaces.md) calls QuickTime _"trivially scriptable and low value"_, which reads as
_scriptable but not worth it_. For this job the dictionary is trivially scriptable **and complete**:

```
$ sdef "/System/Applications/QuickTime Player.app"      # 12,100 bytes
rw  current microphone           -> audio recording device   (cocoa: AVCaptureDevice)
rw  current audio compression    -> audio compression preset
r   audio recording devices      (name, id)
    new audio recording          -> result: document
    start / pause / resume / stop
    export in <file> using settings preset <text>
r   duration, data size, data rate
```

It can pick a microphone, record, and save — and it costs Cupertino **no microphone grant**, because
QuickTime holds `kTCCServiceMicrophone` and Cupertino would need only Automation to
`com.apple.QuickTimePlayerX`.

One trap, recorded so nobody re-derives it: `sdef` prints only two suites, Internet and QuickTime
Player, with **no Standard Suite** — there is no `save`, `close`, `quit` or `open` in the dictionary.
All four nonetheless compile, because Cocoa registers the Standard Suite at runtime whether or not the
sdef declares it:

```
$ osacompile -o /dev/null -e 'tell application "QuickTime Player" to save document 1'   # OK
```

So the save path is real but undocumented, and whether `save` on a _live recording document_ persists
or raises a UI sheet was never measured — that was the lane's remaining risk.

**Rejected because a capability cannot script an app.** `generate-surfaces.mjs` enforces it:

```js
} else if (s.kind === "capability") {
  if (s.usesAppleEvents) {
    problems.push(`${at}: a capability has no app to send an Apple Event to`);
  }
```

The rule is right. The Apple Events consent string is generated from `displayName`, so a capability
called Sound would appear in a prompt about controlling Apple apps while naming no app at all — the
inverse of the generator's own stated rule that _"A consent prompt that lists an app this code never
talks to is asking for a permission it does not need."_

Rejected as this surface's lane, not as a lane.

## What it would cost to build

- `storePermission` needs a fourth value, `"microphone"`. **Two ends must change together**: the
  validator list, and the Swift emitter — which is a silent fallthrough,
  `s.storePermission === "contacts" ? "contacts" : "fullDiskAccess"`. Adding a value to the validator
  alone generates `.fullDiskAccess`, a surface claiming a grant it does not need, with a green build.
- `INFOPLIST_KEY_NSMicrophoneUsageDescription`, which makes the app claim microphone access in its
  metadata for **every** user, including everyone who never enables the surface.
- A `MicrophoneStatus` in `Permissions.swift` — four states, the first status enum in this project
  richer than `DiskAccessStatus`'s three.
- `SoundDevices.swift`, `SoundCapture.swift`, `SoundServer.swift`, and an extension to `smoke-swift`,
  which currently names the `screen` sources by hand.
- Icon: `/System/Library/ExtensionKit/Extensions/Sound.appex` declares
  `ISTypeIdentifier = com.apple.graphic-icon.sound`, exactly parallel to the `DisplaysExt.appex` that
  `screen` already points at. Symbol fallback `speaker.wave.2`.

`supportsWrites` should be **true**, unlike `screen` — volume, mute, speak and play are mutations that
are not recording, and they must be reachable without ever enabling the microphone. Recording sits
behind its own gate, `allowRecording`, following the `allowCodes` precedent that a change of tier gets
_"its own switch rather than `allowWrites`"_.

## Still open

- **Periodic re-consent.** Sequoia introduced a recurring prompt for some services. Two runs across one
  afternoon prove persistence across a re-sign, not across a month. If the microphone nags, that is a
  product fact the Permissions pane has to state rather than a surprise — the same question
  [screen.md](screen.md) leaves open for Screen Recording.
- **Format and size.** The probe's 36 KB/s is AAC mono 44.1 kHz at `AVAudioQuality.medium`, which it
  chose arbitrarily; ~130 MB/hour is too much for a tool whose motivating case is "record the meeting".
  The shipping default should be measured, not inherited from this probe.
- **A device disappearing mid-capture** — unplugging headphones, a Continuity device walking out of the
  room. Unmeasured, and it decides what `stop_recording` returns when there is nothing left to stop.
- **Recording is stateful, and would be the first such tool here.** `start`/`stop` outlives a tool call,
  so `recording_status` must read the live recorder rather than cache, and `start` must refuse when one
  is already running instead of opening a second. The failure mode to design against is the orphaned
  recording — the audio analogue of the stranded `-ScreenshotMode` instance that fails `make smoke`.
- **System-audio capture** is available and deliberately not proposed. `AudioHardwareCreateProcessTap`
  (`API_AVAILABLE(macos 14.2)`) records what the speakers play, including the other side of a call —
  a person who consented to nothing. Strictly worse than the microphone and its own decision, the same
  way `screen` withholds display capture.
