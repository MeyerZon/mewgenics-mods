/*
 * mesh_engine.c — phase M of docs/possible_3d_work.md: real triangle meshes drawn into the vanilla (orthographic)
 * tactics scene. M1 = the probe cube: MEWFW_MESH_PROBE=1 (or "<col>,<row>") puts a flat magenta unit cube on that tile
 * in every fight.
 *
 * How (every fact OBSERVED, .analysis/notes-r3dA.md + the T2 observer run):
 *  - record time: obs3d_engine.c's hook on Camera_RenderOneLayer (0x979210) calls mesh_engine_after_layer() after the
 *    original. When the camera is the fight's world camera (TacticsTest+OFF_TT_MAIN_CAMERA) and the layer is the units
 *    layer (CONST_UNITS_LAYER), we compute the cube's mvp = stack top (the base canvas ortho; the original popped its
 *    own push) x Camera_GetViewProjection(cam) x Model (fw_m4_place: the ISO basis with a view-depth row x the tile
 *    centre), keep it in a static per-frame slot, and submit ONE draw functor with Batch_SubmitFunctor (0xa47820): a
 *    hand-built MSVC std::function<void()> (fw_functor.c). The functor lands in the frame recording right after the
 *    unit layer's groups.
 *  - replay time (FrameEnd -> Batch_Replay 0xa481d0, the game's GL context current, the main RT App+0xc10 bound for the
 *    world camera): _Do_call runs mesh_draw(). It loads the GL entry points itself (opengl32 GetProcAddress for 1.1,
 *    wglGetProcAddress for the rest: glDrawElements / glDepthFunc are not even imported by the game), builds its own
 *    program (an inline GLSL 1.50 flat shader) and VAO/VBO/IBO from fw_mesh_unit_cube once, then per frame: save the GL
 *    state (fw_gl_save), draw with depth test ON (GL_LESS, depth writes on) against the main RT's D24S8 (cleared by
 *    FrameBegin), blend/cull/stencil off, and restore every saved value (fw_gl_restore) — the engine's own caches stay
 *    truthful because the GL state is exactly what they believe. glGetError is drained before (pre-existing, logged
 *    once) and after the draw (logged with the frame, bounded).
 * Nothing is drawn outside fights; the hook itself is a pass-through when there is nothing to draw.
 * Limits (M1): one probe cube; the units layer neither tests nor writes depth, so the cube is drawn OVER the sprites
 * of its layer and below (and under layers drawn after it); sprite/mesh occlusion is phase M2.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdlib.h>
#include <string.h>
#include "framework_internal.h"
#include "fw_m4.h"
#include "fw_functor.h"
#include "fw_gl_state.h"
#include "fw_mesh_draw.h"
#include "fw_mesh_rules.h"

typedef float *(*fn_GetVP)(void *cam, float out[16]);
typedef void (*fn_SubmitFunctor)(void *unused, FwStdFunction *fn);

/* GL beyond the save/restore table */
typedef struct MeshGl {
    uint32_t (*CreateShader)(uint32_t type);
    void (*ShaderSource)(uint32_t sh, int n, const char *const *src, const int *len);
    void (*CompileShader)(uint32_t sh);
    void (*GetShaderiv)(uint32_t sh, uint32_t pname, int *out);
    void (*GetShaderInfoLog)(uint32_t sh, int cap, int *len, char *log);
    uint32_t (*CreateProgram)(void);
    void (*AttachShader)(uint32_t prog, uint32_t sh);
    void (*BindAttribLocation)(uint32_t prog, uint32_t loc, const char *name);
    void (*LinkProgram)(uint32_t prog);
    void (*GetProgramiv)(uint32_t prog, uint32_t pname, int *out);
    void (*GetProgramInfoLog)(uint32_t prog, int cap, int *len, char *log);
    int (*GetUniformLocation)(uint32_t prog, const char *name);
    void (*UniformMatrix4fv)(int loc, int n, uint8_t transpose, const float *m);
    void (*Uniform4f)(int loc, float x, float y, float z, float w);
    void (*GenVertexArrays)(int n, uint32_t *out);
    void (*GenBuffers)(int n, uint32_t *out);
    void (*BufferData)(uint32_t target, ptrdiff_t size, const void *data, uint32_t usage);
    void (*VertexAttribPointer)(uint32_t loc, int size, uint32_t type, uint8_t norm, int stride, const void *off);
    void (*EnableVertexAttribArray)(uint32_t loc);
    void (*DrawElements)(uint32_t mode, int count, uint32_t type, const void *off);
} MeshGl;

