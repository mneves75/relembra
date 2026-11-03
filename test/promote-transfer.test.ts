import { describe, expect, test } from "bun:test";
import {
  createRelembra,
  exportJsonl,
  ImportError,
  importJsonl,
  type Principal,
  type Store,
  type Trust,
} from "relembra";
import { openSqliteStore } from "relembra/sqlite";
import { createMemoryStore } from "../src/testing/memory-store.js";
import { tempDir } from "./sqlite-support.js";
import { provenance } from "./support.js";
import { describeStore } from "./transfer-support.js";

const DEV = "dev/repo";
const TEAM = "team/shared";

/** Owns, reads and writes both scopes, and may promote into TEAM. */
const both: Principal = {
  id: "both",
  readable: [DEV, TEAM],
  writable: [DEV, TEAM],
  promotable: [TEAM],
  owned: [DEV, TEAM],
  trustCeiling: "owner",
};
/** Owns TEAM and promotes into it, but cannot read DEV. */
const teamOnly: Principal = {
  id: "team-only",
  readable: [TEAM],
  writable: [TEAM],
  promotable: [TEAM],
  owned: [TEAM],
};
/** Owns TEAM and reads DEV, but may not promote into TEAM. */
const noPromote: Principal = { ...both, id: "no-promote", promotable: [] };
/** Owns TEAM, reads DEV without owning it, and promotes into TEAM. */
const readsDev: Principal = {
  id: "reads-dev",
  readable: [DEV, TEAM],
  writable: [TEAM],
  promotable: [TEAM],
  owned: [TEAM],
};

function open(store: Store = createMemoryStore(), prefix = "m") {
  let n = 0;
  const relembra = createRelembra<Principal>({
    store,
    policy: (principal) => principal,
    ids: { memoryId: () => `${prefix}-${++n}`, opId: () => `${prefix}-op-${++n}` },
    clock: { now: () => 1_000 + n },
  });
  const note = (text: string, trust?: Trust) =>
    relembra.note(both, {
      scope: DEV,
      text,
      provenance: trust === undefined ? provenance : { ...provenance, trust },
    });
  const promote = (memoryId: string, trust?: Trust) =>
    relembra.promote(both, {
      memoryId,
      revision: 1,
      scope: TEAM,
      provenance: trust === undefined ? provenance : { ...provenance, trust },
    });
  return { store, relembra, note, promote };
}

const lines = (jsonl: string) =>
  jsonl
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line));
const join = (values: readonly unknown[]) => values.map((v) => `${JSON.stringify(v)}\n`).join("");

async function refusal(
  store: Store,
  principal: Principal,
  jsonl: string,
): Promise<{ reason: string; line: number; detail: string | undefined }> {
  const error = await importJsonl(store, principal, jsonl).catch((e: unknown) => e);
  if (!(error instanceof ImportError)) throw new Error(`expected an ImportError, got ${error}`);
  return { reason: error.reason, line: error.line, detail: error.detail };
}

/** A store holding DEV's memories, imported from `source`, ready for TEAM's lines. */
async function withOrigin(source: Store): Promise<Store> {
  const target = createMemoryStore();
  await importJsonl(target, both, await exportJsonl(source, both, { scope: DEV }));
  return target;
}

