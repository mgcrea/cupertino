# Succession

What happens to `io.mgcrea.cupertino` if this is sold, abandoned or handed on.

## Why this document exists

The bundle identifier is the most expensive string in the project.
[distribution.md](distribution.md) records the obvious half: changing it is a new TCC identity, so
every user re-grants Full Disk Access. The dangerous half is the other one — **keeping** it lets a
new owner inherit every existing user's grant silently, on an ordinary update, with no prompt and no
second look.

That is not hypothetical. It is the Bartender mechanism, described in
[licensing.md](licensing.md#trust-is-auditability-not-the-licence): sensitive macOS permissions,
a quiet change of hands in 2024, and a user base that had already been transferred by the time it
noticed. Closed source was not what killed it. Unverifiable ownership was.

Cupertino has the same risk profile against a larger grant. So the commitments below are made in
advance, while there is nothing to gain from making them, and they are incorporated into the
[EULA](../apps/apple/EULA) by reference so that they are owed to licensees rather than merely
published.

## The commitments

### 1. A change of ownership breaks the grant, on purpose

If the project is sold, transferred or otherwise continued by anyone other than the current
copyright holder, **the acquirer ships under a new bundle identifier**. Every user re-grants Full
Disk Access, consciously, to the new owner, having been told who it is.

This is deliberately expensive for an acquirer. It converts the user base from something that
transfers silently into something that has to be re-earned one System Settings trip at a time, and
that is precisely the property being promised. An acquisition that is not worth doing under this
condition is one this document exists to prevent.

### 2. The change is announced before it ships, not after

No build ships under new ownership before the transfer is announced in the release notes, on
cupertino.mgcrea.io, and in the app itself. The announcement names the acquirer.

"Before" means before the first build, not before the first complaint.

### 3. The signing identity is checkable, and never shared

`AppInfo.swift` already reads the team identifier out of the running binary with
`SecCodeCopySigningInformation`, and it is displayed in the app. The current value is published
alongside the release checksums, so a change of signer is visible without a disassembler.

The Developer ID private key is **not** escrowed, not shared, and not transferred. There is no
arrangement by which someone else can sign something as this identity. If that key is ever lost, the
consequence is that no further builds ship under it — which is the correct failure mode, and the
reason commitment 1 costs nothing to keep.

### 4. Abandonment relicenses the app, automatically

If no release and no substantive commit has landed for **twelve consecutive months**, the
[Cupertino Source-Available License](../apps/apple/LICENSE) covering `apps/apple/` converts to the
MIT License, on the same terms as `packages/*`, with no action required by anyone and no further
announcement.

Section 2(a) — the binary redistribution reservation — is the whole of the commercial reservation,
and it exists to protect a project that is being maintained. Applied to one that is not, it protects
nothing and blocks a fork. So it expires on its own.

The twelve months run from the last release or substantive commit in the public repository. A
maintenance release resets the clock. Silence does not.

### 5. Keys keep working, because they were never conditional

License validation is offline by construction ([EULA §4](../apps/apple/EULA)). No server has to stay
up for a key to verify, so nothing about a paid license depends on this project continuing to exist.
If everything here stops tomorrow, the build you have installed keeps running, and the key you paid
for keeps unlocking it, forever.

This is the part of the offline-validation trade that is usually left implicit. It is the strongest
argument for it, and it belongs in writing.

### 6. If it stops, it stops visibly

If the project is wound down rather than transferred: the download is removed, the final build's
SHA-256 and the command that reproduces it stay published, the repository is archived rather than
deleted, and the README says plainly that it is unmaintained and what that means for a tool holding
Full Disk Access.

An abandoned tool that still looks maintained is worse than one that says so.

## What is not promised

- **Not a support commitment.** None of this obliges anyone to keep shipping, to keep pace with a
  macOS release, or to answer email. It constrains how the project may end, not whether it does.
- **Not a source escrow.** There is nothing to escrow — the source is already public, which is what
  makes commitment 4 a relicensing rather than a release.
- **Not a guarantee against a hostile fork.** Anyone may already fork the source, and after
  commitment 4 anyone may ship binaries from it. What is promised is that a fork cannot arrive
  wearing this project's bundle identifier and inherit its permissions.
- **Not applicable to `packages/*`.** They are MIT and always were. Nothing here narrows or extends
  that, and nothing there holds a TCC grant.
