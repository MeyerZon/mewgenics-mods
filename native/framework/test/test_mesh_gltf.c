/* Host-side tests for the glTF 2.0 loader (src/fw_mesh_gltf.c on src/fw_json.c): .gltf with data: URIs and external
 * .bin through the read callback, .glb built in-test from C arrays, index types, byteStride, normalized texcoords,
 * every refusal (extensionsRequired, modes, morphs, sparse, out-of-bounds accessors), materials, and the scene walk:
 * TRS / matrix node transforms, children, instancing, negative determinants, cycles, multiple primitives. The text
 * fixture test/fixtures/mesh/tri.gltf is found next to this source (__FILE__), like crate.obj. */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include <stdarg.h>
#include <math.h>
#include "../../test/minitest.h"
#include "fw_mesh_rules.h"

static int feq(float a, float b) { return fabsf(a - b) < 1e-5f; }
static int veq(const float *a, float x, float y, float z) { return feq(a[0], x) && feq(a[1], y) && feq(a[2], z); }
static float dot3(const float *a, const float *b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
static int windings_match_normals(const FwMesh *m) {
    for (uint32_t t = 0; t + 2 < m->nindices; t += 3) {
        const float *a = m->verts[m->indices[t]].pos, *b = m->verts[m->indices[t + 1]].pos, *c = m->verts[m->indices[t + 2]].pos;
        float u[3] = { b[0] - a[0], b[1] - a[1], b[2] - a[2] }, v[3] = { c[0] - a[0], c[1] - a[1], c[2] - a[2] };
        float n[3] = { u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0] };
        for (int k = 0; k < 3; k++) if (dot3(n, m->verts[m->indices[t + k]].nrm) <= 0.0f) return 0;
    }
    return 1;
}
static int is_zeroed(const FwMesh *m) { FwMesh z; memset(&z, 0, sizeof z); return memcmp(m, &z, sizeof z) == 0; }

/* ---------------- builders ---------------- */
typedef struct Blob { uint8_t b[4096]; size_t n; } Blob;
static void put(Blob *bl, const void *p, size_t n) { memcpy(bl->b + bl->n, p, n); bl->n += n; }
static void put_f32(Blob *bl, const float *f, int n) { for (int i = 0; i < n; i++) put(bl, &f[i], 4); }  /* host = LE */
static void pad4(Blob *bl) { while (bl->n % 4) bl->b[bl->n++] = 0; }

