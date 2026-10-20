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
import { existsSync, writeFileSync } from "node:fs";

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
