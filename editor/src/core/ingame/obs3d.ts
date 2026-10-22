// The phase-0 3D observer's log lines (native/framework/src/obs3d_engine.c over fw_obs3d_rules.c; the formats are
// pinned by native/framework/test/test_obs3d_rules.c). A launch with MEWFW_OBSERVE3D=N writes them into
// mod_logs/mewframework.log; the runner copies the session's window as mewframework.window.log. This module reads them
// back so a T2 run's lines can be pinned as a fixture (editor/test/fixtures/ingame/observe3d-log.txt) and the facts the
// 3D plan relies on (docs/possible_3d_work.md) are checked by tests rather than by eye.

export interface Obs3dCamera { cam: string; world: boolean; rtt: boolean; hdr: boolean; zoom: number; flip: number; layers: bigint; vp: number[] }
export interface Obs3dLayer { layer: number; mode: number; items: number }
export interface Obs3dItem { layer: number; rnd: string; x: number; z: number; screen: number[] | null }
export interface Obs3dGlobals { iso: number[]; isoinv: number[]; flags: number; cull: number; depthBias: number; stackTop: number }
export interface Obs3dApp { clearColor: boolean; clearDepth: boolean; clearStencil: boolean; antialias: number; samples: number }
export interface Obs3dFrame { frame: number; cameras: Obs3dCamera[]; layers: Obs3dLayer[]; items: Obs3dItem[]; globals: Obs3dGlobals | null; app: Obs3dApp | null }
export interface Obs3dLog { fights: string[]; frames: Obs3dFrame[] }

const mat = (s: string): number[] => s.trim().split(/\s+/).map(Number);

export function parseObs3dLog(text: string): Obs3dLog {
  const out: Obs3dLog = { fights: [], frames: [] };
  const frame = (n: number): Obs3dFrame => {
    let f = out.frames.find((x) => x.frame === n);
    if (!f) { f = { frame: n, cameras: [], layers: [], items: [], globals: null, app: null }; out.frames.push(f); }
    return f;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^obs3d fight tt=(\S+)/))) { out.fights.push(m[1]!); continue; }
    if ((m = line.match(/^obs3d cam f=(\d+) cam=(\S+) world=(\d) rtt=(\d) hdr=(\d) zoom=(\S+) flip=(-?\d+) layers=0x([0-9a-f]+) vp=\[([^\]]*)\]/))) {
      frame(Number(m[1])).cameras.push({ cam: m[2]!, world: m[3] === "1", rtt: m[4] === "1", hdr: m[5] === "1", zoom: Number(m[6]), flip: Number(m[7]), layers: BigInt("0x" + m[8]), vp: mat(m[9]!) });
      continue;
    }
    if ((m = line.match(/^obs3d layers f=(\d+)(.*)$/))) {
      const f = frame(Number(m[1]));
      for (const t of m[2]!.trim().split(/\s+/).filter(Boolean)) {
        const p = t.match(/^0x([0-9a-f]+):m(-?\d+):n(\d+)$/);
        if (p) f.layers.push({ layer: parseInt(p[1]!, 16), mode: Number(p[2]), items: Number(p[3]) });
      }
      continue;
    }
    if ((m = line.match(/^obs3d item f=(\d+) layer=0x([0-9a-f]+) rnd=(\S+) pos=\((\S+) (\S+)\) screen=\[([^\]]*)\](.*)$/))) {
      const noMatrix = /not a MaskedRendererIso/.test(m[7]!);
      frame(Number(m[1])).items.push({ layer: parseInt(m[2]!, 16), rnd: m[3]!, x: Number(m[4]), z: Number(m[5]), screen: noMatrix ? null : mat(m[6]!) });
      continue;
    }
    if ((m = line.match(/^obs3d globals iso=\[([^\]]*)\] isoinv=\[([^\]]*)\] flags=0x([0-9a-f]+) cull=(-?\d+) depthbias=(\S+) stacktop=(-?\d+) f=(\d+)/))) {
      frame(Number(m[7])).globals = { iso: mat(m[1]!), isoinv: mat(m[2]!), flags: parseInt(m[3]!, 16), cull: Number(m[4]), depthBias: Number(m[5]), stackTop: Number(m[6]) };
      continue;
    }
    if ((m = line.match(/^obs3d app clear=([01])([01])([01]) antialias=(-?\d+) samples=(-?\d+) f=(\d+)/))) {
      frame(Number(m[6])).app = { clearColor: m[1] === "1", clearDepth: m[2] === "1", clearStencil: m[3] === "1", antialias: Number(m[4]), samples: Number(m[5]) };
    }
  }
  out.frames.sort((a, b) => a.frame - b.frame);
  return out;
}

/** the layer indices whose bit is set */
export function layerList(bits: bigint): number[] {
  const out: number[] = [];
  for (let i = 0; i < 64; i++) if ((bits >> BigInt(i)) & 1n) out.push(i);
  return out;
}

/** determinant of a column-major 4x4 (the autoflip's sign test, Mat4_IsMirrored 0xa082b0) */
export function det4(m: number[]): number {
  const a = (c: number, r: number): number => m[c * 4 + r]!;
  const minor = (skipC: number): number => {
    const cols = [0, 1, 2, 3].filter((c) => c !== skipC);
    const g = (i: number, r: number): number => a(cols[i]!, r);
    return g(0, 1) * (g(1, 2) * g(2, 3) - g(1, 3) * g(2, 2)) - g(1, 1) * (g(0, 2) * g(2, 3) - g(0, 3) * g(2, 2)) + g(2, 1) * (g(0, 2) * g(1, 3) - g(0, 3) * g(1, 2));
  };
  let d = 0;
  for (let c = 0; c < 4; c++) d += (c % 2 === 0 ? 1 : -1) * a(c, 0) * minor(c);
  return d;
}

export interface Obs3dSummary {
  worldFrames: number;
  worldCamera: string | null;
  worldRtt: boolean | null;
  worldZoom: number;
  worldFlip: number;
  worldLayers: number[];
  vpDetNegative: boolean;
  depthCleared: boolean | null;
  unitM14: number | null;
  camerasPerFrame: number;
}

export function summarizeObs3d(log: Obs3dLog): Obs3dSummary {
  const worlds = log.frames.flatMap((f) => f.cameras.filter((c) => c.world));
  const w = worlds[0] ?? null;
  const apps = log.frames.map((f) => f.app).filter((a): a is Obs3dApp => a !== null);
  const unit = log.frames.flatMap((f) => f.items).find((i) => i.layer === 0x19 && i.screen !== null) ?? null;
  return {
    worldFrames: worlds.length,
    worldCamera: w ? w.cam : null,
    worldRtt: w ? w.rtt : null,
    worldZoom: w ? w.zoom : 0,
    worldFlip: w ? w.flip : 0,
    worldLayers: w ? layerList(w.layers) : [],
    vpDetNegative: worlds.length > 0 && worlds.every((c) => det4(c.vp) < 0),
    depthCleared: apps.length ? apps.every((a) => a.clearDepth) : null,
    unitM14: unit ? unit.screen![14]! : null,
    camerasPerFrame: log.frames[0] ? log.frames[0].cameras.length : 0,
  };
}
