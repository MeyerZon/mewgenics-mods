/* Host-side tests for the pure parts of the M1 mesh path (docs/possible_3d_work.md phase M): the 4x4 maths
 * (src/fw_m4.c) checked against the T2 observer's OBSERVED matrices (editor/test/fixtures/ingame/observe3d-log.txt),
 * the MSVC std::function<void()> built in C (src/fw_functor.c) driven by a fake engine that does what
 * Batch_SubmitFunctor 0xa47820 and Batch_Replay 0xa481d0 do (notes-r3dA G1), the GL save/restore (src/fw_gl_state.c)
 * against a fake GL, and the probe setting / layer predicate / stack read / log line (src/fw_mesh_draw.c).
 * The draw itself (mesh_engine.c) is verified in-game (T2: mods/fw-3d/tests/mesh-probe.mewtest). */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include "../../test/minitest.h"
#include "fw_m4.h"
#include "fw_functor.h"
#include "fw_gl_state.h"
#include "fw_mesh_draw.h"
#include "offsets.h"

#define NEAR(a, b, eps) (fabs((double)(a) - (double)(b)) <= (eps))
#define CHECK_NEAR(a, b, eps) do { double _x = (double)(a), _y = (double)(b); if (!NEAR(_x, _y, eps)) MT_FAIL("CHECK_NEAR failed: %s = %.6f, expected %.6f", #a, _x, _y); } while (0)

/* ---- the OBSERVED matrices (observe3d-log.txt, T2 2026-10-22) ---- */
/* obs3d globals iso=[...] */
static const float ISO[16] = { 0.894427f, 0.447214f, 0, 0,  0, 1, 0, 0,  -0.894427f, 0.447214f, 1, 0,  0, 0, 0, 1 };
/* obs3d cam f=1 world=1 vp=[...] (zoom 78.2624, flip -1, Position scale 1.15) */
static const float VP_F1[16] = { 68.0542f, 0, 0, 0,  0, -68.0542f, 0, 0,  0, 0, 1, 0,  640, 664.348f, 0, 1 };
/* obs3d item f=1 layer=0x19 pos=(2.5 5.5): Renderer_GetScreenMatrix m12/m13 */
#define UNIT_X 2.5
#define UNIT_Z 5.5
#define UNIT_M12 (-2.68328)
#define UNIT_M13 3.57771

/* MatStack_Ortho 0x9fec80's formula (OBSERVED decompile) with L, R, B, T = 0, 1280, 720, 0 (INFERRED: FrameBegin reads
 * them from 0x1413c5c04..10; the engine logs the real stack top in-game) */
static void base_ortho(float L, float R, float B, float T, float o[16]) {
    memset(o, 0, 16 * sizeof(float));
    o[0] = 2.0f / (R - L); o[5] = 2.0f / (T - B); o[10] = 1e-4f;
    o[12] = -(L + R) / (R - L); o[13] = -(B + T) / (T - B); o[14] = -0.0f; o[15] = 1;
}

TEST(m4_identity_and_mul_order) {
    float I[16], a[16], b[16], o[16];
    fw_m4_identity(I);
    for (int i = 0; i < 16; i++) CHECK_EQ(I[i], (i % 5 == 0) ? 1 : 0);
    fw_m4_identity(a); a[12] = 5;      /* translate x by 5 */
    fw_m4_identity(b); b[0] = 2;       /* scale x by 2 */
    fw_m4_mul(a, b, o);                /* a x b: scale first, then translate */
    float p[4] = { 1, 0, 0, 1 }, q[4];
    fw_m4_apply(o, p, q);
    CHECK_NEAR(q[0], 7, 1e-6);
    fw_m4_mul(b, a, o);                /* translate first, then scale */
    fw_m4_apply(o, p, q);
    CHECK_NEAR(q[0], 12, 1e-6);
    fw_m4_mul(I, VP_F1, o);
    for (int i = 0; i < 16; i++) CHECK_NEAR(o[i], VP_F1[i], 1e-6);
    float al[16]; memcpy(al, VP_F1, sizeof al);
    fw_m4_mul(al, b, al);              /* aliasing the output with an input */
    CHECK_NEAR(al[0], 2 * 68.0542, 1e-3);
    CHECK_NEAR(al[12], 640, 1e-3);
}

