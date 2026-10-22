/* fw_mesh_draw.c — the pure decisions of the M1 mesh path (fw_mesh_draw.h). Host-tested in test/test_mesh_draw.c. */
#include <stdio.h>
#include <string.h>
#include "fw_mesh_draw.h"
#include "offsets.h"

/* a plain non-negative decimal of at most 6 digits, the whole [s, e) range */
static int parse_uint(const char *s, const char *e, int *out) {
    if (s >= e || e - s > 6) return 0;
    int v = 0;
    for (const char *p = s; p < e; p++) {
        if (*p < '0' || *p > '9') return 0;
        v = v * 10 + (*p - '0');
    }
    *out = v;
    return 1;
}

int fw_mesh_probe_parse(const char *value, int *col, int *row) {
    if (!value || !*value) return 0;
    if (!strcmp(value, "1")) { *col = FW_MESH_PROBE_DEFAULT_COL; *row = FW_MESH_PROBE_DEFAULT_ROW; return 1; }
    const char *comma = strchr(value, ',');
    if (!comma) return 0;
    int c, r;
    if (!parse_uint(value, comma, &c) || !parse_uint(comma + 1, comma + 1 + strlen(comma + 1), &r)) return 0;
    *col = c; *row = r;
    return 1;
}

int fw_mesh_draw_after_layer(const void *tacticsTest, const void *cam, int layer) {
    if (!tacticsTest || !cam || layer != CONST_UNITS_LAYER) return 0;
    return *(void *const *)((const unsigned char *)tacticsTest + OFF_TT_MAIN_CAMERA) == cam;
}

const float *fw_mesh_stack_top(const void *const *stackData, const int *stackTop) {
    if (!stackData || !stackTop || !*stackData || *stackTop < 0) return NULL;
    return (const float *)*stackData + (size_t)*stackTop * 16;
}

int fw_mesh_fmt_probe(char *buf, size_t n, int frame, int col, int row, const float ndc[3], const double canvas[2]) {
    int k = snprintf(buf, n, "mesh probe f=%d tile=(%d,%d) ndc=(%.3g %.3g %.3g) canvas=(%.2f %.2f)", frame, col, row,
                     (double)ndc[0], (double)ndc[1], (double)ndc[2], canvas[0], canvas[1]);
    if (k < 0) { if (n) buf[0] = 0; return 0; }
    return (size_t)k < n ? k : (int)(n ? n - 1 : 0);
}

/* ---- M2/M3: models, the mod-shipped shader, per-object matrices ---- */
#include "fw_m4.h"

/* append n bytes; 0 when it would not fit with the NUL */
static int put(char *out, size_t cap, size_t *w, const char *s, size_t n) {
    if (*w + n + 1 > cap) return 0;
    memcpy(out + *w, s, n);
    *w += n;
    return 1;
}

static const char *find_in(const char *s, size_t len, const char *needle) {
    size_t n = strlen(needle);
    if (n > len) return NULL;
    for (size_t i = 0; i + n <= len; i++) if (!memcmp(s + i, needle, n)) return s + i;
    return NULL;
}

int fw_shader_stage(const char *src, size_t len, int vertex, char *out, size_t cap) {
    if (!src || !out || !cap) return -1;
    for (size_t i = 0; i < len; i++) {   /* an #include DIRECTIVE (a line starting with it), not the word in a comment */
        if (i && src[i - 1] != '\n') continue;
        size_t k = i;
        while (k < len && (src[k] == ' ' || src[k] == '\t')) k++;
        if (k + 8 <= len && !memcmp(src + k, "#include", 8)) return -1;
    }
    const char *entry = find_in(src, len, vertex ? " vert()" : " frag()");
    if (!entry) return -1;
    static const struct { const char *from; int vertexValue; int fragmentValue; } toks[] = {
        { "COMPILING_VERTEX_PROGRAM", 1, 0 }, { "COMPILING_FRAGMENT_PROGRAM", 0, 1 }, { "MATRICES_AS_ATTRIBS", 1, 1 },
    };
    size_t w = 0;
    for (size_t i = 0; i < len;) {
        if (src + i == entry) {
            if (!put(out, cap, &w, " main()", 7)) return -1;
            i += 7;
            continue;
        }
        int done = 0;
        for (size_t t = 0; t < sizeof toks / sizeof toks[0] && !done; t++) {
            size_t n = strlen(toks[t].from);
            if (i + n <= len && !memcmp(src + i, toks[t].from, n)) {
                const char *v = (vertex ? toks[t].vertexValue : toks[t].fragmentValue) ? "1" : "0";
                if (!put(out, cap, &w, v, 1)) return -1;
                i += n;
                done = 1;
            }
        }
        if (done) continue;
        if (!put(out, cap, &w, src + i, 1)) return -1;
        i++;
    }
    out[w] = 0;
    return (int)w;
}

