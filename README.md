# relembra

Memory for AI agents that stays scoped, bounded, durable, erasable and measured. A TypeScript
library with zero runtime dependencies, a SQLite store, and a CLI that any coding agent can call
from a session hook.

The host supplies identity (a policy that turns its own authenticated context into a principal)
and storage (an adapter). relembra enforces the rules:

- **Scoped.** Every memory belongs to a scope. A principal reads and writes only the scopes its
  policy grants; `find`, `wake` and `brief` never return memories from any other scope.
- **Bounded.** A memory is one line of at most 280 bytes. `wake` (the block a session starts with)
  and `brief` (a block for one topic) never exceed their byte budgets.
- **Curated.** A guard refuses credentials, multi-line text and invisible, bidirectional or
  control characters before they become memories. Every memory carries provenance and a trust tier (`owner`,
  `agent`, `untrusted`).
- **Durable.** An append-only event log with revisions, idempotent operations and an authority
  fence for multi-writer hosts. SQLite runs in WAL mode with `synchronous=FULL`.
- **Erasable.** `retract` hides a memory; `redact` turns its text into a tombstone everywhere,
  including the summaries derived from it, and then scrubs the SQLite WAL. Retention rules expire
  memories when the host calls `sweep` on its own schedule; the library runs no timer. Renderings
  given a carrier record which carriers received which memories, and `deliverErasures(hook)` hands
  each redaction's carriers to the host until it answers acknowledged or unsupported per carrier;
  relembra never reports an external copy as erased.
- **Measured.** An evaluation harness with leak, scope, retrieval and wake-coverage gates, plus
  controls that must fail. Results: [docs/eval/](docs/eval/).

