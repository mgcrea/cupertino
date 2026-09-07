import { describe, expect, it } from "vitest";

import {
  bestBody,
  decodeCharset,
  decodeEncodedWords,
  headerFilename,
  headerParam,
  htmlToText,
  listAttachments,
  parseHeaders,
  parsePart,
  partText,
  summaryHeaders,
} from "../src/client/mime.js";

const crlf = (s: string) => s.replaceAll("\n", "\r\n");

describe("RFC 2047 headers", () => {
  it("decodes base64 encoded words", () => {
    expect(decodeEncodedWords("=?UTF-8?B?RmFjdHVyZSA1NzUz?=")).toBe("Facture 5753");
  });

  it("decodes quoted-printable encoded words, with _ as space", () => {
    expect(decodeEncodedWords("=?UTF-8?Q?Votre_facture_=C3=A0_payer?=")).toBe(
      "Votre facture à payer",
    );
  });

  it("joins adjacent encoded words without inserting a space", () => {
    // The RFC says whitespace *between* encoded words is not part of the text.
    expect(decodeEncodedWords("=?UTF-8?Q?Domaine?= =?UTF-8?Q?_M=C3=A9lusine?=")).toBe(
      "Domaine Mélusine",
    );
  });

  it("keeps surrounding plain text intact", () => {
    expect(decodeEncodedWords("Re: =?UTF-8?B?SGVsbG8=?= (urgent)")).toBe("Re: Hello (urgent)");
  });

  it("leaves an unencoded header alone", () => {
    expect(decodeEncodedWords("Just a subject")).toBe("Just a subject");
  });

  it("survives an unknown charset instead of losing the text", () => {
    expect(decodeCharset(Buffer.from("hello"), "x-made-up")).toBe("hello");
  });

  it("decodes iso-8859-1", () => {
    expect(decodeCharset(Buffer.from([0x63, 0x61, 0x66, 0xe9]), "iso-8859-1")).toBe("café");
  });
});

describe("header parsing", () => {
  it("unfolds continuation lines", () => {
    const headers = parseHeaders(crlf("Subject: a very\n  long subject\nFrom: x@y.com"));
    expect(headers.find((h) => h.name === "Subject")?.value).toBe("a very long subject");
    expect(headers).toHaveLength(2);
  });

  it("extracts quoted and bare parameters", () => {
    expect(headerParam('multipart/mixed; boundary="abc123"', "boundary")).toBe("abc123");
    expect(headerParam("text/plain; charset=utf-8", "charset")).toBe("utf-8");
    expect(headerParam("text/plain", "charset")).toBeNull();
  });
});

describe("attachment filenames", () => {
  /**
   * A filename is the one MIME parameter that routinely is not ASCII, and it
   * has two encodings. Neither was handled: the RFC 2231 form returned null, so
   * an accented attachment was reported as having no filename at all — shown as
   * unretrievable and impossible to save — and the RFC 2047 form came back
   * verbatim, so saving it wrote a file literally named `=?utf-8?Q?...?=`.
   */
  it("decodes the RFC 2231 extended form", () => {
    expect(headerFilename(`attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`, null)).toBe(
      "résumé.pdf",
    );
  });

  it("decodes an RFC 2047 encoded word in a plain parameter", () => {
    expect(headerFilename(`attachment; filename="=?utf-8?Q?r=C3=A9sum=C3=A9=2Epdf?="`, null)).toBe(
      "résumé.pdf",
    );
  });

  it("joins RFC 2231 continuations, charset from the first segment only", () => {
    const header = `attachment; filename*0*=UTF-8''a%20very; filename*1*=%20long%20n%C3%A5me.txt`;
    expect(headerFilename(header, null)).toBe("a very long nåme.txt");
  });

  /** A continuation without its own star is literal text, `%` included. */
  it("does not percent-decode an unstarred continuation", () => {
    expect(headerFilename(`attachment; filename*0="100%"; filename*1=" off.txt"`, null)).toBe(
      "100% off.txt",
    );
  });

  it("honours a charset that is not UTF-8", () => {
    expect(headerFilename(`attachment; filename*=iso-8859-1''caf%E9.txt`, null)).toBe("café.txt");
  });

  it("still reads a plain quoted filename", () => {
    expect(headerFilename(`attachment; filename="notes.pdf"`, null)).toBe("notes.pdf");
  });

  it("falls back to the content-type name parameter", () => {
    expect(headerFilename(null, `image/png; name="=?utf-8?B?w6l0w6kucG5n?="`)).toBe("été.png");
  });

  it("prefers the extended form when a part carries both", () => {
    // Mailers emit an ASCII-mangled `filename` beside the real `filename*` for
    // clients that predate RFC 2231. The starred one is the true name.
    const header = `attachment; filename="resume.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`;
    expect(headerFilename(header, null)).toBe("résumé.pdf");
  });

  it("is null when there is no filename anywhere", () => {
    expect(headerFilename(`inline`, `text/plain; charset=utf-8`)).toBeNull();
  });
});

