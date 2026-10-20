# SWF emitter fix spec — why the hand-emitted gate SWF crashes `glaielswf`

## 0. Status 2026-10-19 — implemented, gated in-game, crash not reproducible at boot

Branch `fix/swf-append-frame` (worktree). What changed since the spec below was written:

- **§8.1's premise was wrong (OBSERVED, read-only parse of `swfs/ability_icons.swf`, pinned by a T1 test in
  `editor/test/art-emitter-tests.ts`):** `AbilityIcon` (sprite 1346, 901 frames, 842 unique labels, first
  `unknown`) places **no nested movieclips**. Every labeled icon frame is `FrameLabel` + exactly one
  `PlaceObject2` at **depth 3** of a bare `DefineShape/2/3/4` — flags 6 (HasCharacter|HasMatrix, identity) on
  first use, flags 3 (Move|HasCharacter) on swaps (one scaled outlier). Frame 0 adds a background shape at depth 1,
  a `DefineEditText` named `label` at depth 2 (removed at frame 1) and a border `DefineShape4` at depth 5; the
  tail removes depths 5 and 1 and ends with seven empty frames; the ABC only registers `frame1 → stop()`.
  `PassiveIcon` (id 515) is the same pattern at depth 4. Our donor's one mismatch was **depth 1 instead of 3**.
- **Fix applied:** `minimalGateSwf` places the icon as a bare shape at depth 3 with an identity matrix
  (`ABILITY_ICON_DEPTH`); `layout: "nested"` (this spec's §8.1 form) and `layout: "legacy"` (the pre-fix depth-1
  donor) are kept as gate variants. `DEFAULT_ABC_MODE` was already `"none"`.
