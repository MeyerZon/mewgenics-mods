// The `…` overflow menu of a Shapes-tab row (the Menu primitive, open state in S.openMenu as "shape:<id>", so a click
// elsewhere or Esc closes it like the top bar's menus). Its items keep the aria-labels the row's inline buttons had:
// Open <id> in VectorCraft, Export SVG of <id>, Bake glow of <id>, Wrap <id> in a sprite, Delete shape <id>; Replace…
// clicks the row's hidden file input "Replace <id> from SVG" (it stays in the row so a file can be set on it directly).

import React, { useRef } from "react";
import { useS, Menu } from "../components/ui.tsx";
import { toggleMenu, closeMenu } from "../actions.ts";
import { exportShapeSvgFile, replaceShapeFromSvg, openShapeInVectorcraft, wrapShapeInSprite, deleteShape } from "./art-state.ts";

export function ShapeRowMenu({ id, baked, onBakeGlow }: { id: string; baked: boolean; onBakeGlow: () => void }) {
  const open = useS((s) => s.openMenu === `shape:${id}`);
  const file = useRef<HTMLInputElement>(null);
  const run = (fn: () => void) => () => {
    closeMenu();
    fn();
  };
  return (
    <>
      <input
        ref={file}
        type="file"
        accept=".svg,image/svg+xml"
        aria-label={`Replace ${id} from SVG`}
        hidden
        onChange={(e) => {
          const f = e.target.files && e.target.files[0];
          if (f) void replaceShapeFromSvg(id, f);
          e.target.value = "";
        }}
      />
      <Menu label="…" aria-label={`More actions for ${id}`} triggerClassName="btn ghost sm" right open={open} onToggle={() => toggleMenu(`shape:${id}`)} onClose={closeMenu}>
        <button type="button" className="item" aria-label={`Open ${id} in VectorCraft`} title="Draw on this shape in the VectorCraft tab (in-editor); Apply there brings it back" onClick={run(() => openShapeInVectorcraft(id))}>
          Open in VectorCraft
        </button>
        <button type="button" className="item" aria-label={`Export SVG of ${id}`} title="Write art/<shape>.svg for VectorCraft, Inkscape or any vector editor" onClick={run(() => void exportShapeSvgFile(id))}>
          Export SVG
        </button>
        {baked ? null : (
          <button type="button" className="item" aria-label={`Bake glow of ${id}`} title="The game refuses SWF filters; this bakes a halo shape <id>_glow under this shape (bakeGlow)" onClick={run(onBakeGlow)}>
            Bake glow…
          </button>
        )}
        <button type="button" className="item" title="Bring an edited SVG back over this shape (same coordinates)" onClick={run(() => file.current?.click())}>
          Replace from SVG…
        </button>
        <button type="button" className="item" aria-label={`Wrap ${id} in a sprite`} title="Wrap this shape in a new 1-frame sprite (exported under its own name)" onClick={run(() => wrapShapeInSprite(id))}>
          Wrap in a sprite
        </button>
        <div className="sep" />
        <button type="button" className="item danger" aria-label={`Delete shape ${id}`} onClick={run(() => deleteShape(id))}>
          Delete
        </button>
      </Menu>
    </>
  );
}
