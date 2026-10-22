// The browser side of the /api bridge. POST bodies are typed from the same zod schemas the
// server validates with (src/core/api-schemas.ts), so a component cannot send a body the
// server would reject. Responses are the core's JSON as-is; every call goes through apiFetch.

import type { ApiBodyInput, PostRoute } from "../../src/core/api-schemas.ts";
import { toast } from "./state.ts";

export interface ApiIssue {
  path: (string | number)[];
  message: string;
}

/** A failed /api call: a non-2xx answer (status + the server's {error, issues}) or a network failure (status 0). */
export class ApiError extends Error {
  status: number;
  issues?: ApiIssue[];
  constructor(status: number, message: string, issues?: ApiIssue[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    if (issues) this.issues = issues;
  }
}

/**
 * The one fetch wrapper: parses the JSON reply; on a non-2xx or a network failure it toasts the message (kind
 * "error") and throws an ApiError. Refusals the core answers with 200 + {ok:false} are not errors and pass through.
 */
export async function apiFetch<T = any>(input: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(input, init);
  } catch (e) {
    const err = new ApiError(0, `${input}: ${e instanceof Error ? e.message : String(e)}`);
    toast(err.message, { kind: "error" });
    throw err;
  }
  if (!r.ok) {
    let body: { error?: unknown; issues?: ApiIssue[] } | null = null;
    try {
      body = (await r.json()) as { error?: unknown; issues?: ApiIssue[] };
    } catch {
      body = null;
    }
    const message = body && typeof body.error === "string" ? body.error : `${input}: HTTP ${r.status}`;
    const err = new ApiError(r.status, message, body && Array.isArray(body.issues) ? body.issues : undefined);
    toast(err.message, { kind: "error" });
    throw err;
  }
  return (await r.json()) as T;
}

export function getJson<T = any>(url: string): Promise<T> {
  return apiFetch<T>(url);
}

export function postJson<T = any>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
