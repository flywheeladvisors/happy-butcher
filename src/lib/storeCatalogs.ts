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

// Harris Teeter (Kroger platform): the search page embeds its results, with store prices, in
// window.__INITIAL_STATE__. The store is chosen by the x-active-modality cookie (raw JSON, not
// URL-encoded). The JSON APIs sit behind Akamai and refuse plain requests, so we read the page,
// gently: one request at a time, a pause between, and a short cache.

const HT_PAUSE_MS = 800;
let htQueue: Promise<unknown> = Promise.resolve();
const htCache = new Map<string, { at: number; hits: CatalogListing[] }>();

function unescapeJsString(lit: string): string {
  return lit.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, c: string) => {
    if (c.length === 5 && c[0] === "u") return String.fromCharCode(parseInt(c.slice(1), 16));
    if (c.length === 3 && c[0] === "x") return String.fromCharCode(parseInt(c.slice(1), 16));
    return c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c;
  });
}

interface HtPrice {
  defaultDescription?: string;
  nforPrice?: string;
  price?: string;
  expirationDate?: { value?: string };
}
interface HtProduct {
  item: { upc?: string; description?: string; weight?: string };
  price: { sellBy?: string; storePrices: { regular?: HtPrice; promo?: HtPrice; sourceLocationId?: string } };
}

const usd = (s: string | undefined) => (s && /USD\s*([\d.]+)/.exec(s) ? Number(/USD\s*([\d.]+)/.exec(s)![1]) : null);

async function fetchHarrisTeeter(locationId: string, query: string): Promise<CatalogListing[]> {
  const cookie = `x-active-modality=${JSON.stringify({ type: "PICKUP", locationId, source: "FALLBACK_ACTIVE_MODALITY_COOKIE", createdDate: Date.now() })}`;
  const res = await fetch(`https://www.harristeeter.com/search?query=${encodeURIComponent(query)}`, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      cookie,
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Harris Teeter search failed (${res.status})`);
  const html = await res.text();
  const mark = "__INITIAL_STATE__ = JSON.parse('";
  const start = html.indexOf(mark);
  if (start < 0) throw new Error("Harris Teeter page had no product data");
  const end = html.indexOf("')", start + mark.length);
  const state = JSON.parse(unescapeJsString(html.slice(start + mark.length, end)));

  const found: HtProduct[] = [];
  (function walk(o: unknown) {
    if (!o || typeof o !== "object") return;
    const rec = o as Record<string, unknown>;
    if (rec.item && (rec.price as HtProduct["price"] | undefined)?.storePrices) found.push(rec as unknown as HtProduct);
    for (const k in rec) walk(rec[k]);
  })(state);

  const seen = new Set<string>();
  const out: CatalogListing[] = [];
  for (const p of found) {
    const upc = p.item.upc ?? "";
    const sp = p.price.storePrices;
    if (!upc || seen.has(upc) || !sp.regular) continue;
    seen.add(upc);
    // The server echoes whatever location it was sent; only trust prices for ours.
    if (sp.sourceLocationId !== locationId) continue;
    const byWeight = p.price.sellBy === "Weight";
    // nforPrice is per lb for items sold by weight, per package otherwise.
    const regular = usd(sp.regular.nforPrice) ?? usd(sp.regular.price);
    const promo = sp.promo ? (usd(sp.promo.nforPrice) ?? usd(sp.promo.price)) : null;
    if (regular === null) continue;
    const ends = sp.promo?.expirationDate?.value
      ? new Date(sp.promo.expirationDate.value).toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "America/New_York" })
      : null;
    const onDeal = promo !== null && promo < regular;
    out.push({
      product_id: upc,
      product_name: [p.item.description, !byWeight && p.item.weight ? `(${p.item.weight.replace(/\s*\[lb_av\]/, " lb")})` : null].filter(Boolean).join(" "),
      url: `https://www.harristeeter.com/search?query=${encodeURIComponent(p.item.description ?? upc)}`,
      current_price: onDeal ? promo : regular,
      original_price: onDeal ? regular : null,
      pre_price_text: null,
      post_price_text: byWeight ? "lb" : "ea",
      sale_story: onDeal ? `${sp.promo?.defaultDescription ?? "Sale"} with VIC card${ends ? ` through ${ends}` : ""}` : null,
      valid_text: onDeal && ends ? `VIC price through ${ends}` : "Everyday shelf price",
    });
  }
  return out;
}

