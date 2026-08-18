// Probe body for spike 1. Deliberately tiny: it answers exactly one question —
// can the process that runs me read Mail's Envelope Index?
//
// Uses access(R_OK), never stat: stat SUCCEEDS on a TCC-protected file (you get
// the real size and mtime) and only open/access are denied, so a stat-based
// check would report success and prove nothing.

import { accessSync, appendFileSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const index = join(homedir(), "Library", "Mail", "V10", "MailData", "Envelope Index");

let readable = false;
let errno = null;
try {
  accessSync(index, constants.R_OK);
  readable = true;
} catch (err) {
  errno = err.code;
}

let sizeBytes = null;
try {
  sizeBytes = statSync(index).size;
} catch {
  sizeBytes = null;
}

const record = {
  at: new Date().toISOString(),
  readable,
  errno,
  sizeBytes,
  execPath: process.execPath,
  ppid: process.ppid,
  euid: process.geteuid?.() ?? null,
};

const line = JSON.stringify(record);
console.log(line);

const log = process.env.FDA_PROBE_LOG;
if (log) appendFileSync(log, `${line}\n`);

process.exit(readable ? 0 : 3);
