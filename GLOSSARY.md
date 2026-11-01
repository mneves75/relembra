# relembra

A memory that AI agents share: curated facts, kept in scopes, that a host can plug into any
agent runtime.

## Language

### What is remembered

**Memory**:
One curated fact, a single line of at most 280 bytes, with its provenance.
_Avoid_: Note (as a noun for stored data), record, entry, item

**Revision**:
One version of a memory's text. A memory's revisions are numbered from 1.
_Avoid_: Version, edit

**Summary**:
A memory written to stand for other memories, bound to the exact revisions it was written from.
_Avoid_: Digest, compaction, nap

**Tombstone**:
What remains of a redacted memory: its identity and the fact of redaction, without its text.

### What happens to memories

**Event**:
One recorded change to the memory store: note, retract, redact, supersede, summarize or promote.
_Avoid_: Log line, operation (when meaning the stored change)

**Retract**:
Hide a memory from agents while its owner can still see it. The summaries derived from it are
retracted with it. One-way in v0.1.
_Avoid_: Delete, forget, hide

**Redact**:
Replace a memory's text with a tombstone everywhere, including every summary derived from it and
every copy promoted from it.
_Avoid_: Delete, purge, erase (when meaning this specific act)

**Supersede**:
Declare that one memory replaces another, which stops being served. Needs what retract needs; the
summaries derived from the replaced memory are retracted. A summary is never superseded: it is
retracted and a new summary submitted.
_Avoid_: Update, overwrite

**Promote**:
Copy a memory, at an exact revision, into another scope, keeping a link to its origin. Redacting
the origin redacts the copy; retracting or superseding it does not.
_Avoid_: Share, publish

**Retention**:
A per-scope rule that redacts memories older than a set age, applied when the host runs a sweep.

### Who may see what

**Scope**:
An opaque key, defined by the host, that names where a memory lives.
_Avoid_: Namespace, project, tenant (as generic terms for this)

**Global scope**:
In the CLI, a scope that every session also reads beside its own, named by
`RELEMBRA_GLOBAL_SCOPE`; writes stay in the session's scope (docs/CLI.md).
_Avoid_: Shared scope, default scope

**Principal**:
The identity a host derives from its own authenticated context. It carries the scopes it may
read, write, pin, promote and own. An owner of a scope may retract, redact and supersede there,
and sees retracted memories.
_Avoid_: User, agent, caller

**Policy**:
The host's rule that turns its authenticated context into a principal.

**Egress filter**:
The host's rule applied to every rendering before it leaves relembra for a principal.
_Avoid_: Mask, sanitizer

**Authority fence**:
A key and an epoch the host grants a writer for one authority. The store remembers the highest
epoch per key; a write carrying a lower epoch commits nothing. The host advances the epoch when
the authority changes hands.
_Avoid_: Lease check, lock

### Reliability

**Op id**:
The key that makes a write idempotent: a retried write with the same op id returns the first
result. An op id belongs to the principal that used it; another principal's write under the same
op id is a separate operation.
_Avoid_: Request id, idempotency token

**Provenance**:
Who and what produced a memory: agent, harness, model, host, source, trust and op id.
_Avoid_: Metadata, attribution

**Trust**:
How far a memory's text may be relied on: `owner` (established by the host, independently of any
model), `agent` (model-authored and unreviewed, the default) or `untrusted` (known to come from
external content). A principal's trust ceiling caps the trust its writes may carry.

**Carrier**:
Anything outside relembra a rendering took a memory's text to, such as a conversation or an MCP
server process, recorded (an exposure) so a redaction can reach it. Per piece of erasure work its
status is pending, acknowledged (the host's word) or unsupported; never erased.

### Reading memories

**Wake**:
The bounded block of memories an agent receives when a session starts.
_Avoid_: Boot context, startup prompt

**Brief**:
A bounded block of memories chosen for one question or topic.
_Avoid_: Context pack, digest

**Find**:
A ranked search over the memories a principal may read.
_Avoid_: Recall (for ranked search), query

**Term index**:
What a store keeps, per scope, so find never retokenizes every memory: N, the sums of the
memories' lengths, and each live memory's term counts, updated in the transaction of every write.
Derived data: it changes no score.
_Avoid_: Search index, FTS

**Zoom**:
Reading one memory by id, with its provenance, status and, for a summary, its sources; an owner
also sees it retracted, superseded or redacted.
_Avoid_: Get, show

### Plugging in

**Store**:
The place memories persist, reached through a store adapter.
_Avoid_: Database, backend (as the generic term)

**Integration**:
The piece that connects relembra to one agent runtime, such as pi-durable or MCP.
_Avoid_: Plugin, connector
