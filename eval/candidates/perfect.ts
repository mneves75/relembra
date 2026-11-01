/**
 * The perfect synthetic candidate: an oracle over the set's gold labels, the upper bound.
 * Usage: bun eval/candidates/perfect.ts <set-dir>
 */
import type { EvalSet } from "../set.js";
import { readSet } from "../set.js";
import { createOracle } from "./oracle.js";
import { type CandidateHandler, serve } from "./serve.js";

export function createPerfect(set: EvalSet): CandidateHandler {
  return createOracle(set, { name: "perfect" });
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined) throw new Error("usage: perfect.ts <set-dir>");
  await serve(createPerfect(readSet(dir)));
}
