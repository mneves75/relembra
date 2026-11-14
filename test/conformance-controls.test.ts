import { describe, expect, test } from "bun:test";
import {
  type Carrier,
  type CarrierSettlement,
  createRelembra,
  type DocumentTerms,
  documentTerms,
  type ErasureWork,
  type Event,
  type ImportCheckpoint,
  type Memory,
  type MemoryId,
  type OpRecord,
  redactedEvent,
  type Store,
  type StoredMemory,
  type StoreTransaction,
  type TermPosting,
} from "relembra";
import { createMemoryStore, type OpenedStore, storeConformanceCases } from "relembra/testing";

/**
 * Each flaw is a way a store adapter can be wrong. A store with that flaw must fail the named
 * conformance case; the suite passing on the memory and SQLite stores is the positive control.
 */
type Flaw =
  | "drops-source"
  | "drops-trust"
  | "drops-pinned"
  | "returns-nothing"
  | "constant-seq"
  | "ignores-scopes"
  | "limits-before-filtering"
  | "oldest-first"
  | "replace-moves-to-front"
  | "commits-on-reject"
  | "keeps-caller-objects"
  | "dirty-reads"
  | "no-serialization"
  | "leaked-handle-writes"
  | "forgets-on-reopen"
  | "limits-live-memories"
  | "keeps-old-revisions"
  | "forgets-ops"
  | "ops-outside-transaction"
  | "duplicate-ops"
  | "no-op-enforcement"
  | "global-op-ids"
  | "forgets-fence"
  | "fence-outside-transaction"
  | "append-stores-nothing"
  | "seq-resets-on-reopen"
  | "drops-status"
  | "drops-superseded-by"
  | "drops-sources"
  | "drops-origin"
  | "derived-misses-copies"
  | "serves-retracted"
  | "serves-superseded"
  | "retracted-everywhere"
  | "hides-retracted"
  | "tx-memory-reads-committed"
  | "redact-noop"
  | "redact-keeps-event-text"
  | "redact-keeps-fingerprint"
  | "redact-outside-transaction"
  | "no-derived"
  | "forgets-erasures"
  | "erasures-outside-transaction"
  | "erasures-insertion-order"
  | "keeps-freed-bytes"
  | "expiring-inclusive"
  | "expiring-ignores-scope"
  | "expiring-live-only"
  | "forgets-checkpoints"
  | "checkpoints-outside-transaction"
  | "index-ignores-scopes"
  | "index-serves-non-live"
  | "index-misses-updates"
  | "index-keeps-redacted"
  | "index-outside-transaction"
  | "index-keeps-freed-terms"
  | "index-load-order"
  | "latin1-names"
  | "forgets-exposures"
  | "exposure-overwrites-kind"
  | "exposure-lost-update"
  | "exposure-ignores-redaction"
  | "exposure-races-redaction"
  | "forgets-settlements"
  | "settlement-overwrites"
  | "settlements-outside-transaction"
  | "drops-carriers"
  | "pending-includes-settled"
  | "pending-ignores-page"
  | "pending-count-stale";

const WAKE_CASE =
  "wake and brief render the store's memories with their pinned flag and trust, the same from every handle";

const ROUND_TRIP_CASE = "a memory's status, replacement and summary sources survive the round trip";
const TX_MEMORY_CASE =
  "tx.memory reads a memory written earlier in its transaction, and nothing it rolled back";
const RETRACT_CASE =
  "a retracted memory vanishes from find, recall, wake and brief, and its owner's recall shows it marked";
const LEAK_CASE =
  "a redacted memory's text is gone from every view, derived summary, event, op record and stored byte, while a planted copy is found";
const TERMINAL_CASE =
  "a retried note whose memory was redacted gets a terminal redacted outcome, whatever its payload";
const ROLLBACK_CASE =
  "a redaction that rolls back leaves the memory, its events and op record whole, and no outbox row";
const RETRACT_CASCADE_CASE = "retracting a memory retracts the summaries derived from it";
const SUPERSEDE_CASE =
  "a superseded memory stops being served and its replacement is, along a chain, and a retried supersede returns the first replacement";
const SUPERSEDE_REFUSED_CASE =
  "superseding a retracted or redacted memory is refused and writes nothing";
const PENDING_CASE =
  "pending lists live, unpinned, unsummarized memories oldest first, and a submitted summary covers its sources";
const SOURCE_CHANGED_CASE =
  "submitSummary is refused when a source revision changed since it was read, and writes nothing";
