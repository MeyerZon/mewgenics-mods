#!/usr/bin/env node
// Writes the generated test tones mods/_audioprobe needs (WAV files are git-ignored: `*.wav` in .gitignore, so the
// repo carries this generator instead of the audio). Node built-ins only; run from editor/:
//   node scripts/audio-probe-tones.ts            write the tones (idempotent)
//   node scripts/audio-probe-tones.ts --check    exit 1 when a tone is missing or differs
// The T2 scripts in mods/_audioprobe/tests/ run it first through `npm run test:audioprobe`... or by hand.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODS_DIR } from "../src/core/repo.ts";
import { makeToneWav } from "../src/core/audio/wav.ts";
import type { ToneSpec } from "../src/core/audio/wav.ts";

/** mod-relative path -> tone. Frequencies are distinct so a listener can tell them apart. */
export const AUDIOPROBE_TONES: Record<string, ToneSpec> = {
  // (b) a NEW sound file, referenced by the new AudioProbe_New group in audio/combat_sfx.gon.merge
  "audio/combat_sfx/audioprobe_new.wav": { freq: 660, seconds: 0.4 },
  // (a) a vanilla file replaced at its mirrored path (PickupCoin's SE_PickupCoin plays pickup_coin.wav)
  "audio/combat_sfx/pickup_coin.wav": { freq: 1320, seconds: 0.25, sampleRate: 48000 },
};

export function writeAudioProbeTones(modDir: string = join(MODS_DIR, "_audioprobe"), check = false): string[] {
  const problems: string[] = [];
  for (const [rel, spec] of Object.entries(AUDIOPROBE_TONES)) {
    const abs = join(modDir, rel);
    const bytes = makeToneWav(spec);
    if (check) {
      if (!existsSync(abs)) problems.push(`${rel}: missing`);
      else if (!Buffer.from(readFileSync(abs)).equals(Buffer.from(bytes))) problems.push(`${rel}: differs from the generator`);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
  return problems;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")}` || process.argv[1]?.endsWith("audio-probe-tones.ts")) {
  const check = process.argv.includes("--check");
  const problems = writeAudioProbeTones(undefined, check);
  if (check) {
    for (const p of problems) console.log(p);
    console.log(problems.length ? `${problems.length} tone(s) missing or stale: run node scripts/audio-probe-tones.ts` : "tones up to date");
    process.exit(problems.length ? 1 : 0);
  }
  console.log(`wrote ${Object.keys(AUDIOPROBE_TONES).length} tone(s) under mods/_audioprobe/audio/`);
}