describe("bodies", () => {
  it("decodes quoted-printable", () => {
    const part = parsePart(
      Buffer.from(
        crlf(
          "Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nCaf=C3=A9 =\nau lait",
        ),
      ),
    );
    expect(partText(part)).toBe("Café au lait");
  });

  it("decodes base64", () => {
    const payload = Buffer.from("Hello, body", "utf8").toString("base64");
    const part = parsePart(
      Buffer.from(
        crlf(`Content-Type: text/plain\nContent-Transfer-Encoding: base64\n\n${payload}`),
      ),
    );
    expect(partText(part)).toBe("Hello, body");
  });

  it("prefers text/plain over text/html in a multipart/alternative", () => {
    const raw = crlf(
      [
        'Content-Type: multipart/alternative; boundary="B"',
        "",
        "--B",
        "Content-Type: text/plain",
        "",
        "the plain one",
        "--B",
        "Content-Type: text/html",
        "",
        "<p>the html one</p>",
        "--B--",
      ].join("\n"),
    );
    const picked = bestBody(parsePart(Buffer.from(raw)));
    expect(picked.from).toBe("text/plain");
    expect(picked.text).toBe("the plain one");
  });

  it("falls back to html converted to text", () => {
    const raw = crlf(
      [
        'Content-Type: multipart/alternative; boundary="B"',
        "",
        "--B",
        "Content-Type: text/html",
        "",
        "<h1>Hi</h1><p>There</p>",
        "--B--",
      ].join("\n"),
    );
    const picked = bestBody(parsePart(Buffer.from(raw)));
    expect(picked.from).toBe("text/html");
    expect(picked.text).toBe("Hi\nThere");
  });

  it("returns none when there is no readable part", () => {
    const part = parsePart(Buffer.from(crlf("Content-Type: application/octet-stream\n\n ")));
    expect(bestBody(part).from).toBe("none");
  });
});

describe("html to text", () => {
  it("strips scripts and styles rather than dumping their contents", () => {
    expect(htmlToText("<style>p{color:red}</style><p>Only this</p>")).toBe("Only this");
    expect(htmlToText("<script>alert(1)</script><p>Only this</p>")).toBe("Only this");
  });

  it("turns breaks and blocks into newlines and decodes entities", () => {
    expect(htmlToText("<p>a</p><p>b</p>")).toBe("a\nb");
    expect(htmlToText("x&nbsp;&amp;&nbsp;y &#233;")).toBe("x & y é");
  });

  it("collapses runaway blank lines to a single paragraph break", () => {
    expect(htmlToText("<p>a</p><br><br><br><p>b</p>")).toBe("a\n\nb");
  });
});

