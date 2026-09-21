import "server-only";

// Flipp aggregates grocery weekly ads by postal code, so it gives location-correct circular prices
// for all six chains. This is Flipp's public (unofficial, keyless) search endpoint, used by its own
// web app; if it changes, lookups fall back to Firecrawl/Tavily and come back "unverified".

export interface FlippItem {
  id: number;
  flyer_id: number;
  merchant_name: string;
  name: string;
  current_price: number | null;
  original_price: number | null;
  pre_price_text: string | null;
  post_price_text: string | null;
  sale_story: string | null;
  valid_from: string;
  valid_to: string;
}

const toNumber = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export async function searchFlipp(query: string, postalCode: string, now = new Date()): Promise<FlippItem[]> {
  const url = `https://backflipp.wishabi.com/flipp/items/search?locale=en-us&postal_code=${encodeURIComponent(postalCode)}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (HappyButcher price watch)" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Flipp search failed (${res.status})`);
  const data = await res.json();
  const items: FlippItem[] = (data.items ?? []).map((i: Record<string, unknown>) => ({
    id: Number(i.id),
    flyer_id: Number(i.flyer_id),
    merchant_name: String(i.merchant_name ?? ""),
    name: String(i.name ?? ""),
    current_price: toNumber(i.current_price),
    original_price: toNumber(i.original_price),
    pre_price_text: (i.pre_price_text as string) || null,
    post_price_text: (i.post_price_text as string) || null,
    sale_story: (i.sale_story as string) || null,
    valid_from: String(i.valid_from),
    valid_to: String(i.valid_to),
  }));
  // Flyers for next week often appear early (e.g. Tuesday); only this week's ad counts.
  return items.filter((i) => new Date(i.valid_from) <= now && now <= new Date(i.valid_to));
}

/** Flipp merchant names vs our store names ("LIDL" vs "Lidl"; skip "Publix Liquors"). */
export function sameMerchant(storeName: string, merchantName: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  return norm(storeName) === norm(merchantName);
}

/** Public link for one flyer item (opens the item in Flipp's viewer). */
export const flippItemUrl = (item: FlippItem) => `https://flipp.com/en-us/item/${item.id}`;
