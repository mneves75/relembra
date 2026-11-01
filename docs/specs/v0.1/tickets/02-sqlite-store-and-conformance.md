# 02: SQLite store, proven by the shared conformance suite

**What to build:** The same behaviour works on a SQLite file: an exported conformance suite (`relembra/testing`) runs against the in-memory store and the SQLite store, covering write/read, scope filtering in the query, transactions, concurrent writers, and migrations.

**Blocked by:** 01

**Status:** ready-for-agent

- [x] `relembra/testing` exports the suite and the in-memory store
- [x] SQLite store on node:sqlite: WAL, a transaction per write, forward-only migrations with schema_version, file 0600 and directory 0700
- [x] The suite passes on both stores under Bun; the SQLite store also passes under Node (`node --test` smoke)
- [x] Two concurrent writers on one file lose no write

## Comments

Evidence, 2026-10-30 (branch `feat/v0.1-t02`, Bun 1.4.4, Node v26.12.1):

- `relembra/testing`: `src/testing/index.ts` exports `storeConformanceCases` (framework-neutral
  cases on `node:assert`) and `createMemoryStore`. `test/conformance-controls.test.ts` runs each
  of the 15 cases against a store with one deliberate flaw and requires it to fail; a meta-test
  checks every case has such a flaw.
- Detached state (added from the ticket 01 review): the case "committed state is detached from the
  caller's objects" failed first on the memory store (13 pass, 1 fail, actual "after"), then
  passed after the store kept deep-frozen `structuredClone` snapshots.
- SQLite store: `src/sqlite/index.ts`, `src/sqlite/migrations.ts`. `test/sqlite.test.ts` pins
  0700 directories, 0600 db/-wal/-shm files, an existing directory left alone, WAL mode,
  schema_version 1 recorded once, a newer schema refused (with control), and atomic migrations
  (with control). Each fails under a mutation of the code it guards.
- Suite on both stores under Bun: `bun test` 101 pass, 0 fail (three consecutive runs).
- Under Node: `bun run test:node` (`node --import ./test/sqlite-node-resolve.ts --test
  test/sqlite-node-smoke.ts`): tests 30, pass 30, fail 0 (suite on both stores plus a SQLite
  round trip with mode checks). Without the resolver Node fails with ERR_MODULE_NOT_FOUND.
- Two writer processes: `test/sqlite-concurrency.test.ts` spawns two real processes, 200 writes
  each: count 400, 400 distinct ids, 354 writer switches in commit order. Negative control (a
  snapshot-then-overwrite writer): the same count check sees 200.
- `bun run typecheck` and `bun run lint` pass.

Integration, 2026-10-30 (branch `feat/v0.1-int`, after merging ticket 03):

- `Memory.seq` is persisted (migration 1 edited, since no store has been released) and
  `Store.liveMemories` is served with the scope filter in SQL. Four conformance cases cover it
  (scope filtering with positive controls, no limit, each memory once in its current revision, no
  uncommitted reads), each with a flawed-store control.
- `test/sqlite.test.ts` runs note, find and recall through `createRelembra` on a SQLite file.
- An existing store file looser than 0600 is refused with `StoreFileModeError`; a 0600 file opens.
- `bun test` 174 pass, 0 fail; `bun run test:node` tests 38, pass 38, fail 0; typecheck and lint
  pass.
