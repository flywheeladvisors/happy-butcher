import "server-only";
import { z } from "zod";
import { chatCompletion, extractJson } from "./openrouter";
import { parseAdListing } from "./priceParse";
import { scrapeCached } from "./scrapedAds";
import { tavilySearch } from "./tavily";
import type { PriceResult, Store } from "./types";

// For ad hoc chat questions about an item that isn't in a store's weekly ad: find the store's own
// product page with Tavily, scrape it with Firecrawl, and extract the price. Most of these chains
// pick the store by cookie, so the page shows a default/online price, not necessarily Cary's.
// Results are therefore always "unverified", with the reason spelled out.

const Extracted = z.object({
  found: z.boolean(),
  product_name: z.string().nullable(),
  current_price: z.number().nullable(),
  original_price: z.number().nullable(),
  unit_text: z.string().nullable(),
  promo_text: z.string().nullable(),
  store_location_shown: z.string().nullable(),
});

function snippetAround(markdown: string, terms: string[], maxChars = 12_000): string {
  const lines = markdown.split("\n").filter((l) => l.trim());
  const hits = new Set<number>();
  lines.forEach((l, i) => {
    if (terms.some((t) => l.toLowerCase().includes(t.split(" ").at(-1)!))) for (let j = i - 3; j <= i + 6; j++) hits.add(j);
  });
  const picked = [...hits].filter((i) => i >= 0 && i < lines.length).sort((a, b) => a - b).map((i) => lines[i]);
  return (picked.length ? picked.join("\n") : lines.join("\n")).slice(0, maxChars);
}

export async function fallbackLookup(store: Store, item: string, terms: string[]): Promise<PriceResult> {
  const base: PriceResult = {
    store_id: store.id,
    store: store.name,
    status: "not_found",
    product_name: null,
    regular_price: null,
    sale_price: null,
    unit_price: null,
    on_sale: false,
    promo_text: null,
    product_url: null,
    note: "Not in this week's ad, and no product page turned up on the store's site.",
  };

  const domain = new URL(store.base_url).hostname.replace(/^www\./, "");
  // Tavily ignores include_domains in practice; a site: operator in the query works.
  const results = await tavilySearch(`${terms[0] ?? item} site:${domain}`, { maxResults: 6 });
  // Tavily treats include_domains loosely, so enforce the store's own site here.
  const onSite = (u: string) => {
    try {
      const host = new URL(u).hostname;
      return host === domain || host.endsWith(`.${domain}`);
    } catch {
      return false;
    }
  };
  const usable = results.filter((r) => onSite(r.url) && !/weekly-?ad|circular|flyer|recipe|\/r\/|blog/i.test(r.url));
  // A single product page beats a search-results page.
  const page = usable.find((r) => /\/p\/|\/product/i.test(r.url)) ?? usable[0];
  if (!page) return base;

  const markdown = await scrapeCached(page.url, { waitFor: 3000 });
  if (!markdown) return { ...base, status: "unverified", product_url: page.url, note: "Found a product page but couldn't read it (blocked or empty)." };

  const { toolCalls, content } = await chatCompletion({
    model: process.env.MATCH_MODEL || "anthropic/claude-sonnet-5",
    temperature: 0,
    maxTokens: 600,
    messages: [
      {
        role: "system",
        content:
          "Extract the price of the requested meat cut from a grocery store web page. Apply strict matching: marinated/seasoned/bacon-wrapped products differ from plain cuts; pork loin is not pork tenderloin; boneless in the request rejects bone-in. current_price is what the shopper pays now; original_price is a crossed-out/regular price only if printed. Never invent numbers; if the page doesn't clearly show the cut with a price, found=false. store_location_shown: any store name/city the page says prices are for, else null.",
      },
      { role: "user", content: `Requested cut: "${item}"\nPage: ${page.url}\n\n${snippetAround(markdown, terms)}` },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "report_price",
          description: "The extracted price.",
          parameters: {
            type: "object",
            properties: {
              found: { type: "boolean" },
              product_name: { type: ["string", "null"] },
              current_price: { type: ["number", "null"] },
              original_price: { type: ["number", "null"] },
              unit_text: { type: ["string", "null"], description: "e.g. 'lb', 'ea', '/lb'" },
              promo_text: { type: ["string", "null"] },
              store_location_shown: { type: ["string", "null"] },
            },
            required: ["found", "product_name", "current_price", "original_price", "unit_text", "promo_text", "store_location_shown"],
          },
        },
      },
    ],
    toolChoice: { type: "function", function: { name: "report_price" } },
  });

  const x = Extracted.parse(extractJson(toolCalls[0]?.function.arguments ?? content ?? ""));
  if (!x.found || x.current_price === null) {
    return {
      ...base,
      status: "unverified",
      product_url: page.url,
      note: "Not in this week's ad. Couldn't verify a price: the store's product page shows no price until a store is picked, or didn't clearly match this cut.",
    };
  }
  const parsed = parseAdListing({
    current_price: x.current_price,
    original_price: x.original_price,
    pre_price_text: null,
    post_price_text: x.unit_text,
    sale_story: x.promo_text,
  });
  const where = x.store_location_shown ? `prices shown for ${x.store_location_shown}` : "store location not shown on the page";
  return {
    ...base,
    status: "unverified",
    product_name: x.product_name,
    regular_price: parsed.regular_price,
    sale_price: parsed.sale_price,
    unit_price: parsed.unit_price,
    on_sale: parsed.on_sale,
    promo_text: parsed.promo_text,
    product_url: page.url,
    note: `Not in this week's ad. Online price from ${domain} (${where}); not confirmed for the ${store.city} store.`,
  };
}
