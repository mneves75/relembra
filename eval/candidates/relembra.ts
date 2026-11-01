/**
 * The relembra candidate: the library itself, in process, behind eval/PROTOCOL.md.
 * Usage: bun eval/candidates/relembra.ts [--store memory|sqlite]   (default sqlite)
 *
 * - The policy's result is the request's own principal, mapped field by field to relembra's
 *   `Principal`. The candidate takes no principal, scope or trust from its arguments.
 * - A `note` batch's principal is the corpus loader. It is given ownership of the scopes it
 *   writes, because the protocol asks it to retract, redact and supersede what it noted. Readers
 *   never own anything.
 * - Each item's `at` is the injected clock, and ids come from a counter, so the same corpus always
 *   gives the same store.
 * - `find`, `brief` and `wake` return what relembra returns, untouched: the scorer sees exactly the
 *   text a model would see.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelembra, type Memory, type Principal, type Relembra, type Store } from "relembra";
import { openSqliteStore, type SqliteStore } from "relembra/sqlite";
import { createMemoryStore } from "relembra/testing";
import type { Requests, Results } from "../protocol.js";
import type { EvalPrincipal, Trust } from "../set.js";
import { type CandidateHandler, serve } from "./serve.js";

export type StoreKind = "memory" | "sqlite";
export const STORE_KINDS: readonly StoreKind[] = ["memory", "sqlite"];

export interface RelembraCandidate extends CandidateHandler {
  /** Closes the store and removes its files. */
  close(): Promise<void>;
}

const VERSION = (
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

/** The provenance of every corpus write: the loader, not a model. */
const PROVENANCE = { agent: "eval-loader", harness: "relembra-eval", model: "none", host: "eval" };

/** A reader: the request's principal, as relembra's `Principal`. It owns nothing. */
function reader(p: EvalPrincipal): Principal {
  return {
    id: p.id,
    readable: [...p.readable],
    writable: [...p.writable],
    promotable: [...p.promotable],
    trustCeiling: p.trustCeiling,
    pinnable: p.pinnable ? [...p.writable] : [],
  };
}

/** The corpus loader: a reader that also owns the scopes it writes (see the header). */
function loader(p: EvalPrincipal): Principal {
  return { ...reader(p), owned: [...p.writable] };
}

/** A memory's trust label, read fail-closed as relembra's rendering reads it. */
function trustOf(memory: Memory): Trust {
  const trust = memory.revision.provenance.trust;
  return trust === "owner" || trust === "agent" ? trust : "untrusted";
}

interface Opened {
  readonly store: Store;
  close(): Promise<void>;
}

function openStore(kind: StoreKind): Opened {
  if (kind === "memory") return { store: createMemoryStore(), close: async () => {} };
  const dir = mkdtempSync(join(tmpdir(), "relembra-eval-candidate-"));
  const store: SqliteStore = openSqliteStore({ path: join(dir, "relembra.db") });
  return {
    store,
    close: async () => {
      try {
        await store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export function createRelembraCandidate(kind: StoreKind): RelembraCandidate {
  let opened: Opened | undefined;
  let relembra: Relembra<Principal> | undefined;
  /** What relembra stored for each id this session wrote: the wake's pinned section reads it. */
  let written = new Map<string, Memory>();
  let now = 0;
  let counter = 0;

  const library = (): Relembra<Principal> => {
    if (relembra === undefined) throw new Error("reset must come first");
    return relembra;
  };

  return {
    async reset(): Promise<Results["reset"]> {
      await opened?.close();
      opened = openStore(kind);
      written = new Map();
      counter = 0;
      relembra = createRelembra<Principal>({
        store: opened.store,
        policy: (principal) => principal,
        clock: { now: () => now },
        ids: {
          memoryId: () => `relembra-${String(++counter).padStart(6, "0")}`,
          opId: () => `op-${String(counter).padStart(6, "0")}`,
        },
      });
      return { protocol: 1, name: "relembra", version: `${VERSION}+${kind}` };
    },

    async note({ principal, memories }: Requests["note"]): Promise<Results["note"]> {
      const core = library();
      const writer = loader(principal);
      const ids: string[] = [];
      for (const item of memories) {
        now = item.at;
        const provenance = { ...PROVENANCE, trust: item.trust };
        const memory =
          item.supersedes === undefined
            ? await core.note(writer, {
                scope: item.scope,
                text: item.text,
                provenance,
                pinned: item.pinned,
              })
            : await core.supersede(writer, {
                memoryId: item.supersedes,
                text: item.text,
                provenance,
                pinned: item.pinned,
              });
        // A replacement lives in the replaced memory's scope; a corpus that says otherwise is wrong.
        if (memory.scope !== item.scope) throw new Error("a replacement changed scope");
        if (item.state === "retracted") await core.retract(writer, { memoryId: memory.id });
        if (item.state === "redacted") await core.redact(writer, { memoryId: memory.id });
        written.set(memory.id, memory);
        ids.push(memory.id);
      }
      return { ids };
    },

    async find({ principal, query, limit }: Requests["find"]): Promise<Results["find"]> {
      const found = await library().find(reader(principal), { query, limit });
      return {
        results: found.map(({ memory }) => ({
          id: memory.id,
          text: memory.revision.text,
          trust: trustOf(memory),
        })),
      };
    },

    async brief({ principal, topic, budgetBytes }: Requests["brief"]): Promise<Results["brief"]> {
      const { text } = await library().brief(reader(principal), { topic, budgetBytes });
      return { text };
    },

    async wake({ principal, scope, budgetBytes }: Requests["wake"]): Promise<Results["wake"]> {
      const { text, memoryIds } = await library().wake(reader(principal), { scope, budgetBytes });
      // A wake opens with its pinned memories (untrusted ones are never pinned there), so the
      // pinned section is the leading run of rendered memories that are pinned and trusted.
      const pinned: string[] = [];
      for (const id of memoryIds) {
        const memory = written.get(id);
        if (memory === undefined || !memory.pinned || trustOf(memory) === "untrusted") break;
        pinned.push(id);
      }
      return { text, pinned };
    },

    async close() {
      await opened?.close();
      opened = undefined;
      relembra = undefined;
    },
  };
}

export function parseStoreKind(argv: readonly string[]): StoreKind {
  const index = argv.indexOf("--store");
  if (index < 0) return "sqlite";
  const kind = argv[index + 1];
  if (!STORE_KINDS.includes(kind as StoreKind)) {
    throw new Error(`usage: relembra.ts [--store ${STORE_KINDS.join("|")}]`);
  }
  return kind as StoreKind;
}

if (import.meta.main) {
  const candidate = createRelembraCandidate(parseStoreKind(process.argv.slice(2)));
  try {
    await serve(candidate);
  } finally {
    await candidate.close();
  }
}
