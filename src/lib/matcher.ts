import "server-only";
import { z } from "zod";
import { chatCompletion, extractJson } from "./openrouter";

// Decides which weekly-ad listing (if any) at each store is the cut the household asked for.
// Plain substring matching gets this wrong constantly: "pork tenderloin" vs "marinated pork
// tenderloin" vs "pork loin", "Baby Back Ribs or Boneless Pork Tenderloin", "Beef Tenderloin" vs
// "Pork Tenderloin", so a model judges each candidate against explicit rules.

export interface Candidate {
  id: string;
  store_id: number;
  store: string;
  text: string; // product name plus price/promo wording, as printed
}

export interface MatchDecision {
  store_id: number;
  candidate_id: string | null;
  reason: string;
}

const MATCH_MODEL = () => process.env.MATCH_MODEL || "anthropic/claude-sonnet-5";

const RULES = `You match grocery weekly-ad listings to a shopper's meat cut. For each store, pick the ONE listing that is the requested cut, or none.

Rules:
- Same animal and same cut. "Beef tenderloin" is not "pork tenderloin". "Pork loin" (a roast/chop cut) is NOT "pork tenderloin"; but "Pork Loin Tenderloin(s)" IS pork tenderloin.
- Marinated / seasoned / pre-flavored / bacon-wrapped / stuffed / breaded / fully cooked products are DIFFERENT items from the plain cut. Only match them when the requested item itself says marinated (or the same preparation). And when the request says marinated, a plain cut does not match.
- Qualifiers in the request are requirements: "boneless" rejects bone-in; "(boneless)" likewise. Where the request doesn't specify (e.g. "ribeye steaks"), bone-in, boneless, thin-sliced, family pack, USDA grade, and brand are all fine.
- A listing with alternatives ("Baby Back Ribs or Boneless Pork Tenderloin", "Filet or Tenderloin") matches if one alternative is the requested cut under these rules.
- Request alternatives separated by "/" (e.g. "Filet mignon / beef tenderloin") mean either one is fine.
- "NY strip" = "New York strip" = "strip steak" = "KC strip". "London broil" also matches top round London broil. "Pork shoulder" matches Boston butt / pork butt; "picnic roast" means pork shoulder picnic (not Boston butt). "Chicken breasts" means raw breasts (tenders/cutlets of breast are fine); not wings, not rotisserie.
- Ground meat never matches a steak or roast request.
- If several listings at one store match, prefer the one explicitly on sale, then the lower per-pound price.
- When unsure, choose none and say why. A wrong match is worse than no match.`;

const Output = z.object({
  decisions: z.array(z.object({ store_id: z.number(), candidate_id: z.string().nullable(), reason: z.string() })),
});

export async function matchCandidates(item: string, stores: { id: number; name: string }[], candidates: Candidate[]): Promise<MatchDecision[]> {
  const byStore = stores.map((s) => ({
    store_id: s.id,
    store: s.name,
    candidates: candidates.filter((c) => c.store_id === s.id).map((c) => ({ id: c.id, listing: c.text })),
  }));
  const withAny = byStore.filter((s) => s.candidates.length > 0);
  const none = (reason: string) => (s: { store_id: number }) => ({ store_id: s.store_id, candidate_id: null, reason });
  if (withAny.length === 0) return byStore.map(none("No listings found in this week's ad"));

  const { content, toolCalls } = await chatCompletion({
    model: MATCH_MODEL(),
    temperature: 0,
    maxTokens: 2500,
    messages: [
      { role: "system", content: RULES },
      { role: "user", content: `Requested cut: "${item}"\n\nListings by store:\n${JSON.stringify(withAny, null, 1)}` },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "report_matches",
          description: "One decision per store listed.",
          parameters: {
            type: "object",
            properties: {
              decisions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    store_id: { type: "integer" },
                    candidate_id: { type: ["string", "null"], description: "Chosen listing id, or null if none match" },
                    reason: { type: "string", description: "One short sentence" },
                  },
                  required: ["store_id", "candidate_id", "reason"],
                },
              },
            },
            required: ["decisions"],
          },
        },
      },
    ],
    toolChoice: { type: "function", function: { name: "report_matches" } },
  });

  const raw = toolCalls[0]?.function.arguments ?? content ?? "";
  const parsed = Output.parse(extractJson(raw));
  const validIds = new Set(candidates.map((c) => c.id));
  return byStore.map((s) => {
    const d = parsed.decisions.find((x) => x.store_id === s.store_id);
    if (s.candidates.length === 0) return none("No listings found in this week's ad")(s);
    if (!d) return none("Matcher gave no decision")(s);
    const ok = d.candidate_id && validIds.has(d.candidate_id) && candidates.find((c) => c.id === d.candidate_id)?.store_id === s.store_id;
    return { store_id: s.store_id, candidate_id: ok ? d.candidate_id : null, reason: d.reason };
  });
}

/** Search terms for an item: each "/" alternative, qualifiers dropped, plus the core cut. */
export function searchTerms(item: string): string[] {
  const terms = new Set<string>();
  for (const alt of item.split("/")) {
    const base = alt
      .replace(/\(.*?\)/g, " ")
      .replace(/\bny\b/i, "new york")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!base) continue;
    const singular = base.replace(/(steak|chop|breast|thigh|roast|tenderloin|loin)s\b/g, "$1");
    terms.add(singular);
    // Core cut without leading qualifiers ("marinated pork tenderloin" -> "pork tenderloin").
    const words = singular.split(" ");
    if (words.length > 2) terms.add(words.slice(-2).join(" "));
  }
  return [...terms].slice(0, 4);
}
