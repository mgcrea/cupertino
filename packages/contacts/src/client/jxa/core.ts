/**
 * JXA script fragments for Contacts.
 *
 * Every script here is a static constant. None may contain a template
 * interpolation — `assertStaticScript` rejects any script containing a dollar
 * sign followed by a brace, including template literals written INSIDE the JXA
 * source. Use string concatenation in JXA code.
 *
 * Every script follows the same contract:
 *   - it reads its parameters from `JSON.parse(argv[0])`
 *   - it returns `JSON.stringify({ok: true, data})` on success
 *   - it returns `JSON.stringify({ok: false, error: {code, message}})` on an
 *     application-level failure, still exiting 0
 * so a non-zero exit always means infrastructure rather than "no such contact".
 *
 * ## There is no read.ts here, and that is still the design
 *
 * Adding writes did not add a read lane. Reads come off the file lane, which is
 * the only place a suffix-keyed index over 970 phone numbers can be built at
 * all — see `../store.ts`. These scripts exist only to make Contacts CHANGE
 * something. `test/jxa.test.ts` asserts `read.ts` does not exist.
 *
 * ## What the dictionary actually offers
 *
 * MEASURED from `sdef /System/Applications/Contacts.app` on macOS 26.6. The
 * whole command list is four verbs:
 *
 *     make      create a person, or a phone/email element under one
 *     add       put a person in a group
 *     remove    take a person out of a group
 *     save      commit everything
 *
 * That is all of it. The Standard Suite here contains **only `make`** — the
 * string "delete" does not appear anywhere in the dictionary. So there is no
 * supported way to delete a contact over Apple Events, which is why this file
 * has no DELETE script and why `delete_contacts` is not a tool. Whether Cocoa
 * Scripting answers an undeclared `delete` event anyway is a separate question
 * and an unmeasured one; guessing at it would risk destroying a real person's
 * card on the strength of an assumption.
 *
 * ## `save` is explicit, global, and the whole reason this is not like Calendar
 *
 * Calendar and Reminders persist a property assignment immediately. Contacts
 * does not: changes sit in an unsaved buffer until `Application("Contacts").save()`
 * runs, and the dictionary says so — the application class carries an `unsaved`
 * property, and `save` is documented as "Save ALL Contacts changes".
 *
 * Two consequences, both load-bearing:
 *
 * 1. **A write that forgets `save()` silently does nothing.** The object updates,
 *    every read-back inside the same script agrees, and the store never changes.
 *    Every script below saves before it verifies.
 * 2. **`save()` is not scoped to our change.** It commits whatever else is
 *    pending, including an edit someone has half-typed in the Contacts window.
 *    That is a property of the dictionary, not a choice made here, and the tool
 *    descriptions say so.
 */

/**
 * Shared prelude.
 *
 * The bundle identifier is `com.apple.AddressBook`, which — like Calendar's
 * `com.apple.iCal` — does not match the display name. Contacts.app kept the id
 * it shipped with as Address Book. `Application("Contacts")` is the correct
 * scripting name; `com.apple.Contacts` does not exist.
 */
