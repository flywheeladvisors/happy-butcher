import "server-only";
import { fallbackLookup } from "./fallback";
import { flippItemUrl, sameMerchant, searchFlipp, type FlippItem } from "./flipp";
import { matchCandidates, searchTerms, type Candidate } from "./matcher";
import { parseAdListing, type AdListing } from "./priceParse";
import { listStores, savePriceChecks } from "./queries";
import { getScrapedAd, type ScrapedAd } from "./scrapedAds";
import type { PriceResult, Store } from "./types";

// get_item_prices: one cut, every saved store.
//  1. Weekly-ad listings for each store's ZIP from Flipp (all six chains, location-scoped).
//  2. The store's own weekly-ad page via Firecrawl where the store can be pinned by URL (Publix).
//  3. A model picks the listing per store that really is the requested cut (see matcher.ts).
//  4. Prices are split into regular vs sale deterministically (priceParse.ts).
//  5. Chat only: stores with no ad match get a Tavily + Firecrawl product-page lookup ("unverified").
// Every result is saved to price_checks.

const DEFAULT_ZIP = "27513";

const describe = (l: AdListing & { name: string; extra?: string | null }) =>
  [
    l.name,
    l.extra,
    [l.pre_price_text, l.current_price !== null ? `$${l.current_price}` : null, l.post_price_text].filter(Boolean).join(" "),
    l.sale_story,
  ]
    .filter(Boolean)
    .join(" | ");

async function flippListings(stores: Store[], terms: string[]) {
  const zips = [...new Set(stores.map((s) => s.zip ?? DEFAULT_ZIP))];
  // Keyed by zip too: the same flyer item comes back for neighboring ZIPs.
  const byId = new Map<string, FlippItem & { zip: string }>();
  const errors: string[] = [];
  await Promise.all(
    zips.flatMap((zip) =>
      terms.map(async (term) => {
        try {
          for (const item of await searchFlipp(term, zip)) byId.set(`${zip}:${item.id}`, { ...item, zip });
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }),
    ),
  );
  return { items: [...byId.values()], failed: errors.length === zips.length * terms.length };
}

export async function getItemPrices(
  item: string,
  meta: { source: "chat" | "weekly"; watchItemId?: number | null },
): Promise<PriceResult[]> {
  const stores = await listStores();
  if (stores.length === 0) return [];
  const terms = searchTerms(item);
  const keywords = terms.map((t) => t.split(" ").at(-1)!);

  const [flipp, scraped] = await Promise.all([
    flippListings(stores, terms),
    Promise.all(stores.map(async (s) => [s.id, await getScrapedAd(s)] as const)).then((pairs) => new Map<number, ScrapedAd>(pairs)),
  ]);

  // Candidate listings per store, with ids the matcher can point back to.
  const candidates: Candidate[] = [];
  const lookup = new Map<string, { listing: AdListing; name: string; url: string; valid: string | null }>();
  for (const store of stores) {
    for (const f of flipp.items) {
      if (!sameMerchant(store.name, f.merchant_name) || f.zip !== (store.zip ?? DEFAULT_ZIP)) continue;
      const id = `F${f.id}`;
      candidates.push({ id, store_id: store.id, store: store.name, text: describe(f) });
      lookup.set(id, { listing: f, name: f.name, url: flippItemUrl(f), valid: `${f.valid_from.slice(5, 10)} to ${f.valid_to.slice(5, 10)}` });
    }
    const ad = scraped.get(store.id);
    if (ad?.status === "ok") {
      ad.listings.forEach((l, i) => {
        if (!keywords.some((k) => l.product_name.toLowerCase().includes(k))) return;
        const id = `P${store.id}-${i}`;
        candidates.push({ id, store_id: store.id, store: store.name, text: `${describe({ ...l, name: l.product_name, extra: l.details })} (store's own site)` });
        lookup.set(id, { listing: l, name: l.details ? `${l.product_name}, ${l.details}` : l.product_name, url: ad.url, valid: l.valid_text });
      });
    }
  }

  const decisions = await matchCandidates(item, stores, candidates);

  const results = await Promise.all(
    stores.map(async (store): Promise<PriceResult> => {
      const decision = decisions.find((d) => d.store_id === store.id);
      const chosen = decision?.candidate_id ? lookup.get(decision.candidate_id) : undefined;
      if (chosen) {
        const p = parseAdListing(chosen.listing);
        const notes = [
          chosen.valid ? `Weekly ad, valid ${chosen.valid.replace(/^valid\s*/i, "")}` : "Weekly ad",
          p.regular_is_estimate ? "regular price estimated from the ad's \"save up to/at least\" wording" : null,
          p.on_sale && p.regular_price === null ? "regular price not printed in the ad" : null,
        ];
        return {
          store_id: store.id,
          store: store.name,
          status: "found",
          product_name: chosen.name,
          regular_price: p.regular_price,
          sale_price: p.sale_price,
          unit_price: p.unit_price,
          on_sale: p.on_sale,
          promo_text: p.promo_text,
          product_url: chosen.url,
          note: notes.filter(Boolean).join("; "),
        };
      }

      const adTrouble = flipp.failed ? "Weekly-ad lookup failed" : null;
      if (meta.source === "chat") {
        try {
          const fb = await fallbackLookup(store, item, terms);
          return adTrouble ? { ...fb, note: `${adTrouble}. ${fb.note}` } : fb;
        } catch (err) {
          return notFound(store, `Not in this week's ad; product page lookup failed (${err instanceof Error ? err.message : err}).`, "unverified");
        }
      }
      return adTrouble ? notFound(store, adTrouble, "unverified") : notFound(store, `Not in this week's ad (${decision?.reason ?? "no match"})`);
    }),
  );

  await savePriceChecks(results, { itemQuery: item, watchItemId: meta.watchItemId ?? null, source: meta.source });
  return results;
}

function notFound(store: Store, note: string, status: "not_found" | "unverified" = "not_found"): PriceResult {
  return {
    store_id: store.id,
    store: store.name,
    status,
    product_name: null,
    regular_price: null,
    sale_price: null,
    unit_price: null,
    on_sale: false,
    promo_text: null,
    product_url: store.weekly_ad_url,
    note,
  };
}