TEST(m4_inverse_roundtrip_and_singular) {
    float inv[16], o[16];
    CHECK_EQ(fw_m4_inverse(VP_F1, inv), 1);
    fw_m4_mul(VP_F1, inv, o);
    for (int i = 0; i < 16; i++) CHECK_NEAR(o[i], (i % 5 == 0) ? 1 : 0, 1e-5);
    float z[16] = { 0 }, keep[16];
    for (int i = 0; i < 16; i++) keep[i] = inv[i];
    CHECK_EQ(fw_m4_inverse(z, inv), 0);
    for (int i = 0; i < 16; i++) CHECK_EQ(inv[i], keep[i]);
}

TEST(m4_observed_world_vp_has_negative_det) {
    CHECK(fw_m4_det(VP_F1) < 0);                     /* flip -1: Mat4_IsMirrored stays quiet only with det < 0 */
    CHECK_NEAR(fw_m4_det(VP_F1), -68.0542 * 68.0542, 1e-1);
}

TEST(m4_view_dir_is_yaw45_pitch30_into_the_screen) {
    float d[3];
    fw_m4_view_dir(d);
    CHECK_NEAR(d[0], 0.612372, 1e-5);
    CHECK_NEAR(d[1], -0.5, 1e-6);
    CHECK_NEAR(d[2], 0.612372, 1e-5);
    CHECK_NEAR(d[0] * d[0] + d[1] * d[1] + d[2] * d[2], 1, 1e-6);
}

TEST(m4_place_reproduces_the_observed_unit_screen_matrix) {
    /* the T2 unit at world (2.5, 5.5) on the ground: Renderer_GetScreenMatrix gave m12/m13 = (-2.68328, 3.57771) */
    float M[16], q[4], p[4] = { 0, 0, 0, 1 };
    fw_m4_place(ISO, UNIT_X, 0, UNIT_Z, 1, M);
    fw_m4_apply(M, p, q);
    CHECK_NEAR(q[0], UNIT_M12, 1e-4);
    CHECK_NEAR(q[1], UNIT_M13, 1e-4);
    CHECK_NEAR(q[3], 1, 1e-6);
    /* height goes straight up in camera-2D (ISO column 1 = (0, 1)) */
    float up[4] = { 0, 1, 0, 1 }, qu[4];
    fw_m4_apply(M, up, qu);
    CHECK_NEAR(qu[0], UNIT_M12, 1e-4);
    CHECK_NEAR(qu[1], UNIT_M13 + 1, 1e-4);
    /* scale is about the placement point */
    fw_m4_place(ISO, UNIT_X, 0, UNIT_Z, 0.5, M);
    float x1[4] = { 1, 0, 0, 1 }, qx[4];
    fw_m4_apply(M, x1, qx);
    CHECK_NEAR(qx[0], UNIT_M12 + 0.5 * 0.894427, 1e-4);
    CHECK_NEAR(qx[1], UNIT_M13 + 0.5 * 0.447214, 1e-4);
}

TEST(m4_tile_centre_matches_the_tile_picker) {
    double c[3];
    fw_m4_tile_centre(2, 5, c);
    CHECK_NEAR(c[0], UNIT_X, 1e-12); CHECK_NEAR(c[1], 0, 1e-12); CHECK_NEAR(c[2], UNIT_Z, 1e-12);
}

