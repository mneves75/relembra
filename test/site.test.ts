/**
 * The landing page in site/: the browser bundle of the library it runs, the two Node modules that
 * bundle replaces, and the page's own invariants (both languages, same-origin assets, anchors, CSP).
 *
 * Ways it can fail, each pinned below:
 * - the SHA-256 or deep-equal stand-in disagrees with Node, so the page runs a different library;
 * - site/assets/relembra.js is stale: src changed and `bun run build:site` was not run;
 * - the bundle needs a Node global or module, or is an ES module that file:// pages cannot load;
 * - a text exists in one language only, so the other language shows a hole;
 * - an asset is fetched from another origin or from an absolute path, which breaks the Content
 *   Security Policy or the GitHub Pages subpath;
 * - an in-page link points at an id that does not exist;
 * - an inline script is not covered by the CSP hash, so the browser blocks it;
 * - a personal project or a private name reaches the public page.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import { buildSiteBundle } from "../scripts/site/build.js";
import { createHash as siteCreateHash } from "../scripts/site/crypto.js";
import { isDeepStrictEqual as siteDeepEqual } from "../scripts/site/util.js";

const root = join(import.meta.dir, "..");
const site = join(root, "site");
const html = readFileSync(join(site, "index.html"), "utf8");

describe("site: the SHA-256 stand-in", () => {
  const node = (input: string | Uint8Array) =>
    createHash("sha256")
      .update(input as never)
      .digest("hex");
  const ours = (input: string | Uint8Array) =>
    typeof input === "string"
      ? siteCreateHash("sha256").update(input, "utf8").digest("hex")
      : siteCreateHash("sha256").update(input).digest("hex");

  test("matches node:crypto on every length around the block and padding edges", () => {
    for (let length = 0; length <= 200; length++) {
      const text = "a".repeat(length);
      expect(ours(text)).toBe(node(text));
    }
  });

  test("matches node:crypto on multi-byte text, a lone surrogate and bytes", () => {
    const inputs = [
      "As migrações rodam com `bun run migrate`, nunca na mão.",
      "😀👍🏽 ação ✓ 中文",
      "\ud800 alone",
      JSON.stringify([1, "note", "projeto-a", "agente-a", "Testes precisam de TZ=UTC.", false]),
    ];
    for (const input of inputs) expect(ours(input)).toBe(node(input));
    const bytes = new Uint8Array(300).map((_, i) => (i * 37) % 256);
    expect(ours(bytes)).toBe(node(bytes));
  });

  test("refuses what the library never asks for", () => {
    expect(() => siteCreateHash("md5")).toThrow();
    expect(() =>
      siteCreateHash("sha256")
        .update("x")
        .digest("base64" as "hex"),
    ).toThrow();
  });
});

describe("site: the deep-equal stand-in", () => {
  const memory = {
    id: "m1",
    scope: "projeto-a",
    seq: 3,
    pinned: false,
    notedAt: 1,
    revision: { number: 1, text: "x", at: 1, provenance: { agent: "a", trust: "agent" } },
    status: "live",
  };
  const pairs: [unknown, unknown][] = [
    [memory, structuredClone(memory)],
    [memory, { ...memory, revision: { ...memory.revision, text: "y" } }],
    [memory, { ...memory, supersededBy: undefined }],
    [
      { a: 1, b: 2 },
      { b: 2, a: 1 },
    ],
    [Number.NaN, Number.NaN],
    [0, -0],
    // a hole is not an undefined element
    [[1, undefined, 3], Object.assign(new Array(3), { 0: 1, 2: 3 })],
    [[1, 2], { 0: 1, 1: 2 }],
    [null, {}],
    [{ a: [1, { b: null }] }, { a: [1, { b: null }] }],
    [{ a: [1, { b: null }] }, { a: [1, { b: undefined }] }],
    ["1", 1],
    [Object.create(null), {}],
  ];
  test("agrees with node:util on every pair", () => {
    for (const [a, b] of pairs) expect(siteDeepEqual(a, b)).toBe(isDeepStrictEqual(a, b));
  });

  test("refuses types the library never compares", () => {
    expect(() => siteDeepEqual(new Map(), new Map())).toThrow();
    expect(() => siteDeepEqual(new Date(0), new Date(0))).toThrow();
  });
});

describe("site: the browser bundle", () => {
  test("site/assets/relembra.js is a fresh build of src (run `bun run build:site`)", async () => {
    const committed = readFileSync(join(site, "assets", "relembra.js"), "utf8");
    expect(committed === (await buildSiteBundle())).toBe(true);
  });

  test("is a classic script with no module syntax and no Node module", async () => {
    const bundle = await buildSiteBundle();
    expect(bundle).not.toMatch(/\bnode:[a-z]/);
    expect(bundle).not.toMatch(/^\s*(import|export)\b/m);
    expect(bundle).not.toMatch(/\brequire\(/);
  });

  test("runs the library with browser globals only", async () => {
    const bundle = await buildSiteBundle();
    // The globals a browser has and a bare JavaScript realm lacks; nothing from Node.
    const sandbox: { relembraDemo?: unknown; [global: string]: unknown } = {
      TextEncoder,
      TextDecoder,
      structuredClone,
      crypto: { randomUUID: () => crypto.randomUUID() },
    };
    runInNewContext(bundle, sandbox);
    const lib = sandbox.relembraDemo as typeof import("../scripts/site/entry.js").demo;
    expect(lib).toBeDefined();

    const scopes = ["projeto-a", "projeto-b", "global"];
    const principals = {
      owner: { id: "dono", readable: scopes, writable: scopes, promotable: [], owned: scopes },
      a: {
        id: "agente-a",
        readable: ["projeto-a", "global"],
        writable: ["projeto-a"],
        promotable: [],
      },
      b: {
        id: "agente-b",
        readable: ["projeto-b", "global"],
        writable: ["projeto-b"],
        promotable: [],
      },
    };
    type Who = keyof typeof principals;
    const memory = lib.createRelembra<Who>({
      store: lib.createMemoryStore(),
      policy: (who) => principals[who],
    });
    const provenance = { agent: "demo", harness: "site", model: "none", host: "browser" };
    const note = (who: Who, scope: string, text: string, opId?: string) =>
      memory.note(who, { scope, text, provenance, ...(opId === undefined ? {} : { opId }) });

    const first = await note("a", "projeto-a", "Os testes precisam de TZ=UTC.", "op-1");
    const retry = await note("a", "projeto-a", "Os testes precisam de TZ=UTC.", "op-1");
    expect(retry.id).toBe(first.id);
    expect(retry.notedAt).toBe(first.notedAt);
    expect(note("a", "projeto-a", "Outro texto.", "op-1")).rejects.toMatchObject({
      name: "OpConflictError",
    });

    const secret = ["pass", "word=", "hunter2-example"].join("");
    expect(note("a", "projeto-a", secret)).rejects.toMatchObject({ rule: "credential" });
    expect(lib.findGuardViolation("linha um\nlinha dois", lib.MAX_MEMORY_BYTES)).toBe("multi-line");
    expect(note("a", "projeto-b", "Escrita fora do escopo.")).rejects.toMatchObject({
      name: "ScopeDeniedError",
    });

    await note("b", "projeto-b", "O app iOS precisa do Xcode 27.");
    expect((await memory.find("b", { query: "TZ" })).length).toBe(0);
    expect((await memory.find("a", { query: "TZ" }))[0]?.memory.id).toBe(first.id);

    const wake = await memory.wake("a", { scope: "projeto-a", budgetBytes: 9500 });
    expect(wake.text).toContain("Os testes precisam de TZ=UTC.");
    expect(new TextEncoder().encode(wake.text).length).toBeLessThanOrEqual(9500);

    await memory.redact("owner", { memoryId: first.id });
    const after = await memory.wake("a", { scope: "projeto-a" });
    expect(after.text).not.toContain("TZ=UTC");
  });
});

/** Elements in document order, with their attributes and the path of open parents. */
async function elements(source: string) {
  const found: { tag: string; attrs: Map<string, string>; parent: number; index: number }[] = [];
  const stack: number[] = [];
  // the HTML void elements the page uses, plus the SVG shapes it writes without a closing tag
  const voids = new Set([
    "meta",
    "link",
    "img",
    "input",
    "br",
    "hr",
    "source",
    "track",
    "path",
    "rect",
  ]);
  let index = 0;
  const rewriter = new HTMLRewriter().on("*", {
    element(element) {
      const me = index++;
      found.push({
        tag: element.tagName,
        attrs: new Map(element.attributes),
        parent: stack.at(-1) ?? -1,
        index: me,
      });
      if (voids.has(element.tagName) || element.selfClosing) return;
      stack.push(me);
      element.onEndTag(() => {
        stack.pop();
      });
    },
  });
  await rewriter.transform(new Response(source)).text();
  return found;
}

