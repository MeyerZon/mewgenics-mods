/* Host-side tests for a model's OWN texture (src/fw_mesh_embtex.c; 3D phase M3): the source precedence (explicit >
 * embedded > convention), the record-time decode of the committed sample mods/fw-3d/models/totem.glb (its PNG lives in
 * the BIN chunk; fw_mesh_gltf.c hands the bytes over on the mesh), the refusal codes, the replay-time upload against a
 * fake GL (Texture2D_LoadFromFile's parameters, and every GL value it touches put back) and the load log lines.
 * In-game: SCRATCH mesh3 glb T2 (MEWFW_MESH_PROBE_MODEL=models/totem.glb, no textures/models/totem.png). */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include "../../test/minitest.h"
#include "fw_mesh_embtex.h"
#include "fw_mesh_rules.h"
#include "fw_png.h"

static uint8_t *read_file(const char *rel, size_t *len) {
    char path[1024];
    const char *f = __FILE__, *slash = NULL;
    for (const char *p = f; *p; p++) if (*p == '/' || *p == '\\') slash = p;
    size_t dir = slash ? (size_t)(slash - f + 1) : 0;
    if (dir + strlen(rel) + 1 > sizeof path) return NULL;
    memcpy(path, f, dir); strcpy(path + dir, rel);
    FILE *fp = fopen(path, "rb");
    if (!fp) { printf("      cannot open %s\n", path); return NULL; }
    fseek(fp, 0, SEEK_END); long sz = ftell(fp); fseek(fp, 0, SEEK_SET);
    uint8_t *b = (uint8_t *)malloc(sz > 0 ? (size_t)sz : 1);
    *len = fread(b, 1, (size_t)(sz > 0 ? sz : 0), fp);
    fclose(fp);
    return b;
}

TEST(source_precedence_explicit_then_embedded_then_convention) {
    CHECK_EQ(fw_tex_source("models/crate.png", 1), FW_TEXSRC_EXPLICIT);
    CHECK_EQ(fw_tex_source("models/crate.png", 0), FW_TEXSRC_EXPLICIT);
    CHECK_EQ(fw_tex_source("", 1), FW_TEXSRC_EMBEDDED);
    CHECK_EQ(fw_tex_source(NULL, 1), FW_TEXSRC_EMBEDDED);
    CHECK_EQ(fw_tex_source(NULL, 0), FW_TEXSRC_CONVENTION);
    CHECK_STR(fw_tex_source_name(FW_TEXSRC_EXPLICIT), "explicit");
    CHECK_STR(fw_tex_source_name(FW_TEXSRC_EMBEDDED), "embedded");
    CHECK_STR(fw_tex_source_name(FW_TEXSRC_CONVENTION), "convention");
    CHECK_STR(fw_tex_source_name(99), "none");
}

/* the totem's embedded image, through the real glTF loader */
static int totem(FwMesh *m) {
    size_t n = 0;
    uint8_t *glb = read_file("../../../mods/fw-3d/models/totem.glb", &n);
    if (!glb) return 0;
    FwMeshError e;
    int ok = fw_mesh_gltf_parse(glb, n, NULL, NULL, m, &e);
    if (!ok) printf("      totem.glb: %s\n", e.text);
    free(glb);
    return ok;
}