static char *b64(const uint8_t *p, size_t n) {
    static const char A[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    char *o = (char *)malloc(4 * ((n + 2) / 3) + 1), *q = o;
    for (size_t i = 0; i < n; i += 3) {
        uint32_t v = (uint32_t)p[i] << 16 | (i + 1 < n ? (uint32_t)p[i + 1] << 8 : 0) | (i + 2 < n ? p[i + 2] : 0);
        *q++ = A[v >> 18 & 63]; *q++ = A[v >> 12 & 63];
        *q++ = i + 1 < n ? A[v >> 6 & 63] : '='; *q++ = i + 2 < n ? A[v & 63] : '=';
    }
    *q = 0;
    return o;
}
static char *data_uri(const Blob *bl) {
    char *e = b64(bl->b, bl->n);
    const char *pre = "data:application/octet-stream;base64,";
    char *u = (char *)malloc(strlen(pre) + strlen(e) + 1);
    strcpy(u, pre); strcat(u, e); free(e);
    return u;
}
/* tmpl with each (key, value) pair replaced everywhere, in order; NULL-terminated pairs; malloc'd */
static char *subst(const char *tmpl, ...) {
    char *cur = (char *)malloc(strlen(tmpl) + 1);
    strcpy(cur, tmpl);
    va_list ap; va_start(ap, tmpl);
    for (;;) {
        const char *k = va_arg(ap, const char *);
        if (!k) break;
        const char *v = va_arg(ap, const char *);
        size_t kl = strlen(k), vl = strlen(v), cnt = 0;
        for (const char *p = strstr(cur, k); p; p = strstr(p + kl, k)) cnt++;
        char *nx = (char *)malloc(strlen(cur) + cnt * vl + 1), *w = nx;
        const char *r = cur;
        for (const char *p = strstr(r, k); p; p = strstr(r, k)) { memcpy(w, r, (size_t)(p - r)); w += p - r; memcpy(w, v, vl); w += vl; r = p + kl; }
        strcpy(w, r);
        free(cur); cur = nx;
    }
    va_end(ap);
    return cur;
}
static int parse_json(const char *json, FwMesh *m, FwMeshError *e) {
    memset(e, 0, sizeof *e);
    return fw_mesh_gltf_parse((const uint8_t *)json, strlen(json), NULL, NULL, m, e);
}

/* the standard triangle: pos (0,0,0) (1,0,0) (0,1,0) @0, normals (0,0,1) @36, uvs @72, indices @96 */
static const float TRI_POS[9] = { 0, 0, 0, 1, 0, 0, 0, 1, 0 };
static const float TRI_NRM[9] = { 0, 0, 1, 0, 0, 1, 0, 0, 1 };
static const float TRI_UV[6] = { 0, 0, 1, 0, 0, 1 };
static size_t tri_blob(Blob *bl, int ctype, const uint32_t idx[3]) {
    bl->n = 0;
    put_f32(bl, TRI_POS, 9); put_f32(bl, TRI_NRM, 9); put_f32(bl, TRI_UV, 6);
    size_t at = bl->n;
    for (int i = 0; i < 3; i++) {
        if (ctype == 5121) { uint8_t v = (uint8_t)idx[i]; put(bl, &v, 1); }
        else if (ctype == 5123) { uint16_t v = (uint16_t)idx[i]; put(bl, &v, 2); }
        else put(bl, &idx[i], 4);
    }
    size_t il = bl->n - at;
    pad4(bl);
    return il;
}
static const uint32_t IDX012[3] = { 0, 1, 2 };

#define TRI_HEAD "{\"asset\":{\"version\":\"@VER@\"},@EXTRA@\"buffers\":[@BUF@]," \
    "\"bufferViews\":[{\"buffer\":0,\"byteLength\":96@BV0X@},{\"buffer\":0,\"byteOffset\":96,\"byteLength\":@IDXLEN@}]," \
    "\"accessors\":[{\"bufferView\":0,\"componentType\":5126,\"count\":@N0@,\"type\":\"VEC3\"@ACC0X@}," \
    "{\"bufferView\":0,\"byteOffset\":36,\"componentType\":5126,\"count\":3,\"type\":\"VEC3\"}," \
    "{\"bufferView\":0,\"byteOffset\":72,\"componentType\":5126,\"count\":3,\"type\":\"VEC2\"}," \
    "{\"bufferView\":1,\"componentType\":@CT@,\"count\":3,\"type\":\"SCALAR\"}],"
#define TRI_PRIM "{\"attributes\":{\"POSITION\":0,\"NORMAL\":1,\"TEXCOORD_0\":2},\"indices\":3@PRIMX@}"
#define TRI_MESH "\"meshes\":[{\"primitives\":[" TRI_PRIM "]}],"
#define ONE_NODE "\"nodes\":[{\"mesh\":0@NODEX@}],\"scenes\":[{\"nodes\":[0]}],\"scene\":0}"
#define BUF_URI "{\"uri\":\"@URI@\",\"byteLength\":@LEN@}"

typedef struct Opt { const char *ver, *extra, *buf, *bv0x, *n0, *acc0x, *primx, *nodex, *len; int ctype; const uint32_t *idx; } Opt;
static char *tri_json_opt(const char *rest, Opt o) {
    Blob bl; int ct = o.ctype ? o.ctype : 5123;
    size_t il = tri_blob(&bl, ct, o.idx ? o.idx : IDX012);
    char *uri = data_uri(&bl), ils[16], cts[16], lens[16];
    snprintf(ils, sizeof ils, "%u", (unsigned)il); snprintf(cts, sizeof cts, "%d", ct); snprintf(lens, sizeof lens, "%u", (unsigned)bl.n);
    char *tmpl = (char *)malloc(strlen(TRI_HEAD) + strlen(rest) + 1);
    strcpy(tmpl, TRI_HEAD); strcat(tmpl, rest);
    char *j = subst(tmpl, "@BUF@", o.buf ? o.buf : BUF_URI, "@URI@", uri, "@LEN@", o.len ? o.len : lens,
                    "@VER@", o.ver ? o.ver : "2.0", "@EXTRA@", o.extra ? o.extra : "", "@BV0X@", o.bv0x ? o.bv0x : "",
                    "@IDXLEN@", ils, "@N0@", o.n0 ? o.n0 : "3", "@ACC0X@", o.acc0x ? o.acc0x : "", "@CT@", cts,
                    "@PRIMX@", o.primx ? o.primx : "", "@NODEX@", o.nodex ? o.nodex : "", (const char *)NULL);
    free(tmpl); free(uri);
    return j;
}
static int tri_opt(const char *rest, Opt o, FwMesh *m, FwMeshError *e) {
    char *j = tri_json_opt(rest, o);
    int r = parse_json(j, m, e);
    free(j);
    return r;
}
static const Opt NO = { 0 };
#define TRI_OK(rest, ...) do { Opt o_ = { __VA_ARGS__ }; if (tri_opt((rest), o_, &m, &e) != 1) { MT_FAIL("parse failed: %s", e.text); return; } } while (0)
#define TRI_ERR(needle, rest, ...) do { Opt o_ = { __VA_ARGS__ }; FwMesh m_; FwMeshError e_; \
    if (tri_opt((rest), o_, &m_, &e_) != 0) { MT_FAIL("accepted, wanted error '%s'", (needle)); fw_mesh_free(&m_); } \
    else { if (!strstr(e_.text, (needle))) MT_FAIL("error '%s' lacks '%s'", e_.text, (needle)); CHECK(is_zeroed(&m_)); CHECK_EQ(e_.line, 0); } } while (0)

static int mesh_eq(const FwMesh *a, const FwMesh *b) {
    if (a->nverts != b->nverts || a->nindices != b->nindices) return 0;
    for (uint32_t i = 0; i < a->nverts; i++) {
        const float *p = (const float *)&a->verts[i], *q = (const float *)&b->verts[i];
        for (int k = 0; k < 8; k++) if (!feq(p[k], q[k])) return 0;
    }
    return memcmp(a->indices, b->indices, a->nindices * 4) == 0;
}

/* ---------------- basics ---------------- */
static char *read_fixture(const char *name, size_t *len) {
    char path[1024];
    const char *f = __FILE__, *slash = NULL;
    for (const char *p = f; *p; p++) if (*p == '/' || *p == '\\') slash = p;
    size_t dir = slash ? (size_t)(slash - f + 1) : 0;
    if (dir + strlen("fixtures/mesh/") + strlen(name) + 1 > sizeof path) return NULL;
    memcpy(path, f, dir); strcpy(path + dir, "fixtures/mesh/"); strcat(path, name);
    FILE *fp = fopen(path, "rb");
    if (!fp) { printf("      cannot open fixture %s\n", path); return NULL; }
    fseek(fp, 0, SEEK_END); long sz = ftell(fp); fseek(fp, 0, SEEK_SET);
    char *b = (char *)malloc(sz > 0 ? (size_t)sz : 1);
    *len = fread(b, 1, (size_t)(sz > 0 ? sz : 0), fp);
    fclose(fp);
    return b;
}