TEST(m4_depth_grows_with_distance_and_shrinks_with_height) {
    float M[16], a[4], b[4], c[4];
    fw_m4_place(ISO, 0, 0, 0, 1, M);
    float near_[4] = { 1, 0, 1, 1 }, far_[4] = { 2, 0, 2, 1 }, high[4] = { 1, 1, 1, 1 };
    fw_m4_apply(M, near_, a); fw_m4_apply(M, far_, b); fw_m4_apply(M, high, c);
    CHECK(b[2] > a[2]);          /* farther = larger z = loses under GL_LESS, like the vanilla x+z "farther first" sort */
    CHECK(c[2] < a[2]);          /* higher = toward the viewer */
    CHECK_NEAR(a[2], FW_M4_DEPTH_SCALE * 2 * 0.612372, 1e-2);
    /* a 20x20 board with 5 units of height stays far inside the base ortho's +-10 000 */
    float corner[4] = { 20, -5, 20, 1 }, cz[4];
    fw_m4_apply(M, corner, cz);
    CHECK(fabs(cz[2]) < 10000);
}

TEST(m4_project_through_the_observed_vp_lands_on_the_canvas) {
    float M[16], mvp[16], ndc[3];
    fw_m4_place(ISO, UNIT_X, 0, UNIT_Z, 1, M);
    fw_m4_mul(VP_F1, M, mvp);
    const float o[3] = { 0, 0, 0 };
    CHECK_EQ(fw_m4_project(mvp, o, ndc), 1);
    CHECK_NEAR(ndc[0], 640 + 68.0542 * UNIT_M12, 1e-2);    /* 457.39 canvas px */
    CHECK_NEAR(ndc[1], 664.348 - 68.0542 * UNIT_M13, 1e-2); /* 420.87 canvas px */
    /* then the base ortho: canvas (0, 0) = top-left = NDC (-1, +1) -> pixel (0, 0) of a shot */
    float B[16], full[16], ndc2[3];
    base_ortho(0, 1280, 720, 0, B);
    fw_m4_mul(B, mvp, full);
    CHECK_EQ(fw_m4_project(full, o, ndc2), 1);
    double px[2];
    fw_m4_ndc_to_pixel(ndc2, 1280, 720, px);
    CHECK_NEAR(px[0], 457.39, 0.05);
    CHECK_NEAR(px[1], 420.87, 0.05);
    fw_m4_ndc_to_pixel(ndc2, 1920, 1080, px);              /* a 1080p shot scales with it */
    CHECK_NEAR(px[0], 457.39 * 1.5, 0.08);
    CHECK_NEAR(px[1], 420.87 * 1.5, 0.08);
    CHECK(fabs(ndc2[2]) < 1);                              /* inside the depth range */
    const float wzero[16] = { 0 };
    CHECK_EQ(fw_m4_project(wzero, o, ndc), 0);
}

/* ---- the functor: a fake engine doing exactly what 0xa47820 / 0xa481d0 / group teardown do ---- */
static int g_calls; static void *g_user;
static void count_call(void *user) { g_calls++; g_user = user; }

typedef struct FakeEngine { unsigned char *recorded; int frees; } FakeEngine;

/* Batch_SubmitFunctor(unused, fn): new 0x40 object, +0x38 = 0, impl->vtbl[0](impl, new) -> +0x38; then
 * arg impl->vtbl[4](impl, impl != arg); arg+0x38 = 0 */
static void fake_submit(FakeEngine *e, FwStdFunction *arg) {
    unsigned char *obj = calloc(1, FW_STD_FUNCTION_SIZE);
    void *impl = arg->implPtr;
    if (!impl || !*(void *const *)impl || !(*(const void *const *const *)impl)[FW_FUNC_SLOT_COPY]) { MT_FAIL("%s", "fake_submit: no impl / no _Copy"); free(obj); return; }
    const void *const *vt = *(const void *const *const *)impl;
    void *copied = ((FwFuncCopyFn)vt[FW_FUNC_SLOT_COPY])(impl, obj);
    *(void **)(obj + FW_STD_FUNCTION_IMPL_OFF) = copied;
    ((FwFuncDeleteFn)vt[FW_FUNC_SLOT_DELETE])(impl, (unsigned char)(impl != (void *)arg));
    arg->implPtr = NULL;
    e->recorded = obj;
}
static void fake_replay(FakeEngine *e) {
    if (!e->recorded) return;
    void *impl = *(void **)(e->recorded + FW_STD_FUNCTION_IMPL_OFF);
    const void *const *vt = *(const void *const *const *)impl;
    ((FwFuncDoCallFn)vt[FW_FUNC_SLOT_DOCALL])(impl);
}
static void fake_teardown(FakeEngine *e) {
    if (!e->recorded) return;
    void *impl = *(void **)(e->recorded + FW_STD_FUNCTION_IMPL_OFF);
    const void *const *vt = *(const void *const *const *)impl;
    ((FwFuncDeleteFn)vt[FW_FUNC_SLOT_DELETE])(impl, (unsigned char)(impl != (void *)e->recorded));
    free(e->recorded); e->frees++; e->recorded = NULL;
}

