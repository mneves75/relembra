/**
 * The pi-durable integration: an extension that gives a pi-durable 1.4.0 Harness the tools
 * `memory_note`, `memory_find` and `memory_brief`, and a `relembra_memory` system prompt section
 * carrying the wake rendering.
 *
 * Only types come from pi-durable: its `defineTool`, `defineExtension` and `section` are identity
 * functions, so the extension is a plain object and this module loads nothing at run time.
 */
import type {
  ConversationId,
  Extension,
  HookRegistration,
  PromptSection,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { MAX_MEMORY_BYTES } from "../guard.js";
import type { Scope } from "../model.js";
import { integrationOpId } from "../ops.js";
import type { Carrier } from "../ports.js";
import {
  checkCarrier,
  MAX_FIND_LIMIT,
  MAX_QUERY_LENGTH,
  type NoteProvenance,
  type Relembra,
} from "../relembra.js";

/** What the host gives relembra for one conversation. */
export interface ConversationMemory<Context> {
  /** The host's authenticated context, which its relembra policy maps to a principal. */
  readonly context: Context;
  /** The scope `memory_note` writes to. Reads cover every scope the principal may read. */
  readonly scope: Scope;
  /**
   * Stored with each note and part of its fingerprint: keep it the same across processes, or a
   * rerun after a crash is refused as a conflicting operation.
   */
  readonly provenance: NoteProvenance;
}

export interface MemoryExtensionOptions<Context> {
  readonly relembra: Relembra<Context>;
  /**
   * Names the pi-durable storage this Harness owns: one durable journal lineage. pi-durable numbers
   * conversations and tasks per storage, so two storages need two namespaces. It survives recovery
   * of the same storage; an independently writable copy gets a new one. It also names each
   * conversation's carrier (`<hostNamespace>/<conversationId>`), so it must pass the identifier
   * rule within the carrier id's 512 bytes.
   */
  readonly hostNamespace: string;
  /** The host's context, write scope and provenance for a conversation. */
  resolve(
    conversationId: ConversationId,
  ): ConversationMemory<Context> | Promise<ConversationMemory<Context>>;
}

export const MEMORY_EXTENSION_NAME = "relembra";

/**
 * The key of relembra's system prompt section. Section keys are shared by every extension (a later
 * one replaces an earlier one with the same key), so the key names relembra.
 */
export const MEMORY_SECTION_KEY = "relembra_memory";

/** What the memory section shows when the wake cannot be rendered: no memory text at all. */
export const WAKE_UNAVAILABLE = '<wake unavailable="true"/>';

/** The most an argument may hold before the guard reads it; the guard's own limit is far lower. */
const MAX_TEXT = 4_000;
/** pi-durable's generation task; hooks match tasks by this name. */
const GENERATION_TASK = "pi.generation";
/** The kind of every carrier this extension records. */
export const PI_DURABLE_CARRIER_KIND = "pi-durable";

/**
 * The relembra extension for a pi-durable Harness. Every tool is `replay: "safe"`: `memory_note`
 * derives its op id from the host namespace and the call's conversation, task and call ids, so a
 * call that reruns after a crash returns the memory its first run committed instead of writing
 * another; the reads change nothing. Every rendering (find, brief, wake) goes through the host's
 * egress filter and byte budget, and is recorded as received by its conversation's carrier
 * (kind `pi-durable`, id `<hostNamespace>/<conversationId>`) before the model gets it, so a later
 * redaction names the conversation in its erasure work. Errors (a guard refusal, a fence, an
 * egress deny, a failed recording) become error results; the wake becomes WAKE_UNAVAILABLE.
 */
export function createMemoryExtension<Context>(
  options: MemoryExtensionOptions<Context>,
): Extension {
  const { relembra, hostNamespace } = options;
  if (typeof hostNamespace !== "string" || hostNamespace === "") {
    throw new TypeError("a host namespace must be a non-empty string");
  }
  // pi-durable's conversation ids are whole numbers: the longest one tried here bounds them all.
  checkCarrier(carrierFor(hostNamespace, Number.MAX_SAFE_INTEGER));
  const resolve = async (conversationId: ConversationId) => options.resolve(conversationId);

  const note: ToolRegistration = {
    name: "memory_note",
    description:
      "Save one durable fact for later sessions: a decision, preference or lesson, as one line " +
      `of at most ${MAX_MEMORY_BYTES} bytes.`,
    parameters: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: MAX_TEXT } },
      additionalProperties: false,
    },
    replay: "safe",
    prepareArguments: strictArguments("memory_note", "text", MAX_TEXT),
    async execute(args, api) {
      const { context, scope, provenance } = await resolve(api.conversationId);
      const opId = callOpId(hostNamespace, api);
      const memory = await relembra.note(context, {
        scope,
        text: field(args, "text"),
        provenance,
        opId,
      });
      return {
        output: [{ type: "text", text: `Noted memory ${memory.id}.` }],
        details: { memoryId: memory.id, at: memory.revision.at },
      };
    },
  };

  const find: ToolRegistration = {
    name: "memory_find",
    description: "Search saved memories, best match first, as quoted evidence.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: MAX_QUERY_LENGTH },
        limit: { type: "integer", minimum: 1, maximum: MAX_FIND_LIMIT },
      },
      additionalProperties: false,
    },
    replay: "safe",
    prepareArguments: strictArguments("memory_find", "query", MAX_QUERY_LENGTH, true),
    async execute(args, api) {
      const { context } = await resolve(api.conversationId);
      const limit = (args as { limit?: unknown }).limit;
      const rendering = await relembra.findRendering(context, {
        query: field(args, "query"),
        ...(typeof limit === "number" ? { limit } : {}),
        carrier: carrierFor(hostNamespace, api.conversationId),
      });
      return text(rendering.text, { memoryIds: [...rendering.memoryIds] });
    },
  };

  const brief: ToolRegistration = {
    name: "memory_brief",
    description: "A bounded brief of saved memories about one topic, as quoted evidence.",
    parameters: {
      type: "object",
      required: ["topic"],
      properties: { topic: { type: "string", minLength: 1, maxLength: MAX_QUERY_LENGTH } },
      additionalProperties: false,
    },
    replay: "safe",
    prepareArguments: strictArguments("memory_brief", "topic", MAX_QUERY_LENGTH),
    async execute(args, api) {
      const { context } = await resolve(api.conversationId);
      const rendering = await relembra.brief(context, {
        topic: field(args, "topic"),
        carrier: carrierFor(hostNamespace, api.conversationId),
      });
      return text(rendering.text, { memoryIds: [...rendering.memoryIds] });
    },
  };

  /**
   * The wake as the host's policy and egress filter allow it now, or WAKE_UNAVAILABLE. Never throws:
   * pi-durable keeps a throwing section's earlier text (dist/harness/prompt.js renderSections) and
   * skips a throwing hook, both of which would send a wake the host no longer allows.
   */
  async function currentWake(conversationId: ConversationId): Promise<string> {
    try {
      const { context } = await resolve(conversationId);
      return (await relembra.wake(context, { carrier: carrierFor(hostNamespace, conversationId) }))
        .text;
    } catch {
      return WAKE_UNAVAILABLE;
    }
  }

  // relembra frames its rendering itself (`<wake>…</wake>`), so pi-durable adds no tag.
  const wake: PromptSection = {
    key: MEMORY_SECTION_KEY,
    tag: false,
    render: (input) => currentWake(input.conversationId),
  };

  // Before every model request, recovery included (pi-durable's GenerationHooks.beforeRequest),
  // the request gets the wake rendered now. Section changes are positional system entries that a
  // provider taking mid-conversation system messages receives as stored, and a resumed request
  // reuses the transcript prepared before a crash; neither may carry a wake the host now refuses.
  const freshWake: HookRegistration = {
    task: GENERATION_TASK,
    handlers: {
      async beforeRequest(
        request: { readonly messages: readonly RequestMessage[] },
        api: { readonly conversationId: ConversationId },
      ) {
        return withWake(request.messages, await currentWake(api.conversationId));
      },
    },
  };

  return {
    name: MEMORY_EXTENSION_NAME,
    tools: [note, find, brief],
    sections: [wake],
    hooks: [freshWake],
  };
}

