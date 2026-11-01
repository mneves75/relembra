/**
 * The one part of `node:util` the library calls, for the landing page's browser bundle:
 * `isDeepStrictEqual` over the plain data it compares (memories: objects, arrays, primitives).
 * Same rules as Node for that data: `Object.is` for primitives, equal prototypes, the same own
 * enumerable keys (an array hole is not an `undefined`), compared recursively. Any other kind of
 * object throws instead of guessing; test/site.test.ts checks it against `node:util`.
 */
export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const prototype = Object.getPrototypeOf(a);
  if (prototype !== Object.getPrototypeOf(b)) return false;
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    throw new TypeError("isDeepStrictEqual: only plain objects and arrays are supported here");
  }
  if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      isDeepStrictEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}
