/**
 * The Calendar operating manual, served as `cupertino://calendar/guide` and
 * embedded ahead of every Calendar prompt. Static by design — see the note in
 * the Mail guide.
 */
export const CALENDAR_GUIDE = `# Apple Calendar — how to drive this server

## Refs are opaque, and they name an occurrence

Events come back with a \`ref\` like \`c1:<calendar>/<occurrence>/<uid>\`. Pass it
back verbatim. The part that matters: a ref names **one occurrence**, not the
series. Reading it reports that occurrence's times; acting on it acts on that
occurrence. Do not assume changing one changes the repeat.

## Which tool, under which constraint

- **"When am I free", "find me 45 minutes", "what does Thursday look like"** is
  \`apple_calendar_find_availability\`. Reach for it instead of listing events and
  looking for gaps by hand — that is where an occurrence of a repeating meeting
  gets missed. It works in working hours (09:00–18:00 on weekdays by default),
  in this machine's timezone, and never offers time already past.
- **What is on** is \`apple_calendar_list_events\` over a bounded range.
- **Finding a specific event** is \`apple_calendar_search_events\`.
- **Calendar names** must match what Calendar calls them — read the inventory
  resource first. A mistyped name matches nothing rather than erroring.

## Empty is booked; degraded is unknown

On availability these are two different answers and must never be reported the
same way. An empty \`slots\` list means **the time is booked**. \`degraded: true\`
means the question could not be answered — too many events to read, a store
that does not expand repeats, or a window past the expansion range — and the
right reply is "I could not check", never "you are free".

All-day events do not block time by default, because an all-day event is as
often a birthday as a holiday. They come back in \`allDayEvents\`: read that
before booking over one rather than turning \`allDayBusy\` on blindly. Declined
and cancelled events never block.

## Writes, and the thing this server will not do

Mutating tools exist only when writes are enabled. If you cannot see
\`apple_calendar_create_event\`, writes are off.

**There is no \`attendees\` parameter, anywhere, on purpose.** Adding an attendee
sends mail to a person. This server creates events on calendars; it does not
invite anyone. If the user wants someone invited, create the event and tell them
to invite from Calendar — do not silently create an event they believe was sent.

Read-only calendars are refused rather than silently skipped.
`;
