/** Frozen, detached copies, as the stores hand values out: a caller cannot change what is stored. */
import type { Event, NewEvent } from "./model.js";

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function detachEvent(event: NewEvent, seq: number): Event {
  return deepFreeze(structuredClone({ ...event, seq }));
}
