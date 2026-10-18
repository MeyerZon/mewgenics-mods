// Minimal ambient declarations for the Node.js built-ins this project uses.
// The project has ZERO runtime dependencies and does not install @types/node;
// these shims keep `tsc --noEmit` honest without pulling an extra package.
// Signatures are intentionally narrow to what the code actually calls.

interface ImportMeta {
  url: string;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd(): string;
  exit(code?: number): never;
  platform: string;
  stdin: NodeReadable;
  stdout: NodeWritable;
  stderr: NodeWritable;
  on(event: string, cb: (...args: any[]) => void): void;
};

interface NodeReadable {
  on(event: string, cb: (chunk: any) => void): void;
  setEncoding(enc: string): void;
  resume(): void;
}
interface NodeWritable {
  write(data: string | Uint8Array): boolean;
}

declare class Buffer extends Uint8Array {
  static from(data: any, enc?: string): Buffer;
  static concat(list: Uint8Array[]): Buffer;
  static isBuffer(x: unknown): boolean;
  toString(enc?: string, start?: number, end?: number): string;
}

declare module "node:fs" {
  export function readFileSync(path: string, enc: string): string;
  export function readFileSync(path: string): Buffer;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string, opts?: any): any[];
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function statSync(path: string): { isDirectory(): boolean; isFile(): boolean; size: number; mtimeMs: number };
  export function realpathSync(path: string): string;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string, ext?: string): string;
  export function extname(p: string): string;
  export function relative(from: string, to: string): string;
  export function normalize(p: string): string;
  export function isAbsolute(p: string): boolean;
  export const sep: string;
  const _default: {
    join: typeof join; resolve: typeof resolve; dirname: typeof dirname;
    basename: typeof basename; extname: typeof extname; relative: typeof relative;
    normalize: typeof normalize; isAbsolute: typeof isAbsolute; sep: string;
  };
  export default _default;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
  export function pathToFileURL(path: string): { href: string };
}

declare module "node:crypto" {
  export function createHash(algo: string): { update(data: string | Uint8Array): any; digest(enc: string): string };
}

declare module "node:child_process" {
  export interface ChildProcess {
    stdin: { write(data: string): boolean; end(): void };
    stdout: { on(event: string, cb: (chunk: any) => void): void };
    stderr: { on(event: string, cb: (chunk: any) => void): void };
    on(event: string, cb: (...args: any[]) => void): void;
    kill(signal?: string): void;
  }
  export function spawn(command: string, args?: string[], options?: any): ChildProcess;
}

declare module "node:http" {
  export interface IncomingMessage {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    on(event: string, cb: (chunk: any) => void): void;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    writeHead(status: number, headers?: Record<string, string>): void;
    end(data?: string | Uint8Array): void;
    write(data: string | Uint8Array): boolean;
  }
  export interface Server {
    listen(port: number, host: string, cb?: () => void): Server;
    on(event: string, cb: (...args: any[]) => void): void;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

declare module "node:zlib" {
  export function deflateSync(data: Uint8Array, opts?: { level?: number }): Buffer;
  export function inflateSync(data: Uint8Array): Buffer;
}
