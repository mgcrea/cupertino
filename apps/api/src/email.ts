// Delivering the key.
//
// Cloudflare Email Service, not a third-party sender. Same vendor as the Worker
// and the database, one dashboard, and the sender domain is verified in the
// account that already runs mgcrea.io's DNS — so there are no records to copy
// between two providers and get subtly wrong. It sends to arbitrary recipients,
// which the older Email Routing binding could not: that one could only reach
// addresses already verified as forwarding destinations, which is useless for
// reaching a customer.
//
// The page and the mail are both shipped, and they are not redundant. /thanks
// covers mail being slow or filtered; the mail covers the far more common case
// of closing the tab. A licence the buyer cannot find is indistinguishable from
// one they never received — and that is the case that becomes a chargeback,
// which costs about twice the sale price.
//
// The key goes in the body AND as an attachment. The body is what someone reads
// on a phone; the attachment is what they drop on the Licence window without
// selecting 224 characters of base64 by hand.

export type Sent = { ok: true } | { ok: false; reason: string };

const body = (key: string): string =>
  [
    "Here is your Cupertino licence key.",
    "",
    key,
    "",
    "Open Cupertino, choose Licence… from the menu bar icon, and paste it in — or",
    "drop the attached Cupertino.license file anywhere on that window.",
    "",
    "It covers every 1.x release, on every Mac you own or control, and it does not",
    "expire. Keep this message: replying to it is how you get the key re-sent.",
    "",
    "Thirty days, for any reason or none: reply and it is refunded in full.",
    "",
    "— Olivier",
  ].join("\n");

export const sendLicense = async (env: Env, to: string, key: string): Promise<Sent> => {
  try {
    await env.EMAIL.send({
      to,
      from: { email: env.LICENSE_FROM_EMAIL, name: "Cupertino" },
      replyTo: { email: "olivier@mgcrea.io", name: "Olivier Louvignes" },
      subject: "Your Cupertino licence key",
      text: body(key),
      attachments: [
        {
          disposition: "attachment",
          filename: "Cupertino.license",
          type: "text/plain",
          // Encoded bytes rather than a string: the field accepts either, and
          // "is this string raw or already base64" is not a question worth
          // discovering from a customer's mangled attachment.
          content: new TextEncoder().encode(`${key}\n`),
        },
      ],
    });
    return { ok: true };
  } catch (error) {
    // E_SENDER_NOT_VERIFIED lands here, and so does a plan that cannot send to
    // arbitrary recipients. Both are configuration, both are worth reading in
    // the Stripe event log rather than guessing at.
    return { ok: false, reason: `Email Service refused: ${String(error)}` };
  }
};
