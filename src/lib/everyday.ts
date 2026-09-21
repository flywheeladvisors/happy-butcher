// Best-priced offers per cut, sale or everyday alike. Pure, so it's unit-tested directly.
//
// Offers are ranked by the per-pound price you'd actually pay. A "$6.49 ea." package and a
// "$4.99/lb" family pack aren't comparable without the package weight (which listings rarely
// give), so package-priced items aren't ranked; sales among them are listed separately.

import type { PriceResult } from "./types";

type Result = PriceResult & { item: string };

export interface Offer {
  store: string;
  product_name: string | null;
  price: number; // what you'd pay: sale price when on sale, else regular
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
  /** Sales priced per package, which can't be ranked against per-lb prices. */
  package_sales: Offer[];
  /** How many stores had a comparable per-lb price. */
  compared: number;
}

/** The price per lb a result represents, or null when its unit isn't per pound. */
export function perLbPrice(r: Pick<PriceResult, "unit_price" | "sale_price" | "regular_price" | "on_sale">): number | null {
  if (!r.unit_price || !/\/\s*lb\b|\bper\s+lb\b|\blb\.?$/i.test(r.unit_price)) return null;
  const price = r.on_sale ? r.sale_price : r.regular_price;
  return price ?? null;
}

const toOffer = (r: Result, price: number): Offer => ({
  store: r.store,
  product_name: r.product_name,
  price,
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
      .map((r) => ({ r, p: perLbPrice(r) }))
      .filter((x): x is { r: Result; p: number } => x.p !== null)
      .sort((a, b) => a.p - b.p || Number(b.r.on_sale) - Number(a.r.on_sale));
    const cutoff = perLb[Math.min(topN, perLb.length) - 1]?.p;
    const ranked = perLb.filter((x) => cutoff !== undefined && x.p <= cutoff).map((x) => toOffer(x.r, x.p));
    const package_sales = rs
      .filter((r) => r.on_sale && perLbPrice(r) === null)
      .map((r) => toOffer(r, r.sale_price ?? r.regular_price ?? NaN))
      .sort((a, b) => (a.price || Infinity) - (b.price || Infinity));
    if (ranked.length || package_sales.length) out.push({ item, ranked, package_sales, compared: perLb.length });
  }
  return out;
}
