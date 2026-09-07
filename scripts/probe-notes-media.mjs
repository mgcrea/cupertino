#!/usr/bin/env node
// Which column names an attachment's directory under Accounts/<uuid>/Media/?
//
// `save_attachment` walks the media root looking for a directory whose name
// equals the attachment id it was given. That id comes from Apple Events and
// looks like `x-coredata://<store>/ICAttachment/p6909` — it contains slashes, so
// no directory can ever be named it, and the walk always comes back empty. The
// unit tests miss this because their fixture id is the slug "att-1", a shape the
// scripting dictionary never returns.
//
// So the lookup needs a different key. DON'T GUESS WHICH ONE. Take the directory
// names that are actually on disk and search every TEXT column of
// ZICCLOUDSYNCINGOBJECT for them: whatever comes back IS the key, by
// construction. That is the same discipline findIdBridge() applies to the note
// id, and for the same reason — a plausible-but-wrong column here would fail on
// some fraction of the corpus rather than all of it, which is far worse.
//
// NEEDS FULL DISK ACCESS, from a terminal that has it. The database is opened
// read-only and NEVER written to.
//
// OUTPUT IS REDACTED ON PURPOSE: column names, counts and booleans only.
// Filenames and directory names are masked unless --show-values. Safe to paste.
//
//   node scripts/probe-notes-media.mjs                # human-readable report
//   node scripts/probe-notes-media.mjs --json         # the raw document
//   node scripts/probe-notes-media.mjs --pk=6909      # focus one attachment
//   node scripts/probe-notes-media.mjs --show-values  # unmask names (private!)

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isTextType, listable, openStore, parseArgs, safe, tableTools } from "./lib/probe-kit.mjs";

const ENTITY_TABLE = "ZICCLOUDSYNCINGOBJECT";
const STORE = join(
  homedir(),
  "Library",
  "Group Containers",
  "group.com.apple.notes",
  "NoteStore.sqlite",
);
const MEDIA_ROOT = join(dirname(STORE), "Accounts");

const args = parseArgs(process.argv.slice(2));
const showValues = args.has("--show-values");
const focusPk = Number(args.valueOf("pk", "")) || null;

/** Keep the shape visible without leaking the value. */
const mask = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (showValues) return s;
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(s)?.[1];
  return `<${s.length} chars${ext ? `, .${ext}` : ""}>`;
};

/** Non-empty cells only; a row here is mostly nulls. */
const populated = (row) =>
  row ? Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== "")) : {};

const doc = { store: STORE, mediaRoot: MEDIA_ROOT, findings: {} };

/**
 * Every directory inside an `Accounts/<uuid>/Media/` subtree.
 *
 * SCOPED TO Media/ ON PURPOSE. An earlier version walked all of Accounts/ and
 * drew its sample from whatever readdir returned first — which was fallback
 * images, so the scan "conclusively" identified ZFALLBACKIMAGEGENERATION. The
 * consistency guard could not catch that: the matches were real, the population
 * was wrong. Sample only from the directories whose bytes we actually want.
 *
 * Directories with NO direct files are kept too. If the layout nests one level
 * deeper than expected, the directory that carries the name is exactly the one
 * with no files in it, and dropping those hides the answer.
 */
const mediaRoots = (accountsRoot) => {
  const roots = [];
  for (const acct of safe(
    () => readdirSync(accountsRoot, { withFileTypes: true }),
    () => [],
  )) {
    if (!acct.isDirectory()) continue;
    const media = join(accountsRoot, acct.name, "Media");
    if (listable(media)) roots.push(media);
  }
  return roots;
};

