// Sound sets (`audio/*.gon`, `audio/voices/*.gon`, `audio/npcvoices/*.gon`) and the music table
// (`audio/music/music_info.gon`), read leniently, plus the audio index the validator resolves against.
//
// A sound set is what `glaiel::AudioCore::LoadSoundEffectSet` reads (docs/data-mods.md "Sounds and music"):
//   SetName <name>                  the set's name
//   Folder <dir>                    files resolve as audio/<dir>/<file>
//   Channels { main {...} <ch> {...} }
//   SoundEffectGroups { <Event> { files [a.wav b.wav] | files a.wav, channel <ch>, pitch_range [..], ... } }
// The data layer names an <Event> (`sfx`, `sounds.ontrigger`, `deathsound`, `LoopingSoundWhileAlive`, ...), never a
// file. The scanner is lenient on purpose: vanilla combat_sfx.gon has lines (`pitch range [.9, 1.1]`) that the
// strict editor parser refuses, and the voice sets use `#include` / `#define` macros (a `#` comment to GON).

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SoundSet {
  setName: string | null;
  folder: string | null;
  /** event name -> its file names as written (relative to audio/<folder>/) */
  events: Map<string, string[]>;
}

type Tok = { t: "{" | "}" | "[" | "]" | "w"; v: string };

/** GON-ish tokens: `//`, `/* *\/` and `#` comments dropped; `,` `:` `=` are whitespace; quotes dropped. */
export function tokenizeLenient(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "#") { while (i < n && text[i] !== "\n") i++; continue; }
    if (/[\s,:=]/.test(c)) { i++; continue; }
    if (c === "{" || c === "}" || c === "[" || c === "]") { out.push({ t: c, v: c }); i++; continue; }
    if (c === '"') {
      let s = "";
      i++;
      while (i < n && text[i] !== '"') { if (text[i] === "\\" && i + 1 < n) { i++; s += text[i] === "n" ? "\n" : text[i]; } else s += text[i]; i++; }
      i++;
      out.push({ t: "w", v: s });
      continue;
    }
    let s = "";
    while (i < n && !/[\s,:={}[\]"#]/.test(text[i]!) && !(text[i] === "/" && (text[i + 1] === "/" || text[i + 1] === "*"))) { s += text[i]; i++; }
    out.push({ t: "w", v: s });
  }
  return out;
}

/** Skip one value starting at tokens[i] (a word, an object or an array); returns the next index. */
function skipValue(toks: Tok[], i: number): number {
  const t = toks[i];
  if (!t) return i;
  if (t.t === "w") return i + 1;
  if (t.t === "{" || t.t === "[") {
    let depth = 0;
    for (; i < toks.length; i++) {
      const k = toks[i]!.t;
      if (k === "{" || k === "[") depth++;
      else if (k === "}" || k === "]") { depth--; if (depth === 0) return i + 1; }
    }
    return i;
  }
  return i + 1; // a stray closer
}

/** Words of a value: a word -> [word]; an array -> its top-level words; an object -> []. */
function valueWords(toks: Tok[], i: number): string[] {
  const t = toks[i];
  if (!t) return [];
  if (t.t === "w") return [t.v];
  if (t.t !== "[") return [];
  const out: string[] = [];
  const end = skipValue(toks, i);
  for (let j = i + 1; j < end - 1; j++) if (toks[j]!.t === "w") out.push(toks[j]!.v);
  return out;
}

/**
 * Iterate the `name value` children of the object whose `{` is at toks[open] (or the implicit root when open = -1).
 * A stray `[` in name position (vanilla `pitch range [.9, 1.1]`) is skipped as a value.
 */
function* children(toks: Tok[], open: number): Generator<{ name: string; at: number }> {
  let i = open + 1;
  const stop = open < 0 ? toks.length : skipValue(toks, open) - 1;
  while (i < stop) {
    const t = toks[i]!;
    if (t.t !== "w") { i = skipValue(toks, i); continue; }
    const at = i + 1;
    if (at >= stop) return;
    yield { name: t.v, at };
    i = skipValue(toks, at);
  }
}

/** Read a sound-set file (or an overlay of one) leniently. */
export function scanSoundSet(text: string): SoundSet {
  const toks = tokenizeLenient(text);
  const set: SoundSet = { setName: null, folder: null, events: new Map() };
  for (const { name, at } of children(toks, -1)) {
    if (name === "SetName" && toks[at]?.t === "w") set.setName = toks[at]!.v;
    else if (name === "Folder" && toks[at]?.t === "w") set.folder = toks[at]!.v;
    else if (name === "SoundEffectGroups" && toks[at]?.t === "{") {
      for (const g of children(toks, at)) {
        const files: string[] = [];
        if (toks[g.at]?.t === "{") for (const f of children(toks, g.at)) if (f.name === "files") files.push(...valueWords(toks, f.at));
        set.events.set(g.name, files);
      }
    }
  }
  return set;
}

