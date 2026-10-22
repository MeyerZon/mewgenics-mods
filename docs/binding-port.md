# Binding port: keeping native mods alive across game updates

## The problem

Data mods (`mods/`) are GON/CSV text that the game's own `-modpaths` loader merges by file path, and
everything inside them refers to game content by **name**, resolved at runtime. A game update does not
touch them. Native mods are different: `mewframework.dll` is pinned to one exact `Mewgenics.exe` and
**fails closed** on any other (logs `unknown build: TimeDateStamp=... SizeOfImage=...`, installs no
hooks; `mewtest` then writes `end{code 4, reason framework_inactive}` and the runner's verdict is
`unknown-build`). What is pinned, per build:

| Pinned fact | Count on 25143593 | Where it is used |
|---|---|---|
| PE identity (TimeDateStamp + SizeOfImage) | 1 | `fw_identify_build` |
| Byte signatures of hooked/called functions | 77 signed function entries (40 of the 42 FwSymbol — 15 + 13 v4 run-entry/RNG + 7 glow + 2 glow v2 + `Character_Face` + 4 campaign walk — and 37 reference functions, 12 of them, since 2026-10-22, only as witness hosts: 7 for the Character/GonObject offsets, 4 for the glow offsets, `Character_recompute_stats` for the effective stats); `LuckUp_ctor`, `Status_GetCategory` (FwSymbol) and `Status_ApplyLuckUp` ship as `NULL` pattern + raw RVA, the 11 `FW_LK` lookups likewise | `resolve_symbols` |
| Raw RVAs of the 13 status-name lookups (`FW_LK`) | 13 (none has a signature worth having: twins differ only in `__LINE__` immediates) | `status_engine.c` |
| Data RVAs: App global (also exposed as the ShaderManager), MewDirector global, SDL3 DYNAPI jump table + 8 slots, default status source | 13 | `BuildInfo.rva_data`, `FW_GetData` |
| Vftables (LuckUp, Status, TacticsTest) and the LuckUp type id | 4 | vtable cloning, sanity check, the glow hook's slot check |
| Vtable slot indices / count | 7 (+`VT_TT_LATERENDER` 2026-10-22, by slot search; +`VT_CLIP_BOUNDS` glow v2, displacement witness) | `offsets.h` |
| Struct offsets | 98 (+ `GON_NODE_SIZE`) | `offsets.h` (`status_engine.c`, `mewtest.c`, `mt_gon.c`, `glow_engine.c`); 32 at the cross-build run, +8 on 2026-10-20 (dev scenes, RNG), +17 on 2026-10-22 (per-unit glow: TacticsTest cameras/passes, Camera, renderer extra layers, Pass fields, Character renderer/generation), +6 glow v2 (renderer clip, clip matrix, camera position/zoom/zoomY, scene-manager interpolation), +10 facing (the AnimStateMachine pointer, its suffix and flip, Character orientation / lock / sign / art_flip / no_horizontal_flip / always_face_forward / four_way, all witnessed in `Character_Face`), +8 campaign walk (MapScreen node count / nodes / marker, MapMarker node, MapNode type / next count / next data / done), +2 effective stats (`OFF_CH_STATS_EFF`, `OFF_CH_MAX_HP`) |
| Layer / slot / canvas constants | 7 (`CONST_MASK_LAYER`, `CONST_COMPOSITE_LAYER`, `CONST_GLOW_FRAMEBUF_SLOT`, glow v2 `CONST_CLIP_KIND_A/B` and the 1280x720 canvas `CONST_GLOW_CANVAS_W/H`; call-arg / displacement / rdata witnesses) | `glow_engine.c` |

## The manifest: `bindings/<steamBuildId>.json`

One file per build (schema: `bindings/manifest.schema.json`; validator: `editor/src/core/bindings/manifest.ts`).
`native/framework/src/signatures.h` (one `BuildInfo` + signature/lookup tables per manifest, so one DLL can know
several builds) and `native/framework/src/offsets.h` (shared `#define`s; the generator refuses when two manifests
disagree) are **generated** from it: `cd editor && npm run bindings:gen` (`bindings:check` for CI). Nothing
build-specific is typed by hand anywhere else; a golden test fails while the headers are stale.

Each entry has a `kind` (`function | data | vtable | constant | offset`), its value (`rva` or `value`), where it
surfaces (`exposure`: `FW_SYM_*` / `FW_DATA_*` enumerators, the `FW_LK` table with its A–E shape, a `BuildInfo`
field or an `OFF_*`/`VT_*` macro), who uses it (`consumers`), `evidence[]` (decompile paths under `.analysis/`),
and **anchors**, the evidence that finds it again:

| Entry kind | Anchors recorded by `tools/bindings/harvest.ts` |
|---|---|
| function | `signature` (shortest unique masked window, rel32 / rip-relative disp32 / imm64 wildcarded; may start later in the function, always on an instruction boundary, with a negative `offset`; `null` when no relocation-free unique window exists — the DLL then takes the manifest RVA on the identified build), `strings` (the MSVC `__FUNCSIG__` / `__FILE__` strings it references via rip-relative `lea`, with uniqueness; hand-added `literal` strings are kept), `callees` (calls to other manifest entries, by ordinal among all calls), `cfgLite` (bytes from `.pdata`, calls, rip refs), `prologue`, and the hand-written locators the harvest **verifies** on every run (a function row is `verified` / `mismatch`): `vtableStore { vtable, pattern }` (the only code site that stores an RTTI-derived vftable — constructors), `imm32Witness { pattern, imm32At, equals, callee, maxForward }` (an immediate equal to a constant re-derived on the new image, within N instructions before a call to a known callee), `callers [{ function, ordinal, afterStringLea, maxForward }]` (call #ordinal of a known caller, re-harvested, and/or the first in-tolerance E8 after that caller's `lea rdx,[rip+"literal"]`), `after` / `before` (the `.pdata` function right after / before a named entry, by table index), `sharedDataRef { with, ripRefOrdinal }` (the other function referencing rip ref #k of a named function), `dataRefs [{ rva, role }]` (globals it references; informational, ported by rip-ref ordinal) |
| data | `witness` (the function that references it and the ordinal of that rip-relative reference), or `derive { table, index }` |
| vtable | `rtti { typeDescriptorName }` (TypeDescriptor → CompleteObjectLocator → vftable) + `slotChecks` |
| constant | `derive { vtable, slot, bodyPattern, imm32At }` (read from the slot's code) and/or `witness { function, callee, pattern, imm32At, maxBack }` (the imm32 of the instruction matching `pattern` within `maxBack` instructions before the first call to `callee` inside `function`) and/or an rdata witness `witness { function, pattern, ripAt, rdata, lane? }` (the rip-relative disp32 at `ripAt` in the match points at a float in .rdata; `rdata: "f32"` takes it as the value, `"f32-recip"` its rounded reciprocal: the glow canvas 1280/720 is pinned by the 1/1280 and 1/720 LateRender multiplies by; port method `rdata`) and/or a displacement witness `witness { function, pattern, dispAt, dispSize, scale }` without a callee (the displacement of the matching instruction divided by `scale`: a `call [reg+8*slot]` witnesses a vtable slot index; port method `call-slot`). With two sources the port applies a value only when both agree; a split is `needs-human` with both values. `LuckUp_typeid` carries both since 2026-10-19 (slot 1 body of the LuckUp vftable; `mov r8d, imm32` before `Entity_FindComponentsByTypeId` in `Status_ApplyLuckUp`). |
| offset | `witness { function, pattern, dispAt, dispSize, nth, scale }` — the `nth` match of the byte pattern inside the function's `.pdata` body, the signed displacement at `dispAt` (1 byte, or 4 when `dispSize` is 4), divided by `scale` (default 1). `harvest.ts` verifies it against the manifest value on the current exe (`verified` / `mismatch` / `unresolved`; the CLI exits 1 on a mismatch or an unresolved offset) and `port.ts` ports it. Or `unanchored: true`. |

Facts the design rests on (verified on build 25143593): the exe's `.pdata` has 55,712 `RUNTIME_FUNCTION`
entries, so any address maps to its function without a disassembler; 12 of the 13 status lookups reference a
unique funcsig string (`enum glaiel::Status::StackMode __cdecl glaiel::get_status_stackmode(...)`); the 13th
(`Status_NameExists`) is the `.pdata` function right after `get_status_stackmode`; vftables are reachable through
x64 RTTI; the SDL jump table is referenced by the function that reads `SDL3_DYNAMIC_API`.

**Harvest the current build before the game updates** — the old exe disappears from the install:
`node tools/bindings/harvest.ts <exe> --manifest bindings/<build>.json --write` (a T1 test fails when the
committed anchors are stale). Keep a copy of the exe under `.analysis/exe/<build>/` (git-ignored).

## Tools

| Tool | Does |
|---|---|
| `tools/bindings/check-build.ts [exe]`, MCP `check_game_build` | identity + every signature scanned (`ok / moved / missing / ambiguous`); on an unknown build scans with the newest manifest to show what survived |
| `tools/bindings/make-signature.ts <exe> name=rva ...` / `--manifest <m> --write` | regenerate signatures (wildcards; old kept on failure) |
| `tools/bindings/harvest.ts <exe> --manifest <m> [--write]` | fill/verify anchors; reports mismatches without rewriting values |
| `tools/bindings/port.ts --from <old> --exe <new> --build <id> [--resolve N=0x..] [--apply]`, MCP `port_bindings` | the ladder below; writes `bindings/<id>.json` + `.port-report.md` only with `--apply` |
| `tools/bindings/seed-file.ts --manifest <m> [--out p]` | `REA_GHIDRA_SEED_FILE` (old names; on a ported manifest also `Name__cand_<rva>` per candidate) |
| `tools/bindings/gen-headers.ts [--check]` (`npm run bindings:gen`) | `signatures.h` / `offsets.h` |
| validator finding `native-build-unknown` | a mod uses a native-registered name but the installed exe is unknown |

The library behind them is `editor/src/core/bindings/` (`pe`, `scan` with the DLL's exact scanner semantics,
`siggen`, `manifest`, `harvest`, `port`, `check`, `seed`, `gen-headers`), tested in `editor/test/bindings-tests.ts`
(fake PE images built in-test; T1 against the installed exe).

## The ladder (`port.ts`)

Vtables port first (RTTI needs no function). Then, per function, the rungs are tried in this order and the first
rung whose candidates — **filtered by the cfgLite tolerance** (±35 % bytes, ±2 or 25 % calls) — leave exactly one
wins (`ported-anchor`, method = the rung's name):

1. the stored masked signature matches exactly once → `ported-exact` (same RVA) or `ported-rescan` (moved)
2. `vtable-store`: the only code site that `lea`s the named RTTI-derived vftable with the given pattern
   (`48 8D 05 ?? ?? ?? ?? 48 89 03`) → its `.pdata` function. `LuckUp_ctor`, which has no relocation-free unique
   byte signature at all (notes-bind §1.2), ports this way
3. `imm32-witness`: an instruction matching the pattern with the constant's value *re-derived on the new image*
   (`LuckUp_typeid` from the vftable slot) as imm32, followed within `maxForward` instructions by an E8 to the
   ported callee → `Status_ApplyLuckUp` (`mov r8d, typeid` before `Entity_FindComponentsByTypeId`)
4. `caller-after-lea`: in a ported caller, the first E8 after `lea rdx,[rip+"literal"]` whose target is within the
   tolerance (the `string == cstr` compare call before it is too small) — `Status_ApplyLuckUp` after the
   `"LuckUp"` lea in `apply_status` / `attach_passive`, independent of the ordinal 1261 / 3439
5. `funcsig-xref`: every unique funcsig/literal string anchor is found once and xref'd by rip-relative `lea`; the
   intersection over the strings is filtered by the tolerance before anything is called ambiguous (the 12 functions
   that lea `"LuckUp"` collapse to one once `"None"` and the tolerance are applied)
6. `caller-ordinal`: the k-th call of an already-ported caller that called it at ordinal k
7. `pdata-successor` / `pdata-predecessor`: the `.pdata` function right after / before a ported neighbour, by table
   index (`anchors.after` / `anchors.before`): the 11 lookups form one chain from `apply_status`
8. `shared-data-ref`: the other function referencing rip ref #k of a ported function (`Status_NameExists` shares
   `Status_GetValue`'s map)
9. several in-tolerance candidates → `ambiguous` (each listed with RVA, size, calls, how found); none → `failed`;
   `--resolve Name=0xRVA` → `ported-anchor` (resolved)

Then constants via their sources — slot body and/or call-arg witness; all present sources must
agree (`ported-derived`, method `slot-body+call-arg`), otherwise `needs-human` with every value listed — data via witness rip-ref ordinals
(`ported-witness`; a shifted ordinal is accepted only when exactly one reference of the same opcode remains) and
table+index (`ported-derived`, or `needs-human` when the SDL version changed), struct offsets via their witness
pattern (`ported-witness` when the displacement is unchanged, **`proposed` with the value NOT applied** when it
moved; the same `readOffsetWitness` the harvest verifies with, so an anchor that verifies today ports tomorrow). Unanchored entries are carried over as `needs-human`. Every ported function gets a fresh signature and
fresh anchors on the new image (caller ordinals and `dataRefs` re-harvested); every entry gets a `port { from, status, method, note, candidates? }` block.

Rungs 2–8 iterate until nothing more ports, so a string-less helper becomes reachable once its caller or neighbour
is ported. Every rung's locator is the same function the harvest verifies with (`harvest.ts`:
`findVtableStoreFunctions`, `findImm32WitnessFunctions`, `findCallsAfterStringLea`, `pdataNeighbour`,
`findSharedDataRefFunctions`), so an anchor that verifies today is the anchor that ports tomorrow.

## The report (`bindings/<build>.port-report.md`)

```
# Port report 25143593 -> <new>
generated <iso>; new exe sha256 ..., TimeDateStamp ..., SizeOfImage ..., SDL 3.2.12
Summary: 98 entries · ported-exact 35 · ported-anchor 12 · ported-witness 5 · ported-derived 11 · needs-human 38 · ...
| name | kind | old | new | status | method | detail |
## Needs attention
### Status_GetCategory (function, old 0x4929c0) -- ambiguous
- 2 candidate(s): 0x4931a0 (640 bytes, 6 calls; funcsig xref), 0x4933c0 (...)
- next: compare the old function (seed file + REA compare_functions on cfg + strings_names) with the candidates ...
### Status_stacks (offset) -- proposed 0x5c -> 0x60
## Not auto-portable (human decision)
## Next steps
```

## Verification tiers

- **T0**: the ladder, wildcarder, RTTI/slot/table derivations and report are tested on fake PE images built by
  an in-test linker (relink, recompiled prologue, clone, removed string, moved offset).
- **T1 self-port**: the manifest ported onto its own exe must change no value (every signed function
  `ported-exact`, exactly the unanchored entries `needs-human`).
- **T1 cross-build**: the only tier that proves anchors survive a real recompile. Opt-in test in
  `bindings-tests.ts` driven by `BINDINGS_OLD_EXE` / `BINDINGS_NEW_EXE` (git-ignored copies under
  `.analysis/exe/<build>/`); fetch an older build with Steam's `download_depot 686060 <depot> <manifest>`. The same
  run as a CLI: `node tools/bindings/cross-build.ts --old <exe> --new <exe> [--build <id>] [--gameVersion <x.y.z>]`
  (nothing written; exit 1 when a non-offset entry is ambiguous/failed). In the report every anchor-ported row records
  the candidate's drift from the old cfgLite (`size +N / calls +M vs old`), so a run whose anchors all drifted by 0
  is recognisable as a relink that never stressed the tolerances; the `old` column is the pre-port value.
- **T2**: `npm run test:ingame` after regenerating headers and rebuilding the DLLs. `unknown-build` means the
  identity gate still fails; `harness-error` naming a signature means that signature does not match once.
- **T3**: a played fight on the `dev` save for anything that touches combat (Joker's Luck).

### T1 cross-build result, 2026-10-19: 25143593 -> 23372843

First run against a second genuine build. The committed manifest (Steam build 25143593, 1.1.21239, linked
2026-09-05, SizeOfImage `0x1574000`) was ported onto the **older** build 23372843 (~1.1.21039, public push
2026-05-23, TimeDateStamp `0x6a10f6ca`, SizeOfImage `0x156b000`, depot 686061 manifest 8229879464648565847, exe
kept under `.analysis/exe/23372843/`; SDL 3.2.12 on both). Both forms agree:
`node tools/bindings/cross-build.ts --old <25143593 exe> --new <23372843 exe> --build 23372843` exited 0 with
`cross-build 25143593 -> new exe: 0 non-offset entries ambiguous/failed`, and `BINDINGS_OLD_EXE=… BINDINGS_NEW_EXE=…
npm test` passed the opt-in test (`235 passed, 0 failed`). Full report: `.analysis/cross-build/25143593-to-23372843.txt`
(git-ignored).

Per status, 98 entries: `ported-rescan` 32 · `ported-anchor` 14 · `ported-witness` 3 · `ported-derived` 11 ·
`needs-human` 38 · `ported-exact` / `ambiguous` / `failed` / `proposed` 0.

- Every one of the 32 signed functions moved (the image shifted; `ported-exact` does not happen across real builds)
  and every stored signature still matched exactly once — rung 1 held for all of them.
- Rung 2 (funcsig xref) found 11: nine `Status_*` lookups plus `Status_AttachPassive` and `Status_SpawnTile`. Rung 4
  found `Status_NameExists` as the `.pdata` successor of `Status_GetStackMode`. Rung 3 found the two string-less
  functions by caller ordinal: `Status_ApplyLuckUp` = call #1261 of `Status_ApplyByName` (a 2,384-call function) and
  `LuckUp_ctor` = call #6 of `Status_ApplyLuckUp`.
- RTTI found both vftables. The slot body of `LuckUp_vftable` slot 1 gave `LuckUp_typeid` **`0x4d5`, not `0x4d6`** —
  the one value that genuinely differs between the builds, and the derivation caught it. The three data witnesses
  held at their rip-ref ordinals (#44, #6, #0); the 8 DYNAPI slots ported by table index, which proves nothing yet
  because SDL did not change.
- No non-offset entry fell off the ladder. The 38 `needs-human` rows (46 since 2026-10-20: eight offsets were added
  for the dev scenes and the RNG) are the known unanchored set (`LuckUp_vtableSlots`,
  the five `VT_*` slot indices, 32 struct offsets) carried over unchanged — this run verifies none of them.
- Caveat on what was proven: all 14 anchor-ported functions have **byte-identical size and call counts** on both
  builds (e.g. `Status_AttachPassive` 232,096 bytes / 6,438 calls on each), so this update was a layout shift around
  unchanged bodies. The signature rung and the anchors survived a relink; the ±35 % / ±25 % tolerances, the
  `ambiguous` path and the `proposed` path were not stressed by a real image.

What the run suggested for the ladder, and what became of it:

- ~~**Report bug**~~ — fixed in PR #29: `finish` takes the pre-port value from the caller.
- ~~**Rung 3 is the weakest rung that carried weight.**~~ — closed 2026-10-21/22 (the "bindings hardening" PR, from the
  Ghidra session's `.analysis/notes-bind.md`): `Status_ApplyLuckUp` now carries the `"LuckUp"` + `"None"` literals,
  an `imm32Witness` on the type id and `callers` after the `"LuckUp"` lea in `apply_status` / `attach_passive`;
  `LuckUp_ctor` carries `vtableStore` on `LuckUp_vftable` (plus the pool `dataRef`); the 11 lookups carry the
  `.pdata` chain and `Status_NameExists` the shared value map. Vtables port before the function rungs. The caller
  ordinal is the *last* rung for both, not the only one. Not done: the *callee-set* rung (match a candidate by the
  ported functions it calls at matching ordinals) — the witnesses above made it unnecessary for the two entries
  that needed it.
- **Signature generator defects found by the same session** (fixed in that PR): `decodeRelocs` dropped a
  relocation straddling the window end, so `Status_GetCategory` (`… 48 8D 0D 6F`) and `LuckUp_ctor`
  (`… 48 8D 05 95 5D`) were unique only through unmasked disp32 bytes; `makeSignature` tried window starts every 8
  bytes regardless of instruction boundaries, so `Status_ApplyLuckUp`'s pattern began inside `49 8B F1` and masked
  nothing; and the lite decoder ignored the `66` operand-size prefix, so `mov word [rbx+0xe8],1` desynced it.
  Starts are instruction boundaries now, a cut relocation is masked, uniqueness is found by binary search, and the
  three entries whose only unique bytes are a relocation, the type id or a `__LINE__` immediate are `signature: null`
  (the DLL takes `expectedRva` for a `NULL` pattern on the identified build, exactly like the FW_LK raw RVAs).
- ~~Anchor the six constants~~ — done 2026-10-20: `LuckUp_vtableSlots` = `derive { vtable, extent: true }` (172
  consecutive code pointers); `VT_GetTypeId` / `VT_GetTypeHierarchy` = `derive.slotSearch { bodyPattern }` (the only
  slot whose body is `mov eax,imm32; ret` / `lea rax,[rip+x]; ret`); `VT_GetTypeName` / `VT_IsA` = `slotSearch {
  stringRef: "LuckUp", nth 0/1, expect 2 }` (the only two slots whose bounded body references the string — GetTypeName
  by `mov` loads of its bytes, IsA by a `lea`); `VT_OnStacksChanged` = a displacement witness `FF 90 ?? ?? ?? ?? 83 7B
  ?? 00` in `Status_ApplyLuckUp` with `scale: 8` (`call [rax+0x550]` = slot 170). Slot bodies are bounded by `.pdata`
  or their first `ret`, so a leaf slot never "contains" its neighbour. A search that does not find exactly `expect`
  slots is `needs-human`, never a guess. `LuckUp_typeid` carries its second witness since PR #32.
- ~~The 32 offsets are the real gap~~ — done 2026-10-20: every struct offset (40) carries `witness { function, pattern,
  dispAt[, dispSize, nth] }` with a note naming the instruction; `harvest.ts` verifies all of them on the current exe.
- `cross-build.ts` has no `--gameVersion`, so the ported build block keeps the old manifest's `1.1.21239`;
  `port.ts` already accepts `opts.gameVersion`, pass it through.
- Record the size/call deltas rung 2 saw in the report (all 0 here) so the tolerances can be tightened on evidence,
  and keep a build with a changed SDL on the wishlist — the `table` derivation's `needs-human` path is still
  untested on a real image.

## Known limits and human decisions

- `FW_SIG_MAX_BYTES` / `sigCap` is 128. Nothing needs it any more: `Status_GetCategory`'s 126-byte pattern was unique
  only through an unmasked relocation byte and is `null` since 2026-10-22 (its funcsig xref and the `.pdata` chain
  locate it; the DLL takes the raw RVA). Raising the cap still means changing `fw_sig.h` and the host test together.
- **`__LINE__` signatures are deliberately not used.** The 13 `ConstructionHelpers.cpp` lookups are one template
  body each; the only relocation-free bytes that tell the twins apart are the `__LINE__` / column immediates of the
  `NO STATUS NAMED` assert (`C7 45 B7 48 00 00 00 …` = line 72 for `get_status_type`). A body signature built on them
  is unique today but a source edit above that line moves it onto a twin, and rung 1 would port the wrong function
  silently (`GetValue` / `OnAppliedToDamageInstance` / `OnKilledCharacter` / `OnDamageReport` even share the column).
  The funcsig xref and the `.pdata` chain are strictly stronger; those entries stay `signature: null` with a note.
  `make-signature --manifest` without `--only` lists them as `skipped (null)` and never regenerates one.
- `ApplicationBase_FrameBegin` has no string of its own; its signature is a hand-chosen body window from +45 keyed
  on the per-frame defaults it stores (not the generic 19-byte prologue), plus `before: ApplicationBase_FrameEnd`.
  `make-signature --manifest` would replace it with the shortest prologue window again — keep the body one.
- An SDL upgrade changes the DYNAPI slot order: the 8 slots become `needs-human` until re-verified.
- Nothing is `unanchored` any more (40 struct offsets and 6 vtable slot constants carry witnesses / derivations since
  2026-10-20); the port still reports a `proposed` offset instead of applying it.
- The caller-ordinal-only limit is closed (see above); what remains without a second rung is the callee-set idea,
  not needed by any entry today.
- **`GonObject_Int` / `GonObject_Number` are twins** (the witness hosts of `GonObject_int` / `GonObject_double`): their
  bodies differ only in RIP-relative displacements, which the hardened generator masks, so `make-signature` finds no
  window for them. Their manifest patterns (made before the hardening) still scan unique at their RVAs on this build
  (the T1 regeneration test verifies exactly that for these two names), but on a new build they have no rung — they
  port by a hand-made seed, and the two offsets they witness follow them.
- A changed arity of the 13 lookups (shapes A–E), a compiler/CRT change (`MsvcString` layout), or a changed
  vtable layout cannot be ported mechanically.
- A function without a `.pdata` entry (leaf functions such as `Camera_AddLayer` 0x979bd0 or the pass-predicate lambda
  0x8967b0) cannot be a function entry (the T1 test requires one), and a PGO-split function (`Camera_render` 0x9787c0:
  chained `.pdata` chunks) only exposes its first chunk to `readOffsetWitness` — witnesses must sit in that chunk or in
  another function. Following chained chunks is the next improvement.
- The DLL still resolves functions by signature at load time. Entries that only have anchors (`signature: null`:
  the 11 lookups, `Status_GetCategory`, `LuckUp_ctor`, `Status_ApplyLuckUp`) ship as raw RVAs in `signatures.h`
  (`NULL` pattern + `expectedRva`, logged as `symbol X: no signature on this build; using RVA …`); a runtime anchor
  locator in the DLL (RTTI → vftable store → unique E8 caller, string → lea xref → `.pdata`) is the optional
  follow-up that would let those survive a relink before anyone runs the port.