TEST(functor_layout_is_the_msvc_std_function) {
    CHECK_EQ(sizeof(FwStdFunction), FW_STD_FUNCTION_SIZE);
    CHECK_EQ(offsetof(FwStdFunction, implPtr), FW_STD_FUNCTION_IMPL_OFF);
    CHECK_EQ(offsetof(FwStdFunction, u.impl.vtbl), 0);
    CHECK(sizeof(FwFunctorImpl) <= FW_STD_FUNCTION_IMPL_OFF);
    const void *const *vt = fw_functor_vtable();
    CHECK(vt != NULL);
    for (int i = 0; i < FW_FUNC_SLOTS; i++) CHECK(vt[i] != NULL);
}

TEST(functor_make_points_the_impl_at_its_own_storage) {
    FwStdFunction f;
    int token = 7;
    memset(&f, 0xcc, sizeof f);
    fw_functor_make(&f, count_call, &token);
    CHECK(f.implPtr == (void *)&f.u.impl);
    CHECK(f.u.impl.vtbl == fw_functor_vtable());
    CHECK(f.u.impl.fn == count_call);
    CHECK(f.u.impl.user == &token);
}

TEST(functor_submit_copy_then_replay_runs_ours_once) {
    FakeEngine e = { 0 };
    FwStdFunction f;
    int token = 42;
    g_calls = 0; g_user = NULL;
    fw_functor_make(&f, count_call, &token);
    int before = fw_functor_unexpected_deallocs();
    fake_submit(&e, &f);
    CHECK(f.implPtr == NULL);                                   /* the argument was destroyed by the callee */
    CHECK_EQ(g_calls, 0);                                       /* recording does not run it */
    if (!e.recorded) return;
    void *impl = *(void **)(e.recorded + FW_STD_FUNCTION_IMPL_OFF);
    CHECK(impl == (void *)e.recorded);                          /* _Copy returned `where`: in place */
    memset(&f, 0, sizeof f);                                    /* the caller's stack copy is gone by replay time */
    fake_replay(&e);
    CHECK_EQ(g_calls, 1);
    CHECK(g_user == &token);
    fake_teardown(&e);
    CHECK_EQ(e.frees, 1);
    CHECK_EQ(fw_functor_unexpected_deallocs(), before);         /* in place both times: dealloc = false */
}

TEST(functor_get_and_target_slots_are_harmless) {
    FwStdFunction f;
    fw_functor_make(&f, count_call, NULL);
    const void *const *vt = fw_functor_vtable();
    if (!vt[FW_FUNC_SLOT_GET] || !vt[FW_FUNC_SLOT_TARGET] || !vt[FW_FUNC_SLOT_MOVE] || !vt[FW_FUNC_SLOT_DELETE]) { MT_FAIL("%s", "vtable slots missing"); return; }
    CHECK(((FwFuncGetFn)vt[FW_FUNC_SLOT_GET])(&f.u.impl) == (void *)((unsigned char *)&f.u.impl + 8));
    CHECK(((FwFuncTargetFn)vt[FW_FUNC_SLOT_TARGET])(&f.u.impl) != NULL);
    unsigned char where[FW_STD_FUNCTION_SIZE];
    CHECK(((FwFuncCopyFn)vt[FW_FUNC_SLOT_MOVE])(&f.u.impl, where) == (void *)where);
    CHECK_MEM(where, &f.u.impl, sizeof(FwFunctorImpl));
    int before = fw_functor_unexpected_deallocs();
    ((FwFuncDeleteFn)vt[FW_FUNC_SLOT_DELETE])(&f.u.impl, 1);     /* never frees: counted as a diagnostic */
    CHECK_EQ(fw_functor_unexpected_deallocs(), before + 1);
}

