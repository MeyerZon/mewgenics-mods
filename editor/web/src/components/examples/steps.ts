// The worked examples' step lists (UX PR 6): ONE array per example holds each step's title, sub-line, body and
// jump action, so the stepper's index and the content it shows cannot drift apart. The bodies are plain data
// (paragraphs with `inline code` marks, code blocks, notes) rendered by examples/Stepper.tsx, so Node can load this
// file in the unit tests. Illustrative: the examples never write to disk on their own.

/** One block of a step body. In text, `backticks` mark inline code. */
export type ExampleBlock =
  | { kind: "p"; text: string }
  | { kind: "muted"; text: string }
  | { kind: "ok"; text: string }
  | { kind: "code"; path?: string; chip?: string; text: string; gon?: boolean };

export interface ExampleStep<A extends string = string> {
  /** stable identity (the React key; never the index) */
  id: string;
  title: string;
  sub: string;
  body: ExampleBlock[];
  /** the jump into the live UI this step offers (see DataExample.tsx / ArtExample.tsx) */
  action?: A;
  actionLabel?: string;
}

export type DataExampleAction = "new-mod" | "scaffold" | "launch";
export type ArtExampleAction = "art-mode" | "new-scene" | "import" | "preview" | "build";

export const EXAMPLE_GON = `JokersGambit {
    variant_of Spin
    meta { name "ABILITY_JOKERSGAMBIT_NAME"; desc "ABILITY_JOKERSGAMBIT_DESC" }
    cost { infcantrip true; mana 0 }
    damage_instance { damage 0; effects { JokersLuck 1 } }
}`;

/** The sample mod's two ability rows (mods/jokers-luck/data/text/combined.csv.append): KEY, en, notes, then 9 languages. */
export const EXAMPLE_CSV = `ABILITY_JOKERSGAMBIT_NAME,Joker's Gambit,dev ability (mod),Apuesta del Bufón,Pari du Bouffon,Narrenwette,Azzardo del Giullare,Aposta do Bobo,Гамбит Шута,광대의 도박,道化の賭け,小丑的赌博
ABILITY_JOKERSGAMBIT_DESC,Spin and inflict Joker's Luck on everything hit.,dev ability tooltip (mod),Gira e inflige Suerte del Bufón.,Tourne et inflige Chance du Bouffon.,Wirbelt und verursacht Narrenglück.,Gira e infligge Fortuna del Giullare.,Gira e aplica Sorte do Bobo.,Вращение и наложение Удачи Шута.,회전하며 광대의 행운을 부여합니다.,回転して道化の運を与える。,旋转并施加小丑之运。`;

export const EXAMPLE_STEPS: ExampleStep<DataExampleAction>[] = [
  {
    id: "mod-folder",
    title: "Create the mod folder",
    sub: "mods/jokers-luck",
    body: [
      { kind: "p", text: "A mod is just a folder under `mods/`. The mod menu's New mod (or any + New overlay) creates it for you, with a `description.json`; nothing outside `mods/<name>/` is ever written, and your saves are never touched." },
      { kind: "muted", text: "The finished sample lives in `mods/jokers-luck/`: open it from the mod switcher to compare as you go." },
    ],
    action: "new-mod",
    actionLabel: "Open the New mod dialog →",
  },
  {
    id: "ability",
    title: "Add the ability overlay",
    sub: "JokersGambit, a Spin variant",
    body: [
      { kind: "p", text: "We append a new ability to the fighters' table. `variant_of Spin` inherits everything from the base Spin attack, then we point its on-hit `effects` at our status. Because this is an `.append`, no existing ability is touched." },
      { kind: "code", path: "mods/jokers-luck/data/abilities/fighter_abilities.gon.append", chip: ".append", text: EXAMPLE_GON, gon: true },
      { kind: "ok", text: "Validates now — except `JokersLuck` is still unknown. You'll register it in step 4." },
    ],
    action: "scaffold",
    actionLabel: "Insert this overlay (open scaffolder) →",
  },
  {
    id: "localization",
    title: "Add localization rows",
    sub: "name + tooltip, 12 columns",
    body: [
      { kind: "p", text: "The ability's `meta` names two text keys. Add one row per key to `data/text/combined.csv.append`. The columns are `KEY,en,notes,sp,fr,de,it,pt-br,ru,ko,ja,zh-cn` (docs/data-mods.md); an append file has no header line." },
      { kind: "code", path: "mods/jokers-luck/data/text/combined.csv.append", chip: ".append", text: EXAMPLE_CSV },
      { kind: "muted", text: "Fill every column: the validator's localization check flags a key that is missing from any of the 12. Quote a cell that contains a comma." },
    ],
  },
  {
    id: "native-name",
    title: "Register the native name",
    sub: "so JokersLuck validates",
    body: [
      { kind: "p", text: "A native mod (`native/mods/jokers-luck/`) registers the status `JokersLuck` and lists it in `editor/registered-names.json`. The validator reads that list, so the overlay's reference resolves." },
      { kind: "muted", text: "Illustrative: editing registered-names.json is a native-mod task, not something this example does for you." },
    ],
  },
  {
    id: "launch",
    title: "Validate & launch dev",
    sub: "bind JokersGambit in battle",
    body: [
      { kind: "p", text: "Re-run Validate (top bar). Then open Launch… in the top bar: it shows the `launch-dev.bat mods\\jokers-luck` command. Copy it and run it from the repo root with Steam open; it adds `-savesuffix dev`, so your real saves are never touched. The editor never starts the game itself." },
      { kind: "muted", text: "In a fight, bind JokersGambit to see JokersLuck reroll luck every turn." },
    ],
    action: "launch",
    actionLabel: "Show the Launch… command →",
  },
];

