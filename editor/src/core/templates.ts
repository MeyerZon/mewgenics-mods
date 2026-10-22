// new_from_template: scaffold an ability / passive / item / status-data overlay
// plus matching localization rows, writing them under mods/<name>/ (or returning
// the content for a dry run). Generated GON uses the .append overlay mode.
// The map kinds `room` (a new levels/<folder>/<name>.lvl) and `tileset-variant` (a new tileset name in
// data/tilesets.gon.append) live in level/level-templates.ts.
// glowing-character: a character variant that glows from the data layer (a status FwGlow_<colour> granted by a
// StatusOnSpawnIn / StatusOnBattleStart passive; docs/data-mods.md "Asking for a unit glow from data") plus the
// status's keyword_tooltips entry and its text rows; the colour is checked by the validator's invalid-glow-name rule.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MODS_DIR } from "./repo.ts";
import { parse } from "./gon/parser.ts";
import { toValue } from "./gon/value.ts";
import { parseCsv, serializeCsv } from "./overlay/csv.ts";
import { LOC_COLUMNS } from "./base-data.ts";
import { writeOverlay, writeModBinary } from "./mod-io.ts";
import { registeredPatterns, matchRegisteredPattern } from "./names.ts";
import { planRoom, planTilesetVariant } from "./level/level-templates.ts";

import type { TemplateKind } from "./template-kinds.ts";
export type { TemplateKind } from "./template-kinds.ts";
/** The kinds with a GON entry + localization rows (the map kinds have neither). */
type EntryKind = Exclude<TemplateKind, "room" | "tileset-variant">;

/** Scaffold knobs; every field is optional and comes from untyped JSON (MCP args / HTTP body). */
export interface TemplateOptions {
  displayName?: string;
  desc?: string;
  parent?: string;
  mana?: number | string;
  damage?: number | string;
  statusEffect?: string;
  statusStacks?: number | string;
  class?: string;
  component?: string;
  rarity?: string;
  kind?: string;
  frame?: number | string;
  gonFile?: string;
  /** particle: the SWF clip each particle draws; vfx-ability: the effect clip its graphics.particle plays */
  movieclip?: string;
  /** glowing-character: rrggbb or rrggbbaa (hex), or the whole status name FwGlow_<rrggbb[aa]> */
  colour?: string;
  /** glowing-character: the passive that grants the status (default StatusOnSpawnIn) */
  trigger?: string;
  fillTranslations?: boolean;
  write?: boolean;
  dryRun?: boolean;
  /** room: the folder under levels/ (default "custom"), grid size (default 10x10), placed objects and tiles */
  folder?: string;
  width?: number | string;
  height?: number | string;
  objects?: unknown;
  tiles?: unknown;
  /** room / tileset-variant: the base-data root (tests); default EXTRACTED_DATA */
  extractedData?: string;
}

const LOC_PREFIX: Record<EntryKind, string> = { ability: "ABILITY", passive: "PASSIVE", item: "ITEM", "status-data": "KEYWORD", particle: "", "vfx-ability": "ABILITY", "glowing-character": "KEYWORD" };
const DEFAULT_GON_FILE: Record<EntryKind, string> = {
  ability: "data/abilities/mod_abilities.gon.append",
  passive: "data/passives/mod_passives.gon.append",
  item: "data/items/mod_items.gon.append",
  "status-data": "data/keyword_tooltips.gon.append",
  particle: "data/particles.gon.append",
  "vfx-ability": "data/abilities/mod_abilities.gon.append",
  "glowing-character": "data/characters/enemies.gon.append",
};
/** kinds with no localization rows (a particle system has no player-visible text) */
const NO_LOC = new Set<TemplateKind>(["particle"]);

/** the passives that may grant a glowing-character's status (StatusOnSpawnIn is the in-game-proven one, FwGlowRat) */
const GLOW_TRIGGERS = ["StatusOnSpawnIn", "StatusOnBattleStart"];

