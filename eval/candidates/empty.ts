/**
 * The empty synthetic candidate: it stores nothing and returns nothing. It must fail the gate,
 * which proves the gate requires positive retrieval and wake coverage.
 * Usage: bun eval/candidates/empty.ts
 */
import { type CandidateHandler, serve } from "./serve.js";

export function createEmpty(): CandidateHandler {
  let counter = 0;
  return {
    reset: () => ({ protocol: 1, name: "empty", version: "1" }),
    note: ({ memories }) => ({
      ids: memories.map(() => `empty-${String(++counter).padStart(6, "0")}`),
    }),
    find: () => ({ results: [] }),
    brief: () => ({ text: "" }),
    wake: () => ({ text: "", pinned: [] }),
  };
}

if (import.meta.main) await serve(createEmpty());