static FwGlFns g_gl;
static MeshGl g_mg;
static int g_glState;            /* 0 not loaded, 1 ready, -1 failed (logged once, never retried) */
static uint32_t g_prog, g_vao, g_vbo, g_ibo;
static int g_nindices, g_locMvp, g_locColour;

static int g_probe = -1;         /* -1 setting not read yet, 0 off, 1 on */
static int g_probeCol, g_probeRow;
static void *g_tt;
static int g_worldFrame;         /* world-camera units-layer calls this fight */
static int g_probeLogged;        /* "mesh probe" lines written (bounded) */
static int g_drawLogged;         /* "mesh draw" lines written (bounded) */
static int g_errLogged;
static long g_draws;

/* one frame's draw, captured at record time, read by the functor at replay */
typedef struct MeshFrameDraw { float mvp[16]; int frame; int valid; } MeshFrameDraw;
static MeshFrameDraw g_frameDraw;

#define MESH_LOG_PROBE_EVERY 60
#define MESH_LOG_PROBE_MAX   6
#define MESH_LOG_DRAW_MAX    4
#define MESH_LOG_ERR_MAX     8

static void *data_ptr(int id) { return (void *)fw_resolve_data_addr(1, g_build, g_base, id); }

static void *glproc(HMODULE gl32, PROC (WINAPI *wglGet)(LPCSTR), const char *name) {
    void *p = wglGet ? (void *)wglGet(name) : NULL;
    /* wglGetProcAddress returns 0, 1, 2, 3 or -1 for a failure on some drivers, and nothing for 1.1 entry points */
    if (p == NULL || p == (void *)1 || p == (void *)2 || p == (void *)3 || p == (void *)-1) p = gl32 ? (void *)GetProcAddress(gl32, name) : NULL;
    return p;
}

#define LOAD(dst, name) do { *(void **)&(dst) = glproc(gl32, wglGet, name); if (!(dst)) { fw_log("mesh: GL entry point %s not found", name); ok = 0; } } while (0)

static int load_gl(void) {
    HMODULE gl32 = GetModuleHandleA("opengl32.dll");
    PROC (WINAPI *wglGet)(LPCSTR) = gl32 ? (PROC (WINAPI *)(LPCSTR))(void *)GetProcAddress(gl32, "wglGetProcAddress") : NULL;
    if (!gl32 || !wglGet) { fw_log("mesh: opengl32.dll (%p) / wglGetProcAddress (%p) not available", (void *)gl32, (void *)wglGet); return 0; }
    int ok = 1;
    LOAD(g_gl.GetIntegerv, "glGetIntegerv"); LOAD(g_gl.GetBooleanv, "glGetBooleanv"); LOAD(g_gl.IsEnabled, "glIsEnabled");
    LOAD(g_gl.Enable, "glEnable"); LOAD(g_gl.Disable, "glDisable"); LOAD(g_gl.DepthFunc, "glDepthFunc");
    LOAD(g_gl.DepthMask, "glDepthMask"); LOAD(g_gl.ColorMask, "glColorMask"); LOAD(g_gl.CullFace, "glCullFace");
    LOAD(g_gl.FrontFace, "glFrontFace"); LOAD(g_gl.UseProgram, "glUseProgram"); LOAD(g_gl.BindVertexArray, "glBindVertexArray");
    LOAD(g_gl.BindBuffer, "glBindBuffer"); LOAD(g_gl.ActiveTexture, "glActiveTexture"); LOAD(g_gl.BindTexture, "glBindTexture");
    LOAD(g_gl.BlendFuncSeparate, "glBlendFuncSeparate"); LOAD(g_gl.BlendEquationSeparate, "glBlendEquationSeparate");
    LOAD(g_gl.GetError, "glGetError");
    LOAD(g_mg.CreateShader, "glCreateShader"); LOAD(g_mg.ShaderSource, "glShaderSource"); LOAD(g_mg.CompileShader, "glCompileShader");
    LOAD(g_mg.GetShaderiv, "glGetShaderiv"); LOAD(g_mg.GetShaderInfoLog, "glGetShaderInfoLog"); LOAD(g_mg.CreateProgram, "glCreateProgram");
    LOAD(g_mg.AttachShader, "glAttachShader"); LOAD(g_mg.BindAttribLocation, "glBindAttribLocation"); LOAD(g_mg.LinkProgram, "glLinkProgram");
    LOAD(g_mg.GetProgramiv, "glGetProgramiv"); LOAD(g_mg.GetProgramInfoLog, "glGetProgramInfoLog"); LOAD(g_mg.GetUniformLocation, "glGetUniformLocation");
    LOAD(g_mg.UniformMatrix4fv, "glUniformMatrix4fv"); LOAD(g_mg.Uniform4f, "glUniform4f"); LOAD(g_mg.GenVertexArrays, "glGenVertexArrays");
    LOAD(g_mg.GenBuffers, "glGenBuffers"); LOAD(g_mg.BufferData, "glBufferData"); LOAD(g_mg.VertexAttribPointer, "glVertexAttribPointer");
    LOAD(g_mg.EnableVertexAttribArray, "glEnableVertexAttribArray"); LOAD(g_mg.DrawElements, "glDrawElements");
    return ok && fw_gl_fns_complete(&g_gl);
}

