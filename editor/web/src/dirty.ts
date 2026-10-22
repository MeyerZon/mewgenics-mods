// Unsaved-work registry + guard. Each mode registers how to tell whether it holds unsaved work (data: the open
// overlay; art: the open scene; vc: the VectorCraft drawing not yet applied; rooms: the open room), so the shell can
// ask before an action that would drop it (switching mods, opening another file / scene / room, closing one, a
// reload). A registry instead of imports keeps state.ts free of the art-state / room-state cycle. No DOM: Node runs it.
//
// guard(scopes, action) resolves true at once when nothing in `scopes` is dirty; otherwise it opens the ConfirmModal
// (S.confirm, rendered by App.tsx) and resolves with the choice: Cancel → false, Discard → true, Save and continue →
// the saves' result (offered only when every dirty scope can save).

import { S } from "./state.ts";

export type DirtyScope = "data" | "art" | "vc" | "rooms";
export const ALL_SCOPES: readonly DirtyScope[] = ["data", "art", "vc", "rooms"];

export interface DirtyProvider {
  dirty: () => boolean;
  /** what is unsaved, e.g. "the overlay data/x.gon.append" */
  label: () => string;
  save?: () => Promise<boolean>;
}

export type ConfirmChoice = "cancel" | "discard" | "save";

const providers = new Map<DirtyScope, DirtyProvider>();

/** Register (or replace) the provider of a scope. */
export function registerDirty(scope: DirtyScope, p: DirtyProvider): void {
  providers.set(scope, p);
}

/** The scopes (of those asked; all when omitted) that hold unsaved work, in ALL_SCOPES order. */
export function dirtyScopes(scopes: readonly DirtyScope[] = ALL_SCOPES): DirtyScope[] {
  return ALL_SCOPES.filter((s) => scopes.includes(s) && !!providers.get(s)?.dirty());
}

export function isDirty(scopes?: readonly DirtyScope[]): boolean {
  return dirtyScopes(scopes).length > 0;
}

export function dirtyLabel(scopes?: readonly DirtyScope[]): string {
  return dirtyScopes(scopes)
    .map((s) => providers.get(s)!.label())
    .join(", ");
}

let pending: ((c: ConfirmChoice) => void) | null = null;

/** Ask before `action` (a phrase like "Switching mods") when any of `scopes` is dirty. True = go ahead. */
export async function guard(scopes: readonly DirtyScope[], action: string): Promise<boolean> {
  const dirty = dirtyScopes(scopes);
  if (!dirty.length) return true;
  const savers = dirty.map((s) => providers.get(s)!.save);
  const canSave = savers.every((f) => typeof f === "function");
  const what = dirty.map((s) => providers.get(s)!.label()).join(", ");
  if (pending) resolveConfirm("cancel"); // a second guard supersedes an unanswered one
  const choice = await new Promise<ConfirmChoice>((resolve) => {
    pending = resolve;
    S.set({ confirm: { title: "Unsaved changes", body: `${what} ${dirty.length === 1 ? "has" : "have"} unsaved changes. ${action} will discard them.`, canSave } });
  });
  if (choice === "cancel") return false;
  if (choice === "discard") return true;
  for (const f of savers) if (!(await f!())) return false;
  return true;
}

/** The ConfirmModal's buttons (and Esc / the scrim, which cancel). */
export function resolveConfirm(choice: ConfirmChoice): void {
  const p = pending;
  pending = null;
  S.set({ confirm: null });
  p?.(choice);
}