describe("export format with promotions", () => {
  test("stays format 1 without a promotion, and is format 2 on the header and the promote line with one", async () => {
    const { store, note, promote } = open();
    const origin = await note("A fact worth sharing.");
    // Positive control: no promotion, format 1 throughout.
    const before = lines(await exportJsonl(store, both));
    expect(before.map((line) => line.format)).toEqual([1, 1]);

    const copy = await promote(origin.id);
    const after = lines(await exportJsonl(store, both));
    expect(after.map((line) => [line.kind ?? "header", line.format])).toEqual([
      ["header", 2],
      ["note", 1],
      ["promote", 2],
    ]);
    expect(after[2]).toMatchObject({
      memoryId: copy.id,
      scope: TEAM,
      origin: { memoryId: origin.id, revision: 1 },
    });
    // An export of the origin's scope alone holds no promote line, so it stays format 1.
    expect(lines(await exportJsonl(store, both, { scope: DEV }))[0].format).toBe(1);
  });

  test("a format 3 line, a format 1 promote line and a line above its header's format are refused", async () => {
    const { store, note, promote } = open();
    const origin = await note("A fact.");
    await promote(origin.id);
    const [header, noteLine, promoteLine] = lines(await exportJsonl(store, both));
    const cases: [unknown[], string, number][] = [
      [[{ ...header, format: 3 }, noteLine, promoteLine], "format-too-new", 1],
      [[header, noteLine, { ...promoteLine, format: 3 }], "format-too-new", 3],
      [[header, noteLine, { ...promoteLine, format: 1 }], "malformed", 3],
      [[{ ...header, format: 1 }, noteLine, promoteLine], "malformed", 3],
    ];
    for (const [file, reason, line] of cases) {
      expect(await refusal(createMemoryStore(), both, join(file))).toMatchObject({ reason, line });
    }
    // Positive control: the file as exported imports.
    const report = await importJsonl(
      createMemoryStore(),
      both,
      join([header, noteLine, promoteLine]),
    );
    expect(report.imported).toBe(2);
  });
});

