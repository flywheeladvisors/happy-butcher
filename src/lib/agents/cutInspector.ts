import "server-only";
import { z } from "zod";
import { all, sql } from "../db";
import { parseAdListing } from "../priceParse";
import type { Store } from "../types";
import type { Finding } from "./dealHunter";
import { listingText, type EvidenceLocker } from "./evidence";
import { agentModel, runAgent, type AgentSpec, type AgentTool, type Trace } from "./runtime";

// Cut Inspector: the skeptic. Checks every Deal Hunter finding against the evidence: is it really
// the requested cut, is the "sale" really a sale, did the Hunter read the page correctly? It can
// approve, mark unverified, or reject and send the Hunter back with a hint.

export interface InspectorCtx {
  stores: Store[];
  locker: EvidenceLocker;
  item: string;
}

export interface Verdict {
  store_id: number;
  verdict: "approve" | "reject" | "unverified";
  /** Inspector judged a plain advertised price to be a sale from price history. */
  sale_from_history: boolean;
  typical_regular_price: number | null;
  reason: string;
  retry_hint: string | null;
}

const tools: AgentTool<InspectorCtx>[] = [
  {
    name: "get_evidence",
    description: "Full raw evidence for an evidence_id (ad listing fields, or the scraped page text).",
    parameters: { type: "object", properties: { evidence_id: { type: "string" } }, required: ["evidence_id"] },
    describe: (a) => `examined evidence ${a.evidence_id}`,
    async run(args, ctx) {
      return ctx.locker.get(String(args.evidence_id)) ?? { error: "No such evidence" };
    },
  },
  {
    name: "parse_ad_price",
    description:
      "Deterministic price parse of weekly-ad evidence: regular_price, sale_price, on_sale, and whether the regular price is estimated from 'save up to' wording.",
    parameters: { type: "object", properties: { evidence_id: { type: "string" } }, required: ["evidence_id"] },
    describe: (a) => `parsed prices on ${a.evidence_id}`,
    async run(args, ctx) {
      const e = ctx.locker.get(String(args.evidence_id));
      if (!e) return { error: "No such evidence" };
      if (e.source === "product_page") return { error: "Product-page evidence has no ad listing; check the Hunter's quote against the page text instead." };
      return parseAdListing(e.listing);
    },
  },
  {
    name: "price_history",
    description:
      "Past price checks for this cut at one store (most recent first): product, regular/sale price, on_sale, date. Use it to judge whether an advertised price with no sale wording is actually a deal.",
    parameters: { type: "object", properties: { store_id: { type: "integer" } }, required: ["store_id"] },
    describe: (a) => `pulled price history for store ${a.store_id}`,
    async run(args, ctx) {
      return all(sql`
        select to_jsonb(x) as row from (
          select product_name, regular_price, sale_price, on_sale, checked_at::date as date
          from public.price_checks
          where store_id = ${Number(args.store_id)} and status = 'found' and lower(item_query) = lower(${ctx.item})
          order by checked_at desc limit 10) x`);
    },
  },
];

