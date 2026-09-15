// Whether the secrets this Worker needs are present and usable, said by NAME.
//
// A missing or malformed secret used to surface as whatever the first primitive
// to touch it threw: `importKey` refusing an empty HMAC key, `atob` refusing a
// signing key that is not base64. Either became a bare 500 with nothing in the
// log naming the secret, and a Stripe event log of retries that read like a
// code bug.
//
// Each check runs where its secret is first needed and returns a sentence for
// the log. The caller answers 500, so Stripe keeps retrying until the secret is
// fixed. No sentence here ever includes the value.

import { importSigningKey } from "./license";

export const webhookSecretProblem = (secret: string | undefined): string | null => {
  if (!secret) return "STRIPE_WEBHOOK_SECRET is not set";
  // Every endpoint secret Stripe issues starts so, from the dashboard and from
  // `stripe listen` alike. Anything else is another value pasted into this slot.
  if (!secret.startsWith("whsec_")) return "STRIPE_WEBHOOK_SECRET does not start with whsec_";
  return null;
};

export const signingKeyProblem = async (privateKey: string | undefined): Promise<string | null> => {
  if (!privateKey) return "LICENSE_SIGNING_KEY is not set";
  try {
    await importSigningKey(privateKey);
    return null;
  } catch {
    // The error itself is not repeated: it describes the bytes it choked on.
    return "LICENSE_SIGNING_KEY is not a base64 PKCS#8 Ed25519 private key";
  }
};
