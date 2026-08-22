import { PRELUDE } from "./core.js";

/**
 * The write scripts. Two verbs, and the absence of a third is deliberate.
 *
 * `create` and `update` are both `make`-and-`save`. There is no `delete`,
 * because the Contacts dictionary has no delete command — see `core.ts` for the
 * measurement. That absence is enforced by `test/jxa.test.ts`, so removing a
 * contact cannot be added here without the decision being taken again.
 *
 * Every script SAVES and then RE-READS, in that order. Contacts keeps changes in
 * an unsaved buffer, so a script that skips the save mutates a live object,
 * reports success from its own in-memory read, and leaves the store untouched.
 * Verifying before saving would find exactly the same false success.
 */

export const CREATE_CONTACT = `${PRELUDE}
function run(argv) {
  var p = JSON.parse(argv[0]);
  var C = Application("Contacts");

  if (!isContactsRunning() && !p.allowLaunch) {
    return err("APP_NOT_RUNNING", "Contacts is not running.");
  }

  var person;
  try {
    person = C.Person({
      firstName: p.fields.firstName || "",
      lastName: p.fields.lastName || ""
    });
    C.people.push(person);
  } catch (e) {
    return err("CREATE_FAILED", e.message || e);
  }

  try {
    applyFields(person, p.fields);
    addChildren(C, person, p.phones, p.emails);
  } catch (e) {
    // The person exists but is incomplete. Save anyway so the caller is told
    // about a real half-written card rather than a phantom one, and let the
    // read-back below show exactly what landed.
    try { C.save(); } catch (e2) {}
    return err("CREATE_INCOMPLETE", e.message || e);
  }

  try {
    C.save();
  } catch (e) {
    return err("SAVE_FAILED", e.message || e);
  }

  // Re-read AFTER the save, so what comes back is what Contacts stored rather
  // than what this script asked for.
  var fresh = findPerson(C, prop(function () { return String(person.id()); }, ""));
  if (!fresh) {
    return err("CREATE_NOT_PERSISTED", "Contacts saved without error but the contact could not be read back.");
  }
  return ok(shapePerson(fresh));
}
`;

export const UPDATE_CONTACT = `${PRELUDE}
function run(argv) {
  var p = JSON.parse(argv[0]);
  var C = Application("Contacts");

  if (!isContactsRunning() && !p.allowLaunch) {
    return err("APP_NOT_RUNNING", "Contacts is not running.");
  }

  var person = findPerson(C, p.personId);
  if (!person) {
    return err("CONTACT_NOT_FOUND", "No contact with id " + p.personId + ".");
  }

  try {
    applyFields(person, p.fields);
    addChildren(C, person, p.phones, p.emails);
  } catch (e) {
    return err("UPDATE_FAILED", e.message || e);
  }

  try {
    C.save();
  } catch (e) {
    return err("SAVE_FAILED", e.message || e);
  }

  var fresh = findPerson(C, p.personId);
  if (!fresh) {
    return err("UPDATE_NOT_PERSISTED", "Contacts saved without error but the contact could not be read back.");
  }
  return ok(shapePerson(fresh));
}
`;
