/* fw_mesh_tex.c — the pure texture / palette rules of the mesh path (fw_mesh_tex.h). Host-tested in
 * test/test_mesh_tex.c. */
#include <stdio.h>
#include <string.h>
#include "fw_mesh_tex.h"
#include "fw_mesh_rules.h"
#include "offsets.h"

int fw_tex_name_ok(const char *name) {
    if (!name) return 0;
    size_t n = strlen(name);
    if (n < 5 || n > FW_TEX_NAME_MAX || strcmp(name + n - 4, ".png") != 0) return 0;
    for (size_t i = 0; i < n; i++) {
        char c = name[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.' || c == '/')) return 0;
    }
    const char *seg = name;
    for (;;) {
        const char *slash = strchr(seg, '/');
        size_t len = slash ? (size_t)(slash - seg) : strlen(seg);
        if (len == 0 || (len == 1 && seg[0] == '.') || (len == 2 && seg[0] == '.' && seg[1] == '.')) return 0;
        if (!slash) return len > 4;   /* a stem before ".png" */
        seg = slash + 1;
    }
}

int fw_tex_default_name(const char *modelPath, char *out, size_t cap) {
    if (out && cap) out[0] = 0;
    char stem[FW_MESH_NAME_MAX + 1];
    if (!out || !fw_mesh_name_from_path(modelPath, stem, sizeof stem)) return 0;
    int k = snprintf(out, cap, "models/%s.png", stem);
    if (k < 0 || (size_t)k >= cap || !fw_tex_name_ok(out)) { if (cap) out[0] = 0; return 0; }
    return 1;
}

int fw_tex_choose(const char *explicitName, const char *modelPath, int materialNamedImage, FwTexChoice *out) {
    memset(out, 0, sizeof *out);
    if (explicitName && explicitName[0]) {
        if (!fw_tex_name_ok(explicitName)) return 0;
        snprintf(out->name, sizeof out->name, "%s", explicitName);
        out->named = out->explicitName = 1;
    } else {
        if (!fw_tex_default_name(modelPath, out->name, sizeof out->name)) return 0;
        out->named = materialNamedImage ? 1 : 0;
    }
    snprintf(out->path, sizeof out->path, "%s%s", FW_TEX_PREFIX, out->name);
    return 1;
}

static uint32_t be32(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }

int fw_png_check(const uint8_t *b, size_t len, int *w, int *h, char *why, size_t cap) {
    static const uint8_t sig[8] = { 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n' };
    if (why && cap) why[0] = 0;
    if (!b || len < 33 || memcmp(b, sig, 8) != 0 || be32(b + 8) != 13 || memcmp(b + 12, "IHDR", 4) != 0) {
        if (why && cap) snprintf(why, cap, "not a PNG (signature / IHDR)");
        return FW_PNG_NOT_PNG;
    }
    uint32_t pw = be32(b + 16), ph = be32(b + 20);
    if (w) *w = (int)(pw > 0x7fffffffu ? 0x7fffffff : pw);
    if (h) *h = (int)(ph > 0x7fffffffu ? 0x7fffffff : ph);
    if (b[25] != 2 && b[25] != 6) {
        if (why && cap) snprintf(why, cap, "colour type %u (only 2 RGB / 6 RGBA: grey PNGs upload as GL_LUMINANCE, invalid in a core context)", b[25]);
        return FW_PNG_FORMAT;
    }
    if (b[24] != 8) {
        if (why && cap) snprintf(why, cap, "bit depth %u (only 8)", b[24]);
        return FW_PNG_FORMAT;
    }
    if (pw == 0 || ph == 0 || pw > FW_TEX_MAX_DIM || ph > FW_TEX_MAX_DIM) {
        if (why && cap) snprintf(why, cap, "size %ux%u (1..%d per side)", pw, ph, FW_TEX_MAX_DIM);
        return FW_PNG_SIZE;
    }
    return FW_PNG_OK;
}

int fw_palette_row(int requested, int paletteHeight) {
    if (requested < 0 || paletteHeight <= 0 || requested >= paletteHeight) return -1;
    return requested;
}

FwTexEntry *fw_tex_cache_get(FwTexCache *c, const char *name, int create) {
    if (!c || !name || !name[0] || strlen(name) > FW_TEX_NAME_MAX) return NULL;
    for (int i = 0; i < c->count; i++) if (!strcmp(c->e[i].name, name)) return &c->e[i];
    if (!create || c->count >= FW_TEX_CACHE_MAX) return NULL;
    FwTexEntry *e = &c->e[c->count++];
    memset(e, 0, sizeof *e);
    snprintf(e->name, sizeof e->name, "%s", name);
    e->state = FW_TEX_UNKNOWN;
    return e;
}

uint32_t fw_tex_gl_name(const void *texture2d) {
    if (!texture2d) return 0;
    uint32_t id;
    memcpy(&id, (const uint8_t *)texture2d + OFF_TEX2D_GLNAME, sizeof id);
    return id;
}

void fw_mesh_material_plan(uint32_t texName, uint32_t paletteName, int paletteRow, FwMeshMaterialPlan *out) {
    memset(out, 0, sizeof *out);
    out->hasTex = texName != 0;
    out->units[FW_MESH_TEX_UNIT] = texName;
    out->palette = (paletteRow >= 0 && paletteName) ? paletteRow : -1;
    out->units[FW_MESH_PALETTE_UNIT] = out->palette >= 0 ? paletteName : 0;
}

int fw_mesh_fmt_object(char *buf, size_t n, int frame, int handle, const char *model, int byTile, const float world[3],
                       const float ndc[3], const char *tex, int palette) {
    int k = snprintf(buf, n, "mesh object f=%d handle=%d model=%s %s world=(%.2f %.2f %.2f) ndc=(%.3g %.3g %.3g) tex=%s palette=%d",
                     frame, handle, model ? model : "(null)", byTile ? "tile" : "unit", (double)world[0], (double)world[1], (double)world[2],
                     (double)ndc[0], (double)ndc[1], (double)ndc[2], tex && tex[0] ? tex : "none", palette);
    if (k < 0) { if (n) buf[0] = 0; return 0; }
    return (size_t)k < n ? k : (int)(n ? n - 1 : 0);
}
