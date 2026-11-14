import { createHash } from "node:crypto";
import type { MemoryId, OpId, Provenance, Scope, SourceRevision, Trust } from "./model.js";

/**
 * The op id an integration derives for one tool call: `"v1:"` and the SHA-256 (hex) of
 * `JSON.stringify([hostNamespace, conversationId, taskId, callId])`. The JSON tuple keeps the
 * components apart, so no delimiter inside one can make two calls share an id. `hostNamespace`
 * names one durable journal lineage: it survives recovery, and an independently writable clone
 * gets a new one.
 */
export function integrationOpId(
  hostNamespace: string,
  conversationId: string,
  taskId: string,
  callId: string,
): OpId {
  const components = [hostNamespace, conversationId, taskId, callId];
  if (components.some((component) => typeof component !== "string")) {
    throw new TypeError("integration op id components must be strings");
  }
  return `v1:${sha256(JSON.stringify(components))}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The semantic inputs of a note, after defaults are applied and provenance is screened. */
export interface NotePayload {
  readonly scope: Scope;
  readonly principalId: string;
  readonly text: string;
  readonly pinned: boolean;
  readonly provenance: Provenance;
}

/**
 * The fingerprint an op record keeps: SHA-256 (hex) of the canonical encoding
 *
 *   JSON.stringify([1, "note", scope, principalId, text, pinned, trust,
 *                   agent, harness, model, host, source ?? null])
 *
 * The leading 1 is the encoding's version. Values sit at fixed positions, so the caller's key
 * order cannot change the bytes, and JSON.stringify of an array emits no whitespace between them.
 * Strings are taken exactly as stored: whitespace inside the text is part of the payload. The op
 * id and every generated field (memory id, timestamp, seq) are left out. The encoding is
 * persisted in op records, so changing it needs a new version number.
 */
export function noteFingerprint(payload: NotePayload): string {
  const { scope, principalId, text, pinned, provenance } = payload;
  const { trust, agent, harness, model, host, source } = provenance;
  return sha256(
    JSON.stringify([
      1,
      "note",
      scope,
      principalId,
      text,
      pinned,
      trust,
      agent,
      harness,
      model,
      host,
      source ?? null,
    ]),
  );
}

/** The semantic inputs of a supersede: the memory it replaces and its replacement's note. */
export interface SupersedePayload {
  readonly supersedes: MemoryId;
  readonly principalId: string;
  readonly text: string;
  readonly pinned: boolean;
  readonly provenance: Provenance;
}

/**
 * The fingerprint of a supersede: SHA-256 (hex) of
 *
 *   JSON.stringify([1, "supersede", supersedes, principalId, text, pinned, trust,
 *                   agent, harness, model, host, source ?? null])
 *
 * The replaced memory's id stands for the scope, which is the replaced memory's. The same text
 * replacing two different memories gives two fingerprints. Generated fields are left out.
 */
export function supersedeFingerprint(payload: SupersedePayload): string {
  const { supersedes, principalId, text, pinned, provenance } = payload;
  const { trust, agent, harness, model, host, source } = provenance;
  return sha256(
    JSON.stringify([
      1,
      "supersede",
      supersedes,
      principalId,
      text,
      pinned,
      trust,
      agent,
      harness,
      model,
      host,
      source ?? null,
    ]),
  );
}

/** The semantic inputs of a summary, before its trust is floored by its sources'. */
export interface SummaryPayload {
  readonly scope: Scope;
  readonly principalId: string;
  readonly text: string;
  /** Sorted by memory id. */
  readonly sources: readonly SourceRevision[];
  /** The trust the writer asked for, or undefined for the default. */
  readonly requestedTrust: Trust | undefined;
  readonly provenance: Provenance;
}

/**
 * The fingerprint of a summary: SHA-256 (hex) of
 *
 *   JSON.stringify([1, "summarize", scope, principalId, text, [[memoryId, revision], …],
 *                   requestedTrust ?? null, agent, harness, model, host, source ?? null])
 *
 * with the sources sorted by memory id. The requested trust is used, not the stored one: the
 * stored trust depends on the sources' trust when the summary commits.
 */
export function summaryFingerprint(payload: SummaryPayload): string {
  const { scope, principalId, text, sources, requestedTrust, provenance } = payload;
  const { agent, harness, model, host, source } = provenance;
  return sha256(
    JSON.stringify([
      1,
      "summarize",
      scope,
      principalId,
      text,
      sources.map((s) => [s.memoryId, s.revision]),
      requestedTrust ?? null,
      agent,
      harness,
      model,
      host,
      source ?? null,
    ]),
  );
}

/** The semantic inputs of a promotion, before its trust is floored by the origin's. */
export interface PromotePayload {
  readonly originId: MemoryId;
  /** The origin's revision, as the promoter read it. */
  readonly revision: number;
  readonly targetScope: Scope;
  readonly principalId: string;
  /** The trust the promoter asked for, or undefined for the default. */
  readonly requestedTrust: Trust | undefined;
  readonly provenance: Provenance;
}

/**
 * The fingerprint of a promotion: SHA-256 (hex) of
 *
 *   JSON.stringify([1, "promote", originId, revision, scope, principalId,
 *                   requestedTrust ?? null, agent, harness, model, host, source ?? null])
 *
 * The copy's text is the origin's at that revision, so the origin and revision stand for it. The
 * requested trust is used, not the stored one, which also depends on the origin's trust.
 */
export function promoteFingerprint(payload: PromotePayload): string {
  const { originId, revision, targetScope, principalId, requestedTrust, provenance } = payload;
  const { agent, harness, model, host, source } = provenance;
  return sha256(
    JSON.stringify([
      1,
      "promote",
      originId,
      revision,
      targetScope,
      principalId,
      requestedTrust ?? null,
      agent,
      harness,
      model,
      host,
      source ?? null,
    ]),
  );
}
