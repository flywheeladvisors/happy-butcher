// Lowest everyday (non-sale) price per cut. Pure, so it's unit-tested directly.
//
// Only per-pound prices are compared: a "$6.49 ea." package and a "$4.99/lb" family pack aren't
// comparable without the package weight, which ads rarely print.

import type { PriceResult } from "./types";

export interface EverydayBest {
  item: string;
  store: string;
  product_name: string | null;
  per_lb: number;
  product_url: string | null;
  /** How many stores had a comparable everyday per-lb price. */
  compared: number;
}

/** The price per lb a result represents, or null when its unit isn't per pound. */
export function perLbPrice(r: Pick<PriceResult, "unit_price" | "sale_price" | "regular_price" | "on_sale">): number | null {
  if (!r.unit_price || !/\/\s*lb\b|\bper\s+lb\b|\blb\.?$/i.test(r.unit_price)) return null;
  const price = r.on_sale ? r.sale_price : r.regular_price;
  return price ?? null;
}

export function lowestEveryday(results: (PriceResult & { item: string })[]): EverydayBest[] {
  const byItem = new Map<string, (PriceResult & { item: string })[]>();
  for (const r of results) {
    // Verified, not on sale, priced per lb.
    if (r.status !== "found" || r.on_sale || perLbPrice(r) === null) continue;
    byItem.set(r.item, [...(byItem.get(r.item) ?? []), r]);
  }
  return [...byItem].map(([item, rs]) => {
    const best = rs.reduce((a, b) => (perLbPrice(b)! < perLbPrice(a)! ? b : a));
    return {
      item,
      store: best.store,
      product_name: best.product_name,
      per_lb: perLbPrice(best)!,
      product_url: best.product_url,
      compared: rs.length,
    };
  });
}