/* ---- the GL state: a fake GL ---- */
typedef struct FakeGl {
    int32_t program, vao, arrayBuffer, indirectBuffer, activeTexture, tex[8];
    uint8_t enabled[0x10000 >> 4];   /* by cap >> 4 is too coarse: index caps directly below */
    uint8_t depthTest, stencilTest, blend, cullFace, scissorTest;
    int32_t depthFunc, cullFaceMode, frontFace;
    uint8_t depthMask, colorMask[4];
    int32_t bsr, bdr, bsa, bda, ber, bea, drawFb, viewport[4];
    uint32_t errors[4]; int nerrors;
    char log[2048]; int loglen;
} FakeGl;
static FakeGl G;
static void glog(const char *s) { int n = (int)strlen(s); if (G.loglen + n + 1 < (int)sizeof G.log) { memcpy(G.log + G.loglen, s, n); G.loglen += n; G.log[G.loglen++] = ';'; G.log[G.loglen] = 0; } }
static uint8_t *cap_ref(uint32_t cap) {
    switch (cap) {
        case FW_GL_DEPTH_TEST: return &G.depthTest; case FW_GL_STENCIL_TEST: return &G.stencilTest;
        case FW_GL_BLEND: return &G.blend; case FW_GL_CULL_FACE: return &G.cullFace; case FW_GL_SCISSOR_TEST: return &G.scissorTest;
        default: return NULL;
    }
}
static void f_GetIntegerv(uint32_t p, int32_t *o) {
    switch (p) {
        case FW_GL_CURRENT_PROGRAM: *o = G.program; break;
        case FW_GL_VERTEX_ARRAY_BINDING: *o = G.vao; break;
        case FW_GL_ARRAY_BUFFER_BINDING: *o = G.arrayBuffer; break;
        case FW_GL_DRAW_INDIRECT_BUFFER_BINDING: *o = G.indirectBuffer; break;
        case FW_GL_ACTIVE_TEXTURE: *o = G.activeTexture; break;
        case FW_GL_TEXTURE_BINDING_2D: *o = G.tex[G.activeTexture - FW_GL_TEXTURE0]; break;
        case FW_GL_DEPTH_FUNC: *o = G.depthFunc; break;
        case FW_GL_CULL_FACE_MODE: *o = G.cullFaceMode; break;
        case FW_GL_FRONT_FACE: *o = G.frontFace; break;
        case FW_GL_BLEND_SRC_RGB: *o = G.bsr; break; case FW_GL_BLEND_DST_RGB: *o = G.bdr; break;
        case FW_GL_BLEND_SRC_ALPHA: *o = G.bsa; break; case FW_GL_BLEND_DST_ALPHA: *o = G.bda; break;
        case FW_GL_BLEND_EQUATION_RGB: *o = G.ber; break; case FW_GL_BLEND_EQUATION_ALPHA: *o = G.bea; break;
        case FW_GL_DRAW_FRAMEBUFFER_BINDING: *o = G.drawFb; break;
        case FW_GL_VIEWPORT: memcpy(o, G.viewport, sizeof G.viewport); break;
        default: *o = -12345; break;
    }
}
static void f_GetBooleanv(uint32_t p, uint8_t *o) {
    if (p == FW_GL_DEPTH_WRITEMASK) *o = G.depthMask;
    else if (p == FW_GL_COLOR_WRITEMASK) memcpy(o, G.colorMask, 4);
}
static uint8_t f_IsEnabled(uint32_t c) { uint8_t *r = cap_ref(c); return r ? *r : 0; }
static void f_Enable(uint32_t c) { uint8_t *r = cap_ref(c); if (r) *r = 1; glog("Enable"); }
static void f_Disable(uint32_t c) { uint8_t *r = cap_ref(c); if (r) *r = 0; glog("Disable"); }
static void f_DepthFunc(uint32_t f) { G.depthFunc = (int32_t)f; }
static void f_DepthMask(uint8_t m) { G.depthMask = m; }
static void f_ColorMask(uint8_t r, uint8_t g, uint8_t b, uint8_t a) { G.colorMask[0] = r; G.colorMask[1] = g; G.colorMask[2] = b; G.colorMask[3] = a; }
static void f_CullFace(uint32_t m) { G.cullFaceMode = (int32_t)m; }
static void f_FrontFace(uint32_t m) { G.frontFace = (int32_t)m; }
static void f_UseProgram(uint32_t p) { G.program = (int32_t)p; glog("UseProgram"); }
static void f_BindVertexArray(uint32_t v) { G.vao = (int32_t)v; glog("BindVertexArray"); }
static void f_BindBuffer(uint32_t t, uint32_t b) {
    if (t == FW_GL_ARRAY_BUFFER) { G.arrayBuffer = (int32_t)b; glog("BindBuffer(ARRAY)"); }
    else if (t == FW_GL_DRAW_INDIRECT_BUFFER) { G.indirectBuffer = (int32_t)b; glog("BindBuffer(INDIRECT)"); }
    else glog("BindBuffer(OTHER)");
}
static void f_ActiveTexture(uint32_t u) { G.activeTexture = (int32_t)u; glog("ActiveTexture"); }
static void f_BindTexture(uint32_t t, uint32_t x) { if (t == FW_GL_TEXTURE_2D) G.tex[G.activeTexture - FW_GL_TEXTURE0] = (int32_t)x; glog("BindTexture"); }
static void f_BlendFuncSeparate(uint32_t a, uint32_t b, uint32_t c, uint32_t d) { G.bsr = (int32_t)a; G.bdr = (int32_t)b; G.bsa = (int32_t)c; G.bda = (int32_t)d; }
static void f_BlendEquationSeparate(uint32_t a, uint32_t b) { G.ber = (int32_t)a; G.bea = (int32_t)b; }
static uint32_t f_GetError(void) { return G.nerrors ? G.errors[--G.nerrors] : FW_GL_NO_ERROR; }