TEST(gltf_minimal_triangle_from_data_uri) {
    size_t n = 0; char *b = read_fixture("tri.gltf", &n);
    CHECK(b != NULL);
    if (!b) return;
    FwMesh m; FwMeshError e;
    if (fw_mesh_gltf_parse((const uint8_t *)b, n, NULL, NULL, &m, &e) != 1) { MT_FAIL("tri.gltf: %s", e.text); free(b); return; }
    CHECK_EQ(m.nverts, 3); CHECK_EQ(m.nindices, 3);
    CHECK_EQ(m.has_normals, 0); CHECK_EQ(m.has_uvs, 0);
    for (int i = 0; i < 3; i++) CHECK(veq(m.verts[i].nrm, 0, 0, 1));   /* flat, CCW seen from +z */
    CHECK(veq(m.bmin, 0, 0, 0)); CHECK(veq(m.bmax, 1, 1, 0));
    CHECK(feq(m.base_color[0], 1) && feq(m.base_color[3], 1));
    CHECK_STR(m.texture, "");
    fw_mesh_free(&m);
    free(b);
}

TEST(gltf_triangle_with_normals_and_uvs) {
    FwMesh m; FwMeshError e;
    TRI_OK(TRI_MESH ONE_NODE, 0);
    CHECK_EQ(m.nverts, 3); CHECK_EQ(m.nindices, 3);
    CHECK_EQ(m.has_normals, 1); CHECK_EQ(m.has_uvs, 1);
    CHECK(veq(m.verts[1].pos, 1, 0, 0));
    CHECK(veq(m.verts[2].nrm, 0, 0, 1));
    CHECK(feq(m.verts[2].uv[0], 0) && feq(m.verts[2].uv[1], 1));
    CHECK_EQ(m.indices[0], 0); CHECK_EQ(m.indices[1], 1); CHECK_EQ(m.indices[2], 2);
    CHECK(windings_match_normals(&m));
    fw_mesh_free(&m);
}

TEST(gltf_u16_and_u32_indices_give_the_same_mesh) {
    FwMesh a, b, c, d; FwMeshError e;
    Opt o16 = NO, o32 = NO, o8 = NO;
    o16.ctype = 5123; o32.ctype = 5125; o8.ctype = 5121;
    CHECK_EQ(tri_opt(TRI_MESH ONE_NODE, o16, &a, &e), 1);
    CHECK_EQ(tri_opt(TRI_MESH ONE_NODE, o32, &b, &e), 1);
    CHECK_EQ(tri_opt(TRI_MESH ONE_NODE, o8, &c, &e), 1);
    /* no indices at all: 0..n-1 */
    CHECK_EQ(tri_opt("\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":0,\"NORMAL\":1,\"TEXCOORD_0\":2}}]}]," ONE_NODE, NO, &d, &e), 1);
    CHECK(mesh_eq(&a, &b)); CHECK(mesh_eq(&a, &c)); CHECK(mesh_eq(&a, &d));
    fw_mesh_free(&a); fw_mesh_free(&b); fw_mesh_free(&c); fw_mesh_free(&d);
    TRI_ERR("component", TRI_MESH ONE_NODE, .ctype = 5126);              /* float indices */
}

TEST(gltf_index_out_of_range_is_an_error) {
    static const uint32_t bad[3] = { 0, 1, 3 };
    TRI_ERR("index 3", TRI_MESH ONE_NODE, .idx = bad);
}

/* ---------------- buffers ---------------- */
typedef struct Files { const char *names[4]; const Blob *blobs[4]; int n; char asked[4][64]; int nasked; } Files;
static void *read_cb(void *user, const char *rel, size_t *len) {
    Files *f = (Files *)user;
    if (f->nasked < 4) { snprintf(f->asked[f->nasked], 64, "%s", rel); f->nasked++; }
    for (int i = 0; i < f->n; i++)
        if (strcmp(f->names[i], rel) == 0) {
            void *p = malloc(f->blobs[i]->n);
            memcpy(p, f->blobs[i]->b, f->blobs[i]->n);
            *len = f->blobs[i]->n;
            return p;
        }
    return NULL;
}

