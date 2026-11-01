# 16: Erasure delivery to hosts

**What to build:** After a redaction commits, hosts receive the carriers that took its text out, until they acknowledge.

**Blocked by:** 06, 13, 15, 17

**Status:** merged into `feat/v0.3` (0.3.0)

- [x] Every rendering records the memory ids it carried, per integration. Conformance (every
  store): "recordExposure keeps one row per carrier and memory id…", "concurrent recordExposure
  calls, from two handles, lose no row", "recordExposure reports the ids already redacted, and one
  racing a redaction is told of it". Core: `test/erasure-delivery.test.ts` "a rendering records the
  memory ids it carried" (wake, brief, findRendering; egress deny; empty; failed recording; the
  redaction race) and "a redaction lists the carriers of every memory it erases". pi-durable:
  `test/pi-durable-exposure.test.ts`.
- [x] Outbox work is delivered after commit to idempotent host hooks, retried until acknowledged.
  `test/erasure-delivery.test.ts` "erasure delivery" (void return, missing or wrong answers, a
  throw), and `test/erasure-delivery-stores.test.ts` on the memory, SQLite and Postgres stores.
- [x] Each carrier's status is pending, acknowledged or unsupported; nothing claims an external copy
  is gone. Conformance "a carrier's outcome commits with its transaction, the first one stays…";
  `test/erasure-delivery.test.ts` "no status ever says a copy was erased".
- [x] MCP delivery records exposure and makes no claim that the client deleted anything.
  `test/mcp.test.ts` "find, brief and wake record what the client received under the server's
  carrier"; `test/cli/mcp.test.ts` "erasure: what the client received is recorded under the server
  process's carrier" (with `relembra check`'s `erasurePending`).
