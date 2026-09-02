#!/bin/sh
# Assemble, sign and drive the Cupertino TCC spike.
#
#   ./build.sh          build + sign the bundle, print the grant instructions
#   ./build.sh run      launch it through LaunchServices and tail the log
#   ./build.sh reset    revoke its TCC grants so the next run starts clean
#
# Deliberately NOT an Xcode project: no sandbox, no generated build settings —
# the only variable under test is whether a signed .app's TCC identity covers
# the processes it spawns.
#
# It DOES sign hardened, with the app's own entitlements, and that is not a
# detail. It used to sign plain, on the grounds that the hardened runtime was
# not what was being measured. It was: the runtime gates resource access as
# well as code, and lane 2d's microphone result was a grant the shipping app
# could not reach, because Cupertino.entitlements had no
# `com.apple.security.device.audio-input` and the consent dialog therefore
# never appeared. A spike signed unlike the app measures a different app.

set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
build="$here/build"
app="$build/Cupertino Spike.app"

# NOT io.mgcrea.cupertino. TCC grants are keyed to the bundle identifier, and
# docs/distribution.md is explicit that the real one is the most expensive
# string in the project — burning it on a throwaway leaves a stale grant behind.
bundle_id="io.mgcrea.cupertino-spike"
log="$HOME/Library/Logs/cupertino-spike.log"

case "${1:-build}" in
run)
  echo "launching $app"
  open -a "$app"
  echo "tailing $log — ^C to stop"
  sleep 2
  tail -n 60 "$log"
  exit 0
  ;;
reset)
  tccutil reset SystemPolicyAllFiles "$bundle_id" || true
  tccutil reset AppleEvents "$bundle_id" || true
  tccutil reset Accessibility "$bundle_id" || true
  tccutil reset ScreenCapture "$bundle_id" || true
  tccutil reset Microphone "$bundle_id" || true
  echo "TCC grants for $bundle_id revoked."
  exit 0
  ;;
build) ;;
*)
  echo "usage: $0 [build|run|reset]" >&2
  exit 2
  ;;
esac

node_bin=$(command -v node || true)
[ -n "$node_bin" ] || { echo "no node on PATH" >&2; exit 1; }
echo "node:  $node_bin"

rm -rf "$build"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

cc -Wall -Wextra -Werror -O2 \
  -arch arm64 -arch x86_64 \
  -DLOG_PATH="\"$log\"" \
  -o "$app/Contents/MacOS/cupertino-spike" \
  "$here/spike-main.c"

# The screen probe has to run as a CHILD of the bundle to be attributed to it,
# and ScreenCaptureKit is unreachable from node — so it is compiled in rather
# than invoked through the toolchain, which a Finder-launched app cannot find.
# Native arch only: this measures TCC attribution, not portability.
echo "swift: $here/../probe-screen.swift"
swiftc -O -o "$app/Contents/Resources/probe-screen" "$here/../probe-screen.swift"

# Same reasoning for the microphone: CoreAudio, AVFoundation and Speech are all
# unreachable from node, and the grant has to land on the bundle rather than on
# whatever launched the toolchain.
echo "swift: $here/../probe-sound.swift"
swiftc -O -o "$app/Contents/Resources/probe-sound" "$here/../probe-sound.swift"

sed -e "s#@NODE@#$node_bin#g" -e "s#@REPO@#$repo#g" \
  "$here/spike.sh.in" > "$app/Contents/Resources/spike.sh"
chmod +x "$app/Contents/Resources/spike.sh"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>cupertino-spike</string>
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>CFBundleName</key><string>Cupertino Spike</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>Cupertino Spike is checking whether an app can read Mail and Notes on behalf of the MCP servers it hosts.</string>
  <!-- MANDATORY, and unlike every other grant in this spike its absence is not
       a denial: macOS TERMINATES a process that touches the microphone with no
       usage description. Screen Recording needs no such string, which is why
       this is the first lane to need one and the first that would otherwise
       look like a crash rather than a permission result. -->
  <key>NSMicrophoneUsageDescription</key>
  <string>Cupertino Spike is checking whether an app can record from the microphone on behalf of the MCP servers it hosts.</string>
