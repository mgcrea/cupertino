/**
 * The Contacts operating manual, served as `cupertino://contacts/guide` and
 * embedded ahead of every Contacts prompt. Static by design — see the note in
 * the Mail guide.
 */
export const CONTACTS_GUIDE = `# Apple Contacts — how to drive this server

## This server is read-only by construction

It cannot create, edit or delete a contact, and enabling writes does not add a
tool. If someone asks you to update a contact, say that plainly rather than
looking for a tool that is not there.

## Which tool, under which constraint

- **A raw phone number or email address** — from a Messages handle, a caller ID,
  a mail header — is \`apple_contacts_resolve_handles\`. Give it the identifiers
  as they came; it batches and returns one result per handle.
- **A name, or part of one** is \`apple_contacts_search_contacts\`.
- **\`apple_contacts_get_contact\`** returns one card in full.

Phone matching is by trailing digits, because Contacts stores numbers as typed
("06 12 34 56 78") while most systems hand you E.164 ("+33612345678"). Exact
string matching resolves almost nothing and is not used.

## Read \`status\`, never just \`name\`

Every resolve result carries a status, and three of the four are not a name:

- **\`resolved\`** — exactly one contact. \`name\` is set.
- **\`unknown\`** — nobody in the address book has this handle. **Common and not
  an error**: measured on a real store, about one in six of even the busiest
  correspondents does not resolve. Show the raw handle.
- **\`ambiguous\`** — more than one contact has it, so **no name is returned**.
  Do not guess, and do not pick the first; \`matches\` says how many. Putting the
  wrong name on a message is worse than putting none, because it does not look
  wrong.
- **\`shortcode\`** — a bank, a courier, a 2FA sender. Can never be a contact.

## Permissions and shape

Contacts has its **own** privacy permission and is not covered by Full Disk
Access — and unlike Full Disk Access, macOS prompts for it. A store that cannot
be opened usually means that prompt was dismissed: System Settings > Privacy &
Security > Contacts.

The address book is several databases, one per account. All readable ones are
unioned; if diagnostics reports fewer opened than found, some accounts are
missing from every answer. A contact held in two accounts is folded onto its
link id, matching the single card Contacts.app shows.
`;
