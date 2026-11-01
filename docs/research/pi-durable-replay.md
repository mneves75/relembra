# pi-durable replay findings (measured on 1.0.4, 2026-10-30)

Source: a test-only harness built and run against a real Postgres journal with pi-durable 1.0.4,
a stub model and one memory tool. Branch kept for reference, never merged. Tests (1) to (3) ran
red, then green. Test (4), the stale writer, was not built before the work was stopped.

1. **Ids are stable across recovery.** The replayed `execute()` received exactly the same `taskId`
   and `callId` as the crashed one.
2. **The replay key** is `op_id = <host conversation UUID>:<taskId>:<callId>`. Use the host's
   conversation id, not `api.conversationId`: durable ids restart for every conversation, so they
   collide across conversations.
3. **Replay semantics:** the tool's intent is committed before `execute()` runs. On recovery, a
   tool declared `replay: "safe"` runs again; an `"unsafe"` one returns an `interrupted` error to
   the model. Right after the crash the journal held 0 tool results, and 1 after recovery.
4. **Exactly once:** `UNIQUE(op_id)` plus `INSERT … ON CONFLICT DO NOTHING`, returning the stored
   result, leaves one memory row, and the model sees one tool result. Without the constraint the
   same run leaves two rows: the negative control is red at `2 !== 1`.
5. **Fault handling:** a submission whose writer died never settles, so the test ends that process
   on the fault rather than waiting for it.
6. **Takeover** must expire both the conversation lease and the journal owner lease before a second
   harness can recover the turn.

**Not yet known:**
- whether 1.4.0 (current; released 2026-10-21) changed the extension or tool-replay API. Read it
  before designing the integration;
- the stale-writer behaviour (test 4).
