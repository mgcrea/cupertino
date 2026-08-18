import { describe, expect, it } from "vitest";

import {
  bestBody,
  decodeCharset,
  decodeEncodedWords,
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
    expect(listAttachments(parsePart(Buffer.from(stripped)))[0]?.inline).toBe(false);
  });

  it("decodes the headers it surfaces", () => {
    const headers = summaryHeaders(parsePart(Buffer.from(withAttachment)));
    expect(headers.subject).toBe("Invoice");
    expect(headers.from).toBe("Billing <billing@example.com>");
  });
});
