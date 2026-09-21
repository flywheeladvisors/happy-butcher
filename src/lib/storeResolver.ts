import "server-only";
import { tavilySearch } from "./tavily";
import type { Store } from "./types";

export type NewStore = Omit<Store, "id" | "created_at">;

// Chains we know: canonical name, site, and chain-wide weekly-ad page. The location still travels
// with every store row, because these chains price by store/zone.
const KNOWN_CHAINS: { match: RegExp; name: string; base_url: string; weekly_ad_url: string | null }[] = [
  { match: /harris\s*teeter/i, name: "Harris Teeter", base_url: "https://www.harristeeter.com", weekly_ad_url: "https://www.harristeeter.com/weeklyad" },
  { match: /food\s*lion/i, name: "Food Lion", base_url: "https://www.foodlion.com", weekly_ad_url: "https://www.foodlion.com/weekly-specials" },
  { match: /lowe'?s\s*foods/i, name: "Lowes Foods", base_url: "https://www.lowesfoods.com", weekly_ad_url: "https://www.lowesfoods.com/weekly-ad" },
  { match: /^aldi/i, name: "ALDI", base_url: "https://www.aldi.us", weekly_ad_url: "https://www.aldi.us/weekly-specials/our-weekly-ads" },
  { match: /^lidl/i, name: "LIDL", base_url: "https://www.lidl.com", weekly_ad_url: "https://www.lidl.com/weekly-ad" },
  { match: /publix/i, name: "Publix", base_url: "https://www.publix.com", weekly_ad_url: "https://www.publix.com/savings/weekly-ad" },
];

/** Weekly-ad lookups are by ZIP; when the user only gives a city, use the city's first ZIP. */
async function zipForCity(city: string, state: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(state)}/${encodeURIComponent(city)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.places?.[0]?.["post code"] ?? null;
  } catch {
    return null;
  }
}

export async function resolveStore(input: { name: string; city: string; state: string; zip?: string | null }): Promise<NewStore> {
  const city = input.city.trim();
  const state = input.state.trim().toUpperCase();
  const location = { city, state, zip: input.zip?.trim() || (await zipForCity(city, state)) };
  const known = KNOWN_CHAINS.find((c) => c.match.test(input.name.trim()));
  if (known) {
    return { name: known.name, ...location, store_number: null, base_url: known.base_url, weekly_ad_url: known.weekly_ad_url };
  }

  // Unknown chain: find its site and weekly ad for this location.
  const results = await tavilySearch(`${input.name} weekly ad ${location.city} ${location.state}`, { maxResults: 5 });
  const adPage = results.find((r) => /weekly|circular|ad|specials|deals/i.test(r.url)) ?? results[0];
  if (!adPage) throw new Error(`Couldn't find a website for ${input.name} in ${location.city}, ${location.state}`);
  return {
    name: input.name.trim(),
    ...location,
    store_number: null,
    base_url: new URL(adPage.url).origin,
    weekly_ad_url: adPage.url,
  };
}