TEST(gltf_external_bin_through_the_read_callback) {
    Blob bl; tri_blob(&bl, 5123, IDX012);
    Files f; memset(&f, 0, sizeof f);
    f.names[0] = "my tri.bin"; f.blobs[0] = &bl; f.n = 1;
    Opt o = NO; o.buf = "{\"uri\":\"my%20tri.bin\",\"byteLength\":104}";
    char *j = tri_json_opt(TRI_MESH ONE_NODE, o);
    FwMesh m; FwMeshError e;
    CHECK_EQ(fw_mesh_gltf_parse((const uint8_t *)j, strlen(j), read_cb, &f, &m, &e), 1);
    CHECK_EQ(f.nasked, 1); CHECK_STR(f.asked[0], "my tri.bin");        /* percent-decoded */
    CHECK_EQ(m.nverts, 3);
    fw_mesh_free(&m);
    free(j);
    /* missing file -> an error naming it; no reader -> an error; unsafe uris are refused before any read */
    o.buf = "{\"uri\":\"missing.bin\",\"byteLength\":104}";
    j = tri_json_opt(TRI_MESH ONE_NODE, o);
    CHECK_EQ(fw_mesh_gltf_parse((const uint8_t *)j, strlen(j), read_cb, &f, &m, &e), 0);
    CHECK(strstr(e.text, "missing.bin") != NULL);
    CHECK_EQ(fw_mesh_gltf_parse((const uint8_t *)j, strlen(j), NULL, NULL, &m, &e), 0);
    CHECK(strstr(e.text, "missing.bin") != NULL);
    free(j);
    const char *unsafe[] = { "{\"uri\":\"../tri.bin\",\"byteLength\":104}", "{\"uri\":\"/tri.bin\",\"byteLength\":104}",
                             "{\"uri\":\"C:/tri.bin\",\"byteLength\":104}", "{\"uri\":\"sub\\\\tri.bin\",\"byteLength\":104}",
                             "{\"uri\":\"http://x/tri.bin\",\"byteLength\":104}", "{\"uri\":\"%2e%2e/tri.bin\",\"byteLength\":104}" };
    for (size_t i = 0; i < sizeof unsafe / sizeof unsafe[0]; i++) {
        f.nasked = 0;
        o.buf = unsafe[i];
        j = tri_json_opt(TRI_MESH ONE_NODE, o);
        if (fw_mesh_gltf_parse((const uint8_t *)j, strlen(j), read_cb, &f, &m, &e) != 0) { MT_FAIL("accepted %s", unsafe[i]); fw_mesh_free(&m); }
        CHECK_EQ(f.nasked, 0);
        free(j);
    }
    /* a file shorter than byteLength */
    Blob shortb; shortb.n = 50; memcpy(shortb.b, bl.b, 50);
    f.blobs[0] = &shortb; f.nasked = 0;
    o.buf = "{\"uri\":\"my%20tri.bin\",\"byteLength\":104}";
    j = tri_json_opt(TRI_MESH ONE_NODE, o);
    CHECK_EQ(fw_mesh_gltf_parse((const uint8_t *)j, strlen(j), read_cb, &f, &m, &e), 0);
    CHECK(strstr(e.text, "byteLength") != NULL);
    free(j);
}

TEST(gltf_data_uri_must_be_base64_and_long_enough) {
    TRI_ERR("base64", TRI_MESH ONE_NODE, .buf = "{\"uri\":\"data:application/octet-stream,abc\",\"byteLength\":3}");
    TRI_ERR("base64", TRI_MESH ONE_NODE, .buf = "{\"uri\":\"data:application/octet-stream;base64,AA*A\",\"byteLength\":3}");
    TRI_ERR("byteLength", TRI_MESH ONE_NODE, .len = "200");
}

static uint8_t *make_glb(const char *json, const Blob *bin, uint32_t version, size_t *outLen, int misalign) {
    size_t jl = strlen(json), jp = misalign ? jl : (jl + 3) & ~(size_t)3;
    size_t bl = bin ? (bin->n + 3) & ~(size_t)3 : 0;
    size_t total = 12 + 8 + jp + (bin ? 8 + bl : 0);
    uint8_t *g = (uint8_t *)calloc(1, total + 4);
    uint32_t h[3] = { 0x46546C67u, version, (uint32_t)total };
    memcpy(g, h, 12);
    uint32_t c0[2] = { (uint32_t)jp, 0x4E4F534Au };
    memcpy(g + 12, c0, 8);
    memcpy(g + 20, json, jl);
    for (size_t i = jl; i < jp; i++) g[20 + i] = ' ';
    if (bin) {
        uint32_t c1[2] = { (uint32_t)bl, 0x004E4942u };
        memcpy(g + 20 + jp, c1, 8);
        memcpy(g + 28 + jp, bin->b, bin->n);
    }
    *outLen = total;
    return g;
}

TEST(glb_bin_chunk_is_buffer_zero) {
    Blob bl; tri_blob(&bl, 5123, IDX012);
    Opt o = NO; o.buf = "{\"byteLength\":104}";
    char *j = tri_json_opt(TRI_MESH ONE_NODE, o);
    size_t n; uint8_t *g = make_glb(j, &bl, 2, &n, 0);
    FwMesh m, ref; FwMeshError e;
    CHECK_EQ(fw_mesh_gltf_parse(g, n, NULL, NULL, &m, &e), 1);
    CHECK_EQ(tri_opt(TRI_MESH ONE_NODE, NO, &ref, &e), 1);
    CHECK(mesh_eq(&m, &ref));
    fw_mesh_free(&m); fw_mesh_free(&ref);
    free(g);
    /* buffer 0 without a uri but no BIN chunk */
    g = make_glb(j, NULL, 2, &n, 0);
    CHECK_EQ(fw_mesh_gltf_parse(g, n, NULL, NULL, &m, &e), 0);
    CHECK(strstr(e.text, "BIN") != NULL);
    free(g);
    free(j);
}

