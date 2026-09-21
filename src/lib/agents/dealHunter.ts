import "server-only";
import { z } from "zod";
import { adPageSourceFor } from "../adPages";
import { flippItemUrl, sameMerchant, searchFlipp } from "../flipp";
import { getScrapedAd, scrapeCached } from "../scrapedAds";
import { storeCatalogFor } from "../storeCatalogs";
import { tavilySearch } from "../tavily";
import type { Store } from "../types";
import { EvidenceLocker, listingText } from "./evidence";
import { agentModel, runAgent, type AgentSpec, type AgentTool, type Trace } from "./runtime";

// Deal Hunter: given one cut and the saved stores, decides where to look (weekly ads by ZIP, a
// store's own ad page, the store's website) and keeps digging until it has its best candidate per
// store or has run out of places to look. It reports candidates by evidence id; the Cut Inspector
// judges them.

export interface HunterCtx {
  stores: Store[];
  locker: EvidenceLocker;
  mode: "chat" | "weekly";
  item: string;
}

export interface Finding {
  store_id: number;
  evidence_id: string | null;
  /** Only for product_page evidence: what the Hunter read off the page, with the exact quote. */
  extracted: {
    product_name: string;
    current_price: number | null;
    original_price: number | null;
    unit_text: string | null;
    promo_text: string | null;
    quote: string;
  } | null;
  note: string;
}

const DEFAULT_ZIP = "27513";
const storeLabel = (s: Store) => `${s.name} (store_id ${s.id}, ${s.city} ${s.zip ?? ""})`;

const adTools: AgentTool<HunterCtx>[] = [
  {
    name: "search_weekly_ads",
    description:
      "Search this week's weekly ads (via Flipp, scoped by each store's ZIP) across ALL saved stores at once. Returns listings grouped by store, each with an evidence_id. Try a few phrasings if the first finds little (e.g. 'strip steak', 'new york strip', 'sirloin strip').",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    describe: (a) => `searched weekly ads for "${a.query}"`,
    async run(args, ctx) {
      const query = String(args.query);
      const zips = [...new Set(ctx.stores.map((s) => s.zip ?? DEFAULT_ZIP))];
      const byStore: Record<string, unknown[]> = {};
      await Promise.all(
        zips.map(async (zip) => {
          for (const f of await searchFlipp(query, zip)) {
            const store = ctx.stores.find((s) => (s.zip ?? DEFAULT_ZIP) === zip && sameMerchant(s.name, f.merchant_name));
            if (!store) continue;
            const e = ctx.locker.add({
              store_id: store.id,
              source: "weekly_ad",
              product_name: f.name,
              listing: f,
              url: flippItemUrl(f),
              valid: `${f.valid_from.slice(5, 10)} to ${f.valid_to.slice(5, 10)}`,
            });
            (byStore[storeLabel(store)] ??= []).push({ evidence_id: e.id, product: f.name, price: listingText(f) });
          }
        }),
      );
      return Object.keys(byStore).length ? byStore : { note: "No listings at any saved store for that query." };
    },
  },
  {
    name: "browse_store_ad",
    description:
      "Read a store's weekly ad straight from its own website, pinned to our store location. Only some chains support this (currently Publix). Returns listings whose names contain the keyword.",
    parameters: {
      type: "object",
      properties: { store_id: { type: "integer" }, keyword: { type: "string", description: "One word, e.g. 'tenderloin'" } },
      required: ["store_id", "keyword"],
    },
    describe: (a) => `browsed store ${a.store_id}'s own ad for "${a.keyword}"`,
    async run(args, ctx) {
      const store = ctx.stores.find((s) => s.id === Number(args.store_id));
      if (!store) return { error: "Unknown store_id" };
      const ad = await getScrapedAd(store);
      if (ad.status === "unsupported") return { note: `${store.name}'s own ad can't be pinned to our store; use search_weekly_ads.` };
      if (ad.status === "failed") return { note: `Couldn't read ${store.name}'s ad: ${ad.reason}` };
      const kw = String(args.keyword).toLowerCase();
      const hits = ad.listings.filter((l) => l.product_name.toLowerCase().includes(kw)).slice(0, 25);
      return {
        store: storeLabel(store),
        listings: hits.map((l) => {
          const e = ctx.locker.add({
            store_id: store.id,
            source: "store_ad_page",
            product_name: l.details ? `${l.product_name}, ${l.details}` : l.product_name,
            listing: l,
            url: ad.url,
            valid: l.valid_text,
          });
          return { evidence_id: e.id, product: e.product_name, price: listingText(l), valid: l.valid_text };
        }),
      };
    },
  },
  {
    name: "search_store_catalog",
    description:
      "Search a store's own product catalog, pinned to our store: everyday shelf price plus any current sale/member deal. Available for stores marked '(use search_store_catalog)' in the store list. Call it for several stores in the same turn.",
    parameters: {
      type: "object",
      properties: { store_id: { type: "integer" }, query: { type: "string", description: "e.g. 'ground beef 80/20', 'chicken breast'" } },
      required: ["store_id", "query"],
    },
    describe: (a) => `searched store ${a.store_id}'s own catalog for "${a.query}"`,
    async run(args, ctx) {
      const store = ctx.stores.find((s) => s.id === Number(args.store_id));
      if (!store) return { error: "Unknown store_id" };
      const catalog = storeCatalogFor(store.name);
      if (!catalog) return { note: `${store.name} has no store-pinned catalog; use search_weekly_ads.` };
      if (!store.store_number) return { note: `No store number saved for ${store.name}; can't pin the catalog to our store.` };
      const hits = await catalog.search(store.store_number, String(args.query));
      if (hits.length === 0) return { note: "No products matched." };
      return {
        store: storeLabel(store),
        products: hits.map((h) => {
          const e = ctx.locker.add({
            store_id: store.id,
            source: "store_catalog",
            product_name: h.product_name,
            listing: h,
            url: h.url,
            valid: h.valid_text,
          });
          return { evidence_id: e.id, product: h.product_name, price: listingText(h) };
        }),
      };
    },
  },
];

