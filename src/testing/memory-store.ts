import { deepFreeze } from "../frozen.js";
import {
  type Event,
  type ImportCheckpoint,
  type Memory,
  type MemoryId,
  type OpId,
  type OpRecord,
  redactedEvent,
  type StoredMemory,
} from "../model.js";
import type {
  Carrier,
  CarrierSettlement,
  ErasureWork,
  Store,
  StoreTransaction,
  TermCounts,
  TermIndexRead,
  TermPosting,
} from "../ports.js";
import { type DocumentTerms, documentTerms } from "../ranking.js";

/** The term index entry of one live memory. */
interface Indexed {
  readonly scope: string;
  readonly seq: number;
  readonly terms: DocumentTerms;
}

interface State {
  readonly events: readonly Event[];
  readonly memories: ReadonlyMap<MemoryId, StoredMemory>;
  /** The term index: live memories only, kept in the same transaction as `memories`. */
  readonly index: ReadonlyMap<MemoryId, Indexed>;
  /** Keyed by opKey(principalId, opId). */
  readonly ops: ReadonlyMap<string, OpRecord>;
  readonly fences: ReadonlyMap<string, number>;
  readonly erasures: readonly ErasureWork[];
  /** Keyed by settlementKey(seq, carrierId). */
  readonly settlements: ReadonlyMap<string, CarrierSettlement>;
  readonly checkpoints: ReadonlyMap<string, ImportCheckpoint>;
  /** Per memory id, its carriers by carrier id, as first recorded. */
  readonly exposures: ReadonlyMap<MemoryId, ReadonlyMap<string, Carrier>>;
}

