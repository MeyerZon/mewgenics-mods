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
| Byte signatures of hooked/called functions | 15 FwSymbol + 20 reference functions | `resolve_symbols` |
| Raw RVAs of the 13 status-name lookups (`FW_LK`) | 13 (12 of them have no unique signature) | `status_engine.c` |
| Data RVAs: App global, SDL3 DYNAPI jump table + 8 slots, default status source | 11 | `BuildInfo.rva_data`, `FW_GetData` |
| Vftables (LuckUp, Status) and the LuckUp type id | 3 | vtable cloning, sanity check |
| Vtable slot indices / count | 6 | `offsets.h` |
| Struct offsets | 32 | `offsets.h` (`status_engine.c`, `mewtest.c`) |

## The manifest: `bindings/<steamBuildId>.json`

One file per build (schema: `bindings/manifest.schema.json`; validator: `editor/src/core/bindings/manifest.mjs`).
`native/framework/src/signatures.h` (one `BuildInfo` + signature/lookup tables per manifest, so one DLL can know
several builds) and `native/framework/src/offsets.h` (shared `#define`s; the generator refuses when two manifests
disagree) are **generated** from it: `cd editor && npm run bindings:gen` (`bindings:check` for CI). Nothing
build-specific is typed by hand anywhere else; a golden test fails while the headers are stale.

Each entry has a `kind` (`function | data | vtable | constant | offset`), its value (`rva` or `value`), where it
surfaces (`exposure`: `FW_SYM_*` / `FW_DATA_*` enumerators, the `FW_LK` table with its A–E shape, a `BuildInfo`
field or an `OFF_*`/`VT_*` macro), who uses it (`consumers`), `evidence[]` (decompile paths under `.analysis/`),
and **anchors**, the evidence that finds it again:

