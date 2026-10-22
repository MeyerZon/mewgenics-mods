// Particles and VFX (2026-10-22): what a data mod can say about particle effects, and the in-game VFX probe.
//  A. probe-vfx.ts — the pure measure behind `npm run test:artprobe -- --vfx` (synthetic images): the NEW system's
//     #ff0090 dots and the re-pointed SparkleBuff's marker pixels per shot, the motion between shots, and the refusal
//     when the shots are byte-identical (the stale-shot caveat of 2026-10-22);
//  B. particles.ts — the content model the ParticleSystemData decoder (0x9c5970) reads, pinned against vanilla (T1);
//  C. the validator's particle checks (particle-missing, clip-missing, particle-unknown-key) on fixture mods;
//  D. new_from_template particle / vfx-ability;
//  E. mods/_vfxprobe's shape, and the OBSERVED run fixture (editor/test/fixtures/ingame/vfxprobe-summary.json).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODS_DIR, EXTRACTED_DATA } from "../src/core/repo.ts";
import { parse } from "../src/core/gon/parser.ts";
import { toValue } from "../src/core/gon/value.ts";
import { parseScript } from "../src/core/ingame/script.ts";
import { validateMod } from "../src/core/validate/validator.ts";
import { newFromTemplate } from "../src/core/templates.ts";
import type { Report } from "../src/core/validate/result.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "validator");

type Img = { width: number; height: number; rgba: Uint8Array };
function blank(w = 400, h = 300): Img { const rgba = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { rgba[i * 4] = 60; rgba[i * 4 + 1] = 70; rgba[i * 4 + 2] = 50; rgba[i * 4 + 3] = 255; } return { width: w, height: h, rgba }; }
function paint(img: Img, x0: number, y0: number, w: number, h: number, c: [number, number, number]) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue; const i = (y * img.width + x) * 4; img.rgba[i] = c[0]; img.rgba[i + 1] = c[1]; img.rgba[i + 2] = c[2]; }
}
const PINK: [number, number, number] = [255, 0, 144];
/** a few "particles": 8×8 pink squares at the given offsets around (200, 150) */
function dots(img: Img, offs: Array<[number, number]>, c = PINK): Img { for (const [dx, dy] of offs) paint(img, 200 + dx, 150 + dy, 8, 8, c); return img; }
/** a small marker: yellow frame + magenta / cyan cells */
function marker(img: Img, x: number, y: number): Img { paint(img, x, y, 24, 16, [255, 255, 0]); paint(img, x + 3, y + 3, 8, 10, [255, 0, 255]); paint(img, x + 12, y + 3, 8, 10, [0, 255, 255]); return img; }

