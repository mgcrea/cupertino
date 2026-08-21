// Delivering the key.
//
// Email and the /thanks page are both shipped from day one, and they are not
// redundant: the page covers the case where mail is slow or filtered, and the
// mail covers the far more common case of somebody closing the tab. A licence
// the customer cannot find is indistinguishable from one they never received.
//
// The key goes in the body AND as an attachment. The body is what someone reads
// on a phone; the attachment is what they drop on the Licence window without
// selecting 224 characters by hand.

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
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.LICENSE_FROM_EMAIL,
        to: [to],
        subject: "Your Cupertino licence key",
        text: body(key),
        attachments: [{ filename: "Cupertino.license", content: btoa(`${key}\n`) }],
      }),
    });
    if (!response.ok) {
      return { ok: false, reason: `Resend returned ${response.status}: ${await response.text()}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Resend unreachable: ${String(error)}` };
  }
};
