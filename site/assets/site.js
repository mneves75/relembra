/*
 * relembra landing page: the language switch and the demos. Every demo calls the real library from
 * assets/relembra.js (built from src/ by scripts/site/build.ts) in an in-memory store that lives
 * only in this tab. Nothing is sent anywhere.
 */
(() => {
  // biome-ignore lint/suspicious/noRedundantUseStrict: a classic script, not a module
  "use strict";

  const doc = document;
  const root = doc.documentElement;
  const lib = window.relembraDemo;
  const encoder = new TextEncoder();
  const $ = (selector, scope = doc) => scope.querySelector(selector);
  const $$ = (selector, scope = doc) => Array.from(scope.querySelectorAll(selector));
  const lang = () => (root.lang === "en" ? "en" : "pt-BR");
  const byteLength = (text) => encoder.encode(text).length;
  const MAX = 280;
  const MONDAY = Date.parse("2026-10-26T12:00:00Z");

  function el(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const shortId = (id) => `${id.slice(0, 8)}…`;
  // Both languages take the singular for exactly one and the plural otherwise, zero included.
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /* ---------- Words ---------- */

  const secret = ["pass", "word=", "hunter2-example"].join("");

  const COPY = {
    "pt-BR": {
      title: "relembra: seu agente de IA com memória",
      description:
        "relembra é a memória que todos os seus agentes de IA leem ao começar a sessão: um fato por linha, separado por projeto, apagável de verdade e medido. Código MIT, zero dependências.",
      scopes: { a: "projeto-a", b: "projeto-b", g: "global" },
      seed: {
        pin: "Nunca rode migração em produção sem backup.",
        port: "A API escuta na porta 8080 em desenvolvimento.",
        tz: "Os testes precisam de TZ=UTC ou a suíte de datas quebra.",
        db: "O banco local sobe com docker compose up db.",
        lint: "O lint roda no pre-commit; não use --no-verify.",
        summary: "Ambiente de dev: API na 8080 e testes com TZ=UTC.",
        deploy: "O deploy de sexta só sai depois das 14h.",
        mig: "As migrações rodam com bun run migrate, nunca na mão.",
        global: "Responda sempre em português do Brasil.",
        b1: "O app iOS precisa do Xcode 27.",
        b2: "O deploy do app iOS sai pela TestFlight às quintas.",
      },
      host: "navegador",
      fact: "Os testes precisam de TZ=UTC",
      examples: {
        ok: "O Redis local escuta na 6380, não na 6379",
        secret: `A senha do staging é ${secret}`,
        invisible: "Os testes precisam​ de TZ=UTC",
      },
      accepted: "A guarda aceita",
      refused: "Recusado",
      rules: {
        blank: "Vazio não é fato.",
        "too-long": "Passou de 280 bytes. Um fato por linha.",
        "ill-formed": "Tem um caractere quebrado no meio do texto.",
        "multi-line": "Tem quebra de linha. Um fato, uma linha.",
        "bidi-character": "Tem um caractere que inverte a direção do texto.",
        "zero-width-character": "Tem um caractere invisível de largura zero.",
        "control-character": "Tem um caractere de controle, como um tab.",
        "format-character": "Tem um caractere de formatação invisível.",
        "invisible-character": "Tem um caractere invisível.",
        credential: "Tem cara de senha ou chave; a guarda não repete o texto.",
      },
      notRendered: "Nada é gravado, e a recusa nunca repete o texto.",
      saved: (id) => `Guardado no projeto A como ${shortId(id)}. Já está no wake de terça, abaixo.`,
      saveRefused: (rule) => `A guarda recusou (${rule}). Nada foi gravado.`,
      copied: "Copiado",
      selected: "Selecionado",
      keyYes: "tem a chave",
      keyNo: "sem chave",
      noHits: "nada encontrado",
      found: (n, query) =>
        n === 0
          ? `Nada para “${query}” nas gavetas que ele abre.`
          : `${plural(n, "resultado", "resultados")} para “${query}”, só das gavetas que ele abre.`,
      typeToSearch: "Digite uma palavra para buscar.",
      peekDenied: (scope, access) =>
        `Recusado: ScopeDeniedError (${access === "read" ? "leitura" : access}). Sem a chave da gaveta ${scope}, a busca nem olha lá dentro.`,
      peekAllowed: "Permitido. Este agente tem a chave.",
      budget: (n) => `${n} bytes`,
      kinds: { pinned: "fixada", recent: "recente", summary: "resumo", covered: "coberta" },
      how: { full: "inteira", index: "só o id", out: "fora" },
      wakeSum: (full, index, out, used, budget) =>
        `${plural(full, "inteira", "inteiras")}, ${index} só pelo id, ${out} de fora. Usou ${used} de ${budget} bytes.`,
      erase: {
        pii: "O e-mail pessoal da diretora é ana@example.com.",
        other: "A diretora aprova os deploys de sexta.",
        summary: "A diretora (ana@example.com) aprova os deploys de sexta.",
        chat: "conversa-segunda",
      },
      rowKind: { original: "original", summary: "resumo", copy: "cópia promovida" },
      rowState: {
        live: "viva: os agentes leem",
        retracted: "retirada: só o dono vê",
        redacted: "tarjada",
      },
      tombstone: (seq) => `lápide · seq ${seq}`,
      received: (n) => `recebeu ${plural(n, "texto", "textos")}`,
      kindName: { conversation: "conversa", mcp: "cliente MCP" },
      status: {
        received: "recebeu",
        pending: "pendente",
        acknowledged: "reconhecido",
        unsupported: "sem suporte",
      },
      retracted:
        "Retirada. O original e o resumo saíram do alcance dos agentes, mas a cópia promovida para global continua viva, com o e-mail. Retirar não basta: tarje.",
      redacted: (n) =>
        `Tarjada em ${plural(n, "lugar", "lugares")}: original, resumo e cópia promovida viraram lápide. Quem já tinha o texto ficou pendente.`,
      delivered: (d) =>
        `O host avisou os portadores: ${plural(d.acknowledged, "reconhecido", "reconhecidos")}, ${d.unsupported} sem suporte para apagar, ${plural(d.pending, "pendente", "pendentes")}. O relembra registra a resposta e nunca diz “apagado”.`,
    },
    en: {
      title: "relembra: memory for your AI agents",
      description:
        "relembra is the memory every AI agent you run reads at session start: one fact per line, scoped per project, erasable for real, and measured. MIT code, zero dependencies.",
      scopes: { a: "project-a", b: "project-b", g: "global" },
      seed: {
        pin: "Never run a production migration without a backup.",
        port: "The API listens on port 8080 in development.",
        tz: "Tests need TZ=UTC or the date suite breaks.",
        db: "The local database starts with docker compose up db.",
        lint: "Lint runs on pre-commit; never use --no-verify.",
        summary: "Dev setup: API on 8080, tests with TZ=UTC.",
        deploy: "The Friday deploy goes out after 2 p.m. only.",
        mig: "Migrations run with bun run migrate, never by hand.",
        global: "Always answer in plain English.",
        b1: "The iOS app needs Xcode 27.",
        b2: "The iOS app deploy goes through TestFlight on Thursdays.",
      },
      host: "browser",
      fact: "Tests need TZ=UTC",
      examples: {
        ok: "Local Redis listens on 6380, not 6379",
        secret: `The staging password is ${secret}`,
        invisible: "Tests need​ TZ=UTC",
      },
      accepted: "The guard accepts it",
      refused: "Refused",
      rules: {
        blank: "Empty isn't a fact.",
        "too-long": "Over 280 bytes. One fact per line.",
        "ill-formed": "There's a broken character in the middle of it.",
        "multi-line": "It has a line break. One fact, one line.",
        "bidi-character": "It has a character that flips text direction.",
        "zero-width-character": "It has a zero-width character.",
        "control-character": "It has a control character, like a tab.",
        "format-character": "It has an invisible formatting character.",
        "invisible-character": "It has an invisible character.",
        credential: "It looks like a password or a key; the guard never echoes it.",
      },
      notRendered: "Nothing is stored, and the refusal never echoes the text.",
      saved: (id) => `Saved to project A as ${shortId(id)}. It's in Tuesday's wake, below.`,
      saveRefused: (rule) => `The guard refused it (${rule}). Nothing was stored.`,
      copied: "Copied",
      selected: "Selected",
      keyYes: "has the key",
      keyNo: "no key",
      noHits: "nothing found",
      found: (n, query) =>
        n === 0
          ? `Nothing for “${query}” in the drawers it can open.`
          : `${plural(n, "result", "results")} for “${query}”, only from drawers it can open.`,
      typeToSearch: "Type a word to search.",
      peekDenied: (scope, access) =>
        `Refused: ScopeDeniedError (${access}). With no key to drawer ${scope}, the search never looks inside.`,
      peekAllowed: "Allowed. This agent has the key.",
      budget: (n) => `${n} bytes`,
      kinds: { pinned: "pinned", recent: "recent", summary: "summary", covered: "covered" },
      how: { full: "whole", index: "id only", out: "left out" },
      wakeSum: (full, index, out, used, budget) =>
        `${full} whole, ${index} by id only, ${out} left out. Used ${used} of ${budget} bytes.`,
      erase: {
        pii: "The director's personal email is ana@example.com.",
        other: "The director signs off Friday deploys.",
        summary: "The director (ana@example.com) signs off Friday deploys.",
        chat: "monday-chat",
      },
      rowKind: { original: "original", summary: "summary", copy: "promoted copy" },
      rowState: {
        live: "live: agents read it",
        retracted: "retracted: only the owner sees it",
        redacted: "redacted",
      },
      tombstone: (seq) => `tombstone · seq ${seq}`,
      received: (n) => `received ${plural(n, "text", "texts")}`,
      kindName: { conversation: "conversation", mcp: "MCP client" },
      status: {
        received: "received",
        pending: "pending",
        acknowledged: "acknowledged",
        unsupported: "unsupported",
      },
      retracted:
        "Retracted. The original and its summary are out of every agent's reach, but the copy promoted to global is still live, email and all. Retracting isn't enough: redact.",
      redacted: (n) =>
        `Redacted in ${plural(n, "place", "places")}: original, summary and promoted copy are tombstones now. Whoever already had the text is pending.`,
      delivered: (d) =>
        `The host told the carriers: ${d.acknowledged} acknowledged, ${d.unsupported} unsupported (can't erase), ${d.pending} pending. relembra records each answer and never says “erased”.`,
    },
  };
  const t = () => COPY[lang()];

  /* ---------- Language ---------- */

  function applyLabels() {
    const key = lang() === "en" ? "labelEn" : "labelPt";
    for (const node of $$("[data-label-pt]")) node.setAttribute("aria-label", node.dataset[key]);
    for (const button of $$("[data-set-lang]")) {
      button.setAttribute("aria-pressed", String(button.dataset.setLang === lang()));
    }
    doc.title = t().title;
    $('meta[name="description"]')?.setAttribute("content", t().description);
    // The film is narrated in Portuguese: English readers get English captions on by default.
    for (const track of $(".film")?.textTracks ?? []) {
      track.mode = lang() === "en" && track.language === "en" ? "showing" : "disabled";
    }
  }

  for (const button of $$("[data-set-lang]")) {
    button.addEventListener("click", () => {
      const next = button.dataset.setLang;
      if (next === lang()) return;
      const before = t();
      root.lang = next;
      try {
        window.localStorage.setItem("relembra-lang", next);
      } catch {
        // Storage can be blocked; the choice then lasts for this visit only.
      }
      // ?lang= outranks storage on load, so a stale one would undo this choice on reload.
      const url = new URL(window.location.href);
      if (url.searchParams.has("lang")) {
        url.searchParams.set("lang", next);
        window.history.replaceState(window.history.state, "", url);
      }
      applyLabels();
      if (lib) switchWorlds(before);
    });
  }

  applyLabels();

  /* ---------- Copy buttons ---------- */

  for (const button of $$("[data-copy]")) {
    // Captured once: a second click while "Copied" shows must not save that as the label.
    const original = Array.from(button.childNodes);
    let resetTimer = 0;
    button.addEventListener("click", async () => {
      const sources = $$("[data-copy-source]", button.parentElement);
      const source = sources.find((node) => !node.lang || node.lang === lang());
      if (!source) return;
      let label = t().copied;
      try {
        await navigator.clipboard.writeText(source.textContent);
      } catch {
        const range = doc.createRange();
        range.selectNodeContents(source);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        label = t().selected;
      }
      button.textContent = label;
      button.classList.add("is-done");
      window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => {
        button.replaceChildren(...original);
        button.classList.remove("is-done");
      }, 1600);
    });
  }

  if (!lib) return;

  /* ---------- The library worlds ---------- */

  function principals(scopes) {
    const all = [scopes.a, scopes.b, scopes.g];
    return {
      owner: {
        id: "owner",
        readable: all,
        writable: all,
        promotable: all,
        pinnable: all,
        owned: all,
        trustCeiling: "owner",
      },
      a: { id: "agent-a", readable: [scopes.a, scopes.g], writable: [scopes.a], promotable: [] },
      b: { id: "agent-b", readable: [scopes.b, scopes.g], writable: [scopes.b], promotable: [] },
    };
  }

  /** A relembra instance over a fresh in-memory store, with a clock that starts on Monday. */
  function makeMemory() {
    const scopes = t().scopes;
    const policy = principals(scopes);
    let clock = MONDAY;
    const memory = lib.createRelembra({
      store: lib.createMemoryStore(),
      policy: (who) => policy[who],
      clock: {
        now() {
          clock += 60_000;
          return clock;
        },
      },
    });
    const provenance = { agent: "agent", harness: "claude-code", model: "demo", host: t().host };
    const note = (who, scope, text, extra = {}) =>
      memory.note(who, { scope, text, provenance, ...extra });
    return { memory, scopes, policy, provenance, note };
  }

  const savedTexts = [];
  let world = null;
  let gen = 0;

  async function buildMain() {
    const base = makeMemory();
    const { scopes, note, memory, provenance } = base;
    const seed = t().seed;
    const owner = { ...provenance, trust: "owner" };
    const ids = {};
    ids.pin = (await note("owner", scopes.a, seed.pin, { pinned: true, provenance: owner })).id;
    ids.port = (await note("a", scopes.a, seed.port)).id;
    ids.tz = (await note("a", scopes.a, seed.tz)).id;
    ids.db = (await note("a", scopes.a, seed.db)).id;
    ids.lint = (await note("a", scopes.a, seed.lint)).id;
    ids.summary = (
      await memory.submitSummary("a", {
        scope: scopes.a,
        sources: [
          { memoryId: ids.port, revision: 1 },
          { memoryId: ids.tz, revision: 1 },
        ],
        text: seed.summary,
        provenance,
      })
    ).id;
    ids.deploy = (await note("a", scopes.a, seed.deploy)).id;
    ids.mig = (await note("a", scopes.a, seed.mig)).id;
    ids.global = (await note("owner", scopes.g, seed.global, { provenance: owner })).id;
    ids.b1 = (await note("b", scopes.b, seed.b1)).id;
    ids.b2 = (await note("b", scopes.b, seed.b2)).id;
    for (const text of savedTexts) await note("a", scopes.a, text);
    return { ...base, ids, covered: new Set([ids.port, ids.tz]) };
  }

  function wakeLines(text) {
    return text
      .split("\n")
      .filter((line) => line.startsWith("<memory") || line.startsWith("<index"));
  }

  /** Writes a wake into a code element: frame and attributes dim, the facts bright. */
  function paintWake(code, text) {
    code.replaceChildren();
    for (const [i, line] of text.split("\n").entries()) {
      if (i > 0) code.append("\n");
      const close = line.indexOf(">");
      if (line.startsWith("<memory") && close > 0 && line.endsWith("</memory>")) {
        code.append(
          el("span", "tk-dim", line.slice(0, close + 1)),
          el("span", "tk-text", line.slice(close + 1, -"</memory>".length)),
          el("span", "tk-dim", "</memory>"),
        );
      } else {
        code.append(el("span", "tk-dim", line));
      }
    }
  }

  /* ---------- The instrument: a note measured as you type ---------- */

  const fact = $("#fact");
  const inst = $("[data-inst]");
  const ruler = $("[data-ruler]");
  const verdict = $("#try-verdict");
  const bytesOut = $("[data-bytes]");
  const rendered = $("[data-rendered] code");
  const savedOut = $("[data-saved]");
  let factEdited = false;
  let lastRule = null;
  let trySeq = 0;
  let tryTimer = 0;

  function paintVerdict(rule) {
    const key = `${lang()}:${rule ?? ""}`;
    if (key === lastRule) return;
    lastRule = key;
    verdict.replaceChildren(rule ? t().refused : t().accepted);
    if (rule)
      verdict.append(" ", el("code", "", rule), " ", el("span", "why", t().rules[rule] ?? ""));
  }

  /** Bytes fill the ruler; past half of it the letters condense, from width 100 toward 75. */
  function measure(n) {
    bytesOut.textContent = String(n);
    inst.style.setProperty("--p", String(Math.min(n / MAX, 1)));
    const squeeze = Math.min(Math.max((n - MAX / 2) / (MAX / 2), 0), 1);
    inst.style.setProperty("--wdth", `${100 - 25 * squeeze}%`);
  }

  const saveButton = $("#try-save");

  /** Runs the real guard on the line: ruler, verdict and the save action follow its answer. */
  function guard(text) {
    measure(byteLength(text));
    const rule = lib.findGuardViolation(text, lib.MAX_MEMORY_BYTES);
    ruler.classList.toggle("is-refused", Boolean(rule));
    // aria-disabled, not disabled: the button stays focusable so a keyboard user hears why.
    saveButton?.setAttribute("aria-disabled", String(Boolean(rule)));
    paintVerdict(rule);
    return rule;
  }

  async function renderTry() {
    if (!fact) return;
    const text = fact.value;
    const rule = guard(text);
    const seq = ++trySeq;
    if (rule) {
      rendered.replaceChildren(el("span", "tk-dim", t().notRendered));
      return;
    }
    const fresh = makeMemory();
    await fresh.note("a", fresh.scopes.a, text);
    const wake = await fresh.memory.wake("a", { scope: fresh.scopes.a });
    if (seq !== trySeq) return;
    paintWake(rendered, wakeLines(wake.text)[0] ?? "");
  }

  fact?.addEventListener("input", () => {
    factEdited = true;
    savedOut.textContent = "";
    guard(fact.value);
    window.clearTimeout(tryTimer);
    tryTimer = window.setTimeout(renderTry, 90);
  });

  for (const button of $$("[data-example]")) {
    button.addEventListener("click", () => {
      fact.value = t().examples[button.dataset.example];
      factEdited = true;
      savedOut.textContent = "";
      renderTry();
      fact.focus();
    });
  }

  saveButton?.addEventListener("click", async () => {
    if (!world) return; // the demo store is still being built
    if (saveButton.getAttribute("aria-disabled") === "true") return; // the guard refused the line
    const text = fact.value;
    const g = gen;
    try {
      const memory = await world.note("a", world.scopes.a, text);
      if (g !== gen) return;
      savedTexts.push(text);
      savedOut.textContent = t().saved(memory.id);
      await refreshWorld();
    } catch (error) {
      savedOut.textContent = t().saveRefused(error?.rule ?? error?.name ?? "error");
    }
  });

  /* ---------- Tuesday's session ---------- */

  async function renderSession(g) {
    const wake = await world.memory.wake("a", { budgetBytes: 480 });
    if (g !== gen) return;
    const code = $(".sl--wake code");
    if (code) paintWake(code, wake.text);
    const noted = $("[data-noted-id]");
    if (noted) noted.textContent = world.ids.mig;
  }

  /* ---------- Drawers ---------- */

  const drawers = $("[data-drawers]");
  const findInput = $("[data-find]");
  const findOut = $("[data-find-out]");
  let who = "a";

  async function renderDrawers(g) {
    const { scopes, policy, memory } = world;
    // find() refuses queries over 1,000 characters; the input's maxlength stops typing, this the rest
    const query = findInput.value.trim().slice(0, 1000);
    const results = query ? await memory.find(who, { query }) : [];
    if (g !== gen) return;
    const readable = new Set(policy[who].readable);
    drawers.replaceChildren(
      ...[scopes.a, scopes.b, scopes.g].map((scope) => {
        const open = readable.has(scope);
        const drawer = el("li", `drawer${open ? "" : " is-locked"}`);
        drawer.dataset.scope = scope;
        const head = el("div", "drawer__head");
        head.append(
          el("code", "", scope),
          el("span", "drawer__key", open ? t().keyYes : t().keyNo),
        );
        drawer.append(head);
        if (open && query) {
          const hits = results.filter((result) => result.memory.scope === scope);
          if (hits.length) {
            const list = el("ul", "drawer__hits");
            for (const hit of hits) list.append(el("li", "", hit.memory.revision.text));
            drawer.append(list);
          } else {
            drawer.append(el("p", "drawer__none", t().noHits));
          }
        }
        return drawer;
      }),
    );
    const shown = query.length > 40 ? `${query.slice(0, 40)}…` : query;
    findOut.textContent = query ? t().found(results.length, shown) : t().typeToSearch;
  }

  for (const button of $$("[data-who]")) {
    button.addEventListener("click", () => {
      who = button.dataset.who;
      for (const other of $$("[data-who]")) {
        other.setAttribute("aria-pressed", String(other === button));
      }
      renderDrawers(gen);
    });
  }

  let findTimer = 0;
  findInput?.addEventListener("input", () => {
    window.clearTimeout(findTimer);
    findTimer = window.setTimeout(() => renderDrawers(gen), 90);
  });

  $("[data-peek]")?.addEventListener("click", async () => {
    const other = who === "a" ? world.scopes.b : world.scopes.a;
    try {
      await world.memory.find(who, { query: findInput.value.trim() || "deploy", scope: other });
      findOut.textContent = t().peekAllowed;
    } catch (error) {
      if (error?.name !== "ScopeDeniedError") throw error;
      findOut.textContent = t().peekDenied(other, error.access);
      for (const drawer of $$(".drawer", drawers)) {
        drawer.classList.toggle("is-shaking", drawer.dataset.scope === other);
      }
    }
  });

  /* ---------- The wake budget ---------- */

  const budget = $("[data-budget]");
  const budgetOut = $("[data-budget-out]");
  const wakeList = $("[data-wakelist]");
  const wakeSum = $("[data-wake-sum]");
  const gauge = $("[data-wakebar]")?.parentElement;
  let budgetFrame = 0;

  async function renderWake(g) {
    const bytes = Number(budget.value);
    budgetOut.textContent = t().budget(bytes);
    const { memory, scopes, ids, covered } = world;
    const wake = await memory.wake("a", { scope: scopes.a, budgetBytes: bytes });
    const live = await memory.recall("a", { scope: scopes.a });
    if (g !== gen) return;
    const byId = new Map(live.map((item) => [item.id, item]));
    const kindOf = (id) => {
      if (byId.get(id)?.pinned) return "pinned";
      if (id === ids.summary) return "summary";
      if (covered.has(id)) return "covered";
      return "recent";
    };
    const rows = [];
    const seen = new Set();
    for (const line of wakeLines(wake.text)) {
      const id = /id="([^"]+)"/.exec(line)?.[1];
      if (!id) continue;
      seen.add(id);
      const full = line.startsWith("<memory");
      rows.push({
        id,
        how: full ? "full" : "index",
        text: full ? (byId.get(id)?.revision.text ?? "") : `<index id="${shortId(id)}"/>`,
      });
    }
    for (const item of live) {
      if (!seen.has(item.id)) rows.push({ id: item.id, how: "out", text: item.revision.text });
    }
    wakeList.replaceChildren(
      ...rows.map((row) => {
        const li = el("li", `wl wl--${row.how}`);
        const text = el(row.how === "index" ? "code" : "span", "wl__text", row.text);
        text.title = row.text;
        li.append(el("span", "wl__tag", t().kinds[kindOf(row.id)]), text);
        li.append(el("span", "wl__how", t().how[row.how]));
        return li;
      }),
    );
    const used = byteLength(wake.text);
    gauge?.style.setProperty("--p", String(Math.min(used / bytes, 1)));
    const count = (how) => rows.filter((row) => row.how === how).length;
    wakeSum.textContent = t().wakeSum(count("full"), count("index"), count("out"), used, bytes);
  }

  budget?.addEventListener("input", () => {
    window.cancelAnimationFrame(budgetFrame);
    budgetFrame = window.requestAnimationFrame(() => renderWake(gen));
  });

  /* ---------- Erasure ---------- */

  const eraseList = $("[data-erase]");
  const carrierList = $("[data-carriers]");
  const eraseOut = $("[data-erase-out]");
  let erase = null;

  async function buildErase() {
    const base = makeMemory();
    const { memory, note, scopes, provenance } = base;
    const words = t().erase;
    const pii = await note("a", scopes.a, words.pii);
    const other = await note("a", scopes.a, words.other);
    const summary = await memory.submitSummary("a", {
      scope: scopes.a,
      sources: [
        { memoryId: pii.id, revision: 1 },
        { memoryId: other.id, revision: 1 },
      ],
      text: words.summary,
      provenance,
    });
    const copy = await memory.promote("owner", {
      memoryId: pii.id,
      revision: 1,
      scope: scopes.g,
      provenance,
    });
    const chat = { id: words.chat, kind: "conversation" };
    const mcp = { id: "mcp:7f3a2c", kind: "mcp" };
    const chatWake = await memory.wake("a", { scope: scopes.a, carrier: chat });
    const mcpWake = await memory.wake("a", { carrier: mcp });
    const rows = [
      { id: pii.id, kind: "original" },
      { id: summary.id, kind: "summary" },
      { id: copy.id, kind: "copy" },
    ];
    const tracked = new Set(rows.map((row) => row.id));
    const carriers = [
      { ...chat, received: chatWake.memoryIds.filter((id) => tracked.has(id)).length },
      { ...mcp, received: mcpWake.memoryIds.filter((id) => tracked.has(id)).length },
    ];
    return { ...base, rows, carriers, original: pii.id };
  }

  async function renderErase(g) {
    const state = erase;
    const zooms = [];
    for (const row of state.rows)
      zooms.push(await state.memory.zoom("owner", { memoryId: row.id }));
    const statuses = await state.memory.erasureStatus();
    if (g !== gen || state !== erase) return;
    eraseList.replaceChildren(
      ...state.rows.map((row, i) => {
        const z = zooms[i];
        const li = el("li", `er${z.status === "retracted" ? " is-retracted" : ""}`);
        const meta = el("div", "er__meta");
        meta.append(el("code", "", z.scope), el("span", "", t().rowKind[row.kind]));
        meta.append(el("span", "er__state", t().rowState[z.status] ?? z.status));
        const text = el("p", "er__text");
        if (z.status === "redacted") {
          text.append(el("span", "er__stone", t().tombstone(z.seq)));
        } else {
          text.textContent = z.revision?.text ?? "";
        }
        li.append(meta, text);
        return li;
      }),
    );
    carrierList.replaceChildren(
      ...state.carriers.map((carrier) => {
        const li = el("li", "carrier");
        const name = el("span", "");
        name.append(
          el("code", "", carrier.id),
          " ",
          el(
            "span",
            "carrier__what",
            `${t().kindName[carrier.kind]}, ${t().received(carrier.received)}`,
          ),
        );
        const found = new Set();
        for (const entry of statuses) {
          for (const c of entry.carriers) if (c.id === carrier.id) found.add(c.status);
        }
        const chips = el("span", "carrier__chips");
        for (const status of found.size ? [...found] : ["received"]) {
          chips.append(el("span", `status status--${status}`, t().status[status] ?? status));
        }
        li.append(name, chips);
        return li;
      }),
    );
    const pending = statuses.some((entry) => entry.carriers.some((c) => c.status === "pending"));
    // aria-disabled, not disabled: focus stays on the button the visitor just pressed.
    const off = {
      retract: zooms[0].status !== "live",
      redact: zooms[0].status === "redacted",
      deliver: !pending,
    };
    for (const [act, value] of Object.entries(off)) {
      $(`[data-erase-act="${act}"]`).setAttribute("aria-disabled", String(value));
    }
  }

  // One erase action at a time: a second click while the first awaits would act on a memory
  // the first already changed (MemoryStateError, or a redaction that finds 0 places).
  let erasing = false;
  for (const button of $$("[data-erase-act]")) {
    button.addEventListener("click", async () => {
      if (erasing || !erase || button.getAttribute("aria-disabled") === "true") return;
      erasing = true;
      const act = button.dataset.eraseAct;
      const g = gen;
      const state = erase;
      try {
        let message = "";
        let next = state;
        if (act === "reset") {
          next = await buildErase();
        } else if (act === "retract") {
          await state.memory.retract("owner", { memoryId: state.original });
          message = t().retracted;
        } else if (act === "redact") {
          const result = await state.memory.redact("owner", { memoryId: state.original });
          message = t().redacted(result.redacted.length + result.derived.length);
        } else if (act === "deliver") {
          const delivery = await state.memory.deliverErasures(async (work) =>
            Object.fromEntries(
              work.carriers.map((carrier) => [
                carrier.id,
                carrier.kind === "mcp" ? "unsupported" : "acknowledged",
              ]),
            ),
          );
          message = t().delivered(delivery);
        }
        // A language switch rebuilt the demo meanwhile: this answer belongs to the old one.
        if (g !== gen) return;
        erase = next;
        eraseOut.textContent = message;
        await renderErase(g);
      } finally {
        erasing = false;
      }
    });
  }

  /* ---------- Wiring ---------- */

  async function refreshWorld() {
    const g = gen;
    await Promise.all([renderSession(g), renderDrawers(g), renderWake(g)]);
  }

  async function startWorlds() {
    const g = ++gen;
    world = await buildMain();
    erase = await buildErase();
    if (g !== gen) return;
    eraseOut.textContent = "";
    await Promise.all([refreshWorld(), renderErase(g), renderTry()]);
  }

  function switchWorlds(before) {
    if (!factEdited || fact.value === before.fact) {
      fact.value = t().fact;
      factEdited = false;
    }
    lastRule = null;
    savedOut.textContent = "";
    startWorlds();
  }

  if (fact && !factEdited) fact.value = t().fact;
  startWorlds();
})();