/** The part of a request message the hook reads. */
interface RequestMessage {
  readonly role: string;
  readonly sections?: Readonly<Record<string, string | null>>;
}

/**
 * `messages` with relembra's section in their system messages set to `wake` where it is in effect
 * (the newest value, when the newest change set it rather than removed it) and removed everywhere
 * else. Every other key, message and field is left as it was. `undefined` when relembra's section
 * is in no system message.
 */
function withWake(
  messages: readonly RequestMessage[],
  wake: string,
): { messages: RequestMessage[] } | undefined {
  const holds = (message: RequestMessage) =>
    message.role === "system" && typeof message.sections?.[MEMORY_SECTION_KEY] === "string";
  const touches = (message: RequestMessage) =>
    message.role === "system" &&
    message.sections !== undefined &&
    MEMORY_SECTION_KEY in message.sections;
  const newest = messages.findLastIndex(touches);
  if (newest === -1) return undefined;
  const current = holds(messages[newest] as RequestMessage) ? newest : -1;
  return {
    messages: messages.map((message, index) => {
      if (!holds(message)) return message;
      const { [MEMORY_SECTION_KEY]: _stored, ...others } = message.sections ?? {};
      const sections = index === current ? { ...others, [MEMORY_SECTION_KEY]: wake } : others;
      return { ...message, sections };
    }),
  };
}