const webTools: AgentTool<HunterCtx>[] = [
  {
    name: "search_store_site",
    description:
      "Web search restricted to one store's website (for items NOT in the weekly ad). Returns URLs on that site. Prefer single-product pages (/p/, /product).",
    parameters: { type: "object", properties: { store_id: { type: "integer" }, query: { type: "string" } }, required: ["store_id", "query"] },
    describe: (a) => `searched store ${a.store_id}'s website for "${a.query}"`,
    async run(args, ctx) {
      const store = ctx.stores.find((s) => s.id === Number(args.store_id));
      if (!store) return { error: "Unknown store_id" };
      const domain = new URL(store.base_url).hostname.replace(/^www\./, "");
      const results = await tavilySearch(`${args.query} site:${domain}`, { maxResults: 6 });
      const onSite = results.filter((r) => {
        try {
          const h = new URL(r.url).hostname;
          return h === domain || h.endsWith(`.${domain}`);
        } catch {
          return false;
        }
      });
      return onSite.length ? onSite.map((r) => ({ url: r.url, title: r.title })) : { note: "No pages on the store's site." };
    },
  },
  {
    name: "read_product_page",
    description:
      "Scrape one page on a store's website and return the text around the cut, registered as evidence. Most chains show a default/online price here, not our Cary store's.",
    parameters: { type: "object", properties: { store_id: { type: "integer" }, url: { type: "string" } }, required: ["store_id", "url"] },
    describe: (a) => `read ${String(a.url).replace(/^https?:\/\//, "").slice(0, 70)}`,
    async run(args, ctx) {
      const store = ctx.stores.find((s) => s.id === Number(args.store_id));
      if (!store) return { error: "Unknown store_id" };
      const url = String(args.url);
      const domain = new URL(store.base_url).hostname.replace(/^www\./, "");
      if (!new URL(url).hostname.endsWith(domain)) return { error: "URL is not on this store's site" };
      const markdown = await scrapeCached(url, { waitFor: 3000 });
      if (!markdown) return { note: "Page came back empty or blocked." };
      const keys = ctx.item.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
      const lines = markdown.split("\n").filter((l) => l.trim());
      const keep = new Set<number>();
      lines.forEach((l, i) => {
        if (keys.some((k) => l.toLowerCase().includes(k)) || /\$\s?\d/.test(l)) for (let j = i - 2; j <= i + 3; j++) keep.add(j);
      });
      const snippet = [...keep].filter((i) => i >= 0 && i < lines.length).sort((a, b) => a - b).map((i) => lines[i]).join("\n").slice(0, 6000);
      const e = ctx.locker.add({ store_id: store.id, source: "product_page", url, snippet });
      return { evidence_id: e.id, text: snippet || "(no relevant text)" };
    },
  },
];

