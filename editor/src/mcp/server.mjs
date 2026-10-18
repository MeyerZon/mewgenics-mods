#!/usr/bin/env node
// Hand-rolled MCP stdio server: newline-delimited JSON-RPC 2.0 over stdin/stdout,
// protocol version 2025-06-18. Mirrors the client in tools/rea-mcp.mjs. Node
// built-ins only; no @modelcontextprotocol/sdk. It exposes the mewgenics data
// mod editor core as tools (see tools.mjs).
//
// Transport rules honored:
//  - Requests (with an `id`) get a response; notifications (no `id`) do not.
//  - `initialize` -> capabilities + serverInfo; `notifications/initialized` -> ignored.
//  - `tools/list` -> the tool catalog; `tools/call` -> run a tool.
//  - Diagnostics go to stderr so stdout stays pure JSON-RPC.

import { TOOLS, ToolError } from "./tools.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "mewgenics-mod-editor", version: "0.1.0" };

/** @type {Map<string, import('./tools.mjs').ToolDef>} */
const toolsByName = new Map(TOOLS.map((t) => [t.name, t]));

/** @param {unknown} obj */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** @param {string|number} id @param {unknown} result */
function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

/** @param {string|number} id @param {number} code @param {string} message */
function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * Handlers may be async (run_ingame_test blocks on the game), so this awaits them.
 * @param {any} msg
 */
async function handle(msg) {
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
    const tool = name ? toolsByName.get(name) : undefined;
    if (!tool) {
      sendError(id, -32602, `unknown tool: ${name}`);
      return;
    }
    try {
      const result = await tool.handler(args);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      const isError = result && typeof result === "object" && result.ok === false;
      sendResult(id, { content: [{ type: "text", text }], isError: Boolean(isError) });
    } catch (e) {
      const message = e instanceof ToolError ? e.message : `tool "${name}" failed: ${String(e instanceof Error ? e.stack || e.message : e)}`;
      sendResult(id, { content: [{ type: "text", text: message }], isError: true });
    }
    return;
  }

  if (isRequest) sendError(id, -32601, `method not found: ${method}`);
}

function main() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stderr.write(`[mcp] non-JSON line ignored: ${line.slice(0, 160)}\n`);
        continue;
      }
      handle(msg).catch((e) => {
        process.stderr.write(`[mcp] handler error: ${String(e)}\n`);
        if (msg && msg.id !== undefined && msg.id !== null) sendError(msg.id, -32603, "internal error");
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stderr.write(`[mcp] ${SERVER_INFO.name} ${SERVER_INFO.version} ready (protocol ${PROTOCOL_VERSION})\n`);
}

main();
