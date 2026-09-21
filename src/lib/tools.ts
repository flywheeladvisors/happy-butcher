import "server-only";
import { z } from "zod";
import type { ToolDefinition } from "./openrouter";
import { getItemPrices } from "./prices";
import { addStores, addWatchItems, listStores, listWatchItems, removeStores, removeWatchItems } from "./queries";
import { resolveStore } from "./storeResolver";

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "update_store_list",
      description:
        "Add grocery stores the household shops at, each with its location (chains price by store/region). Adds to the saved list, never replaces it; stores already saved are skipped. Use action 'list' to see saved stores, 'remove' with store_ids to drop some.",
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
        "Look up the current price of ONE meat cut at every saved store (location-specific). Returns per store: status (found / not_found / unverified), the store's product name, regular_price, sale_price (null if not on sale), unit_price, on_sale, promo_text, and a product or circular link.",
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

/** Runs one tool call and returns a JSON-serializable result for the model. */
export async function runTool(name: string, args: unknown): Promise<unknown> {
  switch (name) {
    case "update_store_list": {
      const a = StoreArgs.parse(args);
      if (a.action === "list") return { stores: await listStores() };
      if (a.action === "remove") return { removed: await removeStores(a.store_ids ?? []), stores: await listStores() };
      const resolved = await Promise.all((a.stores ?? []).map((s) => resolveStore(s)));
      const added = (await addStores(resolved)).map(label);
      return {
        added,
        already_saved: resolved.map(label).filter((l) => !added.includes(l)),
        stores: (await listStores()).map(label),
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
      return { item: a.item, results: await getItemPrices(a.item, { source: "chat" }) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
