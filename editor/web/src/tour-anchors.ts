// The guided tours' anchors (UX PR 6): every element a tour step points at carries `data-tour="<id>"`, and the ids
// are defined here once. Also the pure placement maths for the coachmark card (placeCard / isOnScreen), unit-tested
// in test/web-tests.ts. No DOM and no React here, so Node can load it.

export const TOUR = {
  // Data mode
  explorerBase: "explorer-base",
  explorerFiles: "explorer-files",
  newOverlay: "new-overlay",
  editor: "editor",
  validation: "validation",
  preview: "preview",
  launch: "launch",
  // Art mode
  artSwitch: "art-switch",
  artScenes: "art-scenes",
  artImport: "art-import",
  artShapes: "art-shapes",
  artPreview: "art-preview",
  artBuild: "art-build",
  artSubtabs: "art-subtabs",
  // Rooms mode
  roomsSwitch: "rooms-switch",
  roomsList: "rooms-list",
  roomsPalette: "rooms-palette",
  roomsGrid: "rooms-grid",
  roomsInspector: "rooms-inspector",
  roomsFindings: "rooms-findings",
} as const;

export type TourId = (typeof TOUR)[keyof typeof TOUR];

/** The attribute that marks an element as a tour anchor: spread it on the element (`{...tourAttr(TOUR.editor)}`). */
export function tourAttr(id: TourId | string): { "data-tour": string } {
  return { "data-tour": id };
}

/** The CSS selector of an anchor. */
export function tourSelector(id: string): string {
  return `[data-tour="${id}"]`;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}
/** Where the card goes relative to the target; "over" when no side has room (a target that fills the screen). */
export type CardSide = "right" | "left" | "below" | "above" | "over";
export interface CardPlacement {
  left: number;
  top: number;
  side: CardSide;
  /** the arrow's offset along the card's edge facing the target (px from the card's top for left/right, left for below/above) */
  arrow: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Whether any part of `r` (with a non-zero size) is inside the viewport. */
export function isOnScreen(r: Rect, vp: Size): boolean {
  if (!(r.width > 0 && r.height > 0)) return false;
  return r.left < vp.width && r.left + r.width > 0 && r.top < vp.height && r.top + r.height > 0;
}

/**
 * Place a card of `card` size beside the target `t` inside the viewport `vp`: to its right by default, flipped to the
 * left when the right would overflow, then below, then above; "over" (centred on the visible part of the target)
 * when no side has room. `gap` is the space between target and card, `margin` the viewport inset.
 */
export function placeCard(t: Rect, vp: Size, card: Size, gap = 16, margin = 12): CardPlacement {
  const right = t.left + t.width;
  const bottom = t.top + t.height;
  const vTop = () => clamp(t.top, margin, Math.max(margin, vp.height - card.height - margin));
  const hLeft = () => clamp(t.left, margin, Math.max(margin, vp.width - card.width - margin));
  // the arrow points at the middle of the visible part of the target
  const midY = (clamp(t.top, 0, vp.height) + clamp(bottom, 0, vp.height)) / 2;
  const midX = (clamp(t.left, 0, vp.width) + clamp(right, 0, vp.width)) / 2;
  const arrowY = (top: number) => clamp(midY - top, 18, Math.max(18, card.height - 18));
  const arrowX = (left: number) => clamp(midX - left, 18, Math.max(18, card.width - 18));
  if (right + gap + card.width <= vp.width - margin) {
    const top = vTop();
    return { left: right + gap, top, side: "right", arrow: arrowY(top) };
  }
  if (t.left - gap - card.width >= margin) {
    const top = vTop();
    return { left: t.left - gap - card.width, top, side: "left", arrow: arrowY(top) };
  }
  if (bottom + gap + card.height <= vp.height - margin) {
    const left = hLeft();
    return { left, top: bottom + gap, side: "below", arrow: arrowX(left) };
  }
  if (t.top - gap - card.height >= margin) {
    const left = hLeft();
    return { left, top: t.top - gap - card.height, side: "above", arrow: arrowX(left) };
  }
  const left = clamp(midX - card.width / 2, margin, Math.max(margin, vp.width - card.width - margin));
  const top = clamp(midY - card.height / 2, margin, Math.max(margin, vp.height - card.height - margin));
  return { left, top, side: "over", arrow: 0 };
}
