import { describe, expect, test } from "bun:test";
import { GuardError, type GuardRule } from "relembra";
import { openTestRelembra, provenance, SCOPE } from "./support.js";

/** Synthetic, deterministic filler: `length` characters cycling through `alphabet`. */
function filler(length: number, alphabet: string): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[(i * 7 + 3) % alphabet.length];
  return out;
}

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
// Credential shapes are assembled at runtime so no literal token sits in the source.
const join = (...parts: string[]) => parts.join("");

async function noteText(text: string) {
  const relembra = openTestRelembra();
  const outcome = await relembra.note({ user: "writer" }, { scope: SCOPE, text, provenance }).then(
    () => undefined,
    (error: unknown) => error,
  );
  const stored = await relembra.recall({ user: "reader" });
  return { error: outcome, stored };
}

async function expectRejected(text: string, rule: GuardRule) {
  const { error, stored } = await noteText(text);
  expect(error).toBeInstanceOf(GuardError);
  const guardError = error as GuardError;
  expect(guardError.rule).toBe(rule);
  expect(guardError.message).toContain(rule);
  // The error never echoes the input, in any property it carries.
  const carried = Object.getOwnPropertyNames(guardError)
    .map((key) => String((guardError as unknown as Record<string, unknown>)[key]))
    .join("\n");
  const marker = text.trim().slice(0, 24);
  if (marker.length >= 4) expect(carried).not.toContain(marker);
  expect(stored).toEqual([]);
}

async function expectAccepted(text: string) {
  const { error, stored } = await noteText(text);
  expect(error).toBeUndefined();
  expect(stored.map((memory) => memory.revision.text)).toEqual([text]);
}

describe("guard: size", () => {
  test("blank text is rejected", async () => {
    await expectRejected("", "blank");
    await expectRejected("   ", "blank");
  });

  test("280 UTF-8 bytes are accepted and 281 are rejected, counted in bytes not characters", async () => {
    await expectAccepted("a".repeat(280));
    await expectAccepted("ã".repeat(140));
    await expectRejected("a".repeat(281), "too-long");
    await expectRejected(`${"ã".repeat(140)}a`, "too-long");
    await expectRejected("\u{1f680}".repeat(71), "too-long");
  });

  test("ten megabytes are rejected as too long", async () => {
    await expectRejected("x".repeat(10 * 1024 * 1024), "too-long");
  });
});

