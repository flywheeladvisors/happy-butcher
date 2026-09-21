import "server-only";
import { adPageSourceFor, type PageListing } from "./adPages";
import { first, run, sql } from "./db";
import { firecrawlScrape } from "./firecrawl";
import type { Store } from "./types";

const CACHE_HOURS = 6;

/** Firecrawl a URL, reusing a copy from the last few hours (a whole weekly ad serves every item). */
export async function scrapeCached(url: string, options: { waitFor?: number; onlyMainContent?: boolean } = {}): Promise<string | null> {
  const cached = await first<{ markdown: string }>(sql`
    select to_jsonb(c) as row from public.page_cache c
    where c.url = ${url} and c.fetched_at > now() - make_interval(hours => ${CACHE_HOURS})`);
  if (cached) return cached.markdown;

  const markdown = await firecrawlScrape(url, options);
  if (markdown) {
    await run(sql`
      insert into public.page_cache (url, markdown) values (${url}, ${markdown})
      on conflict (url) do update set markdown = excluded.markdown, fetched_at = now()`);
  }
  return markdown;
}

export type ScrapedAd =
  | { status: "ok"; url: string; listings: PageListing[] }
  | { status: "unsupported" }
  | { status: "failed"; url: string | null; reason: string };

/** This store's weekly ad scraped from its own site, when the chain lets us pin the store by URL. */
export async function getScrapedAd(store: Store): Promise<ScrapedAd> {
  const source = adPageSourceFor(store.name);
  if (!source) return { status: "unsupported" };
  const url = source.url(store);
  if (!url) return { status: "failed", url: null, reason: "No store number saved for this location" };
  try {
    const markdown = await scrapeCached(url, { waitFor: 4000, onlyMainContent: false });
    if (!markdown) return { status: "failed", url, reason: "Page came back empty" };
    if (!source.confirmsStore(markdown)) return { status: "failed", url, reason: "Page didn't confirm our store location" };
    return { status: "ok", url, listings: source.parse(markdown) };
  } catch (err) {
    return { status: "failed", url, reason: err instanceof Error ? err.message : String(err) };
  }
}
