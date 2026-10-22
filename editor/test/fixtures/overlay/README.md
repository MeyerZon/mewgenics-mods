# Overlay fidelity fixtures

One directory per case: `base.gon`, exactly one `overlay.gon.<append|merge|patch>`, and `expected.gon` — the result
the game's decompiled engine for that file kind produces (`.analysis/decompiled/Gon_overlay_apply_0x9a64a0.c` is the
dispatch: `.append` → `Gon_Append_0x945410.c`, `.merge` → `Gon_DeepMerge_plain_0x945c30.c` under the constant MERGE
policy of `Gon_DefaultMergeMode_0x9451c0.c`, `.patch` → `Gon_DeepMerge_0x946680.c`, the policy-driven merge, with
`Gon_PatchMerge_a_0x944cc0.c` the suffix parser and `Gon_PatchMerge_b_0x944f50.c` the recursive suffix stripper).
Driven by `editor/test/overlay-tests.ts`; compared structurally (parse + pretty-print), so comments and whitespace
in these files are free. The decompile line each case pins is quoted in its `base.gon` header comment; the table
is in `docs/data-mods.md` "Fidelity to the decompiled merges (2026-10-21)".
