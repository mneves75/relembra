// Host B, the other machine (see host.ts for the commands). Its policy: read and write the
// shared scope, and read, write and own its private-b. It does not own the shared scope, so it
// cannot redact there; host A can.
import type { Principal } from "relembra";
import { runHost, SHARED } from "./host.js";

const principal: Principal = {
  id: "host-b",
  readable: [SHARED, "private-b"],
  writable: [SHARED, "private-b"],
  promotable: [],
  owned: ["private-b"],
};

await runHost({ host: "host-b" }, () => principal);
