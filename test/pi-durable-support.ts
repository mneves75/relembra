import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  createRegistry,
  type Extension,
  Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import type { NoteProvenance, Policy, Principal } from "relembra";

export const context = BACKGROUND_CONTEXT;
export const MEMORY_SCOPE = "agent/pi-durable";

export const piProvenance: NoteProvenance = {
  agent: "test-agent",
  harness: "pi-durable",
  model: "faux-1",
  host: "test-host",
};

/** The host's context for one conversation: who it authenticated, and the epoch it holds. */
export interface PiHostContext {
  readonly user: string;
  readonly epoch?: number;
}

export const FENCE_KEY = "assistant-seat";

/** A host policy: the user reads and writes MEMORY_SCOPE, fenced when the context has an epoch. */
export const piPolicy: Policy<PiHostContext> = (host): Principal => ({
  id: host.user,
  readable: [MEMORY_SCOPE],
  writable: [MEMORY_SCOPE],
  promotable: [],
  ...(host.epoch === undefined ? {} : { fence: { key: FENCE_KEY, epoch: host.epoch } }),
});

/** A model turn that calls one tool. */
export function callTool(name: string, args: ToolCall["arguments"], id: string) {
  return fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
}

export function answer(text: string): AssistantMessage {
  return fauxAssistantMessage(text);
}

/**
 * A Harness on `storage` whose faux model plays `script`, one response per request, with only
 * `extensions` installed. No network: the faux provider answers in process.
 */
export async function openHarness(
  storage: Storage,
  extensions: readonly Extension[],
  script: readonly FauxResponseStep[],
) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([...script]);
  const registry = createRegistry();
  for (const extension of extensions) registry.install(extension);
  const harness = await Harness.open(storage, { models, registry }, context);
  const model = faux.getModel();
  const root = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  return { harness, root, faux };
}

/** A response that first records the messages of the request it answers. */
export function capturing(requests: string[], reply: AssistantMessage): FauxResponseStep {
  return (transcript) => {
    requests.push(JSON.stringify(transcript.messages));
    return reply;
  };
}

/** Submits `content` once (by request id) and waits until the run settles. */
export async function run(root: Conversation, content: string, requestId = content) {
  const submission = await root.submit({ type: "input", content, requestId }, context);
  return submission.wait(context);
}

export async function messages(root: Conversation): Promise<readonly Message[]> {
  return (await root.context(context)).messages;
}

export async function toolResults(root: Conversation): Promise<ToolResultMessage[]> {
  return (await messages(root)).filter(
    (message): message is ToolResultMessage => message.role === "toolResult",
  );
}

export function resultText(result: ToolResultMessage): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * Replaces `fetch` with a trap that records every call and throws, so a test that reaches the
 * network fails. Returns the calls and a function that restores the real `fetch`.
 */
export function trapFetch(): { readonly calls: string[]; restore(): void } {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: unknown) => {
      calls.push(String(input instanceof Request ? input.url : input));
      throw new Error("network access in a test");
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  const restore = () => {
    globalThis.fetch = real;
  };
  return { calls, restore };
}
