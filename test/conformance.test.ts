import { describe, test } from "bun:test";
import { createMemoryStore, storeConformanceCases } from "relembra/testing";
import { timedStore } from "./store-time-support.js";

describe("store conformance: memory store", () => {
  const cases = storeConformanceCases({ open: () => ({ store: createMemoryStore(), close() {} }) });
  for (const conformance of cases) test(conformance.name, () => conformance.run());
});

describe("store conformance: memory store keeping its own time", () => {
  // A clock far from the suite's caller clocks, that moves on every read, as a database's does.
  let now = 1_900_000_000_000;
  const cases = storeConformanceCases({
    open: () => ({ store: timedStore(createMemoryStore(), () => (now += 7)), close() {} }),
  });
  for (const conformance of cases) test(conformance.name, () => conformance.run());
});
