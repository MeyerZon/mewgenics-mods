// The validator's audio checks (docs/data-mods.md "Sounds and music"):
//   - a mod's own audio files: .wav must pass WAVResource::decode's rules (sound-not-wav, error), should be PCM 16-bit
//     mono/stereo like every vanilla WAV (sound-format, warning); .ogg must be an Ogg stream (sound-not-ogg, error);
//     a file at a pack path replaces the vanilla one (sound-replaces, info).
//   - sound-set overlays (audio/<set>.gon[.merge|.patch]): every group's files resolve at audio/<Folder>/<file> in the
//     mod or the pack (sound-missing, error); `.append` on a pack set duplicates SoundEffectGroups (sound-set-append).
//   - music_info.gon overlays: every track file resolves at audio/music/<path> (sound-missing).
//   - data refs: a sound event key names a group of some set, pack or mod (sound-event-unknown, warning); an
//     ambient_sound file resolves at audio/ambience/<file> (sound-missing); music / override_music / new_music name a
//     music_info track (music-unknown, warning).
// Without the cached audio index (editor/data/audio-index.json) the pack-side checks are skipped with one info.

import { readFileSync } from "node:fs";
import { readWav, isOgg } from "../audio/wav.ts";
import { scanSoundSet, scanMusicInfo, soundFilePath, isSoundSetPath, AUDIO_INDEX_HINT } from "../audio/sound-sets.ts";
import type { AudioIndex, SoundSet } from "../audio/sound-sets.ts";
import type { ReportBuilder, SourceLocation } from "./result.ts";
import type { VNode } from "../gon/types.ts";

/** Binary audio files a mod ships; they are never GON/CSV overlays. */
export const AUDIO_FILE_RE = /\.(wav|ogg|mid)$/i;

/** Data keys whose string value names a sound group (event). `sounds { <any> X }` children and `alt_sounds` too. */
export const SOUND_EVENT_KEYS = new Set(["sfx", "sound_event", "deathsound", "LoopingSoundWhileAlive", "SoundEventOnHit", "equip_sound", "play_sound"]);
export const MUSIC_KEYS = new Set(["music", "override_music", "new_music"]);

export const MUSIC_INFO = "audio/music/music_info.gon";

export interface ModAudioFile {
  /** mod-relative posix path */
  relPath: string;
  abs: string;
}

export interface AudioOverlay {
  relPath: string;
  text: string;
  baseName: string;
  mode: string;
}

export interface AudioContext {
  index: AudioIndex | null;
  /** a pack path (lower-case) exists in the mod or (when known) the pack; null = cannot tell (no index, not in mod) */
  exists(packPath: string): boolean | null;
  /** group names of every set (pack + this mod's set overlays); null = no index and the mod adds none */
  hasEvent(name: string): boolean | null;
  hasMusic(key: string): boolean | null;
}

export function makeAudioContext(index: AudioIndex | null, overlays: AudioOverlay[], modFiles: ModAudioFile[]): AudioContext {
  const modPaths = new Set(modFiles.map((f) => f.relPath.toLowerCase()));
  const modEvents = new Set<string>();
  const modMusic = new Set<string>();
  for (const o of overlays) {
    if (isSoundSetPath(o.baseName)) for (const e of scanSoundSet(o.text).events.keys()) modEvents.add(e);
    else if (o.baseName.toLowerCase() === MUSIC_INFO) for (const k of scanMusicInfo(o.text).keys()) modMusic.add(k);
  }
  const packEvents = new Set<string>();
  if (index) for (const s of index.sets.values()) for (const e of s.events.keys()) packEvents.add(e);
  return {
    index,
    exists: (p) => (modPaths.has(p.toLowerCase()) ? true : index ? index.files.has(p.toLowerCase()) : null),
    hasEvent: (n) => (modEvents.has(n) || packEvents.has(n) ? true : index ? false : null),
    hasMusic: (k) => (modMusic.has(k) || (index?.music.has(k) ?? false) ? true : index ? false : null),
  };
}