describe("import of a promotion", () => {
  for (const kind of ["memory", "sqlite"] as const) {
    test(`a round trip keeps the copy's link, and redacting the origin there reaches the copy (${kind} store)`, async () => {
      const dir = tempDir();
      const source = open(createMemoryStore());
      const origin = await source.note("Shared through promotion.");
      const copy = await source.promote(origin.id);
      const jsonl = await exportJsonl(source.store, both);

      const store =
        kind === "memory"
          ? createMemoryStore()
          : openSqliteStore({ path: `${dir.path}/store/r.db` });
      try {
        const report = await importJsonl(store, both, jsonl);
        expect(report).toEqual({ imported: 2, skipped: 0, refused: [] });
        expect(await describeStore(store, [DEV, TEAM])).toEqual(
          await describeStore(source.store, [DEV, TEAM]),
        );
        expect((await describeStore(store, [TEAM]))[0]?.origin).toEqual({
          memoryId: origin.id,
          revision: 1,
        });
        // Importing again adds nothing.
        expect(await importJsonl(store, both, jsonl)).toEqual({
          imported: 0,
          skipped: 2,
          refused: [],
        });
        const target = open(store, "t");
        await target.relembra.redact(both, { memoryId: origin.id });
        expect((await store.transaction((tx) => tx.memory(copy.id)))?.status).toBe("redacted");
      } finally {
        if ("close" in store) await (store as { close(): Promise<void> }).close();
        dir.remove();
      }
    });
  }

  test("a copy imports where its origin is, and is refused where it is not", async () => {
    const source = open();
    const origin = await source.note("A fact.");
    await source.promote(origin.id);
    const team = await exportJsonl(source.store, both, { scope: TEAM });
    expect(await refusal(createMemoryStore(), both, team)).toEqual({
      reason: "malformed",
      line: 2,
      detail: undefined,
    });
    // Positive control: with the origin imported first.
    const target = await withOrigin(source.store);
    expect((await importJsonl(target, both, team)).imported).toBe(1);
  });

  test("an origin the importer cannot read is refused as an absent one is", async () => {
    const source = open();
    const origin = await source.note("A fact.");
    await source.promote(origin.id);
    const team = await exportJsonl(source.store, both, { scope: TEAM });
    const target = await withOrigin(source.store);
    expect(await refusal(target, teamOnly, team)).toEqual({
      reason: "malformed",
      line: 2,
      detail: undefined,
    });
    // Positive control: a principal that reads DEV.
    expect((await importJsonl(target, readsDev, team)).imported).toBe(1);
  });

  test("needs promote rights on the copy's scope", async () => {
    const source = open();
    const origin = await source.note("A fact.");
    await source.promote(origin.id);
    const team = await exportJsonl(source.store, both, { scope: TEAM });
    const target = await withOrigin(source.store);
    expect(await refusal(target, noPromote, team)).toEqual({
      reason: "denied",
      line: 2,
      detail: "promote",
    });
    expect((await importJsonl(target, both, team)).imported).toBe(1);
  });

  test("refuses an origin at another revision, retracted, or redacted", async () => {
    const source = open();
    const origin = await source.note("A fact.");
    await source.promote(origin.id);
    const [header, promoteLine] = lines(await exportJsonl(source.store, both, { scope: TEAM }));

    const atRevision2 = join([
      header,
      { ...promoteLine, origin: { memoryId: origin.id, revision: 2 } },
    ]);
    expect(await refusal(await withOrigin(source.store), both, atRevision2)).toMatchObject({
      reason: "conflict",
      line: 2,
    });

    const retracted = await withOrigin(source.store);
    await open(retracted, "r").relembra.retract(both, { memoryId: origin.id });
    expect(await refusal(retracted, both, join([header, promoteLine]))).toMatchObject({
      reason: "conflict",
      line: 2,
    });
    // A principal that only reads DEV does not see the retracted origin at all.
    expect(await refusal(retracted, readsDev, join([header, promoteLine]))).toMatchObject({
      reason: "malformed",
      line: 2,
    });

    const redacted = await withOrigin(source.store);
    await open(redacted, "r").relembra.redact(both, { memoryId: origin.id });
    expect(await refusal(redacted, both, join([header, promoteLine]))).toMatchObject({
      reason: "redacted-in-target",
      line: 2,
    });
    // Positive control: the live origin at revision 1.
    expect(
      (await importJsonl(await withOrigin(source.store), both, join([header, promoteLine])))
        .imported,
    ).toBe(1);
  });

  test("refuses a copy of a summary, a copy in its origin's scope, and a copy of itself", async () => {
    const source = open();
    const origin = await source.note("A fact.");
    const summary = await source.relembra.submitSummary(both, {
      scope: DEV,
      sources: [{ memoryId: origin.id, revision: 1 }],
      text: "A summary.",
      provenance,
    });
    await source.promote(origin.id);
    const all = lines(await exportJsonl(source.store, both));
    const header = all[0];
    const promoteLine = all.find((line) => line.kind === "promote");
    const before = all.filter((line) => line.kind !== "promote");
    const ofSummary = { ...promoteLine, origin: { memoryId: summary.id, revision: 1 } };
    const sameScope = { ...promoteLine, scope: DEV };
    const ofItself = { ...promoteLine, origin: { memoryId: promoteLine.memoryId, revision: 1 } };
    expect(await refusal(createMemoryStore(), both, join([...before, ofSummary]))).toEqual({
      reason: "malformed",
      line: 4,
      detail: "summary-promote",
    });
    // Promote rights on DEV too, so the refusal is the scope's, as on the direct path.
    const intoDev = { ...both, promotable: [TEAM, DEV] };
    expect(await refusal(createMemoryStore(), intoDev, join([...before, sameScope]))).toMatchObject(
      {
        reason: "malformed",
        line: 4,
      },
    );
    expect(await refusal(createMemoryStore(), both, join([...before, ofItself]))).toMatchObject({
      reason: "malformed",
      line: 4,
    });
    expect(header.format).toBe(2);
    // Positive control.
    expect(
      (await importJsonl(createMemoryStore(), both, join([...before, promoteLine]))).imported,
    ).toBe(3);
  });

  test("caps the copy's trust at its origin's in the store", async () => {
    const source = open();
    const origin = await source.note("From a web page.", "untrusted");
    await source.promote(origin.id);
    const [header, noteLine, promoteLine] = lines(await exportJsonl(source.store, both));
    const raised = {
      ...promoteLine,
      revision: {
        ...promoteLine.revision,
        provenance: { ...promoteLine.revision.provenance, trust: "agent" },
      },
    };
    const target = createMemoryStore();
    await importJsonl(target, both, join([header, noteLine, raised]));
    const copy = await target.transaction((tx) => tx.memory(promoteLine.memoryId));
    expect(copy?.status === "redacted" ? undefined : copy?.revision.provenance.trust).toBe(
      "untrusted",
    );
  });

  test("a copy's tombstone imports without its origin, and a stored copy is not a note", async () => {
    const source = open();
    const origin = await source.note("A fact.");
    const copy = await source.promote(origin.id);
    const live = lines(await exportJsonl(source.store, both, { scope: TEAM }));
    await source.relembra.redact(both, { memoryId: copy.id });
    const team = await exportJsonl(source.store, both, { scope: TEAM });
    expect(lines(team).map((line) => [line.kind ?? "header", line.redacted ?? false])).toEqual([
      ["header", false],
      ["promote", true],
      ["redact", false],
    ]);
    const empty = createMemoryStore();
    expect((await importJsonl(empty, both, team)).imported).toBe(2);
    expect((await empty.transaction((tx) => tx.memory(copy.id)))?.status).toBe("redacted");

    // The same id and text as a note line, where the store holds the copy: a conflict.
    const target = await withOrigin(source.store);
    await importJsonl(target, both, join(live));
    const [header, promoteLine] = live;
    const { origin: _link, ...rest } = promoteLine;
    const asNote = { ...rest, format: 1, kind: "note", pinned: false };
    expect(await refusal(target, both, join([{ ...header, format: 1 }, asNote]))).toMatchObject({
      reason: "conflict",
      line: 2,
    });
  });

  test("a supersede whose replacement is a copy is refused", async () => {
    const source = open();
    const origin = await source.note("A fact.");
    const copy = await source.promote(origin.id);
    const target = open(source.store, "s");
    const replaced = await target.relembra.note(both, { scope: TEAM, text: "Old.", provenance });
    const all = lines(await exportJsonl(source.store, both));
    const last = all.at(-1);
    const supersede = {
      format: 1,
      kind: "supersede",
      seq: last.seq + 1,
      memoryId: replaced.id,
      scope: TEAM,
      principalId: both.id,
      by: copy.id,
    };
    expect(await refusal(createMemoryStore(), both, join([...all, supersede]))).toEqual({
      reason: "malformed",
      line: all.length + 1,
      detail: "copy-replacement",
    });
    // Positive control: the file without it imports.
    expect((await importJsonl(createMemoryStore(), both, join(all))).imported).toBe(3);
  });

  test("a later export's redaction of the origin reaches the copy in the target", async () => {
    const source = open();
    const origin = await source.note("A fact.");
    const copy = await source.promote(origin.id);
    const target = createMemoryStore();
    await importJsonl(target, both, await exportJsonl(source.store, both));
    await source.relembra.redact(both, { memoryId: origin.id });
    await importJsonl(target, both, await exportJsonl(source.store, both, { scope: DEV }));
    expect((await target.transaction((tx) => tx.memory(copy.id)))?.status).toBe("redacted");
    expect((await target.erasures()).map((work) => work.memoryId)).toEqual([origin.id, copy.id]);
  });

  for (const kind of ["memory", "sqlite"] as const) {
    test(`a promote line whose text is not its origin's, or not revision 1, is refused, writing nothing (${kind} store)`, async () => {
      const dir = tempDir();
      const source = open();
      const origin = await source.note("The release branch is main.");
      await source.promote(origin.id);
      const [header, noteLine, promoteLine] = lines(await exportJsonl(source.store, both));
      const forged = {
        ...promoteLine,
        revision: { ...promoteLine.revision, text: "The release branch is anything goes." },
      };
      const renumbered = { ...promoteLine, revision: { ...promoteLine.revision, number: 2 } };
      const fresh = (name: string): Store =>
        kind === "memory"
          ? createMemoryStore()
          : openSqliteStore({ path: `${dir.path}/${name}/relembra.db` });
      const opened: Store[] = [];
      try {
        for (const [line, reason, name] of [
          [forged, "conflict", "forged"],
          [renumbered, "malformed", "renumbered"],
        ] as const) {
          const store = fresh(name);
          opened.push(store);
          expect(await refusal(store, both, join([header, noteLine, line]))).toMatchObject({
            reason,
            line: 3,
          });
          // All or nothing: not even the origin's note line was written.
          expect(await store.events({ scopes: [DEV, TEAM] })).toEqual([]);
        }
        // Positive control: the unedited export round-trips with the origin's text.
        const store = fresh("unedited");
        opened.push(store);
        await importJsonl(store, both, join([header, noteLine, promoteLine]));
        const copy = await store.transaction((tx) => tx.memory(promoteLine.memoryId));
        expect(copy?.status === "redacted" ? undefined : copy?.revision.text).toBe(
          origin.revision.text,
        );
      } finally {
        for (const store of opened) {
          if ("close" in store) await (store as { close(): Promise<void> }).close();
        }
        dir.remove();
      }
    });
  }
});
