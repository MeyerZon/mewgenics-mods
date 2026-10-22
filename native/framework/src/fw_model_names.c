/* fw_model_names.c — the named-model registry (3D phase M3 "@Name"); see fw_model_names.h. Pure: the GON walk goes
 * through the caller's reader (fw_gon.c), the path rule is the loader's (fw_mesh_rules.c fw_mesh_model_kind). */
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include "fw_model_names.h"
#include "fw_mesh_rules.h"

void fw_model_names_clear(FwModelNames *r) {
    if (r) memset(r, 0, sizeof *r);
}

static int entry_verdict(int rc, const FwGonModel *m) {
    if (rc != 1) return (m->invalid & FW_GON_MODEL_BAD_FILE) ? FW_MODEL_ENTRY_NO_FILE : FW_MODEL_ENTRY_NOT_MODEL;
    if (m->file[0] == '@') return FW_MODEL_ENTRY_CHAIN;
    if (!fw_mesh_model_kind(m->file)) return FW_MODEL_ENTRY_PATH;
    return FW_MODEL_ENTRY_OK;
}

int fw_model_names_load(FwMemRead rd, void *u, const void *root, FwModelNames *r) {
    if (!r) return -1;
    fw_model_names_clear(r);
    if (!root) { r->loaded = 1; return 0; }   /* the file is absent: nothing is named */
    const void *begin = NULL;
    long count = 0;
    int c = fw_gon_children(rd, u, root, &begin, &count);
    if (c < 0) { r->loaded = -1; return -1; }
    for (long i = 0; i < count; i++) {
        const unsigned char *child = (const unsigned char *)begin + i * GON_NODE_SIZE;
        char name[FW_MODEL_NAME_MAX + 1];
        if (fw_gon_node_name(rd, u, child, name, sizeof name) != 1) { fw_model_names_clear(r); r->loaded = -1; return -1; }
        FwGonModel m;
        int rc = fw_gon_model_node(rd, u, child, &m);
        if (rc < 0) { fw_model_names_clear(r); r->loaded = -1; return -1; }
        FwModelName *slot = NULL;
        for (int k = 0; k < r->n; k++) if (!strcmp(r->e[k].name, name)) { slot = &r->e[k]; break; }   /* the last definition wins */
        if (!slot) {
            if (r->n >= FW_MODEL_NAMES_MAX) { r->dropped++; continue; }
            slot = &r->e[r->n++];
        }
        memset(slot, 0, sizeof *slot);
        snprintf(slot->name, sizeof slot->name, "%s", name);
        slot->m = m;
        slot->bad = entry_verdict(rc, &m);
    }
    r->loaded = 1;
    return r->n;
}

const FwModelName *fw_model_names_find(const FwModelNames *r, const char *name) {
    if (!r || !name || !name[0]) return NULL;
    for (int k = 0; k < r->n; k++) if (!strcmp(r->e[k].name, name)) return &r->e[k];
    return NULL;
}

int fw_model_names_resolve(const FwModelNames *r, const FwGonModel *unit, FwGonModel *out, const FwModelName **hit) {
    if (hit) *hit = NULL;
    if (!unit || !out) return FW_MODEL_REF_UNKNOWN;
    *out = *unit;
    if (unit->file[0] != '@') return FW_MODEL_REF_NONE;
    const FwModelName *e = fw_model_names_find(r, unit->file + 1);
    if (!e) return FW_MODEL_REF_UNKNOWN;
    if (hit) *hit = e;
    if (e->bad != FW_MODEL_ENTRY_OK) return FW_MODEL_REF_BAD;
    FwGonModel m = e->m;   /* the entry, then the unit's own keys over it */
    if (unit->given & FW_GON_MODEL_HAS_SCALE) m.scale = unit->scale;
    if (unit->given & FW_GON_MODEL_HAS_YAW) m.yaw = unit->yaw;
    if (unit->given & FW_GON_MODEL_HAS_OFFSET) memcpy(m.offset, unit->offset, sizeof m.offset);
    if (unit->given & FW_GON_MODEL_HAS_TINT) memcpy(m.tint, unit->tint, sizeof m.tint);
    if (unit->texture[0]) snprintf(m.texture, sizeof m.texture, "%s", unit->texture);
    if (unit->palette >= 0) m.palette = unit->palette;
    if (unit->doubleSided >= 0) m.doubleSided = unit->doubleSided;
    if (unit->hideSprite >= 0) m.hideSprite = unit->hideSprite;   /* M3 hide_sprite, -1 = not given */
    m.isBlock = e->m.isBlock || unit->isBlock;
    m.invalid = e->m.invalid | unit->invalid;
    m.given = e->m.given | unit->given;
    *out = m;
    return FW_MODEL_REF_OK;
}

