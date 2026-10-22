// Sounds and music for data mods (docs/data-mods.md "Sounds and music").
// T0: the WAV reader/writer (the rules of WAVResource::decode 0x9a6dd0), the gpak index parser on a synthetic archive,
// the lenient sound-set / music_info scanner, the audio index and the validator's audio findings on temp mods with
// generated tones (*.wav is git-ignored, so fixtures are written at test time). T1 (skips without the game): the
// pack's own sound sets resolve every file they name, and the audio-probe tones are up to date.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { readWav, isOgg, makeToneWav } from "../src/core/audio/wav.ts";
import { parseGpakIndex, openGpak } from "../src/core/gpak-index.ts";
import {
  scanSoundSet, scanMusicInfo, buildAudioIndex, soundFilePath, isSoundSetPath, audioIndexToJson, audioIndexFromJson,
} from "../src/core/audio/sound-sets.ts";
import type { AudioIndex } from "../src/core/audio/sound-sets.ts";
import { validateMod } from "../src/core/validate/validator.ts";
import type { ValidateOptions } from "../src/core/validate/validator.ts";
import type { Report } from "../src/core/validate/result.ts";
import { locateGameDir } from "../src/core/ingame/launch.ts";
import { AUDIOPROBE_TONES, writeAudioProbeTones } from "../scripts/audio-probe-tones.ts";
import type { TestFn, AssertFn, EqFn } from "./run-tests.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A synthetic pack audio index: one set (CombatSFX, Folder combat_sfx) and a music table. */
function fakeIndex(): AudioIndex {
  return audioIndexFromJson({
    files: ["audio/combat_sfx.gon", "audio/combat_sfx/pickup_coin.wav", "audio/combat_sfx/death_explode.wav", "audio/ambience/amb_rain.ogg", "audio/music/alley/eatinrats_map.ogg"],
    sets: { "audio/combat_sfx.gon": { setName: "CombatSFX", folder: "combat_sfx", events: { SE_PickupCoin: ["pickup_coin.wav"], DeathExplode: ["death_explode.wav"] } } },
    music: { alley: ["alley/eatinrats_map.ogg"] },
  });
}

/** Write a temp mod: path -> text or bytes. */
function tempMod(files: Record<string, string | Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), "audiomod-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

