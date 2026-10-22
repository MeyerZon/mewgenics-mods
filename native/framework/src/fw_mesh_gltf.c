/* fw_mesh_gltf.c — the glTF 2.0 loader declared in fw_mesh_rules.h (.gltf / .glb, data: URIs, external buffers via a
 * read callback, the default scene's node tree baked into one FwMesh). Pure C11 on fw_json.c; every read from a buffer
 * is bounds-checked when its accessor / bufferView is resolved; little-endian decoding is explicit (no host-order
 * assumption). Host-tested by test/test_mesh_gltf.c. */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "fw_mesh_rules.h"
#include "fw_json.h"

typedef struct GBuf { uint8_t *data; size_t len; int loaded, owned; } GBuf;
typedef struct Acc { const uint8_t *p; size_t stride, csize; uint32_t count; int ctype, ncomp, normalized; } Acc;

typedef struct G {
    const char *js; FwJsonTok *t;
    const uint8_t *bin; size_t binLen;
    FwMeshReadFn read; void *user;
    GBuf *bufs; int nbufs;
    unsigned char *seen; int nnodes;
    int aBuffers, aViews, aAccessors, aMeshes, aNodes, aMaterials, aTextures, aImages;
    FwMesh out; uint32_t cverts, cidx;
    int haveMaterial, firstMaterial, allNormals, anyUv;
    FwMeshError *err;
} G;

static int gerr(G *g, FwMeshCodeId code, const char *fmt, ...) {
    if (g->err && !g->err->text[0]) {
        g->err->code = fw_mesh_code(code);
        va_list ap; va_start(ap, fmt);
        vsnprintf(g->err->text, sizeof g->err->text, fmt, ap);
        va_end(ap);
        g->err->line = 0;
    }
    return 0;
}

/* ---------------------------------------------------------------- JSON helpers */
static int find(G *g, int obj, const char *key) { return fw_json_find(g->js, g->t, obj, key); }
static int elem(G *g, int arr, int i) { return fw_json_index(g->t, arr, i); }
static int is_type(G *g, int tok, int type) { return tok >= 0 && g->t[tok].type == type; }
static int arr_len(G *g, int arr) { return is_type(g, arr, FW_JSON_ARRAY) ? g->t[arr].size : 0; }

/* the code of a malformed member, by the object it sits in */
static FwMeshCodeId member_code(const char *what, const char *key) {
    if (!strcmp(what, "buffer")) return FW_MC_BUFFER_RANGE;
    if (!strcmp(key, "mode")) return FW_MC_PRIMITIVE_MODE;
    if (!strcmp(what, "bufferView") || !strcmp(what, "accessor") || !strcmp(what, "primitive of mesh")) return FW_MC_ACCESSOR_INVALID;
    return FW_MC_NODE_INVALID;   /* node / material / texture / image / the scene index: a malformed or dangling entry */
}
/* integer member: 1 = ok (*out = value or def when absent and !required), 0 = error set */
static int get_int(G *g, int obj, const char *key, long long def, int required, long long *out, const char *what, int idx) {
    int v = find(g, obj, key);
    if (v < 0) {
        if (required) return gerr(g, member_code(what, key), "%s %d: missing '%s'", what, idx, key);
        *out = def;
        return 1;
    }
    if (!fw_json_int(g->js, g->t, v, out)) return gerr(g, member_code(what, key), "%s %d: '%s' must be an integer", what, idx, key);
    return 1;
}
static int get_nums(G *g, int obj, const char *key, float *out, int n, const char *what, int idx) {
    int a = find(g, obj, key);
    if (a < 0) return 1;
    if (arr_len(g, a) != n) return gerr(g, member_code(what, key), "%s %d: %s needs %d numbers", what, idx, key, n);
    for (int i = 0; i < n; i++) {
        double d;
        if (!fw_json_num(g->js, g->t, elem(g, a, i), &d) || !isfinite(d)) return gerr(g, member_code(what, key), "%s %d: %s needs %d numbers", what, idx, key, n);
        out[i] = (float)d;
    }
    return 2;   /* present */
}
/* unescaped copy of a string token (malloc'd), NULL on error */
static char *str_dup(G *g, int tok) {
    if (!is_type(g, tok, FW_JSON_STRING)) return NULL;
    size_t cap = (size_t)(g->t[tok].end - g->t[tok].start) + 1;
    char *s = (char *)malloc(cap);
    if (!s) return NULL;
    if (fw_json_str_copy(g->js, g->t, tok, s, cap) < 0) { free(s); return NULL; }
    return s;
}

