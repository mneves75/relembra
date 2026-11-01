/**
 * mulberry32: a 32-bit seeded generator. Small, fast and deterministic on every runtime, which is
 * all the synthetic corpus needs. Not for anything that needs unpredictability.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded source of choices, built on mulberry32. */
export interface Rng {
  /** An integer in [0, n). */
  int(n: number): number;
  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (n: number) => Math.floor(next() * n);
  return {
    int,
    pick(items) {
      const item = items[int(items.length)];
      if (item === undefined) throw new Error("pick from an empty list");
      return item;
    },
  };
}