/* the M1 probe shader: flat colour, a fixed shade per face orientation so the cube reads as a solid (the M3 palette
 * shader mods/fw-3d/shaders/fw_mesh.shader takes over through the material path) */
static const char *VS =
    "#version 150\n"
    "in vec3 position;\n"
    "in vec3 color;\n"
    "uniform mat4 fw_mvp;\n"
    "out vec3 v_n;\n"
    "void main(){ v_n = color; gl_Position = fw_mvp * vec4(position, 1.0); }\n";
static const char *FS =
    "#version 150\n"
    "uniform vec4 fw_base_color;\n"
    "in vec3 v_n;\n"
    "out vec4 frag_color;\n"
    "void main(){ float s = v_n.y > 0.5 ? 1.0 : (abs(v_n.x) > 0.5 ? 0.8 : 0.62); frag_color = vec4(fw_base_color.rgb * s, 1.0); }\n";

static uint32_t compile(uint32_t type, const char *src) {
    uint32_t sh = g_mg.CreateShader(type);
    g_mg.ShaderSource(sh, 1, &src, NULL);
    g_mg.CompileShader(sh);
    int ok = 0;
    g_mg.GetShaderiv(sh, FW_GL_COMPILE_STATUS, &ok);
    if (!ok) { char log[512] = { 0 }; int n = 0; g_mg.GetShaderInfoLog(sh, sizeof log - 1, &n, log); fw_log("mesh: %s shader compile failed: %s", type == FW_GL_VERTEX_SHADER ? "vertex" : "fragment", log); return 0; }
    return sh;
}