| Entry kind | Anchors recorded by `tools/bindings/harvest.mjs` |
|---|---|
| function | `signature` (shortest unique masked prefix, rel32 / rip-relative disp32 / imm64 wildcarded, may start inside the function with a negative `offset`), `strings` (the MSVC `__FUNCSIG__` / `__FILE__` strings it references via rip-relative `lea`, with uniqueness; hand-added `literal` strings are kept), `callees` (calls to other manifest entries, by ordinal among all calls), `cfgLite` (bytes from `.pdata`, calls, rip refs), `prologue`, optionally `after` (the `.pdata` function it follows) |
| data | `witness` (the function that references it and the ordinal of that rip-relative reference), or `derive { table, index }` |
| vtable | `rtti { typeDescriptorName }` (TypeDescriptor → CompleteObjectLocator → vftable) + `slotChecks` |
| constant | `derive { vtable, slot, bodyPattern, imm32At }` (read from the slot's code) and/or `witness { function, callee, pattern, imm32At, maxBack }` (the imm32 of the instruction matching `pattern` within `maxBack` instructions before the first call to `callee` inside `function`). With two sources the port applies a value only when both agree; a split is `needs-human` with both values. `LuckUp_typeid` carries both since 2026-10-19 (slot 1 body of the LuckUp vftable; `mov r8d, imm32` before `Entity_FindComponentsByTypeId` in `Status_ApplyLuckUp`). |
| offset | `witness { function, pattern, dispAt, dispSize, nth }` or `unanchored: true` |

Facts the design rests on (verified on build 25143593): the exe's `.pdata` has 55,712 `RUNTIME_FUNCTION`
entries, so any address maps to its function without a disassembler; 12 of the 13 status lookups reference a
unique funcsig string (`enum glaiel::Status::StackMode __cdecl glaiel::get_status_stackmode(...)`); the 13th
(`Status_NameExists`) is the `.pdata` function right after `get_status_stackmode`; vftables are reachable through
x64 RTTI; the SDL jump table is referenced by the function that reads `SDL3_DYNAMIC_API`.

**Harvest the current build before the game updates** — the old exe disappears from the install:
`node tools/bindings/harvest.mjs <exe> --manifest bindings/<build>.json --write` (a T1 test fails when the
committed anchors are stale). Keep a copy of the exe under `.analysis/exe/<build>/` (git-ignored).

## Tools

| Tool | Does |
|---|---|
| `tools/bindings/check-build.mjs [exe]`, MCP `check_game_build` | identity + every signature scanned (`ok / moved / missing / ambiguous`); on an unknown build scans with the newest manifest to show what survived |
| `tools/bindings/make-signature.mjs <exe> name=rva ...` / `--manifest <m> --write` | regenerate signatures (wildcards; old kept on failure) |
| `tools/bindings/harvest.mjs <exe> --manifest <m> [--write]` | fill/verify anchors; reports mismatches without rewriting values |
| `tools/bindings/port.mjs --from <old> --exe <new> --build <id> [--resolve N=0x..] [--apply]`, MCP `port_bindings` | the ladder below; writes `bindings/<id>.json` + `.port-report.md` only with `--apply` |
| `tools/bindings/seed-file.mjs --manifest <m> [--out p]` | `REA_GHIDRA_SEED_FILE` (old names; on a ported manifest also `Name__cand_<rva>` per candidate) |
| `tools/bindings/gen-headers.mjs [--check]` (`npm run bindings:gen`) | `signatures.h` / `offsets.h` |
| validator finding `native-build-unknown` | a mod uses a native-registered name but the installed exe is unknown |

The library behind them is `editor/src/core/bindings/` (`pe`, `scan` with the DLL's exact scanner semantics,
`siggen`, `manifest`, `harvest`, `port`, `check`, `seed`, `gen-headers`), tested in `editor/test/bindings-tests.mjs`
(fake PE images built in-test; T1 against the installed exe).

## The ladder (`port.mjs`)

Per function, the first rung that yields exactly one answer wins:

1. the stored masked signature matches exactly once → `ported-exact` (same RVA) or `ported-rescan` (moved)
2. every unique funcsig/literal string anchor is found once and xref'd by rip-relative `lea` from exactly one
   `.pdata` function whose size/call count is within tolerance (±35 % bytes, ±2 or 25 % calls) → `ported-anchor`
3. the k-th call of an already-ported caller that called it at ordinal k → `ported-anchor` (caller-ordinal)
4. the `.pdata` function right after a ported neighbour (`anchors.after`) → `ported-anchor` (pdata-successor)
5. several candidates → `ambiguous` (each listed with RVA, size, calls, how found); none → `failed`;
   `--resolve Name=0xRVA` → `ported-anchor` (resolved)

Then vtables via RTTI and constants via their sources — slot body and/or call-arg witness; all present sources must
agree (`ported-derived`, method `slot-body+call-arg`), otherwise `needs-human` with every value listed — data via witness rip-ref ordinals
(`ported-witness`; a shifted ordinal is accepted only when exactly one reference of the same opcode remains) and
table+index (`ported-derived`, or `needs-human` when the SDL version changed), struct offsets via their witness
pattern (`ported-witness` when the displacement is unchanged, **`proposed` with the value NOT applied** when it
moved). Unanchored entries are carried over as `needs-human`. Every ported function gets a fresh signature and
fresh anchors on the new image; every entry gets a `port { from, status, method, note, candidates? }` block.

Rungs 2–4 iterate until nothing more ports, so a string-less helper becomes reachable once its caller is ported.

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
  `bindings-tests.mjs` driven by `BINDINGS_OLD_EXE` / `BINDINGS_NEW_EXE` (git-ignored copies under
  `.analysis/exe/<build>/`); fetch an older build with Steam's `download_depot 686060 <depot> <manifest>`. The same
  run as a CLI: `node tools/bindings/cross-build.mjs --old <exe> --new <exe> [--build <id>] [--gameVersion <x.y.z>]`
  (nothing written; exit 1 when a non-offset entry is ambiguous/failed). In the report every anchor-ported row records
  the candidate's drift from the old cfgLite (`size +N / calls +M vs old`), so a run whose anchors all drifted by 0
  is recognisable as a relink that never stressed the tolerances; the `old` column is the pre-port value.
- **T2**: `npm run test:ingame` after regenerating headers and rebuilding the DLLs. `unknown-build` means the
  identity gate still fails; `harness-error` naming a signature means that signature does not match once.
- **T3**: a played fight on the `dev` save for anything that touches combat (Joker's Luck).

## Known limits and human decisions

- `FW_SIG_MAX_BYTES` / `sigCap` is 128; `Status_GetCategory` needs 126. Raising it means changing `fw_sig.h`
  and the host test together.
- An SDL upgrade changes the DYNAPI slot order: the 8 slots become `needs-human` until re-verified.
- 38 entries (struct offsets, vtable slot constants) are still `unanchored`: the port reports them instead of
  guessing. Adding witness patterns is the next improvement.
- A changed arity of the 13 lookups (shapes A–E), a compiler/CRT change (`MsvcString` layout), or a changed
  vtable layout cannot be ported mechanically.
- The DLL still resolves functions by signature at load time. Entries that only have anchors (`signature: null`)
  ship as raw RVAs in `signatures.h`; a runtime anchor locator in the DLL (string → lea xref → `.pdata`) is the
  optional follow-up that would let those survive a relink before anyone runs the port.
