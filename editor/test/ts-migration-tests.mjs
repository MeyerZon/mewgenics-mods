// The TypeScript migration's structural T0 (docs/editor-ts-react-plan.md, PR 2): no JavaScript
// source left except the MCP registration shim, the toolchain configured for TS-only, and the
// MCP tool input schemas generated from zod (golden: test/fixtures/mcp-tool-schemas.json, the
// hand-written schemas as they were before the migration — the wire contract must not change).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR = join(HERE, "..");
const REPO = join(EDITOR, "..");

/** @param {string} dir @param {string[]} out */
function jsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "data") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) jsFiles(p, out);
    else if (/\.(mjs|cjs|js)$/.test(name)) out.push(relative(REPO, p).split(sep).join("/"));
  }
  return out;
}

/** A failing import becomes a failing test. @param {string} rel */
async function load(rel) {
  try {
    return await import(rel);
  } catch (e) {
    return { __error: String(e instanceof Error ? e.message : e) };
  }
}

/**
 * The parts of a JSON Schema that are the MCP contract: property names and their types/enums,
 * the required set, and additionalProperties.
 * @param {any} schema
 */
function contract(schema) {
  const props = schema && schema.properties ? schema.properties : {};
  /** @type {Record<string, string>} */
  const typed = {};
  for (const k of Object.keys(props).sort()) {
    const p = props[k];
    typed[k] = p.enum ? `enum(${[...p.enum].sort().join("|")})` : Array.isArray(p.type) ? p.type.slice().sort().join("|") : String(p.type);
  }
  return {
    type: schema.type,
    props: typed,
    required: [...(schema.required || [])].sort(),
    additionalProperties: schema.additionalProperties,
  };
}

/**
 * @param {(name: string, fn: () => void) => void} test
 * @param {(cond: boolean, msg: string) => void} assert
 * @param {(a: unknown, b: unknown, msg?: string) => void} eq
 */