/** `audio/music/music_info.gon`: track key -> every file path it names (relative to audio/music/). */
export function scanMusicInfo(text: string): Map<string, string[]> {
  const toks = tokenizeLenient(text);
  const out = new Map<string, string[]>();
  for (const { name, at } of children(toks, -1)) {
    const files: string[] = [];
    if (toks[at]?.t === "{") for (const f of children(toks, at)) files.push(...valueWords(toks, f.at).filter((w) => /\.(ogg|wav|mid)$/i.test(w)));
    out.set(name, files);
  }
  return out;
}

/** The pack's audio, as the validator needs it. Paths are pack paths, lower-cased (the pak keys are). */
export interface AudioIndex {
  /** every pack file under audio/ (lower-case) */
  files: Set<string>;
  /** pack path of a sound-set file (audio/combat_sfx.gon) -> its set */
  sets: Map<string, SoundSet>;
  /** music_info.gon track keys -> files */
  music: Map<string, string[]>;
}

/** Pack path of a sound file named by a set: audio/<folder>/<file>, lower-cased, `\` -> `/`. */
export function soundFilePath(folder: string, file: string): string {
  return `audio/${folder.replace(/\\/g, "/").replace(/\/+$/, "")}/${file.replace(/\\/g, "/")}`.toLowerCase();
}

/** True for a pack path that is (or overlays) a sound-set file: audio/<x>.gon outside audio/music/. */
export function isSoundSetPath(packPath: string): boolean {
  const p = packPath.replace(/\\/g, "/").toLowerCase();
  return p.startsWith("audio/") && p.endsWith(".gon") && !p.startsWith("audio/music/");
}

export interface AudioIndexJson {
  generatedAt?: string;
  files: string[];
  sets: Record<string, { setName: string | null; folder: string | null; events: Record<string, string[]> }>;
  music: Record<string, string[]>;
}

export function audioIndexToJson(ix: AudioIndex): AudioIndexJson {
  const sets: AudioIndexJson["sets"] = {};
  for (const [p, s] of ix.sets) sets[p] = { setName: s.setName, folder: s.folder, events: Object.fromEntries(s.events) };
  return { files: [...ix.files].sort(), sets, music: Object.fromEntries(ix.music) };
}

export function audioIndexFromJson(j: AudioIndexJson): AudioIndex {
  const sets = new Map<string, SoundSet>();
  for (const [p, s] of Object.entries(j.sets)) sets.set(p, { setName: s.setName, folder: s.folder, events: new Map(Object.entries(s.events)) });
  return { files: new Set(j.files.map((f) => f.toLowerCase())), sets, music: new Map(Object.entries(j.music)) };
}

/**
 * Build the index from a pack listing: `entries` are pack paths, `readText(path)` returns one entry's text.
 * Only audio/ entries are kept; only the .gon ones are read.
 */
export function buildAudioIndex(entries: Iterable<string>, readText: (path: string) => string): AudioIndex {
  const ix: AudioIndex = { files: new Set(), sets: new Map(), music: new Map() };
  for (const raw of entries) {
    const p = raw.replace(/\\/g, "/");
    if (!p.toLowerCase().startsWith("audio/")) continue;
    ix.files.add(p.toLowerCase());
    if (!p.toLowerCase().endsWith(".gon")) continue;
    if (p.toLowerCase() === "audio/music/music_info.gon") ix.music = scanMusicInfo(readText(p));
    else if (isSoundSetPath(p)) {
      const s = scanSoundSet(readText(p));
      if (s.events.size > 0 || s.folder !== null) ix.sets.set(p.toLowerCase(), s);
    }
  }
  return ix;
}

/** The git-ignored cache `npm run build:index` writes (editor/data/audio-index.json). */
export const AUDIO_INDEX_FILE = "audio-index.json";
export const AUDIO_INDEX_HINT = "run `npm run build:index` (reads the resources.gpak index read-only and writes editor/data/audio-index.json)";

/** Load the cached audio index from a cache dir; null when absent or unreadable. */
export function loadAudioIndex(cacheDir: string): AudioIndex | null {
  try {
    return audioIndexFromJson(JSON.parse(readFileSync(join(cacheDir, AUDIO_INDEX_FILE), "utf8")) as AudioIndexJson);
  } catch {
    return null;
  }
}

/** list_base_data's audio categories: sounds (group names of every set), music (music_info tracks), sound_files. */
export const AUDIO_CATEGORIES = ["sounds", "music", "sound_files"] as const;

export function audioCategoryEntries(ix: AudioIndex, category: string): string[] | null {
  if (category === "sounds") {
    const out = new Set<string>();
    for (const s of ix.sets.values()) for (const e of s.events.keys()) out.add(e);
    return [...out].sort();
  }
  if (category === "music") return [...ix.music.keys()].sort();
  if (category === "sound_files") return [...ix.files].filter((f) => /\.(wav|ogg|mid)$/.test(f)).sort();
  return null;
}