/**
 * A `prepareArguments` that accepts exactly `{ [field]: string of 1 to max characters }`, plus an
 * optional integer `limit` from 1 to 100 when `limit` is set, and throws a fixed message otherwise.
 * pi-durable runs it before its own validation, whose error quotes the arguments, and reports a
 * throw as the call's `invalid_arguments` error (dist/harness/tool.js `prepare`): so no input value
 * ever reaches the model in an error.
 */
function strictArguments(
  tool: string,
  field: string,
  max: number,
  limit = false,
): (args: unknown) => Record<string, string | number> {
  const message =
    `${tool}: invalid arguments: ${field} must be a string of 1 to ${max} characters` +
    `${limit ? `, limit an optional integer from 1 to ${MAX_FIND_LIMIT}` : ""}, and nothing else`;
  const allowed = new Set(limit ? [field, "limit"] : [field]);
  return (args) => {
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error(message);
    const given = args as { readonly limit?: unknown } & Record<string, unknown>;
    if (Object.keys(given).some((key) => !allowed.has(key))) throw new Error(message);
    const value = given[field];
    if (typeof value !== "string" || value.length < 1 || value.length > max) {
      throw new Error(message);
    }
    if (!limit || given.limit === undefined) return { [field]: value };
    const count = given.limit;
    if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_FIND_LIMIT) {
      throw new Error(message);
    }
    return { [field]: value, limit: count as number };
  };
}

/** The carrier of one conversation: unique per storage (namespace) and conversation. */
function carrierFor(hostNamespace: string, conversationId: ConversationId | number): Carrier {
  return { id: `${hostNamespace}/${String(conversationId)}`, kind: PI_DURABLE_CARRIER_KIND };
}

/**
 * The §4.3 op id of one tool call. pi-durable's conversation and task ids are numbers; the tuple
 * takes their decimal strings, so the components stay strings as the op id format requires.
 */
function callOpId(hostNamespace: string, api: ToolExecutionApi): string {
  return integrationOpId(hostNamespace, String(api.conversationId), String(api.taskId), api.callId);
}

/** A string argument. pi-durable validated `args` against the schema; this keeps types honest. */
function field(args: unknown, name: string): string {
  const value = (args as Record<string, unknown>)[name];
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function text(
  output: string,
  details: { readonly memoryIds: readonly string[] },
): ToolExecutionResult {
  return {
    output: [{ type: "text", text: output }],
    details: { memoryIds: [...details.memoryIds] },
  };
}