const SUMMARY_TRUST_CASE = "a summary's trust is the least of its sources' trust";
const SUMMARY_SLOT_CASE =
  "summaries fill the wake's slot after recent memories and the brief's after its results";
const SUPERSEDE_GUARDED_CASE =
  "superseding a pinned memory needs pin rights, and one above the principal's trust ceiling is refused, writing nothing";
const SUPERSEDE_CASCADE_CASE = "superseding a memory retracts the summaries derived from it";
const SWEEP_CASE =
  "sweep redacts exactly the memories older than their scope's maxAgeDays, with the summaries derived from them, and reports them";
const SUPERSEDE_SUMMARY_CASE =
  "superseding a summary is refused and writes nothing, so redacting its source still reaches every copy of its fact";
const LIVE_ONLY_CASE = "liveMemories and recall serve only live memories";
const EVENTS_CASE =
  "events returns the committed events of the requested scopes in seq order, redacted forms included";
const CHECKPOINT_CASE =
  "an import checkpoint commits with its transaction, a later one replaces it, and a rolled-back one is not kept";
const INDEX_READ_CASE =
  "findByTerms reads N, lengths and term counts over the live memories of the scopes asked, and loads what was chosen, in order";
const INDEX_FOLLOWS_CASE =
  "find ranks exactly as the full scan after every note, retraction, supersession, summary, redaction and sweep, and a rolled-back write changes nothing";
const OUT_OF_SCOPE_CASE =
  "memories outside the scopes read never change find's scores, and memories inside do";
const INDEX_ERASURE_CASE =
  "a redacted memory's terms leave the term index and every stored byte, while a planted copy's stay";
const IDENTIFIER_CASE =
  "identifiers with NUL, controls, bidi or zero-width characters are refused before the store, on every store";
const PROMOTE_LINK_CASE =
  "a promoted copy keeps its origin, and derived lists it beside the summaries until it is redacted";
const PROMOTE_REDACT_CASE =
  "promote writes a copy that find reads in its scope, and redacting the origin erases the copy's text everywhere";
const PROMOTE_RETRACT_CASE = "retracting the origin leaves its promoted copy live";
const EXPOSURE_CASE =
  "recordExposure keeps one row per carrier and memory id, as first recorded, ids only, and a transaction reads it";
const CONCURRENT_EXPOSURE_CASE = "concurrent recordExposure calls, from two handles, lose no row";
const EXPOSURE_RACE_CASE =
  "recordExposure reports the ids already redacted, and one racing a redaction is told of it";
const OUTCOME_CASE =
  "a carrier's outcome commits with its transaction, the first one stays, and a rolled-back one is not kept";
const PENDING_ERASURES_CASE =
  "pendingErasures pages through the rows with a pending carrier, in seq order, with only those carriers, and the count follows";
const ERASURES_ORDER_CASE =
  "erasures returns every committed outbox row in seq order, whatever order they were put in";
const RETRACTED_SCOPES_CASE =
  "recall returns retracted memories, marked, only in the scopes it names as retracted";

