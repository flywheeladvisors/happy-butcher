import assert from "node:assert/strict";
import { test } from "node:test";
import { lowestEveryday, perLbPrice } from "../../src/lib/everyday";
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
  on_sale: false,
  promo_text: null,
  product_url: null,
  note: null,
  ...over,
});

test("per-lb detection", () => {
  assert.equal(perLbPrice(r({ unit_price: "$4.99/lb", regular_price: 4.99 })), 4.99);
  assert.equal(perLbPrice(r({ unit_price: "$4.99 /lb", regular_price: 4.99 })), 4.99);
  assert.equal(perLbPrice(r({ unit_price: "$6.49/ea", regular_price: 6.49 })), null);
  assert.equal(perLbPrice(r({ unit_price: "$14.99", regular_price: 14.99 })), null);
  assert.equal(perLbPrice(r({ unit_price: "$1.99/lb", on_sale: true, sale_price: 1.99, regular_price: 2.29 })), 1.99);
});

test("lowest everyday per cut ignores sales, unverified, and non-per-lb prices", () => {
  const best = lowestEveryday([
    r({ store: "Wegmans", unit_price: "$4.99/lb", regular_price: 4.99 }),
    r({ store: "Publix", unit_price: "$5.49/lb", regular_price: 5.49 }),
    r({ store: "ALDI", unit_price: "$3.99/lb", regular_price: 3.99, status: "unverified" }),
    r({ store: "Lidl", unit_price: "$2.99/lb", on_sale: true, sale_price: 2.99, regular_price: 3.99 }),
    r({ store: "Food Lion", unit_price: "$6.49/ea", regular_price: 6.49 }),
    r({ item: "Chicken breasts", store: "Wegmans", unit_price: "$2.29/lb", regular_price: 2.29 }),
  ]);
  assert.deepEqual(
    best.map((b) => [b.item, b.store, b.per_lb, b.compared]),
    [
      ["80/20 ground beef", "Wegmans", 4.99, 2],
      ["Chicken breasts", "Wegmans", 2.29, 1],
    ],
  );
});
