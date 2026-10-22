// A tiny external store for the editor UI: plain objects, `set(patch)` merges, React reads
// through `useStore(store, selector)` (useSyncExternalStore). It replaces VanJS `van.state`
// one-for-one: `S.mod.val = x` became `S.set({ mod: x })`, `S.mod.val` became
// `useStore(S, (s) => s.mod)` inside a component or `S.get().mod` outside one.
//
// Same-value writes do not notify (van deduped those too), which keeps effects that
// write back into the store from looping. Selectors must return primitives or values
// already held by the state (not fresh objects/arrays) or React re-renders forever; for a
// selector that builds an object or array, use useStoreShallow.

import React from "react";

export type Patch<T> = Partial<T> | ((current: T) => Partial<T>);

export interface Store<T extends object> {
  get(): T;
  set(patch: Patch<T>): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state: T = initial;
  const listeners = new Set<() => void>();
  const get = () => state;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const set = (patch: Patch<T>) => {
    const next = typeof patch === "function" ? patch(state) : patch;
    let changed = false;
    for (const key of Object.keys(next) as (keyof T)[]) {
      if (!Object.is(next[key], state[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...next };
    for (const l of [...listeners]) l();
  };
  return { get, set, subscribe };
}

/** Subscribe a component to one slice of a store. */
export function useStore<T extends object, R>(store: Store<T>, selector: (state: T) => R): R {
  return React.useSyncExternalStore(
    store.subscribe,
    () => selector(store.get()),
    () => selector(store.get()),
  );
}

/**
 * Shallow equality: Object.is for primitives; for two arrays, the same length and Object.is per element; for two
 * plain objects, the same keys and Object.is per value. Nested values compare by identity.
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * useStore for selectors that build a fresh object or array (`(s) => ({ a: s.a, b: s.b })`): the result is kept
 * while it stays shallow-equal to the previous one, so React sees a stable snapshot and does not re-render forever.
 */
export function useStoreShallow<T extends object, R>(store: Store<T>, selector: (state: T) => R): R {
  const last = React.useRef<{ value: R } | null>(null);
  const select = (): R => {
    const next = selector(store.get());
    if (last.current && shallowEqual(last.current.value, next)) return last.current.value;
    last.current = { value: next };
    return next;
  };
  return React.useSyncExternalStore(store.subscribe, select, select);
}