/** Checks on the mod's audio files and its sound-set / music_info overlays. */
export function validateAudioFiles(modName: string, overlays: AudioOverlay[], modFiles: ModAudioFile[], ctx: AudioContext, rb: ReportBuilder): void {
  const fileOf = (rel: string): string => `mods/${modName}/${rel}`;
  const touchesAudio = modFiles.length > 0 || overlays.some((o) => isSoundSetPath(o.baseName) || o.baseName.toLowerCase() === MUSIC_INFO);
  if (!ctx.index && touchesAudio) rb.info("audio-index-missing", `the pack's audio list is not cached, so sound files and groups are only checked against this mod: ${AUDIO_INDEX_HINT}`);

  for (const f of modFiles) {
    const at = { file: fileOf(f.relPath) };
    let bytes: Uint8Array;
    try { bytes = readFileSync(f.abs); } catch { continue; }
    if (/\.wav$/i.test(f.relPath)) {
      const r = readWav(bytes);
      if (!r.ok) rb.error("sound-not-wav", `${f.relPath}: ${r.error}`, at);
      else if (r.info.formatTag !== 1 || r.info.bitsPerSample !== 16 || r.info.channels < 1 || r.info.channels > 2) {
        rb.warn("sound-format", `${f.relPath} is format ${r.info.formatTag}, ${r.info.channels} channel(s), ${r.info.bitsPerSample}-bit at ${r.info.sampleRate} Hz; every vanilla WAV is PCM (1) 16-bit mono/stereo at 44100/48000 Hz — other formats are untested`, at);
      }
    } else if (/\.ogg$/i.test(f.relPath) && !isOgg(bytes)) {
      rb.error("sound-not-ogg", `${f.relPath} does not start with the Ogg capture pattern "OggS" (music, ambience and cutscene audio are Ogg Vorbis streams)`, at);
    }
    if (ctx.index?.files.has(f.relPath.toLowerCase())) rb.info("sound-replaces", `${f.relPath} replaces the vanilla file at the same pack path (mod paths are searched before the pack)`, at);
  }

  for (const o of overlays) {
    const at = (path?: string): SourceLocation => (path ? { file: fileOf(o.relPath), path } : { file: fileOf(o.relPath) });
    if (isSoundSetPath(o.baseName)) {
      const own = scanSoundSet(o.text);
      const base: SoundSet | undefined = ctx.index?.sets.get(o.baseName.toLowerCase());
      if (o.mode === "append" && base) {
        rb.warn("sound-set-append", `${o.relPath} appends to the pack set ${o.baseName}: a second SoundEffectGroups block is a duplicate name, not a merge — use ${o.baseName}.merge to add groups`, at());
      }
      const folder = own.folder ?? base?.folder ?? null;
      if (folder === null) {
        if (own.events.size > 0) rb.warn("sound-set-folder-unknown", `${o.relPath} names no Folder and no pack set supplies one: its files cannot be resolved`, at());
        continue;
      }
      for (const [ev, files] of own.events) {
        for (const file of files) {
          const p = soundFilePath(folder, file);
          if (ctx.exists(p) === false) rb.error("sound-missing", `group ${ev} plays ${file}, but ${p} is neither in this mod nor in the pack`, at(`SoundEffectGroups.${ev}.files`));
        }
      }
    } else if (o.baseName.toLowerCase() === MUSIC_INFO) {
      for (const [track, files] of scanMusicInfo(o.text)) {
        for (const file of files) {
          const p = `audio/music/${file}`.toLowerCase();
          if (ctx.exists(p) === false) rb.error("sound-missing", `music track ${track} names ${file}, but ${p} is neither in this mod nor in the pack`, at(track));
        }
      }
    }
  }
}

/**
 * A data-overlay field check: call for every (key, value, path) the validator's walk visits. Returns nothing;
 * findings go to rb.
 */
export function checkAudioField(key: string, value: VNode, path: string[], ctx: AudioContext, rb: ReportBuilder, file: string): void {
  const here = [...path, key].join(".");
  const strings = (n: VNode): string[] => (n.t === "str" ? [n.raw] : n.t === "arr" ? n.items.flatMap(strings) : []);
  const isEventKey = SOUND_EVENT_KEYS.has(key) || key === "alt_sounds" || path[path.length - 1] === "sounds";
  if (isEventKey) {
    for (const name of strings(value)) {
      if (ctx.hasEvent(name) === false) rb.warn("sound-event-unknown", `sound group "${name}" is defined by no sound set (pack or this mod's audio/*.gon overlays); the game plays nothing`, { file, path: here });
    }
  } else if (key === "ambient_sound") {
    for (const name of strings(value)) {
      const p = `audio/ambience/${name}`.toLowerCase();
      if (ctx.exists(p) === false) rb.error("sound-missing", `ambient_sound ${name}: ${p} is neither in this mod nor in the pack`, { file, path: here });
    }
  } else if (MUSIC_KEYS.has(key)) {
    for (const name of strings(value)) {
      if (ctx.hasMusic(name) === false) rb.warn("music-unknown", `music "${name}" is not a track of audio/music/music_info.gon (pack or this mod's overlay)`, { file, path: here });
    }
  }
}
