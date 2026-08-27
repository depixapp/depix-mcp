// Anthropic's MCP clients (Claude Desktop, Claude Code) validate tool calls
// against the tool's declared schemas with a JSON-Schema-2020-12-only validator
// and REFUSE any schema that declares another dialect — the call fails in the
// client before it ever reaches the tool. The SDK's zod-v3 converter stamps
// `"$schema": "http://json-schema.org/draft-07/schema#"` on every input and
// output schema it emits, so every tool on this server is unusable from those
// clients unless the stamp is removed.
//
// Removing it is semantically free: the keywords these schemas use mean the
// same thing in draft-07 and 2020-12, and a schema with no `$schema` is read
// in the client's default dialect (2020-12). The stamp is applied inside the
// SDK's tools/list handler, after our code has run — so the one place we can
// reliably catch it is the transport, on the serialized response.

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

interface SendCapable {
  send(message: JSONRPCMessage, options?: unknown): Promise<void>;
}

/** The converter stamps only the schema root — nested schemas carry no `$schema`. */
function withoutDialect(schema: unknown): unknown {
  if (schema && typeof schema === "object" && !Array.isArray(schema) && "$schema" in schema) {
    const { $schema: _dropped, ...rest } = schema as Record<string, unknown>;
    return rest;
  }
  return schema;
}

/** Strip the dialect stamp from every tool schema in a tools/list response; every other message passes through untouched. */
export function stripToolSchemaDialects(message: JSONRPCMessage): JSONRPCMessage {
  const result = (message as { result?: { tools?: unknown } }).result;
  if (!result || !Array.isArray(result.tools)) return message;
  for (const tool of result.tools) {
    if (!tool || typeof tool !== "object") continue;
    const t = tool as Record<string, unknown>;
    t.inputSchema = withoutDialect(t.inputSchema);
    if (t.outputSchema !== undefined) t.outputSchema = withoutDialect(t.outputSchema);
  }
  return message;
}

/**
 * Patch a transport in place so everything it sends goes through
 * stripToolSchemaDialects. Patching (rather than wrapping in a new object)
 * keeps the transport's other contract intact — the Server assigns onmessage/
 * onclose on the same instance it was handed.
 */
export function sanitizeOutgoingSchemas<T extends SendCapable>(transport: T): T {
  const original = transport.send.bind(transport);
  transport.send = (message: JSONRPCMessage, options?: unknown) =>
    original(stripToolSchemaDialects(message), options);
  return transport;
}