- **Gate (T2, `npm run test:swfgate -- <variant>`, mod `mods/swf-gate/`, harness boot to the main menu), all
  with the real save hash-verified unchanged:**

  | variant | donor | harness verdict |
  |---|---|---|
  | control | no gate files | pass |
  | probe | same bytes, linkage `GateProbe` (no merge) | pass |
  | flat | shape at depth 3 (the fix) | pass |
  | nested | nested movieclip at depth 3 (§8.1) | pass |
  | legacy | shape at depth 1 (the 2026-10-18 donor) | **pass** — also with dev-sandbox + jokers-luck loaded, a visible window, and 10 s at the menu |
  | missing | linkage `_Append_NoSuchClipXYZ` | harness-error / console_unavailable: the engine logs `Append movieclip: _Append_NoSuchClipXYZ could not locate original movieclip to append to` (`Application.cpp:1363`) and the boot never reaches the console (no crash report) |

  The `missing` stall proves the harness launch loads `swfs/swflist.gon.append` and runs
  `process_animation_merges` over our SymbolClass; `legacy` passing means **the 2026-10-18 crash is not a
  boot-time merge fault**. The crash chain's outer frames (`appmain → FUN_9bad00 → FUN_9bb110`) are the running
  frame loop, so the fault most likely fires when the appended frame is *displayed* (the 10-18 procedure opened the
  Joker's Luck content so the icon was drawn), which the harness cannot do yet (TODO target 1: enter a run).
- **Open:** the T3 visual check (owner): `npm run test:swfgate -- flat --prepare-only`, then
  `launch-dev.bat mods\swf-gate`, enter the dev run, view `JokersGambit` — icon drawn and no `crash_*.txt` =
  fixed; a crash = decompile `FUN_140a58440` (merge) and `0x9a8f30` (movieclip advance) next.
- Also observed on the way: `-mewtest_clean 1` logs "script finished … (clean exit)" and then never exits
  (killed after 7 min; TODO verification item updated); an unknown `_Append_` target is a silent boot stall for
  modders, not a warning.

Status of reverse-engineering method (read this first):

- **Crash offsets, call chain, fault instruction, and the `_Append_` convention were
  resolved statically** by parsing `Mewgenics.exe` directly (PE export table, section map,
  inline string constants, RTTI, and by decoding the exact `call`/`lea`/`mov` bytes at the
  return addresses in the crash dump). No Ghidra was needed for these; they are **OBSERVED**
  from the shipped binary.
- **Ghidra decompilation succeeded** (via `tools/rea-mcp.mjs` watch mode against
  `rea-ghidra:12.1.4` with `REA_GHIDRA_STARTUP_TIMEOUT_MS=1800000`; see §7). It confirmed
  `process_animation_merges`, the cutscene-command handler, and the fault function. Claims
  backed by decompiler output are **OBSERVED (decompiled)**; claims from static byte decoding
  are **OBSERVED (static)**; the single remaining causal link not provable even from the
  decompilations in hand is tagged **INFERRED**.
- Community convention facts are tagged **COMMUNITY-SOURCED** (CVS-otherwise-Callie's
  Mewgenics modding docs + corroborating repos; see §3).

Evidence tags: **OBSERVED** = measured on this machine/binary. **INFERRED** = reasoned from
observed evidence, not directly proven. **COMMUNITY-SOURCED** = external modding docs.

---

## 1. Executive summary

- **The SWF is NOT rejected by the tag parser.** Our gate SWF (`mod_abc_gate_none.swf` /
  `mod_abc_gate_stub.swf`, produced by `editor/src/core/art/swf-emitter.ts
  → minimalGateSwf`) parses cleanly: header, `FileAttributes`, `SetBackgroundColor`,
  `DefineSceneAndFrameLabelData`, `DefineShape3`, `DefineSprite`, `SymbolClass`
  (`_Append_AbilityIcon` → the sprite), `ShowFrame`, `End`. The crash happens **after**
  loading, during the engine's boot-time "advance clips / run frame scripts" phase.
  (OBSERVED, §4/§6.)
- **The crash is a null-pointer dereference deep in game code**, reached because our SWF is
  listed in `game [ ]` and carries the linkage `_Append_AbilityIcon`. At boot,
  `glaiel::ApplicationBase::process_animation_merges` (RVA `0x9bc070`) merges our clip into
  the vanilla `AbilityIcon` movieclip; a subsequent boot phase advances the loaded clips and
  runs a frame-script (`glaiel::swf::AVM2Bytecode::RunObjectScript`, RVA `0xb7f2b0`). That
  script issues a scripted call-by-name that the display-object dispatcher resolves to a native
  `std::function` callback — the engine's **adventure cutscene command handler** (RVA
  `0x3c0210`: a `memcmp`-on-`"embark"`/`"return"`/`"defeat"` dispatcher) — which builds the
  team-name/cat-quote string (RVA `0x8e130`, reads `data/catquotes.gon`,
  `CAT_EMBARK_SINGULAR_TEAMNAME`, `{Teamname}`, `One_Cat`, `_EmptyHouse`) and dereferences a
  null/empty pointer because there is no active adventure/team yet. (OBSERVED call chain + fault
  instruction + decompiled handler/builder; INFERRED that our merge is what makes that
  frame-script fire at that moment.)
- **The `_Append_AbilityIcon` linkage name is CORRECT.** The engine matches the exact 8-byte
  prefix `"_Append_"`; the `_Append_L` / `_Append_H` strings seen in a raw strings dump are an
  artifact (the 8-byte immediate `"_Append_"` followed by the opcode byte of the next
  instruction, `0x4C`=`L` / `0x48`=`H`) — **not** a real `L`/`H` layer convention. Do not
  "fix" the name to `_Append_L…`. (OBSERVED static + COMMUNITY-SOURCED.)
- **Top emitter fixes** (ordered, §8): (1) make the append donor **mirror `AbilityIcon`'s
  per-frame append structure** (the icon as a nested movieclip on a label-named frame) instead
  of a bare `DefineShape3` directly on the donor sprite — the decompiled merge appends our
  clip's frames/timeline into the live `AbilityIcon` object, so a mismatched frame perturbs its
  playback/script table; (2) default `abc:"none"` for append donors (DoABC is **not** required
  for SymbolClass binding — COMMUNITY-SOURCED + variant A OBSERVED); (3) keep the
  `_Append_AbilityIcon` linkage spelling and FWS/uncompressed output (both already correct — do
  not change). Note: character-ID collision is **not** the cause — the merge operates on
  resolved clip objects, not raw character IDs (OBSERVED, §3.1/§7), so each SWF's internal IDs
  are already resolved before the merge.

---

## 2. How the crash offsets were resolved (no Ghidra)