const expectations: readonly (readonly [Flaw, string])[] = [
  ["drops-source", "a committed memory is recalled with every field intact"],
  ["drops-trust", "a committed memory is recalled with every field intact"],
  ["drops-pinned", "a committed memory is recalled with every field intact"],
  [
    "drops-trust",
    "liveMemories returns every memory in the requested scopes and none outside them",
  ],
  ["drops-pinned", WAKE_CASE],
  ["drops-trust", WAKE_CASE],
  ["ignores-scopes", WAKE_CASE],
  ["forgets-on-reopen", WAKE_CASE],
  ["constant-seq", "append returns the event with a seq that increases in commit order"],
  ["returns-nothing", "transaction returns what its work returns"],
  ["ignores-scopes", "recall returns only memories in the requested scopes"],
  ["ignores-scopes", "recall with no scopes returns nothing"],
  ["limits-before-filtering", "recall filters by scope before it applies the limit"],
  ["oldest-first", "recall returns the newest memories first, at most limit"],
  ["replace-moves-to-front", "putting a memory again replaces it and keeps its place"],
  ["commits-on-reject", "a transaction whose work rejects commits none of its writes"],
  ["keeps-caller-objects", "committed state is detached from the caller's objects"],
  ["dirty-reads", "a read during an open transaction never sees its uncommitted writes"],
  ["no-serialization", "transactions on one store do not interleave"],
  ["no-serialization", "concurrent transactions lose no write"],
  ["leaked-handle-writes", "a transaction handle refuses writes after its transaction ends"],
  ["forgets-on-reopen", "a reopened store keeps committed writes and drops rolled-back ones"],
  [
    "ignores-scopes",
    "liveMemories returns every memory in the requested scopes and none outside them",
  ],
  ["limits-live-memories", "liveMemories applies no limit"],
  ["keeps-old-revisions", "liveMemories returns each memory once, in its current revision"],
  ["dirty-reads", "liveMemories never sees uncommitted writes"],
  ["forgets-ops", "an op record commits with its transaction and is read back intact"],
  ["ops-outside-transaction", "an op record written by a transaction that rejects is not kept"],
  ["duplicate-ops", "an op id has at most one record per principal"],
  [
    "global-op-ids",
    "an op id belongs to its principal: another principal's write under it is a new operation",
  ],
  ["global-op-ids", "an op id has at most one record per principal"],
  [
    "no-op-enforcement",
    "a retried note returns the first outcome and stores one memory, even from a new relembra with another clock and ids",
  ],
  [
    "no-op-enforcement",
    "the same op id with a different payload is refused and stores nothing new",
  ],
  ["forgets-fence", "a fence epoch commits with its transaction and a rolled-back one is not kept"],
  [
    "fence-outside-transaction",
    "a fence epoch commits with its transaction and a rolled-back one is not kept",
  ],
  [
    "forgets-fence",
    "a paused writer whose fence epoch was advanced commits nothing, and the current writer commits",
  ],
  ["forgets-fence", "advancing a fence never lowers it, and a write's epoch advances it"],
  [
    "append-stores-nothing",
    "committed events persist in seq order and a rolled-back append leaves none",
  ],
  [
    "commits-on-reject",
    "committed events persist in seq order and a rolled-back append leaves none",
  ],
  ["seq-resets-on-reopen", "seq keeps increasing across reopened handles"],
  ["drops-status", ROUND_TRIP_CASE],
  ["drops-superseded-by", ROUND_TRIP_CASE],
  ["drops-sources", ROUND_TRIP_CASE],
  ["tx-memory-reads-committed", TX_MEMORY_CASE],
  ["serves-retracted", LIVE_ONLY_CASE],
  ["serves-superseded", LIVE_ONLY_CASE],
  ["drops-status", LIVE_ONLY_CASE],
  ["retracted-everywhere", RETRACTED_SCOPES_CASE],
  ["hides-retracted", RETRACTED_SCOPES_CASE],
  ["serves-retracted", RETRACT_CASE],
  ["hides-retracted", RETRACT_CASE],
  ["drops-status", RETRACT_CASE],
  ["forgets-on-reopen", RETRACT_CASE],
  ["append-stores-nothing", RETRACT_CASE],
  ["redact-noop", LEAK_CASE],
  ["redact-keeps-event-text", LEAK_CASE],
  ["redact-keeps-fingerprint", LEAK_CASE],
  ["no-derived", LEAK_CASE],
  ["forgets-erasures", LEAK_CASE],
  ["keeps-freed-bytes", LEAK_CASE],
  ["redact-noop", TERMINAL_CASE],
  ["forgets-on-reopen", TERMINAL_CASE],
  ["redact-outside-transaction", ROLLBACK_CASE],
  ["erasures-outside-transaction", ROLLBACK_CASE],
  ["forgets-erasures", ROLLBACK_CASE],
  ["no-derived", RETRACT_CASCADE_CASE],
  ["serves-superseded", SUPERSEDE_CASE],
  ["drops-superseded-by", SUPERSEDE_CASE],
  ["no-op-enforcement", SUPERSEDE_CASE],
  ["forgets-on-reopen", SUPERSEDE_CASE],
  ["drops-status", SUPERSEDE_REFUSED_CASE],
  ["redact-noop", SUPERSEDE_REFUSED_CASE],
  ["drops-pinned", SUPERSEDE_GUARDED_CASE],
  ["drops-trust", SUPERSEDE_GUARDED_CASE],
  ["no-derived", SUPERSEDE_CASCADE_CASE],
  ["expiring-inclusive", SWEEP_CASE],
  ["expiring-ignores-scope", SWEEP_CASE],
  ["expiring-live-only", SWEEP_CASE],
  ["no-derived", SWEEP_CASE],
  ["redact-noop", SWEEP_CASE],
  ["forgets-erasures", SWEEP_CASE],
  ["drops-sources", SUPERSEDE_SUMMARY_CASE],
  ["no-derived", SUPERSEDE_SUMMARY_CASE],
  ["drops-sources", PENDING_CASE],
  ["drops-pinned", PENDING_CASE],
  ["forgets-on-reopen", PENDING_CASE],
  ["drops-status", SOURCE_CHANGED_CASE],
  ["drops-trust", SUMMARY_TRUST_CASE],
  ["drops-sources", SUMMARY_SLOT_CASE],
  ["forgets-on-reopen", SUMMARY_SLOT_CASE],
  ["ignores-scopes", EVENTS_CASE],
  ["redact-keeps-event-text", EVENTS_CASE],
  ["commits-on-reject", EVENTS_CASE],
  ["dirty-reads", EVENTS_CASE],
  ["forgets-on-reopen", EVENTS_CASE],
  ["forgets-checkpoints", CHECKPOINT_CASE],
  ["checkpoints-outside-transaction", CHECKPOINT_CASE],
  ["forgets-on-reopen", CHECKPOINT_CASE],
  ["index-ignores-scopes", INDEX_READ_CASE],
  ["ignores-scopes", INDEX_READ_CASE],
  ["index-serves-non-live", INDEX_READ_CASE],
  ["index-misses-updates", INDEX_READ_CASE],
  ["index-load-order", INDEX_READ_CASE],
  ["index-misses-updates", INDEX_FOLLOWS_CASE],
  ["index-keeps-redacted", INDEX_FOLLOWS_CASE],
  ["index-outside-transaction", INDEX_FOLLOWS_CASE],
  ["index-ignores-scopes", OUT_OF_SCOPE_CASE],
  ["index-keeps-redacted", INDEX_ERASURE_CASE],
  ["index-keeps-freed-terms", INDEX_ERASURE_CASE],
  ["dirty-reads", "a read during an open transaction never sees its uncommitted writes"],
  ["latin1-names", IDENTIFIER_CASE],
  ["drops-origin", PROMOTE_LINK_CASE],
  ["derived-misses-copies", PROMOTE_LINK_CASE],
  ["no-derived", PROMOTE_LINK_CASE],
  ["drops-origin", PROMOTE_REDACT_CASE],
  ["derived-misses-copies", PROMOTE_REDACT_CASE],
  ["redact-keeps-event-text", PROMOTE_REDACT_CASE],
  ["derived-misses-copies", PROMOTE_RETRACT_CASE],
  ["forgets-exposures", EXPOSURE_CASE],
  ["exposure-overwrites-kind", EXPOSURE_CASE],
  ["forgets-on-reopen", EXPOSURE_CASE],
  ["exposure-lost-update", CONCURRENT_EXPOSURE_CASE],
  ["forgets-exposures", CONCURRENT_EXPOSURE_CASE],
  ["exposure-ignores-redaction", EXPOSURE_RACE_CASE],
  ["exposure-races-redaction", EXPOSURE_RACE_CASE],
  ["forgets-settlements", OUTCOME_CASE],
  ["settlement-overwrites", OUTCOME_CASE],
  ["settlements-outside-transaction", OUTCOME_CASE],
  ["drops-carriers", OUTCOME_CASE],
  ["forgets-on-reopen", OUTCOME_CASE],
  ["pending-includes-settled", PENDING_ERASURES_CASE],
  ["pending-ignores-page", PENDING_ERASURES_CASE],
  ["pending-count-stale", PENDING_ERASURES_CASE],
  ["forgets-settlements", PENDING_ERASURES_CASE],
  ["drops-carriers", PENDING_ERASURES_CASE],
  ["erasures-insertion-order", ERASURES_ORDER_CASE],
  ["forgets-erasures", ERASURES_ORDER_CASE],
];

