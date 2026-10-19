#!/usr/bin/env node
// Local web server for the Mewgenics mod editor UI.
//
// Node built-ins only. Binds to 127.0.0.1. Serves the static UI from this folder
// and exposes a thin JSON bridge (/api/*) over src/core — the SAME core the MCP
// server uses, so neither adapter reimplements GON or validation. All writes go
// through the core, which confines them to mods/<name>/ and refuses saves/ and
// the protected game files.

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import * as api from "../src/core/api.mjs";

const WEB_DIR = dirname(fileURLToPath(import.meta.url));
// Pure, browser-safe core modules the Preview panel imports so it renders from the
// SAME scene/timeline/geometry code the emitter uses. Read-only allowlist; nothing
// else under src/ is reachable from the browser.
const CORE_ART_DIR = join(WEB_DIR, "..", "src", "core", "art");
const CORE_ART_PUBLIC = new Set(["geometry.mjs", "scene.mjs", "timeline.mjs"]);
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);

/** @type {Record<string, string>} */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<any>} */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 8_000_000) reject(new Error("request body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** @param {import('node:http').ServerResponse} res @param {string} relUrl */
function serveStatic(res, relUrl) {
  let rel = relUrl.split("?")[0];
  if (rel === "/" || rel === "") rel = "/index.html";
  if (rel.startsWith("/src/core/art/")) {
    const name = rel.slice("/src/core/art/".length);
    if (!CORE_ART_PUBLIC.has(name)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[".mjs"] });
    res.end(readFileSync(join(CORE_ART_DIR, name)));
    return;
  }
  const abs = normalize(join(WEB_DIR, rel));
  if (!abs.startsWith(WEB_DIR)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  const type = MIME[extname(abs).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  res.end(readFileSync(abs));
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 */
async function handleApi(req, res, url) {
  const q = url.searchParams;
  const method = req.method || "GET";
  try {
    if (method === "GET" && url.pathname === "/api/base") {
      const category = q.get("category");
      return sendJson(res, 200, category ? api.listBaseEntries(category, q.get("filter") || undefined) : api.listBaseData());
    }
    if (method === "GET" && url.pathname === "/api/base-entry") {
      return sendJson(res, 200, api.readBaseEntry(q.get("category") || "", q.get("name") || ""));
    }
    if (method === "GET" && url.pathname === "/api/components") {
      return sendJson(res, 200, api.searchComponents(q.get("query") || "", {
        whereUsed: q.get("whereUsed") === "1" || q.get("whereUsed") === "true",
        limit: q.get("limit") ? Number(q.get("limit")) : undefined,
      }));
    }
    if (method === "GET" && url.pathname === "/api/mods") {
      return sendJson(res, 200, api.listMods());
    }
    if (method === "GET" && url.pathname === "/api/mod") {
      return sendJson(res, 200, api.readMod(q.get("mod") || "", { includeText: q.get("includeText") === "1" }));
    }
    if (method === "GET" && url.pathname === "/api/mod-file") {
      return sendJson(res, 200, api.readModFile(q.get("mod") || "", q.get("path") || ""));
    }
    if (method === "GET" && url.pathname === "/api/registered") {
      return sendJson(res, 200, api.listRegisteredNativeNames());
    }
    if (method === "POST" && url.pathname === "/api/write") {
      const b = await readBody(req);
      return sendJson(res, 200, api.writeOverlay(b.mod, b.path, b.content));
    }
    if (method === "POST" && url.pathname === "/api/validate") {
      const b = await readBody(req);
      const override = b.path !== undefined && b.text !== undefined ? { relPath: b.path, text: b.text } : undefined;
      return sendJson(res, 200, api.validate(b.mod, override));
    }
    if (method === "POST" && url.pathname === "/api/preview") {
      const b = await readBody(req);
      return sendJson(res, 200, api.preview(b.mod, b.path, { overrideText: b.text, includeFullGon: b.includeFullGon }));
    }
    if (method === "POST" && url.pathname === "/api/template") {
      const b = await readBody(req);
      return sendJson(res, 200, api.newFromTemplate(b.mod, b.kind, b.name, b.options || {}));
    }
    // ---- art pipeline (additive; docs/art-preview-plan.md §4) ----------------
    if (method === "GET" && url.pathname === "/api/art/scenes") {
      return sendJson(res, 200, api.listArtScenes(q.get("mod") || ""));
    }
    if (method === "GET" && url.pathname === "/api/art/scene") {
      return sendJson(res, 200, api.readArtScene(q.get("mod") || "", q.get("path") || ""));
    }
    if (method === "POST" && url.pathname === "/api/art/scene") {
      const b = await readBody(req);
      return sendJson(res, 200, api.writeArtScene(b.mod, b.path, b.scene, { force: !!b.force }));
    }
    if (method === "POST" && url.pathname === "/api/art/new-scene") {
      const b = await readBody(req);
      return sendJson(res, 200, api.newArtScene(b.mod, b.name, { starter: b.starter !== false }));
    }
    if (method === "POST" && url.pathname === "/api/art/validate") {
      const b = await readBody(req);
      return sendJson(res, 200, api.validateArtScene(b.scene));
    }
    if (method === "POST" && url.pathname === "/api/art/import-svg") {
      const b = await readBody(req);
      return sendJson(res, 200, api.importSvgShape({ svgText: b.svgText, mod: b.mod, relPath: b.path, options: b.options || {} }));
    }
    if (method === "POST" && url.pathname === "/api/art/build") {
      const b = await readBody(req);
      return sendJson(res, 200, api.buildSwf(b.mod, b.path, { abc: b.abc, overrideScene: b.scene, writeSwflist: b.writeSwflist, dryRun: !!b.dryRun }));
    }
    if (method === "GET" && url.pathname === "/api/art/inspect-swf") {
      return sendJson(res, 200, api.inspectSwf(q.get("mod") || "", q.get("path") || ""));
    }
    if (method === "GET" && url.pathname === "/api/art/palette") {
      return sendJson(res, 200, api.readArtPalette(q.get("which") === "fx_palette" ? "fx_palette" : "palette"));
    }
    if (method === "GET" && url.pathname === "/api/art/asset") {
      const r = api.readArtAsset(q.get("mod") || "", q.get("path") || "");
      if (!r.ok) return sendJson(res, 404, { error: r.error });
      res.writeHead(200, { "Content-Type": r.mime, "Cache-Control": "no-store" });
      res.end(r.bytes);
      return;
    }
    if (method === "POST" && url.pathname === "/api/art/asset") {
      // body: { mod, path, base64 } — an uploaded SVG/PNG goes into mods/<mod>/art/
      const b = await readBody(req);
      const bytes = new Uint8Array(Buffer.from(String(b.base64 || ""), "base64"));
      return sendJson(res, 200, api.writeArtAsset(b.mod, b.path, bytes));
    }
    if (method === "POST" && url.pathname === "/api/art/prepare-swf-gate") {
      const b = await readBody(req);
      return sendJson(res, 200, api.prepareSwfGate({ mod: b.mod || undefined, variant: b.variant || "flat" }));
    }
    return sendJson(res, 404, { error: `no route: ${method} ${url.pathname}` });
  } catch (e) {
    return sendJson(res, 400, { error: String(e instanceof Error ? e.message : e) });
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    void handleApi(req, res, url);
  } else {
    serveStatic(res, req.url || "/");
  }
});

server.listen(PORT, HOST, () => {
  process.stderr.write(`Mewgenics mod editor UI: http://${HOST}:${PORT}/\n`);
});
