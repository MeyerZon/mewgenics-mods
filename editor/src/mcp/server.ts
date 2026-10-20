#!/usr/bin/env node
// Hand-rolled MCP stdio server: newline-delimited JSON-RPC 2.0 over stdin/stdout,
// protocol version 2025-06-18. Mirrors the client in tools/rea-mcp.mjs. Node
// built-ins + zod; no @modelcontextprotocol/sdk. It exposes the mewgenics data
// mod editor core as tools (see tools.ts). Node runs this file directly; the
// sibling server.mjs is a shim for registrations that still name that path.
//
// Transport rules honored:
//  - Requests (with an `id`) get a response; notifications (no `id`) do not.
//  - `initialize` -> capabilities + serverInfo; `notifications/initialized` -> ignored.
//  - `tools/list` -> the tool catalog; `tools/call` -> run a tool (arguments zod-validated).
//  - Diagnostics go to stderr so stdout stays pure JSON-RPC.

import { TOOLS, ToolError, callTool, findTool } from "./tools.ts";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "mewgenics-mod-editor", version: "0.1.0" };

type JsonRpcId = string | number;

interface JsonRpcMessage {
  id?: JsonRpcId | null;
  method?: string;
  params?: { name?: string; arguments?: unknown } & Record<string, unknown>;
}

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResult(id: JsonRpcId | null | undefined, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: JsonRpcId | null | undefined, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Handlers may be async (run_ingame_test blocks on the game), so this awaits them. */
async function handle(msg: JsonRpcMessage): Promise<void> {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return; // notifications: no response
  }
  if (method === "ping") {
    if (isRequest) sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (!name || !findTool(name)) {
      sendError(id, -32602, `unknown tool: ${name}`);
      return;
    }
    try {
      const result: unknown = await callTool(name, args);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      const isError = !!result && typeof result === "object" && (result as { ok?: unknown }).ok === false;
      sendResult(id, { content: [{ type: "text", text }], isError });
    } catch (e) {
      const message = e instanceof ToolError ? e.message : `tool "${name}" failed: ${String(e instanceof Error ? e.stack || e.message : e)}`;
      sendResult(id, { content: [{ type: "text", text: message }], isError: true });
    }
    return;
  }

  if (isRequest) sendError(id, -32601, `method not found: ${method}`);
}

function main(): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        process.stderr.write(`[mcp] non-JSON line ignored: ${line.slice(0, 160)}\n`);
        continue;
      }
      handle(msg).catch((e: unknown) => {
        process.stderr.write(`[mcp] handler error: ${String(e)}\n`);
        if (msg && msg.id !== undefined && msg.id !== null) sendError(msg.id, -32603, "internal error");
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stderr.write(`[mcp] ${SERVER_INFO.name} ${SERVER_INFO.version} ready (protocol ${PROTOCOL_VERSION})\n`);
}

main();
