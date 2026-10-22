// The Art chunk's entry (App.tsx loads it with React.lazy the first time Art mode shows): the three Art panes, and
// the preview renderer (preview-gl.ts), which art-state.ts — imported by the shell — only knows by type. The Ruffle
// host comes along through ArtRightPanel. Nothing here runs until Art mode is opened.

import { createPreview } from "./preview-gl.ts";
import { registerPreviewFactory } from "./art-state.ts";

registerPreviewFactory(createPreview);

export { ArtExplorer } from "./ArtExplorer.tsx";
export { ArtCenter } from "./ArtCenter.tsx";
export { ArtRightPanel } from "./ArtRightPanel.tsx";
