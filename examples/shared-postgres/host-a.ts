// Host A, one of two machines sharing a memory through Postgres (see host.ts for the commands).
// Its policy: read and write the shared scope and its own private-a, and own both, so it may
// redact there.
import type { Principal } from "relembra";
import { runHost, SHARED } from "./host.js";

const principal: Principal = {
  id: "host-a",
  readable: [SHARED, "private-a"],
  writable: [SHARED, "private-a"],
  promotable: [],
  owned: [SHARED, "private-a"],
};

await runHost({ host: "host-a" }, () => principal);
