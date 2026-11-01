import { GuardError, type GuardRule } from "./errors.js";

export const MAX_MEMORY_BYTES = 280;

const LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/u;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const ZERO_WIDTH = /[\u180e\u200b-\u200d\u2060\ufeff]/u;
const CONTROL = /\p{Cc}/u;
const FORMAT = /\p{Cf}/u;
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;
/** The U+FE0F of a keycap: `1`, `#` or `*`, then U+FE0F, then U+20E3. */
const KEYCAP_SELECTOR = /(?<=[0-9#*])\ufe0f(?=\u20e3)/gu;
/** Combining marks, removed before the credential check so none can split a token. */
const MARKS = /\p{M}/gu;
/** A zero-width joiner between two pictographic emoji; a skin tone or U+FE0F may precede it. */
const EMOJI_JOINER =
  /(?<=\p{Extended_Pictographic}[\u{1f3fb}-\u{1f3ff}\ufe0f]?)\u200d(?=\p{Extended_Pictographic})/gu;
/**
 * One presentation selector (U+FE0E or U+FE0F) right after a pictographic emoji, with no selector
 * after it. Digits, `#` and `*` are emoji too, but take a selector only inside a full keycap
 * (KEYCAP_SELECTOR), so a selector cannot hide inside a token after a digit.
 */
const EMOJI_PRESENTATION =
  /(?<=\p{Extended_Pictographic}[\u{1f3fb}-\u{1f3ff}]?)[\ufe0e\ufe0f](?![\ufe00-\ufe0f\u{e0100}-\u{e01ef}])/gu;

/**
 * Every code point the guard keeps out of a memory for being unseen or for breaking a line:
 * controls, format characters (bidi and zero-width ones among them), default-ignorable code
 * points and the line and paragraph separators, plus lone surrogates, which the guard refuses as
 * `ill-formed`. Each bracketed class of the checks above is one of these.
 */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;

/**
 * `text` with `replace(char)` in place of every code point the guard would refuse as a line
 * break or as unseen (UNSEEN), except the emoji joiners and selectors it allows, which render as
 * part of one visible glyph. A rendering escapes through it, so what it shows has no raw
 * invisible or control character whatever the store holds, and what the guard accepts is
 * unchanged.
 */
export function replaceUnseen(text: string, replace: (char: string) => string): string {
  const allowed = new Set<number>();
  for (const pattern of [EMOJI_JOINER, KEYCAP_SELECTOR, EMOJI_PRESENTATION]) {
    for (const match of text.matchAll(pattern)) allowed.add(match.index);
  }
  return text.replace(UNSEEN, (char: string, offset: number) =>
    allowed.has(offset) ? char : replace(char),
  );
}

/**
 * Token shapes that identify a credential on sight. A token starts and ends where no ASCII letter
 * or digit touches it, so Markdown emphasis (`_`, `*`) and punctuation act as delimiters, which
 * `\b` would not do for `_`.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36}/,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{50,}/,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9])[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/,
  /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{35}/,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/,
  /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}/,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /(?<![A-Za-z0-9])[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

/**
 * `name = value` or `name: value`, where the name may be quoted (JSON, YAML, `.env`, Markdown
 * code). A quoted value runs to its matching closing quote (group 3); an unquoted value runs to
 * whitespace, commas included, so a comma cannot split a secret into harmless pieces (group 4).
 */
const ASSIGNMENT = /["'`]?([A-Za-z_][\w.-]*)["'`]?\s*[:=]\s*(?:(["'`])(.*?)\2|([^\s"'`]+))/g;
/** Sentence punctuation that may follow an unquoted value without being part of it. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;
const SECRET_NAME =
  /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|credential)s?$/i;
/**
 * A value that is wholly a reference to a secret instead of the secret itself: `${NAME}`, `$NAME`,
 * `<name>`, `{{ name }}` or `%NAME%`.
 */
const REFERENCE =
  /^(?:\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)|<([A-Za-z_][\w-]*)>|\{\{\s*([\w.]+)\s*\}\}|%([A-Za-z_]\w*)%)$/;
const REFERENCE_PREFIX = /^(?:\$\{?|<|\{\{|%)/;
const REFERENCE_SUFFIX = /(?:\}\}|\}|>|%)$/;

/** Throws a GuardError naming the first rule `text` breaks. Never includes the text. */
export function guardText(text: string): void {
  const rule = findGuardViolation(text, MAX_MEMORY_BYTES);
  if (rule !== undefined) throw new GuardError(rule);
}