function toKeyToken(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

/**
 * Build a 12-column localization row. Translations default to the English text
 * as a placeholder so a fresh scaffold validates cleanly; `notes` flags it.
 */
function locRow(key: string, en: string, fillTranslations: boolean): string[] {
  const row: string[] = new Array<string>(LOC_COLUMNS.length).fill("");
  row[0] = key;
  row[1] = en;
  row[2] = "scaffolded by editor; TODO translate";
  for (let i = 3; i < LOC_COLUMNS.length; i++) row[i] = fillTranslations ? en : "";
  return row;
}

function scaffoldGon(kind: EntryKind, name: string, o: TemplateOptions): string {
  const base = `${LOC_PREFIX[kind]}_${toKeyToken(name)}`;
  if (kind === "particle") {
    // a gentle rising aura (VfxProbeAura, OBSERVED in-game 2026-10-22); every key is one the decoder reads
    // (src/core/particles.ts). There is no colour key: the colour is the clip art. Wear it with
    // `passives { EliteParticle ${name} }` on a character, or name it in ParticleBurst / global_particles.
    return `${name} {
    movieclip ${o.movieclip || "ParticlePuff"}
    unlit true

    render_mode separate
    simulation_space global
    ownership local
    projection_matrix default

    emit_rate 30
    emit_amount 1
    emit_direction [0, 1, 0]
    emit_spread 30
    emit_box [-.3 .3 0 1 -.3 .3]
    live_bounds [-999 999 -999 999 -999 999]

    particle_lifetime 1.5
    speed_start .6
    size .4
    alpha 1
}
`;
  }
  if (kind === "vfx-ability") {
    const parent = o.parent || "Spin";
    // graphics.particle: the SWF clip played once on the target (SpellParticle); a vanilla one is e.g. Explosion
    return `${name} {
    variant_of ${parent}

    meta {
        name "${base}_NAME"
        desc "${base}_DESC"
    }

    graphics {
        particle ${o.movieclip || "Explosion"}
    }

    cost {
        infcantrip true
        mana ${o.mana ?? 1}
    }
}
`;
  }
  if (kind === "ability") {
    const parent = o.parent || "Spin";
    const mana = o.mana ?? 1;
    const damage = o.damage ?? "1+bonus_melee_ability_damage";
    const effects = o.statusEffect ? `\n        effects {\n            ${o.statusEffect} ${o.statusStacks ?? 1}\n        }` : "";
    return `${name} {
    variant_of ${parent}

    meta {
        name "${base}_NAME"
        desc "${base}_DESC"
    }

    cost {
        infcantrip true
        mana ${mana}
    }

    damage_instance {
        damage ${/^[\d.+-]/.test(String(damage)) ? damage : JSON.stringify(damage)}${effects}
    }
}
`;
  }
  if (kind === "passive") {
    const cls = o.class || "Fighter";
    const component = o.component || "UncappedHP";
    return `${name} {
    name "${base}_NAME"
    desc "${base}_DESC"
    class ${cls}

    1 {
        passives {
            ${component} 1
        }
    }
}
`;
  }
  if (kind === "item") {
    const rarity = o.rarity || "common";
    const itemKind = o.kind || "head";
    const component = o.component || "Metal";
    return `${name} {
    name "${base}_NAME"
    desc "${base}_DESC"
    rarity ${rarity}
    kind ${itemKind}
    frame ${o.frame ?? 0}

    passives {
        ${component} 1
    }
}
`;
  }
  // status-data (keyword_tooltips entry for a native-registered status)
  return `${name} {
    name "${base}_NAME"
    tooltip "${base}_DESC"
    tooltip_stackless "${base}_DESC"
}
`;
}

/** Does a GON append file already define a top-level entry `name`? */
function entryExists(abs: string, name: string): boolean {
  if (!existsSync(abs)) return false;
  try {
    const root = toValue(parse(readFileSync(abs, "utf8")));
    return root.t === "obj" && root.entries.some((e) => e.key === name);
  } catch {
    return false;
  }
}

export interface TemplatePlanFile {
  relPath: string;
  content: string;
  /** a binary file (room: the .lvl bytes); `content` is then a one-line summary */
  base64?: string;
}

export type TemplateResult =
  | { ok: false; error: string; partial?: string[] }
  | { ok: true; dryRun: true; kind: TemplateKind; name: string; files: TemplatePlanFile[]; localizationKeys: string[]; hint?: string }
  | { ok: true; kind: TemplateKind; name: string; written: string[]; localizationKeys: string[]; hint?: string };

/**
 * Scaffold a new content entry and its localization rows.
 * @param name the new entry's GON key (e.g. "MyCoolSpin")
 * @param options displayName, desc, parent, mana, class, component, statusEffect, gonFile, fillTranslations, write, dryRun
 */
export function newFromTemplate(modName: string, kind: TemplateKind, name: string, options: TemplateOptions = {}): TemplateResult {
  if (kind === "room" || kind === "tileset-variant") return levelTemplate(modName, kind, name, options);
  if (!Object.hasOwn(LOC_PREFIX, kind)) return { ok: false, error: `unknown template kind: ${kind}` };
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return { ok: false, error: `invalid entry name: ${JSON.stringify(name)} (letters, digits, underscore; not starting with a digit)` };
  }
  if (kind === "glowing-character") return glowingCharacter(modName, name, options);
  const gonRel = options.gonFile || DEFAULT_GON_FILE[kind];
  const gonAbs = join(MODS_DIR, modName, gonRel);
  if (entryExists(gonAbs, name)) {
    return { ok: false, error: `entry "${name}" already exists in mods/${modName}/${gonRel}` };
  }

  const base = `${LOC_PREFIX[kind]}_${toKeyToken(name)}`;
  const displayName = options.displayName || name;
  const desc = options.desc || `${displayName} (scaffolded)`;
  const fill = options.fillTranslations !== false;
  const entryGon = scaffoldGon(kind, name, options);

  // Compose the new GON append file text (append the entry if the file exists).
  let gonText: string;
  if (existsSync(gonAbs)) {
    const prev = readFileSync(gonAbs, "utf8").replace(/\s*$/, "");
    gonText = prev + "\n\n" + entryGon;
  } else {
    gonText = `// ${kind} entries added by the mewgenics mod editor (.append overlay)\n${entryGon}`;
  }

  // Compose the combined.csv.append rows (skip keys already present).
  const csvRel = "data/text/combined.csv.append";
  const csvAbs = join(MODS_DIR, modName, csvRel);
  const existingRows = existsSync(csvAbs) ? parseCsv(readFileSync(csvAbs, "utf8")) : [];
  const existingKeys = new Set(existingRows.map((r) => r[0]));
  const newRows: string[][] = [];
  const nameKey = `${base}_NAME`;
  const descKey = `${base}_DESC`;
  if (!existingKeys.has(nameKey)) newRows.push(locRow(nameKey, displayName, fill));
  if (!existingKeys.has(descKey)) newRows.push(locRow(descKey, desc, fill));
  const allRows = existingRows.filter((r) => !(r.length === 1 && r[0] === "")).concat(newRows);
  const csvText = serializeCsv(allRows) + (allRows.length ? "\n" : "");

  const noLoc = NO_LOC.has(kind);
  const locKeys = noLoc ? [] : [nameKey, descKey];
  const plan = {
    kind,
    name,
    files: (noLoc ? [{ relPath: gonRel, content: gonText }] : [
      { relPath: gonRel, content: gonText },
      { relPath: csvRel, content: csvText },
    ]) as TemplatePlanFile[],
    localizationKeys: locKeys,
  };

  if (options.dryRun === true) {
    return { ok: true, dryRun: true, ...plan };
  }

  const written: string[] = [];
  for (const f of plan.files) {
    const r = writeOverlay(modName, f.relPath, f.content);
    if (!r.ok) return { ok: false, error: r.error, partial: written };
    written.push(r.path);
  }
  return { ok: true, kind, name, written, localizationKeys: locKeys };
}