/* ---------------------------------------------------------------- uris */
static int hexv(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; }
/* percent-decodes in place; 0 on a bad escape or a %00 */
static int pct_decode(char *s) {
    char *w = s;
    for (const char *r = s; *r; r++) {
        if (*r != '%') { *w++ = *r; continue; }
        int h = hexv(r[1]), l = h >= 0 ? hexv(r[2]) : -1;
        if (h < 0 || l < 0 || (h == 0 && l == 0)) return 0;
        *w++ = (char)(h * 16 + l);
        r += 2;
    }
    *w = 0;
    return 1;
}
/* a mod-relative side file: not empty, not absolute, no '\', no ':' (drives, schemes), no ".." */
static int safe_rel(const char *s) {
    return s[0] && s[0] != '/' && !strchr(s, '\\') && !strchr(s, ':') && !strstr(s, "..");
}
static int b64v(char c) {
    return c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52
         : c == '+' ? 62 : c == '/' ? 63 : -1;
}
/* base64 (padding optional) -> malloc'd bytes; NULL on a bad character */
static uint8_t *b64_decode(const char *s, size_t n, size_t *outLen) {
    while (n && s[n - 1] == '=') n--;
    if (n % 4 == 1) return NULL;
    uint8_t *o = (uint8_t *)malloc(n * 3 / 4 + 3);
    if (!o) return NULL;
    size_t w = 0;
    uint32_t acc = 0; int bits = 0;
    for (size_t i = 0; i < n; i++) {
        int v = b64v(s[i]);
        if (v < 0) { free(o); return NULL; }
        acc = acc << 6 | (uint32_t)v; bits += 6;
        if (bits >= 8) { bits -= 8; o[w++] = (uint8_t)(acc >> bits); }
    }
    *outLen = w;
    return o;
}

/* ---------------------------------------------------------------- buffers / views / accessors */
static GBuf *buffer(G *g, int bi, size_t *byteLength) {
    int b = elem(g, g->aBuffers, bi);
    if (!is_type(g, b, FW_JSON_OBJECT)) { gerr(g, FW_MC_BUFFER_MISSING, "buffer %d does not exist", bi); return NULL; }
    long long bl = 0;
    if (!get_int(g, b, "byteLength", 0, 1, &bl, "buffer", bi)) return NULL;
    if (bl < 0) { gerr(g, FW_MC_BUFFER_RANGE, "buffer %d: bad byteLength", bi); return NULL; }
    *byteLength = (size_t)bl;
    GBuf *gb = &g->bufs[bi];
    if (gb->loaded) return gb;
    int u = find(g, b, "uri");
    char name[96] = "BIN chunk";
    if (u < 0) {
        if (bi != 0 || !g->bin) { gerr(g, FW_MC_BUFFER_MISSING, "buffer %d has no uri and there is no .glb BIN chunk", bi); return NULL; }
        gb->data = (uint8_t *)g->bin; gb->len = g->binLen; gb->owned = 0;
    } else {
        char *uri = str_dup(g, u);
        if (!uri) { gerr(g, FW_MC_URI_UNSUPPORTED, "buffer %d: uri must be a string", bi); return NULL; }
        if (strncmp(uri, "data:", 5) == 0) {
            char *comma = strchr(uri, ',');
            if (!comma || comma - uri < 12 || strncmp(comma - 7, ";base64", 7) != 0) { free(uri); gerr(g, FW_MC_URI_UNSUPPORTED, "buffer %d: data URI is not base64", bi); return NULL; }
            gb->data = b64_decode(comma + 1, strlen(comma + 1), &gb->len);
            free(uri);
            if (!gb->data) { gerr(g, FW_MC_PARSE_ERROR, "buffer %d: bad base64 in its data URI", bi); return NULL; }
            gb->owned = 1;
            snprintf(name, sizeof name, "data URI");
        } else {
            if (!pct_decode(uri) || !safe_rel(uri)) { gerr(g, FW_MC_URI_UNSUPPORTED, "buffer %d: uri '%.60s' is not a safe relative path", bi, uri); free(uri); return NULL; }
            if (!g->read) { gerr(g, FW_MC_BUFFER_MISSING, "buffer %d: no reader for %.80s", bi, uri); free(uri); return NULL; }
            size_t len = 0;
            gb->data = (uint8_t *)g->read(g->user, uri, &len);
            if (!gb->data) { gerr(g, FW_MC_BUFFER_MISSING, "buffer %d: %.80s not found", bi, uri); free(uri); return NULL; }
            gb->len = len; gb->owned = 1;
            snprintf(name, sizeof name, "%.80s", uri);
            free(uri);
        }
    }
    gb->loaded = 1;
    if (gb->len < *byteLength) {
        gerr(g, FW_MC_BUFFER_RANGE, "buffer %d (%s) is %zu bytes, shorter than its byteLength %zu", bi, name, gb->len, *byteLength);
        return NULL;
    }
    return gb;
}

