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

/**
 * What a release is, in one line and a sentence or two — the first paragraph
 * under its `## ` heading, when that paragraph opens with a `**…**` title.
 *
 * It is what the website's per-version page leads with, what its social card
 * shows, and what gets posted with the link, so it is written for somebody who
 * has never opened the app. Optional: releases before 1.25.0 have none, and a
 * lead paragraph without a bold title is prose, not a summary.
 *
 * `title` and `description` are the source's markdown; `plain` strips it for
 * the places markup cannot go — a post, an og:description, a PNG.
 *
 * @typedef {{ title: string, description: string }} Summary
 */

/**
 * `lead` is the prose between the `## ` heading and the first `###`, one entry
 * per PARAGRAPH — wrapped lines joined, blank lines separating. Unlike a group's
 * lead, which the What's New pane renders line by line and so keeps its lines.
 *
 * @typedef {{ version: string, date: string, unreleased: boolean, lead: string[], summary: Summary | null, groups: Group[] }} Release
 */

/**
 * Sections that exist for the repository rather than for the user.
 *
 * Here rather than in either consumer, and applied by both: the What's New
 * generator filters on it, and so does `renderHTML` below. It used to live in
 * the generator alone, so the pane dropped `### Internal` while the appcast
 * rendered it, and every user deciding whether to install an update read about
 * CI jobs and generators in the dialog that asks them.
 */
export const HIDDEN_SECTIONS = new Set(["Internal"]);

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
  /** @type {string[]} */
  let leadParagraph = []; // the release-level lead paragraph being collected

  const flushLead = () => {
    if (release && leadParagraph.length) {
      release.lead.push(leadParagraph.join(" "));
      leadParagraph = [];
    }
  };

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
      flushLead();
      // `## [1.17.0] - 2026-09-07`, or `## [Unreleased]` with no date.
      const heading = line.slice(3).trim();
      const version = /^\[([^\]]+)\]/.exec(heading)?.[1] ?? heading;
      const date = /-\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(heading)?.[1] ?? "";
      release = {
        version,
        date,
        unreleased: version.toLowerCase() === "unreleased",
        lead: [],
        summary: null,
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
      flushLead();
      group = { name: line.slice(4).trim(), lead: [], entries: [] };
      release.groups.push(group);
    } else if (line.startsWith("- ")) {
      flushBullet();
      bullet = [];
      paragraph = [line.slice(2)];
    } else if (line === "") {
      flushParagraph();
      flushLead();
    } else if (bullet) {
      paragraph.push(line.trim());
    } else if (group) {
      // A group's prose, one entry per line, deliberately: the What's New pane
      // renders it that way, and joining it here would move the pane.
      group.lead.push(line.trim());
    } else {
      // The release's own prose. Joined into paragraphs: the appcast renders an
      // entry per `<p>`, and one per source line broke a wrapped sentence into
      // fragments in the update dialog — which no release noticed while none
      // carried a lead long enough to wrap after 1.3.0.
      leadParagraph.push(line.trim());
    }
  }
  flushBullet();
  flushLead();

  for (const each of releases) each.summary = summarise(each.lead[0]);
  return releases;
};

/**
 * The longest title the social card lays out in two lines — see
 * `composeReleaseCard`, which wraps at this many characters and no further.
 */
export const SUMMARY_TITLE_MAX = 64;

/**
 * The longest post the summary may make. 280 is X's limit; a link always counts
 * as 23 characters there, plus the space before it.
 */
export const SUMMARY_POST_MAX = 280 - 24;

/** @param {string | undefined} paragraph @returns {Summary | null} */
const summarise = (paragraph) => {
  const match = paragraph ? HEADLINE.exec(paragraph) : null;
  if (!paragraph || !match) return null;
  return { title: match[1], description: paragraph.slice(match[0].length).trim() };
};

/**
 * Markdown out, for a post, a meta tag or a picture: code spans keep their text,
 * a link keeps its words, emphasis goes.
 *
 * @param {string} text
 * @returns {string}
 */
export const plain = (text) =>
  text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The text to post with a release's link: its title, then its description.
 *
 * @param {Summary} summary
 * @returns {string}
 */
export const postText = (summary) => `${plain(summary.title)} ${plain(summary.description)}`.trim();

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
 * carry cannot move the output. Skips `HIDDEN_SECTIONS`, the one deliberate
 * departure from the renderer it was moved from.
 *
 * @param {Release} release
 * @returns {string}
 */
export const renderHTML = (release) => {
  const html = [];
  for (const text of release.lead) html.push(`<p>${inline(text)}</p>`);
  for (const group of release.groups) {
    if (HIDDEN_SECTIONS.has(group.name)) continue;
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
