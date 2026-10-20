// Client side of the harness's interactive mode: a per-process named pipe (`\\.\pipe\mewtest-<pid>` on Windows; a
// socket file in the tmp dir elsewhere, which only the fake game uses) carrying one JSON request per line and one
// JSON reply per line. The reply is the very event the DLL appended to the result file (`exec` with the console
// lines, `units` for a dump, `exec`/quit before the end), so nothing here adds a second source of truth.

import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { touchesSaves } from "../repo.ts";

/** where mewtest.dll listens for the game with this pid */
export function pipePath(pid: number, platform: NodeJS.Platform = process.platform): string {
  const p = platform === "win32" ? `\\\\.\\pipe\\mewtest-${pid}` : join(tmpdir(), `mewtest-${pid}.sock`);
  if (touchesSaves(p)) throw new Error(`refusing a pipe path under a saves directory: ${p}`);
  return p;
}

export type PipeOp = "exec" | "dump" | "quit";

export interface PipeRequest {
  op: PipeOp;
  /** console line for `exec` */
  text?: string;
  /** frames to keep collecting console output after an `exec` (default 3 in the DLL, max 600) */
  frames?: number;
}

/** a reply line: the DLL's event (`exec` | `units`), or an error reply `{ev:"exec", ok:false, error}` */
export interface PipeReply {
  ev: string;
  id?: number;
  op?: string;
  text?: string;
  ok?: boolean;
  lines?: string[];
  error?: string;
  /** set by the client when the pipe closed right after a `quit` (the DLL exits immediately; EOF is the answer) */
  eof?: boolean;
  [k: string]: unknown;
}

export interface PipeClient {
  readonly path: string;
  readonly closed: boolean;
  request(req: PipeRequest, timeoutMs?: number): Promise<PipeReply>;
  close(): void;
}

export interface ConnectOptions {
  /** between connection attempts while the DLL has not created the pipe yet */
  retryMs?: number;
  /** give up after this long */
  timeoutMs?: number;
}

function tryConnect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(path);
    const onErr = (e: Error) => { s.destroy(); reject(e); };
    s.once("error", onErr);
    s.once("connect", () => { s.off("error", onErr); resolve(s); });
  });
}

/** Connect, retrying until the server exists (the DLL creates the pipe during its init) or `timeoutMs` passes. */
export async function connectPipe(path: string, opts: ConnectOptions = {}): Promise<PipeClient> {
  const retryMs = opts.retryMs ?? 100;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const t0 = Date.now();
  let lastErr = "";
  let sock: Socket | null = null;
  for (;;) {
    try { sock = await tryConnect(path); break; } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
    if (Date.now() - t0 >= timeoutMs) throw new Error(`pipe ${path} not available after ${timeoutMs} ms (timed out): ${lastErr}`);
    await new Promise((r) => setTimeout(r, retryMs));
  }
  return makeClient(path, sock);
}

interface Pending { op: PipeOp; resolve: (r: PipeReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

function makeClient(path: string, sock: Socket): PipeClient {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let buf = "";
  let closed = false;
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let reply: PipeReply;
      try { reply = JSON.parse(line) as PipeReply; } catch { continue; }
      const id = typeof reply.id === "number" ? reply.id : -1;
      const p = pending.get(id);
      if (!p) continue;
      pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(reply);
    }
  });
  const finish = () => {
    if (closed) return;
    closed = true;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      if (p.op === "quit") p.resolve({ ev: "exec", id, op: "quit", ok: true, eof: true });
      else p.reject(new Error("pipe closed before the reply"));
    }
    pending.clear();
  };
  sock.on("close", finish);
  sock.on("error", finish);
  return {
    path,
    get closed() { return closed; },
    request(req: PipeRequest, timeoutMs = 60000): Promise<PipeReply> {
      if (closed) return Promise.reject(new Error("pipe closed"));
      const id = nextId++;
      const line = JSON.stringify({ id, op: req.op, ...(req.text !== undefined ? { text: req.text } : {}), ...(req.frames !== undefined ? { frames: req.frames } : {}) });
      return new Promise<PipeReply>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`pipe request ${id} (${req.op}) got no reply within ${timeoutMs} ms`)); }, timeoutMs);
        pending.set(id, { op: req.op, resolve, reject, timer });
        sock.write(line + "\n", (e) => { if (e) { pending.delete(id); clearTimeout(timer); reject(e); } });
      });
    },
    close() { finish(); sock.destroy(); },
  };
}
