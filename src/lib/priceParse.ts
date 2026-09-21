// Turns a weekly-ad listing into explicit regular / sale prices. Pure, so it is unit-tested directly.
//
// Weekly ads rarely print both numbers. What they print, and what we can conclude:
//   "4.99 lb" + "SAVE UP TO $2.00 LB"      -> sale 4.99, regular ~6.99 (approximate: "up to")
//   "13.99 per lb" + "save at least $6.00"  -> sale 13.99, regular >= 19.99 (we report 19.99)
//   "6.49 ea." + "Save $2.30"               -> sale 6.49, regular 8.79
//   "BUY 1 GET 1 FREE" (no price)           -> on sale, prices unknown, promo carries the deal
//   "HOT SALE!!!" / "Sale" with a price     -> on sale, regular unknown
//   "2.49 PER LB" and nothing else          -> advertised price, not flagged as a sale

export interface AdListing {
  current_price: number | null;
  original_price: number | null;
  pre_price_text: string | null;
  post_price_text: string | null;
  sale_story: string | null;
}

export interface ParsedPrice {
  regular_price: number | null;
  sale_price: number | null;
  unit_price: string | null;
  on_sale: boolean;
  promo_text: string | null;
  /** True when the regular price was worked out from "save up to"/"at least" wording. */
  regular_is_estimate: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Dollar or cents savings named in the text, e.g. "Save $2.30", "SAVE $4.50 LB", "Save 26¢". */
export function parseSavings(text: string | null): { amount: number; approximate: boolean } | null {
  if (!text) return null;
  const dollars = /save\s+(up\s+to\s+|at\s+least\s+)?\$\s?(\d+(?:\.\d{1,2})?)/i.exec(text);
  if (dollars) return { amount: Number(dollars[2]), approximate: Boolean(dollars[1]) };
  const cents = /save\s+(up\s+to\s+|at\s+least\s+)?(\d{1,2})\s?¢/i.exec(text);
  if (cents) return { amount: Number(cents[2]) / 100, approximate: Boolean(cents[1]) };
  return null;
}

const SALE_WORDS = /\b(sale|save|savings|off|bogo|buy\s*\d+\s*get\s*\d+|free|deal|special|rollback|half\s*price|digital\s*coupon)\b/i;

function unitLabel(price: number | null, post: string | null): string | null {
  if (price === null) return null;
  const unit = (post ?? "").toLowerCase().replace(/\bper\s+/, "").replace(/\bib\b/, "lb").replace(/[.\s]+$/, "").trim();
  if (!unit) return `$${price.toFixed(2)}`;
  if (/^lb|^ea|^each|^pk|^oz/.test(unit)) return `$${price.toFixed(2)}/${unit.replace(/^each$/, "ea")}`;
  return `$${price.toFixed(2)} ${unit}`;
}

export function parseAdListing(listing: AdListing): ParsedPrice {
  const promoParts = [listing.pre_price_text, listing.sale_story].map((s) => s?.trim()).filter(Boolean) as string[];
  const promo = promoParts.length ? promoParts.join(" — ") : null;
  const price = listing.current_price;
  const savings = parseSavings(listing.sale_story) ?? parseSavings(listing.pre_price_text);

  // A crossed-out original price is the cleanest signal when present.
  if (price !== null && listing.original_price !== null && listing.original_price > price) {
    return {
      regular_price: listing.original_price,
      sale_price: price,
      unit_price: unitLabel(price, listing.post_price_text),
      on_sale: true,
      promo_text: promo,
      regular_is_estimate: false,
    };
  }

  if (price !== null && savings) {
    return {
      regular_price: round2(price + savings.amount),
      sale_price: price,
      unit_price: unitLabel(price, listing.post_price_text),
      on_sale: true,
      promo_text: promo,
      regular_is_estimate: savings.approximate,
    };
  }

  const markedSale = promo !== null && SALE_WORDS.test(promo);
  if (markedSale) {
    return {
      regular_price: null,
      sale_price: price, // null for BOGO-style deals with no single price
      unit_price: unitLabel(price, listing.post_price_text),
      on_sale: true,
      promo_text: promo,
      regular_is_estimate: false,
    };
  }

  // Advertised at a price with no sale wording: report it as the current (regular) price.
  return {
    regular_price: price,
    sale_price: null,
    unit_price: unitLabel(price, listing.post_price_text),
    on_sale: false,
    promo_text: promo,
    regular_is_estimate: false,
  };
}