const collectMediaDirs = (roots, maxDepth = 4) => {
  const found = [];
  const walk = (dir, depth, trail) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      const kids = safe(
        () => readdirSync(full, { withFileTypes: true }),
        () => [],
      );
      found.push({
        name: e.name,
        depth,
        trail: [...trail, e.name],
        files: kids
          .filter((f) => f.isFile())
          .map((f) => ({
            name: f.name,
            bytes: safe(
              () => statSync(join(full, f.name)).size,
              () => null,
            ),
          })),
        subdirs: kids.filter((f) => f.isDirectory()).length,
      });
      walk(full, depth + 1, [...trail, e.name]);
    }
  };
  for (const r of roots) walk(r, 0, []);
  return found;
};

doc.findings.mediaRootReadable = listable(MEDIA_ROOT);
if (!doc.findings.mediaRootReadable) {
  doc.findings.error =
    `Cannot list ${MEDIA_ROOT}. This probe needs Full Disk Access — grant it to the ` +
    "terminal running it (System Settings > Privacy & Security > Full Disk Access), " +
    "then run it again. Granting it to Notes.app does nothing.";
}

const roots = doc.findings.mediaRootReadable ? mediaRoots(MEDIA_ROOT) : [];
const mediaDirs = collectMediaDirs(roots);
doc.findings.mediaSubtrees = roots.length;
doc.findings.media = {
  dirs: mediaDirs.length,
  withFiles: mediaDirs.filter((d) => d.files.length > 0).length,
  withoutFiles: mediaDirs.filter((d) => d.files.length === 0).length,
  depths: [...new Set(mediaDirs.map((d) => d.depth))].toSorted(),
  // Masked path templates: how deep the bytes sit and what each level is named.
  shapes: [
    ...new Set(
      mediaDirs
        .filter((d) => d.files.length > 0)
        .slice(0, 60)
        .map((d) => `Media/${d.trail.map((t) => `<${t.length}>`).join("/")}/<file>`),
    ),
  ].slice(0, 6),
  sample: mediaDirs
    .filter((d) => d.files.length > 0)
    .slice(0, 5)
    .map((d) => ({
      dir: mask(d.name),
      depth: d.depth,
      looksLikeUuid: /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(d.name),
      files: d.files.map((f) => ({ name: mask(f.name), bytes: f.bytes })),
    })),
};

const store = openStore(STORE);
doc.findings.storeOpen = { mode: store.mode, error: store.error ?? null };