export const PRELUDE = `
ObjC.import("AppKit");

function isContactsRunning() {
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.AddressBook");
  return apps.count > 0;
}

function ok(data) { return JSON.stringify({ ok: true, data: data }); }
function err(code, message) { return JSON.stringify({ ok: false, error: { code: code, message: String(message) } }); }

/** Read one property defensively: Contacts throws on properties it cannot supply. */
function prop(fn, fallback) {
  try {
    var v = fn();
    return v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

/**
 * Find one person, without assuming the two lanes spell an id the same way.
 *
 * The file lane holds \`ZABCDRECORD.ZUNIQUEID\`; Apple Events returns whatever
 * \`person.id()\` returns. That those are the same string is EXACTLY the kind of
 * thing this project has been wrong about before — Calendar's \`calendar.uid()\`
 * throws for every calendar, and the id bridge that held for its events did not
 * extend to them. It is unmeasured here, so it is not assumed.
 *
 * Two attempts, cheapest first:
 *
 *   1. \`byId()\` with the value as given. Contacts offers a real by-id lookup,
 *      unlike Calendar, so when the forms do agree this costs one round trip.
 *   2. A bulk \`people.id()\` fetch, matched on the UUID substring. This is the
 *      guard, and it is affordable precisely here: docs/contacts.md measured the
 *      whole id list at 63-73 ms over 421 people, against the 1.8 s that made the
 *      same trick unusable for Calendar's events.
 *
 * So a mismatch in id FORM degrades to a fast scan instead of a wrong "not
 * found" — which is the failure this would otherwise produce, and the one that
 * looks like the contact was deleted.
 */
function uuidOf(value) {
  var m = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/.exec(String(value || ""));
  return m ? m[0].toUpperCase() : null;
}

function findPerson(C, personId) {
  try {
    var direct = C.people.byId(personId);
    direct.id();
    return direct;
  } catch (e) {
    // Fall through to the scan.
  }

  var wanted = uuidOf(personId);
  if (!wanted) return null;

  try {
    var ids = C.people.id();
    for (var i = 0; i < ids.length; i++) {
      if (uuidOf(ids[i]) === wanted) {
        var found = C.people.byId(ids[i]);
        found.id();
        return found;
      }
    }
  } catch (e2) {
    return null;
  }
  return null;
}

/** Everything a write returns, so a caller sees what Contacts stored. */
function shapePerson(p) {
  return {
    id: prop(function () { return String(p.id()); }, null),
    name: prop(function () { return p.name(); }, null),
    firstName: prop(function () { return p.firstName(); }, null),
    lastName: prop(function () { return p.lastName(); }, null),
    nickname: prop(function () { return p.nickname(); }, null),
    organization: prop(function () { return p.organization(); }, null),
    jobTitle: prop(function () { return p.jobTitle(); }, null),
    department: prop(function () { return p.department(); }, null),
    note: prop(function () { return p.note(); }, null),
    company: prop(function () { return p.company(); }, false),
    phones: prop(function () {
      var out = [];
      var xs = p.phones();
      for (var i = 0; i < xs.length; i++) {
        out.push({
          label: prop(function () { return xs[i].label(); }, null),
          value: prop(function () { return xs[i].value(); }, null)
        });
      }
      return out;
    }, []),
    emails: prop(function () {
      var out = [];
      var xs = p.emails();
      for (var i = 0; i < xs.length; i++) {
        out.push({
          label: prop(function () { return xs[i].label(); }, null),
          value: prop(function () { return xs[i].value(); }, null)
        });
      }
      return out;
    }, [])
  };
}

/**
 * Apply the scalar properties a caller supplied.
 *
 * Only keys actually present are touched: a missing key means "leave it alone",
 * an explicit null means "clear it". Assigning undefined would blank a field the
 * caller never mentioned.
 */
function applyFields(p, f) {
  if (f.firstName !== undefined) p.firstName = f.firstName;
  if (f.lastName !== undefined) p.lastName = f.lastName;
  if (f.nickname !== undefined) p.nickname = f.nickname;
  if (f.organization !== undefined) p.organization = f.organization;
  if (f.jobTitle !== undefined) p.jobTitle = f.jobTitle;
  if (f.department !== undefined) p.department = f.department;
  if (f.note !== undefined) p.note = f.note;
  if (f.company !== undefined) p.company = f.company;
}

/**
 * Add phone and email elements.
 *
 * These are ELEMENTS, not properties: a phone number is its own object made at
 * the end of the person's phones. There is no way to set them as a bulk array,
 * so each one is a separate \`make\`.
 */
function addChildren(C, p, phones, emails) {
  var i;
  if (phones) {
    for (i = 0; i < phones.length; i++) {
      p.phones.push(C.Phone({ label: phones[i].label || "mobile", value: phones[i].value }));
    }
  }
  if (emails) {
    for (i = 0; i < emails.length; i++) {
      p.emails.push(C.Email({ label: emails[i].label || "home", value: emails[i].value }));
    }
  }
}
`;
