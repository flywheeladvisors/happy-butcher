// Works out a comparable price per pound. Pure, so it's unit-tested directly.
//
// Stores price meat three ways: per pound ("$4.99/lb"), per package with a unit price printed
// ("$9.99", "$0.41 per oz."), and per package with the weight only in the product name
// ("Butcher's Specialty ground beef, 85% lean (32 oz.)", "Value Family Pack ... (Avg. 3 lbs)").
// All three can be compared once converted to a per-pound figure; anything with no weight at all
// stays a package price.

export type PerLbSource = "unit" | "derived";
export interface PerLb {
  price: number;
  source: PerLbSource;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Weight in pounds mentioned in a product name or pack-size text, if any. */
export function weightInPounds(text: string | null | undefined): number | null {
  if (!text) return null;
  // Ranges like "19.2 or 23-oz pkg." and "18.4 - 22 oz.": take the smaller weight, which keeps
  // the resulting per-pound price conservative (higher) rather than flattering.
  const range = String.raw`(\d+(?:\.\d+)?)(?:\s*(?:-|–|to|or)\s*(\d+(?:\.\d+)?))?\s*-?\s*`;
  const smallest = (m: RegExpExecArray) => Math.min(...[m[1], m[2]].filter(Boolean).map(Number));
  const lb = new RegExp(`${range}(?:lb|lbs|pound)s?\\b`, "i").exec(text);
  if (lb) return smallest(lb);
  const oz = new RegExp(`${range}(?:oz|ounce)s?\\b`, "i").exec(text);
  if (oz) return smallest(oz) / 16;
  return null;
}

/** A unit price printed on the listing, e.g. "$4.99/lb", "$0.41 per oz.", "$9.99 ea". */
export function perLbFromUnitText(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /\$\s?(\d+(?:\.\d+)?)\s*(?:\/|\s+per\s+|\s+)?\s*(lb|lbs|pound|oz|ounce)s?\b/i.exec(text);
  if (!m) return null;
  const amount = Number(m[1]);
  return /^o/i.test(m[2]) ? round2(amount * 16) : amount;
}

/**
 * The per-pound price for one offer:
 *   1. the listing's own per-lb (or per-oz) unit price  -> "unit"
 *   2. the package price divided by a weight in the product name or pack text -> "derived"
 * Null when nothing published gives a weight.
 */
export function perPound(offer: {
  price: number | null;
  unit_price?: string | null;
  product_name?: string | null;
  pack_text?: string | null;
}): PerLb | null {
  const fromUnit = perLbFromUnitText(offer.unit_price);
  if (fromUnit !== null) return { price: fromUnit, source: "unit" };
  if (offer.price === null) return null;
  const weight = weightInPounds(offer.pack_text) ?? weightInPounds(offer.product_name);
  if (weight && weight > 0) return { price: round2(offer.price / weight), source: "derived" };
  return null;
}