static int view(G *g, int vi, const uint8_t **base, size_t *len, size_t *stride) {
    int v = elem(g, g->aViews, vi);
    if (!is_type(g, v, FW_JSON_OBJECT)) return gerr(g, FW_MC_ACCESSOR_INVALID, "bufferView %d does not exist", vi);
    long long b = 0, off = 0, bl = 0, st = 0;
    if (!get_int(g, v, "buffer", 0, 1, &b, "bufferView", vi) || !get_int(g, v, "byteOffset", 0, 0, &off, "bufferView", vi) ||
        !get_int(g, v, "byteLength", 0, 1, &bl, "bufferView", vi) || !get_int(g, v, "byteStride", 0, 0, &st, "bufferView", vi)) return 0;
    if (b < 0 || b >= g->nbufs) return gerr(g, FW_MC_BUFFER_MISSING, "bufferView %d: buffer %lld does not exist", vi, b);
    if (off < 0 || bl < 0) return gerr(g, FW_MC_BUFFER_RANGE, "bufferView %d: negative offset or length", vi);
    if (st != 0 && (st < 4 || st > 252 || st % 4)) return gerr(g, FW_MC_ACCESSOR_INVALID, "bufferView %d: byteStride %lld is not 4..252 and a multiple of 4", vi, st);
    size_t blen;
    GBuf *gb = buffer(g, (int)b, &blen);
    if (!gb) return 0;
    if ((unsigned long long)off + (unsigned long long)bl > blen)
        return gerr(g, FW_MC_BUFFER_RANGE, "bufferView %d (offset %lld + length %lld) is outside buffer %lld (%zu bytes)", vi, off, bl, b, blen);
    *base = gb->data + off; *len = (size_t)bl; *stride = (size_t)st;
    return 1;
}

static int accessor(G *g, int ai, Acc *a) {
    int t = elem(g, g->aAccessors, ai);
    if (!is_type(g, t, FW_JSON_OBJECT)) return gerr(g, FW_MC_ACCESSOR_INVALID, "accessor %d does not exist", ai);
    if (find(g, t, "sparse") >= 0) return gerr(g, FW_MC_SPARSE_UNSUPPORTED, "accessor %d: sparse accessors are not supported", ai);
    if (find(g, t, "bufferView") < 0) return gerr(g, FW_MC_ACCESSOR_INVALID, "accessor %d has no bufferView (not supported)", ai);
    long long bv = 0, off = 0, ct = 0, cnt = 0;
    if (!get_int(g, t, "bufferView", 0, 1, &bv, "accessor", ai) || !get_int(g, t, "byteOffset", 0, 0, &off, "accessor", ai) ||
        !get_int(g, t, "componentType", 0, 1, &ct, "accessor", ai) || !get_int(g, t, "count", 0, 1, &cnt, "accessor", ai)) return 0;
    if (off < 0 || cnt < 0) return gerr(g, FW_MC_ACCESSOR_INVALID, "accessor %d: negative offset or count", ai);
    if (cnt > (long long)FW_MESH_MAX_INDICES) return gerr(g, FW_MC_LIMIT, "accessor %d: count %lld is over the limit", ai, cnt);
    int tt = find(g, t, "type");
    static const char *const types[] = { "SCALAR", "VEC2", "VEC3", "VEC4", "MAT2", "MAT3", "MAT4" };
    static const int ncomps[] = { 1, 2, 3, 4, 4, 9, 16 };
    a->ncomp = 0;
    for (int i = 0; i < 7; i++) if (fw_json_str_eq(g->js, g->t, tt, types[i])) a->ncomp = ncomps[i];
    if (!a->ncomp) return gerr(g, FW_MC_ACCESSOR_INVALID, "accessor %d: bad type", ai);
    switch (ct) {
    case 5120: case 5121: a->csize = 1; break;
    case 5122: case 5123: a->csize = 2; break;
    case 5125: case 5126: a->csize = 4; break;
    default: return gerr(g, FW_MC_ACCESSOR_INVALID, "accessor %d: bad componentType %lld", ai, ct);
    }
    a->ctype = (int)ct; a->count = (uint32_t)cnt;
    a->normalized = is_type(g, find(g, t, "normalized"), FW_JSON_TRUE);
    const uint8_t *base = NULL; size_t vlen = 0, vstride = 0;
    if (!view(g, (int)bv, &base, &vlen, &vstride)) return 0;
    size_t esize = a->csize * (size_t)a->ncomp;
    a->stride = vstride ? vstride : esize;
    if (cnt > 0 && (unsigned long long)off + (unsigned long long)a->stride * (unsigned long long)(cnt - 1) + esize > vlen)
        return gerr(g, FW_MC_BUFFER_RANGE, "accessor %d (offset %lld, count %lld, stride %zu) is outside bufferView %lld (%zu bytes)", ai, off, cnt, a->stride, bv, vlen);
    a->p = base + off;
    return 1;
}

static uint32_t rd_u(const uint8_t *p, size_t n) {
    uint32_t v = 0;
    for (size_t i = n; i-- > 0;) v = v << 8 | p[i];
    return v;
}
static float rd_comp(const Acc *a, uint32_t i, int c) {
    const uint8_t *p = a->p + (size_t)i * a->stride + (size_t)c * a->csize;
    uint32_t u = rd_u(p, a->csize);
    switch (a->ctype) {
    case 5126: { float f; memcpy(&f, &u, 4); return f; }
    case 5121: return a->normalized ? (float)u / 255.0f : (float)u;
    case 5123: return a->normalized ? (float)u / 65535.0f : (float)u;
    case 5125: return (float)u;
    case 5120: { float f = (float)(int8_t)u; return a->normalized ? fmaxf(f / 127.0f, -1.0f) : f; }
    default: { float f = (float)(int16_t)u; return a->normalized ? fmaxf(f / 32767.0f, -1.0f) : f; }
    }
}