/** The first guard rule `text` breaks when it may hold at most `maxBytes` UTF-8 bytes. */
export function findGuardViolation(text: string, maxBytes: number): GuardRule | undefined {
  if (text.trim() === "") return "blank";
  // Each UTF-16 code unit encodes to at least one UTF-8 byte, so this bounds the work below.
  if (text.length > maxBytes) return "too-long";
  if (!text.isWellFormed()) return "ill-formed";
  if (new TextEncoder().encode(text).length > maxBytes) return "too-long";
  if (LINE_BREAK.test(text)) return "multi-line";
  // Emoji joiners, keycap selectors and presentation selectors render as part of one visible glyph,
  // so they are the only invisible code points allowed; every check below runs on the text without
  // them, the credential check included, so an allowed character cannot split a token.
  const visible = text
    .replace(EMOJI_JOINER, "")
    .replace(KEYCAP_SELECTOR, "")
    .replace(EMOJI_PRESENTATION, "");
  if (BIDI.test(visible)) return "bidi-character";
  if (ZERO_WIDTH.test(visible)) return "zero-width-character";
  if (CONTROL.test(visible)) return "control-character";
  if (FORMAT.test(visible)) return "format-character";
  if (INVISIBLE.test(visible)) return "invisible-character";
  if (holdsCredential(visible.replace(MARKS, ""))) return "credential";
  return undefined;
}

function holdsCredential(text: string): boolean {
  if (CREDENTIAL_SHAPES.some((shape) => shape.test(text))) return true;
  return holdsSecretAssignment(text);
}

/**
 * Checks every assignment in `text`, and every assignment inside each quoted value
 * (`cmd='export token=...'`). Quoted content is strictly shorter than its text, so this ends.
 */
function holdsSecretAssignment(text: string): boolean {
  for (const [, name = "", , quoted, unquoted = ""] of text.matchAll(ASSIGNMENT)) {
    if (quoted !== undefined && holdsSecretAssignment(quoted)) return true;
    const value = quoted ?? unquoted.replace(TRAILING_PUNCTUATION, "");
    if (isReference(value)) continue;
    const bare = value.replace(REFERENCE_PREFIX, "").replace(REFERENCE_SUFFIX, "");
    // A quoted value may be prose; spaces alone do not make it look like a secret.
    if (SECRET_NAME.test(name) && bare.length >= 8 && /[^A-Za-z\s]/.test(bare)) return true;
    if (hasSecretWord(name) && looksEncoded(bare)) return true;
    if (looksRandom(bare)) return true;
  }
  return false;
}

/** Words that make a name secret-like when one of its parts is exactly that word. */
const SECRET_WORDS = new Set([
  "apikey",
  "auth",
  "credential",
  "credentials",
  "key",
  "pass",
  "passwd",
  "password",
  "private",
  "pwd",
  "salt",
  "secret",
  "seed",
  "signing",
  "token",
]);

/** Splits `SIGNING_SEED`, `signing-key` or `signingKey` into parts and looks for a secret word. */
function hasSecretWord(name: string): boolean {
  return name
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .some((part) => SECRET_WORDS.has(part.toLowerCase()));
}

/** Hex of 32 or more characters, or base64/base64url of 20 or more that is not a plain word. */
function looksEncoded(value: string): boolean {
  if (/^[0-9a-fA-F]{32,}$/.test(value)) return true;
  if (!/^[A-Za-z0-9+/_-]{20,}={0,2}$/.test(value)) return false;
  return /[0-9]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value));
}

/**
 * True when the whole value has a reference shape and the name inside it does not look random, so
 * `$DbPassword2` is a placeholder and `$Xk9q2LmT7vR4wZp8` is a secret behind a prefix.
 */
function isReference(value: string): boolean {
  const match = REFERENCE.exec(value);
  const name = match?.slice(1).find((group) => group !== undefined);
  return name !== undefined && !nameLooksRandom(name);
}

/**
 * A name reads as words (`DB_PASSWORD`, `DbPassword2`, `secrets.TOKEN`); a generated string breaks
 * into many one- or two-character fragments at every case or digit change. looksRandom alone is
 * not enough: it needs 20 characters, and a 16-character secret behind `$` must still be caught.
 */
function nameLooksRandom(name: string): boolean {
  if (looksRandom(name)) return true;
  const parts = name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? [];
  const fragments = parts.filter((part) => part.length <= 2).length;
  return parts.length >= 6 && fragments * 2 > parts.length;
}

/** Long, mixed-case, alphanumeric and high in Shannon entropy: the shape of a generated secret. */
function looksRandom(value: string): boolean {
  if (value.length < 20) return false;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) return false;
  return shannonEntropy(value) >= 3.5;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}
