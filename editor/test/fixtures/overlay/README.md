# Overlay fidelity fixtures

One directory per case: `base.gon`, exactly one `overlay.gon.<append|merge|patch>`, and `expected.gon` — the result
the game's decompiled merge produces (`.analysis/decompiled/Gon_DeepMerge_0x946680.c` is the policy-driven merge,
`Gon_PatchMerge_a_0x944cc0.c` the suffix parser, `Gon_PatchMerge_b_0x944f50.c` the recursive suffix stripper).
Driven by `editor/test/overlay-tests.ts`; compared structurally (parse + pretty-print), so comments and whitespace
in these files are free. The decompile line each case pins is quoted in its `base.gon` header comment; the table
is in `docs/data-mods.md` "Fidelity to the decompiled merges (2026-10-21)".