TEST(glb_bad_magic_version_and_misaligned_chunk_are_errors) {
    Blob bl; tri_blob(&bl, 5123, IDX012);
    Opt o = NO; o.buf = "{\"byteLength\":104}";
    char *j = tri_json_opt(TRI_MESH ONE_NODE, o);
    size_t n; FwMesh m; FwMeshError e;
    uint8_t *g = make_glb(j, &bl, 1, &n, 0);
    CHECK_EQ(fw_mesh_gltf_parse(g, n, NULL, NULL, &m, &e), 0);
    CHECK(strstr(e.text, "version") != NULL);
    free(g);
    if (strlen(j) % 4 == 0) { char *j2 = subst(j, "\"asset\"", " \"asset\"", (const char *)NULL); free(j); j = j2; }
    g = make_glb(j, &bl, 2, &n, 1);
    CHECK_EQ(fw_mesh_gltf_parse(g, n, NULL, NULL, &m, &e), 0);
    CHECK(strstr(e.text, "align") != NULL);
    free(g);
    g = make_glb(j, &bl, 2, &n, 0);
    CHECK_EQ(fw_mesh_gltf_parse(g, n - 4, NULL, NULL, &m, &e), 0);       /* header length past the bytes given */
    g[0] = 'X';                                                          /* bad magic: not JSON either */
    CHECK_EQ(fw_mesh_gltf_parse(g, n, NULL, NULL, &m, &e), 0);
    g[0] = 'g';
    uint32_t big = 0x7fffff00u; memcpy(g + 12, &big, 4);                 /* JSON chunk past the end */
    CHECK_EQ(fw_mesh_gltf_parse(g, n, NULL, NULL, &m, &e), 0);
    CHECK(is_zeroed(&m));
    free(g);
    free(j);
}

/* ---------------- accessors ---------------- */
TEST(gltf_byte_stride_interleaved_attributes) {
    Blob bl; bl.n = 0;
    for (int i = 0; i < 3; i++) { put_f32(&bl, TRI_POS + 3 * i, 3); put_f32(&bl, TRI_NRM + 3 * i, 3); put_f32(&bl, TRI_UV + 2 * i, 2); }
    uint16_t ix[3] = { 0, 1, 2 }; put(&bl, ix, 6); pad4(&bl);
    char *uri = data_uri(&bl);
    char *j = subst("{\"asset\":{\"version\":\"2.0\"},\"buffers\":[{\"uri\":\"@URI@\",\"byteLength\":104}],"
                    "\"bufferViews\":[{\"buffer\":0,\"byteLength\":96,\"byteStride\":32},{\"buffer\":0,\"byteOffset\":96,\"byteLength\":6}],"
                    "\"accessors\":[{\"bufferView\":0,\"componentType\":5126,\"count\":3,\"type\":\"VEC3\"},"
                    "{\"bufferView\":0,\"byteOffset\":12,\"componentType\":5126,\"count\":3,\"type\":\"VEC3\"},"
                    "{\"bufferView\":0,\"byteOffset\":24,\"componentType\":5126,\"count\":3,\"type\":\"VEC2\"},"
                    "{\"bufferView\":1,\"componentType\":5123,\"count\":3,\"type\":\"SCALAR\"}]," TRI_MESH ONE_NODE,
                    "@URI@", uri, "@PRIMX@", "", "@NODEX@", "", (const char *)NULL);
    FwMesh m, ref; FwMeshError e;
    CHECK_EQ(parse_json(j, &m, &e), 1);
    CHECK_EQ(tri_opt(TRI_MESH ONE_NODE, NO, &ref, &e), 1);
    CHECK(mesh_eq(&m, &ref));
    fw_mesh_free(&m); fw_mesh_free(&ref);
    /* the last element must fit: stride 32 * 2 + 12 + 24 offset > 96 when the uv accessor starts at 40 */
    char *j2 = subst(j, "\"byteOffset\":24", "\"byteOffset\":40", (const char *)NULL);
    CHECK_EQ(parse_json(j2, &m, &e), 0);
    free(j2); free(j); free(uri);
}

TEST(gltf_normalized_u8_u16_texcoords) {
    Blob bl; bl.n = 0;
    put_f32(&bl, TRI_POS, 9);
    uint16_t uv16[6] = { 0, 0, 65535, 0, 0, 32768 }; put(&bl, uv16, 12);   /* @36 */
    uint8_t uv8[6] = { 0, 0, 255, 0, 0, 51 }; put(&bl, uv8, 6); pad4(&bl);   /* @48 */
    char *uri = data_uri(&bl);
    const char *tmpl = "{\"asset\":{\"version\":\"2.0\"},\"buffers\":[{\"uri\":\"@URI@\",\"byteLength\":56}],"
                       "\"bufferViews\":[{\"buffer\":0,\"byteLength\":56}],"
                       "\"accessors\":[{\"bufferView\":0,\"componentType\":5126,\"count\":3,\"type\":\"VEC3\"},"
                       "{\"bufferView\":0,\"byteOffset\":36,\"componentType\":5123,\"normalized\":@NORM@,\"count\":3,\"type\":\"VEC2\"},"
                       "{\"bufferView\":0,\"byteOffset\":48,\"componentType\":5121,\"normalized\":true,\"count\":3,\"type\":\"VEC2\"}],"
                       "\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":0,\"TEXCOORD_0\":@UV@}}]}]}";
    FwMesh m; FwMeshError e;
    char *j = subst(tmpl, "@URI@", uri, "@NORM@", "true", "@UV@", "1", (const char *)NULL);
    CHECK_EQ(parse_json(j, &m, &e), 1);
    if (m.verts) {
        CHECK_EQ(m.has_uvs, 1);
        CHECK(feq(m.verts[1].uv[0], 1.0f));
        CHECK(fabsf(m.verts[2].uv[1] - 32768.0f / 65535.0f) < 1e-6f);
    }
    fw_mesh_free(&m); free(j);
    j = subst(tmpl, "@URI@", uri, "@NORM@", "true", "@UV@", "2", (const char *)NULL);
    CHECK_EQ(parse_json(j, &m, &e), 1);
    if (m.verts) { CHECK(feq(m.verts[1].uv[0], 1.0f)); CHECK(feq(m.verts[2].uv[1], 0.2f)); }
    fw_mesh_free(&m); free(j);
    j = subst(tmpl, "@URI@", uri, "@NORM@", "false", "@UV@", "1", (const char *)NULL);
    CHECK_EQ(parse_json(j, &m, &e), 0);
    CHECK(strstr(e.text, "normalized") != NULL);
    free(j); free(uri);
}

