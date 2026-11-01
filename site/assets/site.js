/*
 * relembra landing page: language and theme, motion, and the demos. Every demo calls the real
 * library from assets/relembra.js (built from src/ by scripts/site/build.ts) in an in-memory store
 * that lives only in this tab. Nothing is sent anywhere.
 */
(() => {
  // biome-ignore lint/suspicious/noRedundantUseStrict: a classic script, not a module
  "use strict";

  const doc = document;
  const root = doc.documentElement;
  const lib = window.relembraDemo;
  const encoder = new TextEncoder();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const $ = (selector, scope = doc) => scope.querySelector(selector);
  const $$ = (selector, scope = doc) => Array.from(scope.querySelectorAll(selector));
  const lang = () => (root.lang === "en" ? "en" : "pt-BR");
  const byteLength = (text) => encoder.encode(text).length;
  const MAX = 280;
  const MONDAY = Date.parse("2026-10-26T12:00:00Z");

  const storage = {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Storage can be blocked; the choice then lasts for this visit only.
      }
    },
  };

  function el(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Restarts a CSS animation that a class runs once. */
  function pulse(node, className) {
    node.classList.remove(className);
    void node.offsetWidth;
    node.classList.add(className);
  }

  const shortId = (id) => `${id.slice(0, 8)}…`;
  const clockTime = (ms) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;

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
        blank: "Vazio não é fato. Escreve alguma coisa.",
        "too-long": "Passou de 280 bytes. Corta: um fato por linha.",
        "ill-formed": "Tem um caractere quebrado no meio do texto.",
        "multi-line": "Tem quebra de linha. Um fato, uma linha.",
        "bidi-character":
          "Tem um caractere que inverte a direção do texto, truque clássico pra esconder coisa.",
        "zero-width-character":
          "Tem um caractere invisível de largura zero. Você não vê. O modelo vê.",
        "control-character": "Tem um caractere de controle, tipo um tab.",
        "format-character": "Tem um caractere de formatação invisível.",
        "invisible-character": "Tem um caractere invisível.",
        credential: "Isso tem cara de senha ou chave. A guarda barra e nem repete o texto.",
      },
      notRendered: "Nada é gravado, e a recusa nunca repete o texto.",
      saved: (id) =>
        `Guardado no projeto A como ${shortId(id)}. Desce até a sessão de terça: ele já está lá.`,
      saveRefused: (rule) => `A guarda recusou (${rule}). Nada foi gravado.`,
      copied: "Copiado",
      selected: "Selecionado",
      parts: {
        id: "Um id único. É por ele que você corrige, retira ou tarja depois.",
        scope: (v) => `A gaveta onde ela mora: ${v}. Quem não tem a chave nem sabe que ela existe.`,
        rev: (v) => `Revisão ${v}. Corrigir cria uma revisão nova; a contagem começa em 1.`,
        at: "Quando foi anotada, em UTC.",
        trust: (v) =>
          `Confiança: ${v}. Pode ser owner, agent ou untrusted, e o modelo lê como evidência, não como ordem.`,
        text: "O fato. Uma linha, até 280 bytes, escapada pra não forjar a moldura.",
      },
      ruler: (n, line) =>
        `${n} de 280 bytes no texto. A linha inteira, com a moldura, tem ${line}.`,
      keyYes: "tem a chave",
      keyNo: "sem chave",
      found: (count, query) =>
        count === 0
          ? `Nada para “${query}” nas gavetas que ele abre.`
          : `${count} ${count === 1 ? "resultado" : "resultados"} para “${query}”, só das gavetas que ele abre.`,
      typeToSearch: "Digite uma palavra para buscar.",
      peekDenied: (scope, access) =>
        `Recusado: ScopeDeniedError (${access === "read" ? "leitura" : access}). Ele não tem a chave da gaveta ${scope}, e a busca nem olha lá dentro.`,
      peekAllowed: "Permitido. Este agente tem a chave.",
      budget: (n) => `${n} bytes`,
      kinds: { pinned: "fixada", recent: "recente", summary: "resumo", covered: "coberta" },
      how: { full: "inteira", index: "só o id", out: "fora" },
      wakeSum: (full, index, out, used, budget) =>
        `${full} inteiras, ${index} só pelo id, ${out} de fora. Usou ${used} de ${budget} bytes.`,
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
        redacted: "tarjada: lápide no lugar do texto",
      },
      tombstone: (seq) => `lápide · seq ${seq}`,
      received: (count) => `recebeu ${count} ${count === 1 ? "texto" : "textos"} no wake`,
      kindName: { conversation: "conversa", mcp: "cliente MCP" },
      status: {
        received: "recebeu",
        pending: "pendente",
        acknowledged: "reconhecido",
        unsupported: "sem suporte",
      },
      retracted:
        "Escondida. O original e o resumo saíram do alcance dos agentes, mas a cópia promovida para global continua viva, com o e-mail. Esconder não basta: tarje.",
      redacted: (count) =>
        `Tarjada em ${count} lugares: o original, o resumo e a cópia promovida viraram lápide. Quem já tinha levado o texto ficou pendente.`,
      delivered: (d) =>
        `O host avisou os portadores de cada memória tarjada: ${d.acknowledged} entregas reconhecidas, ${d.unsupported} sem suporte para apagar, ${d.pending} pendentes. O relembra registra a resposta e nunca diz “apagado”.`,
      retry: {
        text: "Os testes precisam de TZ=UTC.",
        other: "Os testes rodam em qualquer fuso.",
        first: (op, id, at) => `note  ${op}  →  id ${shortId(id)}  às ${at}`,
        again: (op, id, at, now) =>
          `a luz caiu; repetindo ${op}  →  id ${shortId(id)}, o mesmo, às ${at} (agora são ${now})`,
        conflict: (op) => `${op} com outro texto  →  OpConflictError: recusado, nada gravado`,
      },
      exam: {
        "relembra-sqlite": "O relembra de verdade, na loja SQLite. Passou em todas as metas.",
        "relembra-memory": "O mesmo relembra, na loja em memória. Passou também.",
        perfect:
          "O gabarito: responde exatamente o que deveria. Se ele reprovasse, quem estaria errada era a prova.",
        empty: "Não guarda nada. Nunca vaza, mas também nunca acha nada: reprova.",
        leaky:
          "O gabarito com uma memória proibida plantada em cada superfície. Um vazamento basta pra reprovar.",
        "hollow-empty-brief": "Todo bilhete sai vazio.",
        "hollow-empty-text": "A busca devolve o id certo com o texto vazio.",
        "hollow-wrong-text": "Troca dígitos ou acrescenta uma palavra ao texto.",
        "hollow-wrong-scope": "As memórias saem com um escopo que ninguém pode ler.",
        "hollow-duplicate-conflict":
          "Repete a primeira memória com o mesmo id e o texto falsificado.",
        "hollow-indented-conflict": "A mesma falsificação, recuada um espaço.",
        "hollow-index-text": "Esconde o texto dentro de uma linha de índice.",
        "hollow-wrapped-text": "Repete o texto, quebrado em duas linhas no primeiro espaço.",
        "hollow-encoded-duplicate": "O mesmo elemento com as tags escapadas e um corpo falso.",
        "hollow-extra-raw":
          "O primeiro resultado da busca carrega o texto de uma memória que o agente não pode ler.",
        "hollow-extra-wrapped":
          "O mesmo vazamento, quebrado em duas linhas. Espaço em branco não esconde nada.",
        "hollow-appended-raw": "Cola o texto proibido no fim do primeiro resultado.",
        "hollow-appended-wrapped": "O mesmo, quebrado em duas linhas.",
        "hollow-error-raw": "A busca responde um erro interno cuja mensagem é o texto proibido.",
        "hollow-error-wrapped": "O mesmo erro, com o texto quebrado em duas linhas.",
      },
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
        blank: "Empty isn't a fact. Type something.",
        "too-long": "Over 280 bytes. Cut it: one fact per line.",
        "ill-formed": "There's a broken character in the middle of it.",
        "multi-line": "It has a line break. One fact, one line.",
        "bidi-character":
          "It has a character that flips text direction, the classic way to hide something.",
        "zero-width-character": "It has a zero-width character. You can't see it. The model can.",
        "control-character": "It has a control character, like a tab.",
        "format-character": "It has an invisible formatting character.",
        "invisible-character": "It has an invisible character.",
        credential: "That looks like a password or a key. The guard blocks it and never echoes it.",
      },
      notRendered: "Nothing is stored, and the refusal never echoes the text.",
      saved: (id) =>
        `Saved to project A as ${shortId(id)}. Scroll to Tuesday's session: it's already there.`,
      saveRefused: (rule) => `The guard refused it (${rule}). Nothing was stored.`,
      copied: "Copied",
      selected: "Selected",
      parts: {
        id: "A unique id. It's how you fix, retract or redact it later.",
        scope: (v) => `The drawer it lives in: ${v}. Without the key, you don't know it exists.`,
        rev: (v) => `Revision ${v}. A correction makes a new revision; counting starts at 1.`,
        at: "When it was noted, in UTC.",
        trust: (v) =>
          `Trust: ${v}. It can be owner, agent or untrusted, and the model reads it as evidence, not orders.`,
        text: "The fact. One line, up to 280 bytes, escaped so it can't forge its frame.",
      },
      ruler: (n, line) => `${n} of 280 bytes of text. The whole line, frame included, is ${line}.`,
      keyYes: "has the key",
      keyNo: "no key",
      found: (count, query) =>
        count === 0
          ? `Nothing for “${query}” in the drawers it can open.`
          : `${count} ${count === 1 ? "result" : "results"} for “${query}”, only from drawers it can open.`,
      typeToSearch: "Type a word to search.",
      peekDenied: (scope, access) =>
        `Refused: ScopeDeniedError (${access}). It has no key to drawer ${scope}, and the search never looks inside.`,
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
        redacted: "redacted: a tombstone replaces the text",
      },
      tombstone: (seq) => `tombstone · seq ${seq}`,
      received: (count) => `received ${count} ${count === 1 ? "text" : "texts"} in a wake`,
      kindName: { conversation: "conversation", mcp: "MCP client" },
      status: {
        received: "received",
        pending: "pending",
        acknowledged: "acknowledged",
        unsupported: "unsupported",
      },
      retracted:
        "Hidden. The original and its summary are out of every agent's reach, but the copy promoted to global is still live, email and all. Hiding isn't enough: redact.",
      redacted: (count) =>
        `Redacted in ${count} places: the original, the summary and the promoted copy are tombstones now. Whoever already took the text is pending.`,
      delivered: (d) =>
        `The host told the carriers of every redacted memory: ${d.acknowledged} deliveries acknowledged, ${d.unsupported} unsupported (can't erase), ${d.pending} pending. relembra records each answer and never says “erased”.`,
      retry: {
        text: "Tests need TZ=UTC.",
        other: "Tests run in any time zone.",
        first: (op, id, at) => `note  ${op}  →  id ${shortId(id)}  at ${at}`,
        again: (op, id, at, now) =>
          `power cut; retrying ${op}  →  id ${shortId(id)}, the same, at ${at} (it's ${now} now)`,
        conflict: (op) => `${op} with other text  →  OpConflictError: refused, nothing stored`,
      },
      exam: {
        "relembra-sqlite": "The real relembra on the SQLite store. Passed every gate.",
        "relembra-memory": "The same relembra on the in-memory store. Passed too.",
        perfect:
          "The answer key: returns exactly what it should. If it failed, the test would be what's wrong.",
        empty: "Stores nothing. Never leaks, never finds anything either. Fails.",
        leaky:
          "The answer key with one forbidden memory planted on every surface. One leak is enough to fail.",
        "hollow-empty-brief": "Every brief comes back empty.",
        "hollow-empty-text": "Find returns the right id with empty text.",
        "hollow-wrong-text": "Changes digits or adds a word to the text.",
        "hollow-wrong-scope": "Memories come out labelled with a scope nobody can read.",
        "hollow-duplicate-conflict": "Repeats the first memory under the same id with forged text.",
        "hollow-indented-conflict": "The same forgery, indented by one space.",
        "hollow-index-text": "Hides the text inside an index line.",
        "hollow-wrapped-text": "Repeats the text, wrapped onto two lines at its first space.",
        "hollow-encoded-duplicate": "The same element with escaped tags and a false body.",
        "hollow-extra-raw":
          "The first find result carries the text of a memory the agent cannot read.",
        "hollow-extra-wrapped": "The same leak, wrapped onto two lines. Whitespace hides nothing.",
        "hollow-appended-raw": "Appends the forbidden text to the first result's own text.",
        "hollow-appended-wrapped": "The same, wrapped onto two lines.",
        "hollow-error-raw": "Find answers an internal error whose message is the forbidden text.",
        "hollow-error-wrapped": "The same error, with the text wrapped onto two lines.",
      },
    },
  };
  const t = () => COPY[lang()];

  /* ---------- Language and theme ---------- */

  function applyLabels() {
    const key = lang() === "en" ? "labelEn" : "labelPt";
    for (const node of $$("[data-label-pt]")) node.setAttribute("aria-label", node.dataset[key]);
    for (const button of $$("[data-set-lang]")) {
      button.setAttribute("aria-pressed", String(button.dataset.setLang === lang()));
    }
    doc.title = t().title;
    $('meta[name="description"]')?.setAttribute("content", t().description);
    // The film is narrated in Portuguese: English readers get English captions on by default.
    for (const track of $(".film__video")?.textTracks ?? []) {
      track.mode = lang() === "en" && track.language === "en" ? "showing" : "disabled";
    }
  }

  function applyTheme() {
    $("#theme")?.setAttribute("aria-pressed", String(root.dataset.theme === "dark"));
  }

  $("#theme")?.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    storage.set("relembra-theme", root.dataset.theme);
    applyTheme();
  });

  for (const button of $$("[data-set-lang]")) {
    button.addEventListener("click", () => {
      const next = button.dataset.setLang;
      if (next === lang()) return;
      const before = t();
      root.lang = next;
      storage.set("relembra-lang", next);
      applyLabels();
      fitMark();
      if (lib) switchWorlds(before);
    });
  }

  /* ---------- Motion: the visitor's choice, or the system's until they make one ---------- */

  const motionToggles = $$("[data-motion-toggle]");

  function applyMotion() {
    for (const button of motionToggles) {
      button.setAttribute("aria-pressed", String(root.dataset.motion === "full"));
    }
  }

  for (const button of motionToggles) {
    button.addEventListener("click", () => {
      root.dataset.motion = root.dataset.motion === "full" ? "reduced" : "full";
      storage.set("relembra-motion", root.dataset.motion);
      applyMotion();
    });
  }

  reduced.addEventListener("change", () => {
    if (storage.get("relembra-motion")) return;
    root.dataset.motion = reduced.matches ? "reduced" : "full";
    applyMotion();
  });

  applyLabels();
  applyTheme();
  applyMotion();

  /* ---------- Header: hide on the way down, show on the way up ---------- */

  const bar = $(".bar");
  let lastY = window.scrollY;
  let barTick = false;
  window.addEventListener(
    "scroll",
    () => {
      if (barTick) return;
      barTick = true;
      window.requestAnimationFrame(() => {
        const y = window.scrollY;
        if (bar && !bar.contains(doc.activeElement)) {
          if (y > lastY + 6 && y > 240) bar.classList.add("is-hidden");
          else if (y < lastY - 6 || y < 120) bar.classList.remove("is-hidden");
        }
        lastY = y;
        barTick = false;
      });
    },
    { passive: true },
  );
  bar?.addEventListener("focusin", () => bar.classList.remove("is-hidden"));

  /* ---------- Depth toggle ---------- */

  const explain = $(".explain");
  const depthSource = $(".depth");
  if (depthSource) {
    for (const title of $$(".ch__title")) title.after(depthSource.cloneNode(true));
  }

  function setDepth(value) {
    if (!explain) return;
    explain.dataset.depth = value;
    for (const button of $$("[data-depth-set]")) {
      button.setAttribute("aria-pressed", String(button.dataset.depthSet === value));
    }
  }

  for (const button of $$("[data-depth-set]")) {
    button.addEventListener("click", () => {
      setDepth(button.dataset.depthSet);
      storage.set("relembra-depth", button.dataset.depthSet);
    });
  }
  const savedDepth = storage.get("relembra-depth");
  setDepth(savedDepth === "eng" ? "eng" : "kid");

  /* ---------- Footer wordmark fitted to the page width ---------- */

  function fitMark() {
    const mark = $(".foot__mark");
    const word = $("[data-fit]");
    if (!mark || !word) return;
    mark.style.fontSize = "100px";
    const width = word.getBoundingClientRect().width;
    if (width > 0)
      mark.style.fontSize = `${Math.floor((100 * mark.clientWidth * 1000) / width) / 1000}px`;
  }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      fitMark();
    }, 120);
  });
  fitMark();
  doc.fonts?.ready.then(fitMark);

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

  /* ---------- Rolling figures ---------- */

  function roll(node) {
    const target = Number(node.dataset.roll);
    if (!(target > 0)) return;
    const start = performance.now();
    const duration = 1100;
    const step = (now) => {
      const p = Math.min((now - start) / duration, 1);
      node.textContent = String(Math.round(target * (1 - (1 - p) ** 3)));
      if (p < 1) window.requestAnimationFrame(step);
    };
    node.textContent = "0";
    window.requestAnimationFrame(step);
  }

  /* ---------- Reveals ---------- */

  // Reveals run in both motion modes (reduced ones only fade); moving() gates what travels.
  const reveals = "IntersectionObserver" in window;
  const moving = () => root.dataset.motion === "full";
  const onEnter = new Map();

  function setupReveals() {
    if (!reveals) return;
    const targets = $$("[data-reveal], [data-lines], .stage, .session, .proof__table");
    const fold = window.innerHeight * 0.92;
    for (const node of targets) {
      if (node.getBoundingClientRect().top < fold) node.classList.add("is-in");
    }
    root.classList.add("motion");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
          onEnter.get(entry.target)?.();
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.01 },
    );
    for (const node of targets) if (!node.classList.contains("is-in")) observer.observe(node);
  }

  const proofTable = $(".proof__table");
  if (proofTable) {
    onEnter.set(proofTable, () => {
      for (const node of $$("[data-roll]", proofTable)) roll(node);
    });
  }

  /* ---------- Chapter 6: the exam (static data from docs/eval) ---------- */

  const exam = $("[data-exam]");
  const examSay = $("[data-exam-say]");
  let examRow = null;

  function showExam(row) {
    if (!row || !examSay) return;
    examRow?.classList.remove("is-on");
    examRow = row;
    row.classList.add("is-on");
    examSay.textContent = `${row.dataset.c}: ${t().exam[row.dataset.c] ?? ""}`;
  }

  if (exam) {
    $$("tbody tr", exam).forEach((row, i) => {
      $(".stamp", row)?.style.setProperty("--i", String(i));
      row.addEventListener("mouseenter", () => showExam(row));
      row.addEventListener("focus", () => showExam(row));
      row.addEventListener("click", () => showExam(row));
    });
    showExam($("tbody tr", exam));
  }

  if (!lib) {
    setupReveals();
    return;
  }

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
    const time = {
      now() {
        clock += 60_000;
        return clock;
      },
    };
    const memory = lib.createRelembra({
      store: lib.createMemoryStore(),
      policy: (who) => policy[who],
      clock: time,
    });
    const provenance = { agent: "agent", harness: "claude-code", model: "demo", host: t().host };
    const note = (who, scope, text, extra = {}) =>
      memory.note(who, { scope, text, provenance, ...extra });
    return { memory, scopes, policy, provenance, note, peekClock: () => clock };
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

  /** Splits a rendered `<memory …>text</memory>` line into its attributes and text. */
  function parseMemory(line) {
    const match =
      /^<memory id="([^"]*)" scope="([^"]*)" rev="([^"]*)" at="([^"]*)" trust="([^"]*)">(.*)<\/memory>$/.exec(
        line,
      );
    if (!match) return null;
    const [, id, scope, rev, at, trust, text] = match;
    return { id, scope, rev, at, trust, text };
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

  /* ---------- Try it ---------- */

  const fact = $("#fact");
  const verdict = $("#try-verdict");
  const bytesOut = $("[data-bytes]");
  const meter = $(".meter");
  const meterFill = $("[data-meter]");
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
    const chip = el(
      "span",
      `chip ${rule ? "chip--bad" : "chip--ok"}`,
      rule ? t().refused : t().accepted,
    );
    verdict.replaceChildren(chip);
    if (rule)
      verdict.append(el("code", "", rule), el("span", "verdict__why", t().rules[rule] ?? ""));
    pulse(chip, "is-new");
  }

  async function renderTry() {
    if (!fact) return;
    const text = fact.value;
    const n = byteLength(text);
    bytesOut.textContent = String(n);
    meterFill.style.setProperty("--p", String(Math.max(Math.min(n / MAX, 1), 0.004)));
    meter.classList.toggle("is-over", n > MAX);
    const rule = lib.findGuardViolation(text, lib.MAX_MEMORY_BYTES);
    paintVerdict(rule);
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

  $("#try-save")?.addEventListener("click", async () => {
    if (!world) return; // the demo store is still being built
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

  /* ---------- Live: the next session ---------- */

  const session = $("#session");
  let sessionTimers = [];

  function playSession() {
    if (!session || !reveals) return;
    for (const timer of sessionTimers) window.clearTimeout(timer);
    sessionTimers = [];
    const lines = $$(".sl", session);
    for (const line of lines) line.classList.remove("is-shown");
    session.classList.add("is-playing");
    const delays = [150, 650, 1500, 2500];
    lines.forEach((line, i) => {
      sessionTimers.push(
        window.setTimeout(() => line.classList.add("is-shown"), delays[i] ?? 600 * i),
      );
    });
    sessionTimers.push(
      window.setTimeout(() => session.classList.remove("is-playing"), (delays.at(-1) ?? 0) + 900),
    );
  }

  if (session) onEnter.set(session, playSession);
  $("[data-replay]")?.addEventListener("click", playSession);

  async function renderSession(g) {
    const wake = await world.memory.wake("a", { budgetBytes: 1000 });
    if (g !== gen) return;
    const code = $(".sl--wake code", session);
    if (code) paintWake(code, wake.text);
    const noted = $("[data-noted-id]");
    if (noted) noted.textContent = world.ids.mig;
  }

  /* ---------- Chapter 1: anatomy of a memory ---------- */

  const anatomy = $("[data-anatomy]");
  const anatomySay = $("[data-anatomy-say]");
  let anatomyPart = "text";

  async function renderAnatomy(g) {
    const recent = await world.memory.recall("a", { scope: world.scopes.a });
    const latest = recent.find((memory) => memory.id !== world.ids.summary);
    if (!latest) return;
    const wake = await world.memory.wake("a", { scope: world.scopes.a, budgetBytes: 9500 });
    if (g !== gen) return;
    const line = wakeLines(wake.text).find((l) => l.includes(`id="${latest.id}"`)) ?? "";
    const parsed = parseMemory(line);
    const code = el("code", "anatomy__code raw");
    anatomy.replaceChildren(code);
    if (!parsed) {
      code.append(el("span", "part part--frame", line));
      return;
    }
    const parts = [
      ["frame", "<memory"],
      ["id", `id="${parsed.id}"`],
      ["scope", `scope="${parsed.scope}"`],
      ["rev", `rev="${parsed.rev}"`],
      ["at", `at="${parsed.at}"`],
      ["trust", `trust="${parsed.trust}"`],
      ["frame", ">"],
      ["text", parsed.text],
      ["frame", "</memory>"],
    ];
    parts.forEach(([kind, label], i) => {
      const node =
        kind === "frame"
          ? el("span", "part part--frame", label)
          : el("button", `part part--${kind}`, label);
      node.style.setProperty("--i", String(i));
      if (kind !== "frame") {
        node.type = "button";
        node.dataset.part = kind;
        const choose = () => explainPart(kind, parsed);
        node.addEventListener("click", choose);
        node.addEventListener("focus", choose);
        node.addEventListener("mouseenter", choose);
      }
      code.append(node);
    });
    explainPart(anatomyPart, parsed);
    const n = byteLength(latest.revision.text);
    $("[data-ruler]")?.style.setProperty("--p", String(n / MAX));
    const label = $("[data-ruler-label]");
    if (label) label.textContent = t().ruler(n, byteLength(line));
  }

  function explainPart(kind, parsed) {
    anatomyPart = kind;
    for (const node of $$("[data-part]", anatomy)) {
      node.setAttribute("aria-pressed", String(node.dataset.part === kind));
    }
    const say = t().parts[kind];
    anatomySay.textContent = typeof say === "function" ? say(parsed[kind]) : say;
  }

  /* ---------- Chapter 2: drawers ---------- */

  const drawers = $("[data-drawers]");
  const findInput = $("[data-find]");
  const findOut = $("[data-find-out]");
  let who = "a";

  async function renderDrawers(g) {
    const { scopes, policy, memory } = world;
    // find() refuses queries over 1,000 characters; the input's maxlength stops typing, this the rest
    const query = findInput.value.trim().slice(0, 1000);
    const results = query ? await memory.find(who, { query }) : [];
    const hits = new Set(results.map((result) => result.memory.id));
    const columns = [];
    for (const scope of [scopes.a, scopes.b, scopes.g]) {
      columns.push({ scope, items: await memory.recall("owner", { scope }) });
    }
    if (g !== gen) return;
    const readable = new Set(policy[who].readable);
    drawers.replaceChildren(
      ...columns.map(({ scope, items }) => {
        const open = readable.has(scope);
        const drawer = el("div", `drawer${open ? "" : " is-locked"}`);
        drawer.dataset.scope = scope;
        const head = el("div", "drawer__head");
        head.append(
          el("code", "drawer__name raw", scope),
          el("span", "drawer__key", open ? t().keyYes : t().keyNo),
        );
        const list = el("ul", "drawer__items");
        items.forEach((item, i) => {
          const row = el(
            "li",
            `drawer__item${hits.has(item.id) ? " is-hit" : ""}`,
            open ? item.revision.text : "",
          );
          row.style.setProperty("--i", String(i));
          if (!open) row.setAttribute("aria-hidden", "true");
          list.append(row);
        });
        drawer.append(head, list);
        return drawer;
      }),
    );
    const shown = query.length > 40 ? `${query.slice(0, 40)}…` : query;
    findOut.textContent = query ? t().found(results.length, shown) : t().typeToSearch;
  }

  function replayStage(node) {
    const stage = node.closest(".stage");
    if (!stage || !reveals) return;
    stage.classList.remove("is-in");
    void stage.offsetWidth;
    stage.classList.add("is-in");
  }

  for (const button of $$("[data-who]")) {
    button.addEventListener("click", async () => {
      who = button.dataset.who;
      for (const other of $$("[data-who]")) {
        other.setAttribute("aria-pressed", String(other === button));
      }
      await renderDrawers(gen);
      replayStage(drawers);
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
      const drawer = $$(".drawer", drawers).find((node) => node.dataset.scope === other);
      if (drawer && moving()) pulse(drawer, "is-shaking");
    }
  });

  /* ---------- Chapter 3: the wake budget ---------- */

  const budget = $("[data-budget]");
  const budgetOut = $("[data-budget-out]");
  const wakeList = $("[data-wakelist]");
  const wakeSum = $("[data-wake-sum]");
  const wakeBar = $("[data-wakebar]");
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
        li.append(
          el("span", "wl__tag", t().kinds[kindOf(row.id)]),
          el(row.how === "index" ? "code" : "span", "wl__text raw", row.text),
          el("span", "wl__how", t().how[row.how]),
        );
        return li;
      }),
    );
    const used = byteLength(wake.text);
    wakeBar.style.setProperty("--p", String(Math.min(used / bytes, 1)));
    const count = (how) => rows.filter((row) => row.how === how).length;
    wakeSum.textContent = t().wakeSum(count("full"), count("index"), count("out"), used, bytes);
  }

  budget?.addEventListener("input", () => {
    window.cancelAnimationFrame(budgetFrame);
    budgetFrame = window.requestAnimationFrame(() => renderWake(gen));
  });

  /* ---------- Chapter 4: erasure ---------- */

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

  async function renderErase(g, { animate = false } = {}) {
    const state = erase;
    const zooms = [];
    for (const row of state.rows)
      zooms.push(await state.memory.zoom("owner", { memoryId: row.id }));
    const statuses = await state.memory.erasureStatus();
    if (g !== gen || state !== erase) return;
    const fresh = !eraseList.children.length || !animate;
    if (fresh) {
      eraseList.replaceChildren(
        ...state.rows.map((row, i) => {
          const li = el("li", "er");
          li.dataset.id = row.id;
          const body = el("div", "er__body");
          const text = el("span", "er__text");
          text.style.setProperty("--i", String(i));
          text.append(
            el("span", "er__words", zooms[i].revision?.text ?? ""),
            el("span", "er__ink"),
          );
          body.append(text, el("span", "er__state"));
          li.append(
            el("code", "er__scope raw", zooms[i].scope),
            el("span", "er__kind", t().rowKind[row.kind]),
            body,
          );
          return li;
        }),
      );
    }
    state.rows.forEach((_row, i) => {
      const li = eraseList.children[i];
      const z = zooms[i];
      li.classList.toggle("is-retracted", z.status === "retracted");
      $(".er__state", li).textContent = t().rowState[z.status] ?? z.status;
      if (z.status === "redacted" && !li.classList.contains("is-redacted")) {
        const ink = $(".er__ink", li);
        ink.textContent = t().tombstone(z.seq);
        li.classList.add("is-redacted");
        const words = $(".er__words", li);
        const textBox = $(".er__text", li);
        const settle = () => {
          textBox.style.width = `${Math.max(textBox.getBoundingClientRect().width, 120)}px`;
          textBox.style.height = `${textBox.getBoundingClientRect().height}px`;
          words?.remove();
        };
        if (animate && moving()) window.setTimeout(settle, 800 + i * 140);
        else settle();
      }
    });
    carrierList.replaceChildren(
      ...state.carriers.map((carrier) => {
        const li = el("li", "carrier");
        const name = el("span", "carrier__name");
        name.append(
          el("code", "carrier__id raw", carrier.id),
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
        const list = found.size ? [...found] : ["received"];
        for (const status of list) {
          const chip = el("span", `status status--${status}`, t().status[status] ?? status);
          if (animate && found.size) pulse(chip, "is-new");
          chips.append(chip);
        }
        li.append(name, chips);
        return li;
      }),
    );
    const live = zooms[0].status === "live";
    const redacted = zooms[0].status === "redacted";
    const pending = statuses.some((entry) => entry.carriers.some((c) => c.status === "pending"));
    $('[data-erase-act="retract"]').disabled = !live;
    $('[data-erase-act="redact"]').disabled = redacted;
    $('[data-erase-act="deliver"]').disabled = !pending;
  }

  for (const button of $$("[data-erase-act]")) {
    button.addEventListener("click", async () => {
      const act = button.dataset.eraseAct;
      const g = gen;
      const state = erase;
      if (act === "reset") {
        erase = await buildErase();
        if (g !== gen) return;
        eraseList.replaceChildren();
        eraseOut.textContent = "";
        await renderErase(g);
        return;
      }
      if (act === "retract") {
        await state.memory.retract("owner", { memoryId: state.original });
        eraseOut.textContent = t().retracted;
      } else if (act === "redact") {
        const result = await state.memory.redact("owner", { memoryId: state.original });
        eraseOut.textContent = t().redacted(result.redacted.length + result.derived.length);
      } else if (act === "deliver") {
        const delivery = await state.memory.deliverErasures(async (work) =>
          Object.fromEntries(
            work.carriers.map((carrier) => [
              carrier.id,
              carrier.kind === "mcp" ? "unsupported" : "acknowledged",
            ]),
          ),
        );
        eraseOut.textContent = t().delivered(delivery);
      }
      await renderErase(g, { animate: true });
    });
  }

  /* ---------- Chapter 5: retry ---------- */

  const retryLog = $("[data-retry-log] code");
  const retryCount = $("[data-retry-count]");
  const OP = "op-7f3a";
  let retry = null;

  async function retryCountNow() {
    const count = (await retry.memory.recall("a", { scope: retry.scopes.a })).length;
    retryCount.textContent = String(count);
  }

  function logLine(text, bad = false) {
    retryLog.append(el("span", `log-line${bad ? " log-line--bad" : ""}`, text));
  }

  function stepButtons(next) {
    for (const button of $$("[data-step]")) button.disabled = Number(button.dataset.step) !== next;
  }

  async function resetRetry() {
    retry = makeMemory();
    retry.first = null;
    retryLog.replaceChildren();
    await retryCountNow();
    stepButtons(1);
  }

  async function runStep(step) {
    const words = t().retry;
    if (step === 1) {
      await resetRetry();
      retry.first = await retry.note("a", retry.scopes.a, words.text, { opId: OP });
      logLine(words.first(OP, retry.first.id, clockTime(retry.first.notedAt)));
      stepButtons(2);
    } else if (step === 2) {
      const again = await retry.note("a", retry.scopes.a, words.text, { opId: OP });
      logLine(words.again(OP, again.id, clockTime(again.notedAt), clockTime(retry.peekClock())));
      stepButtons(3);
    } else {
      try {
        await retry.note("a", retry.scopes.a, words.other, { opId: OP });
      } catch (error) {
        if (error?.name !== "OpConflictError") throw error;
        logLine(words.conflict(OP), true);
      }
      stepButtons(1);
    }
    await retryCountNow();
  }

  // The chapter plays its three steps once when it scrolls into view, unless the visitor has
  // already pressed a step or the worlds were rebuilt (language switch) in the meantime.
  let driven = false;
  for (const button of $$("[data-step]")) {
    button.addEventListener("click", () => {
      driven = true;
      runStep(Number(button.dataset.step));
    });
  }

  const retryStage = $("[data-retry-log]")?.closest(".stage");
  if (retryStage) {
    onEnter.set(retryStage, async () => {
      const g = gen;
      for (const step of [1, 2, 3]) {
        if (driven || g !== gen || !retry) return;
        await runStep(step);
        await new Promise((resolve) => window.setTimeout(resolve, 1100));
      }
    });
  }

  /* ---------- Wiring ---------- */

  async function refreshWorld() {
    const g = gen;
    await Promise.all([renderSession(g), renderAnatomy(g), renderDrawers(g), renderWake(g)]);
  }

  async function startWorlds() {
    const g = ++gen;
    world = await buildMain();
    erase = await buildErase();
    if (g !== gen) return;
    eraseList.replaceChildren();
    eraseOut.textContent = "";
    await Promise.all([refreshWorld(), renderErase(g), resetRetry(), renderTry()]);
  }

  function switchWorlds(before) {
    if (!factEdited || fact.value === before.fact) {
      fact.value = t().fact;
      factEdited = false;
    }
    lastRule = null;
    savedOut.textContent = "";
    if (examRow) showExam(examRow);
    startWorlds();
  }

  if (fact && !factEdited) fact.value = t().fact;
  setupReveals();
  startWorlds();
})();
