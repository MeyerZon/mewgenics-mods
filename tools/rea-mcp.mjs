#!/usr/bin/env node
// Minimal MCP stdio client for scripting REA analysis sessions.
//
//   node tools/rea-mcp.mjs --server "<command> <args...>" list-tools [nameFilter]
//   node tools/rea-mcp.mjs --server "<command> <args...>" run <batch.json> [outDir]
//
// batch.json: [{ "id": "label", "tool": "open_binary", "arguments": {...} }, ...]
// Each call's result is written to <outDir>/<index>-<id>.json; a summary goes to stdout.
// The server process is one long-lived session, so an opened Ghidra target stays open
// across all calls in the batch (one import instead of one per query).
//
// Only Node built-ins are used. Transport is MCP stdio (newline-delimited JSON-RPC).

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const serverIdx = argv.indexOf("--server");
if (serverIdx < 0 || !argv[serverIdx + 1]) {
  console.error("usage: rea-mcp.mjs --server \"<cmd...>\" (list-tools [filter] | run <batch.json> [outDir])");
  process.exit(2);
}
const serverCmd = argv[serverIdx + 1];
const rest = argv.filter((_, i) => i !== serverIdx && i !== serverIdx + 1);
const mode = rest[0];

// Split the server command on spaces, honoring double quotes.
const parts = serverCmd.match(/"[^"]*"|\S+/g).map((p) => p.replace(/^"|"$/g, ""));
const child = spawn(parts[0], parts.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let nextId = 1;
const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { process.stderr.write(`[non-json] ${line.slice(0, 200)}\n`); continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
    } else if (msg.method === "notifications/progress" || msg.method === "notifications/message") {
      const p = msg.params || {};
      process.stderr.write(`[progress] ${JSON.stringify(p).slice(0, 300)}\n`);
    }
  }
});
child.on("exit", (code) => {
  for (const { reject } of pending.values()) reject(new Error(`server exited with code ${code}`));
  pending.clear();
});

function request(method, params, timeoutMs = 0) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(payload + "\n");
    if (timeoutMs > 0) setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout after ${timeoutMs} ms: ${method}`)); }
    }, timeoutMs);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function main() {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mewgenics-mods-driver", version: "0.1" },
  }, 120_000);
  notify("notifications/initialized", {});
  process.stderr.write(`[init] server=${init.serverInfo?.name} ${init.serverInfo?.version} protocol=${init.protocolVersion}\n`);

  if (mode === "list-tools") {
    const filter = rest[1] ? new RegExp(rest[1], "i") : null;
    let cursor;
    const tools = [];
    do {
      const r = await request("tools/list", cursor ? { cursor } : {}, 120_000);
      tools.push(...(r.tools || []));
      cursor = r.nextCursor;
    } while (cursor);
    for (const t of tools) {
      if (filter && !filter.test(t.name)) continue;
      console.log(`### ${t.name}\n${(t.description || "").slice(0, 400)}\n${JSON.stringify(t.inputSchema)}\n`);
    }
    process.stderr.write(`[tools] ${tools.length} total\n`);
  } else if (mode === "run") {
    const batch = JSON.parse(readFileSync(rest[1], "utf8"));
    const outDir = rest[2] || ".";
    mkdirSync(outDir, { recursive: true });
    let i = 0;
    for (const call of batch) {
      i++;
      const label = `${String(i).padStart(2, "0")}-${call.id || call.tool}`;
      const started = Date.now();
      try {
        const r = await request("tools/call", { name: call.tool, arguments: call.arguments || {} }, call.timeoutMs || 0);
        const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
        writeFileSync(join(outDir, `${label}.json`), text || JSON.stringify(r, null, 2));
        console.log(`${label}: ok ${((Date.now() - started) / 1000).toFixed(1)}s ${text.length} bytes${r.isError ? " (isError)" : ""}`);
      } catch (e) {
        writeFileSync(join(outDir, `${label}.error.txt`), String(e));
        console.log(`${label}: FAILED ${((Date.now() - started) / 1000).toFixed(1)}s ${String(e).slice(0, 300)}`);
        if (call.stopOnError) break;
      }
    }
  } else if (mode === "watch") {
    // Long-lived session driven by files: drop <queueDir>/req-<name>.json containing
    // { "tool": ..., "arguments": {...} } (or an array of such calls); the result lands in
    // <queueDir>/res-<name>.json (array of results, text content extracted) and the request
    // file is renamed to done-<name>.json. Create <queueDir>/stop to end the session.
    const { readdirSync, renameSync, existsSync, statSync } = await import("node:fs");
    const queueDir = rest[1];
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, "ready"), new Date().toISOString());
    process.stderr.write(`[watch] queue=${queueDir}\n`);
    for (;;) {
      if (existsSync(join(queueDir, "stop"))) break;
      const reqs = readdirSync(queueDir).filter((f) => /^req-.*\.json$/.test(f)).sort();
      if (reqs.length === 0) { await new Promise((r) => setTimeout(r, 500)); continue; }
      for (const f of reqs) {
        const name = f.slice(4, -5);
        const path = join(queueDir, f);
        // wait until the writer finished (size stable for 300ms)
        let size = -1; for (;;) { const s = statSync(path).size; if (s === size) break; size = s; await new Promise((r) => setTimeout(r, 300)); }
        let calls;
        try { calls = JSON.parse(readFileSync(path, "utf8")); } catch (e) { writeFileSync(join(queueDir, `res-${name}.json`), JSON.stringify({ error: `bad request json: ${e}` })); renameSync(path, join(queueDir, `done-${name}.json`)); continue; }
        if (!Array.isArray(calls)) calls = [calls];
        const results = [];
        for (const call of calls) {
          const started = Date.now();
          try {
            const r = await request("tools/call", { name: call.tool, arguments: call.arguments || {} }, call.timeoutMs || 0);
            const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
            let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
            results.push({ id: call.id || call.tool, ok: !r.isError, seconds: (Date.now() - started) / 1000, result: parsed });
          } catch (e) {
            results.push({ id: call.id || call.tool, ok: false, seconds: (Date.now() - started) / 1000, error: String(e) });
          }
        }
        writeFileSync(join(queueDir, `res-${name}.json`), JSON.stringify(results, null, 1));
        renameSync(path, join(queueDir, `done-${name}.json`));
        process.stderr.write(`[watch] ${name}: ${results.map((r) => `${r.id}=${r.ok ? "ok" : "FAIL"}(${r.seconds.toFixed(1)}s)`).join(" ")}\n`);
      }
    }
    process.stderr.write("[watch] stop requested\n");
  } else {
    console.error("unknown mode");
  }
  child.stdin.end();
  setTimeout(() => child.kill(), 2000).unref();
}

main().catch((e) => { console.error(e); child.kill(); process.exit(1); });