TEST(gltf_accessor_past_buffer_end_is_an_error) {
    TRI_ERR("accessor 0", TRI_MESH ONE_NODE, .n0 = "9");                 /* 9 * 12 > the 96-byte view */
    TRI_ERR("bufferView 0", TRI_MESH ONE_NODE, .bv0x = ",\"byteOffset\":40");   /* 40 + 96 > 104 */
    TRI_ERR("bufferView 0", TRI_MESH ONE_NODE, .len = "90", .buf = "{\"uri\":\"@URI@\",\"byteLength\":90}");
    TRI_ERR("accessor", "\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":7}}]}]," ONE_NODE, 0);
}

TEST(gltf_rejects_sparse_morph_targets_and_bad_attribute_types) {
    TRI_ERR("sparse", TRI_MESH ONE_NODE, .acc0x = ",\"sparse\":{\"count\":1}");
    TRI_ERR("morph", TRI_MESH ONE_NODE, .primx = ",\"targets\":[{\"POSITION\":0}]");
    TRI_ERR("POSITION", "\"meshes\":[{\"primitives\":[{\"attributes\":{\"NORMAL\":1}}]}]," ONE_NODE, 0);
    TRI_ERR("POSITION", "\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":2}}]}]," ONE_NODE, 0);   /* VEC2 */
    TRI_ERR("NORMAL", "\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":0,\"NORMAL\":2}}]}]," ONE_NODE, 0);
    TRI_ERR("NORMAL", "\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":0,\"NORMAL\":3}}]}]," ONE_NODE, 0);
}

/* ---------------- top level ---------------- */
TEST(gltf_rejects_extensions_required_by_name) {
    TRI_ERR("KHR_draco_mesh_compression", TRI_MESH ONE_NODE,
            .extra = "\"extensionsUsed\":[\"KHR_draco_mesh_compression\"],\"extensionsRequired\":[\"KHR_draco_mesh_compression\"],");
    FwMesh m; FwMeshError e;
    TRI_OK(TRI_MESH ONE_NODE, .extra = "\"extensionsUsed\":[\"KHR_materials_emissive_strength\"],\"extensionsRequired\":[],");
    fw_mesh_free(&m);
}

TEST(gltf_rejects_non_triangle_mode) {
    TRI_ERR("mode 1", TRI_MESH ONE_NODE, .primx = ",\"mode\":1");
    TRI_ERR("mode 5", TRI_MESH ONE_NODE, .primx = ",\"mode\":5");
    FwMesh m; FwMeshError e;
    TRI_OK(TRI_MESH ONE_NODE, .primx = ",\"mode\":4");
    fw_mesh_free(&m);
}

TEST(gltf_version_must_be_2) {
    TRI_ERR("version", TRI_MESH ONE_NODE, .ver = "1.0");
    FwMesh m; FwMeshError e;
    CHECK_EQ(parse_json("{\"meshes\":[]}", &m, &e), 0);
    CHECK(strstr(e.text, "asset") != NULL);
    CHECK_EQ(parse_json("{\"asset\":{\"version\":\"2.0\"}", &m, &e), 0);      /* not JSON */
    CHECK_EQ(parse_json("[1]", &m, &e), 0);
    CHECK_EQ(parse_json("{\"asset\":{\"version\":\"2.0\"}}", &m, &e), 0);     /* nothing to draw */
    CHECK_EQ(fw_mesh_gltf_parse(NULL, 0, NULL, NULL, &m, &e), 0);
    CHECK_EQ(fw_mesh_gltf_parse((const uint8_t *)"{}", 2, NULL, NULL, &m, NULL), 0);   /* err may be NULL */
}

/* ---------------- materials ---------------- */
TEST(gltf_base_color_texture_uri_and_factor) {
    FwMesh m; FwMeshError e;
    TRI_OK(TRI_MESH ONE_NODE, .primx = ",\"material\":0",
           .extra = "\"materials\":[{\"pbrMetallicRoughness\":{\"baseColorFactor\":[0.5,0.25,1,0.75],\"baseColorTexture\":{\"index\":0}}}],"
                    "\"textures\":[{\"source\":0}],\"images\":[{\"uri\":\"crate%20wood.png\"}],");
    CHECK(feq(m.base_color[0], 0.5f) && feq(m.base_color[1], 0.25f) && feq(m.base_color[2], 1) && feq(m.base_color[3], 0.75f));
    CHECK_STR(m.texture, "crate wood.png");
    fw_mesh_free(&m);
    TRI_OK(TRI_MESH ONE_NODE, .primx = ",\"material\":0",
           .extra = "\"materials\":[{\"pbrMetallicRoughness\":{\"baseColorTexture\":{\"index\":0}}}],"
                    "\"textures\":[{\"source\":0}],\"images\":[{\"bufferView\":1,\"mimeType\":\"image/png\"}],");
    CHECK_STR(m.texture, "embedded:1");
    CHECK(feq(m.base_color[0], 1) && feq(m.base_color[3], 1));
    fw_mesh_free(&m);
    TRI_OK(TRI_MESH ONE_NODE, .primx = ",\"material\":0",
           .extra = "\"materials\":[{\"pbrMetallicRoughness\":{\"baseColorTexture\":{\"index\":0}}}],"
                    "\"textures\":[{\"source\":0}],\"images\":[{\"uri\":\"data:image/png;base64,iVBORw0K\"}],");
    CHECK_STR(m.texture, "embedded:data-uri");
    fw_mesh_free(&m);
    TRI_OK(TRI_MESH ONE_NODE, .primx = ",\"material\":0", .extra = "\"materials\":[{\"name\":\"plain\"}],");
    CHECK_STR(m.texture, "");
    CHECK(feq(m.base_color[1], 1));
    fw_mesh_free(&m);
    TRI_ERR("material", TRI_MESH ONE_NODE, .primx = ",\"material\":3", .extra = "\"materials\":[{}],");
    TRI_ERR("texture", TRI_MESH ONE_NODE, .primx = ",\"material\":0",
            .extra = "\"materials\":[{\"pbrMetallicRoughness\":{\"baseColorTexture\":{\"index\":2}}}],");
    TRI_ERR("image", TRI_MESH ONE_NODE, .primx = ",\"material\":0",
            .extra = "\"materials\":[{\"pbrMetallicRoughness\":{\"baseColorTexture\":{\"index\":0}}}],"
                     "\"textures\":[{\"source\":0}],\"images\":[{\"uri\":\"../x.png\"}],");
}