export function runAudioTests(test: TestFn, assert: AssertFn, eq: EqFn): void {
  const codes = (r: Report): string => r.findings.map((f) => f.code).join(",") || "(none)";
  const v = (files: Record<string, string | Uint8Array>, opts: ValidateOptions = {}): Report =>
    validateMod("audiomod", undefined, { modDir: tempMod(files), extractedData: join(tmpdir(), "no-base-data-here"), components: ["Passive"], registeredNames: [], nativeBuild: null, audioIndex: fakeIndex(), ...opts });
  const only = (r: Report, code: string) => r.findings.filter((f) => f.code === code);

  // ---- WAV / Ogg ----------------------------------------------------------------
  test("audio: makeToneWav writes a canonical PCM16 WAV that readWav reads back (rate, channels, frames, seconds)", () => {
    const w = makeToneWav({ freq: 440, seconds: 0.5, sampleRate: 48000, channels: 2 });
    eq(w.length, 44 + 24000 * 2 * 2, "44-byte header + frames*ch*2");
    const r = readWav(w);
    assert(r.ok, r.ok ? "" : r.error);
    if (!r.ok) return;
    eq(r.info.formatTag, 1); eq(r.info.channels, 2); eq(r.info.sampleRate, 48000); eq(r.info.bitsPerSample, 16);
    eq(r.info.blockAlign, 4); eq(r.info.dataOffset, 44); eq(r.info.frames, 24000); eq(r.info.seconds, 0.5);
  });
  test("audio: readWav refuses what WAVResource::decode asserts on (not RIFF, < 4 bytes, no data chunk) and skips unknown chunks", () => {
    const notRiff = readWav(enc("OggS...."));
    assert(!notRiff.ok && /not "RIFF"/.test(notRiff.error) && /is not a wav file/.test(notRiff.error), "OggS is not a wav");
    const short = readWav(enc("RI"));
    assert(!short.ok && /out of bounds/.test(short.error), "too short");
    const tone = makeToneWav({ freq: 0, seconds: 0.01 });
    const noData = readWav(tone.subarray(0, 36));
    assert(!noData.ok && /"data"/.test(noData.error), `no data chunk: ${noData.ok ? "" : noData.error}`);
    // a JUNK chunk before "fmt " (1961 vanilla files have one) is skipped by its size
    const junk = new Uint8Array(tone.length + 12);
    junk.set(tone.subarray(0, 12), 0);
    junk.set(enc("JUNK"), 12);
    new DataView(junk.buffer).setUint32(16, 4, true);
    junk.set(tone.subarray(12), 24);
    const j = readWav(junk);
    assert(j.ok && j.info.dataOffset === 56 && j.info.sampleRate === 44100, `JUNK skipped: ${JSON.stringify(j)}`);
  });
  test("audio: isOgg checks the OggS capture pattern", () => {
    assert(isOgg(enc("OggS\0\x02")) && !isOgg(enc("RIFF")) && !isOgg(enc("Og")), "OggS only");
  });

  // ---- gpak index ---------------------------------------------------------------
  test("audio: parseGpakIndex reads count / (u16 len, path, u32 size) records and computes body offsets", () => {
    const recs = [["audio/a.wav", 3], ["data/x.gon", 5]] as const;
    const parts: number[] = [];
    const u16 = (n: number) => parts.push(n & 255, n >> 8);
    const u32 = (n: number) => parts.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24);
    u32(recs.length);
    for (const [p, s] of recs) { u16(p.length); for (const c of p) parts.push(c.charCodeAt(0)); u32(s); }
    const head = Uint8Array.from([...parts, 1, 2, 3, 4, 5, 6, 7, 8]);
    const ix = parseGpakIndex(head, head.length);
    eq(ix.length, 2); eq(ix[0]!.path, "audio/a.wav"); eq(ix[0]!.offset, parts.length); eq(ix[1]!.offset, parts.length + 3);
    let threw = "";
    try { parseGpakIndex(head, head.length + 1); } catch (e) { threw = String(e); }
    assert(/file is/.test(threw), "a size mismatch is refused");
  });

  // ---- sound sets / music_info --------------------------------------------------
  test("audio: scanSoundSet reads SetName, Folder and every group's files (array or bare), lenient on vanilla `pitch range [..]` and #include", () => {
    const s = scanSoundSet([
      "#include voice_template.gon",
      "SetName CombatSFX // c",
      'Folder "combat_sfx"',
      "Channels { main { volume 1.1 } }",
      "SoundEffectGroups {",
      "  # Example { files [x.wav] }",
      "  A { files [a1.wav, a2.wav] pitch range [.9, 1.1] }",
      "  B { files b.wav extra_events A }",
      "  /* C { files [c.wav] } */",
      "  D { extra_events A }",
      "}",
    ].join("\n"));
    eq(s.setName, "CombatSFX"); eq(s.folder, "combat_sfx");
    eq([...s.events.keys()].join(","), "A,B,D");
    eq(s.events.get("A")!.join(","), "a1.wav,a2.wav"); eq(s.events.get("B")!.join(","), "b.wav"); eq(s.events.get("D")!.length, 0);
  });
  test("audio: scanMusicInfo maps each track key to the .ogg/.mid paths it names (relative to audio/music/)", () => {
    const m = scanMusicInfo('alley {\n map "alley/m.ogg"\n boss [/*"x.ogg"*/ "alley/b1.ogg" "alley/b2.ogg"]\n midi "alley/m.mid"\n}\nscrambled {\n}\n');
    eq(m.get("alley")!.join(","), "alley/m.ogg,alley/b1.ogg,alley/b2.ogg,alley/m.mid"); eq(m.get("scrambled")!.length, 0);
  });
  test("audio: soundFilePath = audio/<Folder>/<file>, lower-cased (the pak keys are); isSoundSetPath excludes audio/music/", () => {
    eq(soundFilePath("voices/male1", "Angry1.WAV"), "audio/voices/male1/angry1.wav");
    eq(soundFilePath("combat_sfx/", "FleshyLad_walk_01.wav"), "audio/combat_sfx/fleshylad_walk_01.wav");
    assert(isSoundSetPath("audio/combat_sfx.gon") && isSoundSetPath("audio/voices/male1.gon") && !isSoundSetPath("audio/music/music_info.gon") && !isSoundSetPath("data/x.gon"), "set paths");
  });
  test("audio: buildAudioIndex keeps audio/ entries, scans sets and music_info; the JSON form round-trips", () => {
    const texts: Record<string, string> = { "audio/ui_sfx.gon": "SetName UISFX Folder ui_sfx SoundEffectGroups { Click { files click.wav } }", "audio/music/music_info.gon": 'alley { map "alley/m.ogg" }' };
    const ix = buildAudioIndex(["data/x.gon", "audio/ui_sfx.gon", "audio/ui_sfx/click.wav", "audio/music/music_info.gon", "audio/music/alley/m.ogg"], (p) => texts[p]!);
    eq(ix.files.size, 4, "data/ dropped"); eq(ix.sets.get("audio/ui_sfx.gon")!.events.get("Click")!.join(), "click.wav"); eq(ix.music.get("alley")!.join(), "alley/m.ogg");
    const back = audioIndexFromJson(audioIndexToJson(ix));
    eq(back.files.size, 4); eq(back.sets.get("audio/ui_sfx.gon")!.folder, "ui_sfx"); eq(back.music.get("alley")!.length, 1);
  });

  // ---- validator ----------------------------------------------------------------
  const tone = makeToneWav({ freq: 660, seconds: 0.05 });
  test("validator audio: a merged new group whose file the mod ships, and a replaced vanilla file, give no error; the replacement is an info", () => {
    const r = v({
      "audio/combat_sfx.gon.merge": "SoundEffectGroups { Probe_New { files [probe_new.wav] } }",
      "audio/combat_sfx/probe_new.wav": tone,
      "audio/combat_sfx/pickup_coin.wav": tone,
    });
    assert(r.ok, `ok: ${codes(r)}`);
    eq(only(r, "sound-missing").length, 0, "no sound-missing");
    eq(only(r, "whole-file-replace").length, 0, "a sound file is not a GON whole-file replace");
    const rep = only(r, "sound-replaces");
    eq(rep.length, 1, `one sound-replaces: ${codes(r)}`); eq(rep[0]!.severity, "info"); eq(rep[0]!.location?.file, "mods/audiomod/audio/combat_sfx/pickup_coin.wav");
  });
  test("validator audio: sound-missing is an error for a group file in neither the pack nor the mod (path audio/<Folder>/<file>)", () => {
    const r = v({ "audio/combat_sfx.gon.merge": "SoundEffectGroups { Probe_Absent { files [absent.wav, pickup_coin.wav] } }" });
    const m = only(r, "sound-missing");
    eq(m.length, 1, codes(r)); eq(m[0]!.severity, "error"); assert(/audio\/combat_sfx\/absent\.wav/.test(m[0]!.message), m[0]!.message);
    eq(m[0]!.location?.path, "SoundEffectGroups.Probe_Absent.files"); assert(!r.ok, "an error");
  });
  test("validator audio: a NEW sound set (its own SetName/Folder) resolves files under its own folder", () => {
    const r = v({ "audio/probe_sfx.gon": "SetName ProbeSFX Folder probe_sfx SoundEffectGroups { P1 { files p1.wav } P2 { files p2.wav } }", "audio/probe_sfx/p1.wav": tone });
    eq(only(r, "sound-missing").map((f) => f.message.match(/audio\/\S+/)?.[0]).join(), "audio/probe_sfx/p2.wav", codes(r));
    eq(only(r, "whole-file-replace").length, 0, "a new set file is not a replace of a base file");
  });
  test("validator audio: sound-not-wav / sound-not-ogg are errors for a mod audio file the game's decoders refuse", () => {
    const r = v({ "audio/combat_sfx/pickup_coin.wav": "OggS not a wav", "audio/music/alley/eatinrats_map.ogg": tone });
    eq(only(r, "sound-not-wav").length, 1, codes(r)); eq(only(r, "sound-not-ogg").length, 1, codes(r)); assert(!r.ok, "errors");
  });
  test("validator audio: sound-format warns for a WAV that is not PCM 16-bit mono/stereo (every vanilla WAV is)", () => {
    const w = makeToneWav({ freq: 1, seconds: 0.01 });
    new DataView(w.buffer).setUint16(34, 8, true); // 8-bit
    const r = v({ "audio/combat_sfx/pickup_coin.wav": w });
    eq(only(r, "sound-format").length, 1, codes(r)); eq(only(r, "sound-format")[0]!.severity, "warning");
  });
  test("validator audio: sound-event-unknown warns for a data ref naming no group of any set (pack or mod); mod groups count", () => {
    const r = v({
      "audio/combat_sfx.gon.merge": "SoundEffectGroups { Probe_New { files [pickup_coin.wav] } }",
      "data/characters/enemies.gon.append": "ProbeRat { passives { LoopingSoundWhileAlive Probe_New } sfx Nope_1 sounds { ontrigger SE_PickupCoin oncast Nope_2 } sound { alt_sounds [[DeathExplode Nope_3]] animation_prefix Rat } deathsound Nope_4 }",
    });
    eq(only(r, "sound-event-unknown").map((f) => f.message.match(/"([^"]+)"/)?.[1]).join(), "Nope_1,Nope_2,Nope_3,Nope_4", codes(r));
    for (const f of only(r, "sound-event-unknown")) eq(f.severity, "warning");
  });
  test("validator audio: ambient_sound files resolve under audio/ambience/; music keys must be music_info tracks (pack or the mod's overlay)", () => {
    const r = v({
      "audio/music/music_info.gon.append": 'probe_track { map "probe/probe_map.ogg" }',
      "data/house_weather.gon.merge": "w1 { ambient_sound amb_rain.ogg } w2 { ambient_sound amb_nope.ogg }",
      "data/maps/x.gon.merge": "music alley override_music probe_track new_music nope_track",
    });
    eq(only(r, "sound-missing").map((f) => f.message.match(/audio\/\S+/)?.[0]).join(), "audio/music/probe/probe_map.ogg,audio/ambience/amb_nope.ogg", codes(r));
    eq(only(r, "music-unknown").map((f) => f.message.match(/"([^"]+)"/)?.[1]).join(), "nope_track", codes(r));
  });
  test("validator audio: sound-set-append warns for X.gon.append on a pack sound set (a second SoundEffectGroups block)", () => {
    const r = v({ "audio/combat_sfx.gon.append": "SoundEffectGroups { Probe_New { files [pickup_coin.wav] } }" });
    eq(only(r, "sound-set-append").length, 1, codes(r));
  });
  test("validator audio: without an audio index the pack checks are skipped with one audio-index-missing info; mod-local checks still run", () => {
    const r = v({ "audio/combat_sfx.gon.merge": "SoundEffectGroups { P { files [x.wav] } }", "audio/combat_sfx/bad.wav": "nope" }, { audioIndex: null });
    eq(only(r, "audio-index-missing").length, 1, codes(r)); eq(only(r, "audio-index-missing")[0]!.severity, "info");
    eq(only(r, "sound-missing").length, 0, "cannot tell without the pack list"); eq(only(r, "sound-not-wav").length, 1, "the mod's own file is still checked");
  });

  // ---- the probe mod's generated tones ----------------------------------------
  test("audio: the _audioprobe tone table writes valid WAVs (one new file, one replacement at a vanilla path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "audioprobe-"));
    eq(writeAudioProbeTones(dir).length, 0);
    for (const rel of Object.keys(AUDIOPROBE_TONES)) { assert(existsSync(join(dir, rel)), rel); }
    eq(writeAudioProbeTones(dir, true).length, 0, "--check passes right after writing");
    assert(Object.keys(AUDIOPROBE_TONES).includes("audio/combat_sfx/pickup_coin.wav"), "the replacement mirrors a vanilla path");
  });

  // ---- T1: the installed pack ---------------------------------------------------
  const gpak = join(locateGameDir(process.env), "resources.gpak");
  if (!existsSync(gpak)) {
    console.log(`  (skipped: no ${gpak}; the T1 audio-index checks need the installed game)`);
    return;
  }
  const g = openGpak(gpak);
  let ix: AudioIndex;
  try {
    const byPath = new Map(g.entries.map((e) => [e.path, e]));
    ix = buildAudioIndex(g.entries.map((e) => e.path), (p) => new TextDecoder().decode(g.read(byPath.get(p)!)));
  } finally { g.close(); }
  test("audio T1: the pack's sound sets name only files that exist at audio/<Folder>/<file> (the resolution rule holds for every vanilla ref)", () => {
    let refs = 0;
    const miss: string[] = [];
    for (const [p, s] of ix.sets) for (const [e, fs] of s.events) for (const f of fs) { refs++; if (!s.folder || !ix.files.has(soundFilePath(s.folder, f))) miss.push(`${p}:${e}:${f}`); }
    assert(ix.sets.size > 200 && refs > 20000, `sets ${ix.sets.size}, refs ${refs}`);
    eq(miss.length, 0, `unresolved: ${miss.slice(0, 5).join(" ")}`);
    assert(ix.sets.get("audio/combat_sfx.gon")?.events.get("SE_PickupCoin")?.includes("pickup_coin.wav") === true, "SE_PickupCoin -> pickup_coin.wav");
    for (const [k, fs] of ix.music) for (const f of fs) assert(ix.files.has(`audio/music/${f}`.toLowerCase()), `music ${k} ${f}`);
  });
}
