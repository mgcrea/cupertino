/**
 * The prompts on the homepage, and the whole capability argument.
 *
 * The hero promises an agent put to work in these apps; this is where that stops
 * being an adjective. Rules that keep the set honest:
 *
 * 1. **Every prompt carries a constraint** — an account, a date bound, a filter.
 *    Without one it reads as "it can list emails", which is the part nobody needs
 *    a server for. The constrained shape is also the one the naive Apple Events
 *    path answers in 74 s or answers wrongly; see docs/verify.md.
 * 2. **`uses` is checked against the shipped surfaces below**, so a prompt naming
 *    Messages cannot reach the homepage before Messages does. That check throws
 *    at build time rather than rendering a promise the tool list does not keep.
 * 3. **No host name.** Not "ask Claude" — any agent that speaks MCP.
 * 4. **At least one prompt has to make sense to someone who has never opened a
 *    JSON config**, and at least one has to need the write gate, or the gate
 *    reads as a footnote instead of a feature.
 */

import { SURFACES, type Surface } from "./surfaces";

export interface Example {
  /** What the reader would type, verbatim. */
  prompt: string;
  /** Which surfaces answer it. Validated against SURFACES at build time. */
  uses: readonly Surface["id"][];
  /** The one thing this example exists to prove. Shown as the caption. */
  proves: string;
  /** Needs `*_ALLOW_WRITES` on the surfaces it touches. */
  writes?: boolean;
}

export const EXAMPLES: readonly Example[] = [
  {
    prompt: "Look at how I write in my work inbox, then draft this reply in the same voice.",
    uses: ["mail"],
    proves:
      "Scoped to one account. APPLE_MAIL_ACCOUNTS bounds what can be read, not just what can be written.",
  },
  {
    prompt:
      "Pull together everything about the Atlas launch from my mail, my notes and my calendar. What do I still owe people?",
    uses: ["mail", "notes", "calendar"],
    proves: "Three surfaces, one grant — the payoff of shipping them in one bundle.",
  },
  {
    prompt: "Find every unread message from my accountant this quarter.",
    uses: ["mail"],
    proves:
      "A filter. This query shape costs 74 seconds over Apple Events; the index lane answers it in milliseconds.",
  },
  {
    prompt:
      "What is actually on my calendar next week once the repeating meetings are expanded? Block two hours before the release.",
    uses: ["calendar"],
    writes: true,
    proves:
      "Repeats expanded, and the window the answer covers reported with it — a short list is otherwise indistinguishable from a free afternoon.",
  },
  {
    prompt: "Turn the action items from yesterday's client thread into reminders, due Friday.",
    uses: ["mail", "reminders"],
    writes: true,
    proves: "Reads one surface, writes another. Both write gates off by default.",
  },
  {
    prompt: "What did Marc say about the deposit? He texted me sometime last spring.",
    uses: ["messages", "contacts"],
    proves:
      "Searches by name rather than by phone number, and reads the messages SQL alone cannot see — since March 2026, that is all of them.",
  },
  {
    prompt: "Did anyone ever reply to the invoice I sent on the 3rd?",
    uses: ["mail"],
    proves: "The whole pitch, for someone who has never edited a config file.",
  },
];

const SHIPPED_IDS = new Set(SURFACES.map((s) => s.id));

/**
 * Rule 2, enforced. `pnpm check` and `astro build` both evaluate this module, so
 * promoting a prompt ahead of its surface fails the build instead of shipping.
 */
for (const e of EXAMPLES) {
  for (const id of e.uses) {
    if (!SHIPPED_IDS.has(id)) {
      throw new Error(
        `examples.ts: "${e.prompt}" names the surface "${id}", which is not in data/surfaces.ts. ` +
          `Ship the surface before the prompt.`,
      );
    }
  }
}

/** Display name for a badge. The guard above means the lookup always resolves. */
export const surfaceName = (id: Surface["id"]): string =>
  SURFACES.find((s) => s.id === id)?.name ?? id;

/**
 * The hero's picture: one prompt, and the calls it became.
 *
 * It is deliberately NOT one of those above. `Examples.astro` sits directly
 * under the hero, and a reader who meets the same sentence twice inside one
 * screen learns nothing the second time.
 *
 * It obeys the four rules above and two more of its own:
 *
 * 5. **Every tool name is checked against `data/surfaces.ts`**, the same way
 *    `uses` is — a renamed or unshipped tool fails the build here rather than
 *    printing a call the servers do not register.
 * 6. **Every call is a READ tool**, checked below, which is the only reason the
 *    caption is allowed to say so. Showing a write above the fold would
 *    contradict the `writes off by default` chip three lines to its left.
 *
 * There is no answer in the picture, and there must not be one. What comes back
 * is the model's work, not Cupertino's; a mocked-up reply would be advertising
 * someone else's output as this product's. The same discipline as the Activity
 * rows, which carry tool names and their arguments, never message contents.
 */
export interface HeroCall {
  surface: Surface["id"];
  tool: string;
}

export const HERO_TURN: { prompt: string; calls: readonly HeroCall[] } = {
  prompt: "What did I promise Marie last week, and is any of it on my calendar?",
  calls: [
    // Contacts first, and that is the point of it: the prompt names a person,
    // and every other surface is addressed by handle.
    { surface: "contacts", tool: "apple_contacts_search_contacts" },
    { surface: "mail", tool: "apple_mail_search_messages" },
    { surface: "mail", tool: "apple_mail_get_thread" },
    { surface: "calendar", tool: "apple_calendar_list_events" },
  ],
};

/** Rules 5 and 6, enforced at build time. */
for (const call of HERO_TURN.calls) {
  const surface = SURFACES.find((s) => s.id === call.surface);
  if (!surface) {
    throw new Error(
      `examples.ts: HERO_TURN names the surface "${call.surface}", which is not in data/surfaces.ts.`,
    );
  }
  if (!surface.read.includes(call.tool)) {
    throw new Error(
      `examples.ts: HERO_TURN names "${call.tool}", which is not a READ tool of ${surface.name} ` +
        `in data/surfaces.ts. The hero caption claims every call is a read.`,
    );
  }
}
