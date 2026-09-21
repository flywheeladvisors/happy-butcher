// Standalone price lookup, outside the chat: npx tsx --conditions react-server --env-file=.env.local scripts/check-price.ts "ribeye steaks" [chat|weekly]
import { getItemPrices } from "../src/lib/prices";

const item = process.argv[2] ?? "ribeye steaks";
const source = (process.argv[3] as "chat" | "weekly") ?? "weekly";
async function main() {
const started = Date.now();
const results = await getItemPrices(item, { source });
console.table(
  results.map((r) => ({
    store: r.store,
    status: r.status,
    product: r.product_name?.slice(0, 60),
    regular: r.regular_price,
    sale: r.sale_price,
    unit: r.unit_price,
    on_sale: r.on_sale,
    promo: r.promo_text?.slice(0, 50),
  })),
);
for (const r of results) console.log(`${r.store}: ${r.note ?? ""} ${r.product_url ?? ""}`);
console.log(`${((Date.now() - started) / 1000).toFixed(1)}s`);
}

void main();