/* program + cube buffers; runs inside the functor (the context is current), with the state already saved */
static int build_gl_objects(void) {
    uint32_t vs = compile(FW_GL_VERTEX_SHADER, VS), fs = compile(FW_GL_FRAGMENT_SHADER, FS);
    if (!vs || !fs) return 0;
    g_prog = g_mg.CreateProgram();
    g_mg.AttachShader(g_prog, vs); g_mg.AttachShader(g_prog, fs);
    g_mg.BindAttribLocation(g_prog, 0, "position");
    g_mg.BindAttribLocation(g_prog, 1, "color");
    g_mg.LinkProgram(g_prog);
    int ok = 0;
    g_mg.GetProgramiv(g_prog, FW_GL_LINK_STATUS, &ok);
    if (!ok) { char log[512] = { 0 }; int n = 0; g_mg.GetProgramInfoLog(g_prog, sizeof log - 1, &n, log); fw_log("mesh: program link failed: %s", log); return 0; }
    g_locMvp = g_mg.GetUniformLocation(g_prog, "fw_mvp");
    g_locColour = g_mg.GetUniformLocation(g_prog, "fw_base_color");
    FwMesh cube;
    if (!fw_mesh_unit_cube(&cube)) { fw_log("mesh: unit cube allocation failed"); return 0; }
    g_mg.GenVertexArrays(1, &g_vao);
    g_mg.GenBuffers(1, &g_vbo);
    g_mg.GenBuffers(1, &g_ibo);
    g_gl.BindVertexArray(g_vao);   /* ours: the element buffer below binds into OUR VAO only */
    g_gl.BindBuffer(FW_GL_ARRAY_BUFFER, g_vbo);
    g_mg.BufferData(FW_GL_ARRAY_BUFFER, (ptrdiff_t)cube.nverts * (ptrdiff_t)sizeof(FwMeshVertex), cube.verts, FW_GL_STATIC_DRAW);
    g_gl.BindBuffer(FW_GL_ELEMENT_ARRAY_BUFFER, g_ibo);
    g_mg.BufferData(FW_GL_ELEMENT_ARRAY_BUFFER, (ptrdiff_t)cube.nindices * 4, cube.indices, FW_GL_STATIC_DRAW);
    g_mg.VertexAttribPointer(0, 3, FW_GL_FLOAT, 0, sizeof(FwMeshVertex), (const void *)0);
    g_mg.VertexAttribPointer(1, 3, FW_GL_FLOAT, 0, sizeof(FwMeshVertex), (const void *)12);
    g_mg.VertexAttribPointer(2, 2, FW_GL_FLOAT, 0, sizeof(FwMeshVertex), (const void *)24);
    g_mg.EnableVertexAttribArray(0); g_mg.EnableVertexAttribArray(1); g_mg.EnableVertexAttribArray(2);
    g_nindices = (int)cube.nindices;
    fw_log("mesh: GL objects ready: program %u (fw_mvp %d, fw_base_color %d), vao %u, cube %u verts / %u indices", g_prog, g_locMvp, g_locColour, g_vao, cube.nverts, cube.nindices);
    fw_mesh_free(&cube);
    return 1;
}

/* the functor body: runs inside Batch_Replay */
static void mesh_draw(void *user) {
    MeshFrameDraw *d = (MeshFrameDraw *)user;
    if (!d->valid || g_glState < 0) return;
    if (g_glState == 0) {
        if (!load_gl()) { g_glState = -1; fw_log("mesh: GL entry points missing; meshes disabled"); return; }
        g_glState = 2;   /* loaded, objects pending */
    }
    FwGlState st;
    uint32_t err = 0;
    int pre = fw_gl_drain_errors(&g_gl, &err, 16);
    if (pre && g_errLogged < MESH_LOG_ERR_MAX) { g_errLogged++; fw_log("mesh: %d pre-existing GL error(s) at functor entry, first 0x%x (frame %d)", pre, err, d->frame); }
    fw_gl_save(&g_gl, &st);
    if (g_glState == 2) {
        if (!build_gl_objects()) { fw_gl_restore(&g_gl, &st); g_glState = -1; fw_log("mesh: GL objects failed; meshes disabled"); return; }
        g_glState = 1;
    }
    g_gl.UseProgram(g_prog);
    g_mg.UniformMatrix4fv(g_locMvp, 1, 0, d->mvp);
    g_mg.Uniform4f(g_locColour, FW_MESH_PROBE_R, FW_MESH_PROBE_G, FW_MESH_PROBE_B, 1.0f);
    g_gl.BindVertexArray(g_vao);
    g_gl.Enable(FW_GL_DEPTH_TEST);
    g_gl.DepthFunc(FW_GL_LESS);
    g_gl.DepthMask(1);
    g_gl.ColorMask(1, 1, 1, 1);
    g_gl.Disable(FW_GL_BLEND);
    g_gl.Disable(FW_GL_CULL_FACE);
    g_gl.Disable(FW_GL_STENCIL_TEST);
    g_mg.DrawElements(FW_GL_TRIANGLES, g_nindices, FW_GL_UNSIGNED_INT, (const void *)0);
    int post = fw_gl_drain_errors(&g_gl, &err, 16);
    fw_gl_restore(&g_gl, &st);
    g_draws++;
    if (post && g_errLogged < MESH_LOG_ERR_MAX) { g_errLogged++; fw_log("mesh: %d GL error(s) after the draw, first 0x%x (frame %d)", post, err, d->frame); }
    if (g_drawLogged < MESH_LOG_DRAW_MAX) {
        g_drawLogged++;
        fw_log("mesh draw f=%d n=%ld fbo=%d viewport=(%d %d %d %d) depthTest=%d depthFunc=0x%x blend=%d prog=%d vao=%d errors=%d",
               d->frame, g_draws, st.drawFramebuffer, st.viewport[0], st.viewport[1], st.viewport[2], st.viewport[3],
               st.depthTest, st.depthFunc, st.blend, st.program, st.vao, post);
    }
    d->valid = 0;   /* one draw per recorded frame */
}