TEST(totem_glb_carries_its_png_and_decodes_to_the_checker) {
    FwMesh m;
    if (!totem(&m)) { MT_FAIL("%s", "totem.glb did not load"); return; }
    CHECK_STR(m.texture, "embedded:4");
    CHECK(m.image != NULL);
    CHECK(m.image_len > 8 && memcmp(m.image, "\x89PNG", 4) == 0);
    FwEmbTex t;
    memset(&t, 0, sizeof t);
    CHECK_EQ(fw_embtex_decode(&t, "models/totem.glb", m.image, m.image_len), FW_EMB_DECODED);
    CHECK_STR(t.name, "embedded:models/totem.glb");
    CHECK_EQ(t.w, 16); CHECK_EQ(t.h, 16);
    /* editor/src/core/art/fw3d-assets.ts TOTEM: cell (0,0) purple 150,40,210, cell (1,0) lime 150,225,30; opaque, so
     * premultiplying changes nothing */
    CHECK(t.rgba != NULL);
    if (t.rgba) {
        static const uint8_t purple[4] = { 150, 40, 210, 255 }, lime[4] = { 150, 225, 30, 255 };
        CHECK_MEM(t.rgba, purple, 4);
        CHECK_MEM(t.rgba + 8 * 4, lime, 4);
        CHECK_MEM(t.rgba + (8 * 16 + 8) * 4, purple, 4);
    }
    CHECK_EQ(fw_embtex_decode(&t, "models/other.glb", NULL, 0), FW_EMB_DECODED);   /* decoded once: a second call is a no-op */
    fw_embtex_free(&t);
    CHECK_EQ(t.state, FW_EMB_UNKNOWN); CHECK(t.rgba == NULL);
    fw_mesh_free(&m);
    CHECK(m.image == NULL);
}

TEST(decode_refusals_carry_the_codes) {
    FwEmbTex t;
    char line[400];
    size_t n = 0;
    uint8_t *b = read_file("fixtures/png/interlaced.png", &n);
    memset(&t, 0, sizeof t);
    CHECK_EQ(fw_embtex_decode(&t, "models/a.glb", b, n), FW_EMB_REFUSED);
    CHECK_STR(t.code, "model-image-embedded-unsupported");
    CHECK(strstr(t.why, "interlaced") != NULL);
    fw_embtex_fmt_load(line, sizeof line, "models/a.glb", &t);
    CHECK_STR(line, "mesh: model models/a.glb: model-image-embedded-unsupported: embedded image: interlaced (Adam7) images are not decoded; re-export without interlacing: the convention texture or the base colour draws");
    free(b);
    b = read_file("fixtures/png/bad-crc.png", &n);
    memset(&t, 0, sizeof t);
    CHECK_EQ(fw_embtex_decode(&t, "models/a.glb", b, n), FW_EMB_REFUSED);
    CHECK_STR(t.code, "model-image-embedded-invalid");
    free(b);
    memset(&t, 0, sizeof t);
    CHECK_EQ(fw_embtex_decode(&t, "models/a.glb", (const uint8_t *)"\xff\xd8\xff\xe0JFIF", 8), FW_EMB_REFUSED);   /* a JPEG */
    CHECK_STR(t.code, "model-image-embedded-invalid");
    CHECK_EQ(fw_embtex_upload(&t, NULL), 0);
    CHECK_STR(fw_mesh_code_severity("model-image-embedded-invalid"), "warning");
    CHECK_STR(fw_mesh_code_severity("model-image-embedded-unsupported"), "warning");
}

/* ---- a fake GL that keeps the state the upload touches and records the calls ---- */
static int32_t g_bound2d = 7, g_align = 4, g_unpackBuf = 0;
static uint32_t g_nextName = 41;
static char g_calls[1024];
static int g_texW, g_texH, g_texFmt;
static const void *g_texPixels;
static uint8_t g_firstTexel[4];
static void rec(const char *s) { if (strlen(g_calls) + strlen(s) + 2 < sizeof g_calls) { strcat(g_calls, s); strcat(g_calls, " "); } }
static void f_get(uint32_t p, int32_t *o) {
    *o = p == 0x8069 ? g_bound2d : p == FW_GL_UNPACK_ALIGNMENT ? g_align : p == FW_GL_PIXEL_UNPACK_BUFFER_BINDING ? g_unpackBuf : -1;
}
static void f_gen(int n, uint32_t *o) { (void)n; *o = g_nextName; rec("gen"); }
static void f_bind(uint32_t t, uint32_t x) { char b[32]; snprintf(b, sizeof b, "bind%x:%u", t, x); rec(b); g_bound2d = (int32_t)x; }
static void f_store(uint32_t p, int32_t v) { char b[32]; snprintf(b, sizeof b, "store%x:%d", p, v); rec(b); if (p == FW_GL_UNPACK_ALIGNMENT) g_align = v; }
static void f_img(uint32_t t, int l, int32_t ifmt, int w, int h, int border, uint32_t fmt, uint32_t type, const void *px) {
    (void)t; (void)l; (void)border; (void)type;
    char b[48]; snprintf(b, sizeof b, "img%dx%d:%x/%x@%d", w, h, (unsigned)ifmt, fmt, g_align); rec(b);
    g_texW = w; g_texH = h; g_texFmt = (int)fmt; g_texPixels = px;
    if (px) memcpy(g_firstTexel, px, 4);
}
static void f_par(uint32_t t, uint32_t p, int32_t v) { (void)t; char b[32]; snprintf(b, sizeof b, "par%x=%x", p, (unsigned)v); rec(b); }
static void f_buf(uint32_t t, uint32_t x) { char b[32]; snprintf(b, sizeof b, "buf%x:%u", t, x); rec(b); g_unpackBuf = (int32_t)x; }
static const FwTexUploadGl FAKE = { f_get, f_gen, f_bind, f_store, f_img, f_par, f_buf };

