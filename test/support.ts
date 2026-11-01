import { createRelembra, type NoteProvenance, type Policy, type Principal } from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";

/** A synthetic host context: the host has already authenticated `user`. */
export interface HostContext {
  readonly user: "writer" | "reader" | "outsider";
}

export const SCOPE = "dev/example-repo";
export const OTHER_SCOPE = "dev/other-repo";

const principals: Record<HostContext["user"], Principal> = {
  writer: {
    id: "writer",
    readable: [SCOPE],
    writable: [SCOPE],
    promotable: [],
    pinnable: [SCOPE],
  },
  reader: { id: "reader", readable: [SCOPE], writable: [], promotable: [] },
  outsider: { id: "outsider", readable: [OTHER_SCOPE], writable: [OTHER_SCOPE], promotable: [] },
};

export const hostPolicy: Policy<HostContext> = (context) => principals[context.user];

export const provenance: NoteProvenance = {
  agent: "test-agent",
  harness: "test-harness",
  model: "test-model",
  host: "test-host",
};

export function openTestRelembra() {
  return createRelembra({ store: createMemoryStore(), policy: hostPolicy });
}
