/**
 * A minimal 2026-07-28 stdio server for the round-trip test's controls: it answers like a
 * conforming server, or, with DROP_RESULT_TYPE=1, leaves `resultType` out of tools/list. The
 * independent client must reject the second, which shows the round trip checks what it claims.
 */
const serverInfo = { "io.modelcontextprotocol/serverInfo": { name: "fake", version: "0" } };
const { DROP_RESULT_TYPE } = process.env;
const drop = DROP_RESULT_TYPE === "1";

function answer(message: { id?: unknown; method?: string }): unknown {
  switch (message.method) {
    case "server/discover":
      return {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        _meta: serverInfo,
        ttlMs: 0,
        cacheScope: "public",
      };
    case "tools/list":
      return {
        ...(drop ? {} : { resultType: "complete" }),
        tools: [{ name: "echo", inputSchema: { type: "object", additionalProperties: false } }],
        _meta: serverInfo,
        ttlMs: 0,
        cacheScope: "public",
      };
    default:
      return undefined;
  }
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffered += chunk;
  for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
    const message = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    if (message.id === undefined) continue;
    const result = answer(message);
    const reply =
      result === undefined
        ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
        : { jsonrpc: "2.0", id: message.id, result };
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  }
});
