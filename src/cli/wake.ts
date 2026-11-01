/**
 * The CLI's wake over the scopes a session reads (docs/CLI.md, `relembra wake`). The library
 * composes one wake over every readable scope newest first, so a full global scope could push
 * every project memory into the index. With a global scope beside the session's, the CLI asks the
 * library for one wake per scope and gives each part a reservation of the budget instead.
 */
import { BudgetError } from "../errors.js";
import type { Carrier } from "../ports.js";
import type { Relembra } from "../relembra.js";
import {
  checkBudget,
  DEFAULT_BUDGET_BYTES,
  frameBytes,
  type Rendering,
  utf8Bytes,
} from "../render.js";

/** The scopes a session reads: its own, and the global scope when that is another one. */
export interface SessionScopes {
  /** Where every write, pin and maintenance command goes; the principal owns it. */
  readonly session: string;
  /** Read beside the session's scope; never the session's scope itself. */
  readonly global?: string;
}

export interface WakeOptions {
  readonly budgetBytes?: number;
  readonly carrier?: Carrier;
}

/**
 * The wake for `scopes`. One scope: the library's wake, unchanged. Two: the session's `<wake>`
 * frame, a newline, then the global scope's frame, within `budgetBytes` together. Of the
 * `budgetBytes - 1` bytes the two frames share, the session's part is reserved
 * `floor((budgetBytes - 1) / 2)` and the global part the rest; room one part leaves unused goes
 * to the other. So: the session's part is first rendered within its reservation, uncarried (it
 * records nothing); the global part gets every byte that rendering left; the session's part is
 * rendered again, carried, in every byte the global part left. Each part then holds at least what
 * fits in its reservation, and the two never exceed the budget.
 */
export async function composeWake(
  relembra: Relembra<null>,
  scopes: SessionScopes,
  options: WakeOptions = {},
): Promise<Rendering> {
  const carrier = options.carrier === undefined ? {} : { carrier: options.carrier };
  if (scopes.global === undefined) {
    const budget = options.budgetBytes === undefined ? {} : { budgetBytes: options.budgetBytes };
    return relembra.wake(null, { scope: scopes.session, ...budget, ...carrier });
  }
  const budget = checkBudget(options.budgetBytes ?? DEFAULT_BUDGET_BYTES);
  const shared = budget - 1;
  const sessionShare = Math.floor(shared / 2);
  // Both parts must hold at least an empty frame.
  if (sessionShare < frameBytes("wake")) throw new BudgetError(budget);
  const probe = await relembra.wake(null, { scope: scopes.session, budgetBytes: sessionShare });
  const global = await relembra.wake(null, {
    scope: scopes.global,
    budgetBytes: shared - utf8Bytes(probe.text),
    ...carrier,
  });
  const session = await relembra.wake(null, {
    scope: scopes.session,
    budgetBytes: shared - utf8Bytes(global.text),
    ...carrier,
  });
  return {
    text: `${session.text}\n${global.text}`,
    memoryIds: [...session.memoryIds, ...global.memoryIds],
  };
}