async function searchHarrisTeeter(locationId: string, query: string): Promise<CatalogListing[]> {
  const key = `${locationId}|${query.toLowerCase()}`;
  const cached = htCache.get(key);
  if (cached && Date.now() - cached.at < 6 * 3600_000) return cached.hits;
  // Serialize requests with a pause so the site isn't hammered.
  const run = htQueue.then(async () => {
    try {
      return await fetchHarrisTeeter(locationId, query);
    } finally {
      await new Promise((r) => setTimeout(r, HT_PAUSE_MS));
    }
  });
  htQueue = run.catch(() => undefined);
  const hits = await run;
  htCache.set(key, { at: Date.now(), hits });
  return hits;
}

// LIDL: lidl.com's own search API returns every price region's price for each product; a store
// belongs to one offer region (Cary = 1110). regionsV2[region] says whether the store carries it
// and which price group applies; regionsPrices[group].currentPrice holds the price, the crossed-out
// oldPrice, the discount text, and dates. Lidl Plus (app-only) prices are ignored.

interface LidlPrice {
  price?: number;
  oldPrice?: number;
  basePrice?: { text?: string };
  packaging?: { text?: string };
  discount?: { discountText?: string; deletedPrice?: number };
  endDate?: string;
}
interface LidlItem {
  erpNumber?: string;
  fullTitle?: string;
  canonicalPath?: string;
  regionsV2?: Record<string, { regionPriceId?: string }>;
  regionsPrices?: Record<string, { currentPrice?: LidlPrice }>;
}

async function searchLidl(region: string, query: string): Promise<CatalogListing[]> {
  const res = await fetch(
    `https://www.lidl.com/q/api/search?q=${encodeURIComponent(query)}&assortment=US&locale=en_US&version=v2.0.0&fetchsize=36`,
    {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
        accept: "application/mindshift.search+json;version=2, application/json",
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!res.ok) throw new Error(`Lidl search failed (${res.status})`);
  const data = (await res.json()) as { items?: { gridbox?: { data?: LidlItem } }[] };

  const out: CatalogListing[] = [];
  for (const entry of data.items ?? []) {
    const g = entry.gridbox?.data;
    const group = g?.regionsV2?.[region]?.regionPriceId;
    const cp = group ? g?.regionsPrices?.[group]?.currentPrice : undefined;
    if (!g?.fullTitle || cp?.price === undefined) continue; // not sold at our store
    const was = cp.discount?.deletedPrice ?? cp.oldPrice ?? null;
    const onDeal = was !== null && was > cp.price;
    const perLb = /per\s+lb/i.test(cp.basePrice?.text ?? "");
    const ends = cp.endDate
      ? new Date(new Date(cp.endDate).getTime() - 1000).toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "America/New_York" })
      : null;
    out.push({
      product_id: g.erpNumber ?? "",
      product_name: [g.fullTitle, !perLb && cp.packaging?.text ? `(${cp.packaging.text})` : null].filter(Boolean).join(" "),
      url: g.canonicalPath ? `https://www.lidl.com${g.canonicalPath}` : "https://www.lidl.com",
      current_price: cp.price,
      original_price: onDeal ? was : null,
      pre_price_text: null,
      post_price_text: perLb ? "lb" : "ea",
      sale_story: onDeal ? `${cp.discount?.discountText ?? "Sale"}${ends ? ` through ${ends}` : ""}` : null,
      valid_text: onDeal && ends ? `Sale through ${ends}` : "Everyday shelf price",
    });
  }
  return out;
}

// Lowes Foods: its online store runs on Inmar eRetail. A new anonymous session defaults to another
// store, so each search first selects ours by locationId and checks the store number that comes
// back. Prices are in cents; promotion.originalChargePrice is the everyday price when on sale.

const LOWES = {
  base: "https://falcon.shop.inmar.io",
  // Store number -> Inmar location id (from /v2/locations?fulfillmentMethod=pickup&searchTerms=Cary).
  locations: { "162": "7dLEGhO2Qsf5l2an1VwIXK" } as Record<string, string>,
};

