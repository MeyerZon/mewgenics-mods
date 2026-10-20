// How the game draws a mod's SWF art, as OBSERVED in the game (npm run test:artprobe, 2026-10-20; the summary is
// pinned in editor/test/fixtures/ingame/artprobe-summary.json and a test keeps these constants in agreement with it).
// The preview renderer (web/src/art/preview-gl.ts) reads these instead of guessing.

export const ENGINE_DRAWING = {
  /** a nested sprite advances on its own clock (under a one-frame parent it still animates), like Flash's free-running child timelines */
  nestedSprites: "own-clock" as "own-clock" | "parent-frame",
  /** bitmap fills are filtered (blended inside magnified texels), not point-sampled */
  bitmapSampling: "linear" as "linear" | "nearest",
  /** outside the bitmap the edge texels streak (a Flash "clipped" fill), they do not repeat */
  bitmapEdge: "clamp" as "clamp" | "repeat",
  /** enemy clips are drawn mirrored horizontally (they face left); the preview shows the clip as authored */
  enemyClipsMirrored: true,
  /**
   * a character's root clip timeline is driven by the game (it stays near its first frames: restarted), unlike nested
   * sprites; free-running animation belongs in a nested sprite, game states in frame labels
   */
  rootTimeline: "game-driven" as "game-driven" | "plays" | "held",
  /** still unknown: whether a PlaceObject cxform applies before or after the palette remap (enemies are unpaletted) */
  observed: "2026-10-20, build 25143593, npm run test:artprobe",
} as const;

/** The frame a nested sprite with `frames` frames shows at `clock` (the frames elapsed since the root started). */
export function nestedFrame(clock: number, frames: number): number {
  if (frames <= 0) return 0;
  return ((Math.floor(clock) % frames) + frames) % frames;
}
