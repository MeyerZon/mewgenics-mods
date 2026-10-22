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
#include <stdio.h>
#include "fw_unit_model.h"
#include "fw_unit_face.h"     /* M3: the model turns with Character::Face */
#include "fw_glow_rules.h"    /* fw_glow_renderer */
#include "fw_obs3d_rules.h"   /* fw_obs3d_renderer_position / _position_xz / _is_masked_renderer_iso */
#include "fw_model_names.h"   /* M3 "@Name": data/models.gon */
#include "fw_resolve.h"       /* fw_resolve_data_addr */
#include "fw_vtable.h"        /* fw_msvc_init: the by-value std::string Gon_LoadFile destroys */

static Fw3dRegistry g_reg;
static int g_init;
static void *g_tt;   /* the TacticsTest of the last on_fight call: another one = a new fight scene */
static void units_new_fight(void);   /* the per-unit models' state (end of this file) */

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

int obj3d_engine_set_material(int handle, const char *texture, int palette) {
    int ok = fw_obj3d_set_material(reg(), handle, texture, palette);
    fw_log("Set3DObjectMaterial(%d, %s, palette %d): %s", handle, texture && texture[0] ? texture : "(convention)", palette,
           ok ? "ok" : "refused (unknown handle or bad texture name)");
    return ok;
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
        units_new_fight();
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

/* ------------------------------------------------------------------------------------------------------------------
 * Per-unit models from GON (3D phase M2 item 4): a unit whose data/characters entry has `graphics.model` (the string
 * or the block form, fw_gon_model_block) gets that model registered on it, once per (Character, pool generation).
 * The units come from the harness's walk (TurnControl -> Scene -> EntityManager -> +0x1f90, fw_unit_walk) on the
 * TurnControl framework.c's NextTurn hook hands over (obj3d_engine_on_turn_control); every read before registration
 * is guarded. Each combat frame the registered GON objects get their facing (Renderer_GetScreenMatrix m0 sign), their
 * face yaw (M3: Character::Face's stored direction, fw_unit_face.h; a "unit model face:" line when it changes) and a
 * position line when they moved (fw_unit_fmt_at). The mesh engine draws them like any API object.
 * ---------------------------------------------------------------------------------------------------------------- */
typedef float *(*fn_GetScreenMatrix)(void *renderer, float out[16]);

static void *volatile g_unitTc;   /* the fight's TurnControl (NextTurn); NULL until the first turn of this fight */
static FwUnitSeen g_seen;
#define UNIT_LOG_AT_MAX 64        /* position lines per process (a long fight must not flood the log) */
static int g_atLogged;
#define UNIT_LOG_FACE_MAX 64      /* face lines per process */
static int g_faceLogged;
typedef struct UnitTrack { int handle; int logged; double last[2]; char entry[48]; int faceLogged; double faceYaw; } UnitTrack;
static UnitTrack g_track[FW_OBJ3D_MAX];
static int g_ntrack;

void obj3d_engine_on_turn_control(void *turnControl) { g_unitTc = turnControl; }

/* obj3d_engine_on_fight's new-scene branch: a TurnControl of the old fight must never be walked again */
/* ---- named models (3D phase M3 "@Name", fw_model_names.c): data/models.gon through the game's own GON loader ----
 * Gon_LoadFile(ResourceMap, "data/models.gon", 0, 1) is what SpawnDatabase / appmain / MewsicController call for their
 * data files: the pack copy or a mod path's plain file, then every mod's .append / .merge / .patch applied in mod-path
 * order (FileManager_ResolveWithOverlays 0x9a09f0 -> GonResource::combined_decode 0x9a64a0); NULL when no mod ships
 * the base (mods/fw-3d does). The resource is cached by the game; we read it lazily, on the first "@" reference of a
 * fight, and copy the entries out (fw_model_names_load through the guarded reader). */
typedef void *(*fn_GonLoadFile)(void *resourceMap, MsvcString *path, char reload, char flag);
static FwModelNames g_names;
static int g_namesLoaded;            /* 0 not yet this fight */
static FwModelNamesLogged g_namesLogged;   /* one error line per reference per process */

static const FwModelNames *model_names(void) {
    if (g_namesLoaded) return &g_names;
    g_namesLoaded = 1;
    fw_model_names_clear(&g_names);
    void *map = (void *)fw_resolve_data_addr(1, g_build, g_base, FW_DATA_ResourceMap);
    fn_GonLoadFile load = (fn_GonLoadFile)g_sym[FW_SYM_Gon_LoadFile];
    MsvcString s;
    if (!map || !load || !g_sym[FW_SYM_string_Allocate] || !fw_msvc_init(&s, FW_MODEL_REGISTRY_FILE, (FwStringAlloc)g_sym[FW_SYM_string_Allocate])) {
        fw_log("model names: Gon_LoadFile / ResourceMap not resolved on this build: no \"@Name\" model resolves");
        g_names.loaded = 1;
        return &g_names;
    }
    void *res = load(map, &s, 0, 1);   /* destroys s */
    const void *root = res ? (const char *)res + OFF_GONRES_OBJECT : NULL;
    fw_model_names_load(guarded_read, NULL, root, &g_names);
    char line[1024];
    fw_model_names_fmt_loaded(line, sizeof line, &g_names, root == NULL);
    fw_log("%s (GonResource %p)", line, res);
    return &g_names;
}

static void units_new_fight(void) {
    g_unitTc = NULL;
    fw_unit_seen_clear(&g_seen);
    g_ntrack = 0;
    g_namesLoaded = 0;   /* a new fight reads the (cached) registry again */
}

static uint64_t epoch_ms(void) {
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    uint64_t t = ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    return (t - 116444736000000000ull) / 10000ull;
}

static void discover(void *tc) {
    static void *units[FW_UNIT_WALK_MAX];
    int n = fw_unit_walk(guarded_read, NULL, tc, units, FW_UNIT_WALK_MAX);
    for (int i = 0; i < n; i++) {
        void *ch = units[i];
        uint64_t gen = 0;
        const void *entry = NULL;
        if (!ch || !guarded_read(NULL, (const char *)ch + OFF_CH_GENERATION, &gen, sizeof gen) ||
            !guarded_read(NULL, (const char *)ch + OFF_CH_GON_ENTRY, &entry, sizeof entry) || !entry) continue;   /* not initialised yet: next frame */
        if (!fw_unit_seen_first(&g_seen, ch, gen)) continue;
        FwGonModel m;
        int r = fw_gon_model_block(guarded_read, NULL, entry, &m);
        if (r != 1) {
            if (m.invalid & FW_GON_MODEL_BAD_FILE) fw_log("unit model: %p: graphics.model is a block without a string file; no model", ch);
            continue;
        }
        char name[48];
        if (fw_gon_node_name(guarded_read, NULL, entry, name, sizeof name) != 1) snprintf(name, sizeof name, "?");
        char line[512];
        if (m.file[0] == '@') {   /* M3: a named model of data/models.gon; the unit's keys override the entry's */
            FwGonModel unit = m;
            const FwModelName *hit = NULL;
            const FwModelNames *names = model_names();
            int rc = fw_model_names_resolve(names, &unit, &m, &hit);
            if (rc != FW_MODEL_REF_OK) {   /* model-name-unknown / model-registry-entry: the unit keeps its 2D clip */
                if (fw_model_names_log_first(&g_namesLogged, unit.file)) {
                    fw_model_names_fmt_error(line, sizeof line, unit.file, rc, name, names, hit);
                    fw_log("%s", line);
                }
                continue;
            }
            fw_log("unit model: %s: %s -> %s entry %s", name, unit.file, FW_MODEL_REGISTRY_FILE, hit ? hit->name : "?");
        }
        fw_unit_fmt_model(line, sizeof line, name, ch, &m);
        fw_log("%s", line);
        if (m.file[0] != '@' && !fw_obj3d_model_path_ok(m.file)) {
            fw_log("unit model: %s: \"%s\" is not a models/<...>.obj|.gltf|.glb path or an @Name; not registered", name, m.file);
            continue;
        }
        float tr[16];
        fw_unit_model_transform(m.scale, m.yaw, m.offset, tr);
        int h = obj3d_engine_register(ch, m.file, tr);
        if (!h) continue;
        fw_obj3d_mark_gon(reg(), h);
        if (!fw_obj3d_set_look(reg(), h, m.texture, m.tint, m.palette, m.doubleSided))
            fw_log("unit model: %s: texture \"%s\" refused (not printable ASCII / too long); drawn without it", name, m.texture);
        fw_obj3d_set_hide(reg(), h, m.hideSprite);   /* M3: only `hide_sprite true` hides (fw_mesh_hide.h) */
        if (m.hideSprite == 1) fw_log("unit model: %s: hide_sprite: the 2D sprite is not drawn while the model draws", name);
        else if (m.invalid & FW_GON_MODEL_BAD_HIDE_SPRITE) fw_log("unit model: %s: model-flag hide_sprite is not true/false; the sprite is drawn", name);
        int k = 0;
        while (k < g_ntrack && g_track[k].handle != h) k++;
        if (k == g_ntrack) { if (g_ntrack >= FW_OBJ3D_MAX) continue; g_ntrack++; }
        memset(&g_track[k], 0, sizeof g_track[k]);
        g_track[k].handle = h;
        snprintf(g_track[k].entry, sizeof g_track[k].entry, "%s", name);
    }
}

static void follow(void) {
    void *getScreen = (void *)g_sym[FW_SYM_Renderer_GetScreenMatrix];
    uintptr_t vft = g_base + g_build->rva_MaskedRendererIso_vftable;
    for (int i = 0; i < fw_obj3d_count(reg()); i++) {
        const Fw3dObject *o = fw_obj3d_at(reg(), i);
        if (!o || o->byTile || !o->fromGon || !o->character) continue;
        void *rnd = fw_glow_renderer(o->character);
        void *pos = rnd ? fw_obs3d_renderer_position(rnd) : NULL;
        if (!pos) continue;
        float screen[16];
        int haveScreen = getScreen && fw_obs3d_is_masked_renderer_iso(rnd, vft);
        if (haveScreen) ((fn_GetScreenMatrix)getScreen)(rnd, screen);
        int facing = haveScreen ? fw_unit_facing(screen) : 1;
        fw_obj3d_set_facing(reg(), o->handle, facing);
        /* M3 face: the yaw from the direction Character::Face stored (+OFF_CH_ORIENTATION), else the sprite's mirror */
        int dir[2], src = 0;
        int dirOk = fw_face_read_dir(guarded_read, NULL, o->character, dir);
        double faceYaw = fw_face_yaw(dirOk, dir, facing, &src);
        fw_obj3d_set_face_yaw(reg(), o->handle, faceYaw);
        double xz[2];
        fw_obs3d_position_xz(pos, xz);
        for (int k = 0; k < g_ntrack; k++) {
            UnitTrack *t = &g_track[k];
            if (t->handle != o->handle) continue;
            if ((!t->faceLogged || t->faceYaw != faceYaw) && g_faceLogged < UNIT_LOG_FACE_MAX) {
                char fl[160];
                fw_face_fmt(fl, sizeof fl, t->entry, o->handle, dir, faceYaw, src, epoch_ms());
                fw_log("%s", fl);
                g_faceLogged++;
                t->faceLogged = 1;
                t->faceYaw = faceYaw;
            }
            if (fw_unit_moved(t->logged ? t->last : NULL, xz) && g_atLogged < UNIT_LOG_AT_MAX) {
                char line[256];
                fw_unit_fmt_at(line, sizeof line, t->entry, o->handle, xz, haveScreen ? screen : NULL, facing, epoch_ms());
                fw_log("%s", line);
                g_atLogged++;
                t->logged = 1;
                t->last[0] = xz[0]; t->last[1] = xz[1];
            }
            break;
        }
    }
}

void obj3d_engine_units_frame(void) {
    void *tc = g_unitTc;
    if (tc) discover(tc);
    follow();
}
