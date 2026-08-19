import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Schema introspection for stores Apple owns and can reshape in any release.
 *
 * Nothing here assumes a column exists. The failure mode being avoided is a
 * `SELECT *` that starts throwing after a system update and takes the whole
 * server down with it.
 */

/** 2001-01-01T00:00:00Z in Unix seconds — the Core Data epoch. */
export const CORE_DATA_EPOCH_OFFSET = 978_307_200;

export const columnsOf = (db: DatabaseSync, table: string): string[] => {
  try {
    return (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
      (c) => c.name,
    );
  } catch {
    return [];
  }
};

/** Every table and its columns, for capability checks that name what is missing. */
export const tableMap = (db: DatabaseSync): Record<string, string[]> => {
  const names = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((r) => r.name);
  const tables: Record<string, string[]> = {};
  for (const t of names) tables[t] = columnsOf(db, t);
  return tables;
};

/**
 * A short hash of the whole DDL. Cheap drift detection: when Apple reshapes the
 * schema this changes, which turns "why did queries start failing after the
 * update" into a value you can compare against what was captured.
 */
export const fingerprintSchema = (db: DatabaseSync): string => {
  const ddl = db
    .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
    .all() as { sql: string }[];
  return createHash("sha256")
    .update(ddl.map((r) => r.sql).join("\n"))
    .digest("hex")
    .slice(0, 12);
};

/**
 * Work out whether a timestamp column is Unix seconds or Core Data seconds by
 * seeing which reading lands near today. Two independent prior-art projects
 * disagree about this for Mail, and hardcoding the wrong one puts every date 31
 * years out — a bug that looks like corruption rather than a unit mismatch.
 */
export const detectEpoch = (
  maxTimestamp: number | null,
  now: number = Date.now(),
): { offset: number; reason: string } => {
  if (maxTimestamp === null || !Number.isFinite(maxTimestamp) || maxTimestamp <= 0) {
    return { offset: 0, reason: "no dated rows; assuming unix seconds" };
  }
  const nowSec = now / 1000;
  const tenYears = 10 * 365.25 * 24 * 3600;
  const asUnix = Math.abs(nowSec - maxTimestamp);
  const asCoreData = Math.abs(nowSec - (maxTimestamp + CORE_DATA_EPOCH_OFFSET));

  if (asUnix < tenYears && asUnix <= asCoreData) {
    return { offset: 0, reason: "raw value lands within 10 years of now" };
  }
  if (asCoreData < tenYears) {
    return {
      offset: CORE_DATA_EPOCH_OFFSET,
      reason: "value + 978307200 lands within 10 years of now",
    };
  }
  return {
    offset: 0,
    reason: `neither epoch lands near now (max=${maxTimestamp}); assuming unix`,
  };
};
