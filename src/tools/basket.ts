import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendOperation, sendOperations, requireAuth, setOrderId, extractOrderId, STORE } from "../client.js";
import { buildOperation } from "../queries.js";
import { flattenBasket, flattenBasketUpdate, flattenProducts } from "../transform.js";
import { TescoError, toolErrorResponse, type Basket } from "../types.js";
import {
  planChanges,
  unitCosts,
  currentQuantities,
  recordChange,
  readHistory,
  dropChange,
  type ChangeMode,
  type Plan,
} from "../basket-safety.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

/** Read the basket fresh: quantities must be current for "add", previews and undo. */
async function readBasket(): Promise<{ orderId: string; basket: Basket }> {
  const response = await sendOperation(buildOperation("GetBasket", {}, "mfe-basket"));
  const raw = response.data?.basket as Record<string, unknown> | undefined;
  const orderId = extractOrderId(raw);
  if (!raw || !orderId) throw new TescoError("API_ERROR", "Could not read the basket (no order ID returned).");
  setOrderId(orderId);
  return { orderId, basket: flattenBasket(raw) };
}

/**
 * Shelf prices and titles for products not yet in the basket, in one
 * batched request (search by product ID, as get_product_details does).
 */
async function lookupProducts(ids: string[]): Promise<{ prices: Map<string, number>; titles: Map<string, string> }> {
  const prices = new Map<string, number>();
  const titles = new Map<string, string>();
  if (!ids.length) return { prices, titles };
  const ops = ids.map((id) =>
    buildOperation(
      "Search",
      {
        query: id, page: 1, count: 1, sortBy: "relevance", includeRestrictions: true, includeVariations: true,
        showDepositReturnCharge: false, showPopularFilter: true, showExpandedResults: false, includeRangeFilter: false,
        showSuggestedSearch: false, includeAdditionalInfo: true, includeIsInAnyList: true,
        filterCriteria: [{ name: "inputType", values: ["free text"] }], appliedFacetArgs: [], configs: [], suggestionsMaxTimeOut: 600,
      },
      "mfe-plp",
    ),
  );
  const responses = await sendOperations(ops, { authenticated: false });
  responses.forEach((res, i) => {
    const search = res.data?.search as Record<string, unknown> | undefined;
    const found = flattenProducts((search?.results ?? []) as Array<Record<string, unknown>>).find((p) => p.id === ids[i]);
    if (found) {
      prices.set(found.id, found.price);
      titles.set(found.id, found.title);
    }
  });
  return { prices, titles };
}

/** Plan a change against the current basket, pricing anything not yet in it. */
async function plan(
  requests: Array<{ id: string; quantity: number }>,
  mode: ChangeMode,
): Promise<{ orderId: string; basket: Basket; plan: Plan }> {
  const { orderId, basket } = await readBasket();
  const prices = unitCosts(basket);
  const missing = [...new Set(requests.map((r) => r.id))].filter((id) => !prices.has(id));
  const looked = await lookupProducts(missing);
  for (const [id, p] of looked.prices) prices.set(id, p);
  return { orderId, basket, plan: planChanges(requests, mode, currentQuantities(basket), prices, looked.titles) };
}

function preview(basket: Basket, p: Plan) {
  return {
    dryRun: true,
    message: "Nothing was changed. Call again without dryRun to apply.",
    currency: STORE.currency,
    changes: p.items,
    reductions: p.reductions,
    estimatedCostChange: p.estimatedCostChange,
    currentGuidePrice: basket.guidePrice,
    estimatedGuidePrice: Math.round((basket.guidePrice + p.estimatedCostChange) * 100) / 100,
    ...(p.unpricedItems.length ? { unpricedItems: p.unpricedItems, note: "No price found for these, so the estimate leaves them out." } : {}),
  };
}

/** Send absolute quantities, then read the basket back. */
async function writeQuantities(orderId: string, items: Array<{ id: string; quantity: number }>) {
  const updateOp = buildOperation(
    "UpdateBasket",
    {
      orderId,
      items: items.map((item) => ({ adjustment: false, id: item.id, newValue: item.quantity, newUnitChoice: "pcs" })),
    },
    "mfe-basket",
  );
  const results = await sendOperations([updateOp, buildOperation("GetBasket", {}, "mfe-basket")]);
  if (results[0].errors?.length) {
    throw new TescoError("API_ERROR", `Basket update failed: ${results[0].errors.map((e) => e.message).join("; ")}`);
  }
  const updateData = results[0].data?.basket as Record<string, unknown>;
  const basketData = results[1].data?.basket as Record<string, unknown>;
  const oid = extractOrderId(basketData);
  if (oid) setOrderId(oid);
  return flattenBasketUpdate(updateData, basketData);
}