/* ---------------- scene walk ---------------- */
TEST(gltf_two_primitives_are_merged) {
    FwMesh m; FwMeshError e;
    TRI_OK("\"meshes\":[{\"primitives\":[" TRI_PRIM "," TRI_PRIM "]}]," ONE_NODE, .primx = "");
    CHECK_EQ(m.nverts, 6); CHECK_EQ(m.nindices, 6);
    CHECK_EQ(m.indices[3], 3); CHECK_EQ(m.indices[5], 5);
    fw_mesh_free(&m);
    /* the first primitive's material wins */
    TRI_OK("\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":0},\"material\":1}," TRI_PRIM "]}]," ONE_NODE,
           .primx = ",\"material\":0",
           .extra = "\"materials\":[{\"pbrMetallicRoughness\":{\"baseColorFactor\":[0,1,0,1]}},{\"pbrMetallicRoughness\":{\"baseColorFactor\":[1,0,0,1]}}],");
    CHECK(feq(m.base_color[0], 1) && feq(m.base_color[1], 0));
    CHECK_EQ(m.has_normals, 0);   /* the first primitive had none */
    CHECK(windings_match_normals(&m));
    fw_mesh_free(&m);
}

TEST(gltf_node_translation_and_scale_are_baked) {
    FwMesh m; FwMeshError e;
    TRI_OK(TRI_MESH ONE_NODE, .nodex = ",\"translation\":[1,2,3],\"scale\":[2,2,2]");
    CHECK(veq(m.verts[1].pos, 3, 2, 3));
    CHECK(veq(m.verts[2].pos, 1, 4, 3));
    CHECK(veq(m.verts[0].nrm, 0, 0, 1));
    CHECK(veq(m.bmin, 1, 2, 3)); CHECK(veq(m.bmax, 3, 4, 3));
    fw_mesh_free(&m);
    TRI_OK(TRI_MESH ONE_NODE, .nodex = ",\"scale\":[1,4,1]");           /* non-uniform: inverse-transpose normals */
    CHECK(veq(m.verts[0].nrm, 0, 0, 1));
    CHECK(windings_match_normals(&m));
    fw_mesh_free(&m);
}

TEST(gltf_node_rotation_quaternion_and_matrix_agree) {
    FwMesh q, x; FwMeshError e;
    Opt o = NO;
    o.nodex = ",\"rotation\":[0,0.70710678,0,0.70710678]";               /* +90 degrees about +Y */
    CHECK_EQ(tri_opt(TRI_MESH ONE_NODE, o, &q, &e), 1);
    o.nodex = ",\"matrix\":[0,0,-1,0, 0,1,0,0, 1,0,0,0, 0,0,0,1]";       /* the same, column-major */
    CHECK_EQ(tri_opt(TRI_MESH ONE_NODE, o, &x, &e), 1);
    if (q.verts && x.verts) {
        CHECK(veq(q.verts[1].pos, 0, 0, -1));
        CHECK(veq(q.verts[0].nrm, 1, 0, 0));
        CHECK(mesh_eq(&q, &x));
    }
    fw_mesh_free(&q); fw_mesh_free(&x);
    TRI_ERR("matrix", TRI_MESH ONE_NODE, .nodex = ",\"matrix\":[1,0,0]");
    TRI_ERR("rotation", TRI_MESH ONE_NODE, .nodex = ",\"rotation\":[0,0,1]");
}

TEST(gltf_child_node_inherits_parent_transform) {
    FwMesh m; FwMeshError e;
    TRI_OK(TRI_MESH "\"nodes\":[{\"children\":[1],\"translation\":[10,0,0],\"scale\":[2,2,2]},{\"mesh\":0,\"translation\":[0,1,0]}],"
           "\"scenes\":[{\"nodes\":[0]}]}", 0);
    CHECK(veq(m.verts[1].pos, 12, 2, 0));    /* T(10) S(2) T(0,1,0) (1,0,0) */
    fw_mesh_free(&m);
}

TEST(gltf_negative_scale_node_reverses_winding) {
    FwMesh m; FwMeshError e;
    TRI_OK(TRI_MESH ONE_NODE, .nodex = ",\"scale\":[-1,1,1]");
    CHECK_EQ(m.indices[0], 2); CHECK_EQ(m.indices[2], 0);
    CHECK(veq(m.verts[1].pos, -1, 0, 0));
    CHECK(veq(m.verts[0].nrm, 0, 0, 1));
    CHECK(windings_match_normals(&m));
    fw_mesh_free(&m);
    TRI_OK("\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":0}}]}]," ONE_NODE, .nodex = ",\"scale\":[1,1,-1]");
    CHECK(windings_match_normals(&m));       /* flat normals under a mirror */
    fw_mesh_free(&m);
}