describe("attachments", () => {
  const withAttachment = crlf(
    [
      'Content-Type: multipart/mixed; boundary="M"',
      "Subject: =?UTF-8?B?SW52b2ljZQ==?=",
      "From: Billing <billing@example.com>",
      "",
      "--M",
      "Content-Type: text/plain",
      "",
      "See attached.",
      "--M",
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0=",
      "--M--",
    ].join("\n"),
  );

  it("lists them without returning their contents", () => {
    const found = listAttachments(parsePart(Buffer.from(withAttachment)));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      filename: "invoice.pdf",
      contentType: "application/pdf",
      inline: true,
    });
  });

  it("does not treat the readable body as an attachment", () => {
    expect(bestBody(parsePart(Buffer.from(withAttachment))).text).toBe("See attached.");
  });

  it("reports the DECODED size, not the transfer-encoded length", () => {
    // "Hello, attachment" is 17 bytes; its base64 is 24. Reporting `raw.length`
    // would inflate every base64 attachment by roughly a third.
    const payload = Buffer.from("Hello, attachment", "utf8");
    const raw = crlf(
      [
        'Content-Type: multipart/mixed; boundary="M"',
        "",
        "--M",
        'Content-Type: application/octet-stream; name="a.bin"',
        'Content-Disposition: attachment; filename="a.bin"',
        "Content-Transfer-Encoding: base64",
        "",
        payload.toString("base64"),
        "--M--",
      ].join("\n"),
    );
    const found = listAttachments(parsePart(Buffer.from(raw)));
    expect(found[0]?.sizeBytes).toBe(payload.length);
    expect(found[0]?.inline).toBe(true);
  });

  /**
   * The shape observed on real mail: Mail moved the attachment to its sidecar
   * tree and left one byte of delimiter whitespace behind. The old `raw.length
   * > 0` test read that as a present, 1-byte attachment.
   */
  it("treats a part stripped to leftover whitespace as absent", () => {
    const stray = crlf(
      [
        'Content-Type: multipart/mixed; boundary="M"',
        "",
        "--M",
        'Content-Type: application/pdf; name="Facture_5753.pdf"',
        'Content-Disposition: attachment; filename="Facture_5753.pdf"',
        "",
        " ",
        "--M--",
      ].join("\n"),
    );
    const found = listAttachments(parsePart(Buffer.from(stray)));
    expect(found[0]).toMatchObject({
      filename: "Facture_5753.pdf",
      inline: false,
      sizeBytes: null,
    });
  });

  it("does not trust X-Apple-Content-Length as a byte size", () => {
    // That header is the BASE64-ENCODED length: a 164156-byte PDF advertises
    // 224634. The parser reports null and lets readEmlx stat the real file.
    const stripped = crlf(
      [
        'Content-Type: multipart/mixed; boundary="M"',
        "",
        "--M",
        'Content-Type: application/pdf; name="Facture_5753.pdf"',
        'Content-Disposition: attachment; filename="Facture_5753.pdf"',
        "X-Apple-Content-Length: 224634",
        "",
        " ",
        "--M--",
      ].join("\n"),
    );
    const found = listAttachments(parsePart(Buffer.from(stripped)));
    expect(found[0]?.sizeBytes).toBeNull();
    expect(found[0]?.inline).toBe(false);
  });

  it("marks a stripped attachment as not inline", () => {
    const stripped = crlf(
      [
        'Content-Type: multipart/mixed; boundary="M"',
        "",
        "--M",
        'Content-Type: application/pdf; name="gone.pdf"',
        'Content-Disposition: attachment; filename="gone.pdf"',
        "",
        "--M--",
      ].join("\n"),
    );
    const found = listAttachments(parsePart(Buffer.from(stripped)))[0];
    expect(found?.inline).toBe(false);
    expect(found?.sizeBytes).toBeNull();
  });

  it("decodes the headers it surfaces", () => {
    const headers = summaryHeaders(parsePart(Buffer.from(withAttachment)));
    expect(headers.subject).toBe("Invoice");
    expect(headers.from).toBe("Billing <billing@example.com>");
  });
});
