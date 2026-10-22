#!/usr/bin/env node
// Local web server for the Mewgenics mod editor UI.
//
// Node built-ins + zod. Binds to 127.0.0.1. Serves the Vite build from web/dist/ and
// exposes a thin JSON bridge (/api/*) over src/core — the SAME core the MCP server uses,
// so neither adapter reimplements GON or validation. Every POST body is parsed by the
// route's zod schema (src/core/api-schemas.ts) before a handler sees it: a bad body is a
// 400 with the issues, never a stack trace. All writes go through the core, which confines
// them to mods/<name>/ and refuses saves/ and the protected game files.
//
// PORT=0 picks a free port (the test suite does this); the bound port is announced on stderr.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import * as api from "../src/core/api.ts";
import { parseBody, BodyError, type ApiBody, type PostRoute } from "../src/core/api-schemas.ts";

const WEB_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(WEB_DIR, "dist");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer | string) => {
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

/** Read + validate a POST body for a route. */
async function body<R extends PostRoute>(route: R, req: IncomingMessage): Promise<ApiBody<R>> {
  return parseBody(route, await readBody(req));
}

function serveStatic(res: ServerResponse, relUrl: string): void {
  let rel = relUrl.split("?")[0]!;
  if (rel === "/" || rel === "") rel = "/index.html";
  if (!existsSync(join(DIST_DIR, "index.html"))) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("The UI is not built: run `npm run build` in editor/ (or `npm run dev` for the hot-reloading Vite server).\n");
    return;
  }
  const abs = normalize(join(DIST_DIR, rel));
  if (!abs.startsWith(DIST_DIR)) {
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

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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
      const b = await body("/api/write", req);
      return sendJson(res, 200, api.writeOverlay(b.mod, b.path, b.content));
    }
    if (method === "POST" && url.pathname === "/api/validate") {
      const b = await body("/api/validate", req);
      const override = b.path !== undefined && b.text !== undefined ? { relPath: b.path, text: b.text } : undefined;
      return sendJson(res, 200, api.validate(b.mod, override));
    }
    if (method === "POST" && url.pathname === "/api/preview") {
      const b = await body("/api/preview", req);
      return sendJson(res, 200, api.preview(b.mod, b.path, { overrideText: b.text, includeFullGon: b.includeFullGon }));
    }
    if (method === "POST" && url.pathname === "/api/template") {
      const b = await body("/api/template", req);
      return sendJson(res, 200, api.newFromTemplate(b.mod, b.kind, b.name, b.options));
    }
    // ---- art pipeline (docs/art-preview-plan.md §4) --------------------------
    if (method === "GET" && url.pathname === "/api/art/scenes") {
      return sendJson(res, 200, api.listArtScenes(q.get("mod") || ""));
    }
    if (method === "GET" && url.pathname === "/api/art/scene") {
      return sendJson(res, 200, api.readArtScene(q.get("mod") || "", q.get("path") || ""));
    }
    if (method === "POST" && url.pathname === "/api/art/scene") {
      const b = await body("/api/art/scene", req);
      return sendJson(res, 200, api.writeArtScene(b.mod, b.path, b.scene, { force: !!b.force }));
    }
    if (method === "POST" && url.pathname === "/api/art/new-scene") {
      const b = await body("/api/art/new-scene", req);
      return sendJson(res, 200, api.newArtScene(b.mod, b.name, { starter: b.starter !== false, template: b.template, animation: b.animation }));
    }
    if (method === "POST" && url.pathname === "/api/art/validate") {
      const b = await body("/api/art/validate", req);
      return sendJson(res, 200, api.validateArtScene(b.scene));
    }
    if (method === "POST" && url.pathname === "/api/art/import-svg") {
      const b = await body("/api/art/import-svg", req);
      return sendJson(res, 200, api.importSvgShape({ svgText: b.svgText, mod: b.mod, relPath: b.path, options: b.options }));
    }
    if (method === "POST" && url.pathname === "/api/art/export-svg") {
      const b = await body("/api/art/export-svg", req);
      return sendJson(res, 200, api.exportShapeSvg(b.mod, b.path, b.shapeId));
    }
    if (method === "POST" && url.pathname === "/api/art/build") {
      const b = await body("/api/art/build", req);
      return sendJson(res, 200, api.buildSwf(b.mod, b.path, { abc: b.abc, overrideScene: b.scene, writeSwflist: b.writeSwflist, dryRun: !!b.dryRun }));
    }
    if (method === "GET" && url.pathname === "/api/art/inspect-swf") {
      return sendJson(res, 200, api.inspectSwf(q.get("mod") || "", q.get("path") || ""));
    }
    if (method === "GET" && url.pathname === "/api/art/vanilla-swfs") {
      return sendJson(res, 200, api.listVanillaSwfs());
    }
    if (method === "GET" && url.pathname === "/api/art/vanilla-swf") {
      const r = api.readVanillaSwf(q.get("name") || "");
      if (!r.ok) return sendJson(res, 404, r);
      res.writeHead(200, { "Content-Type": "application/x-shockwave-flash", "Cache-Control": "no-store" });
      res.end(r.bytes);
      return;
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
      // an uploaded SVG/PNG goes into mods/<mod>/art/
      const b = await body("/api/art/asset", req);
      const bytes = new Uint8Array(Buffer.from(b.base64, "base64"));
      return sendJson(res, 200, api.writeArtAsset(b.mod, b.path, bytes));
    }
    if (method === "POST" && url.pathname === "/api/art/prepare-swf-gate") {
      const b = await body("/api/art/prepare-swf-gate", req);
      return sendJson(res, 200, api.prepareSwfGate({ mod: b.mod || undefined, variant: b.variant }));
    }
    // ---- rooms: levels/**/*.lvl (the Room editor) ------------------------------
    if (method === "GET" && url.pathname === "/api/levels") {
      return sendJson(res, 200, api.listLevels(q.get("mod") || ""));
    }
    if (method === "GET" && url.pathname === "/api/level") {
      return sendJson(res, 200, api.readLevel(q.get("mod") || "", q.get("path") || ""));
    }
    if (method === "GET" && url.pathname === "/api/level-palette") {
      return sendJson(res, 200, api.levelPalette(q.get("mod") || ""));
    }
    if (method === "POST" && url.pathname === "/api/level") {
      const b = await body("/api/level", req);
      return sendJson(res, 200, api.writeLevel(b.mod, b.path, b.level, { dryRun: !!b.dryRun }));
    }
    if (method === "POST" && url.pathname === "/api/level/validate") {
      const b = await body("/api/level/validate", req);
      return sendJson(res, 200, api.validateLevel(b.mod, b.path, b.level));
    }
    return sendJson(res, 404, { error: `no route: ${method} ${url.pathname}` });
  } catch (e) {
    if (e instanceof BodyError) return sendJson(res, 400, { error: e.message, issues: e.issues });
    return sendJson(res, 400, { error: String(e instanceof Error ? e.message : e) });
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT || 1}`);
  if (url.pathname.startsWith("/api/")) {
    void handleApi(req, res, url);
  } else {
    serveStatic(res, req.url || "/");
  }
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : PORT;
  process.stderr.write(`Mewgenics mod editor UI: http://${HOST}:${port}/\n`);
});