const SYSTEM = `You are the Cut Inspector on the Happy Butcher's team: a meticulous, skeptical butcher who checks the Deal Hunter's work before anything reaches the customer. A wrong answer is worse than no answer.

For each store's finding, decide:
1. Is it the requested cut? Same animal and cut. Marinated/seasoned/bacon-wrapped/stuffed/breaded/cooked products are DIFFERENT from the plain cut (and a plain cut doesn't satisfy a "marinated" request). "Pork loin" is not "pork tenderloin", but "pork loin tenderloin" is tenderloin. "Boneless" in the request rejects bone-in. Listings with alternatives ("X or Y") match if one alternative matches. "NY strip" = "New York strip" = "strip steak". Ground meat never matches a steak/roast. Ground beef lean ratios must match exactly: "80/20" = "80% lean" (often sold as ground chuck), "85/15" = "85% lean" (often ground round), "90/10" = "90% lean" (often ground sirloin); a different ratio (e.g. 93/7 for a 90/10 request) is a different item. A listing that names no ratio doesn't match a ratio request unless it offers that ratio as an alternative. "Filet mignon / beef tenderloin" means either.
2. Is the price read right? For ad evidence, use parse_ad_price rather than your own arithmetic. For product_page evidence, get_evidence and confirm the Hunter's quote and numbers really appear in the page text for that product.
3. Is it really on sale? The parser flags explicit sale wording. If an ad shows a plain price with no sale wording, check price_history: only set sale_from_history=true when history shows this store's regular price for the cut was clearly higher (give typical_regular_price). Otherwise leave it false.

Verdicts:
- approve: right cut, price read correctly.
- unverified: right cut, but the price can't be trusted for our store (e.g. a product page with no store location or a different store's location than ours, or a quote you couldn't find). Name the location a page shows if it isn't ours.
- reject: wrong cut or misread. If the Hunter could plausibly find the right item (e.g. it picked the marinated one but the plain one might be in the ad), give a concrete retry_hint; otherwise retry_hint null.
Stores with no evidence: reject with retry_hint null and reason "nothing found".

Work in parallel: request all the evidence and price parses you need in one turn, then decide. Aim to finish in 2-3 turns.

Finish with submit_verdicts: exactly one per store.`;

const VerdictSchema = z.object({
  store_id: z.number().int(),
  verdict: z.enum(["approve", "reject", "unverified"]),
  sale_from_history: z.boolean().optional().default(false),
  typical_regular_price: z.number().nullable().optional().default(null),
  reason: z.string(),
  retry_hint: z.string().nullable().optional().default(null),
});

function inspectorSpec(storeIds: number[]): AgentSpec<InspectorCtx, Verdict[]> {
  return {
    name: "Cut Inspector",
    system: SYSTEM,
    tools,
    model: agentModel("inspector"),
    maxRounds: 10,
    // Seven stores' verdicts with reasons need room; a truncated submission arrives empty.
    maxTokens: 6000,
    submit: {
      name: "submit_verdicts",
      description: "Your verdict on each store's finding.",
      parameters: {
        type: "object",
        properties: {
          verdicts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                store_id: { type: "integer" },
                verdict: { type: "string", enum: ["approve", "reject", "unverified"] },
                sale_from_history: { type: "boolean" },
                typical_regular_price: { type: ["number", "null"] },
                reason: { type: "string", description: "One short sentence" },
                retry_hint: { type: ["string", "null"], description: "One short sentence, or null" },
              },
              required: ["store_id", "verdict", "reason"],
            },
          },
        },
        required: ["verdicts"],
      },
      parse: (raw) => {
        const verdicts = z.object({ verdicts: z.array(VerdictSchema) }).parse(raw).verdicts;
        const missing = storeIds.filter((id) => !verdicts.some((v) => v.store_id === id));
        if (missing.length) throw new Error(`Missing verdicts for store_id ${missing.join(", ")}`);
        return verdicts;
      },
    },
  };
}

export async function runCutInspector(ctx: InspectorCtx, findings: Finding[], trace: Trace): Promise<Verdict[]> {
  const lines = findings.map((f) => {
    const store = ctx.stores.find((s) => s.id === f.store_id);
    const e = ctx.locker.get(f.evidence_id);
    const shown = !e
      ? "no evidence"
      : e.source === "product_page"
        ? `product page ${e.url}; Hunter read: ${JSON.stringify(f.extracted)}`
        : `${{ weekly_ad: "weekly ad", store_ad_page: "store's own ad page", store_catalog: "store's own catalog, pinned to our store" }[e.source]}: "${e.product_name}" | ${listingText(e.listing)}`;
    const where = store ? `${store.name}, our store at ${store.address ?? `${store.city}, ${store.state} ${store.zip ?? ""}`}` : "unknown store";
    return `- store_id ${f.store_id} (${where}): evidence ${f.evidence_id ?? "none"}: ${shown}. Hunter's note: ${f.note}`;
  });
  return runAgent(inspectorSpec(findings.map((f) => f.store_id)), `Requested cut: "${ctx.item}"\n\nDeal Hunter's findings:\n${lines.join("\n")}`, ctx, trace);
}
