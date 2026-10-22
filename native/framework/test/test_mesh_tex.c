/* Host-side tests for the pure texture / palette rules of the mesh path (src/fw_mesh_tex.c; 3D phase M2/M3):
 * the texture name rule and the convention, the PNG header gate in front of App_GetTexture (which crashes on a missing
 * file and cannot sample a grey PNG in a core context), the palette row rule, the record-time cache, the GL name at
 * Texture2D+OFF_TEX2D_GLNAME, the per-draw material plan and the object log line; and the GL helper that binds the
 * plan's units inside the saved state (src/fw_gl_state.c fw_gl_bind_units) against a fake GL.
 * In-game: mods/dev-sandbox/tests/mesh-probe.mewtest with MEWFW_MESH_PROBE_MODEL / _TEXTURE / _PALETTE (T2). */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>
#include "../../test/minitest.h"
#include "fw_mesh_tex.h"
#include "fw_gl_state.h"
#include "offsets.h"

TEST(tex_name_rule) {
    CHECK_EQ(fw_tex_name_ok("models/crate.png"), 1);
    CHECK_EQ(fw_tex_name_ok("palette.png"), 1);
    CHECK_EQ(fw_tex_name_ok("models/props/a-b_c.1.png"), 1);
    CHECK_EQ(fw_tex_name_ok(NULL), 0);
    CHECK_EQ(fw_tex_name_ok(""), 0);
    CHECK_EQ(fw_tex_name_ok("models/crate.jpg"), 0);       /* PNG only */
    CHECK_EQ(fw_tex_name_ok("models/crate.PNG"), 0);
    CHECK_EQ(fw_tex_name_ok(".png"), 0);                   /* no stem */
    CHECK_EQ(fw_tex_name_ok("/models/crate.png"), 0);
    CHECK_EQ(fw_tex_name_ok("models//crate.png"), 0);
    CHECK_EQ(fw_tex_name_ok("models/../crate.png"), 0);
    CHECK_EQ(fw_tex_name_ok("./crate.png"), 0);
    CHECK_EQ(fw_tex_name_ok("models\\crate.png"), 0);
    CHECK_EQ(fw_tex_name_ok("C:/crate.png"), 0);
    CHECK_EQ(fw_tex_name_ok("models/cr ate.png"), 0);
    char longname[80];
    memset(longname, 'a', sizeof longname); memcpy(longname + 60, ".png", 5);   /* 64 chars */
    CHECK_EQ(fw_tex_name_ok(longname), 0);
    memcpy(longname + 59, ".png", 5);                                          /* 63 chars */
    CHECK_EQ(fw_tex_name_ok(longname), 1);
}

TEST(tex_default_name_is_models_stem_png) {
    char out[64];
    CHECK_EQ(fw_tex_default_name("models/crate.obj", out, sizeof out), 1);  CHECK_STR(out, "models/crate.png");
    CHECK_EQ(fw_tex_default_name("models/pillar.glb", out, sizeof out), 1); CHECK_STR(out, "models/pillar.png");
    CHECK_EQ(fw_tex_default_name("models/props/barrel.gltf", out, sizeof out), 1); CHECK_STR(out, "models/barrel.png");
    CHECK_EQ(fw_tex_default_name("crate.obj", out, sizeof out), 0);          CHECK_STR(out, "");
    CHECK_EQ(fw_tex_default_name("models/crate.fbx", out, sizeof out), 0);
    CHECK_EQ(fw_tex_default_name("models/crate.obj", out, 10), 0);           /* does not fit */
    CHECK_EQ(fw_tex_default_name(NULL, out, sizeof out), 0);
}