The crash dump (`crash_2026-10-18-16-19-58.txt`, identical to the supplied
`crash.gate.A-or-B.txt`) symbolizes every game frame as `Mewgenics!<nearest-export>+0xOFF`.
`FAPOBase_Initialize` is simply the nearest **exported** symbol below each address (the game
statically links FAudio/SDL, whose export names leak into the PE export directory and are
misattributed by DbgHelp). Method:

1. Parsed the PE export directory of `Mewgenics.exe` (image base `0x140000000`, PE32+). The
   export `FAPOBase_Initialize` = RVA `0x50fa0`; `SDL_wcstol` = `0xba9a00`;
   `FAPOBase_CalcOutputFrames` = `0xc16160`. (OBSERVED.)
2. True VA of each frame = export VA + printed offset. Verified by re-deriving the
   nearest-preceding export for each computed VA — it reproduces the dump's labels exactly.
3. Mapped each VA to its containing function via `.analysis/list_procedures.tsv`
   (56,359 functions), then decoded the `call` instruction ending at each frame's return
   address to prove the caller→callee edges (direct `E8 rel32` vs. indirect
   `FF /2` virtual calls).

All crash VAs lie in `.text` (`0x140001000..0x140e3e800`), i.e., real code. Scripts used are
in the session scratchpad (`resolve-crash.mjs`, `analyze-frames.mjs`, `dump-sites.mjs`,
`probe-append.mjs`, `find-vtables.mjs`). Nothing in the game install, gpak, or saves was
modified.

---

## 3. Verified append / linkage / symbol-resolution convention

### 3.1 From the binary (OBSERVED, static)

- The glaielswf engine is `glaiel::swf::*` (Tyler Glaiel's engine; source paths like
  `C:\Users\Tyler\Desktop\SVN\Engine\code\glaielswf\...` are embedded as `__FILE__` asserts).
- SWF loading: `glaiel::swf::SWF::load` (RVA `0x9b1d80`, asserts `"DOUBLE LOADING SWF"`),
  `glaiel::ApplicationBase::load_swf` (RVA `0x9bb9e0`, `"SWF File does not exist: "`),
  `glaiel::ApplicationBase::process_animation_merges(swf::SWF*)` (RVA `0x9bc070`). The tag
  dispatcher `glaiel::swf::SWFTag::createTag` (RVA ~`0xa2f4a0`) recognizes exactly:
  `JPEGTables, DefineShape, PlaceObject, DefineShape2/3/4, PlaceObject2/3, DefineBitsJPEG2/3/4,
  FrameLabel, DefineSprite, ExportAssets, SymbolClass, DefineSceneAndFrameLabelData, ShowFrame,
  DoABC, DoAction`; everything else logs `"Unknown Tag"`. (OBSERVED.)
- **Append matching lives inside `process_animation_merges`.** At RVA `0x9bc0bd` the code is
  `mov rax, 0x5f646e6570415f` — the 8-byte immediate ASCII `"_Append_"` — then it checks the
  SymbolClass/linkage name length ≥ 8 and compares its first 8 bytes to `"_Append_"`
  byte-for-byte (a second identical compare at RVA `0x9bc1e9`). The suffix after `"_Append_"`
  is the target clip's linkage name. **There is no `L`/`H` discriminator**: the `_Append_L` /
  `_Append_H` seen in a naive strings scan are the immediate `"_Append_"` plus the first opcode
  byte of the following instruction (`0x4C`=`lea`, `0x48`=REX.W). (OBSERVED, static.)
- `process_animation_merges` is called from `FUN_0x9baaa0` (the per-SWF load+merge driver,
  which also calls `load_swf`), itself reached from `glaiel::ApplicationBase::appmain`
  (RVA `0x9b9970`; logs `"Initiating Loader..."`, `"Loading..."`, `"swfs/"`,
  `"TOTAL LOADING TIME: "`). So the merge runs at boot for every `game [ ]` SWF. (OBSERVED.)

### 3.2 From community docs (COMMUNITY-SOURCED)