</dict>
</plist>
PLIST

# Sign last: any change to bundle contents invalidates the signature, and TCC
# keys on the signature. A real Developer ID cert is not needed to answer the
# question — Apple Development, or ad-hoc, gives a usable local identity.
#
# `--options runtime --entitlements` matches how the app ships. See the header:
# without them the microphone lane measures a prompt that the real app never
# gets.
ents="$repo/apps/apple/Cupertino.entitlements"
ident=$(security find-identity -v -p codesigning | awk '/Apple Development/ {print $2; exit}')
if [ -n "$ident" ]; then
  echo "sign:  Apple Development ($ident), hardened, $ents"
  codesign --force --sign "$ident" --identifier "$bundle_id" \
    --options runtime --entitlements "$ents" --timestamp=none "$app"
else
  echo "sign:  ad-hoc (no Apple Development identity found), hardened, $ents"
  codesign --force --sign - --identifier "$bundle_id" \
    --options runtime --entitlements "$ents" "$app"
fi
codesign -dv "$app" 2>&1 | sed 's/^/       /'

cat <<TXT

Built: $app

Next, by hand — Full Disk Access never prompts, it has to be granted:

  1. Open Full Disk Access:
       open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"
  2. Drag "Cupertino Spike.app" from $build into the list, and switch it on.
  2b. Same again in Accessibility, which is a separate grant and the one the
      Mail composer needs:
       open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility"
  2c. And again in Screen Recording, which is a THIRD separate grant:
       open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture"
  3. Make sure Mail (and Notes) are running — the Apple Events lane skips
     apps that are not, exactly as the real client does.
  4. $0 run

Read the result as two independent answers:

  half1 ... YES   the app itself holds Full Disk Access
  file lane rc=0  a node CHILD inherited it  <- the one that matters
  apple events    a prompt naming "Cupertino Spike" means Automation landed on
                  the app rather than on Terminal

If the file lane says rc=3 while half1 says YES, children do NOT inherit and
the app-hosted design is wrong — fall back to keeping launcher.c as a helper.

The accessibility lane answers a DIFFERENT question and must be read on its
own. Grant Accessibility to the spike, relaunch it, and compare:

  trusted: granted + uiRead: granted   the grant reaches a grandchild
  trusted: denied  + uiRead: denied    it does not — and the composer design
                                       needs a route that does not depend on it

The two columns disagreeing is itself the finding: \`trusted\` is a claim about an
identity and \`uiRead\` is the thing the composer actually does.

The screen lane answers a THIRD question and inherits nothing from the other
two. This spike measured FDA and Apple Events, the codebase generalised that to
every TCC service, and it was wrong for Accessibility — so Screen Recording is
measured here rather than assumed. Compare the same binary run two ways:

  swift ../probe-screen.swift        responsible = your terminal
  ./build.sh run                     responsible = "Cupertino Spike.app"

  flag granted + SCShareableContent ok      the grant reaches a child
  flag granted + SCShareableContent DENIED  the four-grants state — tccutil
                                            reset ScreenCapture, never re-grant

A GO from that lane is still provisional: it cannot tell a target window from
the window occluding it. Open the PNGs it writes before believing it.

The microphone lane is the FOURTH question, and it is the only one you do not
have to grant in advance: the microphone PROMPTS. Launch the spike and a dialog
should appear naming "Cupertino Spike" — that dialog IS the finding, because it
means the grant is landing on the bundle and not on your editor. Measured from
an agent shell, the ancestry reads:

  swift-frontend <- zsh <- claude <- Code Helper (Plugin) <- Code

so a "denied" seen there is Visual Studio Code's answer, not Cupertino's, and
says nothing about whether this design works.

  authorizationStatus authorized + non-silent yes   the grant reaches a child
  authorizationStatus authorized + non-silent NO    green flag over a dead
                                                    device — check it is not
                                                    muted or held by another app
  killed with no output                             NSMicrophoneUsageDescription
                                                    is missing from Info.plist;
                                                    macOS terminates rather than
                                                    denies, and this is the only
                                                    lane where that happens

Speak while it runs, or the peak level is a fact about a quiet room rather than
about the lane.

TXT
