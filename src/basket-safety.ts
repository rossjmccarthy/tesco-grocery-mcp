import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./client.js";
import { TescoError, type Basket } from "./types.js";

/**
 * Safety around basket writes: work out what a change will do before making
 * it (so it can be previewed), and remember what each change replaced (so it
 * can be undone). Tesco's UpdateBasket sets absolute quantities, so without
 * this a second recipe needing onions would silently overwrite the first.
 */

export type ChangeMode = "add" | "set";

export interface PlannedItem {
  id: string;
  title: string | null;
  before: number;
  after: number;
  /** Estimated cost of this line's change; null when no price is known. */
  costChange: number | null;
}

export interface Plan {
  items: PlannedItem[];
  /** Lines whose quantity goes down (only possible with mode "set" or a removal). */
  reductions: string[];
  /** Sum of known line changes; Clubcard and multibuy prices can make the real total differ. */
  estimatedCostChange: number;
  unpricedItems: string[];
}

/** Per-unit price of each line already in the basket (line cost / quantity). */
export function unitCosts(basket: Basket): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of basket.items) {
    if (item.quantity > 0) out.set(item.id, item.cost / item.quantity);
  }
  return out;
}

export function currentQuantities(basket: Basket): Map<string, number> {
  return new Map(basket.items.map((i) => [i.id, i.quantity]));
}

/**
 * Turn requested changes into before/after quantities. In "add" mode the
 * requested quantity is added to what is there (repeated ids add up); in
 * "set" mode it replaces it (repeating an id is refused as ambiguous).
 */
export function planChanges(
  requests: Array<{ id: string; quantity: number }>,
  mode: ChangeMode,
  current: Map<string, number>,
  prices: Map<string, number>,
  titles: Map<string, string> = new Map(),
): Plan {
  const wanted = new Map<string, number>();
  for (const r of requests) {
    if (mode === "set") {
      if (wanted.has(r.id)) {
        throw new TescoError("INVALID_REQUEST", `Product ${r.id} is listed twice; with mode "set" give each product once.`);
      }
      wanted.set(r.id, r.quantity);
    } else {
      if (r.quantity < 1) {
        throw new TescoError("INVALID_REQUEST", `Quantity for ${r.id} must be at least 1 with mode "add"; use mode "set" or remove_from_basket to lower it.`);
      }
      wanted.set(r.id, (wanted.get(r.id) ?? current.get(r.id) ?? 0) + r.quantity);
    }
  }

  const items: PlannedItem[] = [];
  const reductions: string[] = [];
  const unpricedItems: string[] = [];
  let estimatedCostChange = 0;
  for (const [id, after] of wanted) {
    const before = current.get(id) ?? 0;
    const price = prices.get(id);
    const costChange = price === undefined ? null : round2((after - before) * price);
    if (costChange === null && after !== before) unpricedItems.push(id);
    else if (costChange !== null) estimatedCostChange += costChange;
    if (after < before) reductions.push(id);
    items.push({ id, title: titles.get(id) ?? null, before, after, costChange });
  }
  return { items, reductions, estimatedCostChange: round2(estimatedCostChange), unpricedItems };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Change history (for undo) ──────────────────────────────────────────────

export interface ChangeRecord {
  id: string;
  at: string;
  tool: string;
  items: Array<{ id: string; before: number; after: number }>;
}

const KEEP = 20;

function historyPath(): string {
  return process.env.TESCO_HISTORY_PATH ?? join(getConfigDir(), "basket-history.json");
}

export function readHistory(): ChangeRecord[] {
  const path = historyPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? (parsed as ChangeRecord[]) : [];
  } catch {
    console.error(`[tesco] Basket history at ${path} is unreadable; starting a new one`);
    return [];
  }
}

function writeHistory(records: ChangeRecord[]): void {
  const path = historyPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(records.slice(-KEEP), null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* no-op on Windows */ }
}

/** Record a change before it is sent, so it can be undone even if the reply is lost. */
export function recordChange(tool: string, plan: Plan): ChangeRecord {
  const record: ChangeRecord = {
    id: `chg-${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    tool,
    items: plan.items.filter((i) => i.before !== i.after).map(({ id, before, after }) => ({ id, before, after })),
  };
  writeHistory([...readHistory(), record]);
  return record;
}

export function dropChange(id: string): void {
  writeHistory(readHistory().filter((r) => r.id !== id));
}
