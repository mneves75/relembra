/**
 * One measuring process for bench/eval-latency.ts, runnable under Bun and Node. It only reads the
 * store and checks that every call did its work (a result, a rendered memory), so no number is
 * for work that did not happen.
 *
 *   eval-worker.ts warm <db> <warmup> <measured> <queries-json>
 *     One open store; for find, wake and brief in turn, <warmup> unmeasured calls then
 *     <measured> measured ones, cycling the queries. Prints {"find":[ms…],"wake":[…],"brief":[…]}.
 *   eval-worker.ts cold <db> <find|wake|brief> <query>
 *     Opens the store, makes one call, closes it. Prints {"ms":…} for those three steps; the
 *     caller times the whole process.
 */
import { createRelembra, type Principal, type Relembra } from "../src/index.js";
import { openSqliteStore } from "../src/sqlite/index.js";

const SCOPE = "bench";
const OPS = ["find", "wake", "brief"] as const;
type Op = (typeof OPS)[number];
const FIND_LIMIT = 10;
const WAKE_BUDGET_BYTES = 9500;
const BRIEF_BUDGET_BYTES = 4000;

const reader: Principal = { id: "bench-reader", readable: [SCOPE], writable: [], promotable: [] };

async function call(relembra: Relembra<null>, op: Op, query: string): Promise<void> {
  let carried: number;
  if (op === "find") {
    carried = (await relembra.find(null, { query, limit: FIND_LIMIT })).length;
  } else if (op === "wake") {
    const wake = await relembra.wake(null, { scope: SCOPE, budgetBytes: WAKE_BUDGET_BYTES });
    carried = wake.memoryIds.length;
  } else {
    const brief = await relembra.brief(null, { topic: query, budgetBytes: BRIEF_BUDGET_BYTES });
    carried = brief.memoryIds.length;
  }
  if (carried === 0) throw new Error(`${op} returned no memory`);
}

function open(path: string) {
  const store = openSqliteStore({ path });
  return { store, relembra: createRelembra<null>({ store, policy: () => reader }) };
}

async function warm(path: string, warmup: number, measured: number, queries: readonly string[]) {
  const { store, relembra } = open(path);
  try {
    const samples: Record<Op, number[]> = { find: [], wake: [], brief: [] };
    for (const op of OPS) {
      for (let i = -warmup; i < measured; i++) {
        const query = queries[(i + warmup) % queries.length] as string;
        const started = performance.now();
        await call(relembra, op, query);
        if (i >= 0) samples[op].push(performance.now() - started);
      }
    }
    return samples;
  } finally {
    await store.close();
  }
}

async function cold(path: string, op: Op, query: string) {
  const started = performance.now();
  const { store, relembra } = open(path);
  try {
    await call(relembra, op, query);
  } finally {
    await store.close();
  }
  return { ms: performance.now() - started };
}

const [mode, path, ...rest] = process.argv.slice(2);
if (path === undefined) throw new Error("usage: eval-worker.ts warm|cold <db> …");
if (mode === "warm") {
  const [warmup, measured, queries] = rest;
  const parsed = JSON.parse(queries ?? "[]") as string[];
  const result = await warm(path, Number(warmup), Number(measured), parsed);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (mode === "cold") {
  const [op, query] = rest;
  if (!OPS.includes(op as Op)) throw new Error(`unknown op ${op}`);
  process.stdout.write(`${JSON.stringify(await cold(path, op as Op, query ?? ""))}\n`);
} else {
  throw new Error(`unknown mode ${mode}`);
}