Authoritative source: **CVS-otherwise-Callie**, "Mewgenics Modding Documentation"
(`github.com/CVS-otherwise-Callie/mewgenics-modding-documents`, `docs/*.md`), corroborated by
`ombrellus/MewgenicsScriptResources`, `Sploder12/mewgenerate` (a parser reimplementation), and
real mods (`SurrealDude/Mewgenics-Area-Template`, `dragonslayer55/mewspansion`). (`tcrf.net`
was not consulted, per policy.)

- **Append naming = `_Append_` + the verbatim original AS-linkage label** of the target
  movieclip. Examples from the docs: `Furniture → _Append_Furniture`,
  `modular_cutscenes_fla.BossArt_3 → _Append_modular_cutscenes_fla.BossArt_3`. The `L`/`H`
  low/high-layer idea is **not documented anywhere** — matching the binary finding that it is
  an artifact. So `_Append_AbilityIcon` is the correct form to append to the `AbilityIcon` clip.
- **swflist registration**: a `swflist.gon.append` with a `game [ … ]` list (optionally
  `loader loader.swf` and `per_file_curve_resolution { <file.swf> <int> }`). `.append`
  concatenates to the base `swflist.gon`, so appended SWFs load **last** (our donor loads after
  `ability_icons.swf`, so `AbilityIcon` already exists when our merge runs — OBSERVED in the
  real `swflist.gon`).
- **Binding is via `SymbolClass` (tag 76) name only; a `DoABC`/AS3 class is NOT required** to
  bind. Adobe Animate emits a DoABC stub incidentally when "Export for ActionScript" is ticked,
  but the engine keys on the SymbolClass name. (COMMUNITY-SOURCED; consistent with our
  observation that crash variant **A has no DoABC** yet still crashes.)
- **Hard requirements**: SWF must be **uncompressed (`FWS`)** and published **non-strict**;
  never reuse a vanilla filename; and an appended clip should be **"set up similarly to the
  original moviescript"** — for the label-driven clips (furniture, and by the same pattern
  `AbilityIcon`), a visual frame plus a label frame, with every appended object wrapped as a
  movieclip to avoid raw-graphic overlay between mods.

### 3.3 The append target `AbilityIcon` (OBSERVED, from `ability_icons.swf`)

- `ability_icons.swf`: `FWS` v17, character IDs **1..1346**. `SymbolClass`
  `{AbilityIcon→1346, PassiveIcon→515}`. Uses `ImportAssets2` and a `DoABC` with
  `addFrameScript`.
- `AbilityIcon` = sprite **id 1346**, **901 frames**, **842 FrameLabels** (ability names;
  `"unknown"` is the first/fallback label), 836 `PlaceObject2`. `"JokersGambit"` is not a
  vanilla label (it comes from the `jokers-luck` dev mod). The intended append adds a frame
  labeled `JokersGambit` carrying that ability's icon.

---

## 4. The resolved crash call chain (OBSERVED)

Innermost game frame (8) is the fault; frames 0–1 are the game's own crash reporter; 2–7 are
the OS unhandled-exception/dispatch path. `d`=direct call, `v`=virtual call `mov rax,[rcx];
call [rax+disp]`. (A prior partial pass also tagged frames 13/15 as `switchD_*::caseD_*` and
frame 14 as `switchD_140B7F3F5` — i.e. the AVM2 opcode-dispatch and interpreter-state switches,
which corroborates the identities below.)

