// Screenshots for `shot "<label>"`: the DLL emits a shot event and holds the scene ~700 ms; the runner, which polls
// the result file every 250 ms, captures the game window as soon as it sees the event. The capture is a small
// PowerShell script written next to the shot so the run dir shows exactly what ran: PrintWindow with
// PW_RENDERFULLCONTENT on the process's main window (the composited content, also when another window covers it;
// the game runs full-screen and the owner may be working in front of it), and only when that yields a black frame
// AND the game is the foreground window, the screen region instead. A covered window with a black frame is reported
// as `occluded`, a missing one as `nowindow`; the whole screen is never captured (T3a finding 2026-10-20: three
// shots of the owner's browser). No dependency; injectable for tests (`RunPlanArgs.capture`).

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { encodePng, type RgbaImage } from "../art/png.ts";

/** what a capture produced: the PNG path, or null with a short reason (`occluded`, `nowindow`, `tiny …`, an error) */
export interface CaptureResult {
  path: string | null;
  note?: string;
}

/** (label, run dir, game pid) -> the PNG path (or null when nothing was captured), optionally with a note */
export type CaptureFn = (label: string, dir: string, pid: number | null) => string | null | CaptureResult;

/** `shot-<label>.png`, label reduced to a file-safe slug */
export function shotFileName(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "shot";
  return `shot-${slug}.png`;
}

export const CAPTURE_PS1 = `param([int]$ProcId, [string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace U -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); public struct RECT { public int L; public int T; public int R; public int B; }'
$h = [IntPtr]::Zero
if ($ProcId -gt 0) { $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue; if ($p) { $h = $p.MainWindowHandle } }
if ($h -eq [IntPtr]::Zero) { Write-Output "nowindow"; exit 3 }
$r = New-Object U.W+RECT
if (-not [U.W]::GetWindowRect($h, [ref]$r)) { Write-Output "norect"; exit 3 }
$w = $r.R - $r.L; $hh = $r.B - $r.T
if ($w -lt 50 -or $hh -lt 50) { Write-Output "tiny $w x $hh"; exit 3 }
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [U.W]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$dark = $true
foreach ($pt in @(@(0.5, 0.5), @(0.25, 0.25), @(0.75, 0.75), @(0.25, 0.75), @(0.75, 0.25))) {
  $c = $bmp.GetPixel([int]($w * $pt[0]), [int]($hh * $pt[1]))
  if (($c.R + $c.G + $c.B) -gt 24) { $dark = $false }
}
$what = "window"
if (-not $ok -or $dark) {
  if ([U.W]::GetForegroundWindow() -ne $h) { Write-Output "occluded"; exit 4 }
  $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
  $what = "screen"
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$what $w x $hh"
`;

/** Capture the game window into `<dir>/shot-<label>.png`; path null with the script's reason when it could not. */
export const captureWindow: CaptureFn = (label, dir, pid): CaptureResult => {
  const out = join(dir, shotFileName(label));
  const ps1 = join(dir, "capture.ps1");
  if (!existsSync(ps1)) writeFileSync(ps1, CAPTURE_PS1);
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, "-ProcId", String(pid ?? 0), "-Out", out], {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
  });
  const note = String(r.stdout || "").trim() || String(r.stderr || "").trim().split(/\r?\n/)[0] || (r.error ? String(r.error.message) : `exit ${r.status}`);
  if (r.status !== 0 || !existsSync(out)) return { path: null, note };
  return { path: out, note };
};

// ---- the in-process capture (2026-10-22, the stale-shot fix) ----------------------------------------------------
// OBSERVED 2026-10-22 (PR #107 runs + this PR's diagnostics): every run whose shots were all the loading screen had
// taken them through the screen fallback above (PrintWindow dark, the game the foreground window) and the screen copy
// was one frozen frame for the whole run. The DLL (mewtest.dll) now reads the GL back buffer at SDL_GL_SwapWindow and
// the shot event carries the raw file (source "gl"); the window capture stays the fallback (source "window"/"screen").

/** the raw file mewtest.dll writes (native/mods/test-harness/src/mt_shot.c): "MTSHOT01", u32 LE w, u32 LE h, then h
 * rows of w*3 RGB bytes, bottom row first -> a top-down RGBA image */
export function decodeRawShot(bytes: Uint8Array): RgbaImage {
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(0, 8)) !== "MTSHOT01") throw new Error("not an MTSHOT01 raw shot");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint32(8, true), height = dv.getUint32(12, true);
  const row = width * 3;
  if (!width || !height || bytes.length < 16 + row * height) throw new Error(`raw shot ${width} x ${height} needs ${16 + row * height} bytes, has ${bytes.length}`);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = 16 + (height - 1 - y) * row;
    for (let x = 0; x < width; x++) {
      const s = src + x * 3, d = (y * width + x) * 4;
      data[d] = bytes[s]!; data[d + 1] = bytes[s + 1]!; data[d + 2] = bytes[s + 2]!; data[d + 3] = 255;
    }
  }
  return { width, height, rgba: data };
}

/** convert the DLL's raw file into `<dir>/shot-<label>.png` and remove the raw file; the PNG path */
export function rawShotToPng(rawPath: string, label: string, dir: string): string {
  const img = decodeRawShot(readFileSync(rawPath));
  const out = join(dir, shotFileName(label));
  writeFileSync(out, encodePng(img.width, img.height, img.rgba));
  try { unlinkSync(rawPath); } catch { /* left behind: harmless, git-ignored run dir */ }
  return out;
}

/** a run's shots as a whole: `stale` when two or more were captured and every file is byte-identical (a frozen
 * capture, not the game: a live fight never repeats a frame exactly across shots); `single` = one shot, nothing to
 * compare; `none` = nothing captured */
export interface ShotsCheck { status: "ok" | "stale" | "single" | "none"; detail: string }
export function assessShots(shots: { label: string; path: string | null }[]): ShotsCheck {
  const got = shots.filter((s) => s.path && existsSync(s.path));
  if (!got.length) return { status: "none", detail: "no shot captured" };
  if (got.length === 1) return { status: "single", detail: "one shot; nothing to compare it with" };
  const hashes = got.map((s) => createHash("sha256").update(readFileSync(s.path!)).digest("hex"));
  if (new Set(hashes).size === 1) return { status: "stale", detail: `all ${got.length} shots byte-identical (${got.map((s) => s.label).join(", ")}): a frozen capture, not the game` };
  return { status: "ok", detail: `${new Set(hashes).size} distinct of ${got.length}` };
}

/** for the probes: a message refusing to derive a verdict from stale shots, or null when the shots are usable (a
 * report from before shotsCheck existed, e.g. art-probe --from, is assessed from its shots) */
export function staleShotsRefusal(report: { artifacts: { shotsCheck?: ShotsCheck; shots?: { label: string; path: string | null }[] } }): string | null {
  const c = report.artifacts.shotsCheck || (report.artifacts.shots && report.artifacts.shots.length ? assessShots(report.artifacts.shots) : undefined);
  return c && c.status === "stale" ? `shots: stale — ${c.detail}; no verdict derived from them (re-run; see docs/ingame-testing.md "shot")` : null;
}