export async function runTsMigrationTests(test, assert, eq) {
  console.log("\n# TypeScript migration: no JS source left, TS-only toolchain, MCP schemas from zod");

  test("no .mjs/.js source remains under editor/{src,scripts,test,web} and tools/bindings except the MCP shim src/mcp/server.mjs", () => {
    const found = [
      ...jsFiles(join(EDITOR, "src")),
      ...jsFiles(join(EDITOR, "scripts")),
      ...jsFiles(join(EDITOR, "test")),
      ...jsFiles(join(EDITOR, "web")),
      ...jsFiles(join(REPO, "tools", "bindings")),
    ].filter((p) => p !== "editor/src/mcp/server.mjs");
    eq(found.length, 0, `JS files left: ${found.slice(0, 8).join(", ")}${found.length > 8 ? ` … (+${found.length - 8})` : ""}`);
  });

  test("src/mcp/server.mjs is a short shim importing ./server.ts (the registered path keeps working)", () => {
    const p = join(EDITOR, "src", "mcp", "server.mjs");
    assert(existsSync(p), "shim exists");
    const text = readFileSync(p, "utf8");
    assert(/import\s+["']\.\/server\.ts["']/.test(text), "shim imports ./server.ts");
    assert(text.split("\n").length <= 12, "shim is a few lines, not a copy of the server");
    assert(existsSync(join(EDITOR, "src", "mcp", "server.ts")), "server.ts exists");
  });

  test("package.json scripts point at .ts entry points and the README registration names server.ts", () => {
    const pkg = JSON.parse(readFileSync(join(EDITOR, "package.json"), "utf8"));
    const bad = Object.entries(pkg.scripts).filter(([, v]) => /\.(mjs|js)\b/.test(String(v)));
    eq(bad.length, 0, `scripts still naming JS files: ${bad.map(([k, v]) => `${k}=${v}`).join("; ")}`);
    assert(pkg.devDependencies && pkg.devDependencies["@types/node"], "@types/node is a devDependency");
    const readme = readFileSync(join(REPO, "README.md"), "utf8");
    assert(/editor\/src\/mcp\/server\.ts/.test(readme), "README's `claude mcp add` line names server.ts");
  });

  test("tsconfig is TS-only: no allowJs/checkJs, types: [node], the hand-written node shims are gone", () => {
    const ts = JSON.parse(readFileSync(join(EDITOR, "tsconfig.json"), "utf8"));
    assert(!ts.compilerOptions.allowJs && !ts.compilerOptions.checkJs, "allowJs/checkJs off");
    assert(Array.isArray(ts.compilerOptions.types) && ts.compilerOptions.types.includes("node"), "types includes node");
    assert(ts.compilerOptions.erasableSyntaxOnly === true, "erasableSyntaxOnly (Node runs the source)");
    assert(!existsSync(join(EDITOR, "types", "node-shims.d.ts")), "types/node-shims.d.ts deleted");
    const inc = (ts.include || []).join(" ");
    assert(!/\.mjs|\.js\b/.test(inc.replace(/\.d\.ts/g, "")), `include lists no JS globs: ${inc}`);
  });

  // ---- MCP tool schemas from zod -----------------------------------------------------------
  const golden = JSON.parse(readFileSync(join(HERE, "fixtures", "mcp-tool-schemas.json"), "utf8"));
  const tools = await load("../src/mcp/tools.ts");
  const { z } = await import("zod");
  test("src/mcp/tools.ts loads and exports TOOLS, TOOL_INPUT (name → zod schema) and callTool", () => {
    assert(!tools.__error, tools.__error);
    assert(Array.isArray(tools.TOOLS), "TOOLS");
    assert(tools.TOOL_INPUT && typeof tools.TOOL_INPUT === "object", "TOOL_INPUT");
    assert(typeof tools.callTool === "function", "callTool");
  });
  test("every tool has a zod input schema and its published inputSchema is generated from it", () => {
    if (tools.__error) throw new Error("tools.ts did not load");
    for (const t of tools.TOOLS) {
      const zs = tools.TOOL_INPUT[t.name];
      assert(!!zs, `${t.name}: zod schema`);
      const gen = z.toJSONSchema(zs);
      delete gen.$schema;
      eq(JSON.stringify(contract(t.inputSchema)), JSON.stringify(contract(gen)), `${t.name}: inputSchema is the zod-generated one`);
      assert(!("$schema" in t.inputSchema), `${t.name}: no $schema key on the wire`);
    }
  });
  test("the generated schemas keep the pre-migration contract (golden fixture: names, property types, required, additionalProperties:false)", () => {
    if (tools.__error) throw new Error("tools.ts did not load");
    eq(tools.TOOLS.map((/** @type {any} */ t) => t.name).join(","), golden.map((/** @type {any} */ g) => g.name).join(","), "tool names and order");
    for (const g of golden) {
      const t = tools.TOOLS.find((/** @type {any} */ x) => x.name === g.name);
      eq(JSON.stringify(contract(t.inputSchema)), JSON.stringify(contract(g.inputSchema)), `${g.name}: contract`);
    }
  });
  // callTool validates synchronously (throws before any handler promise exists), so the sync harness sees it.
  test("callTool validates arguments with zod before dispatch: a wrong type is a ToolError naming the argument", () => {
    if (tools.__error) throw new Error("tools.ts did not load");
    let msg = "";
    try {
      tools.callTool("list_base_data", { category: 1 });
    } catch (e) {
      msg = String(e instanceof Error ? e.message : e);
      assert(e instanceof tools.ToolError, `ToolError, got ${e && e.constructor && e.constructor.name}`);
    }
    assert(/category/.test(msg), `message names the argument: ${msg}`);
    let msg2 = "";
    try {
      tools.callTool("read_base_entry", {});
    } catch (e) {
      msg2 = String(e instanceof Error ? e.message : e);
    }
    assert(/category/.test(msg2) && /name/.test(msg2), `missing required args named: ${msg2}`);
    let msg3 = "";
    try {
      tools.callTool("no_such_tool", {});
    } catch (e) {
      msg3 = String(e instanceof Error ? e.message : e);
    }
    assert(/no_such_tool/.test(msg3), `unknown tool named: ${msg3}`);
  });
}