| # | VA | Containing function (RVA) | Identity / evidence | edge to inner |
|---|----|---------------------------|---------------------|----|
| 25 | `0x140c0a3c0` | `FUN_c0a3c0` | entry wrapper; refs `"Error processing command line arguments"`, `"Fatal Error"` | v → 24 |
| 24 | `0x1409b5230` | `FUN_9b5230` | tiny boot shim | d → 23 |
| 23 | `0x1409b9970` | **`ApplicationBase::appmain`** | refs `"Initiating Loader..."`,`"Loading..."`,`"swfs/"`,`"TOTAL LOADING TIME: "` | d → 22 |
| 22 | `0x1409bad00` | `FUN_9bad00` | boot step (SDL perf timing) | d → 21 |
| 21 | `0x1409bb110` | `FUN_9bb110` | boot step | d → 20 |
| 20 | `0x1409d56f0` | `FUN_9d56f0` | clip/scene update | v [rax+0x80] → 19 |
| 19 | `0x14096aeb0` | `FUN_96aeb0` | display-object update | v [rax+0x20] → 18 |
| 18 | `0x14097ad10` | `FUN_97ad10` | display-object update | d → 17 |
| 17 | `0x1409a8720` | `FUN_9a8720` | movieclip advance (glaielswf `0x9a8xxx`) | d → 16 |
| 16 | `0x1409a80c0` | `FUN_9a80c0` | movieclip advance | d → 15 |
| 15 | `0x1409a8f30` | `FUN_9a8f30` (`switchD_9a8f5e`) | runs object frame script | d → 14 |
| 14 | `0x140b7f2b0` | **`swf::AVM2Bytecode::RunObjectScript`** (`switchD_b7f3f5`) | refs `AVM2Bytecode.cpp`, `"UNSUPPORTED INSTRUCTION: "`, the `RunObjectScript` funcsig | d → 13 |
| 13 | `0x14099aaa0` | `FUN_99aaa0` (`switchD_99afb7`) | `swf::DisplayObjectContainer` — builds a `glaiel::Param` arg list (decompiled) | d → 12 |
| 12 | `0x14099dec0` | `FUN_99dec0` | **scripted call-by-name**: builds a name string, red-black-tree lookup, invokes the bound `std::function` (decompiled) | v [rax+0x10] → 11 |
| 11 | `0x14029ae10` | `std::_Func_impl…_Do_call` | **`std::function` `_Do_call`** (RTTI at vtable `0x140f056a0` names it a `PauseMenu::TryAbandonRun` lambda); invokes the resolved callback | d → 10 |
| 10 | `0x1403c0210` | `FUN_3c0210` | **adventure cutscene-command handler** (decompiled): `memcmp` on `"embark"`/`"return"`/`"defeat"`; plays `audio/music/stingers/team_intro.ogg`, reads adventure/team state | d → 9 |
| 9 | `0x1403c8b80` | `FUN_3c8b80` | cutscene sub-step | d → 8 |
| 8 | `0x14008f8c6` | `FUN_8e130` (+0x1796) | **FAULT**: cat-quote builder; refs `"data/catquotes.gon"`,`"CAT_EMBARK_SINGULAR_TEAMNAME"`,`"CAT_RETURN_SINGULAR_TEAMNAME"`,`"One_Cat"`,`"_EmptyHouse"` | — |

### The fault instruction (OBSERVED)

At the fault IP `0x14008f8c6` the bytes are `48 8B 40 08  48 8B 18` =
`mov rax,[rax+8]; mov rbx,[rax]`. The function has just called a getter (`mov rcx,rdi;
lea rdx,[rbp+0x70]; call …`) returning an object in `rax`; it then loads a pointer at
`[rax+8]` and dereferences it (`[rax]`). The inner pointer is **null/garbage** → access
violation. This is the classic shape of reading `begin()`/first element of an empty-or-unset
container (team/cat/quote list) that does not exist at boot. (OBSERVED, static decode.)

The virtual dispatches at frames 12/18/19 (`mov rax,[rcx]; call [rax+disp]`) **succeeded** —
the objects and vtables were valid — so this is a legitimate code path reached with bad game
*state*, not a jump through a smashed vtable. (OBSERVED.)

### What this means

The SWF parsed and loaded. During boot, `process_animation_merges` merged our
`_Append_AbilityIcon` donor; a later boot phase (`appmain → FUN_9bad00 → … → RunObjectScript`)
advanced the loaded clips and ran a frame script that invoked the adventure-return/
`TryAbandonRun` cutscene callback with no active run → null deref in the cat-quote builder.
Crash **variant A carries no DoABC**, so the frame script being run is a **vanilla** clip's,
not ours — i.e., our merge perturbs shared state and a *vanilla* boot-time script is what
faults. (Call chain + fault = OBSERVED; "our merge perturbs shared state" = INFERRED, see §7.)

---

## 5. Byte-level structural diff vs. a vanilla SWF

Our gate SWFs were regenerated with `node` into the session scratch dir (no `npm install`,
nothing written into `editor/` or `mods/`); vanilla `minecarts.swf` (7,024 B) and
`ability_icons.swf` (2,243,520 B) were extracted read-only with
`python -I tools/gpak.py cat …` and both were parsed with
`editor/src/core/art/swf-reader.ts`.