TEST(gltf_same_mesh_on_two_nodes_is_instanced_twice) {
    FwMesh m; FwMeshError e;
    TRI_OK(TRI_MESH "\"nodes\":[{\"mesh\":0},{\"mesh\":0,\"translation\":[5,0,0]}],\"scenes\":[{\"nodes\":[0,1]}]}", 0);
    CHECK_EQ(m.nverts, 6); CHECK_EQ(m.nindices, 6);
    CHECK(veq(m.verts[4].pos, 6, 0, 0));
    CHECK(veq(m.bmax, 6, 1, 0));
    fw_mesh_free(&m);
}

TEST(gltf_scene_index_selects_scene_and_no_scenes_bakes_every_mesh) {
    FwMesh m; FwMeshError e;
    TRI_OK(TRI_MESH "\"nodes\":[{\"mesh\":0},{\"mesh\":0,\"translation\":[5,0,0]}],\"scenes\":[{\"nodes\":[0]},{\"nodes\":[1]}],\"scene\":1}", 0);
    CHECK_EQ(m.nverts, 3); CHECK(veq(m.verts[0].pos, 5, 0, 0));
    fw_mesh_free(&m);
    TRI_OK(TRI_MESH "\"nodes\":[{\"mesh\":0},{\"mesh\":0}],\"scenes\":[{\"nodes\":[0]},{\"nodes\":[1]}]}", 0);   /* default 0 */
    CHECK_EQ(m.nverts, 3);
    fw_mesh_free(&m);
    TRI_OK("\"meshes\":[{\"primitives\":[" TRI_PRIM "]},{\"primitives\":[" TRI_PRIM "]}]}", .primx = "");
    CHECK_EQ(m.nverts, 6);
    fw_mesh_free(&m);
    TRI_ERR("scene", TRI_MESH "\"nodes\":[{\"mesh\":0}],\"scenes\":[{\"nodes\":[0]}],\"scene\":2}", 0);
    TRI_ERR("no triangles", TRI_MESH "\"nodes\":[{\"name\":\"empty\"}],\"scenes\":[{\"nodes\":[0]}]}", 0);
}

TEST(gltf_node_cycle_and_bad_references_are_errors) {
    TRI_ERR("node", TRI_MESH "\"nodes\":[{\"children\":[1]},{\"children\":[0],\"mesh\":0}],\"scenes\":[{\"nodes\":[0]}]}", 0);
    TRI_ERR("node", TRI_MESH "\"nodes\":[{\"children\":[1]},{\"mesh\":0}],\"scenes\":[{\"nodes\":[0,1]}]}", 0);   /* shared */
    TRI_ERR("node", TRI_MESH "\"nodes\":[{\"children\":[4]}],\"scenes\":[{\"nodes\":[0]}]}", 0);
    TRI_ERR("mesh", TRI_MESH "\"nodes\":[{\"mesh\":3}],\"scenes\":[{\"nodes\":[0]}]}", 0);
    /* a 100-deep chain is fine (the depth limit is FW_GLTF_MAX_NODE_DEPTH = 256) */
    char nodes[8192] = "\"nodes\":[";
    for (int i = 0; i < 100; i++) {
        char one[64];
        if (i < 99) snprintf(one, sizeof one, "{\"children\":[%d],\"translation\":[0.01,0,0]},", i + 1);
        else snprintf(one, sizeof one, "{\"mesh\":0}");
        strcat(nodes, one);
    }
    strcat(nodes, "],\"scenes\":[{\"nodes\":[0]}]}");
    char *rest = (char *)malloc(strlen(TRI_MESH) + strlen(nodes) + 1);
    strcpy(rest, TRI_MESH); strcat(rest, nodes);
    FwMesh m; FwMeshError e;
    Opt o = NO;
    CHECK_EQ(tri_opt(rest, o, &m, &e), 1);
    if (m.verts) CHECK(fabsf(m.verts[0].pos[0] - 0.99f) < 1e-4f);
    fw_mesh_free(&m);
    free(rest);
    /* deeper than FW_GLTF_MAX_NODE_DEPTH: an error, not a stack overflow */
    size_t cap = 64 * (FW_GLTF_MAX_NODE_DEPTH + 10) + 256;
    char *deep = (char *)malloc(cap);
    strcpy(deep, TRI_MESH "\"nodes\":[");
    for (int i = 0; i <= FW_GLTF_MAX_NODE_DEPTH; i++) {
        char one[64];
        snprintf(one, sizeof one, i < FW_GLTF_MAX_NODE_DEPTH ? "{\"children\":[%d]}," : "{\"mesh\":0}", i + 1);
        strcat(deep, one);
    }
    strcat(deep, "],\"scenes\":[{\"nodes\":[0]}]}");
    CHECK_EQ(tri_opt(deep, o, &m, &e), 0);
    CHECK(strstr(e.text, "deep") != NULL);
    free(deep);
}

TEST(gltf_then_to_game_axes_keeps_front_faces) {
    FwMesh m; FwMeshError e;
    TRI_OK(TRI_MESH ONE_NODE, .nodex = ",\"rotation\":[0.2,0.3,0.1,0.927]");
    CHECK(windings_match_normals(&m));
    fw_mesh_to_game_axes(&m, 2.0f);
    CHECK(windings_match_normals(&m));
    fw_mesh_free(&m);
}

int main(void) { return MT_RUN_ALL(); }
