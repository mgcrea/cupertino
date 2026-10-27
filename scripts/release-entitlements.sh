#!/usr/bin/env bash
# Check the Developer ID provisioning profile a release is signed with, and
# write the app's entitlements expanded for it.
#
# Why there is a profile at all: Shell's seal key lives in the data protection
# keychain, under a keychain access group, so that no other program can plant
# or replace it (ShellSeal.swift says how the login keychain allowed exactly
# that). On macOS a keychain access group is a restricted entitlement: AMFI
# kills at launch an app that claims one with no embedded profile authorising
# it. Xcode embeds one for Debug; `make sign` signs the release by hand, so it
# embeds this one and signs with entitlements whose identifiers are spelled
# out, because codesign does not expand `$(AppIdentifierPrefix)`.
#
# Everything here fails loudly. Each failure would otherwise be a build that
# dies at launch on every user's Mac, or one that runs but can never seal and
# so never turns Shell on, and neither would show before it shipped:
#
#   * no profile, or a file that is not a signed profile
#   * a profile for another team, or another application identifier
#   * a development profile (it lists devices) rather than a Developer ID one
#   * a profile past its expiry date
#   * a profile that does not authorise the app's keychain access group
#   * a profile that does not name the certificate signing this build
#   * an entitlements file left with a variable unexpanded
#
# Usage: scripts/release-entitlements.sh <profile> <team-id> <bundle-id> \
#          <entitlements-in> <entitlements-out> [signing-identity-sha1]
set -euo pipefail

PROFILE="${1:-}"
TEAM="${2:?usage: release-entitlements.sh <profile> <team-id> <bundle-id> <in> <out> [sha1]}"
BUNDLE_ID="${3:?bundle id}"
IN="${4:?entitlements in}"
OUT="${5:?entitlements out}"
IDENTITY="${6:-}"
fail() { echo "  FAIL  $*" >&2; exit 1; }

[ -n "$PROFILE" ] || fail "PROVISIONING_PROFILE is not set. A release needs the Developer ID" \
  "profile for $BUNDLE_ID: see docs/distribution.md, 'The provisioning profile'."
[ -f "$PROFILE" ] || fail "no provisioning profile at $PROFILE"

decoded="$(mktemp "${TMPDIR:-/tmp}/cupertino-profile.XXXXXX")"
trap 'rm -f "$decoded"' EXIT
security cms -D -i "$PROFILE" > "$decoded" 2>/dev/null \
  || fail "$PROFILE is not a signed provisioning profile"

value() { plutil -extract "$1" raw -o - "$decoded" 2>/dev/null || true; }
entitlement() { /usr/libexec/PlistBuddy -c "Print :Entitlements:$1" "$decoded" 2>/dev/null || true; }

team="$(value TeamIdentifier.0)"
[ "$team" = "$TEAM" ] || fail "the profile is for team '$team', not $TEAM"

prefix="$(value ApplicationIdentifierPrefix.0)"
appid="$(entitlement com.apple.application-identifier)"
[ -n "$prefix" ] && [ "$appid" = "$prefix.$BUNDLE_ID" ] \
  || fail "the profile is for '$appid', not <prefix>.$BUNDLE_ID"

[ "$(value ProvisionsAllDevices)" = "true" ] \
  || fail "the profile lists devices: a development profile, not a Developer ID one"

expires="$(value ExpirationDate)"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -z "$expires" ] || ! expr "$expires" \> "$now" >/dev/null; then
  fail "the profile expired on $expires"
fi

group="$prefix.$BUNDLE_ID"
allowed="$(entitlement keychain-access-groups:0)"
[ "$allowed" = "$prefix.*" ] || [ "$allowed" = "$group" ] \
  || fail "the profile does not authorise keychain access group $group (it allows '$allowed')"

if [ -n "$IDENTITY" ]; then
  want="$(printf '%s' "$IDENTITY" | tr '[:upper:]' '[:lower:]')"
  count="$(value DeveloperCertificates)"
  found=""
  i=0
  while [ "$i" -lt "${count:-0}" ]; do
    sha="$(value "DeveloperCertificates.$i" | base64 --decode | shasum -a 1 | cut -d' ' -f1)"
    [ "$sha" = "$want" ] && found=1
    i=$((i + 1))
  done
  [ -n "$found" ] || fail "the profile does not name the certificate signing this build ($IDENTITY)"
fi

# Single-quoted patterns with the prefix spliced in: a literal `$(` for sed on
# both BSD and GNU, never a shell expansion.
# shellcheck disable=SC2016
sed -e 's/\$(AppIdentifierPrefix)/'"$prefix"'./g' \
  -e 's/\$(PRODUCT_BUNDLE_IDENTIFIER)/'"$BUNDLE_ID"'/g' "$IN" > "$OUT"
# shellcheck disable=SC2016
if grep -q '\$(' "$OUT"; then fail "$OUT still has an unexpanded variable"; fi
/usr/libexec/PlistBuddy \
  -c "Add :com.apple.application-identifier string $appid" \
  -c "Add :com.apple.developer.team-identifier string $team" "$OUT" >/dev/null
plutil -lint -s "$OUT" || fail "$OUT is not a valid plist"
echo "  ok    profile for $appid, team $team, until $expires"