void mesh_engine_on_late_render(void *tt) {
    if (tt != g_tt) { g_tt = tt; g_worldFrame = 0; }
}

int mesh_engine_wants_layer_hook(void) {
    if (g_probe < 0) {
        g_probe = fw_mesh_probe_parse(getenv("MEWFW_MESH_PROBE"), &g_probeCol, &g_probeRow);
        if (g_probe) fw_log("mesh: probe cube on tile (%d,%d) (MEWFW_MESH_PROBE)", g_probeCol, g_probeRow);
    }
    return g_probe > 0;
}

/* after Camera_RenderOneLayer(cam, layer) returned (record time) */
void mesh_engine_after_layer(void *cam, int layer) {
    if (g_probe <= 0 || g_glState < 0 || !fw_mesh_draw_after_layer(g_tt, cam, layer)) return;
    g_worldFrame++;
    const float *top = fw_mesh_stack_top((const void *const *)data_ptr(FW_DATA_MatStackData), (const int *)data_ptr(FW_DATA_MatStackTop));
    const float *iso = (const float *)data_ptr(FW_DATA_Iso);
    if (!top || !iso || !g_sym[FW_SYM_Batch_SubmitFunctor]) return;
    float vp[16], model[16], topVp[16];
    ((fn_GetVP)g_sym[FW_SYM_Camera_GetViewProjection])(cam, vp);
    double c[3];
    fw_m4_tile_centre(g_probeCol, g_probeRow, c);
    fw_m4_place(iso, c[0], c[1], c[2], FW_MESH_PROBE_SIZE, model);
    fw_m4_mul(top, vp, topVp);
    fw_m4_mul(topVp, model, g_frameDraw.mvp);
    g_frameDraw.frame = g_worldFrame;
    g_frameDraw.valid = 1;
    if ((g_worldFrame - 1) % MESH_LOG_PROBE_EVERY == 0 && g_probeLogged < MESH_LOG_PROBE_MAX) {
        g_probeLogged++;
        const float mid[3] = { 0.0f, 0.5f, 0.0f };   /* the cube's centre in its local unit space (h 0..1) */
        float ndc[3] = { 0 }, vpm[16], cv[3] = { 0 };
        fw_m4_project(g_frameDraw.mvp, mid, ndc);
        fw_m4_mul(vp, model, vpm);
        fw_m4_project(vpm, mid, cv);
        const double canvas[2] = { cv[0], cv[1] };
        char buf[200];
        fw_mesh_fmt_probe(buf, sizeof buf, g_worldFrame, g_probeCol, g_probeRow, ndc, canvas);
        fw_log("%s", buf);
        if (g_probeLogged == 1)
            fw_log("mesh probe f=%d top=[%g %g %g %g %g %g %g %g %g %g %g %g %g %g %g %g] det(top x vp)=%g", g_worldFrame,
                   top[0], top[1], top[2], top[3], top[4], top[5], top[6], top[7], top[8], top[9], top[10], top[11], top[12], top[13], top[14], top[15], fw_m4_det(topVp));
    }
    FwStdFunction f;
    fw_functor_make(&f, mesh_draw, &g_frameDraw);
    ((fn_SubmitFunctor)g_sym[FW_SYM_Batch_SubmitFunctor])(NULL, &f);
    if (fw_functor_unexpected_deallocs()) { fw_log("mesh: the engine asked our functor to free itself; meshes disabled"); g_glState = -1; }
}
