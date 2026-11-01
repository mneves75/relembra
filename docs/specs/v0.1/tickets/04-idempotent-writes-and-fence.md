# 04: Idempotent writes with op ids and the authority fence

**What to build:** A retried write with the same op id returns the first result and stores nothing new; the same op id with a different payload is refused; a host fence that fails inside the write leaves nothing committed.

**Blocked by:** 02

**Status:** done, pending review

- [x] Same op id + same payload returns the stored result, one row (conformance test on both stores)
- [x] Negative control: with op-id enforcement disabled in a test double, the retry produces two rows
- [x] Same op id + different payload is refused with a named error
- [x] A failing authority fence commits nothing; a passing one commits (both in the conformance suite)
- [x] Op records persist the first commit's generated memory id, timestamp and result; a retry from a later process with a different clock returns them (IMPLEMENTATION-PLAN §4.3)
- [x] Fingerprint: SHA-256 over a canonical encoding of kind, scope, principal id and every semantic input, generated fields excluded
- [x] Integration op id helper: `v1:` + SHA-256 of the canonical JSON tuple; the delimiter-collision pair from §4.3 yields different ids
- [x] The fence is a host key and epoch enforced in the store transaction: a write with a lower epoch commits nothing; the current epoch commits; advancing is a store operation
- [x] A retry by a principal that lost write access is refused even though the op record exists
- [x] `Provenance.trust` (`owner` | `agent` | `untrusted`) is stored; the policy's ceiling caps it

## Comments

Built 2026-10-30 on `feat/v0.1` (commits `a9c5016` to `7613fb6`, plus review fixes listed at
the end). Every test below was seen failing before its code existed, unless noted.

Decisions:

- **Fence shape:** `Principal.fence = { key, epoch }`, derived by the host's policy from its
  authenticated context. Rejected: a `fence` field on `NoteInput`, which would put authority in
  the writer's payload beside the fingerprinted fields. A write whose epoch is higher than the
  stored one commits and becomes the highest (fencing-token semantics); an equal epoch commits;
  a lower one raises `FencedError`. `advanceFence(store, fence)` applies the same rule in its own
  transaction; repeating the same epoch is accepted so a host can retry a takeover.
- **Rules in the core, data in the store:** `StoreTransaction` gains `op`, `putOp`, `fenceEpoch`
  and `putFence`; the core compares fingerprints and epochs, so adapters cannot get the rules
  wrong.
- **Op ids belong to their principal** (security review): records are keyed by
  `(principalId, opId)`, so an op id can neither block nor probe another principal's writes.
- **Order in the note transaction:** fence, op lookup, then conflict, replay or write. Policy,
  Clock and Ids run before the transaction. The scope check runs on the policy's answer before
  the transaction: it reads no store state, so checking the same value inside would change
  nothing, and the policy itself must not run inside.
- **Retry outcome:** rebuilt from the op record (memory id, timestamp, seq) plus the input,
  which the fingerprint proves identical.
- **Fingerprint encoding:** `JSON.stringify([1, "note", scope, principalId, text, pinned,
  trust, agent, harness, model, host, source ?? null])`, SHA-256 hex. Positional, so key order
  is irrelevant and no whitespace is emitted; the leading 1 versions it because it is persisted.
- **Trust default:** `agent`, or the principal's ceiling when that is lower; an explicit value
  above the ceiling is refused (`ProvenanceError`, field `trust`, rule `above-ceiling`).
- **SQLite:** migration 1 edited (no store released) with `ops` and `fences` tables; trust lives
  in the provenance JSON, with no column of its own.

Evidence per checkbox:

- Same op id + same payload, one row: conformance "a retried note returns the first outcome and
  stores one memory, even from a new relembra with another clock and ids" (both stores; SQLite
  also through a reopened handle). Red: 4 fail (both new core cases on both stores).
- Negative control: `test/conformance-controls.test.ts` "a store without op-id enforcement
  stores a retried note twice" (count 2; the memory store keeps 1). Flaw `no-op-enforcement`
  fails the retry and conflict cases.
- Different payload refused: conformance "the same op id with a different payload is refused and
  stores nothing new" (`OpConflictError`); `test/idempotency.test.ts` covers each semantic field,
  each with a control, and that the message echoes neither payload nor op id.
- Fence commits nothing when stale, commits when current: conformance "a paused writer whose
  fence epoch was advanced commits nothing, and the current writer commits" (takeover through a
  reopened handle on SQLite; the stale writer's retry of its own committed op is refused too)
  and "advancing a fence never lowers it, and a write's epoch advances it". Red: import of
  `advanceFence` failed on both.
- Persisted outcome: the retry case asserts deep equality with the first result under a
  different Clock (9000 vs 1000) and Ids. Store level: "an op record commits with its
  transaction and is read back intact", "an op record written by a transaction that rejects is
  not kept", "an op id has at most one record per principal" (red: 6 fail).
- Fingerprint: `test/idempotency.test.ts` "the stored fingerprint is the SHA-256 of the
  documented canonical encoding" (golden value from `shasum -a 256`), reordered keys and elided
  defaults replay, whitespace in text conflicts, the op id is not fingerprinted.
- Integration op id: `test/op-id.test.ts` (golden id from `shasum`; `["host","1","2","3:4"]` vs
  `["host:1","2","3","4"]` differ, with a control showing their colon joins are equal; long
  components). Red: import failed.
- Fence in the store transaction: conformance "a fence epoch commits with its transaction and a
  rolled-back one is not kept"; `test/fence.test.ts` refuses malformed keys and epochs on write
  and advance. `test/sqlite.test.ts` "the policy, clock and ids never run while the store holds
  its write lock" (control: the probe sees an open transaction; mutation: moving `clock.now()`
  inside makes it fail).
- Revoked access: `test/idempotency.test.ts` "a retry by a principal that lost write access is
  refused although the op record exists" (same principal id; control: restored access replays).
- Trust: `test/trust.test.ts` (red: 0 pass, 6 fail); the conformance round trip covers all three
  tiers on both stores (flaw `drops-trust`).

Commands, final run on the tree at the end of this ticket:

- `bun test`: 277 pass, 0 fail, across 13 files.
- `bun run test:node`: tests 59, pass 59, fail 0.
- `bun run typecheck`: `tsc --noEmit`, no output.
- `bun run lint`: "Checked 36 files … No fixes applied."

Review fixes for tickets 02 and 03, done in this ticket's run: commits `fd4d36d`, `acf5036`,
`9cb58b8`, `c0b695e` and `6a1a8e9` (synchronous=FULL, defensive mode, sidecar modes, untouched
future schema, busy errors on open, timeout validation, event `format: 1` and `docs/FORMAT.md`,
`inspectEvents` and seq across reopen, crash and first-open process tests, code-point lengths in
ranking, tokenless `find` without a store read).