TEST(upload_once_like_texture2d_and_put_every_value_back) {
    FwMesh m;
    if (!totem(&m)) { MT_FAIL("%s", "totem.glb did not load"); return; }
    FwEmbTex t;
    memset(&t, 0, sizeof t);
    fw_embtex_decode(&t, "models/totem.glb", m.image, m.image_len);
    g_calls[0] = 0; g_bound2d = 7; g_align = 4; g_unpackBuf = 0;
    CHECK_EQ(fw_embtex_upload(&t, &FAKE), 41);
    CHECK_STR(g_calls, "gen bindde1:41 storecf5:1 img16x16:1908/1908@1 par2801=2601 par2800=2601 par2802=2901 par2803=2901 storecf5:4 bindde1:7 ");
    CHECK_EQ(g_texW, 16); CHECK_EQ(g_texFmt, 0x1908);
    CHECK_EQ(g_firstTexel[0], 150); CHECK_EQ(g_firstTexel[1], 40); CHECK_EQ(g_firstTexel[2], 210); CHECK_EQ(g_firstTexel[3], 255);
    CHECK_EQ(g_bound2d, 7); CHECK_EQ(g_align, 4);
    CHECK_EQ(t.state, FW_EMB_UPLOADED); CHECK(t.rgba == NULL); CHECK_EQ(t.gl, 41);
    g_calls[0] = 0;
    CHECK_EQ(fw_embtex_upload(&t, &FAKE), 41);                    /* once */
    CHECK_STR(g_calls, "");
    char line[400];
    fw_embtex_fmt_load(line, sizeof line, "models/totem.glb", &t);
    CHECK_STR(line, "mesh: texture embedded:models/totem.glb for models/totem.glb: decoded 16x16 (source embedded: the model file's own image, decoded in the DLL, uploaded at replay)");
    /* a bound pixel-unpack buffer is unbound for the upload and put back */
    FwEmbTex u;
    memset(&u, 0, sizeof u);
    fw_embtex_decode(&u, "models/totem.glb", m.image, m.image_len);
    g_calls[0] = 0; g_unpackBuf = 5; g_nextName = 42;
    CHECK_EQ(fw_embtex_upload(&u, &FAKE), 42);
    CHECK(strncmp(g_calls, "gen buf88ec:0 ", 14) == 0);
    CHECK(strstr(g_calls, "bindde1:7 buf88ec:5 ") != NULL);
    CHECK_EQ(g_unpackBuf, 5);
    /* glGenTextures yielding 0 refuses the texture and frees its pixels */
    FwEmbTex z;
    memset(&z, 0, sizeof z);
    fw_embtex_decode(&z, "models/totem.glb", m.image, m.image_len);
    g_nextName = 0; g_unpackBuf = 0;
    CHECK_EQ(fw_embtex_upload(&z, &FAKE), 0);
    CHECK_EQ(z.state, FW_EMB_REFUSED); CHECK(z.rgba == NULL);
    g_nextName = 41;
    fw_mesh_free(&m);
}

int main(void) { return MT_RUN_ALL(); }
