import assert from "node:assert/strict";
import { test } from "node:test";
import { perLbFromUnitText, perPound, weightInPounds } from "../../src/lib/perPound";

test("weights in real product names", () => {
  assert.equal(weightInPounds("Butcher's Specialty ground beef, 85% lean (32 oz.)"), 2);
  assert.equal(weightInPounds("Wegmans Ground Beef 80/20, FAMILY PACK"), null);
  assert.equal(weightInPounds("Value Family Pack Fresh Ground Beef 80% Lean (Avg. 3 lbs per pack)"), 3);
  assert.equal(weightInPounds("Lowes Foods Boneless Skinless Chicken Breast Fillets (Avg. 1.5lb)"), 1.5);
  assert.equal(weightInPounds("Smithfield Marinated Pork Tenderloin, Or Loin Filet, 19.2 or 23-oz pkg."), 1.2);
  assert.equal(weightInPounds("18.4 - 22 oz. Hatfield Marinated Pork Loin Filet"), 1.15);
});

test("unit prices, including per-ounce", () => {
  assert.equal(perLbFromUnitText("$4.99/lb"), 4.99);
  assert.equal(perLbFromUnitText("$4.99 /lb"), 4.99);
  assert.equal(perLbFromUnitText("$ 0.41 per oz."), 6.56);
  assert.equal(perLbFromUnitText("$9.99 ea"), null);
  assert.equal(perLbFromUnitText("$14.99"), null);
});

test("per-pound price from a unit price, then from a package weight", () => {
  assert.deepEqual(perPound({ price: 4.99, unit_price: "$4.99/lb" }), { price: 4.99, source: "unit" });
  assert.deepEqual(perPound({ price: 6.49, unit_price: "$ 0.41 per oz.", product_name: "x (16 oz.)" }), { price: 6.56, source: "unit" });
  assert.deepEqual(perPound({ price: 12.95, unit_price: "$12.95/ea", product_name: "ground beef, 85% lean (32 oz.)" }), { price: 6.48, source: "derived" });
  assert.deepEqual(perPound({ price: 9.99, unit_price: "$9.99", product_name: "Force of Nature 80/20 Ground Beef, 16-oz pkg." }), { price: 9.99, source: "derived" });
  // Nothing published gives a weight.
  assert.equal(perPound({ price: 9.99, unit_price: "$9.99", product_name: "Publix Ground Chuck" }), null);
  assert.equal(perPound({ price: null, unit_price: null, product_name: "BOGO item" }), null);
});
