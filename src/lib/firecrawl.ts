import "server-only";
import { requireEnv } from "./env";

/** Scrape one page to markdown. Returns null when the page is empty or blocked. */
export async function firecrawlScrape(
  url: string,
  options: { waitFor?: number; onlyMainContent?: boolean } = {},
): Promise<string | null> {
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("FIRECRAWL_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      onlyMainContent: options.onlyMainContent ?? true,
      waitFor: options.waitFor ?? 2000,
      location: { country: "US" },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Firecrawl scrape failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const markdown: unknown = data?.data?.markdown;
  return typeof markdown === "string" && markdown.trim().length > 200 ? markdown : null;
}
