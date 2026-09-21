import assert from "node:assert/strict";
import { test } from "node:test";
import { bestOffers, perLbPrice } from "../../src/lib/everyday";
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

test("sales and everyday prices are ranked together by what you'd pay", () => {
  const [cut] = bestOffers([
    r({ store: "Publix", unit_price: "$5.49/lb", regular_price: 5.49 }),
    r({ store: "Wegmans", unit_price: "$4.99/lb", regular_price: 4.99 }),
    r({ store: "Lowes Foods", unit_price: "$4.99/lb", on_sale: true, sale_price: 4.99, regular_price: 7.99 }),
    r({ store: "ALDI", unit_price: "$5.29/lb", on_sale: true, sale_price: 5.29, regular_price: 6.19 }),
    r({ store: "Harris Teeter", unit_price: "$6.99/lb", on_sale: true, sale_price: 6.99, regular_price: 7.99 }),
  ]);
  // Top 3 by price; the tie at $4.99 lists the sale first.
  assert.deepEqual(
    cut.ranked.map((o) => [o.store, o.price, o.on_sale]),
    [
      ["Lowes Foods", 4.99, true],
      ["Wegmans", 4.99, false],
      ["ALDI", 5.29, true],
    ],
  );
  assert.equal(cut.compared, 5);
});

test("ties at the cutoff are all kept", () => {
  const [cut] = bestOffers(
    [
      r({ store: "A", unit_price: "$3.00/lb", regular_price: 3 }),
      r({ store: "B", unit_price: "$4.00/lb", regular_price: 4 }),
      r({ store: "C", unit_price: "$4.00/lb", regular_price: 4 }),
    ],
    2,
  );
  assert.deepEqual(cut.ranked.map((o) => o.store), ["A", "B", "C"]);
});

test("unverified results are left out; package-priced sales are listed separately", () => {
  const [cut] = bestOffers([
    r({ store: "Wegmans", unit_price: "$4.99/lb", regular_price: 4.99 }),
    r({ store: "ALDI", unit_price: "$3.99/lb", regular_price: 3.99, status: "unverified" }),
    r({ store: "Publix", unit_price: "$9.99", on_sale: true, sale_price: 9.99, regular_price: 13.99 }),
    r({ store: "Food Lion", unit_price: "$6.49/ea", regular_price: 6.49 }),
  ]);
  assert.deepEqual(cut.ranked.map((o) => o.store), ["Wegmans"]);
  assert.deepEqual(cut.package_sales.map((o) => [o.store, o.price]), [["Publix", 9.99]]);
});
