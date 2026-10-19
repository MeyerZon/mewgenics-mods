#!/usr/bin/env node
// The real cross-build check (docs/binding-port.md "T1 cross-build"): port the committed manifest of
// one genuine build onto another genuine build and print the report. Nothing is written.
//   node tools/bindings/cross-build.mjs --old <Mewgenics.exe of the manifest's build> --new <other Mewgenics.exe> [--build <id>] [--gameVersion <x.y.z>]
// Getting a second build without extra tools: in the Steam client console (steam://open/console):
//   download_depot 686060 <depotId> <manifestId>     (ids from SteamDB's depot history for app 686060)
// Steam prints where it put the files; copy Mewgenics.exe to .analysis/exe/<build>/ (git-ignored).
// Exit 0 when nothing non-offset is ambiguous/failed, 1 otherwise.
import { readFileSync } from "node:fs";
import { parsePe } from "../../editor/src/core/bindings/pe.mjs";
import { listManifests } from "../../editor/src/core/bindings/manifest.mjs";
import { portManifest, renderPortReport } from "../../editor/src/core/bindings/port.mjs";
import { parseCrossBuildArgs } from "./cross-build-args.mjs";

const args = parseCrossBuildArgs(process.argv.slice(2));
if (args.error || !args.oldPath || !args.newPath) {
  console.error(args.error);
  process.exit(2);
}
const { oldPath, newPath } = args;
const oldPe = parsePe(readFileSync(oldPath));
const manifests = listManifests().map((x) => x.manifest);
const m = manifests.find((x) => parseInt(x.build.timeDateStamp, 16) === oldPe.timeDateStamp && parseInt(x.build.sizeOfImage, 16) === oldPe.sizeOfImage);
if (!m) {
  console.error(`no manifest matches the old exe (TimeDateStamp 0x${oldPe.timeDateStamp.toString(16)}, SizeOfImage 0x${oldPe.sizeOfImage.toString(16)}); known: ${manifests.map((x) => x.build.steamBuildId).join(", ")}`);
  process.exit(2);
}
const newBuf = readFileSync(newPath);
const newPe = parsePe(newBuf);
const r = portManifest(m, newPe, newBuf, { steamBuildId: args.build, gameVersion: args.gameVersion });
console.log(renderPortReport(r, { generatedAt: new Date().toISOString() }));
const bad = r.rows.filter((x) => (x.status === "ambiguous" || x.status === "failed") && x.kind !== "offset");
console.log(`\ncross-build ${m.build.steamBuildId} -> new exe: ${bad.length} non-offset entries ambiguous/failed`);
process.exit(bad.length ? 1 : 0);
