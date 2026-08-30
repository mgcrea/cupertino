import { describe, expect, it } from "vitest";

import { extractCode } from "../src/client/codes.js";

/**
 * The negative table is the point of this file.
 *
 * A one-time-code extractor that is merely generous looks perfect against
 * positives and fails in production, because a real inbox is mostly numbers
 * that are not codes. Every NOT_A_CODE case below is a shape that a naive
 * `\d{4,8}` matches and a user would then have pasted into an auth prompt.
 */

const code = (text: string, fromShortcode = false) => extractCode(text, { fromShortcode });

describe("extractCode — the domain-bound format", () => {
  /**
   * The WebOTP convention Apple and Chrome both parse. It binds the origin to
   * the code, so there is nothing left to infer and it outranks everything.
   */
  it("takes the bound code and reports the origin", () => {
    const m = code("123456 is your Google verification code. @google.com #123456");
    expect(m).toMatchObject({ code: "123456", confidence: "high", matched: "domain-bound" });
    expect(m?.boundTo).toBe("google.com");
  });

  it("wins even when a decoy number comes first", () => {
    const m = code("Order 88213 shipped. Your code: 4471\n@shop.example.com #4471");
    expect(m).toMatchObject({ code: "4471", matched: "domain-bound" });
  });

  it("does not fire on a bare hash — an order number is not a code", () => {
    expect(code("Your order #99213 has shipped.")).toBeNull();
  });
});

describe("extractCode — keyword proximity", () => {
  it.each([
    ["Your verification code is 847213", "847213"],
    ["G-583014 is your Google verification code", "583014"],
    ["Code: 8721", "8721"],
    ["Use 4821 to sign in to your account", "4821"],
    ["Your one-time passcode is 55219", "55219"],
    ["472913 is your OTP. Do not share it.", "472913"],
    ["Your PIN is 9024", "9024"],
    ["Enter 662145 to confirm your login", "662145"],
  ])("reads %j", (text, expected) => {
    expect(code(text)?.code).toBe(expected);
  });

  /** Both orders occur in the wild, which is why the window is character-based. */
  it("reads the code before the keyword and after it", () => {
    expect(code("998211 is your security code")?.code).toBe("998211");
    expect(code("Your security code is 998211")?.code).toBe("998211");
  });

  it("marks a distant keyword as medium rather than high", () => {
    const near = code("Your code is 4471");
    const far = code("Your code for the account you opened is 4471");
    expect(near?.confidence).toBe("high");
    expect(far?.confidence).toBe("medium");
  });

  /**
   * The window has an edge and it is worth pinning: past it there is no signal
   * left, and inventing one from a keyword two sentences away is how an order
   * number becomes a login code.
   */
  it("returns null when the only keyword is beyond the window", () => {
    expect(code("Your code was sent to you in a separate message. Reference 88213.")).toBeNull();
  });
});

describe("extractCode — French", () => {
  it.each([
    ["Votre code de vérification est 847213", "847213"],
    ["Votre code de verification est 847213", "847213"],
    ["583014 est votre code à usage unique", "583014"],
    ["Code de connexion : 4471", "4471"],
    ["Votre code de sécurité est 22190", "22190"],
  ])("reads %j", (text, expected) => {
    expect(code(text)?.code).toBe(expected);
  });
});

describe("extractCode — NOT a code", () => {
  /**
   * Each of these contains a 4-to-8 digit run, and most contain a code word
   * too. Returning a number for any of them is the failure mode this module
   * exists to prevent.
   */
  it.each([
    ["a phone number", "Call us back on +1 555 123 4567 if this was not you."],
    ["a local phone number", "Reach the desk at 5551234567."],
    ["a price", "Your order total is $1,299.00 — thanks!"],
    ["a euro price", "Montant : 1299,00 € débité aujourd'hui."],
    ["a bare year", "Your subscription expires in 2027."],
    ["a tracking number", "Parcel 1Z999AA10123456784 is out for delivery."],
    ["a promo code", "Use promo code 55219 for 20% off your next order."],
    ["a French promo code", "Utilisez le code promo 55219 pour -20%."],
    ["a discount code", "Your discount code 4471 expires Friday."],
    ["a referral code", "Share your referral code 88213 with a friend."],
    ["a postal code", "Delivering to 75011 Paris tomorrow."],
    ["an account number", "Statement ready for account 400123456789."],
    ["a percentage", "You saved 15% on 3 items."],
    ["a plain sentence", "See you at the restaurant at 8."],
    ["an empty message", ""],
    ["no digits at all", "Your verification code is on its way."],
  ])("returns null for %s", (_label, text) => {
    expect(code(text)).toBeNull();
  });

  it("returns null for null and undefined", () => {
    expect(extractCode(null)).toBeNull();
    expect(extractCode(undefined)).toBeNull();
  });

  /**
   * A long message is a newsletter that happens to contain digits. The scoring
   * has no way to tell it from a notification, so length ends the question
   * before scoring starts.
   */
  it("returns null for a long message even with a keyword", () => {
    const long = `${"Thanks for reading our monthly update. ".repeat(12)} Your code is 4471.`;
    expect(long.length).toBeGreaterThan(400);
    expect(code(long)).toBeNull();
  });
});

describe("extractCode — the shortcode signal", () => {
  /**
   * Corroborating only. It has to raise a bare-digits message to usable without
   * ever manufacturing a match on its own, so the same text is tested both ways.
   */
  it("accepts bare digits from a shortcode, at low confidence", () => {
    expect(code("729104", true)).toMatchObject({
      code: "729104",
      confidence: "low",
      matched: "shortcode",
    });
  });

  it("rejects the same message from a person", () => {
    expect(code("729104", false)).toBeNull();
  });

  it("does not rescue a disqualified number", () => {
    expect(code("Call +1 555 123 4567", true)).toBeNull();
    expect(code("Total $1,299.00", true)).toBeNull();
  });

  it("does not apply to a long message from a shortcode", () => {
    expect(code(`${"Delivery update. ".repeat(10)}729104`, true)).toBeNull();
  });
});

describe("extractCode — ambiguity is reported, not hidden", () => {
  /**
   * Two equally-strong candidates means this function cannot separate them.
   * Downgrading is the honest answer: the tool description tells the model to
   * check the body on anything below "high", and that instruction is only
   * useful if "high" actually means unambiguous.
   */
  it("downgrades and flags when two candidates tie", () => {
    const m = code("Code 4471 or code 8823 — whichever arrived first");
    expect(m?.matched).toBe("keyword-ambiguous");
    expect(m?.confidence).toBe("medium");
  });

  it("does not flag a code repeated in one message", () => {
    const m = code("Your code is 4471. Enter 4471 to continue.");
    expect(m).toMatchObject({ code: "4471", matched: "keyword", confidence: "high" });
  });
});

describe("extractCode — boundaries", () => {
  it("accepts 4 through 8 digits and nothing outside that", () => {
    expect(code("Your code is 1234")?.code).toBe("1234");
    expect(code("Your code is 12345678")?.code).toBe("12345678");
    expect(code("Your code is 123")).toBeNull();
    expect(code("Your code is 123456789")).toBeNull();
  });

  it("takes the digits out of a letter-prefixed code", () => {
    // Google sends "G-123456"; the digits are what the user types.
    expect(code("G-583014 is your verification code")?.code).toBe("583014");
  });
});
