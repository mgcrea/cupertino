#!/bin/sh
# Assemble, sign and drive the Cupertino TCC spike.
#
#   ./build.sh          build + sign the bundle, print the grant instructions
#   ./build.sh run      launch it through LaunchServices and tail the log
#   ./build.sh reset    revoke its TCC grants so the next run starts clean
#
# Deliberately NOT an Xcode project: no sandbox, no hardened runtime, no
# generated build settings — the only variable under test is whether a signed
# .app's TCC identity covers the processes it spawns.

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
</dict>
</plist>
PLIST

# Sign last: any change to bundle contents invalidates the signature, and TCC
# keys on the signature. A real Developer ID cert is not needed to answer the
# question — Apple Development, or ad-hoc, gives a usable local identity.
ident=$(security find-identity -v -p codesigning | awk '/Apple Development/ {print $2; exit}')
if [ -n "$ident" ]; then
  echo "sign:  Apple Development ($ident)"
  codesign --force --sign "$ident" --identifier "$bundle_id" --timestamp=none "$app"
else
  echo "sign:  ad-hoc (no Apple Development identity found)"
  codesign --force --sign - --identifier "$bundle_id" "$app"
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

The two columns disagreeing is itself the finding: `trusted` is a claim about an
identity and `uiRead` is the thing the composer actually does.

TXT