const SYSTEM = (mode: "chat" | "weekly") => `You are the Deal Hunter on the Happy Butcher's team. Your job: for ONE meat cut, find each saved store's best current listing for exactly that cut, with evidence.

How to hunt:
- Start with search_weekly_ads (it covers every store at once, scoped to each store's ZIP). Try 2-3 phrasings: the cut's common names, singular forms, and the core cut without qualifiers. Listings often combine items ("Baby Back Ribs or Boneless Pork Tenderloin").
- For stores whose own ad can be pinned to our location (Publix), also browse_store_ad with a key word; it often has details and savings text Flipp lacks.
- For stores marked "(use search_store_catalog)", search the store's own catalog too: it gives our store's everyday shelf price and any current sale/member deal, including items the weekly ad doesn't list. Everyday prices matter to the household as much as sales. When several pack sizes match, prefer the lowest per-lb price (often the family pack) and say which pack in the note. (Publix's catalog only shows items on promotion; a missing Publix price means "not on promotion", not "not sold".)
- If a store has both a weekly-ad listing and a catalog listing for the cut, submit the one with the lower price you'd actually pay.
${
  mode === "chat"
    ? "- For stores with nothing in the weekly ad, look on the store's own site: search_store_site, then read_product_page on the best single-product URL. For product_page evidence, fill `extracted` with exactly what the page says and copy the exact price text into `quote`. Never invent a number."
    : "- This is the Wednesday sale check: weekly ads only. Don't search store websites."
}
- Ground beef is sold by lean ratio: search "ground beef", "ground chuck" (usually 80/20), "ground round" (85/15), "ground sirloin" (90/10), and "<n>% lean". The ratio must match the request.
- Be precise about the cut: marinated/seasoned products are different items from plain cuts; pork loin is not pork tenderloin; "boneless" in the request excludes bone-in. If you're unsure, include your best candidate and say why in the note; the Cut Inspector makes the final call.
- Work in parallel: call several tools in the same turn (e.g. all your weekly-ad phrasings at once; then search_store_site for every remaining store at once; then read_product_page for the best URL of each at once). Aim to finish in 3-4 turns.
- Be efficient: stop when every store has a candidate or you've tried the sensible phrasings. One product page per store is enough.

Finish with submit_findings: exactly one entry per store_id. evidence_id null if you found nothing for that store.`;

const FindingSchema = z.object({
  store_id: z.number().int(),
  evidence_id: z.string().nullable(),
  extracted: z
    .object({
      product_name: z.string(),
      current_price: z.number().nullable(),
      original_price: z.number().nullable(),
      unit_text: z.string().nullable(),
      promo_text: z.string().nullable(),
      quote: z.string(),
    })
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  note: z.string(),
});

export function dealHunterSpec(mode: "chat" | "weekly", storeIds: number[], locker: EvidenceLocker): AgentSpec<HunterCtx, Finding[]> {
  return {
    name: "Deal Hunter",
    system: SYSTEM(mode),
    tools: mode === "chat" ? [...adTools, ...webTools] : adTools,
    model: agentModel("hunter"),
    maxRounds: mode === "chat" ? 6 : 4,
    submit: {
      name: "submit_findings",
      description: "Hand your findings to the Cut Inspector: one entry per store.",
      parameters: {
        type: "object",
        properties: {
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                store_id: { type: "integer" },
                evidence_id: { type: ["string", "null"] },
                extracted: {
                  type: ["object", "null"],
                  description:
                    "REQUIRED when evidence_id came from read_product_page (null prices if the page shows none); null for weekly-ad evidence",
                  properties: {
                    product_name: { type: "string" },
                    current_price: { type: ["number", "null"] },
                    original_price: { type: ["number", "null"] },
                    unit_text: { type: ["string", "null"] },
                    promo_text: { type: ["string", "null"] },
                    quote: { type: "string", description: "Exact price text copied from the page" },
                  },
                },
                note: { type: "string" },
              },
              required: ["store_id", "evidence_id", "note"],
            },
          },
        },
        required: ["findings"],
      },
      parse: (raw) => {
        const findings = z.object({ findings: z.array(FindingSchema) }).parse(raw).findings;
        const missing = storeIds.filter((id) => !findings.some((f) => f.store_id === id));
        if (missing.length) throw new Error(`Missing findings for store_id ${missing.join(", ")}`);
        const unknown = findings.filter((f) => f.evidence_id && !locker.get(f.evidence_id));
        if (unknown.length) throw new Error(`Unknown evidence_id ${unknown.map((f) => f.evidence_id).join(", ")}`);
        const needsExtract = findings.filter((f) => locker.get(f.evidence_id)?.source === "product_page" && !f.extracted);
        if (needsExtract.length) {
          throw new Error(
            `Product-page evidence needs 'extracted' (product_name, prices, and the exact quote) for store_id ${needsExtract.map((f) => f.store_id).join(", ")}; use null prices if the page shows none`,
          );
        }
        return findings;
      },
    },
  };
}

export async function runDealHunter(
  ctx: HunterCtx,
  trace: Trace,
  feedback: { store_id: number; hint: string }[] = [],
): Promise<Finding[]> {
  const storeList = ctx.stores
    .map((s) => {
      const how = storeCatalogFor(s.name) && s.store_number ? " (use search_store_catalog)" : adPageSourceFor(s.name) ? " (also browse_store_ad)" : "";
      return `- ${storeLabel(s)}${how}`;
    })
    .join("\n");
  const retry = feedback.length
    ? `\n\nThe Cut Inspector sent these back. Look again for just these stores:\n${feedback.map((f) => `- store_id ${f.store_id}: ${f.hint}`).join("\n")}`
    : "";
  return runAgent(dealHunterSpec(ctx.mode, ctx.stores.map((s) => s.id), ctx.locker),`Cut: "${ctx.item}"\n\nStores:\n${storeList}${retry}`, ctx, trace);
}
