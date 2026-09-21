import "server-only";
import { z } from "zod";
import { runStoreScout } from "./agents/storeScout";
import type { Trace } from "./agents/runtime";
import type { ToolDefinition } from "./openrouter";
import { getItemPrices } from "./prices";
import { addStores, addWatchItems, findSavedStore, listStores, listWatchItems, removeStores, removeWatchItems } from "./queries";

// The Happy Butcher's tools. Two of them hand work to specialist agents:
//   update_store_list (add) -> Store Scout, one per new store
//   get_item_prices         -> Deal Hunter + Cut Inspector
// manage_watch_list is plain bookkeeping.

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "update_store_list",
      description:
        "Add grocery stores the household shops at, each with its location (chains price by store/region). New stores are researched by the Store Scout (exact location, ZIP, weekly ad). Adds to the saved list, never replaces it; stores already saved are skipped. Use action 'list' to see saved stores, 'remove' with store_ids to drop some.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "list", "remove"] },
          stores: {
            type: "array",
            description: "Stores to add (action 'add').",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Store/chain name, e.g. 'Harris Teeter'" },
                city: { type: "string" },
                state: { type: "string", description: "Two-letter state code" },
                zip: { type: "string", description: "Optional ZIP code" },
              },
              required: ["name", "city", "state"],
            },
          },
          store_ids: { type: "array", items: { type: "integer" }, description: "Store ids to remove (action 'remove')." },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_watch_list",
      description:
        "The household's standing list of meat cuts checked every Wednesday. 'add' appends cuts (duplicates skipped, never replaces), 'remove' drops cuts, 'list' shows the list. Keep cuts distinct as the user names them (e.g. 'pork tenderloin' and 'marinated pork tenderloin' are different items).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "remove", "list"] },
          items: { type: "array", items: { type: "string" }, description: "Cut names for add/remove." },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_item_prices",
      description:
        "Send the Deal Hunter to price ONE meat cut at every saved store; the Cut Inspector verifies each finding. Returns per store: status (found / not_found / unverified), the store's product name, regular_price, sale_price (null if not on sale), unit_price, on_sale, promo_text, a link, and a note.",
      parameters: {
        type: "object",
        properties: { item: { type: "string", description: "The cut, e.g. 'ribeye steaks'" } },
        required: ["item"],
      },
    },
  },
];

const StoreArgs = z.object({
  action: z.enum(["add", "list", "remove"]),
  stores: z.array(z.object({ name: z.string(), city: z.string(), state: z.string(), zip: z.string().optional() })).optional(),
  store_ids: z.array(z.number().int()).optional(),
});
const WatchArgs = z.object({ action: z.enum(["add", "remove", "list"]), items: z.array(z.string()).optional() });
const PriceArgs = z.object({ item: z.string().min(1) });

const label = (s: { name: string; city: string; state: string }) => `${s.name} (${s.city}, ${s.state})`;
const storeView = (s: Awaited<ReturnType<typeof listStores>>[number]) => ({
  id: s.id,
  store: label(s),
  address: s.address,
  weekly_ad: s.ad_source === "none" ? "no reachable weekly ad" : "weekly ad tracked",
});

/** Runs one of the Butcher's tool calls and returns a JSON-serializable result for him. */
export async function runTool(name: string, args: unknown, trace: Trace): Promise<unknown> {
  switch (name) {
    case "update_store_list": {
      const a = StoreArgs.parse(args);
      if (a.action === "list") return { stores: (await listStores()).map(storeView) };
      if (a.action === "remove") return { removed: await removeStores(a.store_ids ?? []), stores: (await listStores()).map(storeView) };

      const alreadySaved: string[] = [];
      const toScout: typeof a.stores = [];
      for (const s of a.stores ?? []) {
        if (await findSavedStore(s.name, s.city, s.state)) alreadySaved.push(label(s));
        else toScout!.push(s);
      }
      const scouted = await Promise.all(
        (toScout ?? []).map(async (s) => {
          trace.add("Happy Butcher", "handoff", `sent the Store Scout to find ${label(s)}`);
          try {
            return await runStoreScout(s, trace);
          } catch (err) {
            trace.add("Store Scout", "error", `${label(s)}: ${err instanceof Error ? err.message : err}`);
            return null;
          }
        }),
      );
      const added = await addStores(scouted.filter((s) => s !== null));
      return {
        added: added.map((s) => ({ ...storeView(s), scout_notes: s.scout_notes })),
        already_saved: alreadySaved,
        could_not_resolve: (toScout ?? []).filter((_, i) => scouted[i] === null).map(label),
        stores: (await listStores()).map(storeView),
      };
    }
    case "manage_watch_list": {
      const a = WatchArgs.parse(args);
      const items = (a.items ?? []).map((i) => i.trim()).filter(Boolean);
      if (a.action === "add") {
        const added = (await addWatchItems(items)).map((w) => w.name);
        return { added, already_on_list: items.filter((i) => !added.includes(i)), watch_list: (await listWatchItems()).map((w) => w.name) };
      }
      if (a.action === "remove") {
        return { removed: await removeWatchItems(items), watch_list: (await listWatchItems()).map((w) => w.name) };
      }
      return { watch_list: (await listWatchItems()).map((w) => w.name) };
    }
    case "get_item_prices": {
      const a = PriceArgs.parse(args);
      const watch = (await listWatchItems()).find((w) => w.name.toLowerCase() === a.item.toLowerCase());
      return { item: a.item, results: await getItemPrices(a.item, { source: "chat", watchItemId: watch?.id ?? null, trace }) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