if (store.db) {
  const { columnInfo, one } = tableTools(store.db);
  const textCols = columnInfo(ENTITY_TABLE)
    .filter((c) => isTextType(c.type))
    .map((c) => c.name);
  doc.findings.textColumns = textCols.length;

  /**
   * THE KEY SCAN. For a handful of real directory names, ask which TEXT column
   * holds that exact value. A column that matches every probed directory is the
   * key; one that matches some of them is a decoy and must not be trusted.
   */
  const needles = mediaDirs
    .filter((d) => d.files.length > 0)
    .slice(0, 12)
    .map((d) => d.name);
  const hits = Object.fromEntries(textCols.map((c) => [c, 0]));
  for (const col of textCols) {
    for (const needle of needles) {
      const row = one(`SELECT COUNT(*) AS c FROM "${ENTITY_TABLE}" WHERE "${col}" = ?`, needle);
      if ((row?.c ?? 0) > 0) hits[col] += 1;
    }
  }
  doc.findings.keyScan = {
    probed: needles.length,
    matches: Object.fromEntries(
      Object.entries(hits)
        .filter(([, n]) => n > 0)
        .toSorted((a, b) => b[1] - a[1]),
    ),
    // The column that resolves EVERY probed directory, if there is one.
    conclusive:
      Object.entries(hits)
        .filter(([, n]) => n === needles.length && needles.length > 0)
        .map(([c]) => c) ?? [],
  };

  /**
   * The reverse direction, and the one that actually matters: given the `pN`
   * from the CoreData id Apple Events returns, which directory holds the bytes?
   *
   * ICAttachment does not name the directory itself — it points at an ICMedia
   * row through the numeric ZMEDIA column, and that row carries the identifier
   * and filename. So follow every numeric column that looks like a foreign key
   * into this same table rather than assuming ZMEDIA is the only hop.
   */
  if (focusPk) {
    const allCols = columnInfo(ENTITY_TABLE).map((c) => c.name);
    const quoted = allCols.map((c) => `"${c}"`).join(", ");
    const rowOf = (pk) => one(`SELECT ${quoted} FROM "${ENTITY_TABLE}" WHERE Z_PK = ?`, pk);
    const dirFor = (value) => mediaDirs.find((d) => d.name === String(value));
    const describe = (row, label) => {
      const cells = populated(row);
      const resolves = Object.entries(cells)
        .map(([col, value]) => ({ column: col, dir: dirFor(value) }))
        .filter((r) => r.dir);
      return {
        label,
        pk: row?.Z_PK ?? null,
        columns: Object.fromEntries(
          Object.entries(cells).map(([k, v]) => [k, typeof v === "number" ? v : mask(v)]),
        ),
        resolvesVia: resolves.map((r) => ({
          column: r.column,
          depth: r.dir.depth,
          files: r.dir.files.map((f) => ({ name: mask(f.name), bytes: f.bytes })),
        })),
      };
    };

    const attachment = rowOf(focusPk);
    const chain = [describe(attachment, "ICAttachment")];
    // Hop through each numeric column that resolves to a real row in this table.
    for (const [col, value] of Object.entries(populated(attachment))) {
      if (typeof value !== "number" || col === "Z_PK" || value <= 0) continue;
      const target = rowOf(value);
      if (target) chain.push(describe(target, `via ${col}`));
    }
    doc.findings.focus = { pk: focusPk, found: Boolean(attachment), chain };
  }

  store.db.close();
}

if (args.json) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  const L = [];
  L.push("Notes attachment media — directory key");
  L.push("");
  L.push(`  store                 ${doc.store}`);
  L.push(`  media root readable   ${doc.findings.mediaRootReadable ? "yes" : "NO"}`);
  if (doc.findings.error) L.push(`  !! ${doc.findings.error}`);
  L.push(`  store open mode       ${doc.findings.storeOpen?.mode ?? "failed"}`);
  L.push(`  Media/ subtrees       ${doc.findings.mediaSubtrees ?? 0}`);
  L.push("");
  const m = doc.findings.media;
  L.push(
    `  dirs under Media/     ${m.dirs} (${m.withFiles} with files, ${m.withoutFiles} without)`,
  );
  L.push(`  nesting depths        ${m.depths.join(", ") || "none"}`);
  L.push("  path shapes:");
  for (const shape of m.shapes) L.push(`    ${shape}`);
  for (const s2 of m.sample) {
    L.push(
      `    depth=${s2.depth} ${s2.dir} uuid-shaped=${s2.looksLikeUuid ? "yes" : "no"} files=${s2.files.length}`,
    );
  }
  L.push("");
  const scan = doc.findings.keyScan;
  if (scan) {
    L.push(`  probed directories    ${scan.probed}`);
    L.push(`  columns with any hit  ${JSON.stringify(scan.matches)}`);
    L.push(`  CONCLUSIVE KEY        ${scan.conclusive.join(", ") || "none — see matches above"}`);
  }
  const f = doc.findings.focus;
  if (f) {
    L.push("");
    L.push(`  focus Z_PK=${f.pk} found=${f.found ? "yes" : "no"}`);
    for (const link of f.chain) {
      L.push(`    [${link.label}] Z_PK=${link.pk}`);
      L.push(`      columns   ${JSON.stringify(link.columns)}`);
      L.push(
        `      RESOLVES  ${link.resolvesVia.map((r) => `${r.column} (depth ${r.depth}) -> ${r.files.map((x) => x.bytes).join("/")} bytes`).join(", ") || "nothing"}`,
      );
    }
  }
  console.log(L.join("\n"));
}