/* ---------------------------------------------------------------- matrices (column-major 4x4) */
static void mat_identity(float m[16]) { memset(m, 0, 16 * sizeof *m); m[0] = m[5] = m[10] = m[15] = 1.0f; }
static void mat_mul(const float a[16], const float b[16], float o[16]) {
    float r[16];
    for (int c = 0; c < 4; c++)
        for (int rr = 0; rr < 4; rr++) {
            float s = 0;
            for (int k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k];
            r[c * 4 + rr] = s;
        }
    memcpy(o, r, sizeof r);
}

static int node_local(G *g, int node, int ni, float m[16]) {
    float mat[16];
    int r = get_nums(g, node, "matrix", mat, 16, "node", ni);
    if (!r) return 0;
    if (r == 2) { memcpy(m, mat, sizeof mat); return 1; }
    float t[3] = { 0, 0, 0 }, q[4] = { 0, 0, 0, 1 }, s[3] = { 1, 1, 1 };
    if (!get_nums(g, node, "translation", t, 3, "node", ni) || !get_nums(g, node, "rotation", q, 4, "node", ni) ||
        !get_nums(g, node, "scale", s, 3, "node", ni)) return 0;
    float l = sqrtf(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (l > 1e-12f) for (int i = 0; i < 4; i++) q[i] /= l; else { q[0] = q[1] = q[2] = 0; q[3] = 1; }
    float x = q[0], y = q[1], z = q[2], w = q[3];
    float R[9] = { /* column-major 3x3 */
        1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y) };
    mat_identity(m);
    for (int c = 0; c < 3; c++) for (int rr = 0; rr < 3; rr++) m[c * 4 + rr] = R[c * 3 + rr] * s[c];
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
    return 1;
}

/* ---------------------------------------------------------------- materials */
static int material(G *g, int mi) {
    int m = elem(g, g->aMaterials, mi);
    if (!is_type(g, m, FW_JSON_OBJECT)) return gerr(g, FW_MC_NODE_INVALID, "material %d does not exist", mi);
    if (g->haveMaterial) { if (mi != g->firstMaterial) fw_mesh_warn(g->err, FW_MC_MULTI_MATERIAL); return 1; }   /* v1: one material */
    g->haveMaterial = 1; g->firstMaterial = mi;
    int pbr = find(g, m, "pbrMetallicRoughness");
    if (!is_type(g, pbr, FW_JSON_OBJECT)) return 1;
    if (!get_nums(g, pbr, "baseColorFactor", g->out.base_color, 4, "material", mi)) return 0;
    int bct = find(g, pbr, "baseColorTexture");
    if (bct < 0) return 1;
    long long ti = 0, si = 0;
    if (!get_int(g, bct, "index", 0, 1, &ti, "material", mi)) return 0;
    int tx = elem(g, g->aTextures, (int)ti);
    if (ti < 0 || !is_type(g, tx, FW_JSON_OBJECT)) return gerr(g, FW_MC_NODE_INVALID, "material %d: texture %lld does not exist", mi, ti);
    if (find(g, tx, "source") < 0)
        return gerr(g, FW_MC_NODE_INVALID, "texture %lld has no source image (KHR_texture_basisu / EXT_texture_webp are not supported)", ti);
    if (!get_int(g, tx, "source", 0, 1, &si, "texture", (int)ti)) return 0;
    int im = elem(g, g->aImages, (int)si);
    if (si < 0 || !is_type(g, im, FW_JSON_OBJECT)) return gerr(g, FW_MC_NODE_INVALID, "texture %lld: image %lld does not exist", ti, si);
    int u = find(g, im, "uri");
    if (u >= 0) {
        char *uri = str_dup(g, u);
        if (!uri) return gerr(g, FW_MC_URI_UNSUPPORTED, "image %lld: uri must be a string", si);
        if (strncmp(uri, "data:", 5) == 0) { snprintf(g->out.texture, sizeof g->out.texture, "embedded:data-uri"); free(uri); return 1; }
        if (!pct_decode(uri) || !safe_rel(uri) || strlen(uri) >= sizeof g->out.texture) {
            gerr(g, FW_MC_URI_UNSUPPORTED, "image %lld: uri '%.60s' is not a safe relative path", si, uri);
            free(uri);
            return 0;
        }
        memcpy(g->out.texture, uri, strlen(uri) + 1);
        free(uri);
        return 1;
    }
    long long bv = 0;
    if (find(g, im, "bufferView") < 0) return gerr(g, FW_MC_NODE_INVALID, "image %lld has neither uri nor bufferView", si);
    if (!get_int(g, im, "bufferView", 0, 1, &bv, "image", (int)si)) return 0;
    snprintf(g->out.texture, sizeof g->out.texture, "embedded:%lld", bv);
    return 1;
}

