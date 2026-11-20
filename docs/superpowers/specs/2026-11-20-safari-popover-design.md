# The Safari extension's popover: this tab's state, its recording, and what agents did on it

Written 2026-11-20. Olivier asked for "a popover to the extension when we click on the icon that
could show its state and maybe some useful things or actions", and approved the sketch below the
same day ("looks good go").

## Why

On 2026-11-20 Safari stopped the extension's background worker while a geneanet tab was open and in
front (measured in Safari's log; see "Open pages can also go silent" in `docs/safari.md`). For
minutes every page command timed out, and the only places that could say so were a timeout message
in an agent's session and a log only `log show` reaches. Olivier, looking at the tab, had no way to
see that it had gone deaf, or that an agent had left a network recording armed on it ("The extension
dropped out again, so I couldn't stop the recording").

Clicking the toolbar icon does nothing today: the manifest declares an `action` with icons and a
title and no popup. The popover makes the icon the place to look: is this tab reachable, is it
recording, and what have agents done here, with the fix one click away.

## Goals

- Show, for the tab the person is looking at, what state it is in, and the one action that fixes it.
- Show the tab's network recording when it is armed, with Stop and Clear.
- Show the last commands agents ran on this page load.
- Keep working when the background worker is the thing that broke.

## Non-goals

- Settings. Allow writes, one-time codes and the cookie hosts are the MCP server's configuration,
  set in Cupertino; the extension cannot read them, and a copy would drift.
- Site permissions. Safari owns them; the popover says where they are and changes nothing.
- Anything about other tabs or other sites, history, or the server's state.
- An icon badge for a stalled tab. Only the background worker can set a badge, and a stalled worker
  is exactly when it would be needed. Left for later.

## Anti-goals

- **No new consent.** The popover must not add a permission, and above all not `activeTab`: in
  Safari a click on the icon under `activeTab` grants the extension that tab temporarily, so the
  person's click to look would let the extension onto a site they never allowed. That is the
  per-site grant `extension-manifest.test.ts` exists to protect ("asks for no host permission, so
  cookies stay behind the per-site grant"). `permissions` stays `["nativeMessaging", "cookies"]`.
- **No page content.** The popover never shows captured text, HTML, a field's value, a cookie or a
  recorded request's URL or body. Agent actions are shown by verb and element label only.
- **No path through the worker.** Every popover call goes to the tab's content script or to the
  tabs API, never through `background.js`, so a stopped worker cannot take the popover with it.

## Constraints

- Manifest V3, `background.service_worker`, Safari's Web Extension API. The extension's
  `Resources/` folder is a synchronized Xcode group (`project.pbxproj`, `CupertinoSafariExtension`
  root group), so new files there are bundled flat beside `background.js` with no project edit.
- The bundle is notarized, so nothing here runs in real Safari before a signed build. Every
  Safari behaviour this design relies on and nobody has measured is listed under "To measure".
- The content script is two files in two manifest entries: `network-hook.js` and `network.js` at
  `document_start`, then `actions.js` and `content.js` at `document_idle`. `actions.js` owns the
  command runner (`window.cupertinoRunCommand`) and the page-load token
  (`window.cupertinoPageToken`); `network.js` owns the recorder (`window.cupertinoNetwork.run`,
  whose `netRecord` ops `status`, `stop` and `clear` return its `state()`); `content.js` owns the
  capture and the poll pump.
- Extension JS is tested in vitest by running the real file in a `node:vm` context with stubbed
  `browser`, timers and DOM (`content-pump.test.ts`, `extension-background.test.ts`). The popup is
  tested the same way.

## Approaches

1. **A web-extension popover** (chosen): `action.default_popup` naming `popup.html`, with
   `popup.js` and `popup.css` beside the other resources. It reaches the tab's content script with
   `browser.tabs.sendMessage`, which does not go through the background worker, and ships with the
   extension it describes.
2. **A native popover** through `SFSafariExtensionViewController`. That class belongs to the
   legacy Safari App Extension API; a Safari Web Extension cannot present one. Ruled out.
3. **A status panel in the Cupertino app.** The app can read `SFSafariExtensionManager`'s enabled
   state but sees no tab, so it cannot say whether the page in front is reachable, recording, or
   what was done on it. Ruled out as the answer; it stays as it is.

## The design

### What the person sees

```
┌ Cupertino 1.42.0 ───────────────────────┐
│ en.geneanet.org                          │
│ ● Stalled: this page can't reach         │
│   Cupertino (last check-in 2 min ago)    │
│                          [Reload tab]    │
│ ─ Network recording ──────────────────── │
│ 33 requests · stops at 09:58             │
│                     [Stop]  [Clear]      │
│ ─ What agents did here ───────────────── │
│ 09:39 filled "Nom"                       │
│ 09:39 clicked "Rechercher"               │
│ 09:38 listed elements                    │
└──────────────────────────────────────────┘
```

The header is the extension's own version (`browser.runtime.getManifest().version`). The host is
the content script's `location.host`, so the popover never needs the tab's URL from the tabs API.
Times are local, `HH:MM`. Light and dark follow `prefers-color-scheme`.

### The states

The popup finds the active tab with `browser.tabs.query({ active: true, currentWindow: true })`,
which gives its `id` without any permission, and sends it `{ kind: "popupStatus" }` with
`tabs.sendMessage`, given up on after 1.5 s.

| State      | When                                                                                                          | Says                                                                                                                                                                                                                                                                      | Action     |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Ready      | The content script answered and its last successful poll is at most 15 s old                                  | "Agents can read and act on this page."                                                                                                                                                                                                                                   | none       |
| Connecting | It answered, has had no successful poll yet, and started less than 15 s ago                                   | "Connecting…"                                                                                                                                                                                                                                                             | none       |
| Stalled    | It answered, and its last successful poll is older than 15 s, or it has had none and started 15 s ago or more | "This page can't reach Cupertino" and how long since its last check-in ("never" when none)                                                                                                                                                                                | Reload tab |
| Not here   | `sendMessage` rejected or timed out                                                                           | "Cupertino isn't running on this page" and the three reasons: the site isn't allowed (Safari > Settings > Extensions, or the site's page settings), the tab was open before the extension was turned on or updated, or Safari doesn't run extensions on this kind of page | Reload tab |
| No tab     | `tabs.query` found no tab                                                                                     | "No page is open in this window."                                                                                                                                                                                                                                         | none       |

15 s is the visible-tab threshold the server already uses for lost polls (`CAPTURE_AFTER_POLL_MS`
in `packages/safari/src/client/pages.ts`): the tab is in front while its popover is open, so it
polls every second, and fifteen seconds without a successful poll is fourteen lost in a row.

"Out of date", shown in the approved sketch as its own state, folds into "Not here": a tab still
running a content script from before this build has no message listener and cannot answer, which is
indistinguishable from no content script at all. Both are fixed by the same reload, and "Not here"
names an update as one of its reasons.

**Reload tab** calls `browser.tabs.reload(tabId)` and closes the popover. A reload is what brought
the worker back on 2026-11-07 and 2026-11-20.

### What the content script keeps

`content.js`'s pump records, in memory, for this page load:

- `lastPollOkAt`: when a poll last came back with a reply object from the handler (the background
  returns `undefined` when its native call failed, and a lost message rejects after `WAIT_MS`;
  neither counts);
- `failedPolls`: polls that failed since the last one that worked;
- `startedAt`: when the pump started on this page load, so a page whose first poll is still on its
  way reads as Connecting rather than Stalled. Right after **Reload tab** the worker may be cold
  and the first reply can take up to `WAIT_MS`; a person who reopens the popover to see whether the
  reload worked should not be told it did not. (The builder check's call, 2026-11-20.)

It answers `popupStatus` with:

```js
{
  ok: true,
  host: location.host,
  page: window.cupertinoPageToken ?? null,
  extensionVersion: manifestVersion(),
  lastPollOkAt,          // epoch ms or null
  failedPolls,
  startedAt,             // epoch ms
  network: recorderState(), // network.js's state(), or null when the recorder did not load
  recent,                // see below
}
```

`recorderState()` is `window.cupertinoNetwork.run({ action: "netRecord", op: "status" }).data`
when that exists. It is called only when the popover asks, so a page nobody opens a popover on pays
nothing.

The listener is `browser.runtime.onMessage` in `content.js`, answering only `popupStatus`,
`popupNetwork` and nothing else, and only when `sender.id` is the extension's own id and the sender
is not a tab (a popup page has no `sender.tab`). Any other message gets no reply, so the listener
never swallows a message meant for someone else.

### Network recording

The section shows while `network.recording` is true, and also while it is stopped with records
still held (`network.counts.records > 0`), because `stop` keeps what was recorded and agents can
still read it with `network_list` and `network_get` until the page reloads. Armed, it shows the
record count and when it stops (`network.expiresAt`, local time), with **Stop** and **Clear**.
Stopped with records, it says "Stopped · 33 requests kept" with **Clear** alone. Both send `{ kind: "popupNetwork", op: "stop" | "clear" }`, which the content script answers
by running `window.cupertinoNetwork.run({ action: "netRecord", op })` and returning the new state,
which the popover redraws from. The page-load token is not needed: the message goes to this tab's
own content script, which is the recorder's owner.

### What agents did here

`actions.js` keeps the last ten commands `cupertinoRunCommand` ran on this page load, newest first,
as `{ at, action, ok, label }`:

- `at`: epoch ms;
- `action`: the command's action, and for `netRecord` its op;
- `ok`: whether the result was `ok`;
- `label`: for `click` and `fill`, the result's `label` (the element's label; for a click, named
  before the click); for `submit`, the result's `button` when it went through one; cut to 60
  characters; otherwise absent.

Never the filled text, a value, a URL, a query or a request id. The list lives in the page's memory
and dies with the page load, as the element ids it describes do. A command refused before it ran
(wrong page load, wrong URL) is listed with `ok: false` and no label.

The popover words them as verbs: "clicked", "filled", "submitted", "listed elements", "read the
page", "scrolled", "searched the page", "looked for codes", "started recording", "stopped
recording", "cleared the recording", "listed requests", "read a request". A failure is shown in the
secondary colour with "(failed)".

Commands from the popover itself (`popupNetwork`) are not listed: they are the person's, not an
agent's.

Cookie reads are listed too, though they never reach the page: `background.js` answers `cookies`
and `cookieProbe` itself (`answerHere`) and takes them out of the poll reply. It now leaves the page
a note in their place, `ran: [{ action, ok }]` on the reply, which the pump adds to the ring as
"read cookies" (or "checked a cookie") with no names and no values. They are the most sensitive
thing an agent does on a site, and a list of what agents did that silently left them out would
mislead. The note travels the poll like everything else, so it is lost with the poll when the
worker is stuck, which is fine: so was the cookie read.

## Files

- `apps/apple/CupertinoSafariExtension/Resources/popup.html`, `popup.css`, `popup.js`: new.
- `manifest.json`: `action.default_popup: "popup.html"`. Nothing else changes.
- `content.js`: poll bookkeeping, the `onMessage` listener.
- `actions.js`: the recent-commands ring.
- `background.js`: the `ran` note for the cookie commands it answers.
- `packages/safari/test/`: `extension-manifest.test.ts` updated (popup named, permissions
  unchanged, still no host permission); `extension-background.test.ts` for the `ran` note; new
  popup and content-listener tests in the vm style.
- `docs/safari.md`: a section on the popover, its states and what it never shows.
- `CHANGELOG.md`: an Unreleased entry.

## To measure on a notarized build

None of these is known for Safari, and each changes what the person sees:

1. `tabs.query({ active: true, currentWindow: true })` from the popover returns the tab with an
   `id` under the current permissions, and `tabs.sendMessage(id, …)` reaches the content script's
   `runtime.onMessage` while the background worker is stopped. If the second fails, the popover
   loses its reason to exist on a stalled tab, and the design comes back here.
2. `tabs.reload(id)` works with no `tabs` permission.
3. What clicking the icon does on a site the extension is not allowed on. Safari may show its own
   permission prompt instead of the popover; if so, "Not here" only ever shows for the other two
   reasons, and its wording should say so.
4. What `sender` looks like for a message from the popover in Safari (`sender.id`, no
   `sender.tab`), which the listener's filter depends on.
5. Whether opening the popover wakes the background worker. Not relied on; worth knowing.

## Done

Olivier's call, 2026-11-20: ship, confirm later. The popover merges and goes out in the next
release once a signed build shows it working on a healthy tab: the states it can reach there
(Ready, Connecting, Not here on a site the extension is not allowed on, No tab), Stop and Clear on
an armed recording, the agent list after a few commands, and Reload. Nothing known causes the
worker stop on demand, so the stalled case, "To measure" 1, is confirmed the next time a stall
happens on its own, and `docs/safari.md` records it as open until then.

## Left to the builder

- The popover's exact layout, type and colours, within the sketch and the system font, at a fixed
  width of about 300 pt.
- How `popup.js` is split for testing, so long as the vm tests run the real file.
- The wording of the "Not here" reasons, within what the table says.
