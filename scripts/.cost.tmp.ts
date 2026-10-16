import { Trace } from "../src/lib/agents/runtime";
import { getItemPrices } from "../src/lib/prices";
async function main() {
  let total = 0;
  for (const cut of ["Chuck roast", "Pork tenderloin", "Ribeye steaks", "Chicken breasts"]) {
    const trace = new Trace();
    await getItemPrices(cut, { source: "weekly", trace });
    total += trace.totalCost;
    console.log(`${cut.padEnd(18)} $${trace.totalCost.toFixed(4)}  cache read ${trace.cacheRead} tok, written ${trace.cacheWritten} tok`);
  }
  console.log(`total $${total.toFixed(4)} over 4 cuts`);
}
void main();
