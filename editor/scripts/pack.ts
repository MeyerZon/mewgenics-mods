#!/usr/bin/env node
// npm run pack -- <mod> [--force] [--init] [--out <dir>]
//   Build the mod's SWFs, validate it and write editor/data/dist/<mod>-<version>.zip (docs/data-mods.md "Shipping a mod").
// npm run pack -- --install <zip> [--into <dir>] [--yes]
//   Unpack a mod zip into mods/<name>/ (or <dir>/<name>/) after checking it. On a game-build mismatch it asks
//   (interactive terminal) or refuses (exit 3) unless --yes.
// Exit codes: 0 done, 1 refused / failed, 2 usage, 3 build mismatch not accepted.

import { createInterface } from "node:readline/promises";
import { packMod, installMod } from "../src/core/pack.ts";
import type { InstallResult } from "../src/core/pack.ts";

const USAGE = `usage:
  npm run pack -- <mod> [--force] [--init] [--out <dir>]
      builds art/*.scene.json, runs validate_mod (refuses on errors unless --force) and writes
      editor/data/dist/<mod>-<version>.zip (mod folder minus tests/ and art/, + README-INSTALL.txt, MANIFEST.sha256).
      --init drafts mods/<mod>/mod.json from description.json when it is missing.
  npm run pack -- --install <zip> [--into <dir>] [--yes]
      checks the zip (paths, size, mod.json, checksums, game build) and unpacks it into mods/<name>/
      (or <dir>/<name>/). Never overwrites an existing folder. --yes accepts a game-build mismatch.`;

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) { console.error(`${flag} needs a value\n${USAGE}`); process.exit(2); }
  args.splice(i, 2);
  return v;
}
function flag(args: string[], f: string): boolean {
  const i = args.indexOf(f);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function printInstall(r: InstallResult): void {
  if (r.ok) {
    console.log(`installed ${r.name} ${r.version} -> ${r.dir} (${r.files.length} files; build ${r.build.status})`);
    for (const n of r.notes) console.log(`  note: ${n}`);
    if (r.report) console.log(`  validate_mod: ${r.report.counts.errors} error(s), ${r.report.counts.warnings} warning(s), ${r.report.counts.infos} info(s)`);
  } else if (r.verdict === "refused") console.error(`refused (${r.code}): ${r.reason}`);
  else console.error(`build mismatch: ${r.prompt}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || flag(args, "--help") || flag(args, "-h")) { console.log(USAGE); return; }
  const zip = arg(args, "--install");
  if (zip !== undefined) {
    const into = arg(args, "--into");
    const yes = flag(args, "--yes");
    if (args.length) { console.error(`unexpected arguments: ${args.join(" ")}\n${USAGE}`); process.exit(2); }
    let r = installMod(zip, { into, acceptBuildMismatch: yes });
    if (!r.ok && r.verdict === "build-mismatch") {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question(`${r.prompt} [y/N] `)).trim().toLowerCase();
        rl.close();
        if (answer === "y" || answer === "yes") r = installMod(zip, { into, acceptBuildMismatch: true });
      }
      if (!r.ok && r.verdict === "build-mismatch") { printInstall(r); console.error("not installed (pass --yes to accept)"); process.exitCode = 3; return; }
    }
    printInstall(r);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  const force = flag(args, "--force");
  const init = flag(args, "--init");
  const outDir = arg(args, "--out");
  if (args.length !== 1 || args[0]!.startsWith("--")) { console.error(USAGE); process.exit(2); }
  const r = packMod(args[0]!, { force, init, outDir });
  if (r.initialized) console.log(`wrote a draft mods/${r.mod}/mod.json — review it (license, description, gameBuild)`);
  for (const b of r.builds ?? []) console.log(`  swf ${b.ok ? "built" : "FAILED"}: ${b.scene}${b.error ? ` (${b.error})` : ""}`);
  if (r.report) console.log(`  validate_mod: ${r.report.counts.errors} error(s), ${r.report.counts.warnings} warning(s), ${r.report.counts.infos} info(s)`);
  for (const w of r.warnings ?? []) console.log(`  forced past: ${w}`);
  if (!r.ok) { console.error(`refused (${r.refused?.code}): ${r.refused?.message}`); process.exitCode = 1; return; }
  console.log(`packed ${r.zipPath} (${r.bytes} bytes, ${r.entries?.length} entries, sha256 ${r.sha256})`);
}

await main();
