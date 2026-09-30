// Best-priced offers per cut, sale or everyday alike. Pure, so it's unit-tested directly.
//
// Offers are ranked by price per pound (price_checks.per_lb_price), which comes from the listing's
// own unit price or from a weight in the product name (see perPound.ts). Listings that publish no
// weight at all can't be compared; their sales are listed separately.

import type { PriceResult } from "./types";

type Result = PriceResult & { item: string };

export interface Offer {
  store: string;
  product_name: string | null;
  /** Price per pound, when one could be worked out. */
  per_lb: number | null;
  /** "derived" means it came from a package weight rather than a printed per-lb price. */
  per_lb_source: "unit" | "derived" | null;
  /** The price as listed (per package when per_lb is null). */
  price: number;
  regular_price: number | null;
  on_sale: boolean;
  unit_price: string | null;
  promo_text: string | null;
  product_url: string | null;
  note: string | null;
}

export interface CutOffers {
  item: string;
  /** Cheapest per-lb offers first (top N, plus anything tied with the Nth). */
  ranked: Offer[];
  /** Sales with no published weight, so no per-lb comparison. */
  package_sales: Offer[];
  /** How many stores had a comparable per-lb price. */
  compared: number;
}

const paid = (r: Result) => (r.on_sale ? r.sale_price : r.regular_price) ?? r.regular_price ?? r.sale_price;

const toOffer = (r: Result): Offer => ({
  store: r.store,
  product_name: r.product_name,
  per_lb: r.per_lb_price,
  per_lb_source: r.per_lb_source,
  price: paid(r) ?? NaN,
  regular_price: r.regular_price,
  on_sale: r.on_sale,
  unit_price: r.unit_price,
  promo_text: r.promo_text,
  product_url: r.product_url,
  note: r.note,
});

export function bestOffers(results: Result[], topN = 3): CutOffers[] {
  const byItem = new Map<string, Result[]>();
  for (const r of results) {
    if (r.status !== "found") continue; // verified prices only
    byItem.set(r.item, [...(byItem.get(r.item) ?? []), r]);
  }
  const out: CutOffers[] = [];
  for (const [item, rs] of byItem) {
    const perLb = rs
      .filter((r) => r.per_lb_price !== null)
      .map(toOffer)
      .sort((a, b) => a.per_lb! - b.per_lb! || Number(b.on_sale) - Number(a.on_sale));
    const cutoff = perLb[Math.min(topN, perLb.length) - 1]?.per_lb ?? null;
    const ranked = cutoff === null ? [] : perLb.filter((o) => o.per_lb! <= cutoff);
    const package_sales = rs
      .filter((r) => r.on_sale && r.per_lb_price === null)
      .map(toOffer)
      .sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
    if (ranked.length || package_sales.length) out.push({ item, ranked, package_sales, compared: perLb.length });
  }
  return out;
}
