// Ruffle (the WASM Flash player) as a *reference* player in Art mode: it plays a built mod SWF or an extracted
// vanilla SWF from bytes. It is not glaiel::swf — no palette remap, no _Append_ merging — so it answers "what does
// this SWF contain and how does it animate as Flash", never "how will the game draw it".
// Loaded on demand from the same origin (web/public/ruffle/, vendored by scripts/vendor-ruffle.ts) with networking,
// script access and URL opening off.

interface RufflePlayerElement extends HTMLElement {
  ruffle(): { load(opts: { data: ArrayBuffer }): Promise<void>; metadata?: RuffleMetadata | null; pause?(): void; resume?(): void };
  /** older API surface, kept for safety */
  metadata?: RuffleMetadata | null;
  play?(): void;
  pause?(): void;
}
export interface RuffleMetadata {
  numFrames?: number;
  frameRate?: number;
  width?: number;
  height?: number;
  swfVersion?: number;
}
interface RuffleGlobal {
  config?: Record<string, unknown>;
  newest(): { createPlayer(): RufflePlayerElement };
}
declare global {
  interface Window { RufflePlayer?: RuffleGlobal }
}

export const RUFFLE_CONFIG: Record<string, unknown> = {
  polyfills: false,
  autoplay: "on",
  unmuteOverlay: "hidden",
  splashScreen: false,
  letterbox: "off",
  allowNetworking: "none",
  allowScriptAccess: false,
  openUrlMode: "deny",
  upgradeToHttps: false,
  warnOnUnsupportedContent: false,
  logLevel: "error",
  backgroundColor: "#1a212b",
};

let loading: Promise<RuffleGlobal> | null = null;

/** Inject ./ruffle/ruffle.js once and resolve with window.RufflePlayer. */
export function loadRuffle(): Promise<RuffleGlobal> {
  if (loading) return loading;
  loading = new Promise<RuffleGlobal>((resolve, reject) => {
    window.RufflePlayer = window.RufflePlayer || ({} as RuffleGlobal);
    window.RufflePlayer.config = { ...RUFFLE_CONFIG };
    const s = document.createElement("script");
    s.src = "./ruffle/ruffle.js";
    s.async = true;
    s.onload = () => (window.RufflePlayer && typeof window.RufflePlayer.newest === "function" ? resolve(window.RufflePlayer) : reject(new Error("ruffle.js loaded but window.RufflePlayer.newest is missing")));
    s.onerror = () => { loading = null; reject(new Error("ruffle.js not found (run npm run build, which vendors Ruffle into web/public/ruffle/)")); };
    document.head.appendChild(s);
  });
  return loading;
}

/** Create a player in `container` (replacing any previous one) and load the bytes. */
export async function playSwfBytes(container: HTMLElement, bytes: ArrayBuffer): Promise<RufflePlayerElement> {
  const r = await loadRuffle();
  container.replaceChildren();
  const player = r.newest().createPlayer();
  player.style.width = "100%";
  player.style.height = "100%";
  container.appendChild(player);
  await player.ruffle().load({ data: bytes });
  return player;
}

/** The SWF header facts once Ruffle has parsed it (frames, rate, size, version); null while loading. */
export function metadataOf(player: RufflePlayerElement): RuffleMetadata | null {
  try {
    const m = player.ruffle().metadata ?? player.metadata ?? null;
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}