interface LowesProduct {
  productId?: string;
  name?: string;
  chargePrice?: number;
  chargeByUOM?: string;
  isAvailableForLocation?: boolean;
  hasDigitalCoupon?: boolean;
  promotion?: { originalChargePrice?: number; saleEndDate?: string; label?: { text?: string } };
}

function lowesHeaders(sessionId?: string): Record<string, string> {
  return {
    "inmar-banner-id": "shop_lowes_foods",
    origin: "https://shop.lowesfoods.com",
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
    ...(sessionId ? { "inmar-session-id": sessionId } : {}),
  };
}

async function searchLowesFoods(storeNumber: string, query: string): Promise<CatalogListing[]> {
  const locationId = LOWES.locations[storeNumber];
  if (!locationId) throw new Error(`No Lowes Foods location id configured for store ${storeNumber}`);

  const session = await fetch(`${LOWES.base}/v2/session`, { method: "POST", headers: lowesHeaders(), signal: AbortSignal.timeout(15_000) });
  if (!session.ok) throw new Error(`Lowes Foods session failed (${session.status})`);
  const sessionId: string | undefined = (await session.json())?.data?.item?.sessionId;
  if (!sessionId) throw new Error("Lowes Foods returned no session");

  const pick = await fetch(`${LOWES.base}/v2/fulfillmentInfo`, {
    method: "POST",
    headers: lowesHeaders(sessionId),
    body: JSON.stringify({ fulfillmentType: "instore", fulfillmentInStoreConfig: { locationId } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!pick.ok) throw new Error(`Lowes Foods store selection failed (${pick.status})`);
  const picked = JSON.stringify(await pick.json());
  // Fail loudly rather than price the wrong store.
  if (!picked.includes(`"locationStoreNumber":"${storeNumber}"`)) throw new Error(`Lowes Foods did not confirm store ${storeNumber}`);

  const res = await fetch(`${LOWES.base}/v2/search?searchTerms=${encodeURIComponent(query)}`, {
    headers: lowesHeaders(sessionId),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Lowes Foods search failed (${res.status})`);
  // Results arrive as page "modules", each holding productItems.
  const items: LowesProduct[] = [];
  (function walk(o: unknown) {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") {
      const rec = o as Record<string, unknown>;
      if (Array.isArray(rec.productItems)) items.push(...(rec.productItems as LowesProduct[]));
      Object.values(rec).forEach(walk);
    }
  })(await res.json());

  const out: CatalogListing[] = [];
  for (const p of items.slice(0, 30)) {
    if (!p.name || p.chargePrice === undefined || p.isAvailableForLocation === false) continue;
    const price = p.chargePrice / 100;
    const was = p.promotion?.originalChargePrice !== undefined ? p.promotion.originalChargePrice / 100 : null;
    const onDeal = was !== null && was > price;
    const ends = p.promotion?.saleEndDate ? new Date(`${p.promotion.saleEndDate}T12:00:00`).toLocaleDateString("en-US", { month: "numeric", day: "numeric" }) : null;
    const byLb = (p.chargeByUOM ?? "").toLowerCase() === "lb";
    out.push({
      product_id: String(p.productId ?? ""),
      product_name: p.name,
      url: `https://shop.lowesfoods.com/products/${p.productId}`,
      current_price: price,
      original_price: onDeal ? was : null,
      pre_price_text: null,
      post_price_text: byLb ? "lb" : "ea",
      sale_story: onDeal
        ? `${p.promotion?.label?.text ?? "Sale"}${ends ? ` through ${ends}` : ""}`
        : p.hasDigitalCoupon
          ? "Digital coupon available"
          : null,
      valid_text: onDeal && ends ? `Sale through ${ends}` : "Everyday shelf price",
    });
  }
  return out;
}

// Publix: publix.com search pages, pinned by ?setstorenumber=, embed product JSON. Publix only
// publishes a price online while an item is on promotion (weekly ad, TPR, BOGO); everyday prices
// for items not on promotion aren't shown anywhere on publix.com, so those come back unpriced.

interface PublixProduct {
  baseProductId?: string;
  storeNbr?: number;
  title?: string;
  priceLine?: string | null;
  originalPriceLine?: string | null;
  onSale?: boolean;
  promoType?: string | null;
  promoMsg?: string | null;
  promoValidThruMsg?: string | null;
}

/** Pull the {"allowQuantity"...} product objects out of the page by brace matching. */
function extractPublixProducts(html: string): PublixProduct[] {
  const s = html.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'");
  const out = new Map<string, PublixProduct>();
  let i = 0;
  while ((i = s.indexOf('{"allowQuantity"', i)) >= 0) {
    let depth = 0;
    let j = i;
    let inString = false;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inString) {
        if (c === "\\") j++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
    }
    try {
      const o = JSON.parse(s.slice(i, j + 1)) as PublixProduct;
      if (o.baseProductId && (!out.has(o.baseProductId) || o.priceLine)) out.set(o.baseProductId, o);
    } catch {
      // not a complete object; skip
    }
    i = j + 1;
  }
  return [...out.values()];
}

async function searchPublix(storeNumber: string, query: string): Promise<CatalogListing[]> {
  const res = await fetch(`https://www.publix.com/search?searchTerm=${encodeURIComponent(query)}&setstorenumber=${storeNumber}`, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Publix search failed (${res.status})`);
  const out: CatalogListing[] = [];
  for (const p of extractPublixProducts(await res.text())) {
    if (!p.title || String(p.storeNbr) !== storeNumber) continue;
    const now = parseUnitPrice(p.priceLine ?? undefined);
    if (!now) continue; // Publix doesn't publish a price for items not on promotion
    const was = parseUnitPrice(p.originalPriceLine ?? undefined);
    const bogo = /bogo/i.test(p.promoType ?? "") || /buy\s*1\s*get\s*1/i.test(p.promoMsg ?? "");
    const valid = p.promoValidThruMsg ?? null;
    const story = [p.promoMsg, valid].filter(Boolean).join(", ") || null;
    // For BOGO the listed price is the full price; each is effectively half when you buy two.
    const current = bogo ? Math.round((now.price / 2) * 100) / 100 : now.price;
    const original = bogo ? now.price : was && was.price > now.price ? was.price : null;
    out.push({
      product_id: p.baseProductId ?? "",
      product_name: p.title,
      url: `https://www.publix.com/pd/item/${p.baseProductId}`,
      current_price: current,
      original_price: original,
      pre_price_text: null,
      post_price_text: now.unit,
      sale_story: bogo ? `Buy 1 Get 1 Free (price shown is each when you buy 2)${valid ? `, ${valid}` : ""}` : original !== null ? story : null,
      valid_text: valid ?? (p.onSale ? "Promotion" : "Shelf price"),
    });
  }
  return out;
}

