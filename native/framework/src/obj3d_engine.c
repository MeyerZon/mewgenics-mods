/*
 * obj3d_engine.c — the 3D-object registry behind API v6 (FW_Register3DObject / FW_Place3DObjectOnTile /
 * FW_Unregister3DObject) and the 3D data seam (a unit's GON `graphics.model`).
 *
 * This file only records: it owns the one static Fw3dRegistry (fw_obj3d_rules.c, host-tested), logs every
 * registration the way glow_engine.c does, and hands the objects to the mesh engine (the lead's mesh_engine.c),
 * which resolves `model` names, reads each unit's world position, builds fw_obj3d_model_matrix and draws. The mesh
 * engine calls, per combat frame from its TacticsTest::LateRender work:
 *     obj3d_engine_on_fight(tt);                       // a new TacticsTest clears the registry; prunes freed units
 *     for (int i = 0; i < obj3d_engine_count(); i++) { const Fw3dObject *o = obj3d_engine_get(i); ... }
 * and, per unit it considers, obj3d_engine_unit_model(character, buf, cap) for the GON `graphics.model` key (read
 * from the live entry at Character+OFF_CH_GON_ENTRY through a VirtualQuery-guarded reader).
 *
 * Main thread only, like the glow registry (the harness and turn callbacks are).
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string.h>
#include "framework_internal.h"
#include "fw_obj3d_rules.h"
#include "fw_gon.h"

static Fw3dRegistry g_reg;
static int g_init;
static void *g_tt;   /* the TacticsTest of the last on_fight call: another one = a new fight scene */

static Fw3dRegistry *reg(void) {
    if (!g_init) { fw_obj3d_init(&g_reg); g_init = 1; }
    return &g_reg;
}

int obj3d_engine_register(void *character, const char *model, const float transform[16]) {
    int h = fw_obj3d_add_character(reg(), character, model, transform);
    fw_log("Register3DObject(%p, %s): %s handle %d (%d object(s))", character, model ? model : "(null)",
           h ? "ok" : "refused (null unit, bad model name, or 64 objects)", h, fw_obj3d_count(reg()));
    return h;
}

int obj3d_engine_place(int col, int row, const char *model, const float transform[16]) {
    int h = fw_obj3d_add_tile(reg(), col, row, model, transform);
    fw_log("Place3DObjectOnTile(%d, %d, %s): %s handle %d (%d object(s))", col, row, model ? model : "(null)",
           h ? "ok" : "refused (tile out of range, bad model name, or 64 objects)", h, fw_obj3d_count(reg()));
    return h;
}

int obj3d_engine_unregister(void *character, int handle) {
    int ok = character ? fw_obj3d_remove_character(reg(), character) : fw_obj3d_remove_handle(reg(), handle);
    fw_log("Unregister3DObject(%p, %d): %s (%d object(s))", character, handle, ok ? "removed" : "not registered", fw_obj3d_count(reg()));
    return ok;
}

int obj3d_engine_count(void) { return fw_obj3d_count(reg()); }

const Fw3dObject *obj3d_engine_get(int i) { return fw_obj3d_at(reg(), i); }

void obj3d_engine_on_fight(void *tacticsTest) {
    if (tacticsTest != g_tt) {
        if (g_tt && fw_obj3d_count(reg())) fw_log("obj3d: new fight scene (TacticsTest %p -> %p): %d object(s) dropped", g_tt, tacticsTest, fw_obj3d_count(reg()));
        fw_obj3d_clear(reg());
        g_tt = tacticsTest;
    }
    int dropped = fw_obj3d_prune(reg());
    if (dropped) fw_log("obj3d: %d object(s) dropped (pool generation moved)", dropped);
}

/* a guarded copy (the harness's safe_read): committed, readable pages only */
static int guarded_read(void *u, const void *addr, void *out, size_t n) {
    (void)u;
    MEMORY_BASIC_INFORMATION mbi;
    if (!addr || n == 0) return 0;
    const char *p = (const char *)addr;
    size_t done = 0;
    while (done < n) {
        if (!VirtualQuery(p + done, &mbi, sizeof mbi)) return 0;
        if (mbi.State != MEM_COMMIT || (mbi.Protect & PAGE_GUARD)) return 0;
        DWORD prot = mbi.Protect & 0xff;
        if (prot == PAGE_NOACCESS || prot == 0) return 0;
        size_t avail = (size_t)((const char *)mbi.BaseAddress + mbi.RegionSize - (p + done));
        size_t chunk = avail < n - done ? avail : n - done;
        memcpy((char *)out + done, p + done, chunk);
        done += chunk;
    }
    return 1;
}

int obj3d_engine_unit_model(const void *character, char *out, size_t cap) {
    const void *entry = NULL;
    if (out && cap) out[0] = 0;
    if (!character || !guarded_read(NULL, (const char *)character + OFF_CH_GON_ENTRY, &entry, sizeof entry)) return -1;
    return fw_gon_model(guarded_read, NULL, entry, out, cap);
}
