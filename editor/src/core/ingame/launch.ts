// Game-dir discovery, preflight checks and the argv/env/cwd builder for a
// harness launch. Pure except detectSteam() and the default `exists`.
//
// argv order matters: ApplicationBase::ProcessCmds treats every argument after
// `-modpaths` as a mod path, so all -mewtest* flags come BEFORE -modpaths.

import { existsSync } from "node:fs";
import { join, win32, posix } from "node:path";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, MODS_DIR, touchesSaves } from "../repo.ts";
import { SAVESUFFIX_RE, type Plan } from "./script.ts";

/**
 * The path module for a game-side path. The game is a Windows process, but the suite (and CI) may run on
 * Linux, so joins follow the shape of the path given (`C:\…` or any backslash → win32), not the host.
 */
function pathApi(p: string): typeof win32 | typeof posix {
  return /^[A-Za-z]:/.test(p) || p.includes("\\") ? win32 : posix;
}
const pjoin = (base: string, ...parts: string[]): string => pathApi(base).join(base, ...parts);
const pabs = (p: string): boolean => pathApi(p).isAbsolute(p);

export const DEFAULT_GAME_DIR = "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Mewgenics";
export const STEAM_APP_ID = "686060";
export const NATIVE_DIST_DIR = join(REPO_ROOT, "native", "dist");
export const MEWTEST_DLL_NAME = "mewtest.dll";
export const FRAMEWORK_DLL_NAME = "mewframework.dll";

export type Env = Record<string, string | undefined>;

export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchError";
  }
}

export function locateGameDir(env: Env): string {
  return env.MEWGENICS_DIR && env.MEWGENICS_DIR.trim() ? env.MEWGENICS_DIR.trim() : DEFAULT_GAME_DIR;
}

/** Is steam.exe running? true / false / null (could not tell). */
export function detectSteam(): boolean | null {
  try {
    const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq steam.exe", "/NH"], { encoding: "utf8", windowsHide: true });
    if (r.error || r.status !== 0) return null;
    return /steam\.exe/i.test(String(r.stdout));
  } catch {
    return null;
  }
}

export interface PreflightCheck {
  ok: boolean;
  path?: string;
  detail?: string;
}

export interface Preflight {
  ok: boolean;
  skipped: boolean;
  reasons: string[];
  checks: Record<string, PreflightCheck>;
}

export interface PreflightContext {
  gameDir: string;
  env: Env;
  exists?: (p: string) => boolean;
  steamRunning?: () => boolean | null;
  modsDir?: string;
  appdataLogsDir: string | null;
}

export function preflight(plan: Plan, ctx: PreflightContext): Preflight {
  const env = ctx.env || {};
  if (env.MEWTEST_SKIP === "1") return { ok: false, skipped: true, reasons: ["MEWTEST_SKIP=1"], checks: {} };
  const exists = ctx.exists || existsSync;
  const modsDir = ctx.modsDir || MODS_DIR;
  const fake = Boolean(env.MEWTEST_FAKE_GAME);
  const checks: Preflight["checks"] = {};
  const reasons: string[] = [];

  const need = (key: string, path: string, what: string) => {
    if (fake) { checks[key] = { ok: true, path, detail: "fake game" }; return; }
    const ok = exists(path);
    checks[key] = { ok, path };
    if (!ok) reasons.push(`${what} not found: ${path}`);
  };
  need("exe", pjoin(ctx.gameDir, "Mewgenics.exe"), "Mewgenics.exe");
  need("versionDll", pjoin(ctx.gameDir, "version.dll"), "Mewjector version.dll (run tools/install-mewjector.bat)");
  need("chainloaderIni", pjoin(ctx.gameDir, "chainloader.ini"), "chainloader.ini");
  need("frameworkDll", join(NATIVE_DIST_DIR, FRAMEWORK_DLL_NAME), "mewframework.dll in native/dist");
  need("mewtestDll", join(NATIVE_DIST_DIR, MEWTEST_DLL_NAME), "mewtest.dll in native/dist");

  if (ctx.appdataLogsDir) checks.appdata = { ok: true, path: ctx.appdataLogsDir };
  else { checks.appdata = { ok: false }; reasons.push("game appdata logs dir not found (%APPDATA%\\Glaiel Games\\Mewgenics\\<steamid>\\logs)"); }

  if (fake) checks.steam = { ok: true, detail: "fake game" };
  else {
    const s = ctx.steamRunning ? ctx.steamRunning() : detectSteam();
    if (s === false) { checks.steam = { ok: false }; reasons.push("Steam is not running (steam.exe not found in tasklist)"); }
    else checks.steam = { ok: true, detail: s === null ? "unknown" : "running" };
  }

  const missingMods = plan.mods.filter((m) => !exists(pjoin(modsDir, m)));
  checks.modDirs = { ok: missingMods.length === 0, detail: plan.mods.join(",") };
  for (const m of missingMods) reasons.push(`mod folder missing: ${pjoin(modsDir, m)}`);

  return { ok: reasons.length === 0, skipped: false, reasons, checks };
}

export interface LaunchContext {
  gameDir: string;
  scriptPath: string;
  outPath: string;
  env: Env;
  modsDir?: string;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  fake: boolean;
}

export function buildLaunch(plan: Plan, ctx: LaunchContext): LaunchSpec {
  const modsDir = ctx.modsDir || MODS_DIR;
  if (!SAVESUFFIX_RE.test(plan.savesuffix)) throw new LaunchError(`invalid save suffix ${JSON.stringify(plan.savesuffix)}`);
  const paths: [string, string][] = [["script path", ctx.scriptPath], ["result path", ctx.outPath], ["game dir", ctx.gameDir], ["mods dir", modsDir]];
  for (const [what, p] of paths) {
    if (!pabs(p)) throw new LaunchError(`${what} must be absolute: ${p}`);
    if (touchesSaves(p)) throw new LaunchError(`refusing a ${what} under a saves directory: ${p}`);
  }
  const modPaths = plan.mods.map((m) => pjoin(modsDir, m));
  for (const p of modPaths) if (touchesSaves(p)) throw new LaunchError(`refusing a mod path under a saves directory: ${p}`);
  if (modPaths.length === 0) throw new LaunchError("no mod paths");

  const args = [
    "-savesuffix", plan.savesuffix,
    "-enable_debugconsole", "true",
    "-dev_mode", "true",
    "-mewtest", ctx.scriptPath,
    "-mewtest_out", ctx.outPath,
    "-mewtest_hide", plan.hide ? "1" : "0",
    "-mewtest_timeout", String(plan.timeoutMs),
    "-mewtest_clean", plan.clean ? "1" : "0",
    "-modpaths", ...modPaths,
  ];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.env || {})) if (typeof v === "string") env[k] = v;
  env.SteamAppId = STEAM_APP_ID;
  env.SteamGameId = STEAM_APP_ID;

  const fake = ctx.env && ctx.env.MEWTEST_FAKE_GAME ? String(ctx.env.MEWTEST_FAKE_GAME) : "";
  if (fake) return { command: process.argv[0]!, args: [fake, ...args], cwd: ctx.gameDir, env, fake: true };
  return { command: pjoin(ctx.gameDir, "Mewgenics.exe"), args, cwd: ctx.gameDir, env, fake: false };
}
