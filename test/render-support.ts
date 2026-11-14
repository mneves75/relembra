import {
  createRelembra,
  type EgressFilter,
  type NoteProvenance,
  type Principal,
  type Store,
  type Trust,
} from "relembra";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { OTHER_SCOPE, provenance, SCOPE } from "./support.js";

/** Host users for the wake, brief and egress tests. */
type User = "owner" | "agent" | "reader" | "outsider" | "both";

const principals: Record<User, Principal> = {
  owner: {
    id: "owner",
    readable: [SCOPE],
    writable: [SCOPE, OTHER_SCOPE],
    promotable: [],
    pinnable: [SCOPE],
    trustCeiling: "owner",
  },
  agent: { id: "agent", readable: [SCOPE], writable: [SCOPE, OTHER_SCOPE], promotable: [] },
  reader: { id: "reader", readable: [SCOPE], writable: [], promotable: [] },
  outsider: { id: "outsider", readable: [OTHER_SCOPE], writable: [], promotable: [] },
  both: { id: "both", readable: [SCOPE, OTHER_SCOPE], writable: [], promotable: [] },
};

/** 2026-10-30T12:00:00.000Z; the clock advances one second per note. */
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);

/** A relembra with deterministic ids (m-1, m-2, …) and clock, over `store`. */
export function openRendering(options: { store?: Store; egress?: EgressFilter } = {}) {
  const store = options.store ?? createMemoryStore();
  let memories = 0;
  let ops = 0;
  let now = T0;
  const relembra = createRelembra<User>({
    store,
    policy: (user) => principals[user],
    clock: { now: () => (now += 1000) },
    ids: { memoryId: () => `m-${++memories}`, opId: () => `op-${++ops}` },
    ...(options.egress === undefined ? {} : { egress: options.egress }),
  });
  const note = (
    user: User,
    text: string,
    options: { trust?: Trust; pinned?: boolean; scope?: string } = {},
  ) => {
    const noted: NoteProvenance =
      options.trust === undefined ? provenance : { ...provenance, trust: options.trust };
    return relembra.note(user, {
      scope: options.scope ?? SCOPE,
      text,
      provenance: noted,
      ...(options.pinned === undefined ? {} : { pinned: options.pinned }),
    });
  };
  return { store, relembra, note };
}

/** The ISO time of the n-th note (1-based) under openRendering's clock. */
export function at(n: number): string {
  return new Date(T0 + n * 1000).toISOString();
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** One parsed `<memory …>text</memory>` line. */
interface ParsedMemory {
  readonly id: string;
  readonly scope: string;
  readonly rev: string;
  readonly at: string;
  readonly trust: string;
  readonly text: string;
}

const MEMORY_LINE =
  /^<memory id="([^"<>]*)" scope="([^"<>]*)" rev="([^"<>]*)" at="([^"<>]*)" trust="([^"<>]*)">([^<>]*)<\/memory>$/;
const INDEX_LINE = /^<index id="([^"<>]*)"\/>$/;

/**
 * Parses a rendering line by line, written from the format in IMPLEMENTATION-PLAN §4.2 rather
 * than from the renderer. Every line between the frame must be a whole memory or index element;
 * anything else throws.
 */
export function parseRendering(text: string, kind: "wake" | "brief") {
  const lines = text.split("\n");
  if (lines[0] !== `<${kind}>` || lines.at(-1) !== `</${kind}>`) {
    throw new Error(`not a ${kind} frame`);
  }
  const memories: ParsedMemory[] = [];
  const index: string[] = [];
  for (const line of lines.slice(1, -1)) {
    const memory = MEMORY_LINE.exec(line);
    if (memory) {
      const [, id = "", scope = "", rev = "", time = "", trust = "", body = ""] = memory;
      if (index.length > 0) throw new Error("a memory after the index");
      memories.push({ id, scope, rev, at: time, trust, text: body });
      continue;
    }
    const indexed = INDEX_LINE.exec(line);
    if (indexed) {
      index.push(indexed[1] ?? "");
      continue;
    }
    throw new Error(`not a whole element: ${line}`);
  }
  return { memories, index };
}

/** Undoes the four escapes the format requires. */
export function unescapeText(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

export { OTHER_SCOPE, SCOPE };
