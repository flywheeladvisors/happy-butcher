import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePublixAd } from "../../src/lib/adPages";
import { parseAdListing, parseSavings } from "../../src/lib/priceParse";

const listing = (over: Partial<Parameters<typeof parseAdListing>[0]>) => ({
  current_price: null,
  original_price: null,
  pre_price_text: null,
  post_price_text: null,
  sale_story: null,
  ...over,
});

test("savings wording", () => {
  assert.deepEqual(parseSavings("Save $2.30"), { amount: 2.3, approximate: false });
  assert.deepEqual(parseSavings("SAVE UP TO $2.00 LB"), { amount: 2, approximate: true });
  assert.deepEqual(parseSavings("save at least $6.00 per lb. with your VIC card"), { amount: 6, approximate: true });
  assert.deepEqual(parseSavings("Save 26¢ Save Even More -56¢"), { amount: 0.26, approximate: false });
  assert.equal(parseSavings("HOT SALE!!!"), null);
});

test("sale price with savings gives both prices", () => {
  const p = parseAdListing(listing({ current_price: 4.99, post_price_text: "lb", sale_story: "SAVE UP TO $2.00 LB" }));
  assert.equal(p.sale_price, 4.99);
  assert.equal(p.regular_price, 6.99);
  assert.equal(p.on_sale, true);
  assert.equal(p.regular_is_estimate, true);
  assert.equal(p.unit_price, "$4.99/lb");
});

test("crossed-out original price wins", () => {
  const p = parseAdListing(listing({ current_price: 12.99, original_price: 17.98 }));
  assert.deepEqual([p.regular_price, p.sale_price, p.on_sale], [17.98, 12.99, true]);
});

test("BOGO with no price is a sale with unknown prices", () => {
  const p = parseAdListing(listing({ sale_story: "BUY 1 GET 1 FREE each item rings at half price with your VIC card" }));
  assert.deepEqual([p.regular_price, p.sale_price, p.on_sale], [null, null, true]);
  assert.match(p.promo_text ?? "", /BUY 1 GET 1/);
});

test("sale wording without an amount", () => {
  const p = parseAdListing(listing({ current_price: 2.49, post_price_text: "MVP LB", sale_story: "HOT SALE!!!" }));
  assert.deepEqual([p.regular_price, p.sale_price, p.on_sale], [null, 2.49, true]);
});

test("plain advertised price is not flagged as a sale", () => {
  const p = parseAdListing(listing({ current_price: 2.49, post_price_text: "PER LB" }));
  assert.deepEqual([p.regular_price, p.sale_price, p.on_sale, p.unit_price], [2.49, null, false, "$2.49/lb"]);
});

test("Publix weekly-ad blocks", () => {
  const md = [
    "Your store has been set to Amberly Place.",
    "Add to list",
    "- ![Smithfield Marinated Pork Tenderloin](https://img)",
    "",
    "Smithfield Marinated Pork Tenderloin",
    "",
    "$6.99",
    "",
    "Or Loin Filet, 19.2 or 23-oz pkg.",
    "save up to $2.50",
    "Valid 9/16 - 9/22",
    "Add to list",
    "Publix Extra Lean Pork Loin Tenderloins",
    "$4.99 lb",
    "Boneless",
    "save up to $2.00 lb",
    "Valid 9/16 - 9/22",
    "Add to list",
  ].join("\n");
  const items = parsePublixAd(md);
  assert.equal(items.length, 2);
  assert.deepEqual(
    [items[0].product_name, items[0].current_price, items[0].details, items[0].sale_story, items[0].valid_text],
    ["Smithfield Marinated Pork Tenderloin", 6.99, "Or Loin Filet, 19.2 or 23-oz pkg.", "save up to $2.50", "Valid 9/16 - 9/22"],
  );
  assert.deepEqual([items[1].current_price, items[1].post_price_text], [4.99, "lb"]);
});
