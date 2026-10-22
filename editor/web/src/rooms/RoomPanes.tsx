// The Rooms chunk's entry (App.tsx loads it with React.lazy the first time Rooms mode shows): the explorer, the
// centre (toolbar + flat grid or iso view, the empty state, the New room dialog) and the Inspector | Findings panel.
// room-state.ts stays in the shell (actions.ts, the top bar and the status bar read it).

import React from "react";
import { useStore, useStoreShallow } from "../store.ts";
import { S } from "../state.ts";
import { Button, EmptyState } from "../components/ui.tsx";
import { R, openNewRoom } from "./room-state.ts";
import { RoomToolbar } from "./RoomToolbar.tsx";
import { RoomGrid } from "./RoomGrid.tsx";
import { RoomIso } from "./RoomIso.tsx";
import { NewRoomModal } from "./NewRoomModal.tsx";
import { useStrokeEnd } from "./grid-input.ts";

export { RoomExplorer } from "./RoomExplorer.tsx";
export { RoomRightPanel } from "./RoomInspector.tsx";

function RoomsEmpty(): React.JSX.Element {
  const mod = useStore(S, (s) => s.mod);
  return (
    <div className="emptycenter">
      <EmptyState
        icon="▦"
        title="Paint a room the game can load"
        body={
          <>
            A room is a binary <span className="mono">levels/&lt;folder&gt;/&lt;name&gt;.lvl</span>: a 10x10 grid of <span className="mono">tiles.gon</span> ids and objects
            placed by <span className="mono">spawns.gon</span> id (enemies, props, the <span className="mono">PlayerSpawn</span> cells). Any id can instead be a weighted random
            list. Play one in a test fight with the console command <span className="mono">load &lt;folder&gt;/&lt;name&gt;</span>. See docs/data-mods.md "Maps, rooms and
            encounters".
          </>
        }
        actions={
          mod ? (
            <Button variant="primary" onClick={() => openNewRoom()}>
              + New room
            </Button>
          ) : (
            <span className="muted">No mod open — pick one from the top-bar mod switcher first.</span>
          )
        }
      />
    </div>
  );
}

export function RoomCenter(): React.JSX.Element {
  const { hasLevel, newOpen, view } = useStoreShallow(R, (r) => ({ hasLevel: !!r.level, newOpen: r.newOpen, view: r.view }));
  useStrokeEnd();
  return (
    <div className="center">
      {hasLevel ? <RoomToolbar /> : null}
      {hasLevel ? view === "iso" ? <RoomIso /> : <RoomGrid /> : <RoomsEmpty />}
      {newOpen ? <NewRoomModal /> : null}
    </div>
  );
}