describe("the conformance suite catches a flawed store", () => {
  for (const [flaw, caseName] of expectations) {
    test(`${flaw} fails "${caseName}"`, async () => {
      const cases = storeConformanceCases({
        durable: true,
        open: () => openFlawed(flaw),
      });
      const target = cases.find((c) => c.name === caseName);
      expect(target).toBeDefined();
      const error = await target?.run().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      // A bug in the case itself (a ReferenceError, a TypeError) must not pass for a caught flaw.
      expect((error as Error).name).not.toBeOneOf(["ReferenceError", "TypeError", "SyntaxError"]);
    });
  }

  test("every case has a flaw that fails it", () => {
    const names = storeConformanceCases({ durable: true, open: () => openFlawed("oldest-first") })
      .map((c) => c.name)
      .sort();
    const covered = [...new Set(expectations.map(([, name]) => name))].sort();
    expect(covered).toEqual(names);
  });
});

describe("negative control: op-id enforcement", () => {
  test("a store without op-id enforcement stores a retried note twice", async () => {
    const policy = () => ({ id: "w", readable: ["s"], writable: ["s"], promotable: [] });
    const input = {
      scope: "s",
      text: "Stored once, or twice without enforcement.",
      provenance: { agent: "a", harness: "h", model: "m", host: "h" },
      opId: "op-retry",
    };
    const count = async (store: Store) => (await store.recall({ scopes: ["s"], limit: 10 })).length;

    const flawed = openFlawed("no-op-enforcement").store;
    await createRelembra({ store: flawed, policy }).note(undefined, input);
    await createRelembra({ store: flawed, policy }).note(undefined, input);
    expect(await count(flawed)).toBe(2);

    // Positive control: the same retry on a store that enforces op ids keeps one row.
    const enforcing = createMemoryStore();
    await createRelembra({ store: enforcing, policy }).note(undefined, input);
    await createRelembra({ store: enforcing, policy }).note(undefined, input);
    expect(await count(enforcing)).toBe(1);
  });
});