Version: 1.0.0-beta.3, a beta ([changelog](CHANGELOG.md),
[releases](https://github.com/mneves75/relembra/releases)). Release procedure:
[docs/RELEASE.md](docs/RELEASE.md).
Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Vocabulary: [GLOSSARY.md](GLOSSARY.md).

## Library

Requires Node 24.14 or later, or Bun 1.4 or later. The beta is on npm under the `beta` tag:

```sh
npm install relembra@beta    # or: bun add relembra@beta
```

```ts
import { createRelembra } from "relembra";
import { openSqliteStore } from "relembra/sqlite";

const store = openSqliteStore({ path: "memory.db" });
const memory = createRelembra({ store, policy: (context) => principalFor(context) });

await memory.note(context, { scope: "project-a", text: "Tests need TZ=UTC.", provenance });
const { text } = await memory.wake(context, { scope: "project-a" });
```

The full walk-through (note, find, wake, brief, the guard, redact) runs as
`bun examples/quickstart.ts`.

Entry points:

| Import | What |
|---|---|
| `relembra` | `createRelembra`, the error types and the domain types |
| `relembra/sqlite` | `openSqliteStore`, the SQLite adapter (`node:sqlite`) |
| `relembra/postgres` | `openPostgresStore`, the Postgres adapter over a SQL client the host passes |
| `relembra/pi-durable` | `createMemoryExtension`, memory tools for a pi-durable Harness |
| `relembra/testing` | an in-memory store and the conformance suite a store adapter must pass |

Export, import and OptMem import: [docs/FORMAT.md](docs/FORMAT.md).

### Postgres

To share one memory between machines, pass your own Postgres client; relembra installs no
driver. The client needs two methods: `query(text, params)` resolving rows, and
`transaction(work)` running `work` on one connection between BEGIN and COMMIT.

```ts
import { SQL } from "bun";
import { openPostgresStore } from "relembra/postgres";

const sql = new SQL(process.env.DATABASE_URL);
const store = await openPostgresStore({
  schema: "relembra", // created if missing, migrated on open
  client: {
    query: async (text, params = []) => [...(await sql.unsafe(text, [...params]))],
    transaction: (work) =>
      sql.begin((tx) => work({ query: async (t, p = []) => [...(await tx.unsafe(t, [...p]))] })),
  },
});
```

The same client over [`pg`](https://node-postgres.com) or [postgres.js](https://github.com/porsager/postgres)
(these two wrappers are not run by this repository's tests):

```ts
// pg
const client = {
  query: async (text, params) => (await pool.query(text, params)).rows,
  async transaction(work) {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      const result = await work({ query: async (t, p) => (await connection.query(t, p)).rows });
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  },
};
// postgres.js
const client = {
  query: (text, params) => sql.unsafe(text, params),
  transaction: (work) => sql.begin((tx) => work({ query: (t, p) => tx.unsafe(t, p) })),
};
```

Writes from every machine run one at a time behind a lock row, and are dated by the database
clock. A redaction removes the text from every row relembra keeps; Postgres keeps old row
versions in its files until VACUUM, and the WAL and backups keep theirs, which are the database
operator's to erase. TLS on the connection, encryption of the database and its backups, and
auditing who reads or exports what are the host's and the operator's too: relembra's event log
records changes, not reads.

### Sharing across machines

[`examples/shared-postgres`](examples/shared-postgres) is two minimal hosts sharing one memory.
Each runs as its own process with its own policy, principal and connection pool; only the
database links them. Host A reads, writes and owns `shared` and `private-a`; host B reads and
writes `shared` and owns `private-b`. Each finds what the other notes in `shared`, neither sees
the other's private scope, and once A redacts a shared memory B's view no longer holds its text
(`test/postgres-sharing.test.ts`). From a clone of the repository:

```sh
export DATABASE_URL=postgres://user:password@db.example:5432/app
bun examples/shared-postgres/host-a.ts note shared "Releases need two approvals."
bun examples/shared-postgres/host-b.ts find approvals
```

Trust: each host's policy decides which principal it acts as, and relembra enforces that
principal's scopes on every call made through it. The database credentials are not scoped.
Whoever holds them can read, change or delete every scope's memories directly, and relembra's
scope rules do not apply to them. In the example both hosts hold the same credentials, so
`private-a` is hidden from host B's relembra calls, not from whoever runs host B. To keep a scope
from a machine, do not give that machine the credentials.

The CLI stays SQLite-only: no flag, environment variable or configuration points it at Postgres.
A Postgres configuration for the CLI would be a change of its own.

### pi-durable

`relembra/pi-durable` gives a [pi-durable](https://github.com/earendil-works/pi) Harness the tools
`memory_note`, `memory_find` and `memory_brief`, and a system prompt section carrying the wake,
under the key `relembra_memory` (`MEMORY_SECTION_KEY`; section keys are shared by every extension). pi-durable is an optional peer dependency, pinned to exactly `1.4.0`, the version the tests
run against.

```ts
import { createMemoryExtension } from "relembra/pi-durable";

registry.install(
  createMemoryExtension({
    relembra: memory,
    hostNamespace: "host-1/agent.sqlite", // one per pi-durable storage
    resolve: (conversationId) => ({ context, scope: "project-a", provenance }),
  }),
);
```

- **Crash-safe writes.** The tools are `replay: "safe"`. `memory_note`'s op id hashes the host
  namespace with the call's conversation, task and call ids, so a call that pi-durable reruns
  after a crash returns the memory, id and timestamp its first run committed.
- **One owner per storage.** pi-durable has no cross-process locking: one process owns a storage
  at a time. pi-durable numbers conversations and tasks per storage, so each storage needs its own
  `hostNamespace`; an independently writable copy gets a new one.
- **Takeover needs a fencing epoch.** To move the authority to another process, give the host's
  principal an authority fence and call `advanceFence(store, { key, epoch })` on takeover. A
  paused writer that resumes with the old epoch commits nothing.
- **Egress.** `memory_find`, `memory_brief` and the wake go through the host's egress filter and
  byte budget. A refusal (guard, fence, egress) is an error result for the model. Each model request,
  a resumed one included, carries the wake rendered for it, once; a wake the host refuses shows
  `<wake unavailable="true"/>`, so a revoked wake is not resent from the history. Compaction
  requests leave out the conversation's system messages, the wake included; they carry only
  pi-durable's own summarization prompt and the serialized transcript.
- **Bounded errors.** Invalid tool arguments get a fixed error that quotes none of the input.
- **Erasure.** Every rendering a conversation receives is recorded for the carrier
  `<hostNamespace>/<conversationId>` (kind `pi-durable`) first, so `hostNamespace` must pass the
  identifier rule within 512 bytes. After a redaction, `memory.deliverErasures(hook)` hands the
  host each conversation that held the text.
- **No way back past pi-durable 1.4.0.** Opening a pi-durable SQLite storage with 1.4.0 migrates
  it to schema version 2, which 1.3.0 and earlier cannot open (pi-durable's CHANGELOG, 1.4.0).

## CLI

A single binary over the SQLite store, built with Bun. The scope comes from the git repository
(or `RELEMBRA_SCOPE`, set by the host) and the principal is the OS user; no argument changes
either. Writes carry `agent` trust at most, and owner trust needs a person typing a code at the
terminal. It is a single-user model: anything running as the same OS user has the same reach.

`RELEMBRA_GLOBAL_SCOPE` names one more scope every session reads, for rules and lessons that
should reach every project: `wake`, the session hook, `find`, `brief`, `recall` and `zoom` (and
the MCP server's reads) cover it beside the project's scope, while writes stay in the project's
scope. Outside a repository it is the scope itself. The wake gives each of the two scopes half
its budget and passes the room one leaves unused to the other, so neither can crowd the other
out. Set `RELEMBRA_SCOPE` to the global scope to change what it holds.

Each [GitHub release](https://github.com/mneves75/relembra/releases) carries a native binary
per platform, `SHA256SUMS` and the library archive npm serves:

| Platform | Binary |
|---|---|
| macOS arm64 | `relembra-darwin-arm64` |
| Linux x64 (glibc) | `relembra-linux-x64` |
| Linux arm64 (glibc) | `relembra-linux-arm64` |
| Windows x64 | `relembra-windows-x64.exe` |
| Windows arm64 | `relembra-windows-arm64.exe` |

On macOS and Linux, download the binary and checksum file, then install them with `install.sh`
from a checkout of the same tag:

```sh
sh install.sh relembra-linux-x64 SHA256SUMS  # verifies the checksum, installs to ~/.local/bin
```

On Windows, check the hash with `Get-FileHash` and copy the binary onto `PATH` as
`relembra.exe`; the session hook needs Git Bash ([docs/CLI.md](docs/CLI.md#windows)).

Before replacing an installed executable, retain a backup and its hash. Verify installed bytes
against the release checksum and export metadata from a disposable store
(`relembra: "1.0.0-beta.3"`); there is no `--version` flag. The [release procedure](docs/RELEASE.md) covers isolated checks and
rollback without opening a live memory store. After verification, `relembra init` prints the
session hook for your agent.

To build it yourself, run `bun run build:cli` from a clone with the pinned Bun
(`build/bun-toolchain.txt`); it writes `bin/relembra` (`relembra.exe` on Windows) and
`bin/relembra.sha256`.

Commands, flags, exit codes and the JSON envelope: [docs/CLI.md](docs/CLI.md).

## MCP

`relembra mcp` is an MCP server over stdio for clients that speak protocol revision 2026-07-28
(older revisions are refused with the supported list). It is a subcommand of the same binary,
so it takes its scope, principal and store from the launch environment exactly as the CLI does,
and no tool argument changes them. It writes at `agent`
trust at most and never asks for owner trust. Its tools are `note`, `find`, `brief`, `wake` and
`retract`; every tool that returns memory text returns an escaped, egress-filtered rendering
within a byte budget, recorded for this server process as a carrier (`mcp:<random UUID>`), which a
redaction then lists as pending: the server cannot make a client forget, and never says it did.
Register it with your client as the command `relembra mcp`, started in the
project's directory or with `RELEMBRA_SCOPE` set. The contract (methods, tools, op ids, errors,
framing, pending requests) is in [docs/CLI.md](docs/CLI.md#relembra-mcp).

The server holds at most 64 requests queued or running. One more gets the error `-31000`,
`data: { maxPending: 64 }`, at once and is never queued. The revision defines no overload code and
reserves `-32020` to `-32099` for its own, so `-31000` sits outside `-32768` to `-32000`, as its
Error Codes section asks. A client that stops reading its responses stops being read.

Qualified with the official MCP TypeScript SDK client, `@modelcontextprotocol/client` **2.4.0**
(with `@modelcontextprotocol/core` 2.4.0), pinned to protocol revision 2026-07-28
(`versionNegotiation: { mode: { pin: "2026-07-28" } }`): `test/cli/mcp-sdk.test.ts` runs a stdio
round trip through it against the built binary. It is a development dependency only; the library
and the binary have no runtime dependencies. A client that speaks only the earlier,
`initialize`-based revisions cannot use this server: `initialize` is refused with `-32022`, which
names the supported version.

Implemented from these pages of the specification (read 2026-10-31):

- [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog): no
  `initialize` handshake, per-request `_meta`, required `server/discover`, `resultType`, `ttlMs`
  and `cacheScope`, the `-32020` to `-32099` allocation.
- [Base Protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic/index): Messages
  (ids, Result Responses, ResultType, Error Responses, Error Codes), Statelessness, and `_meta`
  ("Per-request protocol fields", "Per-response protocol fields").
- [Versioning and Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning):
  Protocol Version Negotiation, and "Backward Compatibility with Initialization-Based Versions"
  for the answer to `initialize`. The revision has no lifecycle page:
  `/specification/2026-07-28/basic/lifecycle` redirects here.
- [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio): the
  framing, stdout and stderr rules, Cancellation and Shutdown.
- [Cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation).
- [Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover):
  `DiscoverResult`.
- [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools): Listing Tools,
  Calling Tools, Tool, Tool Result, Structured Content, Output Schema, Error Handling.
- [Caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching):
  Cacheable Results, `ttlMs`, Cache Scope.
- [schema.ts](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts):
  `RequestMetaObject`, `Result`, `DiscoverResult`, `CacheableResult`, `ListToolsResult`,
  `CallToolResult`, `Tool`, `ToolAnnotations`, `UnsupportedProtocolVersionError`, and the error
  code constants.

Where these pages go beyond the ticket, the server follows them: cache fields go on
`server/discover` and `tools/list` only (the Caching page lists no other operation this server
offers), `serverInfo` is in every result's `_meta` (a SHOULD), and `initialize` is answered with
`-32022` naming the supported version (a SHOULD for a server that speaks no legacy revision).

The 2026-07-28 revision has no per-call identifier a server could derive an op id from, and the
JSON-RPC id changes on every retry. So instead of the plan's `[host, conversation, task, call]`
tuple from a durable journal (IMPLEMENTATION-PLAN §4.3), a `note` takes an optional
`idempotencyKey` from the client and derives its op id with the same function, from
`["relembra-mcp", scope, "note", key]`. Without a key, a retry after a lost response writes twice.

## Development

```sh
bun install
bun run build:cli        # build the CLI first: the CLI tests run the binary
scripts/with-postgres.sh bun run test:all   # Bun suite, beside a throwaway Postgres 17 (needs Docker)
bun run test:node        # the Node suite (SQLite adapter and library on Node)
bun run typecheck && bun run lint
bun run eval             # the evaluation harness
scripts/ci.sh            # all of the above, the merge gate, on the committed candidate
scripts/check-release.sh # the gate, then the strict latency benchmark on the same candidate
```

The landing page is `site/`: static files, no build step besides `bun run build:site`, which bundles
the library into `site/assets/relembra.js` so the page's demos run the real code in the browser
(`test/site.test.ts` fails while that file is stale). Preview it with
`python3 -m http.server --directory site`, or open `site/index.html` directly.
The `pages` workflow (`gh workflow run pages.yml --ref main`) publishes it to GitHub Pages with
OIDC, no stored token: `scripts/site/assemble.sh <new directory>` builds what ships from the
commit's `site/` plus the explainer video, which is git-ignored on `main` and kept on the
`gh-pages` branch, checked against `scripts/site/video.sha256`.

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## Licence

MIT. See [LICENSE](LICENSE).