/* ---------------------------------------------------------------- primitives */
static int append(G *g, const FwMesh *tmp) {
    if ((uint64_t)g->out.nverts + tmp->nverts > FW_MESH_MAX_VERTS) return gerr(g, FW_MC_LIMIT, "more than %u vertices (limit)", FW_MESH_MAX_VERTS);
    if ((uint64_t)g->out.nindices + tmp->nindices > FW_MESH_MAX_INDICES) return gerr(g, FW_MC_LIMIT, "more than %u indices (limit)", FW_MESH_MAX_INDICES);
    uint32_t nv = g->out.nverts + tmp->nverts, ni = g->out.nindices + tmp->nindices;
    if (nv > g->cverts) {
        uint32_t c = g->cverts ? g->cverts : 256;
        while (c < nv) c *= 2;
        void *p = realloc(g->out.verts, (size_t)c * sizeof *g->out.verts);
        if (!p) return gerr(g, FW_MC_LIMIT, "out of memory");
        g->out.verts = (FwMeshVertex *)p; g->cverts = c;
    }
    if (ni > g->cidx) {
        uint32_t c = g->cidx ? g->cidx : 256;
        while (c < ni) c *= 2;
        void *p = realloc(g->out.indices, (size_t)c * sizeof *g->out.indices);
        if (!p) return gerr(g, FW_MC_LIMIT, "out of memory");
        g->out.indices = (uint32_t *)p; g->cidx = c;
    }
    memcpy(g->out.verts + g->out.nverts, tmp->verts, (size_t)tmp->nverts * sizeof *tmp->verts);
    for (uint32_t i = 0; i < tmp->nindices; i++) g->out.indices[g->out.nindices + i] = tmp->indices[i] + g->out.nverts;
    g->out.nverts = nv; g->out.nindices = ni;
    return 1;
}