// ALDI: aldi.us is an Instacart storefront. A guest session (cookie from the storefront page) plus
// two persisted GraphQL queries give store-pinned prices: search -> item ids -> Items. The query
// hashes belong to the site's current front-end build and change when it's redeployed; override
// them by env (ALDI_SEARCH_HASH / ALDI_ITEMS_HASH) and expect "PersistedQueryNotFound" when stale.
// Price drops carry no end date here (the weekly ad via Flipp has dates).

const ALDI = {
  // Store number (Instacart in-store shop id) -> the rest of its location context.
  shops: { "516858": { postalCode: "27513", zoneId: "714" } } as Record<string, { postalCode: string; zoneId: string }>,
  searchHash: process.env.ALDI_SEARCH_HASH ?? "406e5b9dfc9dc9b209b2c72012622de595fb4040d17f68efa4d4e104657273ee",
  itemsHash: process.env.ALDI_ITEMS_HASH ?? "388f200246a7fcc0f10ed9c1bb97952f9046e69c1be3b14ebae5855822cec831",
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
};

/** First value found for a key anywhere in a JSON tree. */
function findKey(o: unknown, key: string): unknown {
  let found: unknown;
  JSON.stringify(o, (k, v) => {
    if (k === key && found === undefined && v != null) found = v;
    return v;
  });
  return found;
}