describe("guard: shape", () => {
  test("every line break makes the text multi-line", async () => {
    for (const lineBreak of ["\n", "\r\n", "\r", "\v", "\f", "\u0085", "\u2028", "\u2029"]) {
      await expectRejected(`first line${lineBreak}second line`, "multi-line");
    }
  });

  test("control characters are rejected", async () => {
    for (const control of ["\u0000", "\t", "\u001b", "\u007f", "\u0090"]) {
      await expectRejected(`before${control}after`, "control-character");
    }
  });

  test("bidi controls are rejected", async () => {
    for (const bidi of ["\u202e", "\u202a", "\u2066", "\u2069", "\u200f", "\u061c"]) {
      await expectRejected(`before${bidi}after`, "bidi-character");
    }
  });

  test("zero-width characters are rejected", async () => {
    for (const zeroWidth of ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u180e"]) {
      await expectRejected(`before${zeroWidth}after`, "zero-width-character");
    }
  });

  test("other invisible format characters are rejected", async () => {
    for (const format of ["\u00ad", "\u{e0041}", "\ufff9", "\u206a"]) {
      await expectRejected(`before${format}after`, "format-character");
    }
  });

  test("text with a lone surrogate is rejected as ill-formed", async () => {
    await expectRejected("before\ud800after", "ill-formed");
  });

  test("default-ignorable characters that render as nothing are rejected", async () => {
    const invisibles = [
      "\u034f", // combining grapheme joiner
      "\u115f", // Hangul choseong filler
      "\u1160", // Hangul jungseong filler
      "\u3164", // Hangul filler
      "\uffa0", // halfwidth Hangul filler
      "\u180b", // Mongolian free variation selector one
      "\u180f", // Mongolian free variation selector four
      "\u17b4", // Khmer vowel inherent aq
    ];
    for (const invisible of invisibles) {
      await expectRejected(`before${invisible}after`, "invisible-character");
    }
  });

  test("a combining grapheme joiner inside a token prefix is rejected", async () => {
    await expectRejected(`see g\u034fhp_${filler(36, BASE62)} here`, "invisible-character");
  });

  test("variation selectors are rejected unless one follows an emoji", async () => {
    await expectRejected("plain\ufe0ftext", "invisible-character");
    await expectRejected("plain\ufe00text", "invisible-character");
    await expectRejected("emoji \u{1f600}\ufe0f\ufe0f twice", "invisible-character");
    await expectRejected("emoji \u{1f600}\u{e0100} supplement", "invisible-character");
  });

  test("a zero-width joiner outside an emoji sequence is rejected", async () => {
    await expectRejected("joined\u200dletters", "zero-width-character");
    await expectRejected("dangling \u{1f469}\u200d", "zero-width-character");
  });

  test("emoji tag sequences are rejected because tag characters can carry hidden text", async () => {
    await expectRejected(
      "flag \u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}",
      "format-character",
    );
  });

  test("a selector or joiner after a digit inside a token is refused", async () => {
    const vs16 = String.fromCodePoint(0xfe0f);
    const vs15 = String.fromCodePoint(0xfe0e);
    const zwj = String.fromCodePoint(0x200d);
    const keycap = String.fromCodePoint(0x20e3);
    const stripe = (mark: string) => join("s", "k_live_4", mark, filler(23, BASE62));
    const github = (mark: string) => join("gh", "p_1", mark, filler(35, BASE62));

    await expectRejected(`key ${stripe(vs16)} here`, "invisible-character");
    await expectRejected(`key ${github(vs16)} here`, "invisible-character");
    await expectRejected(`key ${github(vs15)} here`, "invisible-character");
    await expectRejected(`key ${github(zwj)} here`, "zero-width-character");
    await expectRejected(`key ${stripe(`${vs16}${keycap}`)} here`, "credential");
  });

  test("keycaps, heart and technologist emoji stay accepted", async () => {
    const vs16 = String.fromCodePoint(0xfe0f);
    const keycap = String.fromCodePoint(0x20e3);
    const heart = String.fromCodePoint(0x2764);
    const technologist = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb);
    await expectAccepted(`Steps 1${vs16}${keycap} #${vs16}${keycap} *${vs16}${keycap} done.`);
    await expectAccepted(`Thanks ${heart}${vs16} from the ${technologist} team.`);
  });

  // Rule: a zero-width joiner is allowed only between two pictographic emoji (an optional skin tone
  // or U+FE0F may sit before it), and one U+FE0E or U+FE0F only right after an emoji. These render
  // as one visible glyph, so nothing is hidden.
  test("emoji ZWJ sequences, skin tones, presentation selectors, keycaps and flags are accepted", async () => {
    await expectAccepted("Pairing with \u{1f469}\u200d\u{1f4bb} today.");
    await expectAccepted("Pride \u{1f3f3}\ufe0f\u200d\u{1f308} release.");
    await expectAccepted("Family \u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466} plan.");
    await expectAccepted("Dev \u{1f9d1}\u{1f3fd}\u200d\u{1f4bb} on call.");
    await expectAccepted("Thumbs \u{1f44d}\u{1f3fd} and \u2764\ufe0f and \u2764\ufe0e.");
    await expectAccepted("Step 1\ufe0f\u20e3 first.");
    await expectAccepted("Team in \u{1f1e7}\u{1f1f7} and \u{1f1f5}\u{1f1f9}.");
  });

  test("ordinary text in Portuguese and English, emoji included, is accepted", async () => {
    await expectAccepted("A migração do banco roda antes do deploy.");
    await expectAccepted("Release notes go in CHANGELOG.md \u{1f680} \u2764\ufe0f");
    await expectAccepted("Use `bun test --watch` while editing; CI runs on Node 24 and Bun.");
  });
});

