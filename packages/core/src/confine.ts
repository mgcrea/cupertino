import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import { PreconditionError } from "./errors.js";

/**
 * Write a file somewhere the caller is allowed to write it.
 *
 * ## Why this is shared
 *
 * Three surfaces save attachments — Mail, Notes and Messages — and each had its
 * own copy of this, near enough identical that Messages' comment said so. All
 * three had the same two holes, which is what a third copy buys you.
 *
 * ## The two boundaries
 *
 * `root` is the CONFINEMENT: a configured directory, and nothing may be written
 * outside it. `directory` may only select a subdirectory of it — resolved
 * *against* the root, so a relative path lands inside and an absolute one is
 * caught. `name` is basename'd because it comes from message or note content,
 * which is attacker-controlled in exactly the way path traversal needs.
 *
 * ## What the copies got wrong
 *
 * **The check was lexical.** `startsWith(root + sep)` compares strings, and a
 * symlink is a string that points elsewhere: with any component of `directory` a
 * link, the path passed and the bytes landed outside. Both the root and the
 * directory are `realpath`ed here before they are compared, so the check is
 * about where the write actually goes.
 *
 * **`existsSync` then `writeFileSync` is check-then-act.** Between the two, the
 * name can be created — as a symlink to somewhere else, by anything that can
 * write to that directory. Without `overwrite`, the file is created with `wx`,
 * which fails if it exists rather than asking first, so the refusal and the
 * write are one operation the kernel performs.
 */
export type ConfinedWrite = {
  /** The confinement boundary. Created if it is not there. */
  root: string;
  /** An optional subdirectory of `root`, chosen by the caller. */
  directory?: string | undefined;
  /** The leaf name. Basename'd here; callers need not do it first. */
  name: string;
  /**
   * The content, or a function that produces it. A function is called only
   * once the destination has passed every check, so a refused write never pays
   * for reading or extracting what it would have written — Mail's extraction
   * parses the whole message file, which is a lot to spend on a traversal
   * attempt.
   */
  bytes: Uint8Array | (() => Uint8Array);
  overwrite?: boolean | undefined;
  /**
   * Named in the refusal, so the message says how to change the destination
   * rather than only that it was refused.
   */
  settingName: string;
};

/**
 * `realpath` for a directory that may not exist yet.
 *
 * Resolving the deepest existing ancestor and re-joining what is left is what
 * makes this usable before `mkdir`: a link anywhere in the existing part is
 * followed, and the part that does not exist yet cannot be a link to anything.
 */
const realpathOfNearest = (path: string): string => {
  let current = resolve(path);
  const trailing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...trailing.toReversed());
    } catch {
      const parent = resolve(current, "..");
      // The filesystem root exists, so this terminates.
      if (parent === current) return resolve(path);
      trailing.push(basename(current));
      current = parent;
    }
  }
};

export const writeConfinedFile = ({
  root,
  directory,
  name,
  bytes,
  overwrite = false,
  settingName,
}: ConfinedWrite): { path: string; bytes: number } => {
  const confinement = realpathOfNearest(root);
  const requested = directory ? resolve(confinement, directory) : confinement;
  const dir = realpathOfNearest(requested);
  if (dir !== confinement && !dir.startsWith(confinement + sep)) {
    throw new PreconditionError(
      `Refusing to write outside ${confinement}. Set ${settingName} to change the destination.`,
    );
  }

  const leaf = basename(name);
  const target = resolve(join(dir, leaf));
  if (target !== join(dir, leaf) || !target.startsWith(dir + sep)) {
    throw new PreconditionError(`Refusing to write outside ${dir}.`);
  }

  const data = typeof bytes === "function" ? bytes() : bytes;
  mkdirSync(dir, { recursive: true });
  try {
    // `wx` unless overwriting: the refusal and the write are one operation, so
    // nothing can appear between them.
    writeFileSync(target, data, { mode: 0o600, flag: overwrite ? "w" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new PreconditionError(`${target} already exists; refusing to overwrite it.`);
    }
    throw error;
  }
  return { path: target, bytes: data.length };
};
