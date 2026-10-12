/**
 * The version sentence in `apps/website/public/llms.txt`, rewritten to name the
 * release `package.json` names.
 *
 * It was the one copy of the version `make version` did not write. It was
 * typed by hand, and `website-tools.test.mjs` failed CI whenever it lacked the
 * current minor, so every minor release was followed by a commit doing nothing
 * but bump it (8802834 for 1.26.0). The generator writes it now, like every
 * other copy.
 *
 * A line pattern rather than a marked region, because llms.txt is plain text
 * served as is to whatever reads /llms.txt, and an HTML comment or a banner in
 * it would be read as content. The pattern is the sentence itself, allowing any
 * run of whitespace between words since the paragraph is wrapped by hand and
 * the wrap moves with the length of the number. A file that no longer carries
 * the sentence is an error, not a no-op: the version would silently stop being
 * written.
 *
 * "As of <month>" comes from the release's own `## [x.y.z] - YYYY-MM-DD`
 * heading in CHANGELOG.md, so it is the month the release shipped and does not
 * depend on the day the generator ran. While the release has no section yet,
 * the file is left alone: `generate-version.mjs` refuses that state itself,
 * with the reason, and reporting it twice would only bury the message.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const SENTENCE = /(Shipped at 1\.0\.0, and at\s+)\S+(\s+as\s+of\s+)[A-Z][a-z]+(\s+)\d{4}:/;

/**
 * @param {string} text the current llms.txt
 * @param {string} version the root package.json version
 * @param {string} changelog the current CHANGELOG.md
 */
export const stampLlmsVersion = (text, version, changelog) => {
  if (!SENTENCE.test(text)) {
    throw new Error(
      'llms.txt: no "Shipped at 1.0.0, and at <version> as of <Month> <year>:" sentence to rewrite',
    );
  }
  const escaped = version.replace(/[.+]/g, "\\$&");
  const heading = changelog.match(new RegExp(`^## \\[${escaped}\\](.*)$`, "m"));
  if (!heading) return text;
  const date = heading[1].match(/^ - (\d{4})-(\d{2})-\d{2}\s*$/);
  if (!date) {
    throw new Error(
      `llms.txt: CHANGELOG.md's "## [${version}]" heading has no date to give the release`,
    );
  }
  const month = MONTHS[Number(date[2]) - 1];
  if (!month) throw new Error(`llms.txt: "${heading[0]}" has no month ${date[2]}`);
  return text.replace(
    SENTENCE,
    (_, lead, asOf, gap) => `${lead}${version}${asOf}${month}${gap}${date[1]}:`,
  );
};