static int primitive(G *g, int pt, int mi, int pi, const float M[16]) {
    long long mode = 4, idxA = -1, mat = -1;
    if (!get_int(g, pt, "mode", 4, 0, &mode, "primitive of mesh", mi)) return 0;
    if (mode != 4) return gerr(g, FW_MC_PRIMITIVE_MODE, "mesh %d primitive %d: mode %lld is not TRIANGLES (4)", mi, pi, mode);
    if (find(g, pt, "targets") >= 0) fw_mesh_warn(g->err, FW_MC_MORPH_IGNORED);   /* v1: the base mesh is drawn */
    int attrs = find(g, pt, "attributes");
    if (!is_type(g, attrs, FW_JSON_OBJECT) || find(g, attrs, "POSITION") < 0) return gerr(g, FW_MC_ATTRIBUTE_MISSING, "mesh %d primitive %d has no POSITION", mi, pi);
    long long ap = 0, an = -1, at = -1;
    if (!get_int(g, attrs, "POSITION", 0, 1, &ap, "primitive of mesh", mi) ||
        !get_int(g, attrs, "NORMAL", -1, 0, &an, "primitive of mesh", mi) ||
        !get_int(g, attrs, "TEXCOORD_0", -1, 0, &at, "primitive of mesh", mi) ||
        !get_int(g, pt, "indices", -1, 0, &idxA, "primitive of mesh", mi) ||
        !get_int(g, pt, "material", -1, 0, &mat, "primitive of mesh", mi)) return 0;
    Acc P, N, T, I;
    memset(&P, 0, sizeof P); memset(&N, 0, sizeof N); memset(&T, 0, sizeof T); memset(&I, 0, sizeof I);
    if (!accessor(g, (int)ap, &P)) return 0;
    if (P.ncomp != 3 || P.ctype != 5126) return gerr(g, FW_MC_ATTRIBUTE_FORMAT, "mesh %d primitive %d: POSITION accessor %lld must be VEC3 float", mi, pi, ap);
    if (an >= 0) {
        if (!accessor(g, (int)an, &N)) return 0;
        if (N.ncomp != 3 || N.ctype != 5126 || N.count != P.count)
            return gerr(g, FW_MC_ATTRIBUTE_FORMAT, "mesh %d primitive %d: NORMAL accessor %lld must be VEC3 float with POSITION's count", mi, pi, an);
    }
    if (at >= 0) {
        if (!accessor(g, (int)at, &T)) return 0;
        int intType = T.ctype == 5121 || T.ctype == 5123;
        if (T.ncomp != 2 || !(T.ctype == 5126 || intType) || T.count != P.count)
            return gerr(g, FW_MC_ATTRIBUTE_FORMAT, "mesh %d primitive %d: TEXCOORD_0 accessor %lld must be VEC2 float or normalized unsigned byte/short with POSITION's count", mi, pi, at);
        if (intType && !T.normalized) return gerr(g, FW_MC_ATTRIBUTE_FORMAT, "mesh %d primitive %d: TEXCOORD_0 accessor %lld: integer components must be normalized", mi, pi, at);
    }
    uint32_t nidx = P.count;
    if (idxA >= 0) {
        if (!accessor(g, (int)idxA, &I)) return 0;
        if (I.ncomp != 1 || !(I.ctype == 5121 || I.ctype == 5123 || I.ctype == 5125))
            return gerr(g, FW_MC_ACCESSOR_INVALID, "mesh %d primitive %d: indices accessor %lld: componentType %d is not an unsigned byte/short/int", mi, pi, idxA, I.ctype);
        nidx = I.count;
    }
    if (nidx % 3) return gerr(g, FW_MC_INDEX_RANGE, "mesh %d primitive %d: %u indices is not a multiple of 3", mi, pi, nidx);
    if (mat >= 0 && !material(g, (int)mat)) return 0;
    if (P.count > FW_MESH_MAX_VERTS) return gerr(g, FW_MC_LIMIT, "more than %u vertices (limit)", FW_MESH_MAX_VERTS);

    FwMesh tmp;
    memset(&tmp, 0, sizeof tmp);
    tmp.verts = (FwMeshVertex *)calloc(P.count ? P.count : 1, sizeof *tmp.verts);
    tmp.indices = (uint32_t *)malloc((size_t)(nidx ? nidx : 1) * sizeof *tmp.indices);
    if (!tmp.verts || !tmp.indices) { fw_mesh_free(&tmp); return gerr(g, FW_MC_LIMIT, "out of memory"); }
    tmp.nverts = P.count; tmp.nindices = nidx;
    for (uint32_t i = 0; i < P.count; i++) {
        FwMeshVertex *v = &tmp.verts[i];
        for (int c = 0; c < 3; c++) v->pos[c] = rd_comp(&P, i, c);
        if (an >= 0) for (int c = 0; c < 3; c++) v->nrm[c] = rd_comp(&N, i, c);
        if (at >= 0) for (int c = 0; c < 2; c++) v->uv[c] = rd_comp(&T, i, c);
        for (int c = 0; c < 3; c++) if (!isfinite(v->pos[c])) { fw_mesh_free(&tmp); return gerr(g, FW_MC_ATTRIBUTE_FORMAT, "mesh %d primitive %d: a POSITION is not finite", mi, pi); }
    }
    for (uint32_t i = 0; i < nidx; i++) {
        uint32_t x = idxA >= 0 ? rd_u(I.p + (size_t)i * I.stride, I.csize) : i;
        if (x >= P.count) { fw_mesh_free(&tmp); return gerr(g, FW_MC_INDEX_RANGE, "mesh %d primitive %d: index %u out of range (%u vertices)", mi, pi, x, P.count); }
        tmp.indices[i] = x;
    }
    if (an < 0) { g->allNormals = 0; if (!fw_mesh_flat_normals(&tmp)) { fw_mesh_free(&tmp); return gerr(g, FW_MC_LIMIT, "out of memory"); } }
    if (at >= 0) g->anyUv = 1;

    /* bake the node transform: positions by M, normals by the inverse-transpose of its 3x3, winding by det's sign */
    const float a00 = M[0], a10 = M[1], a20 = M[2], a01 = M[4], a11 = M[5], a21 = M[6], a02 = M[8], a12 = M[9], a22 = M[10];
    float C[9] = { /* cofactors, row-major C[r*3+c] */
        a11 * a22 - a12 * a21, -(a10 * a22 - a12 * a20), a10 * a21 - a11 * a20,
        -(a01 * a22 - a02 * a21), a00 * a22 - a02 * a20, -(a00 * a21 - a01 * a20),
        a01 * a12 - a02 * a11, -(a00 * a12 - a02 * a10), a00 * a11 - a01 * a10 };
    float det = a00 * C[0] + a01 * C[1] + a02 * C[2];
    float inv = fabsf(det) > 1e-30f ? 1.0f / det : 1.0f;
    for (uint32_t i = 0; i < tmp.nverts; i++) {
        FwMeshVertex *v = &tmp.verts[i];
        float p[3] = { v->pos[0], v->pos[1], v->pos[2] }, n[3] = { v->nrm[0], v->nrm[1], v->nrm[2] };
        for (int r = 0; r < 3; r++) v->pos[r] = M[r] * p[0] + M[4 + r] * p[1] + M[8 + r] * p[2] + M[12 + r];
        /* inverse-transpose = C / det; (C/det)[r][c] = C[r*3+c] * inv */
        for (int r = 0; r < 3; r++) v->nrm[r] = (C[r * 3 + 0] * n[0] + C[r * 3 + 1] * n[1] + C[r * 3 + 2] * n[2]) * inv;
        float l = sqrtf(v->nrm[0] * v->nrm[0] + v->nrm[1] * v->nrm[1] + v->nrm[2] * v->nrm[2]);
        if (l > 1e-20f) for (int r = 0; r < 3; r++) v->nrm[r] /= l;
        else { v->nrm[0] = 0; v->nrm[1] = 1; v->nrm[2] = 0; }
    }
    if (det < 0)
        for (uint32_t t = 0; t + 2 < tmp.nindices; t += 3) { uint32_t x = tmp.indices[t]; tmp.indices[t] = tmp.indices[t + 2]; tmp.indices[t + 2] = x; }
    int ok = append(g, &tmp);
    fw_mesh_free(&tmp);
    return ok;
}

