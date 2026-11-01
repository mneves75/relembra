import type { Scope, Store } from "relembra";

/** What an import must reproduce of one memory: its identity, scope, status, text and links. */
export interface Described {
  readonly id: string;
  readonly scope: Scope;
  readonly status: string;
  readonly text?: string;
  readonly supersededBy?: string;
  readonly sources?: readonly { readonly memoryId: string; readonly revision: number }[];
  readonly origin?: { readonly memoryId: string; readonly revision: number };
}

/**
 * Every memory and tombstone in `scopes`, sorted by id: the memory ids the events name, each read
 * as the store holds it now. Trust, pins, principals and seqs are left out (an import changes them).
 */
export async function describeStore(store: Store, scopes: readonly Scope[]): Promise<Described[]> {
  const ids = [...new Set((await store.events({ scopes })).map((event) => event.memoryId))].sort();
  return store.transaction(async (tx) => {
    const described: Described[] = [];
    for (const id of ids) {
      const stored = await tx.memory(id);
      if (stored === undefined) throw new Error(`an event names ${id}, which the store lacks`);
      if (stored.status === "redacted") {
        described.push({ id, scope: stored.scope, status: "redacted" });
        continue;
      }
      described.push({
        id,
        scope: stored.scope,
        status: stored.status,
        text: stored.revision.text,
        ...(stored.supersededBy === undefined ? {} : { supersededBy: stored.supersededBy }),
        ...(stored.sources === undefined ? {} : { sources: stored.sources }),
        ...(stored.origin === undefined ? {} : { origin: stored.origin }),
      });
    }
    return described;
  });
}
