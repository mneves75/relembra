import type { Store, StoreTransaction } from "relembra";

/**
 * `store` with a time of its own, as a database keeps one: every `tx.now()` reads `clock()`.
 * Everything else goes to `store` unchanged.
 */
export function timedStore(store: Store, clock: () => number): Store {
  return {
    ...store,
    transaction: (work) =>
      store.transaction((tx) => {
        const timed: StoreTransaction = Object.create(tx);
        timed.now = async () => clock();
        return work(timed);
      }),
  };
}