async function searchAldi(shopId: string, query: string): Promise<CatalogListing[]> {
  const shop = ALDI.shops[shopId];
  if (!shop) throw new Error(`No ALDI shop context configured for ${shopId}`);

  const jar = new Map<string, string>();
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const eq = kv.indexOf("=");
      jar.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

  const home = await fetch("https://www.aldi.us/store/aldi/storefront", { headers: { "user-agent": ALDI.ua, accept: "text/html" }, signal: AbortSignal.timeout(20_000) });
  keep(home);
  await home.text();

  const gql = async (op: string, variables: object, hash: string) => {
    const url = `https://www.aldi.us/graphql?operationName=${op}&variables=${encodeURIComponent(JSON.stringify(variables))}&extensions=${encodeURIComponent(
      JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
    )}`;
    const res = await fetch(url, {
      headers: { "user-agent": ALDI.ua, accept: "*/*", "content-type": "application/json", "x-client-identifier": "web", cookie: cookie(), referer: "https://www.aldi.us/store/aldi/storefront" },
      signal: AbortSignal.timeout(20_000),
    });
    keep(res);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) throw new Error(`ALDI ${op} failed (${res.status})`);
    if (JSON.stringify(body).includes("PersistedQueryNotFound")) throw new Error(`ALDI ${op} query hash is stale; refresh ALDI_${op === "Items" ? "ITEMS" : "SEARCH"}_HASH`);
    return body;
  };

  const search = await gql(
    "SearchResultsPlacements",
    {
      action: null, query, pageViewId: crypto.randomUUID(), elevatedProductId: null, searchSource: "search", filters: [],
      disableReformulation: false, disableLlm: false, forceInspiration: false, orderBy: "bestMatch", clusterId: null,
      includeDebugInfo: false, clusteringStrategy: null, contentManagementSearchParams: { itemGridColumnCount: 2 },
      shopId, postalCode: shop.postalCode, zoneId: shop.zoneId, first: 12,
    },
    ALDI.searchHash,
  );
  const ids = [...new Set([...JSON.stringify(search).matchAll(/"(items_\d+-\d+)"/g)].map((m) => m[1]))].slice(0, 12);
  if (ids.length === 0) return [];
  const items = await gql("Items", { ids, shopId, zoneId: shop.zoneId, postalCode: shop.postalCode }, ALDI.itemsHash);

  const out: CatalogListing[] = [];
  for (const x of (items?.data?.items ?? []) as { id?: string; name?: string; price?: unknown }[]) {
    if (!x.name) continue;
    const pkg = parseUnitPrice(findKey(x.price, "priceString") as string | undefined);
    const perUnit = parseUnitPrice(findKey(x.price, "pricingUnitString") as string | undefined);
    const full = parseUnitPrice(findKey(x.price, "plainFullPriceString") as string | undefined);
    const offer = (findKey(x, "offerLabelString") as string | undefined) ?? null;
    if (!pkg) continue;
    // Weighed items: price per lb from the unit string; the package price is only an estimate.
    const byLb = perUnit?.unit === "lb";
    const price = byLb ? perUnit!.price : pkg.price;
    const ratio = full && full.price > pkg.price ? full.price / pkg.price : null;
    const was = ratio ? Math.round(price * ratio * 100) / 100 : null;
    out.push({
      product_id: String(x.id ?? ""),
      product_name: x.name,
      url: `https://www.aldi.us/store/aldi/products/${String(x.id ?? "").split("-").pop()}`,
      current_price: price,
      original_price: was,
      pre_price_text: null,
      post_price_text: byLb ? "lb" : "ea",
      sale_story: was ? `Price drop${offer ? ` (${offer})` : ""}` : null,
      valid_text: was ? "Price drop (end date not published)" : "Everyday shelf price",
    });
  }
  return out;
}

const CATALOGS: StoreCatalog[] = [
  { chain: /^wegman/i, search: searchWegmans },
  { chain: /harris\s*teeter/i, search: searchHarrisTeeter },
  { chain: /^lidl/i, search: searchLidl },
  { chain: /lowe'?s\s*foods/i, search: searchLowesFoods },
  { chain: /publix/i, search: searchPublix },
  { chain: /^aldi/i, search: searchAldi },
];

export const storeCatalogFor = (storeName: string) => CATALOGS.find((c) => c.chain.test(storeName)) ?? null;
