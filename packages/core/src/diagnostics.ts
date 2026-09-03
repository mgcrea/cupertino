import type { BuildInfo } from "./build-info.js";

/**
 * The half of every surface's diagnostics report that is the same everywhere.
 *
 * ## Why this exists
 *
 * `apple_<surface>_diagnostics` is the tool an operator reaches for first, and
 * the eight surfaces had four incompatible ideas of what it should say. Three of
 * them — Notes, Reminders and Calendar — put their lane report under `server`
 * and so could not report their own VERSION at all: the first question anyone
 * asks about a misbehaving server had no answer. Four others reported a name and
 * a version and then nothing about how they were configured, so `maxResults`,
 * `indexMode` and the write gate were invisible on exactly the surfaces where
 * "why can the model not see that tool" gets asked.
 *
 * Nothing here is a new fact. It is the union of what the most complete of them
 * already reported, in one place, so a surface cannot quietly report less than
 * its neighbour.
 *
 * ## What belongs here, and what does not
 *
 * `server` is identity: which build is running. `settings` is the configuration
 * every surface has, from `BaseConfigSchema`. Everything else — lanes,
 * permissions, stores, caveats — is surface-specific and stays with the surface,
 * spread around this rather than folded into it.
 */
export type BaseDiagnosticsInput = {
  build: BuildInfo;
  /** The surface's own config. Only the fields every surface shares are read. */
  config: {
    exposePrompts: boolean;
    lazyTools: boolean;
    maxResults: number;
    /** Surfaces with a SQLite lane. Omitted by those without one. */
    indexMode?: string;
  };
  /**
   * Passed explicitly rather than read from `config`, because it is the tool
   * context that decides what was REGISTERED — and a report that read the flag
   * from somewhere other than the registration would be free to disagree with
   * it. Contacts' diagnostics said the surface had no mutating tool for three
   * releases after two shipped.
   */
  allowWrites: boolean;
};

export type BaseDiagnostics = {
  server: {
    name: string;
    version: string;
    gitCommit: string;
    node: string;
    platform: string;
  };
  settings: {
    allowWrites: boolean;
    exposePrompts: boolean;
    lazyTools: boolean;
    maxResults: number;
    indexMode?: string;
  };
};

export const buildBaseDiagnostics = ({
  build,
  config,
  allowWrites,
}: BaseDiagnosticsInput): BaseDiagnostics => ({
  server: {
    name: build.name,
    version: build.version,
    gitCommit: build.gitCommit,
    // The runtime rather than the package's engines field: a server started
    // under the app's embedded node and one started by `npx` are different
    // enough that the answer matters, and it is the first thing to check when
    // `node:sqlite` behaves differently on two machines.
    node: process.version,
    platform: process.platform,
  },
  settings: {
    // First, and on every surface. With writes off the mutating tools are not
    // registered at all, so this is where a client learns why it cannot see
    // them — and the same for `exposePrompts` and the resources.
    allowWrites,
    exposePrompts: config.exposePrompts,
    // On, the client sees a search tool and a dispatcher instead of the tool
    // list, so a missing tool is expected rather than a fault — and this is the
    // one tool that still says which of the two it is looking at.
    lazyTools: config.lazyTools,
    maxResults: config.maxResults,
    ...(config.indexMode === undefined ? {} : { indexMode: config.indexMode }),
  },
});
