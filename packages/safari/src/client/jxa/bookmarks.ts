/**
 * The bookmark tree, including the Reading List.
 *
 * ## This runs through osascript but sends NO Apple Event
 *
 * The distinction matters and is easy to lose. The script below talks to
 * **Foundation**, not to Safari: it reads a file with
 * `NSDictionary.dictionaryWithContentsOfFile`. So it needs Full Disk Access,
 * which `osascript` inherits from whatever launched it, and it needs no
 * Automation grant, triggers no consent prompt, and works perfectly with Safari
 * closed. It is part of the FILE lane that happens to be spelled in JXA.
 *
 * ## Why not `plutil`
 *
 * MEASURED — the obvious approach fails outright:
 *
 *     $ plutil -convert json -o - ~/Library/Safari/Bookmarks.plist
 *     Bookmarks.plist: Invalid object in plist for JSON format
 *
 * Reading List entries carry `NSData` preview images, and JSON has no
 * representation for those, so the whole conversion aborts — not just the
 * offending key. Converting to XML and pattern-matching it can count fixed
 * literals but cannot track nesting, and nesting is the entire question: WHICH
 * leaves sit under the Reading List folder. Walking the native object graph
 * sidesteps it completely, because the data keys are simply never touched.
 *
 * ## The Reading List is identified by a fixed literal
 *
 * It is not its own file and not a flag. It is a folder whose `Title` is the
 * literal string `com.apple.ReadingList` — an identifier, not a display name,
 * so it does not change with the user's language. Matching a localised
 * "Reading List" would work on exactly one Mac.
 *
 * `DateLastViewed` is the entire unread/read distinction: present means opened,
 * absent means unread. There is no boolean anywhere.
 *
 * ## Verified against the failure, not yet against a real file
 *
 * docs/safari.md records this walk as rewritten after `plutil` failed and
 * verified against a fixture reproducing that exact error — but **not yet run
 * against a real `Bookmarks.plist`**. Everything below is defensive for that
 * reason: a missing key yields null rather than throwing, and a node that
 * cannot be read is skipped rather than aborting the walk.
 */

/**
 * Walk the tree and return every bookmark and Reading List entry.
 *
 * Unlike the probe's version, this returns the actual titles and URLs — that is
 * the server's whole job, where the probe's job was to prove the shape without
 * copying anybody's browsing out.
 *
 * `depth` is capped. A malformed or cyclic plist would otherwise recurse until
 * the process dies, and a bookmark bar nested a hundred deep is not a real
 * structure worth supporting.
 */
export const BOOKMARKS_WALK = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  ObjC.import("Foundation");

  var root = $.NSDictionary.dictionaryWithContentsOfFile(p.path);
  if (!root || root.isNil()) {
    return JSON.stringify({
      ok: false,
      error: { code: "UNREADABLE", message: "Bookmarks.plist could not be read as a plist." }
    });
  }

  var MAX_DEPTH = 32;
  var out = [];
  var folders = 0;
  var truncated = false;

  function unwrap(v) {
    if (!v || v.isNil()) return null;
    try { return ObjC.unwrap(v); } catch (e) { return null; }
  }
  function str(dict, key) {
    var v = unwrap(dict.objectForKey(key));
    return v === null || v === undefined ? null : String(v);
  }
  function has(dict, key) {
    var v = dict.objectForKey(key);
    return Boolean(v) && !v.isNil();
  }
  /** An NSDate to ISO-8601, via its seconds-since-1970. Null when absent. */
  function date(dict, key) {
    var v = dict.objectForKey(key);
    if (!v || v.isNil()) return null;
    try {
      var secs = v.timeIntervalSince1970;
      if (typeof secs !== "number" || !isFinite(secs)) return null;
      return new Date(secs * 1000).toISOString();
    } catch (e) {
      return null;
    }
  }

  function walk(node, depth, folderPath, inReadingList) {
    if (!node || node.isNil()) return;
    if (depth > MAX_DEPTH) { truncated = true; return; }

    var type = str(node, "WebBookmarkType");
    var title = str(node, "Title");

    // The container is a fixed identifier, never a localised display name.
    var isReadingListRoot = title === "com.apple.ReadingList";
    var within = inReadingList || isReadingListRoot;

    if (type === "WebBookmarkTypeLeaf") {
      var uri = node.objectForKey("URIDictionary");
      var leafTitle = null;
      if (uri && !uri.isNil()) leafTitle = str(uri, "title");
      if (leafTitle === null) leafTitle = title;

      var entry = {
        uuid: str(node, "WebBookmarkUUID"),
        url: str(node, "URLString"),
        title: leafTitle,
        folder: folderPath,
        readingList: false,
        dateAdded: null,
        dateLastViewed: null,
        previewText: null
      };

      var rl = node.objectForKey("ReadingList");
      if (rl && !rl.isNil()) {
        entry.readingList = true;
        entry.dateAdded = date(rl, "DateAdded");
        // Presence IS the read/unread flag. There is no boolean anywhere.
        entry.dateLastViewed = date(rl, "DateLastViewed");
        entry.previewText = str(rl, "PreviewText");
      } else if (within) {
        // Inside the container but with no ReadingList dictionary. Still a
        // Reading List item as far as the user is concerned.
        entry.readingList = true;
      }

      if (entry.url !== null) out.push(entry);
    } else if (type === "WebBookmarkTypeList") {
      folders++;
    }

    var kids = node.objectForKey("Children");
    if (kids && !kids.isNil()) {
      var n = kids.count;
      // The Reading List folder's own literal title is not a useful path
      // segment for a reader, so it is replaced by a stable readable name.
      //
      // The empty-string check is not defensive padding: the ROOT node is a
      // WebBookmarkTypeList whose Title is "", so treating any non-null title
      // as a segment prefixes every path with a leading slash.
      var named = title !== null && title !== "";
      var nextPath =
        type === "WebBookmarkTypeList" && named
          ? (isReadingListRoot
              ? "Reading List"
              : (folderPath === null ? title : folderPath + "/" + title))
          : folderPath;
      for (var i = 0; i < n; i++) walk(kids.objectAtIndex(i), depth + 1, nextPath, within);
    }
  }

  walk(root, 0, null, false);

  return JSON.stringify({
    ok: true,
    data: { entries: out, folders: folders, depthTruncated: truncated }
  });
}
`;
