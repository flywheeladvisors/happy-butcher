// Weekly-ad pages we can scrape directly because the store is set by URL (so prices are for that
// store, not a chain default). Today that's Publix (?setstorenumber=). Parsing is pure and
// unit-tested; fetching/caching lives in scrapedAds.ts.

import type { AdListing } from "./priceParse";

export interface PageListing extends AdListing {
  product_name: string;
  details: string | null;
  valid_text: string | null;
}

export interface AdPageSource {
  chain: RegExp;
  /** Store-scoped page URL, or null if this store lacks what the URL needs. */
  url: (store: { store_number: string | null }) => string | null;
  /** The page must prove it's showing our store, or we don't trust its prices. */
  confirmsStore: (markdown: string) => boolean;
  parse: (markdown: string) => PageListing[];
}

const PRICE_RE = /^\$(\d+(?:\.\d{1,2})?)\s*(.*)$/;

/** Publix weekly ad: item blocks separated by "Add to list", fields on their own lines. */
export function parsePublixAd(markdown: string): PageListing[] {
  const listings: PageListing[] = [];
  for (const block of markdown.split(/\n\s*Add to list\s*\n/)) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("- ![") && !l.startsWith("![") && !l.startsWith("[") && !l.startsWith("- ["));
    const priceIdx = lines.findIndex((l) => PRICE_RE.test(l) || /^buy\s*\d+\s*get\s*\d+/i.test(l));
    if (priceIdx < 1) continue;
    const product_name = lines[priceIdx - 1];
    if (product_name.length > 160) continue;
    const rest = lines.slice(priceIdx + 1, priceIdx + 6);
    const price = PRICE_RE.exec(lines[priceIdx]);
    const saveLine = rest.find((l) => /save|off\b/i.test(l)) ?? null;
    const validLine = rest.find((l) => /^valid\b/i.test(l)) ?? null;
    const details = rest.find((l) => l !== saveLine && l !== validLine && !PRICE_RE.test(l)) ?? null;
    listings.push({
      product_name,
      details,
      valid_text: validLine,
      current_price: price ? Number(price[1]) : null,
      original_price: null,
      pre_price_text: price ? null : lines[priceIdx],
      post_price_text: price ? price[2].trim() || null : null,
      sale_story: saveLine,
    });
  }
  return listings;
}

export const AD_PAGE_SOURCES: AdPageSource[] = [
  {
    chain: /publix/i,
    url: (s) => (s.store_number ? `https://www.publix.com/savings/weekly-ad/meat?setstorenumber=${s.store_number}` : null),
    confirmsStore: (md) => /your store has been set to/i.test(md),
    parse: parsePublixAd,
  },
];

export const adPageSourceFor = (storeName: string) => AD_PAGE_SOURCES.find((s) => s.chain.test(storeName)) ?? null;
