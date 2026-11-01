/**
 * What JSON.parse hides: a key written twice in one object keeps only its last value. This scan
 * runs over text JSON.parse has already accepted, so it only has to tell strings, keys and
 * structure apart.
 */
export interface JsonScan {
  /** Whether some object holds one key twice (compared decoded, so escapes cannot hide it). */
  readonly duplicate: boolean;
  /** Every key and string value in document order, decoded, duplicates included. */
  readonly strings: readonly string[];
}

/** One open container: an object's keys so far and whether a key comes next, or an array. */
type Frame = { keys: Set<string>; expectKey: boolean } | "array";

export function scanJson(text: string): JsonScan {
  const strings: string[] = [];
  const stack: Frame[] = [];
  let duplicate = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      // The token is valid JSON, so JSON.parse decodes its escapes exactly.
      const value = JSON.parse(text.slice(i, end + 1)) as string;
      strings.push(value);
      const top = stack.at(-1);
      if (top !== undefined && top !== "array" && top.expectKey) {
        if (top.keys.has(value)) duplicate = true;
        top.keys.add(value);
        top.expectKey = false;
      }
      i = end + 1;
      continue;
    }
    if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push("array");
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") {
      const top = stack.at(-1);
      if (top !== undefined && top !== "array") top.expectKey = true;
    }
    i++;
  }
  return { duplicate, strings };
}