/** room / tileset-variant: plan with level/level-templates.ts, then write (binary for a .lvl) unless dryRun. */
function levelTemplate(modName: string, kind: "room" | "tileset-variant", name: string, options: TemplateOptions): TemplateResult {
  const plan = kind === "room" ? planRoom(modName, name, options) : planTilesetVariant(modName, name, options);
  if (!plan.ok) return plan;
  if (options.dryRun === true) return { ok: true, dryRun: true, kind, name, files: plan.files, localizationKeys: [], hint: plan.hint };
  const written: string[] = [];
  for (const f of plan.files) {
    const r = f.base64 !== undefined ? writeModBinary(modName, f.relPath, Buffer.from(f.base64, "base64")) : writeOverlay(modName, f.relPath, f.content);
    if (!r.ok) return { ok: false, error: r.error, partial: written };
    written.push(r.path);
  }
  return { ok: true, kind, name, written, localizationKeys: [], hint: plan.hint };
}

/** the glow status a colour option asks for, checked against the glow pattern of editor/registered-names.json (the rule
 * behind the validator's invalid-glow-name), or an error */
function glowStatusName(colour: unknown): { status: string } | { error: string } {
  const glow = registeredPatterns().find((p) => p.kind === "glow");
  if (!glow) return { error: "no glow pattern in editor/registered-names.json (kind glow)" };
  if (typeof colour !== "string" || colour.trim() === "") {
    return { error: `glowing-character needs options.colour: rrggbb or rrggbbaa hex (e.g. "ff00ff"), or the whole name ${glow.prefix}ff00ff` };
  }
  const c = colour.trim().replace(/^#/, "");
  const status = c.startsWith(glow.prefix) ? c : glow.prefix + c;
  if (!matchRegisteredPattern([glow], status)) {
    return { error: `invalid-glow-name: "${status}" is not a glow request: the colour must be 6 or 8 hex digits (rrggbb or rrggbbaa, e.g. ${glow.prefix}ff00ff)` };
  }
  return { status };
}

/** GON append text: the entry after the file's current content, or a new file with a header comment */
function appendEntry(abs: string, entry: string, what: string): string {
  return existsSync(abs) ? readFileSync(abs, "utf8").replace(/\s*$/, "") + "\n\n" + entry : `// ${what} added by the mewgenics mod editor (.append overlay)\n${entry}`;
}

function glowingCharacter(modName: string, name: string, o: TemplateOptions): TemplateResult {
  const g = glowStatusName(o.colour);
  if ("error" in g) return { ok: false, error: g.error };
  const status = g.status;
  const trigger = o.trigger || "StatusOnSpawnIn";
  if (!GLOW_TRIGGERS.includes(trigger)) return { ok: false, error: `unknown trigger "${trigger}": use ${GLOW_TRIGGERS.join(" or ")}` };
  const parent = o.parent || "Rat";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parent)) return { ok: false, error: `invalid parent: ${JSON.stringify(parent)}` };

  const charRel = o.gonFile || DEFAULT_GON_FILE["glowing-character"];
  const charAbs = join(MODS_DIR, modName, charRel);
  if (entryExists(charAbs, name)) return { ok: false, error: `entry "${name}" already exists in mods/${modName}/${charRel}` };
  const charEntry = `// ${name}: a ${parent} that glows while it carries the status ${status} (granted by ${trigger}).
// Load fw-glow next to this mod (it ships the rim shader). docs/data-mods.md "Asking for a unit glow from data".
${name} {
    variant_of ${parent}
    passives {
        ${trigger} {
            ${status} 1
        }
    }
}
`;
  const files: TemplatePlanFile[] = [{ relPath: charRel, content: appendEntry(charAbs, charEntry, "characters") }];

  // the status's display text: keyword_tooltips by the full status name (skipped when the mod already has one)
  const base = `KEYWORD_${toKeyToken(status)}`;
  const nameKey = `${base}_NAME`, descKey = `${base}_DESC`;
  const kwRel = "data/keyword_tooltips.gon.append";
  const kwAbs = join(MODS_DIR, modName, kwRel);
  if (!entryExists(kwAbs, status)) files.push({ relPath: kwRel, content: appendEntry(kwAbs, scaffoldGon("status-data", status, o), "keyword tooltips") });

  const csvRel = "data/text/combined.csv.append";
  const csvAbs = join(MODS_DIR, modName, csvRel);
  const existingRows = existsSync(csvAbs) ? parseCsv(readFileSync(csvAbs, "utf8")) : [];
  const existingKeys = new Set(existingRows.map((r) => r[0]));
  const fill = o.fillTranslations !== false;
  const newRows: string[][] = [];
  if (!existingKeys.has(nameKey)) newRows.push(locRow(nameKey, o.displayName || "Glowing", fill));
  if (!existingKeys.has(descKey)) newRows.push(locRow(descKey, o.desc || "This unit is outlined by a coloured glow.", fill));
  const allRows = existingRows.filter((r) => !(r.length === 1 && r[0] === "")).concat(newRows);
  files.push({ relPath: csvRel, content: serializeCsv(allRows) + (allRows.length ? "\n" : "") });
  const localizationKeys = [nameKey, descKey];

  if (o.dryRun === true) return { ok: true, dryRun: true, kind: "glowing-character", name, files, localizationKeys };
  const written: string[] = [];
  for (const f of files) {
    const r = writeOverlay(modName, f.relPath, f.content);
    if (!r.ok) return { ok: false, error: r.error, partial: written };
    written.push(r.path);
  }
  return { ok: true, kind: "glowing-character", name, written, localizationKeys };
}