/** A store held in process memory, for tests and examples. */
export function createMemoryStore(): Store {
  let committed: State = {
    events: [],
    memories: new Map(),
    index: new Map(),
    ops: new Map(),
    fences: new Map(),
    erasures: [],
    settlements: new Map(),
    checkpoints: new Map(),
    exposures: new Map(),
  };
  let queue: Promise<unknown> = Promise.resolve();

  return {
    transaction<T>(work: (tx: StoreTransaction) => Promise<T>): Promise<T> {
      const run = queue.then(async () => {
        const events = [...committed.events];
        const memories = new Map(committed.memories);
        const index = new Map(committed.index);
        const ops = new Map(committed.ops);
        const fences = new Map(committed.fences);
        const erasures = [...committed.erasures];
        const settlements = new Map(committed.settlements);
        const checkpoints = new Map(committed.checkpoints);
        let open = true;
        const assertOpen = () => {
          if (!open) throw new Error("store transaction used after it ended");
        };
        const tx: StoreTransaction = {
          async append(event) {
            assertOpen();
            const appended = snapshot<Event>({ ...event, seq: events.length + 1 });
            events.push(appended);
            return appended;
          },
          async putMemory(memory) {
            assertOpen();
            const stored = snapshot(memory);
            memories.set(memory.id, stored);
            index.delete(memory.id);
            if (stored.status === "live") {
              const terms = documentTerms(stored.revision.text);
              index.set(memory.id, { scope: stored.scope, seq: stored.seq, terms });
            }
          },
          async memory(id) {
            assertOpen();
            return memories.get(id);
          },
          async derived(id) {
            assertOpen();
            return [...memories.values()].flatMap((stored) =>
              stored.status !== "redacted" &&
              ((stored.sources ?? []).some((source) => source.memoryId === id) ||
                stored.origin?.memoryId === id)
                ? [stored.id]
                : [],
            );
          },
          async expiring(scope, before) {
            assertOpen();
            return [...memories.values()].flatMap((stored) =>
              stored.status !== "redacted" && stored.scope === scope && stored.notedAt < before
                ? [stored]
                : [],
            );
          },
          async redact(tombstone) {
            assertOpen();
            memories.set(tombstone.id, snapshot(tombstone));
            index.delete(tombstone.id);
            events.forEach((event, index) => {
              if (event.memoryId === tombstone.id) events[index] = snapshot(redactedEvent(event));
            });
            for (const [key, record] of ops) {
              if (record.memoryId !== tombstone.id) continue;
              const { fingerprint: _scrubbed, ...rest } = record;
              ops.set(key, snapshot(rest));
            }
          },
          async putErasure(work) {
            assertOpen();
            erasures.push(snapshot(work));
          },
          async exposures(memoryId) {
            assertOpen();
            // Recorders run in the transaction queue, so none commits while this one is open.
            return [...(committed.exposures.get(memoryId)?.values() ?? [])];
          },
          async settle(settlement) {
            assertOpen();
            const key = settlementKey(settlement.seq, settlement.carrierId);
            if (!settlements.has(key)) settlements.set(key, snapshot(settlement));
          },
          async op(principalId, opId) {
            assertOpen();
            return ops.get(opKey(principalId, opId));
          },
          async putOp(record) {
            assertOpen();
            const key = opKey(record.principalId, record.opId);
            if (ops.has(key)) throw new Error("the principal already has a record for this op id");
            ops.set(key, snapshot(record));
          },
          async fenceEpoch(key) {
            assertOpen();
            return fences.get(key);
          },
          async putFence({ key, epoch }) {
            assertOpen();
            fences.set(key, epoch);
          },
          async checkpoint(source) {
            assertOpen();
            return checkpoints.get(source);
          },
          async putCheckpoint(checkpoint) {
            assertOpen();
            checkpoints.set(checkpoint.source, snapshot(checkpoint));
          },
        };
        try {
          const result = await work(tx);
          // Exposures are written only between transactions (recordExposure is queued too).
          const { exposures } = committed;
          committed = {
            events,
            memories,
            index,
            ops,
            fences,
            erasures,
            settlements,
            checkpoints,
            exposures,
          };
          return result;
        } finally {
          open = false;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },

    async recall({ scopes, limit, retracted = [] }) {
      const readable = new Set(scopes);
      const owned = new Set(retracted);
      const newestFirst = [...committed.memories.values()].reverse();
      return newestFirst
        .filter(
          (memory) =>
            readable.has(memory.scope) &&
            (memory.status === "live" ||
              (memory.status === "retracted" && owned.has(memory.scope))),
        )
        .slice(0, limit) as Memory[];
    },

    async erasures() {
      return committed.erasures;
    },

    async settlements() {
      return [...committed.settlements.values()];
    },

    async pendingErasures({ after = 0, limit }) {
      return pendingIn(committed)
        .filter((work) => work.seq > after)
        .slice(0, limit);
    },

    async pendingErasureCount() {
      const pending = pendingIn(committed);
      return {
        work: pending.length,
        carriers: pending.reduce((sum, work) => sum + work.carriers.length, 0),
      };
    },

    recordExposure({ carrier, memoryIds }) {
      // In the transaction queue, so a redaction's exposures read sees every recording that
      // started before it, and a recording that starts after it runs after its commit.
      const run = queue.then(() => {
        const exposures = new Map(committed.exposures);
        const stored = snapshot({ id: carrier.id, kind: carrier.kind });
        for (const memoryId of memoryIds) {
          const carriers = new Map(exposures.get(memoryId));
          if (!carriers.has(carrier.id)) carriers.set(carrier.id, stored);
          exposures.set(memoryId, carriers);
        }
        committed = { ...committed, exposures };
        return memoryIds.filter((id) => committed.memories.get(id)?.status === "redacted");
      });
      queue = run.catch(() => undefined);
      return run;
    },

    async events({ scopes }) {
      const readable = new Set(scopes);
      return committed.events.filter((event) => readable.has(event.scope));
    },

    async liveMemories({ scopes }) {
      const readable = new Set(scopes);
      return [...committed.memories.values()].filter(
        (memory): memory is Memory => memory.status === "live" && readable.has(memory.scope),
      );
    },

    async findByTerms({ scopes, terms, choose }) {
      // One synchronous pass over committed state: the read, the choice and the load share it.
      const { index, memories } = committed;
      const readable = new Set(scopes);
      const read = { memories: 0, lengthAll: 0, lengthKept: 0 };
      const postings: TermPosting[] = [];
      for (const [memoryId, entry] of index) {
        if (!readable.has(entry.scope)) continue;
        const { lengthAll, lengthKept, exact: exactCounts, stems } = entry.terms;
        read.memories += 1;
        read.lengthAll += lengthAll;
        read.lengthKept += lengthKept;
        const exact = terms.map((term) => exactCounts.get(term.exact) ?? NONE);
        const stem = terms.map((term) => stems.get(term.stem) ?? NONE);
        if (exact.every((c) => c === NONE) && stem.every((c) => c === NONE)) continue;
        postings.push({ memoryId, seq: entry.seq, lengthAll, lengthKept, exact, stem });
      }
      const chosen = choose({ ...read, postings } satisfies TermIndexRead);
      return chosen.flatMap((id) => {
        const memory = memories.get(id);
        return memory?.status === "live" && readable.has(memory.scope) ? [memory] : [];
      });
    },
  };
}

const NONE: TermCounts = Object.freeze({ all: 0, kept: 0 });

/** The outbox rows with a carrier that has no outcome, each with only those carriers, in seq order. */
function pendingIn(state: State): ErasureWork[] {
  return [...state.erasures]
    .sort((x, y) => x.seq - y.seq)
    .flatMap((work) => {
      const carriers = work.carriers.filter(
        (carrier) => !state.settlements.has(settlementKey(work.seq, carrier.id)),
      );
      return carriers.length === 0 ? [] : [{ ...work, carriers }];
    });
}

/** One key per (outbox seq, carrier id) pair. */
function settlementKey(seq: number, carrierId: string): string {
  return JSON.stringify([seq, carrierId]);
}

/** One key per (principal, op id) pair; the JSON tuple keeps the two apart. */
function opKey(principalId: string, opId: OpId): string {
  return JSON.stringify([principalId, opId]);
}

/** A deep, frozen copy, so neither the caller nor a reader can change committed state. */
function snapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}