static int bake_mesh(G *g, long long mi, const float M[16]) {
    int m = elem(g, g->aMeshes, (int)mi);
    if (mi < 0 || !is_type(g, m, FW_JSON_OBJECT)) return gerr(g, FW_MC_NODE_INVALID, "mesh %lld does not exist", mi);
    int prims = find(g, m, "primitives");
    for (int p = 0; p < arr_len(g, prims); p++) {
        int pt = elem(g, prims, p);
        if (!is_type(g, pt, FW_JSON_OBJECT)) return gerr(g, FW_MC_NODE_INVALID, "mesh %lld primitive %d is not an object", mi, p);
        if (!primitive(g, pt, (int)mi, p, M)) return 0;
    }
    return 1;
}

static int walk(G *g, long long ni, const float parent[16], int depth) {
    if (depth >= FW_GLTF_MAX_NODE_DEPTH) return gerr(g, FW_MC_LIMIT, "node tree is too deep (more than %d levels)", FW_GLTF_MAX_NODE_DEPTH);
    int node = elem(g, g->aNodes, (int)ni);
    if (ni < 0 || !is_type(g, node, FW_JSON_OBJECT)) return gerr(g, FW_MC_NODE_INVALID, "node %lld does not exist", ni);
    if (g->seen[ni]) return gerr(g, FW_MC_NODE_CYCLE, "node %lld is reached twice (a cycle or a shared child)", ni);
    g->seen[ni] = 1;
    float local[16], world[16];
    if (!node_local(g, node, (int)ni, local)) return 0;
    mat_mul(parent, local, world);
    long long mesh = -1;
    if (!get_int(g, node, "mesh", -1, 0, &mesh, "node", (int)ni)) return 0;
    if (find(g, node, "mesh") >= 0 && !bake_mesh(g, mesh, world)) return 0;
    int ch = find(g, node, "children");
    for (int c = 0; c < arr_len(g, ch); c++) {
        long long ci;
        if (!fw_json_int(g->js, g->t, elem(g, ch, c), &ci)) return gerr(g, FW_MC_NODE_INVALID, "node %lld: children must be integers", ni);
        if (!walk(g, ci, world, depth + 1)) return 0;
    }
    return 1;
}

/* ---------------------------------------------------------------- entry */
static int parse_json(G *g, const char *js, size_t jlen) {
    FwJsonError je;
    int cap = 1024, n = -1;
    int maxCap = (int)((jlen / 2 + 64) < (size_t)0x7fffffff ? jlen / 2 + 64 : 0x7fffffff);
    for (;;) {
        g->t = (FwJsonTok *)malloc((size_t)cap * sizeof *g->t);
        if (!g->t) return gerr(g, FW_MC_LIMIT, "out of memory");
        n = fw_json_tokenize(js, jlen, g->t, cap, &je);
        if (n >= 0 || !strstr(je.text, "too many tokens") || cap >= maxCap) break;
        free(g->t); g->t = NULL;
        cap = cap > maxCap / 2 ? maxCap : cap * 2;
    }
    if (n < 0) return gerr(g, FW_MC_PARSE_ERROR, "not valid JSON: %s", je.text);
    g->js = js;
    if (!is_type(g, 0, FW_JSON_OBJECT)) return gerr(g, FW_MC_PARSE_ERROR, "the glTF JSON is not an object");
    return 1;
}

