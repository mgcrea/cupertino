# Security

Cupertino is a signed, notarized, self-updating macOS app that holds Full Disk Access on your
behalf, and a set of MCP servers that read your mail, messages, notes and calendars. That makes a
vulnerability report the most valuable message this project can receive, and it deserves a channel
that is written down.

## Reporting

Email **security@mgcrea.io**. If the report concerns the update channel or the signing identity,
say so in the subject line — those are the two keys [docs/succession.md](docs/succession.md) is
written around, and a report about either is read first.

Please do not open a public issue for something exploitable before it is fixed: the app updates
through Sparkle, and a fix reaches every user faster than a thread does. Everything else — a
hardening suggestion, a question about what the audit script actually asserts — is welcome as an
issue.

You will get an acknowledgement within three working days and a fix, or a reason there is not
going to be one, within thirty. Credit in the CHANGELOG is the default; say if you would rather not.

## What is in scope

- The app: the bridge socket, the licence check, the audit log, the updater, the entitlements, and
  anything that reads or writes outside `~/Library/Application Support/io.mgcrea.cupertino`.
- The surfaces the app serves in-process — Screen, Sound, Desktop and Simulator — and the switches
  that bound them: a capture or a driven application outside the Apple apps Cupertino brokers,
  with "any application" off, is a vulnerability.
- The servers: the write gates, the `confirm` arguments, the one-time-code gates, path confinement
  on attachment saves, and any way for one server to reach data a different permission gates.
- The Safari extension in `apps/apple/CupertinoSafariExtension`, and what it lets a page reach.
- The licence API in `apps/api`: the Stripe webhook's signature check, and the `/thanks` and
  `/license/resend` routes.

## What the project already asserts

`scripts/audit-network.sh` runs against every built bundle and fails if the app can reach the
network, if the entitlement set is anything but the two measured keys, or if the update feed's
public key is missing. `make unit` proves what a recorded call can carry, and
`make audit-log-check` that a failed write cannot break the audit chain. The full list is in
`.github/workflows/ci.yml`, and every check there is one that rotted when it lived only in a
README.

## Supported versions

The current 1.x release on the appcast. A fix ships as a new release, not as a patch to an old one;
older builds keep working — a licence key never expires — but they do not receive fixes.