describe("guard: credentials", () => {
  const credentials: Record<string, string> = {
    "private key header": join("-----BEGIN ", "OPENSSH PRIVATE KEY", "----- b3BlbnNzaA"),
    "RSA private key header": join("-----BEGIN ", "RSA PRIVATE KEY", "-----"),
    "GitHub token": join("token is gh", "p_", filler(36, BASE62)),
    "GitHub fine-grained token": join(
      "github",
      "_pat_",
      filler(22, BASE62),
      "_",
      filler(59, BASE62),
    ),
    "GitLab token": join("gl", "pat-", filler(20, BASE62)),
    "OpenAI-style key": join("s", "k-", filler(32, BASE62)),
    "Anthropic-style key": join("s", "k-ant-api03-", filler(40, BASE62)),
    "Stripe secret key": join("s", "k_live_", filler(24, BASE62)),
    "AWS access key id": join("AK", "IA", filler(16, UPPER_DIGITS)),
    "Slack token": join("xo", "xb-", "1234567890-", filler(24, BASE62)),
    "Google API key": join("AI", "za", filler(35, BASE62)),
    "npm token": join("np", "m_", filler(36, BASE62)),
    "Hugging Face token": join("h", "f_", filler(34, BASE62)),
    JWT: join("ey", "JhbGciOiJIUzI1NiJ9.", "ey", "JzdWIiOiIxMjM0In0.", filler(43, BASE62)),
    "bearer token": join("Authorization: Bear", "er ", filler(40, BASE62)),
    "URL with a password": join("postgres://app:", "s3cr3t-pa55", "@db.example.test/app"),
    "password assignment": join("pass", "word=", "hunter2-example"),
    "secret assignment": join("CLIENT_SEC", "RET: ", "x9", filler(20, BASE62)),
    "high-entropy assignment": join("SIGNING_SEED=", filler(40, BASE62)),
    "dollar-prefixed password": join("pass", "word=$", "Xk9q2LmT7vR4wZp8"),
    "brace-wrapped token": join("tok", "en={{", "Xk9q2LmT7vR4wZp8abc", "}}"),
    "percent-prefixed secret": join("sec", "ret=%", "Xk9q2LmT7vR4wZp8"),
  };

  for (const [shape, text] of Object.entries(credentials)) {
    test(`rejects a credential: ${shape}`, async () => {
      await expectRejected(text, "credential");
    });
  }

  const quotedAssignments: Record<string, string> = {
    "JSON with a quoted key": join('{"tok', 'en":"', "Xk9q2LmT7vR4wZp8abC6", '"}'),
    "JSON with spaces": join('{ "api_', 'key" : "', "Xk9q2LmT7vR4wZp8abC6", '" }'),
    "YAML with single quotes": join("'pass", "word': '", "hunter2-example", "'"),
    ".env with a quoted value": join("DB_PASS", 'WORD="', "hunter2-example", '"'),
  };

  for (const [shape, text] of Object.entries(quotedAssignments)) {
    test(`rejects a quoted assignment: ${shape}`, async () => {
      await expectRejected(text, "credential");
    });
  }

  const HEX = "0123456789abcdef";
  const encodedSecrets: Record<string, string> = {
    "lowercase hex seed": join("SIGNING_", "SEED=", "ae01379b42f8c65d0e43a978bc12f560"),
    "uppercase hex private key": join("private_", "key: ", filler(64, HEX).toUpperCase()),
    "base64url auth value": join("au", "th=", "q8r2-mz7x_k4p9w1v6t3ab"),
    "base64 salt with padding": join("password_", "salt=", "c2VjcmV0c2FsdHZhbHVlMTI=="),
    "camelCase signing key": join("signing", "Key=", filler(40, HEX)),
  };

  for (const [shape, text] of Object.entries(encodedSecrets)) {
    test(`rejects an encoded value assigned to a secret-like name: ${shape}`, async () => {
      await expectRejected(text, "credential");
    });
  }

  test("hashes in prose and encoded values under ordinary names are accepted", async () => {
    await expectAccepted("commit ae01379b42f8c65d0e43a978bc12f560ab12cd34 fixed it");
    await expectAccepted(
      "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 is the test file.",
    );
    await expectAccepted(`checksum=${filler(64, HEX)} matches the release.`);
    await expectAccepted("keyboard=us-international-2024 is the default layout.");
    await expectAccepted("author=release-bot-2024-automation signs the tags.");
  });

  const commaSplitSecrets: Record<string, string> = {
    "token split by a comma": join("tok", "en=", "Xk9q2LmT,7vR4wZp8abC6q"),
    "password with a comma": join("pass", "word=", "hunter2,Xk9q2LmT7vR4wZp8"),
  };

  for (const [shape, text] of Object.entries(commaSplitSecrets)) {
    test(`rejects an unquoted value with a comma inside: ${shape}`, async () => {
      await expectRejected(text, "credential");
    });
  }

  const nestedInQuotes: Record<string, string> = {
    "an API key inside a quoted command": join(
      'run "API_',
      "KEY=",
      "Xk9q2LmT7vR4wZp8abC6q",
      ' ./start"',
    ),
    "an exported token inside a quoted value": join(
      "cmd='export TOK",
      "EN=",
      "ab12cd34ef56ab12cd34ef56ab12cd34",
      "'",
    ),
    // The whole quoted value is lowercase, so only a scan inside the quotes can find the secret.
    "a lowercase key in a quoted option": join(
      'opts="--env api_',
      "key=",
      "ab12cd34ef56ab12cd34ef56ab12cd34",
      ' ./start"',
    ),
    "a lowercase token two quotes deep": join(
      `run="sh -c 'export tok`,
      "en=",
      "ab12cd34ef56ab12cd34ef56ab12cd34",
      `'"`,
    ),
    "a lowercase token in a quoted script": join(
      "cmd='export tok",
      "en=",
      "ab12cd34ef56ab12cd34ef56ab12cd34",
      " && run'",
    ),
  };

  for (const [shape, text] of Object.entries(nestedInQuotes)) {
    test(`rejects an assignment nested in a quoted value: ${shape}`, async () => {
      await expectRejected(text, "credential");
    });
  }

  test("quoted commands and prose without secrets are accepted", async () => {
    await expectAccepted('Build with cmd="npm run build" in CI.');
    await expectAccepted("Log msg='a=1 is fine' when the flag is off.");
    await expectAccepted('Leave "password": "see the team vault" in the template.');
  });

  test("comma-separated ordinary values and sentence punctuation are accepted", async () => {
    await expectAccepted('Defaults are {"port": 8080, "mode": "fast"}.');
    await expectAccepted("Use a=1, b=2 in the example.");
    await expectAccepted("Label it tags=x,y,z for the filter.");
    await expectAccepted("Read password=$DB_PASSWORD.");
    await expectAccepted('Leave "password": "see the team vault" in the template.');
  });

  test("ordinary quoted configuration is accepted", async () => {
    await expectAccepted('The service config is {"port": 8080}.');
    await expectAccepted('Set "mode": "fast" for local runs.');
    await expectAccepted('package.json has {"name": "relembra", "type": "module"}.');
  });

  const bareTokens: Record<string, string> = {
    "GitHub token": join("gh", "p_", filler(36, BASE62)),
    "GitHub fine-grained token": join(
      "github",
      "_pat_",
      filler(22, BASE62),
      "_",
      filler(59, BASE62),
    ),
    "GitLab token": join("gl", "pat-", filler(20, BASE62)),
    "OpenAI-style key": join("s", "k-", filler(32, BASE62)),
    "Stripe secret key": join("s", "k_live_", filler(24, BASE62)),
    "AWS access key id": join("AK", "IA", filler(16, UPPER_DIGITS)),
    "Slack token": join("xo", "xb-", "1234567890-", filler(24, BASE62)),
    "Google API key": join("AI", "za", filler(35, BASE62)),
    "npm token": join("np", "m_", filler(36, BASE62)),
    "Hugging Face token": join("h", "f_", filler(34, BASE62)),
    JWT: join("ey", "JhbGciOiJIUzI1NiJ9.", "ey", "JzdWIiOiIxMjM0In0.", filler(43, BASE62)),
    "bearer token": join("Bear", "er ", filler(40, BASE62)),
  };
  const wrappers: Record<string, (token: string) => string> = {
    bare: (token) => `see ${token} here`,
    underscores: (token) => `see _${token}_ here`,
    asterisks: (token) => `see *${token}* here`,
    "double asterisks": (token) => `see **${token}** here`,
    "double underscores": (token) => `see __${token}__ here`,
    parentheses: (token) => `see (${token}) here`,
    backticks: (token) => `see \`${token}\` here`,
  };

  for (const [shape, token] of Object.entries(bareTokens)) {
    test(`rejects ${shape} bare and wrapped in Markdown or punctuation`, async () => {
      for (const wrap of Object.values(wrappers)) await expectRejected(wrap(token), "credential");
    });
  }

  test("ordinary facts that mention credentials or hold low-entropy values are accepted", async () => {
    await expectAccepted("Password rotation runs monthly; the token budget is 9500 bytes.");
    await expectAccepted("Set NODE_ENV=production before the release build.");
    await expectAccepted("The password is in the team vault, never in the repo.");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${VAR}` is the point.
    await expectAccepted("DB_PASSWORD=${DB_PASSWORD} comes from the environment.");
    await expectAccepted("Run id=550e8400-e29b-41d4-a716-446655440000 reproduced the bug.");
    await expectAccepted(
      "sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 is the empty file.",
    );
    await expectAccepted("Keys created in the dashboard start with sk- and expire yearly.");
  });

  test("a reference whose name is made of words is accepted, whatever its case", async () => {
    await expectAccepted("password=$DbPassword2 is read at boot.");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${VAR}` is the point.
    await expectAccepted("token=${ApiToken} is injected by CI.");
    await expectAccepted("secret=%AppData% on Windows hosts.");
    await expectAccepted("key=<your-key> goes in the local config.");
  });

  test("a value that is wholly a reference to a secret is accepted", async () => {
    await expectAccepted("password=$DB_PASSWORD is read at boot.");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${VAR}` is the point.
    await expectAccepted("token=${API_TOKEN} is injected by CI.");
    await expectAccepted("key=<your-key> goes in the local config.");
    await expectAccepted("x={{ secrets.TOKEN }} in the workflow file.");
  });
});
