#!/usr/bin/env node
// Writes the DoABC gate-test fixtures (docs/art-preview-plan.md §7) into
// mods/dev-sandbox/ (or the mod named as argv[2]). Nothing is launched: the user runs
// the procedure in the plan. Only mods/<mod>/ is written.
import { prepareAbcGateTest } from "../src/core/api.mjs";

const mod = process.argv[2] || "dev-sandbox";
const r = prepareAbcGateTest(mod);
if (!r.ok) {
  process.stderr.write(`failed: ${r.error}\n`);
  process.exit(1);
}
process.stdout.write(`wrote:\n${(r.written || []).map((w) => "  " + w).join("\n")}\n`);
process.stdout.write(`linkage ${r.linkage}, frame label ${r.label}\n${r.note}\nProcedure: ${r.procedure}\n`);
