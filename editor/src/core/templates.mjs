// new_from_template: scaffold an ability / passive / item / status-data overlay
// plus matching localization rows, writing them under mods/<name>/ (or returning
// the content for a dry run). Generated GON uses the .append overlay mode.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MODS_DIR } from "./repo.mjs";
import { parse } from "./gon/parser.mjs";
import { toValue } from "./gon/value.mjs";
import { parseCsv, serializeCsv } from "./overlay/csv.mjs";
import { LOC_COLUMNS } from "./base-data.mjs";
import { writeOverlay } from "./mod-io.mjs";

/** @typedef {'ability'|'passive'|'item'|'status-data'} TemplateKind */

const LOC_PREFIX = { ability: "ABILITY", passive: "PASSIVE", item: "ITEM", "status-data": "KEYWORD" };
const DEFAULT_GON_FILE = {
  ability: "data/abilities/mod_abilities.gon.append",
  passive: "data/passives/mod_passives.gon.append",
  item: "data/items/mod_items.gon.append",
  "status-data": "data/keyword_tooltips.gon.append",
};

/** @param {string} s */
function toKeyToken(s) {
  return s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

/**
 * Build a 12-column localization row. Translations default to the English text
 * as a placeholder so a fresh scaffold validates cleanly; `notes` flags it.
 * @param {string} key
 * @param {string} en
 * @param {boolean} fillTranslations
 * @returns {string[]}
 */
function locRow(key, en, fillTranslations) {
  const row = new Array(LOC_COLUMNS.length).fill("");
  row[0] = key;
  row[1] = en;
  row[2] = "scaffolded by editor; TODO translate";
  for (let i = 3; i < LOC_COLUMNS.length; i++) row[i] = fillTranslations ? en : "";
  return row;
}

/**
 * @param {TemplateKind} kind
 * @param {string} name
 * @param {Record<string, any>} o
 * @returns {string}
 */
function scaffoldGon(kind, name, o) {
  const base = `${LOC_PREFIX[kind]}_${toKeyToken(name)}`;
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

/**
 * Does a GON append file already define a top-level entry `name`?
 * @param {string} abs
 * @param {string} name
 */
function entryExists(abs, name) {
  if (!existsSync(abs)) return false;
  try {
    const root = toValue(parse(readFileSync(abs, "utf8")));
    return root.t === "obj" && root.entries.some((e) => e.key === name);
  } catch {
    return false;
  }
}

/**
 * Scaffold a new content entry and its localization rows.
 * @param {string} modName
 * @param {TemplateKind} kind
 * @param {string} name                      the new entry's GON key (e.g. "MyCoolSpin")
 * @param {Record<string, any>} [options]    displayName, desc, parent, mana, class, component, statusEffect, gonFile, fillTranslations, write, dryRun
 */
export function newFromTemplate(modName, kind, name, options = {}) {
  if (!LOC_PREFIX[kind]) return { ok: false, error: `unknown template kind: ${kind}` };
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return { ok: false, error: `invalid entry name: ${JSON.stringify(name)} (letters, digits, underscore; not starting with a digit)` };
  }
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
  let gonText;
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
  /** @type {string[][]} */
  const newRows = [];
  const nameKey = `${base}_NAME`;
  const descKey = `${base}_DESC`;
  if (!existingKeys.has(nameKey)) newRows.push(locRow(nameKey, displayName, fill));
  if (!existingKeys.has(descKey)) newRows.push(locRow(descKey, desc, fill));
  const allRows = existingRows.filter((r) => !(r.length === 1 && r[0] === "")).concat(newRows);
  const csvText = serializeCsv(allRows) + (allRows.length ? "\n" : "");

  const plan = {
    kind,
    name,
    files: [
      { relPath: gonRel, content: gonText },
      { relPath: csvRel, content: csvText },
    ],
    localizationKeys: [nameKey, descKey],
  };

  if (options.dryRun === true) {
    return { ok: true, dryRun: true, ...plan };
  }

  const written = [];
  for (const f of plan.files) {
    const r = writeOverlay(modName, f.relPath, f.content);
    if (!r.ok) return { ok: false, error: r.error, partial: written };
    written.push(r.path);
  }
  return { ok: true, kind, name, written, localizationKeys: [nameKey, descKey] };
}