static FwGlFns fake_fns(void) {
    FwGlFns f = { f_GetIntegerv, f_GetBooleanv, f_IsEnabled, f_Enable, f_Disable, f_DepthFunc, f_DepthMask, f_ColorMask,
                  f_CullFace, f_FrontFace, f_UseProgram, f_BindVertexArray, f_BindBuffer, f_ActiveTexture, f_BindTexture,
                  f_BlendFuncSeparate, f_BlendEquationSeparate, f_GetError };
    return f;
}
static void game_state(void) {   /* what a replayed group leaves behind (notes-r3dA G2) */
    memset(&G, 0, sizeof G);
    G.program = 11; G.vao = 22; G.arrayBuffer = 33; G.indirectBuffer = 44; G.activeTexture = FW_GL_TEXTURE0 + 3;
    G.tex[0] = 101; G.tex[1] = 102; G.tex[3] = 103;
    G.depthTest = 0; G.stencilTest = 0; G.blend = 1; G.cullFace = 0; G.scissorTest = 1;
    G.depthFunc = FW_GL_LESS; G.cullFaceMode = FW_GL_BACK; G.frontFace = FW_GL_CCW;
    G.depthMask = 1; G.colorMask[0] = G.colorMask[1] = G.colorMask[2] = G.colorMask[3] = 1;
    G.bsr = 0x302; G.bdr = 0x303; G.bsa = 0x302; G.bda = 0x303; G.ber = 0x8006; G.bea = 0x8006;
    G.drawFb = 7; G.viewport[2] = 1920; G.viewport[3] = 1080;
}
static void our_draw(void) {     /* everything a mesh draw changes */
    G.program = 900; G.vao = 901; G.arrayBuffer = 902; G.indirectBuffer = 0; G.activeTexture = FW_GL_TEXTURE0 + 0;
    G.tex[0] = 903; G.tex[1] = 904;
    G.depthTest = 1; G.blend = 0; G.cullFace = 1; G.stencilTest = 1;
    G.depthFunc = FW_GL_LEQUAL; G.cullFaceMode = FW_GL_FRONT; G.frontFace = FW_GL_CW;
    G.depthMask = 0; G.colorMask[3] = 0;
    G.bsr = 1; G.bdr = 0; G.bsa = 1; G.bda = 0; G.ber = 0x800a; G.bea = 0x800a;
}