interface State {
  events: Event[];
  memories: Map<MemoryId, StoredMemory>;
  /** Every memory version ever put, for the keeps-old-revisions flaw. */
  history: Memory[];
  ops: Map<string, OpRecord>;
  fences: Map<string, number>;
  erasures: ErasureWork[];
  /** Keyed by JSON [seq, carrierId]. */
  settlements: Map<string, CarrierSettlement>;
  /** Per memory id, its carriers by id. Written between transactions, as recordExposure runs. */
  exposures: Map<MemoryId, Map<string, Carrier>>;
  checkpoints: Map<string, ImportCheckpoint>;
  /** Every event body ever written, for the keeps-freed-bytes flaw: deleted bytes left on disk. */
  residue: string[];
  /** The term index, keyed by memory id. */
  index: Map<MemoryId, Indexed>;
  /** Every term ever removed from the index, for the index-keeps-freed-terms flaw. */
  indexResidue: string[];
}

interface Indexed {
  readonly scope: string;
  readonly seq: number;
  readonly terms: DocumentTerms;
}

const termsOf = (entry: Indexed) => [...entry.terms.exact.keys(), ...entry.terms.stems.keys()];

const emptyState = (): State => ({
  events: [],
  memories: new Map(),
  history: [],
  ops: new Map(),
  fences: new Map(),
  erasures: [],
  settlements: new Map(),
  exposures: new Map(),
  checkpoints: new Map(),
  residue: [],
  index: new Map(),
  indexResidue: [],
});

/** The outbox rows with a carrier lacking an outcome (all carriers when `all`), in seq order. */
function pendingOf(state: State, all: boolean): ErasureWork[] {
  return [...state.erasures]
    .sort((x, y) => x.seq - y.seq)
    .flatMap((work) => {
      const carriers = work.carriers.filter(
        (carrier) => all || !state.settlements.has(JSON.stringify([work.seq, carrier.id])),
      );
      return carriers.length === 0 ? [] : [{ ...work, carriers }];
    });
}

/** The memories (not tombstones) a state holds, in insertion order. */
function memoriesOf(state: State): Memory[] {
  return [...state.memories.values()].filter((m): m is Memory => m.status !== "redacted");
}

function openFlawed(flaw: Flaw): OpenedStore {
  const shared: { committed: State } = { committed: emptyState() };
  const store = createFlawedStore(flaw, shared);
  return {
    store,
    inspectEvents: () => shared.committed.events,
    rawBytes: () => {
      const { events, memories, ops, erasures, residue, index, indexResidue } = shared.committed;
      const kept = [
        ...(flaw === "keeps-freed-bytes" ? residue : []),
        ...(flaw === "index-keeps-freed-terms" ? indexResidue : []),
      ];
      const held = {
        events,
        memories: [...memories.values()],
        ops: [...ops.values()],
        erasures,
        terms: [...index.values()].map(termsOf),
      };
      return new TextEncoder().encode(JSON.stringify([held, kept]));
    },
    reopen: () =>
      flaw === "forgets-on-reopen"
        ? createFlawedStore(flaw, { committed: emptyState() })
        : createFlawedStore(flaw, shared),
    close() {},
  };
}

