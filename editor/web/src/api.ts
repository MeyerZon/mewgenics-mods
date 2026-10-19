// The browser side of the /api bridge. POST bodies are typed from the same zod schemas the
// server validates with (src/core/api-schemas.ts), so a component cannot send a body the
// server would reject. Responses are the core's JSON as-is.

import type { ApiBodyInput, PostRoute } from "../../src/core/api-schemas.ts";

export interface ApiError {
  error: string;
  issues?: { path: (string | number)[]; message: string }[];
}

export async function getJson<T = any>(url: string): Promise<T> {
  const r = await fetch(url);
  return (await r.json()) as T;
}

export async function postJson<T = any>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

/** POST to a known route with a body checked against that route's schema at compile time. */
export function post<R extends PostRoute, T = any>(route: R, body: ApiBodyInput<R>): Promise<T> {
  return postJson<T>(route, body);
}

/** Build `/api/x?a=1&b=2`, skipping undefined/empty values. */
export function url(path: string, params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}