TEST(gl_fns_complete_needs_every_pointer) {
    FwGlFns f = fake_fns();
    CHECK_EQ(fw_gl_fns_complete(&f), 1);
    f.DepthFunc = NULL;
    CHECK_EQ(fw_gl_fns_complete(&f), 0);
    CHECK_EQ(fw_gl_fns_complete(NULL), 0);
}

TEST(gl_state_restore_returns_every_queried_value) {
    FwGlFns f = fake_fns();
    game_state();
    FakeGl before = G;
    FwGlState st;
    fw_gl_save(&f, &st);
    CHECK_EQ(st.drawFramebuffer, 7);
    CHECK_EQ(st.viewport[2], 1920);
    our_draw();
    fw_gl_restore(&f, &st);
    CHECK_EQ(G.program, before.program); CHECK_EQ(G.vao, before.vao); CHECK_EQ(G.arrayBuffer, before.arrayBuffer);
    CHECK_EQ(G.indirectBuffer, before.indirectBuffer); CHECK_EQ(G.activeTexture, before.activeTexture);
    for (int u = 0; u < 4; u++) CHECK_EQ(G.tex[u], before.tex[u]);
    CHECK_EQ(G.depthTest, before.depthTest); CHECK_EQ(G.stencilTest, before.stencilTest); CHECK_EQ(G.blend, before.blend);
    CHECK_EQ(G.cullFace, before.cullFace); CHECK_EQ(G.scissorTest, before.scissorTest);
    CHECK_EQ(G.depthFunc, before.depthFunc); CHECK_EQ(G.cullFaceMode, before.cullFaceMode); CHECK_EQ(G.frontFace, before.frontFace);
    CHECK_EQ(G.depthMask, before.depthMask); CHECK_MEM(G.colorMask, before.colorMask, 4);
    CHECK_EQ(G.bsr, before.bsr); CHECK_EQ(G.bdr, before.bdr); CHECK_EQ(G.bsa, before.bsa); CHECK_EQ(G.bda, before.bda);
    CHECK_EQ(G.ber, before.ber); CHECK_EQ(G.bea, before.bea);
    CHECK_EQ(G.drawFb, before.drawFb);   /* never touched */
}

TEST(gl_state_restores_the_vao_before_any_buffer_and_the_active_unit_last) {
    FwGlFns f = fake_fns();
    game_state();
    FwGlState st;
    fw_gl_save(&f, &st);
    our_draw();
    G.loglen = 0; G.log[0] = 0;
    fw_gl_restore(&f, &st);
    const char *vao = strstr(G.log, "BindVertexArray"), *arr = strstr(G.log, "BindBuffer(ARRAY)");
    CHECK(vao && arr && vao < arr);
    CHECK(strstr(G.log, "BindBuffer(OTHER)") == NULL);   /* never an element buffer while the game's VAO is bound */
    /* the last texture call is the active-unit restore (the units are restored first, each behind its own ActiveTexture) */
    const char *lastActive = NULL, *lastBind = NULL;
    for (const char *p = G.log; (p = strstr(p, "ActiveTexture")); p++) lastActive = p;
    for (const char *p = G.log; (p = strstr(p, "BindTexture")); p++) lastBind = p;
    CHECK(lastActive && lastBind && lastActive > lastBind);
}