### 5.1 Tag stream — ours vs. vanilla

| aspect | ours (gate) | vanilla (`minecarts.swf` / `ability_icons.swf`) |
|---|---|---|
| signature/version | `FWS` v17 ✓ | `FWS` v17 ✓ (match — good) |
| header tags | `FileAttributes(0x08)`, `SetBackgroundColor ffccff`, `DefineSceneAndFrameLabelData(1 scene "Scene 1")` ✓ | identical order ✓ |
| library | 1 `DefineShape3` + 1 `DefineSprite` | many `DefineShape/2/3/4` + several `DefineSprite`; AbilityIcon is a 901-frame sprite |
| character IDs | **1 (shape), 2 (sprite)** | 1..28 (minecarts), **1..1346** (ability_icons) |
| exported clip | `DefineSprite id=2`, 1 frame, `FrameLabel "JokersGambit"` + 1 `PlaceObject2(char=1,depth=1)` | AbilityIcon = sprite 901 frames, 842 labels, 836 places, nested movieclips |
| `SymbolClass` | `{2 → "_Append_AbilityIcon"}` | real class names (`MinecartCat`, `minecarts_fla.*`, `AbilityIcon`) |
| `DoABC` | A: none; B: minimal (1 class, 12 strings, 3 methods) | always present, full Flash ABC (minecarts: 10 classes, 69 strings, `addFrameScript`, `setRandomFrame`) |

### 5.2 Structural differences that matter for the loader

1. **Donor does not mirror the target clip (leading structural suspect).** `AbilityIcon`
   places **nested movieclips** on labeled frames; our donor places a **bare `DefineShape3`**
   directly on its one frame. The decompiled merge (§7) hands two *resolved clip objects*
   (target `AbilityIcon`, our source sprite) to `FUN_140a58440`, which appends our clip's
   frames/timeline into the live `AbilityIcon` object. A frame that does not match the target's
   per-frame layout (icon-as-movieclip on an icon layer, name on the label frame) perturbs
   `AbilityIcon`'s playback/frame-script bookkeeping; the subsequent first scene update then
   runs a scripted call-by-name that resolves to the adventure cutscene-command handler.
   Community guidance: wrap each appended object as a movieclip and set the clip up "similarly
   to the original". (COMMUNITY-SOURCED + INFERRED.)
2. **Character-ID collision is NOT the cause.** We emit IDs 1/2 and `AbilityIcon`'s host owns
   1..1346, but `process_animation_merges` passes **resolved clip objects**, not raw character
   IDs, to the merge (OBSERVED, §7). Each SWF resolved its own character IDs to objects at load,
   so our low IDs do not clobber the target's. (A high `idBase` is at most a cheap defensive
   guard, not the fix — see §8.)
3. **`DoABC` is emitted for variant B but is unnecessary and risky.** Binding uses
   `SymbolClass` alone (§3.2). Running our hand-built ABC through glaielswf's AVM2 interpreter
   (frame 14) is avoidable attack surface; variant A proves binding/crash do not need it.
   (COMMUNITY-SOURCED + OBSERVED.)
4. **Things that are already correct — do not change:** `FWS`/uncompressed; the
   header/`FileAttributes`/`SetBackgroundColor`/`DefineSceneAndFrameLabelData` order;
   `DefineShape3` encoding; the `_Append_AbilityIcon` linkage spelling; the single labeled
   frame carrying the ability name. (OBSERVED.)

---

## 6. Root cause

**Confirmed (OBSERVED, incl. decompilation):**
- The SWF is syntactically valid and fully loads.
- `process_animation_merges` (`0x9bc070`, decompiled) iterates our SWF's SymbolClass map;
  for each name of length ≥ 8 whose first 8 bytes equal `"_Append_"` it takes the target name
  = the substring after `"_Append_"`, looks the target clip up **by name**
  (`FUN_1409bb6f0(app, name)`), fetches our source clip, and — if **both** are found — calls
  the merge `FUN_140a58440(target, source)` on the two **resolved clip objects**. If either is
  missing it logs a **non-fatal** `"Append movieclip: <name> could not locate original
  movieclip to append to"` and moves on. So for us the target `AbilityIcon` is found and the
  merge runs; it is an object-level timeline append, not an ID-table merge.
