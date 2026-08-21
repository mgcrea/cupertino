// Minting licence keys, in a Worker.
//
// The third implementation of one format, and the reason there are three is that
// none of them can import the others: scripts/lib/license.mjs runs on Node,
// apps/apple/Cupertino/License.swift runs inside a binary that is forbidden from
// making a network call, and this runs on workerd. What keeps them honest is
// that the signature covers the ENCODED payload rather than the parsed object,
// so JSON key order and whitespace never have to agree — only the bytes do.
//
// Field order in the object literal below is therefore load-bearing. Change it
// and every key this mints still verifies, because the verifier reads what was
// signed; but a key minted here and a key minted by the Node script for the same
// customer would differ, which would make "re-send their key" ambiguous.

const KEY_PREFIX = "cup1";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const fromBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** 10 characters of millisecond timestamp, 16 of randomness. Sortable by issue. */
export const ulid = (now: number = Date.now()): string => {
  let time = "";
  for (let remaining = now, i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(remaining % 32) + time;
    remaining = Math.floor(remaining / 32);
  }
  let random = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
    random += CROCKFORD.charAt(byte % 32);
  }
  return time + random;
};

export interface Minted {
  id: string;
  issuedAt: string;
  key: string;
}

export const mint = async (options: {
  email: string;
  major: number;
  privateKey: string;
  id?: string;
  issuedAt?: string;
}): Promise<Minted> => {
  const id = options.id ?? ulid();
  const issuedAt = options.issuedAt ?? new Date().toISOString();
  const encoder = new TextEncoder();
  const payload = toBase64Url(
    encoder.encode(JSON.stringify({ id, email: options.email, major: options.major, issuedAt })),
  );
  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64(options.privateKey),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("Ed25519", signingKey, encoder.encode(payload));
  return {
    id,
    issuedAt,
    key: `${KEY_PREFIX}.${payload}.${toBase64Url(new Uint8Array(signature))}`,
  };
};
