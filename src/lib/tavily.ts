import "server-only";
import { requireEnv } from "./env";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

export async function tavilySearch(
  query: string,
  options: { maxResults?: number; includeDomains?: string[] } = {},
): Promise<TavilyResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("TAVILY_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      max_results: options.maxResults ?? 5,
      search_depth: "basic",
      ...(options.includeDomains?.length ? { include_domains: options.includeDomains } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Tavily search failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.results ?? []) as TavilyResult[];
}
