import { test } from "bun:test";
import { storeConformanceCases } from "relembra/testing";
import { describePostgres, postgresTarget } from "./postgres-support.js";

describePostgres("store conformance: postgres store", () => {
  for (const conformance of storeConformanceCases(postgresTarget())) {
    test(conformance.name, () => conformance.run(), 30_000);
  }
});