TEST(tex_choose_explicit_then_convention) {
    FwTexChoice c;
    CHECK_EQ(fw_tex_choose(NULL, "models/crate.obj", 0, &c), 1);
    CHECK_STR(c.name, "models/crate.png"); CHECK_STR(c.path, "textures/models/crate.png");
    CHECK_EQ(c.named, 0); CHECK_EQ(c.explicitName, 0);
    CHECK_EQ(fw_tex_choose("", "models/pillar.glb", 1, &c), 1);              /* the glTF material named an image */
    CHECK_STR(c.name, "models/pillar.png"); CHECK_EQ(c.named, 1); CHECK_EQ(c.explicitName, 0);
    CHECK_EQ(fw_tex_choose("models/wood.png", "models/crate.obj", 0, &c), 1);
    CHECK_STR(c.name, "models/wood.png"); CHECK_STR(c.path, "textures/models/wood.png");
    CHECK_EQ(c.named, 1); CHECK_EQ(c.explicitName, 1);
    CHECK_EQ(fw_tex_choose("../x.png", "models/crate.obj", 0, &c), 0);       /* an invalid explicit name is not replaced */
    CHECK_EQ(fw_tex_choose(NULL, "nope", 0, &c), 0);
}

/* a minimal PNG header: signature + IHDR (w, h, depth, colour type) */
static size_t png_header(uint8_t *b, uint32_t w, uint32_t h, uint8_t depth, uint8_t ctype) {
    static const uint8_t sig[8] = { 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n' };
    memcpy(b, sig, 8);
    b[8] = 0; b[9] = 0; b[10] = 0; b[11] = 13;
    memcpy(b + 12, "IHDR", 4);
    b[16] = (uint8_t)(w >> 24); b[17] = (uint8_t)(w >> 16); b[18] = (uint8_t)(w >> 8); b[19] = (uint8_t)w;
    b[20] = (uint8_t)(h >> 24); b[21] = (uint8_t)(h >> 16); b[22] = (uint8_t)(h >> 8); b[23] = (uint8_t)h;
    b[24] = depth; b[25] = ctype; b[26] = 0; b[27] = 0; b[28] = 0;
    memset(b + 29, 0, 4);   /* crc: not checked (stb_image does not either by default) */
    return 33;
}

TEST(png_check_gates_what_app_gettexture_can_upload) {
    uint8_t b[64]; char why[96]; int w = -1, h = -1;
    size_t n = png_header(b, 16, 256, 8, 6);
    CHECK_EQ(fw_png_check(b, n, &w, &h, why, sizeof why), FW_PNG_OK); CHECK_EQ(w, 16); CHECK_EQ(h, 256);
    n = png_header(b, 64, 32, 8, 2);
    CHECK_EQ(fw_png_check(b, n, &w, &h, why, sizeof why), FW_PNG_OK); CHECK_EQ(w, 64); CHECK_EQ(h, 32);
    n = png_header(b, 16, 16, 8, 0);                                          /* grey: GL_LUMINANCE */
    CHECK_EQ(fw_png_check(b, n, &w, &h, why, sizeof why), FW_PNG_FORMAT); CHECK(strstr(why, "colour type 0") != NULL);
    n = png_header(b, 16, 16, 8, 4);                                          /* grey + alpha */
    CHECK_EQ(fw_png_check(b, n, &w, &h, why, sizeof why), FW_PNG_FORMAT);
    n = png_header(b, 16, 16, 8, 3);                                          /* indexed */
    CHECK_EQ(fw_png_check(b, n, &w, &h, why, sizeof why), FW_PNG_FORMAT);
    n = png_header(b, 16, 16, 16, 6);                                         /* 16-bit */
    CHECK_EQ(fw_png_check(b, n, &w, &h, why, sizeof why), FW_PNG_FORMAT); CHECK(strstr(why, "bit depth 16") != NULL);
    n = png_header(b, 4096, 16, 8, 6);
    CHECK_EQ(fw_png_check(b, n, &w, &h, why, sizeof why), FW_PNG_SIZE);
    n = png_header(b, 0, 16, 8, 6);
    CHECK_EQ(fw_png_check(b, n, &w, &h, why, sizeof why), FW_PNG_SIZE);
    n = png_header(b, 16, 16, 8, 6);
    CHECK_EQ(fw_png_check(b, 20, &w, &h, why, sizeof why), FW_PNG_NOT_PNG);   /* truncated */
    b[1] = 'J';
    CHECK_EQ(fw_png_check(b, n, &w, &h, why, sizeof why), FW_PNG_NOT_PNG);
    b[1] = 'P'; memcpy(b + 12, "IDAT", 4);
    CHECK_EQ(fw_png_check(b, n, &w, &h, why, sizeof why), FW_PNG_NOT_PNG);   /* IHDR must come first */
    CHECK_EQ(fw_png_check(NULL, 0, &w, &h, why, sizeof why), FW_PNG_NOT_PNG);
    CHECK_EQ(fw_png_check(b, n, NULL, NULL, NULL, 0), FW_PNG_NOT_PNG);        /* NULL outputs are fine */
}

TEST(palette_row_rule) {
    CHECK_EQ(fw_palette_row(-1, 256), -1);
    CHECK_EQ(fw_palette_row(-7, 256), -1);
    CHECK_EQ(fw_palette_row(0, 256), 0);
    CHECK_EQ(fw_palette_row(63, 256), 63);
    CHECK_EQ(fw_palette_row(255, 256), 255);
    CHECK_EQ(fw_palette_row(256, 256), -1);
    CHECK_EQ(fw_palette_row(5, 0), -1);    /* no palette texture */
}

TEST(tex_cache_by_name) {
    static FwTexCache c;
    memset(&c, 0, sizeof c);
    CHECK(fw_tex_cache_get(&c, "models/crate.png", 0) == NULL);
    FwTexEntry *e = fw_tex_cache_get(&c, "models/crate.png", 1);
    CHECK(e != NULL);
    if (!e) return;
    CHECK_EQ(e->state, FW_TEX_UNKNOWN);
    e->state = FW_TEX_LOADED;
    CHECK(fw_tex_cache_get(&c, "models/crate.png", 1) == e);
    CHECK(fw_tex_cache_get(&c, "models/crate.png", 0) == e);
    CHECK_EQ(c.count, 1);
    CHECK(fw_tex_cache_get(&c, "", 1) == NULL);
    CHECK(fw_tex_cache_get(&c, NULL, 1) == NULL);
    char name[16];
    for (int i = 1; i < FW_TEX_CACHE_MAX; i++) { snprintf(name, sizeof name, "t%d.png", i); CHECK(fw_tex_cache_get(&c, name, 1) != NULL); }
    CHECK(fw_tex_cache_get(&c, "one-too-many.png", 1) == NULL);
    CHECK(fw_tex_cache_get(&c, "models/crate.png", 1) == e);
}

TEST(tex_gl_name_at_texture2d_plus_8) {
#ifndef OFF_TEX2D_GLNAME
    MT_FAIL("%s", "OFF_TEX2D_GLNAME missing from offsets.h (bindings/25143593.json Texture2D_glName)");
#else
    CHECK_EQ(OFF_TEX2D_GLNAME, 0x8);
    uint8_t tex[0x20];
    memset(tex, 0xee, sizeof tex);
    uint32_t id = 4242;
    memcpy(tex + OFF_TEX2D_GLNAME, &id, 4);
    CHECK_EQ(fw_tex_gl_name(tex), 4242);
    id = 0;
    memcpy(tex + OFF_TEX2D_GLNAME, &id, 4);
    CHECK_EQ(fw_tex_gl_name(tex), 0);
    CHECK_EQ(fw_tex_gl_name(NULL), 0);
#endif
}

TEST(material_plan) {
    FwMeshMaterialPlan p;
    fw_mesh_material_plan(0, 0, -1, &p);
    CHECK_EQ(p.hasTex, 0); CHECK_EQ(p.palette, -1); CHECK_EQ(p.units[0], 0); CHECK_EQ(p.units[1], 0);
    fw_mesh_material_plan(77, 0, -1, &p);
    CHECK_EQ(p.hasTex, 1); CHECK_EQ(p.palette, -1); CHECK_EQ(p.units[FW_MESH_TEX_UNIT], 77); CHECK_EQ(p.units[FW_MESH_PALETTE_UNIT], 0);
    fw_mesh_material_plan(77, 88, 63, &p);
    CHECK_EQ(p.hasTex, 1); CHECK_EQ(p.palette, 63); CHECK_EQ(p.units[FW_MESH_PALETTE_UNIT], 88);
    fw_mesh_material_plan(0, 88, 63, &p);   /* palette without a texture: the base colour is remapped */
    CHECK_EQ(p.hasTex, 0); CHECK_EQ(p.palette, 63); CHECK_EQ(p.units[FW_MESH_TEX_UNIT], 0); CHECK_EQ(p.units[FW_MESH_PALETTE_UNIT], 88);
    fw_mesh_material_plan(77, 0, 63, &p);   /* palette not uploaded yet: off for this frame */
    CHECK_EQ(p.palette, -1); CHECK_EQ(p.units[FW_MESH_PALETTE_UNIT], 0);
    fw_mesh_material_plan(77, 88, -1, &p);  /* row off: palettemap unbound */
    CHECK_EQ(p.palette, -1); CHECK_EQ(p.units[FW_MESH_PALETTE_UNIT], 0);
    CHECK_EQ(FW_MESH_TEX_UNIT, 0); CHECK_EQ(FW_MESH_PALETTE_UNIT, 1);
    CHECK(FW_MESH_PALETTE_UNIT < FW_GL_SAVED_UNITS);   /* every unit a draw binds is saved and restored */
}

TEST(object_log_line) {
    char buf[256];
    const float w[3] = { 4.5f, 0, 3.5f }, ndc[3] = { 0.1234f, -0.2f, 0.04f };
    int n = fw_mesh_fmt_object(buf, sizeof buf, 61, 1, "models/crate.obj", 1, w, ndc, "models/crate.png", 63);
    CHECK_STR(buf, "mesh object f=61 handle=1 model=models/crate.obj tile world=(4.50 0.00 3.50) ndc=(0.123 -0.2 0.04) tex=models/crate.png palette=63");
    CHECK_EQ(n, (int)strlen(buf));
    fw_mesh_fmt_object(buf, sizeof buf, 1, 2, "models/pillar.glb", 0, w, ndc, NULL, -1);
    CHECK_STR(buf, "mesh object f=1 handle=2 model=models/pillar.glb unit world=(4.50 0.00 3.50) ndc=(0.123 -0.2 0.04) tex=none palette=-1");
    n = fw_mesh_fmt_object(buf, 12, 1, 2, "models/pillar.glb", 0, w, ndc, NULL, -1);
    CHECK_EQ(n, 11); CHECK_EQ((int)strlen(buf), 11);
}

/* ---- fw_gl_bind_units against a fake GL that records unit bindings ---- */
static int32_t g_active = FW_GL_TEXTURE0 + 5, g_units[8];
static char g_log[512]; static int g_loglen;
static void gl_log(const char *s) { int n = (int)strlen(s); if (g_loglen + n + 1 < (int)sizeof g_log) { memcpy(g_log + g_loglen, s, n); g_loglen += n; g_log[g_loglen++] = ';'; g_log[g_loglen] = 0; } }
static void f_ActiveTexture(uint32_t u) { g_active = (int32_t)u; char s[32]; snprintf(s, sizeof s, "Active%d", (int)(u - FW_GL_TEXTURE0)); gl_log(s); }
static void f_BindTexture(uint32_t t, uint32_t x) { if (t == FW_GL_TEXTURE_2D) g_units[g_active - FW_GL_TEXTURE0] = (int32_t)x; gl_log("Bind"); }

TEST(gl_bind_units_binds_each_saved_unit_and_leaves_unit0_active) {
    FwGlFns f;
    memset(&f, 0, sizeof f);
    f.ActiveTexture = f_ActiveTexture; f.BindTexture = f_BindTexture;
    for (int i = 0; i < 8; i++) g_units[i] = 500 + i;
    g_loglen = 0; g_log[0] = 0;
    FwMeshMaterialPlan p;
    fw_mesh_material_plan(77, 88, 63, &p);
    fw_gl_bind_units(&f, p.units);
    CHECK_EQ(g_units[0], 77); CHECK_EQ(g_units[1], 88);
    for (int i = 2; i < 8; i++) CHECK_EQ(g_units[i], 500 + i);    /* only the saved units are touched */
    CHECK_EQ(g_active, FW_GL_TEXTURE0);
    CHECK_STR(g_log, "Active1;Bind;Active0;Bind;");             /* unit 0 last: it stays the active unit */
}

int main(void) { return MT_RUN_ALL(); }