static int ends_with(const char *s, const char *suf) {
    size_t n = strlen(s), k = strlen(suf);
    return n >= k && strcmp(s + n - k, suf) == 0;
}

/* how far under the floor (game height, model units) a model may reach before model-below-floor: the M1 log's 0.01 */
#define FW_MESH_FLOOR_TOLERANCE 0.01f

int fw_mesh_load_bytes(const char *path, const uint8_t *bytes, size_t len, FwMesh *out, FwMeshError *err) {
    memset(out, 0, sizeof *out);
    fw_mesh_err_reset(err);
    int kind = fw_mesh_model_kind(path);
    int ok;
    if (kind == FW_MESH_KIND_OBJ) ok = fw_mesh_obj_parse((const char *)bytes, len, out, err);
    else if (kind == FW_MESH_KIND_GLB && !(len >= 4 && bytes && memcmp(bytes, "glTF", 4) == 0)) {
        /* a .glb must be the binary container; the parser alone would read it as JSON text and say "not valid JSON" */
        if (err) { snprintf(err->text, sizeof err->text, "not a GLB file (no glTF magic in its first 4 bytes)"); err->code = fw_mesh_code(FW_MC_GLB_HEADER); }
        return 0;
    }
    else if (kind == FW_MESH_KIND_GLTF || kind == FW_MESH_KIND_GLB) ok = fw_mesh_gltf_parse(bytes, len, NULL, NULL, out, err);
    else {
        const char *p = path ? path : "(null)";
        int known = path && (ends_with(path, ".obj") || ends_with(path, ".gltf") || ends_with(path, ".glb"));
        if (err) {
            snprintf(err->text, sizeof err->text, known ? "not a models/<name>.obj|.gltf|.glb path: %s" : "not a .obj, .gltf or .glb file: %s", p);
            err->line = 0;
            err->code = fw_mesh_code(known ? FW_MC_PATH_INVALID : FW_MC_EXTENSION);
        }
        return 0;
    }
    if (!ok) return 0;
    fw_mesh_to_game_axes(out, 1.0f);
    /* what the engine filled in or the modder may not expect (design §2.6) */
    if (!out->has_normals) fw_mesh_warn(err, FW_MC_NO_NORMALS);
    if (out->bmin[1] < -FW_MESH_FLOOR_TOLERANCE) fw_mesh_warn(err, FW_MC_BELOW_FLOOR);
    if (out->texture[0] && !out->has_uvs) fw_mesh_warn(err, FW_MC_TEXTURE_NO_UVS);
    if (strncmp(out->texture, "embedded:", 9) == 0) fw_mesh_warn(err, FW_MC_TEXTURE_EMBEDDED);
    return 1;
}

void fw_mesh_object_mvp(const float top[16], const float vp[16], const float iso[16], const float world[16], float out[16]) {
    float tv[16], basis[16], bw[16];
    fw_m4_mul(top, vp, tv);
    fw_m4_iso_basis(iso, basis);
    fw_m4_mul(basis, world, bw);
    fw_m4_mul(tv, bw, out);
}

int fw_mesh_fmt_load_result(char *buf, size_t n, const char *path, int ok, const FwMesh *m, const FwMeshError *e) {
    char tmp[512];
    int w;
    const char *p = path ? path : "(null)";
    if (ok && m) {
        w = snprintf(tmp, sizeof tmp, "mesh: %s: loaded %u vertices, %u triangles, bounds x %.2f..%.2f h %.2f..%.2f z %.2f..%.2f", p,
                     m->nverts, m->nindices / 3, (double)m->bmin[0], (double)m->bmax[0], (double)m->bmin[1], (double)m->bmax[1],
                     (double)m->bmin[2], (double)m->bmax[2]);
        for (int i = 0; e && i < e->nwarnings && i < FW_MESH_MAX_WARNINGS && w > 0 && (size_t)w < sizeof tmp; i++)
            w += snprintf(tmp + w, sizeof tmp - (size_t)w, "%s%s", i ? ", " : "; ", e->warnings[i] ? e->warnings[i] : "?");
    } else {
        const char *code = e && e->code ? e->code : fw_mesh_code(FW_MC_PARSE_ERROR);
        w = snprintf(tmp, sizeof tmp, "mesh: %s: %s: %s — drawing the 2D clip", p, code, e && e->text[0] ? e->text : "not loaded");
    }
    if (w < 0) w = 0;
    if ((size_t)w >= sizeof tmp) w = (int)sizeof tmp - 1;
    if (buf && n) snprintf(buf, n, "%s", tmp);
    return w;
}
