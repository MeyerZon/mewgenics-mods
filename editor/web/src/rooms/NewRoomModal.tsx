// Rooms mode: the New room dialog — new_from_template kind room into levels/<folder>/<name>.lvl. A <form>, so Enter
// in either field creates; the footer's Create is the form's submit button.

import React, { useState } from "react";
import { useStore } from "../store.ts";
import { S } from "../state.ts";
import { sx, Modal, Button } from "../components/ui.tsx";
import { newRoom, closeNewRoom } from "./room-state.ts";

const FORM_ID = "newroom-form";

export function NewRoomModal(): React.JSX.Element {
  const mod = useStore(S, (s) => s.mod);
  const [folder, setFolder] = useState(mod.replace(/[^A-Za-z0-9_-]/g, "_") || "custom");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setErr("enter a room name");
      return;
    }
    setBusy(true);
    const msg = await newRoom(folder.trim(), name.trim());
    setBusy(false);
    if (msg) setErr(msg);
  };
  return (
    <Modal
      title="New room"
      icon="＋"
      onClose={closeNewRoom}
      initialFocus="#newroom-name"
      footer={
        <>
          <div className="grow" />
          <Button variant="ghost" onClick={closeNewRoom}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={FORM_ID} disabled={busy}>
            Create
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={(e) => void submit(e)}>
        <p className="muted" style={sx("margin:0 0 6px")}>{`Writes mods/${mod}/levels/<folder>/<name>.lvl from the room template: 4 player spawns on the top row and 2 Rats near the bottom.`}</p>
        <label className="fld" htmlFor="newroom-folder">
          folder (under levels/)
        </label>
        <input id="newroom-folder" className="mono" value={folder} onChange={(e) => setFolder(e.target.value)} />
        <label className="fld" htmlFor="newroom-name">
          room name
        </label>
        <input id="newroom-name" className="mono" placeholder="my_room" value={name} onChange={(e) => setName(e.target.value)} />
        {err ? (
          <div className="finding error" role="alert">
            <span className="mark">✕</span>
            <div>{err}</div>
          </div>
        ) : null}
        {/* Enter in either field submits (the footer's Create is this form's submit button) */}
      </form>
    </Modal>
  );
}