- The fault (`0x8e130`, decompiled) is the **team-name/cat-quote builder** (reads
  `data/catquotes.gon`, formats `CAT_EMBARK/RETURN_SINGULAR_TEAMNAME` with `{Teamname}`,
  `One_Cat`, `_EmptyHouse`). It is called from the **adventure cutscene-command handler**
  (`0x3c0210`, decompiled: `memcmp` on `"embark"`/`"return"`/`"defeat"`), which is itself
  reached by a scripted **call-by-name** dispatch (`0x99dec0` → `std::function`, decompiled)
  driven by glaielswf's AVM2 interpreter during the first scene update after load. The fault is
  a null double-deref (`mov rax,[rax+8]; mov rbx,[rax]`) on team/cat state that does not exist
  yet.
- The crash reproduces without any DoABC of ours (variant A), so the frame script that faults
  is a **vanilla** clip's, not ours.

**Inferred bridge (INFERRED — the one link not pinned by the decompilations in hand):**
Appending our structurally-naive donor frame into the live `AbilityIcon` object perturbs that
clip's playback/frame-script bookkeeping so that the first post-load scene update issues a
scripted call-by-name that the display-object dispatcher resolves to the adventure
cutscene-command handler with no active run — null-dereferencing the team/quote state. Pinning
this last step exactly would need `FUN_140a58440` (the merge) and the frame-15 movieclip-advance
(`0x9a8f30`) decompiled; the fix in §8 (make the donor mirror the target's per-frame structure)
addresses the producing boundary regardless.

---

## 7. Ghidra decompilation status

<!-- GHIDRA_STATUS -->
**Ghidra succeeded.** Two attempts were run (watch mode,
`REA_GHIDRA_STARTUP_TIMEOUT_MS=1800000`, named container for guaranteed cleanup). The first
failed at ~12.7 min with an internal error traced to a **pre-existing orphaned analysis
container from an earlier session competing for memory**, which was found and removed. The
second attempt (import/analysis `binary_overview` = 963 s ≈ 16 min, the pattern the prior
successful sessions used) completed and decompiled, all `ok`:
`process_animation_merges` (`0x9bc070`), the fault builder (`0x8e130`), the cutscene-command
handler (`0x3c0210`), the call-by-name dispatcher (`0x99dec0`) and its caller (`0x99aaa0`),
and `load_swf` (`0x9bb9e0`), plus xrefs of `0x9bc070` and `0x8e130`.

Findings used above (OBSERVED, decompiled): the `"_Append_"` 8-byte prefix match + by-name
target lookup + object-level merge via `FUN_140a58440`, with a non-fatal "could not locate
original movieclip" warning when the target is missing (§6); the fault builder's
`catquotes.gon` / team-name formatting (§4/§6); the cutscene-command handler's
`"embark"/"return"/"defeat"` dispatch (§4/§6).

Decompiled since 2026-10-20 (not yet read against §6): `.analysis/decompiled/Swf_Merge_0xa58440.c` (the actual
frame merge) and `Swf_MovieClipAdvance_0x9a8f30.c` (the movieclip advance that calls `RunObjectScript`). **No Ghidra
container or watcher is left running** (verified: `docker ps` clean, all `rea_ghidra_*`
containers removed, watcher processes killed).

---

## 8. Ordered emitter changes (specification — do NOT change code here)

Make these in `editor/src/core/art/`. Ordered by likelihood of being the operative defect.
The decompile (§7) established that the merge is an **object-level timeline append**
(`FUN_140a58440(targetClip, sourceClip)`), so the fix is about the donor's **frame/clip
structure**, not its byte/ID layout.

1. **Make the append donor mirror `AbilityIcon`'s per-frame layout** (leading fix — **corrected 2026-10-19,
   see §0**). The original text here assumed `AbilityIcon` placed nested movieclips on its labeled frames; the
   read-only parse shows it places a **bare shape at depth 3** per labeled frame. The donor now does exactly that
   (`ABILITY_ICON_DEPTH = 3`, identity matrix, one `ShowFrame`, one `FrameLabel` = the ability name). The nested
   form is kept only as the `nested` gate variant. Both forms boot and merge; neither the fix nor the pre-fix
   donor crashes at the main menu (§0), so the display-time check is what remains.

