import changelog from "../../../../CHANGELOG.md?raw";
/**
 * The releases, for /changelog and /changelog/<version>.
 *
 * Read from the repository's CHANGELOG.md at build time — `?raw`, as the terms
 * page reads the EULA — and through the same parser the appcast and the app's
 * What's New pane use, so the three cannot disagree about what a release said.
 * `### Internal` sections are left out here as they are there: they are about
 * CI and the licence API, and the page is for people deciding whether to update.
 *
 * A release's social card exists only if `pnpm cards` rendered one, which it
 * does for every release with a summary. The manifest it writes is what says
 * so; a page for a release without one falls back to the site card.
 */
import {
  HIDDEN_SECTIONS,
  inline,
  parse,
  plain,
  postText,
  renderHTML,
} from "../../../../scripts/lib/changelog.mjs";
import cards from "./release-cards.json";

export interface Release {
  version: string;
  date: string;
  /** "October 3, 2026", fixed to UTC so the build machine's zone cannot move it. */
  longDate: string;
  /** The page every share links to. */
  path: string;
  /** The `**Title.**` lead and its sentence, when the release has one. */
  summary: { title: string; description: string; post: string } | null;
  /** The notes as HTML, without `### Internal`. */
  html: string;
  /** The sections the page shows, for the table of contents. */
  sections: string[];
  /** Each visible entry's bold headline, plain — the index's stand-in for a summary. */
  highlights: string[];
  /** The same headlines as inline HTML, so a tool name keeps its code styling. */
  highlightsHtml: string[];
  /** `/changelog/<version>.png`, or null where no card was rendered. */
  card: string | null;
}

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

/**
 * Newest first, released only. `## [Unreleased]` is in the file between
 * releases and is not something to link to.
 */
export const RELEASES: Release[] = parse(changelog)
  .filter((release) => !release.unreleased)
  .map((release) => ({
    version: release.version,
    date: release.date,
    longDate: longDate(release.date),
    path: `/changelog/${release.version}/`,
    summary: release.summary
      ? {
          title: plain(release.summary.title),
          description: plain(release.summary.description),
          post: postText(release.summary),
        }
      : null,
    // The lead's first paragraph IS the summary, and the page sets it as the
    // headline and standfirst. Rendering it again in the notes would say it twice.
    html: renderHTML(release.summary ? { ...release, lead: release.lead.slice(1) } : release),
    sections: release.groups
      .filter((group) => !HIDDEN_SECTIONS.has(group.name))
      .map((group) => group.name),
    highlights: release.groups
      .filter((group) => !HIDDEN_SECTIONS.has(group.name))
      .flatMap((group) => group.entries)
      .map((entry) => (entry.headline ? plain(entry.headline) : null))
      .filter((headline): headline is string => headline !== null),
    highlightsHtml: release.groups
      .filter((group) => !HIDDEN_SECTIONS.has(group.name))
      .flatMap((group) => group.entries)
      .map((entry) => (entry.headline ? inline(entry.headline) : null))
      .filter((headline): headline is string => headline !== null),
    card: release.version in cards ? `/changelog/${release.version}.png` : null,
  }));