TEST(gl_state_errors_are_drained_and_reported) {
    FwGlFns f = fake_fns();
    game_state();
    G.errors[0] = 0x502; G.errors[1] = 0x500; G.nerrors = 2;   /* popped last-in first: 0x500 then 0x502 */
    uint32_t first = 99;
    CHECK_EQ(fw_gl_drain_errors(&f, &first, 16), 2);
    CHECK_EQ(first, 0x500);
    CHECK_EQ(fw_gl_drain_errors(&f, &first, 16), 0);
    CHECK_EQ(first, 0);
    G.errors[0] = G.errors[1] = G.errors[2] = 0x505; G.nerrors = 3;
    CHECK_EQ(fw_gl_drain_errors(&f, &first, 2), 2);              /* bounded: a lost context returns errors forever */
}

/* ---- probe setting, layer predicate, stack top, log line ---- */
TEST(mesh_probe_parse) {
    int c = -1, r = -1;
    CHECK_EQ(fw_mesh_probe_parse("1", &c, &r), 1); CHECK_EQ(c, FW_MESH_PROBE_DEFAULT_COL); CHECK_EQ(r, FW_MESH_PROBE_DEFAULT_ROW);
    CHECK_EQ(fw_mesh_probe_parse("4,2", &c, &r), 1); CHECK_EQ(c, 4); CHECK_EQ(r, 2);
    CHECK_EQ(fw_mesh_probe_parse("0,0", &c, &r), 1); CHECK_EQ(c, 0); CHECK_EQ(r, 0);
    const char *off[] = { NULL, "", "0", "x", "4,", ",2", "-1,2", "4,-2", "4,2,1", "4;2", "1.5", "99999999999,1", " 4,2" };
    for (size_t i = 0; i < sizeof off / sizeof off[0]; i++) { c = r = 77; CHECK_EQ(fw_mesh_probe_parse(off[i], &c, &r), 0); }
}

TEST(mesh_draw_after_the_world_cameras_units_layer_only) {
    unsigned char tt[OFF_TT_MAIN_CAMERA + 16] = { 0 };
    unsigned char cam[16] = { 0 }, other[16] = { 0 };
    *(void **)(tt + OFF_TT_MAIN_CAMERA) = cam;
    CHECK_EQ(fw_mesh_draw_after_layer(tt, cam, CONST_UNITS_LAYER), 1);
    CHECK_EQ(fw_mesh_draw_after_layer(tt, cam, CONST_UNITS_LAYER - 1), 0);
    CHECK_EQ(fw_mesh_draw_after_layer(tt, other, CONST_UNITS_LAYER), 0);
    CHECK_EQ(fw_mesh_draw_after_layer(NULL, cam, CONST_UNITS_LAYER), 0);
    CHECK_EQ(fw_mesh_draw_after_layer(tt, NULL, CONST_UNITS_LAYER), 0);
}

TEST(mesh_stack_top_reads_data_plus_top_times_16) {
    float stack[3 * 16];
    for (int i = 0; i < 48; i++) stack[i] = (float)i;
    const void *data = stack;
    int top = 0;
    CHECK(fw_mesh_stack_top(&data, &top) == stack);
    top = 2;
    CHECK(fw_mesh_stack_top(&data, &top) == stack + 32);
    top = -1;
    CHECK(fw_mesh_stack_top(&data, &top) == NULL);
    const void *nul = NULL; top = 0;
    CHECK(fw_mesh_stack_top(&nul, &top) == NULL);
    CHECK(fw_mesh_stack_top(NULL, &top) == NULL);
    CHECK(fw_mesh_stack_top(&data, NULL) == NULL);
}

TEST(mesh_probe_log_line) {
    char buf[160];
    const float ndc[3] = { -0.285f, -0.169f, 0.0567f };
    const double canvas[2] = { 457.39, 420.87 };
    int n = fw_mesh_fmt_probe(buf, sizeof buf, 61, 3, 3, ndc, canvas);
    CHECK_STR(buf, "mesh probe f=61 tile=(3,3) ndc=(-0.285 -0.169 0.0567) canvas=(457.39 420.87)");
    CHECK_EQ(n, (int)strlen(buf));
    char small[12];
    fw_mesh_fmt_probe(small, sizeof small, 61, 3, 3, ndc, canvas);
    CHECK_EQ(strlen(small), sizeof small - 1);
}

int main(void) { return MT_RUN_ALL(); }