/* bounded appends into buf (always NUL-terminated); the running length, capped at n - 1 */
static size_t app(char *buf, size_t n, size_t at, const char *fmt, ...) {
    if (!buf || !n || at >= n - 1) return at;
    va_list ap;
    va_start(ap, fmt);
    int w = vsnprintf(buf + at, n - at, fmt, ap);
    va_end(ap);
    if (w < 0) return at;
    at += (size_t)w;
    return at >= n ? n - 1 : at;
}

#define FW_MN_TAIL " \xe2\x80\x94 drawing the 2D clip"

int fw_model_names_fmt_error(char *buf, size_t n, const char *ref, int rc, const char *unitEntry, const FwModelNames *r, const FwModelName *hit) {
    if (!buf || !n) return 0;
    buf[0] = 0;
    const char *rf = ref ? ref : "@";
    const char *nm = rf[0] == '@' ? rf + 1 : rf;
    size_t at = 0;
    if (rc == FW_MODEL_REF_BAD && hit) {
        at = app(buf, n, at, "mesh: %s: %s: %s entry %s", rf, fw_mesh_code(FW_MC_REGISTRY_ENTRY), FW_MODEL_REGISTRY_FILE, hit->name);
        switch (hit->bad) {
            case FW_MODEL_ENTRY_CHAIN: at = app(buf, n, at, " names another @Name (%s); an entry must name a models/<...>.obj|.gltf|.glb file", hit->m.file); break;
            case FW_MODEL_ENTRY_NO_FILE: at = app(buf, n, at, " is a block without a string file"); break;
            case FW_MODEL_ENTRY_PATH: at = app(buf, n, at, ": \"%s\" is not a models/<...>.obj|.gltf|.glb path", hit->m.file); break;
            default: at = app(buf, n, at, " is neither a model path nor a model block"); break;
        }
        if (unitEntry) at = app(buf, n, at, " (unit %s)", unitEntry);
    } else {
        at = app(buf, n, at, "mesh: %s: %s: no %s entry named %s", rf, fw_mesh_code(FW_MC_NAME_UNKNOWN), FW_MODEL_REGISTRY_FILE, nm);
        int named = r && r->loaded > 0 ? r->n : 0;
        if (unitEntry) at = app(buf, n, at, " (unit %s; %d named model%s)", unitEntry, named, named == 1 ? "" : "s");
        else at = app(buf, n, at, " (%d named model%s)", named, named == 1 ? "" : "s");
    }
    at = app(buf, n, at, "%s", FW_MN_TAIL);
    return (int)at;
}

int fw_model_names_fmt_loaded(char *buf, size_t n, const FwModelNames *r, int absent) {
    if (!buf || !n) return 0;
    buf[0] = 0;
    size_t at = app(buf, n, 0, "model names: %s: ", FW_MODEL_REGISTRY_FILE);
    if (!r || r->loaded < 0) return (int)app(buf, n, at, "unreadable");
    if (absent) return (int)app(buf, n, at, "absent (no mod on the mod path ships it; mods/fw-3d has the base)");
    at = app(buf, n, at, "%d entr%s", r->n, r->n == 1 ? "y" : "ies");
    for (int k = 0; k < r->n; k++) at = app(buf, n, at, "%s%s", k ? ", " : ": ", r->e[k].name);
    if (r->dropped) at = app(buf, n, at, " (%d dropped)", r->dropped);
    return (int)at;
}

int fw_model_names_log_first(FwModelNamesLogged *g, const char *ref) {
    if (!g || !ref) return 0;
    for (int k = 0; k < g->n; k++) if (!strcmp(g->ref[k], ref)) return 0;
    if (g->n >= FW_MODEL_NAMES_LOGGED_MAX) return 0;
    snprintf(g->ref[g->n++], sizeof g->ref[0], "%s", ref);
    return 1;
}