2. **Default `abc:"none"` for append donors; never emit a DoABC solely to bind.**
   `emitSwf`/`minimalGateSwf` should treat `SymbolClass` as sufficient for linkage
   (COMMUNITY-SOURCED + variant A OBSERVED crashes without a DoABC). Keep the `abc:"stub"` path
   only for the explicit gate experiment, and if ever required it must be byte-exact (see #5).
   Set `scene.ts DEFAULT_ABC_MODE = "none"`.

3. **Do not alter the `_Append_` linkage spelling, and keep FWS/uncompressed output.**
   `exports` key `_Append_AbilityIcon` is correct — the engine matches the exact 8-byte
   `"_Append_"` prefix (OBSERVED, decompiled) and looks the remainder up as a clip name, so the
   suffix must be the target's **exact registered clip name**. Explicitly reject any change to
   `_Append_L…`/`_Append_H…` (that convention does not exist, §3). Keep `FWS`/uncompressed.

4. **(Defensive, not the cause) optional non-colliding character-ID base.** Because the merge
   is object-level (§7), the donor's low IDs (1,2) do **not** clobber the target's. An
   `appendMode`/`idBase` option raising the donor's base is at most belt-and-suspenders and is
   **not** expected to change the crash; do it only if a future decompile of `FUN_140a58440`
   shows an ID-keyed path. Do not spend effort here first.

5. **If a DoABC is emitted at all, keep it strictly Flash-faithful with no frame scripts.**
   `abc-stub.ts` must not emit `addFrameScript` or any frame-script-bearing trait; its
   class-init must only declare the class. (Our stub already does only this; keep it so, because
   glaielswf *does* execute DoABC via its AVM2 interpreter — §4 frame 14 — unlike some community
   parsers that ignore it.)

6. **Keep the already-correct invariants** (regression guards): `FWS`/uncompressed output;
   header tag order; `DefineShape3` fill-side rule; single scene `"Scene 1"`; `frameRate` 60;
   `FileAttributes 0x08`.

### Validation to run after implementing (no game bytes modified)

- Done (2026-10-19): `npm test` re-parses the donor and asserts depth 3 / flags 6 / identity / bare
  `DefineShape3` on the labeled frame, plus parity with `AbilityIcon`'s first labeled frame (T1).
- Done (2026-10-19): `npm run test:swfgate -- control|probe|flat|nested|legacy|missing` (§0 table). Still owed:
  the visual check that the `JokersGambit` icon renders instead of `unknown` inside a run (T3, owner).
- If the crash persists after #1, decompile `FUN_140a58440` (the merge) and `0x9a8f30` (the
  movieclip advance) to pin the exact perturbation.

---

## 9. Artifacts / provenance

- Crash dumps (OBSERVED): `…/Glaiel Games/Mewgenics/<id>/logs/crash_2026-10-18-16-19-58.txt`
  (= supplied `crash.gate.A-or-B.txt`).
- Binary: `Mewgenics.exe` SHA-256 `4127cd6a792ae528bca6f65a8873dd61789591937d87656c2b586a5e30eb77ea`,
  build 1.1.21239 / Steam `25143593`, image base `0x140000000`.
- Static analysis scripts (session scratch, not committed): `resolve-crash.mjs`,
  `analyze-frames.mjs`, `dump-sites.mjs`, `probe-append.mjs`, `find-vtables.mjs`,
  `callers.mjs`, `emit-and-diff.mjs`, `parse-abilityicons.mjs`.
- Gate fixtures: `editor/src/core/art/swf-emitter.ts#minimalGateSwf`,
  `editor/src/core/art/art-io.ts#prepareSwfGate` (variants flat/nested/legacy/probe/missing/control, mod
  `mods/swf-gate/`, runner `editor/scripts/swf-gate.ts`).
- Append convention corroboration (COMMUNITY-SOURCED):
  `github.com/CVS-otherwise-Callie/mewgenics-modding-documents` (`docs/SWF_appendation.md`,
  `SWF_home.md`, `SWFOverview.md`); `ombrellus/MewgenicsScriptResources`;
  `Sploder12/mewgenerate`; `SurrealDude/Mewgenics-Area-Template`.
