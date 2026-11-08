// Offline checks against a fake Tesco (no network, no account).
// Run with: npm test
import assert from "node:assert/strict";
import { fakeTesco, mcpServer } from "./lib.mjs";

let failures = 0;
let checks = 0;
const check = async (name, fn) => {
  checks++;
  try {
    await fn();
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
};

// Search results in the shape flattenProducts reads.
const product = (id, title, price, unitPrice = price, unitOfMeasure = "each") => ({
  node: { id, tpnb: `b${id}`, title, brandName: "Tesco", sellers: { results: [{ isForSale: true, price: { price, unitPrice, unitOfMeasure } }] } },
});

// ─── Store setting ───────────────────────────────────────────────────────────

for (const [region, origin, language, shopPath] of [["UK", "https://www.tesco.com", "en-GB", "/groceries/"], ["IE", "https://www.tesco.ie", "en-IE", "/shop/en-IE/"]]) {
  const fake = await fakeTesco({ Search: () => ({ search: { results: [product("1", "Milk", 1.2)], pageInformation: { totalCount: 1 } } }) });
  const srv = await mcpServer({ TESCO_API_URL: fake.url, ...(region === "UK" ? {} : { TESCO_REGION: region }) });
  const r = await srv.call("search_products", { queries: [{ query: "milk" }] });
  srv.close();
  fake.close();
  await check(`store ${region}: search sends the ${region} headers`, () => {
    assert.equal(r.ok, true, r.text);
    const h = fake.calls[0].headers;
    assert.equal(h.region, region);
    assert.equal(h.origin, origin);
    assert.equal(h.referer, `${origin}${shopPath}`);
    assert.equal(h.language, language);
  });
}
{
  const fake = await fakeTesco({ Search: () => ({ search: { results: [] } }) });
  const srv = await mcpServer({ TESCO_API_URL: fake.url, TESCO_REGION: "IE", TESCO_LANGUAGE: "en-GB" });
  await srv.call("search_products", { queries: [{ query: "milk" }] });
  srv.close();
  fake.close();
  await check("TESCO_LANGUAGE overrides the store's language", () =>
    assert.equal(fake.calls[0].headers.language, "en-GB"));
}

// ─── Safe basket changes ─────────────────────────────────────────────────────

/**
 * A stateful fake basket. UpdateBasket sets absolute quantities, as Tesco's
 * does (newValue with adjustment false); 0 removes the line.
 */
function basketFake(initial, prices, { failUpdate = false } = {}) {
  const qty = new Map(Object.entries(initial));
  const titles = { A: "Onions 1kg", B: "Chopped tomatoes 400g", C: "Spaghetti 500g" };
  const lines = () =>
    [...qty].map(([id, q]) => ({ product: { id, isForSale: true, status: "AvailableForSale" }, quantity: q, cost: Math.round(q * prices[id] * 100) / 100 }));
  const basket = () => ({ id: "order-1", splitView: [{ guidePrice: lines().reduce((s, l) => s + l.cost, 0), items: lines() }] });
  return {
    qty,
    handlers: {
      GetBasket: () => ({ basket: basket() }),
      UpdateBasket: (v) => {
        if (failUpdate) throw new Error("basket service unavailable");
        for (const item of v.items) {
          if (item.newValue === 0) qty.delete(item.id);
          else qty.set(item.id, item.newValue);
        }
        return { basket: { updates: { items: v.items.map((i) => ({ id: i.id, successful: true })) }, splitView: [{ items: lines() }] } };
      },
      Search: (v) => ({ search: { results: prices[v.query] !== undefined ? [product(v.query, titles[v.query], prices[v.query])] : [] } }),
    },
  };
}
const prices = { A: 1.5, B: 0.89, C: 1.2 };
const updates = (fake) => fake.calls.filter((c) => c.operationName === "UpdateBasket");

// add mode adds to what is there; dryRun changes nothing.
{
  const b = basketFake({ A: 2 }, prices);
  const fake = await fakeTesco(b.handlers);
  const srv = await mcpServer({ TESCO_API_URL: fake.url });
  const dry = await srv.call("add_to_basket", { items: [{ id: "A", quantity: 1 }, { id: "B", quantity: 3 }], dryRun: true });
  const afterDry = Object.fromEntries(b.qty);
  const real = await srv.call("add_to_basket", { items: [{ id: "A", quantity: 1 }, { id: "B", quantity: 3 }] });
  srv.close();
  fake.close();
  await check("dryRun previews quantities and estimated cost, and writes nothing", () => {
    assert.equal(dry.ok, true, dry.text);
    assert.equal(dry.json.dryRun, true);
    assert.deepEqual(dry.json.changes.map((c) => [c.id, c.before, c.after]), [["A", 2, 3], ["B", 0, 3]]);
    assert.equal(dry.json.changes[1].title, "Chopped tomatoes 400g");
    assert.equal(dry.json.estimatedCostChange, 4.17);
    assert.equal(dry.json.currentGuidePrice, 3);
    assert.equal(dry.json.estimatedGuidePrice, 7.17);
    assert.deepEqual(afterDry, { A: 2 });
  });
  await check('mode "add" adds to existing quantities instead of overwriting them', () => {
    assert.equal(real.ok, true, real.text);
    assert.deepEqual(Object.fromEntries(b.qty), { A: 3, B: 3 });
    assert.equal(updates(fake).length, 1);
    assert.match(real.json.undo.changeId, /^chg-/);
  });
}

// Two recipes needing the same product add up, in one call or across calls.
{
  const b = basketFake({}, prices);
  const fake = await fakeTesco(b.handlers);
  const srv = await mcpServer({ TESCO_API_URL: fake.url });
  await srv.call("add_to_basket", { items: [{ id: "A", quantity: 1 }, { id: "A", quantity: 2 }] });
  await srv.call("add_to_basket", { items: [{ id: "A", quantity: 1 }] });
  srv.close();
  fake.close();
  await check("the same product from two recipes adds up", () => assert.equal(b.qty.get("A"), 4));
}

// Refusals and reductions.
{
  const b = basketFake({ A: 3 }, prices);
  const fake = await fakeTesco(b.handlers);
  const srv = await mcpServer({ TESCO_API_URL: fake.url });
  const zero = await srv.call("add_to_basket", { items: [{ id: "A", quantity: 0 }] });
  const dup = await srv.call("add_to_basket", { items: [{ id: "A", quantity: 1 }, { id: "A", quantity: 2 }], mode: "set" });
  const lower = await srv.call("add_to_basket", { items: [{ id: "A", quantity: 1 }], mode: "set", dryRun: true });
  const same = await srv.call("add_to_basket", { items: [{ id: "A", quantity: 3 }], mode: "set" });
  srv.close();
  fake.close();
  await check('mode "add" refuses quantity 0, writing nothing', () => {
    assert.equal(zero.ok, false);
    assert.match(zero.json.message, /at least 1 with mode "add"/);
  });
  await check('mode "set" refuses a product listed twice', () => {
    assert.equal(dup.ok, false);
    assert.match(dup.text, /listed twice/);
  });
  await check('a "set" that lowers a quantity is flagged as a reduction', () =>
    assert.deepEqual(lower.json.reductions, ["A"]));
  await check("a change to the same quantity sends no update", () => {
    assert.equal(same.ok, true, same.text);
    assert.match(same.json.message, /Nothing to change/);
    assert.equal(updates(fake).length, 0);
  });
}

// Undo, including lines changed since and a write that never landed.
{
  const b = basketFake({ A: 2 }, prices);
  const fake = await fakeTesco(b.handlers);
  const srv = await mcpServer({ TESCO_API_URL: fake.url });
  await srv.call("add_to_basket", { items: [{ id: "A", quantity: 1 }, { id: "B", quantity: 3 }] });
  const undoDry = await srv.call("undo_last_basket_change", { dryRun: true });
  const undo = await srv.call("undo_last_basket_change");
  const none = await srv.call("undo_last_basket_change");
  await check("undo dryRun previews without writing", () => {
    assert.deepEqual(undoDry.json.restore.map((r) => [r.id, r.quantity]), [["A", 2], ["B", 0]]);
  });
  await check("undo puts back the quantities from before the change", () => {
    assert.equal(undo.ok, true, undo.text);
    assert.deepEqual(Object.fromEntries(b.qty), { A: 2 });
    assert.match(none.json.message, /No basket change to undo/);
  });

  await srv.call("add_to_basket", { items: [{ id: "A", quantity: 1 }, { id: "C", quantity: 1 }] });
  b.qty.set("A", 9); // changed on the website since
  const partial = await srv.call("undo_last_basket_change");
  const partialState = Object.fromEntries(b.qty);
  const forced = await srv.call("undo_last_basket_change", { force: true });
  await check("undo leaves alone a line changed since, and restores the rest", () => {
    assert.deepEqual(partial.json.skipped, [{ id: "A", expected: 3, now: 9 }]);
    assert.deepEqual(partialState, { A: 9 });
  });
  await check("undo with force restores it too", () => {
    assert.equal(forced.ok, true, forced.text);
    assert.deepEqual(Object.fromEntries(b.qty), { A: 2 });
  });

  const rmDry = await srv.call("remove_from_basket", { ids: ["A"], dryRun: true });
  const rm = await srv.call("remove_from_basket", { ids: ["A"] });
  const rmGone = Object.fromEntries(b.qty);
  await srv.call("undo_last_basket_change");
  srv.close();
  fake.close();
  await check("remove_from_basket previews, removes, and can be undone", () => {
    assert.deepEqual(rmDry.json.reductions, ["A"]);
    assert.equal(rmDry.json.estimatedCostChange, -3);
    assert.equal(rm.ok, true, rm.text);
    assert.deepEqual(rmGone, {});
    assert.deepEqual(Object.fromEntries(b.qty), { A: 2 });
  });
  const { stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await check("the change history file is private (0600)", async () =>
    assert.equal((await stat(join(srv.dir, "tesco-grocery-mcp", "basket-history.json"))).mode & 0o777, 0o600));
}
{
  const b = basketFake({ A: 2 }, prices, { failUpdate: true });
  const fake = await fakeTesco(b.handlers);
  const srv = await mcpServer({ TESCO_API_URL: fake.url });
  const failed = await srv.call("add_to_basket", { items: [{ id: "A", quantity: 1 }] });
  const undo = await srv.call("undo_last_basket_change");
  srv.close();
  fake.close();
  await check("a rejected update is reported as an error", () => {
    assert.equal(failed.ok, false);
    assert.match(failed.text, /Basket update failed: basket service unavailable/);
  });
  await check("undo after a write that never landed changes nothing and clears it", () => {
    assert.equal(undo.ok, true, undo.text);
    assert.deepEqual(undo.json.restore, []);
    assert.equal(updates(fake).length, 1);
  });
}

// ─── Server instructions ─────────────────────────────────────────────────────

{
  const srv = await mcpServer({ TESCO_API_URL: "http://127.0.0.1:9/", TESCO_REGION: "IE" });
  const init = await srv.initializeResult();
  srv.close();
  await check("instructions name the store, the DocMost preferences page and the safety rules", () => {
    const text = init.instructions ?? "";
    assert.match(text, /\(IE, prices in EUR\)/);
    assert.match(text, /"Tesco Shopping Preferences"/);
    assert.match(text, /dryRun: true/);
    assert.match(text, /There is no checkout/);
  });
}

// ─── Tool names and stdout ───────────────────────────────────────────────────

{
  const srv = await mcpServer({ TESCO_API_URL: "http://127.0.0.1:9/" });
  const tools = await srv.listTools();
  srv.close();
  await check("tools listed", () => assert.ok(tools.length > 0));
  for (const t of tools) {
    await check(`tool name: ${t.name}`, () => assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/));
  }
  await check("stdout carries protocol only", () => assert.deepEqual(srv.strayStdout, []));
}

console.log(failures ? `${failures} failed` : `all ${checks} checks passed`);
process.exitCode = failures ? 1 : 0;
