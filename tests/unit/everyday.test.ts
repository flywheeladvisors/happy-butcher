import assert from "node:assert/strict";
import { test } from "node:test";
import { bestOffers } from "../../src/lib/everyday";
import { cutGroup, groupCuts } from "../../src/lib/cutGroup";
import type { PriceResult } from "../../src/lib/types";

const r = (over: Partial<PriceResult> & { item?: string }) => ({
  item: "80/20 ground beef",
  store_id: 1,
  store: "A",
  status: "found" as const,
  product_name: "Ground Beef 80/20",
  regular_price: null,
  sale_price: null,
  unit_price: null,
  per_lb_price: null,
  per_lb_source: null,
  on_sale: false,
  promo_text: null,
  product_url: null,
  note: null,
  ...over,
});

test("sales and everyday prices are ranked together by price per pound", () => {
  const [cut] = bestOffers([
    r({ store: "Publix", regular_price: 5.49, per_lb_price: 5.49, per_lb_source: "unit" }),
    r({ store: "Wegmans", regular_price: 4.99, per_lb_price: 4.99, per_lb_source: "unit" }),
    r({ store: "Lowes Foods", on_sale: true, sale_price: 4.99, regular_price: 7.99, per_lb_price: 4.99, per_lb_source: "unit" }),
    r({ store: "LIDL", on_sale: true, sale_price: 12.95, regular_price: 13.99, per_lb_price: 6.48, per_lb_source: "derived" }),
    r({ store: "Harris Teeter", on_sale: true, sale_price: 6.99, regular_price: 7.99, per_lb_price: 6.99, per_lb_source: "unit" }),
  ]);
  // Top 3 per lb; the tie at $4.99 lists the sale first. Lidl's $12.95 package converts to
  // $6.48/lb, which ranks below Publix's $5.49/lb even though its package price looks bigger.
  assert.deepEqual(
    cut.ranked.map((o) => [o.store, o.per_lb, o.on_sale]),
    [
      ["Lowes Foods", 4.99, true],
      ["Wegmans", 4.99, false],
      ["Publix", 5.49, false],
    ],
  );
  assert.equal(cut.compared, 5);
});

test("ties at the cutoff are all kept", () => {
  const [cut] = bestOffers(
    [
      r({ store: "A", regular_price: 3, per_lb_price: 3 }),
      r({ store: "B", regular_price: 4, per_lb_price: 4 }),
      r({ store: "C", regular_price: 4, per_lb_price: 4 }),
    ],
    2,
  );
  assert.deepEqual(cut.ranked.map((o) => o.store), ["A", "B", "C"]);
});

test("unverified results are left out; sales with no weight are listed separately", () => {
  const [cut] = bestOffers([
    r({ store: "Wegmans", regular_price: 4.99, per_lb_price: 4.99 }),
    r({ store: "ALDI", regular_price: 3.99, per_lb_price: 3.99, status: "unverified" }),
    r({ store: "Publix", on_sale: true, sale_price: 9.99, regular_price: 13.99 }),
  ]);
  assert.deepEqual(cut.ranked.map((o) => o.store), ["Wegmans"]);
  assert.deepEqual(cut.package_sales.map((o) => [o.store, o.price]), [["Publix", 9.99]]);
});

test("cuts group as Beef, Chicken, Pork", () => {
  assert.equal(cutGroup("Chuck roast"), "Beef");
  assert.equal(cutGroup("Picnic roast"), "Pork");
  assert.equal(cutGroup("Chicken thighs (boneless)"), "Chicken");
  assert.equal(cutGroup("80/20 ground beef"), "Beef");
  assert.deepEqual(
    groupCuts(["Boneless pork chops", "Chuck roast", "Chicken breasts", "Ribeye steaks"], (s) => s).map((g) => [g.group, g.items]),
    [
      ["Beef", ["Chuck roast", "Ribeye steaks"]],
      ["Chicken", ["Chicken breasts"]],
      ["Pork", ["Boneless pork chops"]],
    ],
  );
});