/** Apply a plan: record it for undo first, then write the changed lines. */
async function apply(tool: string, orderId: string, p: Plan) {
  const changed = p.items.filter((i) => i.before !== i.after);
  if (!changed.length) {
    return { success: true, message: "Nothing to change: the basket already has these quantities.", changes: p.items };
  }
  const record = recordChange(tool, p);
  const result = await writeQuantities(orderId, changed.map((i) => ({ id: i.id, quantity: i.after })));
  return {
    ...result,
    currency: STORE.currency,
    changes: p.items,
    reductions: p.reductions,
    undo: { changeId: record.id, hint: "undo_last_basket_change puts these quantities back." },
  };
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export function registerBasketTools(server: McpServer): void {
  server.tool(
    "get_basket",
    "Get the current basket contents.",
    {},
    async () => {
      try {
        requireAuth();
        const { basket } = await readBasket();
        return json({ currency: STORE.currency, ...basket });
      } catch (e) {
        return toolErrorResponse(e);
      }
    },
  );

  server.tool(
    "add_to_basket",
    'Add products to the basket. mode "add" (default) adds to what is already there and never lowers a quantity, so recipes can be combined; mode "set" sets exact quantities (0 removes). dryRun previews quantities and estimated cost without changing anything. Undo: undo_last_basket_change.',
    {
      items: z
        .array(
          z.object({
            id: z.string().describe("Product ID"),
            quantity: z.number().int().min(0).describe('How many to add (mode "add"), or the exact quantity (mode "set")'),
          }),
        )
        .min(1),
      mode: z.enum(["add", "set"]).optional(),
      dryRun: z.boolean().optional().describe("Preview only"),
    },
    async (args) => {
      try {
        requireAuth();
        const { orderId, basket, plan: p } = await plan(args.items, args.mode ?? "add");
        if (args.dryRun) return json(preview(basket, p));
        return json(await apply("add_to_basket", orderId, p));
      } catch (e) {
        return toolErrorResponse(e);
      }
    },
  );

  server.tool(
    "remove_from_basket",
    "Remove products from the basket. dryRun previews it. Undo: undo_last_basket_change.",
    {
      ids: z.array(z.string()).min(1).describe("Product IDs to remove"),
      dryRun: z.boolean().optional().describe("Preview only"),
    },
    async (args) => {
      try {
        requireAuth();
        const ids = [...new Set(args.ids)];
        const { orderId, basket, plan: p } = await plan(ids.map((id) => ({ id, quantity: 0 })), "set");
        if (args.dryRun) return json(preview(basket, p));
        return json(await apply("remove_from_basket", orderId, p));
      } catch (e) {
        return toolErrorResponse(e);
      }
    },
  );

  server.tool(
    "undo_last_basket_change",
    "Put back the quantities from before the last add_to_basket or remove_from_basket. Skips lines changed since (e.g. on the website) unless force. dryRun previews it.",
    {
      dryRun: z.boolean().optional().describe("Preview only"),
      force: z.boolean().optional().describe("Also restore lines changed since"),
    },
    async (args) => {
      try {
        requireAuth();
        const last = readHistory().at(-1);
        if (!last) return json({ success: true, message: "No basket change to undo." });

        const { orderId, basket } = await readBasket();
        const current = currentQuantities(basket);
        const restore: Array<{ id: string; quantity: number; from: number }> = [];
        const skipped: Array<{ id: string; expected: number; now: number }> = [];
        for (const item of last.items) {
          const now = current.get(item.id) ?? 0;
          // Already back where it was (e.g. the original write never landed).
          if (now === item.before) continue;
          if (now !== item.after && !args.force) skipped.push({ id: item.id, expected: item.after, now });
          else restore.push({ id: item.id, quantity: item.before, from: now });
        }
        const summary = {
          change: { id: last.id, at: last.at, tool: last.tool },
          restore,
          ...(skipped.length ? { skipped, note: "These changed after that edit, so they were left alone; pass force to restore them anyway." } : {}),
        };
        if (args.dryRun) return json({ dryRun: true, message: "Nothing was changed.", ...summary });

        const result = restore.length
          ? await writeQuantities(orderId, restore.map(({ id, quantity }) => ({ id, quantity })))
          : { success: true };
        // A partly skipped undo stays in history so it can be forced later.
        if (!skipped.length) dropChange(last.id);
        return json({ ...result, ...summary });
      } catch (e) {
        return toolErrorResponse(e);
      }
    },
  );
}
