/** The Node twin under test, which ships no types of its own. */
declare module "*/license.mjs" {
  export const generateKeypair: () => { privateKey: string; publicKey: string };
  export const mint: (options: {
    email: string;
    major: number;
    privateKey: string;
    id?: string;
    issuedAt?: string;
  }) => string;
  export const verifyKey: (
    key: string,
    options: { major?: number; publicKey: string; revoked?: string[] },
  ) => {
    ok: boolean;
    reason: string;
    claims?: { id: string; email: string; major: number; issuedAt: string };
  };
}

/** The D1 stand-in the handler tests run against, plain JavaScript over node:sqlite. */
declare module "*/d1.mjs" {
  export const createD1: () => {
    binding: D1Database;
    sql: (query: string, ...params: (string | number | null)[]) => Record<string, unknown>[];
  };
}