describe("site: the page", () => {
  test("every text has both languages, as adjacent pt-BR and en siblings", async () => {
    const all = await elements(html);
    const byParent = new Map<number, string[]>();
    for (const el of all) {
      const lang = el.attrs.get("lang");
      if (el.tag === "html" || (lang !== "pt-BR" && lang !== "en")) continue;
      byParent.set(el.parent, [...(byParent.get(el.parent) ?? []), lang]);
    }
    expect(byParent.size).toBeGreaterThan(50);
    const unpaired = [...byParent].filter(
      ([, langs]) =>
        langs.length % 2 !== 0 || langs.some((l, i) => l !== (i % 2 === 0 ? "pt-BR" : "en")),
    );
    expect(unpaired.map(([parent]) => all[parent]?.attrs.get("id") ?? all[parent]?.tag)).toEqual(
      [],
    );
  });

  test("loads every asset from its own folder, by relative path", async () => {
    const all = await elements(html);
    const loads = all.flatMap((el) => {
      if (el.tag === "a") return [];
      return ["src", "href", "poster"].flatMap((name) => el.attrs.get(name) ?? []);
    });
    expect(loads.length).toBeGreaterThan(3);
    expect(loads.filter((url) => /^([a-z]+:|\/)/i.test(url))).toEqual([]);
    const css = readFileSync(join(site, "assets", "site.css"), "utf8");
    expect([...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1])).not.toContainEqual(
      expect.stringMatching(/^([a-z]+:|\/)/i),
    );
    expect(css).not.toMatch(/@import/);
  });

  test("every in-page link has a target", async () => {
    const all = await elements(html);
    const ids = new Set(all.flatMap((el) => el.attrs.get("id") ?? []));
    const targets = all.flatMap((el) => {
      const href = el.attrs.get("href");
      return href?.startsWith("#") && href.length > 1 ? [href.slice(1)] : [];
    });
    expect(targets.length).toBeGreaterThan(5);
    expect(targets.filter((id) => !ids.has(id))).toEqual([]);
  });

  test("the Content Security Policy allows exactly the inline scripts the page has", () => {
    const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
    expect(policy).toBeDefined();
    expect(policy).toContain("default-src 'self'");
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
    expect(inline.length).toBeGreaterThan(0);
    for (const code of inline) {
      const hash = createHash("sha256").update(code, "utf8").digest("base64");
      expect(policy).toContain(`'sha256-${hash}'`);
    }
    expect(policy).not.toContain("unsafe-inline");
  });

  test("names no personal project and no private deployment", () => {
    // The words are kept as SHA-256 digests of their lowercase form, so this file names none of
    // them; every window of each length is hashed, so a word inside a longer one is found too.
    const forbidden = new Set([
      "8ca3e7efe0956df3a6f92163bf77e33bf17086335245fab9fde857dd29c717f9",
      "fb38a93fd89e1a5fc7852a5d7109e321d23a721a1899292273ac5a21dc4db378",
    ]);
    const lengths = [6];
    const found = (text: string) => {
      const lower = text.toLowerCase();
      const hits = new Set<string>();
      for (const length of lengths) {
        for (let at = 0; at + length <= lower.length; at++) {
          const word = lower.slice(at, at + length);
          if (forbidden.has(createHash("sha256").update(word).digest("hex"))) hits.add(word);
        }
      }
      return [...hits];
    };
    // positive control: a planted word is found inside a longer one, whatever its case
    expect(found("Imported from the XOptMemY log.")).toEqual(["optmem"]);
    const files = readdirSync(site, { recursive: true, encoding: "utf8" }).filter((f) =>
      /\.(html|css|js|txt|svg|vtt)$/.test(f),
    );
    // positive control: the scan reads the page, its script and security.txt
    expect(files).toEqual(
      expect.arrayContaining([
        "index.html",
        join("assets", "site.js"),
        join(".well-known", "security.txt"),
      ]),
    );
    for (const file of files) {
      expect({ file, found: found(readFileSync(join(site, file), "utf8")) }).toEqual({
        file,
        found: [],
      });
    }
  });

  test("every version the page states is the one package.json publishes", () => {
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const stated = [
      ...html.matchAll(/\b(?:[Vv]ersão|[Vv]ersion) (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]*[0-9A-Za-z])?)/g),
    ].map((m) => m[1]);
    // Rewritten for the 2026-11 redesign, whose install line adds a mention: the exact count was
    // incidental; what matters is at least one mention (scripts/deploy.sh needs it) and all equal.
    expect(stated.length).toBeGreaterThanOrEqual(1);
    expect(new Set(stated)).toEqual(new Set([version]));
  });

  test("demo email addresses use domains reserved for documentation", () => {
    const js = readFileSync(join(site, "assets", "site.js"), "utf8");
    const domains = [...`${html}\n${js}`.matchAll(/[\w.+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map(
      (m) => m[1]?.toLowerCase(),
    );
    // positive control: the redaction demo has addresses in both languages
    expect(domains.length).toBeGreaterThanOrEqual(4);
    expect(
      domains.filter((d) => !/^example\.(com|org|net)$|\.(example|invalid|test)$/.test(d ?? "")),
    ).toEqual([]);
  });

  test("security.txt names the reporting channel, an expiry and its own URL (RFC 9116)", () => {
    const text = readFileSync(join(site, ".well-known", "security.txt"), "utf8");
    const fields = new Map(
      text
        .split("\n")
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => [
          line.slice(0, line.indexOf(":")),
          line.slice(line.indexOf(":") + 1).trim(),
        ]),
    );
    expect(fields.get("Contact")).toBe(
      "https://github.com/mneves75/relembra/security/advisories/new",
    );
    expect(fields.get("Policy")).toBe("https://github.com/mneves75/relembra/security/policy");
    expect(fields.get("Canonical")).toBe(
      "https://mneves75.github.io/relembra/.well-known/security.txt",
    );
    const expires = fields.get("Expires") ?? "";
    expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Number.isNaN(Date.parse(expires))).toBe(false);
  });

  // Rewritten for the 2026-11 redesign: the page is dark only, with no theme or motion toggle, so
  // the bootstrap sets the language and nothing else.
  test("theme and motion: the bootstrap sets neither, and the page has no toggle for them", async () => {
    const boot = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    // positive control: the bootstrap exists and still sets the language
    expect(boot).toContain("d.lang=l");
    const attrs = new Map<string, string>();
    const element = {
      classList: { add() {} },
      lang: "",
      setAttribute: (name: string, value: string) => attrs.set(name, value),
    };
    runInNewContext(boot, {
      document: { documentElement: element },
      localStorage: { getItem: () => "dark" },
      matchMedia: () => ({ matches: true }),
      navigator: { language: "pt-BR" },
    });
    expect(element.lang).toBe("pt-BR");
    expect([...attrs.keys()]).toEqual([]);
    const all = await elements(html);
    // positive control: the language switch is found by the same scan
    expect(all.filter((el) => el.attrs.has("data-set-lang")).length).toBe(2);
    expect(
      all.filter(
        (el) => ["theme"].includes(el.attrs.get("id") ?? "") || el.attrs.has("data-motion-toggle"),
      ),
    ).toEqual([]);
  });

  test("language: ?lang= in the link wins, then a saved choice, then the browser", () => {
    const boot = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    const langFor = (search: string, stored: string | null, browser: string) => {
      const element = { classList: { add() {} }, lang: "", setAttribute() {} };
      runInNewContext(boot, {
        document: { documentElement: element },
        localStorage: { getItem: (key: string) => (key === "relembra-lang" ? stored : null) },
        matchMedia: () => ({ matches: false }),
        navigator: { language: browser },
        location: { search },
        URLSearchParams,
      });
      return element.lang;
    };
    // positive control: without a parameter the browser and the saved choice decide, as before
    expect(langFor("", null, "pt-BR")).toBe("pt-BR");
    expect(langFor("", null, "en-US")).toBe("en");
    expect(langFor("", "en", "pt-BR")).toBe("en");
    // a shared link names its language, whatever the browser or an earlier visit chose
    expect(langFor("?lang=en", "pt-BR", "pt-BR")).toBe("en");
    expect(langFor("?lang=pt-BR", "en", "en-US")).toBe("pt-BR");
    // anything else in the parameter is ignored
    expect(langFor("?lang=fr", null, "pt-BR")).toBe("pt-BR");
    expect(langFor("?lang=<b>", "en", "pt-BR")).toBe("en");
  });

  // Rewritten for the 2026-11 redesign: the motion toggles are gone, so the stylesheet must honour
  // the system's reduced-motion preference itself, with every transition behind it.
  test("motion: every transition and animation sits behind prefers-reduced-motion", () => {
    const css = readFileSync(join(site, "assets", "site.css"), "utf8");
    const js = readFileSync(join(site, "assets", "site.js"), "utf8");
    const gate = "@media (prefers-reduced-motion: no-preference) {";
    // positive control: the gate exists and holds transitions
    const at = css.indexOf(gate);
    expect(at).toBeGreaterThan(-1);
    const outside = css.slice(0, at);
    expect(css.slice(at)).toMatch(/\btransition\s*:/);
    // nothing moves before the gate, and nothing keys on the old attribute
    expect(outside).not.toMatch(/\b(transition|animation)\s*:/);
    expect(`${html}\n${css}\n${js}`).not.toContain("data-motion");
  });

  test("table parts keep explicit roles, since phone CSS changes their display", async () => {
    // Safari with VoiceOver drops table semantics from a table element whose display CSS changes;
    // the roles in the markup restore them.
    const expected: Record<string, string> = {
      table: "table",
      thead: "rowgroup",
      tbody: "rowgroup",
      tr: "row",
      td: "cell",
    };
    const all = await elements(html);
    const parts = all.filter((el) => el.tag in expected || el.tag === "th");
    // positive control: the proof table and its 27 data rows are found
    expect(parts.filter((el) => el.tag === "tr").length).toBe(29);
    const wrong = parts.filter((el) => {
      const role = el.attrs.get("role");
      if (el.tag !== "th") return role !== expected[el.tag];
      return role !== (el.attrs.get("scope") === "col" ? "columnheader" : "rowheader");
    });
    expect(wrong.map((el) => el.tag)).toEqual([]);
  });

  test("explains plainly without naming the method it borrows", () => {
    const page = readFileSync(join(site, "index.html"), "utf8");
    // Rewritten for the 2026-11 redesign, which dropped the explain__lead chapter: the positive
    // control is now the "how it works" section this rule guards.
    expect(page).toContain('id="como"');
    expect(page.match(/[^<>]{0,40}feynman[^<>]{0,40}/gi)).toBeNull();
  });
});