export const ART_SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="8" y="8" width="48" height="48" rx="10" fill="#888888"/>
  <circle cx="24" cy="28" r="5" fill="#222222"/>
  <circle cx="40" cy="28" r="5" fill="#222222"/>
  <path d="M20 42 Q32 52 44 42" fill="none" stroke="#dddddd" stroke-width="3"/>
</svg>`;

export const ART_EXAMPLE_STEPS: ExampleStep<ArtExampleAction>[] = [
  {
    id: "art-mode",
    title: "Switch to Art mode",
    sub: "Data | Art | Rooms switch",
    body: [
      { kind: "p", text: "The top-bar `Data | Art | Rooms` switch flips the whole editor. Art mode authors vector scenes and builds them into the SWF subset the engine loads — all writes still land only under `mods/<name>/`, so your saves are never touched." },
    ],
    action: "art-mode",
    actionLabel: "Enter Art mode →",
  },
  {
    id: "scene",
    title: "Create a scene",
    sub: "art/<name>.scene.json",
    body: [
      { kind: "p", text: "A scene is an `art/<name>.scene.json` file — the hand-editable source model of shapes, sprites and exports. It needs a mod (the top-bar mod switcher). The starter is a bobbing gray square with idle/blink labels." },
    ],
    action: "new-scene",
    actionLabel: "Open the New scene dialog →",
  },
  {
    id: "import",
    title: "Import an SVG",
    sub: "or a PNG",
    body: [
      { kind: "p", text: "Drop an SVG or a PNG on the Import card of the Shapes tab (or click it to pick a file). Each SVG becomes one shape; gradients and text are supported. Gray fills become `gray:0–15` levels the engine recolors; non-gray colours pass through and are flagged. A PNG imports as a sprite, a background plate or a bitmap fill. Here's a tiny sample — the `#888888` / `#222222` / `#dddddd` fills land on gray levels 8, 2 and 13:" },
      { kind: "code", text: ART_SAMPLE_SVG },
    ],
    action: "import",
    actionLabel: "Go to the Shapes panel to import →",
  },
  {
    id: "preview",
    title: "Preview it faithfully",
    sub: "palette row + scrubber",
    body: [
      { kind: "p", text: "The Preview draws the scene exactly as the engine does: the 16-level gray is remapped through a `palette.png` row (Browse rows… picks one), with timeline playback and a frame-label scrubber. View options: `show raw gray` shows the authored levels before the remap, plus the canvas background and a ghost cat on a `parts: game` rig." },
    ],
    action: "preview",
    actionLabel: "Open the Preview →",
  },
  {
    id: "build",
    title: "Build the SWF",
    sub: "swfs/<name>.swf",
    body: [
      { kind: "p", text: "Build emits `mods/<mod>/swfs/<name>.swf` plus a `swflist.gon.append`. SymbolClass binds the export names; the DoABC stub is optional. GON then addresses your art by its export names. Play the built SWF in the Ruffle tab, or Inspect it from the Built SWFs list." },
    ],
    action: "build",
    actionLabel: "Open the Build tab →",
  },
];
