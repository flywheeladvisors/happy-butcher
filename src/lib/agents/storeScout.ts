import "server-only";
import { z } from "zod";
import { adPageSourceFor } from "../adPages";
import { scrapeCached } from "../scrapedAds";
import { tavilySearch } from "../tavily";
import type { Store } from "../types";
import { agentModel, runAgent, type AgentTool, type Trace } from "./runtime";

// Store Scout: turns "Wegmans in Cary, NC" into a store the Deal Hunter can actually shop: the
// specific location (address, ZIP, store number), the chain's site and weekly-ad page, and whether
// that ad is reachable through the weekly-ad search for that ZIP.

export type ScoutedStore = Omit<Store, "id" | "created_at">;

interface ScoutCtx {
  request: { name: string; city: string; state: string; zip?: string | null };
}

const tools: AgentTool<ScoutCtx>[] = [
  {
    name: "lookup_zip",
    description: "ZIP codes for a city/state.",
    parameters: { type: "object", properties: { city: { type: "string" }, state: { type: "string" } }, required: ["city", "state"] },
    describe: (a) => `looked up ZIPs for ${a.city}, ${a.state}`,
    async run(args) {
      const res = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(String(args.state))}/${encodeURIComponent(String(args.city))}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { error: `ZIP lookup failed (${res.status})` };
      const data = await res.json();
      return (data.places ?? []).map((p: Record<string, string>) => p["post code"]);
    },
  },
  {
    name: "list_weekly_ads",
    description:
      "Which chains have a current weekly ad in the weekly-ad search (Flipp) for a ZIP. If the chain appears here, the Deal Hunter can price it for that ZIP.",
    parameters: { type: "object", properties: { zip: { type: "string" } }, required: ["zip"] },
    describe: (a) => `checked which weekly ads cover ZIP ${a.zip}`,
    async run(args) {
      const res = await fetch(`https://backflipp.wishabi.com/flipp/flyers?locale=en-us&postal_code=${encodeURIComponent(String(args.zip))}`, {
        headers: { "User-Agent": "Mozilla/5.0 (HappyButcher price watch)" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { error: `Weekly-ad list failed (${res.status})` };
      const data = await res.json();
      const now = new Date();
      const current = (data.flyers ?? []).filter(
        (f: { valid_from: string; valid_to: string }) => new Date(f.valid_from) <= now && now <= new Date(f.valid_to),
      );
      return [...new Set(current.map((f: { merchant: string }) => f.merchant))].sort();
    },
  },
  {
    name: "web_search",
    description: "Web search (Tavily). Use for store locator pages, addresses, store numbers, and weekly-ad URLs.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    describe: (a) => `searched the web for "${a.query}"`,
    async run(args) {
      return (await tavilySearch(String(args.query), { maxResults: 6 })).map((r) => ({ url: r.url, title: r.title, content: r.content.slice(0, 400) }));
    },
  },
  {
    name: "read_page",
    description: "Read a web page (Firecrawl) as text; first 6000 characters.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    describe: (a) => `read ${String(a.url).replace(/^https?:\/\//, "").slice(0, 70)}`,
    async run(args) {
      const md = await scrapeCached(String(args.url), { waitFor: 2500 });
      return md ? md.slice(0, 6000) : { note: "Empty or blocked page." };
    },
  },
];

const SYSTEM = `You are the Store Scout on the Happy Butcher's team. The customer named a grocery store and a town; you pin down the exact location so the Deal Hunter can price it correctly (these chains price by store/region, not nationally).

Find:
- The specific store: street address and ZIP (if the town has several, choose the one the customer named; otherwise the most central one and say so in notes). Store number if the chain publishes one.
- The chain's website (base_url) and its weekly-ad page (weekly_ad_url; null if the chain has no weekly ad).
- ad_source: "flipp" if list_weekly_ads shows the chain's ad for the store's ZIP; "store_page" only for chains whose own ad page can be pinned to a store by URL (Publix, via ?setstorenumber=<store number>; this needs the store number); otherwise "none".
- name: the chain's usual name (e.g. "Wegmans", "Harris Teeter").

Be efficient: a few searches, read a store-locator page if needed. Don't guess an address or store number; leave it null and explain in notes.
Finish with submit_store.`;

const Submitted = z.object({
  name: z.string().min(1),
  city: z.string().min(1),
  state: z.string().length(2),
  zip: z.string().regex(/^\d{5}$/).nullable(),
  address: z.string().nullable(),
  store_number: z.string().nullable(),
  base_url: z.string().url(),
  weekly_ad_url: z.string().url().nullable(),
  ad_source: z.enum(["flipp", "store_page", "none"]),
  notes: z.string(),
});

export async function runStoreScout(request: ScoutCtx["request"], trace: Trace): Promise<ScoutedStore> {
  const out = await runAgent(
    {
      name: "Store Scout",
      system: SYSTEM,
      tools,
      model: agentModel("scout"),
      maxRounds: 8,
      submit: {
        name: "submit_store",
        description: "The resolved store location.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            city: { type: "string" },
            state: { type: "string", description: "Two-letter code" },
            zip: { type: ["string", "null"] },
            address: { type: ["string", "null"] },
            store_number: { type: ["string", "null"] },
            base_url: { type: "string" },
            weekly_ad_url: { type: ["string", "null"] },
            ad_source: { type: "string", enum: ["flipp", "store_page", "none"] },
            notes: { type: "string" },
          },
          required: ["name", "city", "state", "zip", "address", "store_number", "base_url", "weekly_ad_url", "ad_source", "notes"],
        },
        parse: (raw) => Submitted.parse(raw),
      },
    },
    `Store: ${request.name}\nTown: ${request.city}, ${request.state}${request.zip ? `\nZIP given by customer: ${request.zip}` : ""}`,
    { request },
    trace,
  );

  // store_page only works where we have a parser for that chain's ad page.
  const adSource = out.ad_source === "store_page" && !(adPageSourceFor(out.name) && out.store_number) ? "none" : out.ad_source;
  return {
    name: out.name,
    // Keep the town the customer used ("the Cary Wegmans"), so asking again finds the saved store;
    // the exact location lives in address/zip.
    city: request.city.trim(),
    state: request.state.trim().toUpperCase(),
    zip: out.zip,
    address: out.address,
    store_number: out.store_number,
    base_url: out.base_url,
    weekly_ad_url: out.weekly_ad_url,
    ad_source: adSource,
    scout_notes: out.notes,
  };
}
