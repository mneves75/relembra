# 15: MCP server (stdio, 2026-07-28)

**What to build:** An MCP client of protocol revision 2026-07-28 can use relembra over stdio, statelessly.

**Blocked by:** 11

**Status:** merged into `feat/v0.3` (0.3.0)

- [x] `server/discover`, `tools/list` and `tools/call` with required metadata, `resultType` and cache fields, and the prescribed protocol errors
  - `test/cli/mcp.test.ts`, "server/discover, tools/list": the `DiscoverResult` fields,
    `serverInfo` in every result's `_meta`, `resultType: "complete"`, `ttlMs` and
    `cacheScope: "public"` on discover and list (and a check that neither names the scope or
    user), a fixed tool order, strict input schemas, an unknown cursor refused.
  - "the prescribed protocol errors": each missing or mistyped required `_meta` field `-32602`,
    another version `-32022` with `supported` and `requested`, a legacy `initialize` `-32022`
    naming `2026-07-28`, unknown methods (`ping` included) `-32601`, an unknown tool and every
    schema violation `-32602` without echoing the name or value, notifications unanswered.
- [x] Malformed and oversized messages, interleaved request ids, EOF and stdout framing are tested
  - `test/mcp-lines.test.ts`: byte framing, a chunk split inside a character, the cap exactly and
    one byte over, an oversized line discarded across chunks, an unterminated final line dropped.
  - `test/cli/mcp.test.ts`, "framing faults": `-32700` without an id for bad JSON and bad UTF-8,
    `-32600` for a batch, a null, fractional or boolean id, a wrong `jsonrpc` or `method`; a line
    of 1 MiB + n bytes refused with `maxBytes` and the next one read, a line of exactly 1 MiB
    answered; seven interleaved ids of both types each answered with its own; EOF mid-message
    executes nothing, logs on stderr and exits 0, with the same bytes plus a newline as control;
    blank lines and CRLF; a cancelled queued request unanswered, with a control; a cancel for an
    unknown id harmless. Every run checks that stdout holds JSON-RPC responses and nothing else.
    84 requests in one write each get exactly one response, an answer or `-31000`.
  - `test/mcp.test.ts`, "the request queue is bounded": with the first request held, 64 + 5 at
    once give exactly 5 `-31000` errors before anything runs and answer the first 64; control: 64
    at once are all answered; the cap counts pending requests, not a lifetime; a client that stops
    reading leaves 64 unread errors and is not read past them.
- [x] A stdio round trip passes through an independent conforming client; the README names the qualified client versions
  - `test/cli/mcp-sdk.test.ts`: `@modelcontextprotocol/client` 2.4.0 pinned to 2026-07-28, against
    the built binary. Negative control: the same client rejects a fake server that leaves
    `resultType` out; positive control: it accepts the fake server with it. README, "MCP".
- [x] JSON-RPC ids are correlation ids only; writes carry a separate op id
  - `test/cli/mcp.test.ts`, "op ids": one `idempotencyKey` under two JSON-RPC ids is one memory
    whose op id is `integrationOpId("relembra-mcp", scope, "note", key)`; the same key with other
    text is `op-conflict`; one JSON-RPC id reused without a key writes twice, op ids distinct and
    not the JSON-RPC id; keys namespaced by scope and apart from CLI `--op-id`; key length 256 /
    257.
- [x] The principal comes from the launch environment; a test shows no tool argument changes the scope
  - `test/cli/mcp.test.ts`, "the principal and scope come only from the launch environment":
    `scope`, `principal`, `trustCeiling`, `home`, `owned` and `opId` arguments refused with
    nothing written, beside a control; `trust: "owner"` refused, `untrusted` lowering; `_meta` and
    `clientInfo` change neither scope nor provenance; servers launched with two `RELEMBRA_SCOPE`
    values cannot see each other's memories; the source never asks for owner confirmation.
    "the tools": retracting an owner memory is refused at the agent ceiling, an agent one is not.
  - `test/mcp.test.ts`: find, brief and wake leave through the host's egress filter, measured
    after it, and a denying filter is a refusal.