/** A copy of the memory store's shape with one flaw switched on. */
function createFlawedStore(flaw: Flaw, shared: { committed: State }): Store {
  // global-op-ids keys records by op id alone, as a store with a one-column unique key would.
  const opKey = (principalId: string, opId: string) =>
    flaw === "global-op-ids" ? opId : JSON.stringify([principalId, opId]);
  let queue: Promise<unknown> = Promise.resolve();
  let working: State | undefined;
  // seq-resets-on-reopen counts per handle, as a store that keeps its counter in memory would.
  let handleSeq = 0;
  const copy = (value: Memory): Memory =>
    flaw === "keeps-caller-objects" ? value : structuredClone(value);

  const run = async <T>(work: (tx: StoreTransaction) => Promise<T>): Promise<T> => {
    const state: State = {
      events: [...shared.committed.events],
      memories: new Map(shared.committed.memories),
      history: [...shared.committed.history],
      ops: new Map(shared.committed.ops),
      fences: new Map(shared.committed.fences),
      erasures: [...shared.committed.erasures],
      settlements: new Map(shared.committed.settlements),
      exposures: shared.committed.exposures,
      checkpoints: new Map(shared.committed.checkpoints),
      residue: [...shared.committed.residue],
      index: new Map(shared.committed.index),
      indexResidue: [...shared.committed.indexResidue],
    };
    working = state;
    /** Keeps the index in step with one memory, in this transaction unless a flaw says otherwise. */
    const reindex = (id: MemoryId, memory: Memory | undefined) => {
      const indexes =
        flaw === "index-outside-transaction"
          ? [state.index, shared.committed.index]
          : [state.index];
      for (const index of indexes) {
        if (flaw === "index-misses-updates" && index.has(id)) continue;
        if (memory === undefined && flaw === "index-keeps-redacted") continue;
        const old = index.get(id);
        if (old !== undefined) state.indexResidue.push(...termsOf(old));
        index.delete(id);
        if (memory === undefined) continue;
        if (memory.status !== "live" && flaw !== "index-serves-non-live") continue;
        const terms = documentTerms(memory.revision.text);
        index.set(id, { scope: memory.scope, seq: memory.seq, terms });
      }
    };
    let open = true;
    const tx: StoreTransaction = {
      async append(event) {
        if (!open && flaw !== "leaked-handle-writes") throw new Error("ended");
        const seq =
          flaw === "constant-seq"
            ? 1
            : flaw === "seq-resets-on-reopen"
              ? ++handleSeq
              : state.events.length + 1;
        const appended = { ...event, seq } as Event;
        if (flaw !== "append-stores-nothing") state.events.push(appended);
        state.residue.push(JSON.stringify(appended));
        return appended;
      },
      async putMemory(memory) {
        if (!open && flaw !== "leaked-handle-writes") throw new Error("ended");
        const target = open ? state.memories : shared.committed.memories;
        if (flaw === "replace-moves-to-front") target.delete(memory.id);
        let stored = copy(memory);
        if (flaw === "drops-source") {
          const { source: _dropped, ...provenance } = stored.revision.provenance;
          stored = { ...stored, revision: { ...stored.revision, provenance } };
        }
        if (flaw === "drops-pinned") stored = { ...stored, pinned: false };
        if (flaw === "latin1-names") {
          // A store that writes names as Latin-1, as a column with the wrong encoding would.
          const latin1 = (name: string) => Buffer.from(name, "utf8").toString("latin1");
          stored = { ...stored, id: latin1(stored.id), scope: latin1(stored.scope) };
        }
        if (flaw === "drops-status") stored = { ...stored, status: "live" };
        if (flaw === "drops-superseded-by") {
          const { supersededBy: _dropped, ...rest } = stored;
          stored = rest;
        }
        if (flaw === "drops-sources") {
          const { sources: _dropped, ...rest } = stored;
          stored = rest;
        }
        if (flaw === "drops-origin") {
          const { origin: _dropped, ...rest } = stored;
          stored = rest;
        }
        if (flaw === "drops-trust") {
          // A store that keeps only the default tier, as a missing column would.
          const provenance = { ...stored.revision.provenance, trust: "agent" as const };
          stored = { ...stored, revision: { ...stored.revision, provenance } };
        }
        target.set(memory.id, stored);
        if (open) reindex(memory.id, stored);
        (open ? state : shared.committed).history.push(stored);
      },
      async memory(id) {
        if (!open) throw new Error("ended");
        return (flaw === "tx-memory-reads-committed" ? shared.committed : state).memories.get(id);
      },
      async derived(id) {
        if (!open) throw new Error("ended");
        if (flaw === "no-derived") return [];
        return memoriesOf(state)
          .filter(
            (m) =>
              (m.sources ?? []).some((source) => source.memoryId === id) ||
              (flaw !== "derived-misses-copies" && m.origin?.memoryId === id),
          )
          .map((m) => m.id);
      },
      async expiring(scope, before) {
        if (!open) throw new Error("ended");
        return memoriesOf(state).filter(
          (m) =>
            (flaw === "expiring-ignores-scope" || m.scope === scope) &&
            (flaw === "expiring-inclusive" ? m.notedAt <= before : m.notedAt < before) &&
            (flaw !== "expiring-live-only" || m.status === "live"),
        );
      },
      async redact(tombstone) {
        if (!open) throw new Error("ended");
        if (flaw === "redact-noop") return;
        // Written straight to committed state, as a store using a second connection would.
        const target = flaw === "redact-outside-transaction" ? shared.committed : state;
        target.memories.set(tombstone.id, tombstone);
        reindex(tombstone.id, undefined);
        if (flaw !== "redact-keeps-event-text") {
          target.events = target.events.map((e) =>
            e.memoryId === tombstone.id ? redactedEvent(e) : e,
          );
        }
        if (flaw === "redact-keeps-fingerprint") return;
        for (const [key, record] of target.ops) {
          if (record.memoryId !== tombstone.id) continue;
          const { fingerprint: _scrubbed, ...rest } = record;
          target.ops.set(key, rest);
        }
      },
      async putErasure(work) {
        if (!open) throw new Error("ended");
        if (flaw === "forgets-erasures") return;
        const stored = flaw === "drops-carriers" ? { ...work, carriers: [] } : work;
        state.erasures.push(stored);
        if (flaw === "erasures-outside-transaction") shared.committed.erasures.push(stored);
      },
      async exposures(memoryId) {
        if (!open) throw new Error("ended");
        return [...(shared.committed.exposures.get(memoryId)?.values() ?? [])];
      },
      async settle(settlement) {
        if (!open) throw new Error("ended");
        if (flaw === "forgets-settlements") return;
        const key = JSON.stringify([settlement.seq, settlement.carrierId]);
        const targets =
          flaw === "settlements-outside-transaction"
            ? [state.settlements, shared.committed.settlements]
            : [state.settlements];
        for (const target of targets) {
          if (flaw === "settlement-overwrites" || !target.has(key)) target.set(key, settlement);
        }
      },
      async op(principalId, opId) {
        if (!open) throw new Error("ended");
        const forgets = flaw === "forgets-ops" || flaw === "no-op-enforcement";
        return forgets ? undefined : state.ops.get(opKey(principalId, opId));
      },
      async putOp(record) {
        if (!open) throw new Error("ended");
        const key = opKey(record.principalId, record.opId);
        const unique = flaw !== "duplicate-ops" && flaw !== "no-op-enforcement";
        if (state.ops.has(key) && unique) throw new Error("duplicate");
        state.ops.set(key, structuredClone(record));
        // Written straight to committed state, as a store using a second connection would.
        if (flaw === "ops-outside-transaction") shared.committed.ops.set(key, record);
      },
      async fenceEpoch(key) {
        if (!open) throw new Error("ended");
        return flaw === "forgets-fence" ? undefined : state.fences.get(key);
      },
      async putFence({ key, epoch }) {
        if (!open) throw new Error("ended");
        state.fences.set(key, epoch);
        if (flaw === "fence-outside-transaction") shared.committed.fences.set(key, epoch);
      },
      async checkpoint(source) {
        if (!open) throw new Error("ended");
        return flaw === "forgets-checkpoints" ? undefined : state.checkpoints.get(source);
      },
      async putCheckpoint(checkpoint) {
        if (!open) throw new Error("ended");
        state.checkpoints.set(checkpoint.source, checkpoint);
        // Written straight to committed state, as a store using a second connection would.
        if (flaw === "checkpoints-outside-transaction") {
          shared.committed.checkpoints.set(checkpoint.source, checkpoint);
        }
      },
    };
    try {
      const result = await work(tx);
      shared.committed = { ...state, exposures: shared.committed.exposures };
      return (flaw === "returns-nothing" ? undefined : result) as T;
    } catch (error) {
      if (flaw === "commits-on-reject") shared.committed = state;
      throw error;
    } finally {
      open = false;
      working = undefined;
    }
  };

  /** Whether liveMemories serves `m`: live only, unless a flaw serves another status. */
  const served = (m: Memory) =>
    m.status === "live" ||
    (flaw === "serves-retracted" && m.status === "retracted") ||
    (flaw === "serves-superseded" && m.status === "superseded");

  return {
    transaction(work) {
      if (flaw === "no-serialization") return run(work);
      const next = queue.then(() => run(work));
      queue = next.catch(() => undefined);
      return next;
    },
    async erasures() {
      if (flaw === "erasures-insertion-order") return shared.committed.erasures;
      return [...shared.committed.erasures].sort((x, y) => x.seq - y.seq);
    },
    async settlements() {
      return [...shared.committed.settlements.values()];
    },
    async pendingErasures({ after = 0, limit }) {
      const rows = pendingOf(shared.committed, flaw === "pending-includes-settled");
      if (flaw === "pending-ignores-page") return rows;
      return rows.filter((work) => work.seq > after).slice(0, limit);
    },
    async pendingErasureCount() {
      const rows = pendingOf(shared.committed, flaw === "pending-count-stale");
      return { work: rows.length, carriers: rows.reduce((n, w) => n + w.carriers.length, 0) };
    },
    recordExposure({ carrier, memoryIds }) {
      const record = async () => {
        if (flaw === "forgets-exposures") return [];
        const exposures = new Map(shared.committed.exposures);
        // A read-modify-write across an await, as a store without a unique key would do.
        if (flaw === "exposure-lost-update") await new Promise((done) => setTimeout(done, 5));
        for (const memoryId of memoryIds) {
          const carriers = new Map(exposures.get(memoryId));
          if (flaw === "exposure-overwrites-kind" || !carriers.has(carrier.id)) {
            carriers.set(carrier.id, { id: carrier.id, kind: carrier.kind });
          }
          exposures.set(memoryId, carriers);
        }
        shared.committed = { ...shared.committed, exposures };
        if (flaw === "exposure-ignores-redaction") return [];
        return memoryIds.filter((id) => shared.committed.memories.get(id)?.status === "redacted");
      };
      // exposure-races-redaction records at once, without waiting for an open transaction.
      if (flaw === "exposure-races-redaction" || flaw === "exposure-lost-update") return record();
      const next = queue.then(record);
      queue = next.catch(() => undefined);
      return next;
    },
    async events({ scopes }) {
      const source = flaw === "dirty-reads" && working ? working : shared.committed;
      return source.events.filter((e) => flaw === "ignores-scopes" || scopes.includes(e.scope));
    },
    async liveMemories({ scopes }) {
      const source = flaw === "dirty-reads" && working ? working : shared.committed;
      const all = flaw === "keeps-old-revisions" ? source.history : memoriesOf(source);
      const live = all.filter(
        (m) => served(m) && (flaw === "ignores-scopes" || scopes.includes(m.scope)),
      );
      return flaw === "limits-live-memories" ? live.slice(0, 100) : live;
    },
    async findByTerms({ scopes, terms, choose }) {
      const source = flaw === "dirty-reads" && working ? working : shared.committed;
      const counted = (scope: string) =>
        flaw === "ignores-scopes" || flaw === "index-ignores-scopes" || scopes.includes(scope);
      const none = { all: 0, kept: 0 };
      let memories = 0;
      let lengthAll = 0;
      let lengthKept = 0;
      const postings: TermPosting[] = [];
      for (const [memoryId, entry] of source.index) {
        if (!counted(entry.scope)) continue;
        memories += 1;
        lengthAll += entry.terms.lengthAll;
        lengthKept += entry.terms.lengthKept;
        const exact = terms.map((t) => entry.terms.exact.get(t.exact) ?? none);
        const stem = terms.map((t) => entry.terms.stems.get(t.stem) ?? none);
        if ([...exact, ...stem].every((c) => c === none)) continue;
        const { lengthAll: all, lengthKept: kept } = entry.terms;
        postings.push({ memoryId, seq: entry.seq, lengthAll: all, lengthKept: kept, exact, stem });
      }
      const chosen = choose({ memories, lengthAll, lengthKept, postings });
      const loaded = chosen.flatMap((id) => {
        const m = source.memories.get(id);
        return m !== undefined && m.status === "live" && scopes.includes(m.scope) ? [m] : [];
      });
      // index-load-order loads in store order instead of the chosen order.
      if (flaw === "index-load-order") return memoriesOf(source).filter((m) => loaded.includes(m));
      return loaded;
    },
    async recall({ scopes, limit, retracted = [] }) {
      const source = flaw === "dirty-reads" && working ? working : shared.committed;
      let all = memoriesOf(source);
      if (flaw !== "oldest-first") all = all.reverse();
      const shownRetracted = (m: Memory) =>
        m.status === "retracted" &&
        flaw !== "hides-retracted" &&
        (flaw === "retracted-everywhere" || retracted.includes(m.scope));
      const readable = (m: Memory) =>
        (served(m) || shownRetracted(m)) && (flaw === "ignores-scopes" || scopes.includes(m.scope));
      if (flaw === "limits-before-filtering") return all.slice(0, limit).filter(readable);
      return all.filter(readable).slice(0, limit);
    },
  };
}
