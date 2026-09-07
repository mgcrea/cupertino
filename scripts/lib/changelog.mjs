// CHANGELOG.md, parsed once.
//
// Two things read this file and they must not disagree about it: the Sparkle
// appcast, which renders one section as HTML at release time, and the app's
// What's New pane, which is generated from the most recent sections at build
// time. Two parsers over one hand-written file drift the first time somebody
// writes a bullet in a shape neither anticipated, and the failure is silent in
// both directions — the appcast keeps rendering while the pane quietly drops a
// bullet. So there is one parser, and `renderHTML` below is the appcast's
// renderer moved here verbatim.
//
// `renderHTML` reads `entry.paragraphs` and nothing else. That is the whole
// reason entries carry their raw paragraphs alongside the `headline`/`body`
// split the Swift generator wants: the HTML path never sees the split, so
// changing how the split works cannot move a byte of the appcast.

/**
 * One bullet.
 *
 * `paragraphs` is what the source said, with continuation lines joined by a
 * single space — the shape the HTML renderer has always emitted. `headline` is
 * the leading `**…**` span with its asterisks removed, or null: not every
 * bullet in this file opens with one, so a required headline would be a lie
 * about the format.
 *
 * @typedef {{ paragraphs: string[], headline: string | null, body: string[] }} Entry
 */

/**
 * One `### Added` / `### Fixed` block.
 *
 * `lead` is the prose that can sit between the heading and the first bullet.
 * It is easy to forget it exists; dropping it silently shortens the release
 * notes every user reads before agreeing to replace an app that holds Full Disk
 * Access.
 *
 * @typedef {{ name: string, lead: string[], entries: Entry[] }} Group
 */

/** @typedef {{ version: string, date: string, unreleased: boolean, lead: string[], groups: Group[] }} Release */

/** The leading `**…**`, non-greedy so a headline containing a code span still ends at its own close. */
const HEADLINE = /^\*\*(.+?)\*\*\s*/;

/**
 * Every `## ` section, newest first.
 *
 * @param {string} markdown
 * @returns {Release[]}
 */
export const parse = (markdown) => {
  const lines = markdown.split("\n");
  /** @type {Release[]} */
  const releases = [];

  /** @type {Release | null} */
  let release = null;
  /** @type {Group | null} */
  let group = null;
  /** @type {string[] | null} */
  let bullet = null; // the paragraphs of the bullet being collected
  /** @type {string[]} */
  let paragraph = [];

  const flushParagraph = () => {
    if (bullet && paragraph.length) {
      bullet.push(paragraph.join(" "));
      paragraph = [];
    }
  };
  const flushBullet = () => {
    if (!bullet) return;
    flushParagraph();
    const paragraphs = bullet;
    bullet = null;
    const first = paragraphs[0] ?? "";
    const match = HEADLINE.exec(first);
    const rest = match ? first.slice(match[0].length) : first;
    group?.entries.push({
      paragraphs,
      headline: match ? match[1] : null,
      body: [rest, ...paragraphs.slice(1)].filter((p) => p !== ""),
    });
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.startsWith("## ")) {
      flushBullet();
      // `## [1.17.0] - 2026-09-07`, or `## [Unreleased]` with no date.
      const heading = line.slice(3).trim();
      const version = /^\[([^\]]+)\]/.exec(heading)?.[1] ?? heading;
      const date = /-\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(heading)?.[1] ?? "";
      release = {
        version,
        date,
        unreleased: version.toLowerCase() === "unreleased",
        lead: [],
        groups: [],
      };
      releases.push(release);
      group = null;
      continue;
    }

    // Everything above the first `## ` is the file's own intro — including the
    // `<generated:version>` region `make version` writes there. Not a release.
    if (!release) continue;

    if (line.startsWith("### ")) {
      flushBullet();
      group = { name: line.slice(4).trim(), lead: [], entries: [] };
      release.groups.push(group);
    } else if (line.startsWith("- ")) {
      flushBullet();
      bullet = [];
      paragraph = [line.slice(2)];
    } else if (line === "") {
      flushParagraph();
    } else if (bullet) {
      paragraph.push(line.trim());
    } else {
      // Prose outside any bullet. One paragraph per line, deliberately: that is
      // what the HTML renderer has always emitted, and joining them here would
      // change the appcast.
      (group ?? release).lead.push(line.trim());
    }
  }
  flushBullet();

  return releases;
};

// ─── HTML, for the appcast ────────────────────────────────────────────────────
//
// Moved here from `changelog-notes.mjs` character for character. Sparkle renders
// an item's `<description>` as HTML in a WKWebView, and the release path used to
// slice raw markdown straight into the CDATA: every user's update dialog showed
// literal `###` headings, `- ` bullets and `**` around each entry's lead.

const escape = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Inline markdown. Code spans are lifted out first so nothing inside is touched.
 *
 * The placeholder wraps the index in private-use characters. Wrapping it in
 * spaces and restoring with `/ (\d+) /` also matches any bare number in ordinary
 * prose: "from March 2026 onward" came back as "from Marchundefinedonward",
 * because there is no 2026th code span. This CHANGELOG is full of years and
 * counts, so that is not a corner. U+E000 and U+E001 cannot appear in the source
 * — it is prose, not a font — and no rule below matches one. Private-use rather
 * than NUL so the restore pattern is not a control-character regex, which
 * oxlint rejects.
 */
export const inline = (text) => {
  const codes = [];
  let out = escape(text).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\uE000${codes.length - 1}\uE001`;
  });
  out = out
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:)]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out.replace(/\uE000(\d+)\uE001/g, (_, index) => codes[Number(index)]);
};

/**
 * One release as the HTML Sparkle shows.
 *
 * Reads `entry.paragraphs`, never `headline`/`body`, so the split those two
 * carry cannot move the output.
 *
 * @param {Release} release
 * @returns {string}
 */
export const renderHTML = (release) => {
  const html = [];
  for (const text of release.lead) html.push(`<p>${inline(text)}</p>`);
  for (const group of release.groups) {
    html.push(`<h3>${inline(group.name)}</h3>`);
    for (const text of group.lead) html.push(`<p>${inline(text)}</p>`);
    if (group.entries.length === 0) continue;
    html.push("<ul>");
    for (const entry of group.entries) {
      html.push(`<li>${entry.paragraphs.map((p) => `<p>${inline(p)}</p>`).join("")}</li>`);
    }
    html.push("</ul>");
  }
  return html.join("\n");
};
