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

for (const [region, origin, language] of [["UK", "https://www.tesco.com", "en-GB"], ["IE", "https://www.tesco.ie", "en-IE"]]) {
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
    assert.equal(h.referer, `${origin}/groceries/`);
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
