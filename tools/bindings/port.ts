#!/usr/bin/env node
// Port a bindings manifest to a new game build.
//   node tools/bindings/port.ts --from bindings/<old>.json --exe <new Mewgenics.exe> --build <steamBuildId>
//        [--version <gameVersion>] [--resolve name=0xRVA ...] [--dry-run | --apply] [--out bindings/<new>.json]
// --dry-run (default) prints the report; --apply writes bindings/<build>.json and
// bindings/<build>.port-report.md. Never writes anything else. Exit 0 when nothing is ambiguous
// or failed, 1 otherwise, 2 on usage errors.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { parsePe } from "../../editor/src/core/bindings/pe.ts";
import { loadManifest, saveManifest, BINDINGS_DIR } from "../../editor/src/core/bindings/manifest.ts";
import { portManifest, renderPortReport } from "../../editor/src/core/bindings/port.ts";
import { isInside, SafetyError } from "../../editor/src/core/repo.ts";

const argv = process.argv.slice(2);
const opt = (flag: string): string | undefined => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const from = opt("--from");
const exePath = opt("--exe");
const build = opt("--build");
const version = opt("--version");
const apply = argv.includes("--apply");
const resolve: Record<string, string> = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--resolve") {
    const [name, rva] = String(argv[++i]).split("=");
    if (!name || !/^0x[0-9a-fA-F]+$/.test(rva || "")) { console.error(`--resolve needs name=0xRVA, got ${argv[i]}`); process.exit(2); }
    resolve[name] = rva;
  }
}
if (!from || !exePath || !build || !/^\d+$/.test(build)) {
  console.error("usage: node tools/bindings/port.ts --from bindings/<old>.json --exe <new exe> --build <steamBuildId> [--version v] [--resolve name=0xRVA ...] [--apply] [--out path]");
  process.exit(2);
}
const old = loadManifest(from);
const buf = readFileSync(exePath);
const pe = parsePe(buf);
if (parseInt(old.build.timeDateStamp, 16) === pe.timeDateStamp && parseInt(old.build.sizeOfImage, 16) === pe.sizeOfImage && build !== old.build.steamBuildId) {
  console.error(`note: the exe IS build ${old.build.steamBuildId} (self-port)`);
}
const r = portManifest(old, pe, buf, { steamBuildId: build, gameVersion: version, resolve });
const md = renderPortReport(r, { generatedAt: new Date().toISOString() });
console.log(md);
if (apply) {
  const outPath = resolvePath(opt("--out") || join(BINDINGS_DIR, `${build}.json`));
  if (!isInside(BINDINGS_DIR, outPath)) throw new SafetyError(`refusing to write outside bindings/: ${outPath}`);
  saveManifest(outPath, r.manifest);
  const reportPath = outPath.replace(/\.json$/i, ".port-report.md");
  writeFileSync(reportPath, md);
  console.log(`wrote ${outPath} and ${reportPath}`);
} else console.log("(dry run; add --apply to write bindings/<build>.json and the report)");
process.exit(r.needsAgent.length ? 1 : 0);
