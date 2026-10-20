#!/usr/bin/env node
// Is the installed Mewgenics.exe a build bindings/ knows, and does every signature still hold?
//   node tools/bindings/check-build.ts [exe] [--all] [--json]
// Exit 0: known build and every signature ok. 1: unknown build or a signature moved/missing/
// ambiguous. 2: nothing to check (exe or manifests absent). Read-only; never launches the game.
import { checkInstalledBuild } from "../../editor/src/core/bindings/check.ts";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const all = argv.includes("--all");
const exePath = argv.find((a) => !a.startsWith("--"));
const r = checkInstalledBuild(exePath ? { exePath } : {});
if (json) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(!r.ok ? 2 : r.known && r.summary.ok === r.entries.length ? 0 : 1);
}
if (!r.ok) {
  console.log(`(skipped: ${r.reason})`);
  process.exit(2);
}
const b = r.build;
console.log(`exe: ${r.exePath}`);
console.log(`identity: TimeDateStamp ${b.timeDateStamp}, SizeOfImage ${b.sizeOfImage}, sha256 ${r.sha256.slice(0, 16)}...`);
if (b.matched) console.log(`build: KNOWN  ${b.matched.name} (bindings/${b.matched.steamBuildId}.json)`);
else console.log(`build: UNKNOWN  (known: ${b.knownBuilds.map((k) => k.steamBuildId).join(", ") || "none"}); signatures scanned with bindings/${b.scannedWith}.json`);
const s = r.summary;
console.log(`signatures: ${s.ok} ok, ${s.moved} moved, ${s.missing} missing, ${s.ambiguous} ambiguous (${s.unscanned} entries have no signature)`);
for (const e of r.entries) {
  if (e.status === "ok" && !all) continue;
  console.log(`  ${e.status.padEnd(9)} ${e.name.padEnd(34)} expected ${e.expected}${e.hit ? ` hit ${e.hit}` : ""}${e.matches > 1 ? ` (${e.matches} matches)` : ""}${e.detail ? ` ${e.detail}` : ""}`);
}
process.exit(r.known && s.ok === r.entries.length ? 0 : 1);
