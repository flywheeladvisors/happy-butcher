import "server-only";
import type { AdListing } from "./priceParse";

// Store catalogs: chains whose own product search returns prices pinned to one store, so the Deal
// Hunter can check shelf prices and member deals directly, not just what made the weekly ad.
//
// Wegmans: its site searches through Algolia with a public, search-only key embedded in its own
// JavaScript. Filtering by storeNumber gives that store's shelf price (price_inStore) and any
// Shoppers Club price (price_inStoreLoyalty) with the discount and its end date. The app id, key,
// and index can change when Wegmans updates its site, so they're overridable by env.

export interface CatalogListing extends AdListing {
  product_id: string;
  product_name: string;
  url: string;
  valid_text: string | null;
}

interface StoreCatalog {
  chain: RegExp;
  search: (storeNumber: string, query: string) => Promise<CatalogListing[]>;
}

const WEGMANS = {
  app: process.env.WEGMANS_ALGOLIA_APP ?? "QGPPR19V8V",
  key: process.env.WEGMANS_ALGOLIA_KEY ?? "9a10b1401634e9a6e55161c3a60c200d",
  index: process.env.WEGMANS_ALGOLIA_INDEX ?? "products",
};

/** "$4.99/lb." -> { price: 4.99, unit: "lb" } */
function parseUnitPrice(text: string | undefined): { price: number; unit: string | null } | null {
  const m = text ? /\$\s?(\d+(?:\.\d{1,2})?)\s*(?:\/\s*([a-z]+))?/i.exec(text) : null;
  return m ? { price: Number(m[1]), unit: m[2]?.toLowerCase() ?? null } : null;
}

interface WegmansHit {
  productId?: string | number;
  productName?: string;
  price_inStore?: { unitPrice?: string; amount?: number };
  price_inStoreLoyalty?: { unitPrice?: string; amount?: number };
  discountType?: string;
  loyaltyInstoreDiscount?: { savings?: number; name?: string; expiryDate?: string }[];
}

async function searchWegmans(storeNumber: string, query: string): Promise<CatalogListing[]> {
  const res = await fetch(`https://${WEGMANS.app}-dsn.algolia.net/1/indexes/${WEGMANS.index}/query`, {
    method: "POST",
    headers: { "x-algolia-application-id": WEGMANS.app, "x-algolia-api-key": WEGMANS.key, "content-type": "application/json" },
    body: JSON.stringify({
      query,
      hitsPerPage: 12,
      filters: `storeNumber:${storeNumber}`,
      attributesToRetrieve: ["productId", "productName", "price_inStore", "price_inStoreLoyalty", "discountType", "loyaltyInstoreDiscount"],
      attributesToHighlight: [],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Wegmans catalog search failed (${res.status})`);
  const data = (await res.json()) as { hits?: WegmansHit[] };

  const out: CatalogListing[] = [];
  for (const h of data.hits ?? []) {
    const shelf = parseUnitPrice(h.price_inStore?.unitPrice);
    if (!shelf || !h.productName) continue;
    const member = h.discountType === "loyalty" ? parseUnitPrice(h.price_inStoreLoyalty?.unitPrice) : null;
    const discount = h.loyaltyInstoreDiscount?.[0];
    const ends = discount?.expiryDate
      ? new Date(discount.expiryDate).toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "America/New_York" })
      : null;
    const onDeal = member !== null && member.price < shelf.price;
    out.push({
      product_id: String(h.productId ?? ""),
      product_name: h.productName,
      url: `https://www.wegmans.com/shop/product/${h.productId}`,
      current_price: onDeal ? member.price : shelf.price,
      original_price: onDeal ? shelf.price : null,
      pre_price_text: null,
      post_price_text: shelf.unit,
      sale_story: onDeal
        ? `Shoppers Club price${discount?.savings ? `: $${discount.savings.toFixed(2)} off per pack` : ""}${ends ? ` through ${ends}` : ""}`
        : null,
      valid_text: onDeal && ends ? `Shoppers Club through ${ends}` : "Everyday shelf price",
    });
  }
  return out;
}

const CATALOGS: StoreCatalog[] = [{ chain: /^wegman/i, search: searchWegmans }];

export const storeCatalogFor = (storeName: string) => CATALOGS.find((c) => c.chain.test(storeName)) ?? null;
