import "server-only";
import { runCutInspector, type Verdict } from "./agents/cutInspector";
import { runDealHunter, type Finding } from "./agents/dealHunter";
import { EvidenceLocker } from "./agents/evidence";
import type { Trace } from "./agents/runtime";
import { parseAdListing } from "./priceParse";
import { listStores, savePriceChecks } from "./queries";
import type { PriceResult, Store } from "./types";

// get_item_prices: the Deal Hunter and Cut Inspector working one cut together.
//  1. Deal Hunter searches (weekly ads by ZIP, store ad pages, store websites in chat) and submits
//     one candidate per store, by evidence id.
//  2. Cut Inspector checks each against the evidence and approves, rejects, or marks unverified.
//  3. Rejected stores with a retry hint go back to the Hunter once, then back to the Inspector.
//  4. Prices come from the approved raw evidence via the deterministic parser (priceParse.ts).
// Every result is saved to price_checks.

const MAX_ROUNDS = 2;

export async function getItemPrices(
  item: string,
  meta: { source: "chat" | "weekly"; watchItemId?: number | null; trace: Trace },
): Promise<PriceResult[]> {
  const stores = await listStores();
  if (stores.length === 0) return [];
  const locker = new EvidenceLocker();
  const { trace } = meta;

  const findings = new Map<number, Finding>();
  const verdicts = new Map<number, Verdict>();
  let pending: Store[] = stores;
  let feedback: { store_id: number; hint: string }[] = [];

  for (let round = 1; round <= MAX_ROUNDS && pending.length > 0; round++) {
    if (round > 1) trace.add("Cut Inspector", "handoff", `sent ${pending.map((s) => s.name).join(", ")} back to the Deal Hunter`);
    else trace.add("Happy Butcher", "handoff", `asked the Deal Hunter to price "${item}" at ${stores.length} stores`);

    const found = await runDealHunter({ stores: pending, locker, mode: meta.source, item }, trace, feedback);
    for (const f of found) findings.set(f.store_id, f);

    trace.add("Deal Hunter", "handoff", `handed ${found.filter((f) => f.evidence_id).length} candidates to the Cut Inspector`);
    const judged = await runCutInspector({ stores: pending, locker, item }, found, trace);
    for (const v of judged) verdicts.set(v.store_id, v);

    feedback = judged.filter((v) => v.verdict === "reject" && v.retry_hint).map((v) => ({ store_id: v.store_id, hint: v.retry_hint! }));
    pending = stores.filter((s) => feedback.some((f) => f.store_id === s.id));
  }

  const results = stores.map((store) => buildResult(store, findings.get(store.id), verdicts.get(store.id), locker));
  await savePriceChecks(results, { itemQuery: item, watchItemId: meta.watchItemId ?? null, source: meta.source });
  return results;
}

function empty(store: Store): PriceResult {
  return {
    store_id: store.id,
    store: store.name,
    status: "not_found",
    product_name: null,
    regular_price: null,
    sale_price: null,
    unit_price: null,
    on_sale: false,
    promo_text: null,
    product_url: store.weekly_ad_url,
    note: null,
  };
}

function buildResult(store: Store, finding: Finding | undefined, verdict: Verdict | undefined, locker: EvidenceLocker): PriceResult {
  const evidence = locker.get(finding?.evidence_id);
  if (!verdict || !evidence || verdict.verdict === "reject") {
    return { ...empty(store), note: verdict?.reason ?? finding?.note ?? "Not in this week's ad" };
  }

  if (evidence.source === "product_page") {
    const x = finding?.extracted;
    if (!x || x.current_price === null) return { ...empty(store), status: "unverified", product_url: evidence.url, note: verdict.reason };
    const p = parseAdListing({ current_price: x.current_price, original_price: x.original_price, pre_price_text: null, post_price_text: x.unit_text, sale_story: x.promo_text });
    return {
      ...empty(store),
      // Product pages aren't pinned to our store, so they never count as verified.
      status: "unverified",
      product_name: x.product_name,
      regular_price: p.regular_price,
      sale_price: p.sale_price,
      unit_price: p.unit_price,
      on_sale: p.on_sale,
      promo_text: p.promo_text,
      product_url: evidence.url,
      note: `Not in this week's ad; online price, not confirmed for the ${store.city} store. ${verdict.reason}`,
    };
  }

  const p = parseAdListing(evidence.listing);
  let { regular_price, sale_price, on_sale } = p;
  const notes = [evidence.valid ? `Weekly ad, valid ${evidence.valid.replace(/^valid\s*/i, "")}` : "Weekly ad"];
  if (!on_sale && verdict.sale_from_history && evidence.listing.current_price !== null) {
    // Plain advertised price the Inspector judged a deal against this store's own price history.
    on_sale = true;
    sale_price = evidence.listing.current_price;
    regular_price = verdict.typical_regular_price;
    notes.push("sale judged from price history (no sale wording in the ad)");
  }
  if (p.regular_is_estimate) notes.push("regular price estimated from the ad's \"save up to/at least\" wording");
  if (on_sale && regular_price === null) notes.push("regular price not printed in the ad");

  return {
    ...empty(store),
    status: verdict.verdict === "approve" ? "found" : "unverified",
    product_name: evidence.product_name,
    regular_price,
    sale_price,
    unit_price: p.unit_price,
    on_sale,
    promo_text: p.promo_text,
    product_url: evidence.url,
    note: verdict.verdict === "approve" ? notes.join("; ") : `${verdict.reason}`,
  };
}
