/**
 * Replace the content between the markers, preserving everything outside them.
 *
 * The markers stay in the file so the boundary is visible to a reader who has
 * never heard of the generator, and so a merge conflict lands inside a region
 * rather than silently reordering it.
 *
 * Shared by the surfaces, version and changelog generators. It lives here
 * rather than in `generate-surfaces.mjs` because that module validates
 * `surfaces.json` at import time and exits the process on a bad manifest, which
 * is not a thing an unrelated generator should inherit.
 */
export const region = (source, open, close, body, label) => {
  const start = source.indexOf(open);
  const end = source.indexOf(close);
  if (start === -1 || end === -1 || end < start) {
    console.error(`${label}: could not find the generated region (${open.trim()})`);
    process.exit(3);
  }
  return source.slice(0, start + open.length) + body + source.slice(end);
};
