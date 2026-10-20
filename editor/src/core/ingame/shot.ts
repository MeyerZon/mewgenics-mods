// Screenshots for `shot "<label>"`: the DLL emits a shot event and holds the scene ~700 ms; the runner, which polls
// the result file every 250 ms, captures the game window as soon as it sees the event. The capture is a small
// PowerShell script (System.Drawing CopyFromScreen of the process's main-window rectangle; the whole primary screen
// when the window cannot be located), written next to the shot so the run dir shows exactly what ran. No
// dependency; injectable for tests (`RunPlanArgs.capture`).

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";

/** (label, run dir, game pid) -> path of the PNG, or null when nothing was captured */
export type CaptureFn = (label: string, dir: string, pid: number | null) => string | null;

/** `shot-<label>.png`, label reduced to a file-safe slug */
export function shotFileName(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "shot";
  return `shot-${slug}.png`;
}

export const CAPTURE_PS1 = `param([int]$ProcId, [string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace U -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); public struct RECT { public int L; public int T; public int R; public int B; }'
$rect = $null
if ($ProcId -gt 0) {
  $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) {
    $r = New-Object U.W+RECT
    if ([U.W]::GetWindowRect($p.MainWindowHandle, [ref]$r) -and ($r.R - $r.L) -gt 50 -and ($r.B - $r.T) -gt 50) { $rect = $r }
  }
}
if ($rect) { $x = $rect.L; $y = $rect.T; $w = $rect.R - $rect.L; $h = $rect.B - $rect.T; $what = "window" }
else { $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $x = $b.X; $y = $b.Y; $w = $b.Width; $h = $b.Height; $what = "screen" }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$what $w x $h"
`;

/** Capture the game window (or the screen) into `<dir>/shot-<label>.png`; null when the capture failed. */
export const captureWindow: CaptureFn = (label, dir, pid) => {
  const out = join(dir, shotFileName(label));
  const ps1 = join(dir, "capture.ps1");
  if (!existsSync(ps1)) writeFileSync(ps1, CAPTURE_PS1);
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, "-ProcId", String(pid ?? 0), "-Out", out], {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
  });
  if (r.status !== 0 || !existsSync(out)) return null;
  return out;
};