export async function runParticlesTests(test: TestFn, assert: AssertFn, eq: EqFn): Promise<void> {
  console.log("\n# Particles and VFX: content model, validator, templates, the VFX probe");
  let V: Record<string, any> = {};
  let P: Record<string, any> = {};
  let err = "";
  try { V = await import("../src/core/art/probe-vfx.ts"); } catch (e) { err += `probe-vfx.ts: ${e instanceof Error ? e.message : e}\n`; }
  try { P = await import("../src/core/particles.ts"); } catch (e) { err += `particles.ts: ${e instanceof Error ? e.message : e}\n`; }
  test("probe-vfx.ts and particles.ts load", () => assert(err === "", err));

  // ---- A. the VFX probe measure ----
  const shot = (label: string, img: Img) => ({ label, img });
  test("measureVfx: dots in every aura shot (none in the baseline) that move between shots → aura drawn; marker pixels in the repoint shots only → repoint drawn", () => {
    const shots = [
      shot("baseline", blank()),
      shot("aura 1", dots(blank(), [[0, 0], [20, -30], [-25, -60]])),
      shot("aura 2", dots(blank(), [[5, -10], [18, -45], [-30, -80]])),
      shot("aura 3", dots(blank(), [[-4, -20], [25, -5], [-20, -95]])),
      shot("repoint 1", marker(dots(blank(), [[0, 0]]), 100, 100)),
      shot("repoint 2", marker(dots(blank(), [[9, -9]]), 104, 96)),
      shot("repoint 3", marker(dots(blank(), [[-9, -30]]), 98, 90)),
    ];
    const s = V.measureVfx(shots);
    eq(s.identical, false);
    eq(s.outcomes.aura, "drawn"); eq(s.outcomes.repoint, "drawn");
    assert(s.perShot.find((p: any) => p.label === "aura 1").dot >= 150, JSON.stringify(s.perShot));
    eq(s.perShot.find((p: any) => p.label === "baseline").dot, 0);
    assert(s.auraMotion >= 0.2, `motion ${s.auraMotion}`);
  });
  test("measureVfx: byte-identical shots → stale-shots for both questions (no verdict from a frozen capture)", () => {
    const same = dots(blank(), [[0, 0], [20, -30]]);
    const shots = ["baseline", "aura 1", "aura 2", "aura 3", "repoint 1", "repoint 2", "repoint 3"].map((l) => shot(l, same));
    const s = V.measureVfx(shots);
    eq(s.identical, true); eq(s.outcomes.aura, "stale-shots"); eq(s.outcomes.repoint, "stale-shots");
  });
  test("measureVfx: the same dots in every aura shot → static (a sprite, not an emitter); no dots → absent; dots in the baseline → inconclusive", () => {
    const d = () => dots(blank(), [[0, 0], [20, -30], [-25, -60]]);
    const mk = (base: Img, a: Img[]) => [shot("baseline", base), ...a.map((x, i) => shot(`aura ${i + 1}`, x)), shot("repoint 1", marker(blank(), 100, 100 + 0)), shot("repoint 2", marker(blank(), 101, 100)), shot("repoint 3", marker(blank(), 102, 100))];
    const still = d(); paint(still, 0, 0, 1, 1, [0, 0, 0]);
    eq(V.measureVfx(mk(blank(), [d(), still, d()])).outcomes.aura, "static");
    eq(V.measureVfx(mk(blank(), [blank(), blank(), blank()])).outcomes.aura, "absent");
    eq(V.measureVfx(mk(d(), [d(), dots(blank(), [[3, 3]]), d()])).outcomes.aura, "inconclusive");
    eq(V.measureVfx(mk(blank(), [d(), dots(blank(), [[3, 3]]), d()]).map((s, i) => (i >= 4 ? shot(s.label, blank()) : s))).outcomes.repoint, "absent");
  });
  test("measureVfx: only the arena counts (a pink HUD corner is ignored)", () => {
    const hud = (img: Img) => { paint(img, 0, 0, 30, 20, PINK); return img; };
    const s = V.measureVfx([shot("baseline", hud(blank())), shot("aura 1", hud(blank())), shot("aura 2", hud(dots(blank(), [[0, 0]]))), shot("aura 3", hud(blank()))]);
    eq(s.perShot[0].dot, 0); eq(s.outcomes.aura, "absent");
  });

  // ---- B. the content model ----
  test("particles.ts: PARTICLE_KEYS holds the decoder's emitter keys; curve keys expand to X / X_start / X_end / X_in / X_out; there is no colour key", () => {
    assert(!P.isParticleKey("continual_emission") && P.PARTICLE_DEAD_KEYS.includes("continual_emission"), "continual_emission is dead (no such string in the exe)");
    for (const k of ["movieclip", "emit_rate", "emit_amount", "emit_box", "particle_lifetime", "live_bounds", "render_mode", "render_layer", "simulation_space", "ownership", "scripts", "combo", "chain", "variant_of", "max_particles", "material", "unlit", "depth_bias"]) assert(P.isParticleKey(k), k);
    for (const c of ["size", "alpha", "speed", "friction", "force", "rotation", "rotation_speed"]) for (const s of ["", "_start", "_end", "_in", "_out"]) assert(P.isParticleKey(c + s), c + s);
    for (const k of ["color", "colour", "tint", "emit_rat", "size_middle"]) assert(!P.isParticleKey(k), k);
  });
  test("particles.ts: particleRefKeys names where a particles.gon system is referenced (EliteParticle, ParticleBurst, global_particles, particles, combo, chain) and clipRefKeys where an SWF clip is (graphics particle / affected_particle / center_particle / area_particle / miss_particle / projectile, particles.gon movieclip)", () => {
    for (const k of ["EliteParticle", "ParticleBurst", "global_particles", "combo", "chain"]) assert(P.PARTICLE_REF_KEYS.includes(k), k);
    for (const k of ["particle", "affected_particle", "center_particle", "area_particle", "miss_particle", "projectile"]) assert(P.ABILITY_CLIP_KEYS.includes(k), k);
    assert(P.isNoneName("none") && P.isNoneName("None") && !P.isNoneName("Explosion"), "none / None mean no effect");
  });
  const BASE_PARTICLES = join(EXTRACTED_DATA, "particles.gon");
  if (!existsSync(BASE_PARTICLES)) console.log(`  (skipped: base particles.gon not extracted at ${BASE_PARTICLES})`);
  else {
    test("T1: every key vanilla particles.gon / particles2d.gon uses at the system level is a PARTICLE_KEYS key (the model covers the pack), and every combo / chain target is a system of the same files", () => {
      const names = new Set<string>();
      const bad: string[] = [];
      const refs: string[] = [];
      for (const f of ["particles.gon", "particles2d.gon"]) {
        const root = toValue(parse(readFileSync(join(EXTRACTED_DATA, f), "utf8"))) as any;
        for (const e of root.entries) names.add(e.key);
        for (const e of root.entries) {
          if (e.value.t !== "obj") continue;
          for (const k of e.value.entries) {
            if (!P.isParticleKey(k.key) && !P.PARTICLE_DEAD_KEYS.includes(k.key)) bad.push(`${f}:${e.key}.${k.key}`);
            if (k.key === "combo" && k.value.t === "arr") for (const it of k.value.items) if (it.t === "str") refs.push(it.raw);
            if (k.key === "chain" && k.value.t === "str") refs.push(k.value.raw);
          }
        }
      }
      eq(bad.join(" "), "", "unknown keys");
      const missing = refs.filter((r) => !names.has(r));
      eq(missing.join(" "), "", "combo / chain targets");
    });
  }

  // ---- C. the validator ----
  const v = (code: string, clips: string[] = ["ParticlePuff", "Explosion", "PoisonPoof"]): Report =>
    validateMod(code, undefined, { modDir: join(FIX, "mods", code), extractedData: join(FIX, "base"), components: ["EliteParticle", "PlayerBrain"], registeredNames: [], nativeBuild: null, clips } as any);
  const codes = (r: Report) => r.findings.map((f) => `${f.code}@${f.location?.path ?? ""}`).join(",") || "(none)";
  test("validator: particle-missing (error) for an EliteParticle / combo / chain name no particles.gon (base or this mod) defines; a mod-added system and `none` resolve", () => {
    const r = v("particle-missing");
    const hits = r.findings.filter((f) => f.code === "particle-missing");
    eq(hits.map((h) => h.location?.path).sort().join(" "), "MyBadAura.combo.[1] MyBadAura.chain VfxRat.passives.EliteParticle".split(" ").sort().join(" "), codes(r));
    for (const h of hits) eq(h.severity, "error");
  });
  test("validator: clip-missing (warning) for a particles.gon movieclip or an ability graphics particle that is neither a vanilla export nor this mod's scene export; this mod's art export resolves", () => {
    const r = v("clip-missing");
    const hits = r.findings.filter((f) => f.code === "clip-missing");
    eq(hits.map((h) => h.location?.path).sort().join(" "), ["NoSuchClipAura.movieclip", "PinkSpin.graphics.particle"].sort().join(" "), codes(r));
    for (const h of hits) eq(h.severity, "warning");
  });
  test("validator: no clip list → one info clip-list-missing instead of a warning per clip", () => {
    const r = validateMod("clip-missing", undefined, { modDir: join(FIX, "mods", "clip-missing"), extractedData: join(FIX, "base"), components: ["EliteParticle"], registeredNames: [], nativeBuild: null, clips: [] } as any);
    eq(r.findings.filter((f) => f.code === "clip-missing").length, 0, codes(r));
    eq(r.findings.filter((f) => f.code === "clip-list-missing").length, 1, codes(r));
  });
  test("validator: particle-unknown-key (warning) for a system key the decoder never reads (a typo, or a colour key — colour is the clip's art)", () => {
    const r = v("particle-unknown-key");
    eq(r.findings.filter((f) => f.code === "particle-unknown-key").map((f) => f.location?.path).sort().join(" "), "TypoAura.color TypoAura.emit_rat", codes(r));
  });
  test("validator: the clean fixture stays clean (no particle findings when no particle is referenced)", () => {
    const r = v("clean");
    eq(r.findings.length, 0, codes(r));
  });

  // ---- D. templates ----
  test("new_from_template particle: a particles.gon.append system with the given movieclip, every key a PARTICLE_KEYS key, no localization rows", () => {
    const r = newFromTemplate("tmp-vfx", "particle" as any, "MyAura", { movieclip: "MyDot", dryRun: true } as any) as any;
    assert(r.ok && r.dryRun, JSON.stringify(r));
    eq(r.files.map((f: any) => f.relPath).join(","), "data/particles.gon.append");
    const root = toValue(parse(r.files[0].content)) as any;
    const sys = root.entries.find((e: any) => e.key === "MyAura").value;
    eq(sys.entries.find((e: any) => e.key === "movieclip").value.raw, "MyDot");
    for (const e of sys.entries) assert(P.isParticleKey(e.key), e.key);
    eq(r.localizationKeys.length, 0);
  });
  test("new_from_template vfx-ability: an ability variant whose graphics name the clip (particle) plus a character wearing a particle system aura is not implied; loc rows for the ability", () => {
    const r = newFromTemplate("tmp-vfx", "vfx-ability" as any, "PinkSpin", { movieclip: "MyHitClip", dryRun: true } as any) as any;
    assert(r.ok && r.dryRun, JSON.stringify(r));
    const gon = r.files.find((f: any) => f.relPath === "data/abilities/mod_abilities.gon.append").content;
    const ab = (toValue(parse(gon)) as any).entries.find((e: any) => e.key === "PinkSpin").value;
    const g = ab.entries.find((e: any) => e.key === "graphics").value;
    eq(g.entries.find((e: any) => e.key === "particle").value.raw, "MyHitClip");
    eq(ab.entries.find((e: any) => e.key === "variant_of").value.raw, "Spin");
    eq(r.localizationKeys.join(","), "ABILITY_PINKSPIN_NAME,ABILITY_PINKSPIN_DESC");
  });

  // ---- E. the probe mod and the OBSERVED run ----
  test("_vfxprobe: SparkleBuff re-pointed by .merge (movieclip only), VfxProbeAura appended, two Rat variants wearing them through EliteParticle, the scene exports both clips, the script shoots a baseline before any spawn", () => {
    const merge = toValue(parse(readFileSync(join(MODS_DIR, "_vfxprobe", "data", "particles.gon.merge"), "utf8"))) as any;
    eq(merge.entries.map((e: any) => e.key).join(","), "SparkleBuff");
    eq(merge.entries[0].value.entries.map((e: any) => `${e.key}=${e.value.raw}`).join(","), "movieclip=VfxProbeMarker");
    const app = toValue(parse(readFileSync(join(MODS_DIR, "_vfxprobe", "data", "particles.gon.append"), "utf8"))) as any;
    const aura = app.entries.find((e: any) => e.key === "VfxProbeAura").value;
    eq(aura.entries.find((e: any) => e.key === "movieclip").value.raw, "VfxProbeDot");
    for (const e of aura.entries) assert(P.isParticleKey(e.key), e.key);
    const scene = JSON.parse(readFileSync(join(MODS_DIR, "_vfxprobe", "art", "vfx.scene.json"), "utf8"));
    assert(scene.exports.VfxProbeDot && scene.exports.VfxProbeMarker, JSON.stringify(scene.exports));
    assert(/#ff0090/i.test(JSON.stringify(scene.shapes)), "the distinctive dot colour");
    const plan = parseScript(readFileSync(join(MODS_DIR, "_vfxprobe", "tests", "vfx-probe.mewtest"), "utf8"), { owningMod: "_vfxprobe", name: "vfx-probe" });
    assert(plan.ok, JSON.stringify(plan.errors));
    assert(plan.body.indexOf('shot "baseline"') < plan.body.indexOf("cmd spawn VfxProbeAura") && plan.body.indexOf("cmd spawn VfxProbeAura") < plan.body.indexOf("cmd spawn VfxProbeRepoint"), plan.body);
    assert(!plan.mods.includes("_autoplay"), "no autoplay: the probe units must stay alive");
  });
  test("_vfxprobe validates with zero errors on the real base (T1 when extracted)", () => {
    if (!existsSync(BASE_PARTICLES)) { console.log("  (skipped: no base data)"); return; }
    const r = validateMod("_vfxprobe");
    assert(r.ok, JSON.stringify(r.findings.filter((f) => f.severity === "error")));
    eq(r.findings.filter((f) => f.code === "particle-missing" || f.code === "clip-missing").length, 0, JSON.stringify(r.findings));
  });
  test("OBSERVED 2026-10-22 fixture (vfxprobe-summary.json): the run passed with the real save unchanged, the shots were not byte-identical, and the outcomes for the NEW system and the re-pointed vanilla one are recorded", () => {
    const p = join(HERE, "fixtures", "ingame", "vfxprobe-summary.json");
    assert(existsSync(p), "written by npm run test:artprobe -- --vfx");
    const j = JSON.parse(readFileSync(p, "utf8")) as any;
    eq(j.verdict, "pass");
    assert(/real save file\(s\) unchanged/.test(j.save), String(j.save));
    eq(j.identical, false);
    eq(j.outcomes.aura, "drawn", "a NEW particles.gon system with a mod clip draws, and moves");
    eq(j.outcomes.repoint, "drawn", "a vanilla system re-pointed to a mod clip draws the mod clip");
  });
}