static int run(G *g, const uint8_t *bytes, size_t len) {
    const char *js = (const char *)bytes;
    size_t jlen = len;
    if (len >= 4 && memcmp(bytes, "glTF", 4) == 0) {
        if (len < 20) return gerr(g, FW_MC_GLB_HEADER, "glb is shorter than its header");
        uint32_t ver = rd_u(bytes + 4, 4), total = rd_u(bytes + 8, 4);
        if (ver != 2) return gerr(g, FW_MC_GLB_HEADER, "glb version %u is not 2", ver);
        if (total > len) return gerr(g, FW_MC_GLB_HEADER, "glb header length %u is past the %zu bytes given", total, len);
        uint32_t l0 = rd_u(bytes + 12, 4), t0 = rd_u(bytes + 16, 4);
        if (t0 != 0x4E4F534Au) return gerr(g, FW_MC_GLB_HEADER, "glb first chunk is not JSON");
        if ((uint64_t)20 + l0 > total) return gerr(g, FW_MC_GLB_HEADER, "glb JSON chunk (%u bytes) is past the end", l0);
        if (l0 % 4) return gerr(g, FW_MC_GLB_HEADER, "glb JSON chunk length %u is not 4-byte aligned", l0);
        js = (const char *)bytes + 20; jlen = l0;
        size_t at = 20 + (size_t)l0;
        if (at + 8 <= total) {
            uint32_t l1 = rd_u(bytes + at, 4), t1 = rd_u(bytes + at + 4, 4);
            if ((uint64_t)at + 8 + l1 > total) return gerr(g, FW_MC_GLB_HEADER, "glb chunk 1 (%u bytes) is past the end", l1);
            if (t1 == 0x004E4942u) {
                if (l1 % 4) return gerr(g, FW_MC_GLB_HEADER, "glb BIN chunk length %u is not 4-byte aligned", l1);
                g->bin = bytes + at + 8; g->binLen = l1;
            }
        }
    }
    if (!parse_json(g, js, jlen)) return 0;
    int asset = find(g, 0, "asset");
    if (!is_type(g, asset, FW_JSON_OBJECT)) return gerr(g, FW_MC_GLTF_VERSION, "no asset object (not a glTF file)");
    int ver = find(g, asset, "version");
    char vs[16];
    if (fw_json_str_copy(g->js, g->t, ver, vs, sizeof vs) < 0 || strncmp(vs, "2.", 2) != 0)
        return gerr(g, FW_MC_GLTF_VERSION, "asset.version must be 2.x");
    int req = find(g, 0, "extensionsRequired");
    if (arr_len(g, req) > 0) {
        char ext[64];
        if (fw_json_str_copy(g->js, g->t, elem(g, req, 0), ext, sizeof ext) < 0) snprintf(ext, sizeof ext, "?");
        return gerr(g, FW_MC_EXTENSION_REQUIRED, "glTF extension required but not supported: %s", ext);
    }
    if (arr_len(g, find(g, 0, "extensionsUsed")) > 0) fw_mesh_warn(g->err, FW_MC_EXTENSION_IGNORED);
    if (arr_len(g, find(g, 0, "skins")) > 0) fw_mesh_warn(g->err, FW_MC_SKIN_IGNORED);
    if (arr_len(g, find(g, 0, "animations")) > 0) fw_mesh_warn(g->err, FW_MC_ANIMATION_IGNORED);
    g->aBuffers = find(g, 0, "buffers"); g->aViews = find(g, 0, "bufferViews"); g->aAccessors = find(g, 0, "accessors");
    g->aMeshes = find(g, 0, "meshes"); g->aNodes = find(g, 0, "nodes"); g->aMaterials = find(g, 0, "materials");
    g->aTextures = find(g, 0, "textures"); g->aImages = find(g, 0, "images");
    g->nbufs = arr_len(g, g->aBuffers);
    g->nnodes = arr_len(g, g->aNodes);
    g->bufs = (GBuf *)calloc((size_t)g->nbufs + 1, sizeof *g->bufs);
    g->seen = (unsigned char *)calloc((size_t)g->nnodes + 1, 1);
    if (!g->bufs || !g->seen) return gerr(g, FW_MC_LIMIT, "out of memory");
    float I[16];
    mat_identity(I);
    int scenes = find(g, 0, "scenes");
    if (arr_len(g, scenes) > 0) {
        long long si = 0;
        if (!get_int(g, 0, "scene", 0, 0, &si, "glTF", 0)) return 0;
        int sc = elem(g, scenes, (int)si);
        if (si < 0 || !is_type(g, sc, FW_JSON_OBJECT)) return gerr(g, FW_MC_NODE_INVALID, "scene %lld does not exist", si);
        int roots = find(g, sc, "nodes");
        for (int r = 0; r < arr_len(g, roots); r++) {
            long long ni;
            if (!fw_json_int(g->js, g->t, elem(g, roots, r), &ni)) return gerr(g, FW_MC_NODE_INVALID, "scene %lld: nodes must be integers", si);
            if (!walk(g, ni, I, 0)) return 0;
        }
    } else {
        for (int m = 0; m < arr_len(g, g->aMeshes); m++) if (!bake_mesh(g, m, I)) return 0;
    }
    if (g->out.nindices == 0) return gerr(g, FW_MC_EMPTY, "no triangles to draw");
    return 1;
}

int fw_mesh_gltf_parse(const uint8_t *bytes, size_t len, FwMeshReadFn read, void *user, FwMesh *out, FwMeshError *err) {
    fw_mesh_err_reset(err);
    if (!out) { if (err) { snprintf(err->text, sizeof err->text, "no output mesh"); err->code = fw_mesh_code(FW_MC_PARSE_ERROR); } return 0; }
    memset(out, 0, sizeof *out);
    G g;
    memset(&g, 0, sizeof g);
    g.read = read; g.user = user; g.err = err;
    g.allNormals = 1;
    g.aBuffers = g.aViews = g.aAccessors = g.aMeshes = g.aNodes = g.aMaterials = g.aTextures = g.aImages = -1;
    fw_mesh_default_material(&g.out);
    int ok = (bytes && len) ? run(&g, bytes, len) : gerr(&g, FW_MC_EMPTY, "empty input");
    for (int i = 0; i < g.nbufs; i++) if (g.bufs && g.bufs[i].owned) free(g.bufs[i].data);
    free(g.bufs); free(g.seen); free(g.t);
    if (!ok) { fw_mesh_free(&g.out); return 0; }
    g.out.has_normals = g.allNormals;
    g.out.has_uvs = g.anyUv;
    fw_mesh_bounds(&g.out);
    *out = g.out;
    return 1;
}
