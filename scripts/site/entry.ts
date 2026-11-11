/**
 * What the landing page's browser bundle exposes, as `globalThis.relembraDemo`: the library itself
 * and its in-memory store, so every demo on the page runs the real code in src/.
 */
import { findGuardViolation, MAX_MEMORY_BYTES } from "../../src/guard.js";
import { createRelembra, integrationOpId } from "../../src/index.js";
import { createMemoryStore } from "../../src/testing/memory-store.js";
import { RELEMBRA_VERSION } from "../../src/version.js";

export const demo = {
  createRelembra,
  createMemoryStore,
  findGuardViolation,
  integrationOpId,
  MAX_MEMORY_BYTES,
  RELEMBRA_VERSION,
};

(globalThis as { relembraDemo?: typeof demo }).relembraDemo = demo;
