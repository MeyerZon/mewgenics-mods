/*
 * mesh_engine.c — phase M of docs/possible_3d_work.md: real triangle meshes drawn into the vanilla (orthographic)
 * tactics scene.
 *
 * What draws:
 *  - the probe (M1): MEWFW_MESH_PROBE=1 (tile 3,3) or "<col>,<row>": a magenta unit cube (0.8 tiles) on that tile in
 *    every fight; MEWFW_MESH_PROBE_MODEL=models/<name>.obj|.gltf|.glb additionally places that model one tile to the
 *    right through the API v6 registry (obj3d_engine_place, the same path FW_Place3DObjectOnTile takes);
 *  - every object of the API v6 registry (obj3d_engine.c: FW_Register3DObject on a unit, FW_Place3DObjectOnTile):
 *    its `model` is a mod path (models/...), loaded once through ResourceManager_GetBinaryResource (0x973750: -modpaths
 *    first, then the gpak) and parsed by fw_mesh_load_bytes (OBJ or glTF, the game's left-handed axes); "@Name" models
 *    (native-registered) are not resolved yet.
 *
 * How (every fact OBSERVED, .analysis/notes-r3dA.md + the T2 runs of 2026-10-22):
 *  - record time: obs3d_engine.c's hook on Camera_RenderOneLayer (0x979210) calls mesh_engine_after_layer() after the
 *    original. For the fight's world camera (TacticsTest+OFF_TT_MAIN_CAMERA) drawing the units layer (CONST_UNITS_LAYER)
 *    every draw's mvp = stack top (the base canvas ortho; the original popped its own push) x
 *    Camera_GetViewProjection(cam) x the ISO basis with a view-depth row x the object's world matrix
 *    (fw_mesh_object_mvp) is captured into a static per-frame list, and ONE draw functor is submitted with
 *    Batch_SubmitFunctor (0xa47820): a hand-built MSVC std::function<void()> (fw_functor.c). It lands in the frame
 *    recording right after the unit layer's groups.
 *  - replay time (FrameEnd -> Batch_Replay 0xa481d0, the game's GL context current, the main RT App+0xc10 bound —
 *    OBSERVED fbo 1): the functor loads the GL entry points itself (opengl32 for 1.1, wglGetProcAddress for the rest:
 *    the game imports neither glDrawElements nor glDepthFunc), compiles mods/fw-3d/shaders/fw_mesh.shader with the
 *    game's dialect (fw_shader_stage) when that file is on the mod path (else an inline flat shader), uploads each
 *    mesh's VAO/VBO/IBO once, then saves the GL state (fw_gl_save), draws depth-tested (GL_LESS, writes on,
 *    blend/cull/stencil off) against the main RT's D24S8 (cleared by FrameBegin) and restores every saved value
 *    (fw_gl_restore): the engine's own caches stay truthful, no engine global is written. glGetError is drained before
 *    and after the draws (bounded logs).
 * Textures and the palette (M2, fw_mesh_tex.c; OBSERVED facts in its header): at record time an object's texture
 * (its own name, else the convention textures/models/<stem>.png) is existence-checked with ResourceManager_GetBinaryResource
 * on "textures/" + name — the exact call + path the App_GetTexture loader makes, and it dereferences a NULL result — and
 * its PNG header gated (RGB/RGBA 8-bit), then loaded ONCE with App_GetTexture (FwSymbol 42; the upload is synchronous);
 * palette.png likewise when an object has a palette row. At replay the functor reads each GL name at
 * Texture2D+OFF_TEX2D_GLNAME, binds unit 0 = fw_tex, unit 1 = palettemap (fw_gl_bind_units: both units are saved and
 * restored by fw_gl_save / fw_gl_restore) and sets fw_has_tex / palette. A missing named texture = one
 * "model-texture-missing" line and the base colour.
 * Sprite/mesh occlusion (M2, fw_mesh_order.c): the draws are collected BEFORE the original Camera_RenderOneLayer and
 * interleaved into the units layer's painter order: our per-item filter std::function sits at the world camera's
 * +OFF_CAM_LAYER_FILTER for the duration of that one call (the previous impl is chained and put back) and Layer_Draw
 * 0x9896f0 calls it before every (descending-key) item; a mesh's functor is submitted right before the first item
 * whose key is not larger than the mesh's (x + z of its origin; a unit-attached one right after its unit's item), the
 * rest after the layer. One functor per insertion point; meshes depth-test only against each other (the units layer
 * never writes depth). A layer that is not sorted or not drawn forward falls back to the M1 path (all after it).
 * hide_sprite (M3, fw_mesh_hide.c): the filter at the camera is fw_mesh_hide_filter wrapping the order filter; a unit
 * whose GON model block says hide_sprite true and whose model was drawn this frame has its units-layer item skipped.
 * Limits: meshes are drawn UNDER everything recorded after the units layer (UI, overlays); a multi-tile mesh is keyed
 * by one point (its origin).
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "framework_internal.h"
#include "fw_m4.h"
#include "fw_functor.h"
#include "fw_mesh_order.h"
#include "fw_mesh_hide.h"     /* M3 hide_sprite: the wrapping per-item filter */
#include "fw_gl_state.h"
#include "fw_mesh_draw.h"
#include "fw_mesh_rules.h"
#include "fw_mesh_tex.h"
#include "fw_obj3d_rules.h"
#include "fw_glow_rules.h"    /* fw_glow_renderer: Character -> its renderer */
#include "fw_obs3d_rules.h"   /* fw_obs3d_renderer_position / fw_obs3d_position_xz */
#include "fw_vtable.h"        /* fw_msvc_init: the by-value std::string the resource getter destroys */

typedef float *(*fn_GetVP)(void *cam, float out[16]);
typedef void (*fn_SubmitFunctor)(void *unused, FwStdFunction *fn);
typedef void *(*fn_GetBinaryResource)(void *unused, MsvcString *path);
typedef void *(*fn_GetTexture)(void *unused, MsvcString *name);

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
    void (*Uniform3f)(int loc, float x, float y, float z);
    void (*Uniform1f)(int loc, float x);
    void (*Uniform1i)(int loc, int x);
    void (*GenVertexArrays)(int n, uint32_t *out);
    void (*GenBuffers)(int n, uint32_t *out);
    void (*BufferData)(uint32_t target, ptrdiff_t size, const void *data, uint32_t usage);
    void (*VertexAttribPointer)(uint32_t loc, int size, uint32_t type, uint8_t norm, int stride, const void *off);
    void (*EnableVertexAttribArray)(uint32_t loc);
    void (*DrawElements)(uint32_t mode, int count, uint32_t type, const void *off);
} MeshGl;

static FwGlFns g_gl;
static MeshGl g_mg;
static int g_glState;            /* 0 not loaded, 2 loaded (program pending), 1 ready, -1 failed (logged once, never retried) */
static uint32_t g_prog;
static int g_progIsMod;          /* 1 = mods/fw-3d/shaders/fw_mesh.shader, 0 = the inline fallback */
enum { U_MVP, U_MODEL, U_LIGHT, U_AMBIENT, U_BANDS, U_COLOUR, U_PALETTE, U_FLAT, U_CXMUL, U_CXADD, U_TEX, U_HASTEX, U_PALMAP, U_COUNT };
static const char *const UNIFORMS[U_COUNT] = { "fw_mvp", "fw_model", "fw_light_dir", "fw_ambient", "fw_bands", "fw_base_color", "palette", "fw_flat", "fw_cx_mul", "fw_cx_add", "fw_tex", "fw_has_tex", "palettemap" };
static int g_loc[U_COUNT];

/* meshes: slot 0 = the built-in unit cube, then models by path (g_models.names = the path) */
static FwMeshRegistry g_models;
#define MESH_CUBE 0
#define MESH_SLOTS (FW_MESH_MAX_MODELS + 1)
static struct { uint32_t vao, vbo, ibo; int nindices; int uploaded; } g_gpu[MESH_SLOTS];
static FwMesh g_cube;
static int g_cubeBuilt;
#define MESH_FAILED_MAX FW_MESH_MAX_MODELS
static char g_failed[MESH_FAILED_MAX][FW_MESH_NAME_MAX + 1];   /* paths that failed to load (never retried, logged once) */
static int g_nfailed;

static char *g_modShader;        /* fw_mesh.shader's text, read at record time once (NULL: not on the mod path) */
static int g_modShaderRead;

static int g_probe = -1;         /* -1 setting not read yet, 0 off, 1 on */
static int g_probeCol, g_probeRow;
static char g_probeModel[FW_MESH_NAME_MAX + 1];
static char g_probeTexture[FW_TEX_NAME_MAX + 1];   /* MEWFW_MESH_PROBE_TEXTURE: the probe model's texture name */
static int g_probePalette = -1;                     /* MEWFW_MESH_PROBE_PALETTE: the probe model's palette row */

/* textures (record time: game calls; replay time: the GL names) */
static FwTexCache g_tex;
static void *g_paletteTex;       /* palette.png's Texture2D*, loaded once on demand */
static int g_paletteH, g_paletteState;   /* rows; 0 not tried, 1 loaded, -1 unavailable */
static int g_texLogged, g_rowLogged;
#define MESH_LOG_TEX_MAX 6
static void *g_tt;
static int g_worldFrame;         /* world-camera units-layer calls this fight */
static int g_probeLogged, g_drawLogged, g_errLogged, g_objLogged;
static long g_draws;

#define MESH_MAX_DRAWS 64
typedef struct MeshDraw { int mesh; float mvp[16]; float world[16]; float colour[4]; void *tex; const char *texName; int palette; } MeshDraw;
typedef struct MeshFrame { int frame; int n; MeshDraw d[MESH_MAX_DRAWS]; } MeshFrame;
static MeshFrame g_frame;        /* captured at record time, drawn by the functors at replay */
/* M2: one group of draws per insertion point in the units layer's painter order (fw_mesh_order.c); one functor each */
typedef struct MeshSeg { int n; int idx[MESH_MAX_DRAWS]; } MeshSeg;
static MeshSeg g_segs[MESH_MAX_DRAWS];
static int g_nsegs;
static FwMeshOrder g_order;
static FwMeshOrderFilter g_flt;
static FwFilterImpl g_fltImpl;
static void *g_fltCam, *g_fltPrev;
static int g_fltInstalled;       /* our filter sits at the world camera's +OFF_CAM_LAYER_FILTER (inside the original call) */
static int g_pendingAfter;       /* draws collected but the layer cannot be interleaved: all go after it (the M1 path) */
static int g_orderLogged, g_fltLogged, g_itemsLogged;
/* M3 hide_sprite (fw_mesh_hide.h): the renderers whose units-layer item is skipped this frame; the filter at the camera
 * is the hide filter wrapping the order filter */
static FwMeshHide g_hide;
static FwMeshHideFilter g_hideFlt;
static int g_hideFallbackLogged;
#define MESH_LOG_ORDER_MAX 6

#define MESH_LOG_PROBE_EVERY 60
#define MESH_LOG_PROBE_MAX   6
#define MESH_LOG_DRAW_MAX    4
#define MESH_LOG_ERR_MAX     8
#define MESH_LOG_OBJ_MAX     8

static void *data_ptr(int id) { return (void *)fw_resolve_data_addr(1, g_build, g_base, id); }

/* ------------------------------------------------------------------ GL loading */
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
    LOAD(g_mg.UniformMatrix4fv, "glUniformMatrix4fv"); LOAD(g_mg.Uniform4f, "glUniform4f"); LOAD(g_mg.Uniform3f, "glUniform3f");
    LOAD(g_mg.Uniform1f, "glUniform1f"); LOAD(g_mg.Uniform1i, "glUniform1i"); LOAD(g_mg.GenVertexArrays, "glGenVertexArrays");
    LOAD(g_mg.GenBuffers, "glGenBuffers"); LOAD(g_mg.BufferData, "glBufferData"); LOAD(g_mg.VertexAttribPointer, "glVertexAttribPointer");
    LOAD(g_mg.EnableVertexAttribArray, "glEnableVertexAttribArray"); LOAD(g_mg.DrawElements, "glDrawElements");
    return ok && fw_gl_fns_complete(&g_gl);
}

/* ------------------------------------------------------------------ program */
/* the fallback when mods/fw-3d is not on the mod path: a fixed shade per face orientation (the M1 probe shader) */
static const char *VS_INLINE =
    "#version 150\n"
    "in vec3 position;\n"
    "in vec3 color;\n"
    "uniform mat4 fw_mvp;\n"
    "out vec3 v_n;\n"
    "void main(){ v_n = color; gl_Position = fw_mvp * vec4(position, 1.0); }\n";
static const char *FS_INLINE =
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

static uint32_t link(const char *vsrc, const char *fsrc) {
    uint32_t vs = compile(FW_GL_VERTEX_SHADER, vsrc), fs = compile(FW_GL_FRAGMENT_SHADER, fsrc);
    if (!vs || !fs) return 0;
    uint32_t prog = g_mg.CreateProgram();
    g_mg.AttachShader(prog, vs); g_mg.AttachShader(prog, fs);
    /* the engine's own attribute names (Shader_compile binds position 0 / color 1 / texcoord 2 by name): color = the normal */
    g_mg.BindAttribLocation(prog, 0, "position");
    g_mg.BindAttribLocation(prog, 1, "color");
    g_mg.BindAttribLocation(prog, 2, "texcoord");
    g_mg.LinkProgram(prog);
    int ok = 0;
    g_mg.GetProgramiv(prog, FW_GL_LINK_STATUS, &ok);
    if (!ok) { char log[512] = { 0 }; int n = 0; g_mg.GetProgramInfoLog(prog, sizeof log - 1, &n, log); fw_log("mesh: program link failed: %s", log); return 0; }
    return prog;
}

static int build_program(void) {
    g_prog = 0;
    if (g_modShader) {
        size_t len = strlen(g_modShader), cap = len + 64;
        char *v = malloc(cap), *f = malloc(cap);
        if (v && f && fw_shader_stage(g_modShader, len, 1, v, cap) > 0 && fw_shader_stage(g_modShader, len, 0, f, cap) > 0) {
            g_prog = link(v, f);
            g_progIsMod = g_prog != 0;
            if (!g_prog) fw_log("mesh: shaders/fw_mesh.shader did not build; falling back to the inline shader");
        } else fw_log("mesh: shaders/fw_mesh.shader is not in the game's dialect (no vert()/frag() or an #include); falling back to the inline shader");
        free(v); free(f);
    }
    if (!g_prog) { g_prog = link(VS_INLINE, FS_INLINE); g_progIsMod = 0; }
    if (!g_prog) return 0;
    for (int i = 0; i < U_COUNT; i++) g_loc[i] = g_mg.GetUniformLocation(g_prog, UNIFORMS[i]);
    fw_log("mesh: program %u ready (%s; fw_mvp %d, fw_base_color %d, fw_light_dir %d)", g_prog,
           g_progIsMod ? "mods/fw-3d/shaders/fw_mesh.shader" : "inline flat shader", g_loc[U_MVP], g_loc[U_COLOUR], g_loc[U_LIGHT]);
    return 1;
}

/* ------------------------------------------------------------------ meshes */
static const FwMesh *mesh_at(int slot) {
    if (slot == MESH_CUBE) return g_cubeBuilt ? &g_cube : NULL;
    return fw_mesh_reg_get(&g_models, slot - 1);
}

/* inside the functor: VAO/VBO/IBO once per mesh (our VAO is bound before the element buffer, so the game's VAOs are never touched) */
static int upload(int slot) {
    if (g_gpu[slot].uploaded) return g_gpu[slot].uploaded > 0;
    const FwMesh *m = mesh_at(slot);
    g_gpu[slot].uploaded = -1;
    if (!m || !m->nindices) return 0;
    g_mg.GenVertexArrays(1, &g_gpu[slot].vao);
    g_mg.GenBuffers(1, &g_gpu[slot].vbo);
    g_mg.GenBuffers(1, &g_gpu[slot].ibo);
    g_gl.BindVertexArray(g_gpu[slot].vao);
    g_gl.BindBuffer(FW_GL_ARRAY_BUFFER, g_gpu[slot].vbo);
    g_mg.BufferData(FW_GL_ARRAY_BUFFER, (ptrdiff_t)m->nverts * (ptrdiff_t)sizeof(FwMeshVertex), m->verts, FW_GL_STATIC_DRAW);
    g_gl.BindBuffer(FW_GL_ELEMENT_ARRAY_BUFFER, g_gpu[slot].ibo);
    g_mg.BufferData(FW_GL_ELEMENT_ARRAY_BUFFER, (ptrdiff_t)m->nindices * 4, m->indices, FW_GL_STATIC_DRAW);
    g_mg.VertexAttribPointer(0, 3, FW_GL_FLOAT, 0, sizeof(FwMeshVertex), (const void *)0);
    g_mg.VertexAttribPointer(1, 3, FW_GL_FLOAT, 0, sizeof(FwMeshVertex), (const void *)12);
    g_mg.VertexAttribPointer(2, 2, FW_GL_FLOAT, 0, sizeof(FwMeshVertex), (const void *)24);
    g_mg.EnableVertexAttribArray(0); g_mg.EnableVertexAttribArray(1); g_mg.EnableVertexAttribArray(2);
    g_gpu[slot].nindices = (int)m->nindices;
    g_gpu[slot].uploaded = 1;
    fw_log("mesh: uploaded %s: %u verts / %u indices (vao %u)", slot == MESH_CUBE ? "the unit cube" : fw_mesh_reg_name(&g_models, slot - 1), m->nverts, m->nindices, g_gpu[slot].vao);
    return 1;
}

static int make_str(MsvcString *s, const char *text) { return fw_msvc_init(s, text, (FwStringAlloc)g_sym[FW_SYM_string_Allocate]); }

/* a file's bytes through -modpaths (ResourceManager_GetBinaryResource; borrowed, NULL when missing) */
static const uint8_t *read_resource(const char *path, size_t *len) {
    MsvcString s;
    if (!g_sym[FW_SYM_ResourceManager_GetBinaryResource] || !make_str(&s, path)) return NULL;
    void *res = ((fn_GetBinaryResource)g_sym[FW_SYM_ResourceManager_GetBinaryResource])(NULL, &s);   /* destroys s */
    if (!res) return NULL;
    const uint8_t *data = *(const uint8_t *const *)((const char *)res + OFF_BINRES_DATA);
    int32_t size = *(const int32_t *)((const char *)res + OFF_BINRES_SIZE);
    if (!data || size <= 0) return NULL;
    *len = (size_t)size;
    return data;
}

/* a failed model is remembered (never re-read, never re-logged); 1 = newly remembered, so log it */
static int remember_failed(const char *path) {
    for (int i = 0; i < g_nfailed; i++) if (!strcmp(g_failed[i], path)) return 0;
    if (g_nfailed >= MESH_FAILED_MAX) return 0;   /* full: stay quiet rather than log every frame */
    snprintf(g_failed[g_nfailed++], sizeof g_failed[0], "%s", path);
    return 1;
}

/* record time: a model path -> mesh slot (loaded once), -1 when it cannot be drawn. Logs exactly one line per model
 * per process, in the design §2.6 shape (fw_mesh_fmt_load_result): "mesh: <path>: <code>: <text> — drawing the 2D
 * clip" or "mesh: <path>: loaded N vertices, M triangles, bounds ...[; <warning codes>]". */
static int resolve_model(const char *path) {
    char p[FW_MESH_NAME_MAX + 1], line[512];
    FwMeshError e;
    fw_mesh_err_reset(&e);
    if (!path || !fw_mesh_model_path(path, p, sizeof p)) {
        for (int i = 0; i < g_nfailed; i++) if (!strcmp(g_failed[i], path ? path : "")) return -1;
        if (remember_failed(path ? path : "")) {
            e.code = fw_mesh_code(FW_MC_PATH_INVALID);
            snprintf(e.text, sizeof e.text, "not a models/<name>.obj|.gltf|.glb path (\"@Name\" models are not resolved yet)");
            fw_mesh_fmt_load_result(line, sizeof line, path ? path : "(null)", 0, NULL, &e);
            fw_log("%s", line);
        }
        return -1;
    }
    int i = fw_mesh_reg_find(&g_models, p);
    if (i >= 0) return i + 1;
    for (int k = 0; k < g_nfailed; k++) if (!strcmp(g_failed[k], p)) return -1;
    size_t len = 0;
    const uint8_t *bytes = read_resource(p, &len);
    FwMesh m;
    memset(&m, 0, sizeof m);
    int ok = 0;
    if (!bytes) {
        e.code = fw_mesh_code(FW_MC_FILE_MISSING);
        snprintf(e.text, sizeof e.text, "not found on the mod path (mods/<mod>/%s) nor in the game's resources, or empty", p);
    } else ok = fw_mesh_load_bytes(p, bytes, len, &m, &e);
    if (ok) {
        i = fw_mesh_reg_add(&g_models, p, &m);
        if (i < 0) {
            fw_mesh_free(&m); ok = 0;
            e.code = fw_mesh_code(FW_MC_LIMIT);
            snprintf(e.text, sizeof e.text, "the model registry is full (%d models per process)", FW_MESH_MAX_MODELS);
        }
    }
    if (!ok) {
        if (remember_failed(p)) { fw_mesh_fmt_load_result(line, sizeof line, p, 0, NULL, &e); fw_log("%s", line); }
        return -1;
    }
    fw_mesh_fmt_load_result(line, sizeof line, p, 1, fw_mesh_reg_get(&g_models, i), &e);
    fw_log("%s", line);
    return i + 1;
}

/* ------------------------------------------------------------------ textures (record time) */
/* "textures/" + name exists (the same GetBinaryResource call the loader makes) and is a PNG App_GetTexture can upload:
 * load it once. Every outcome is cached by name; the first lookup logs it. */
static FwTexEntry *load_texture(const FwTexChoice *c, const char *forModel) {
    FwTexEntry *e = fw_tex_cache_get(&g_tex, c->name, 1);
    if (!e || e->state != FW_TEX_UNKNOWN) return e;
    size_t len = 0;
    const uint8_t *bytes = read_resource(c->path, &len);
    if (!bytes) {
        e->state = FW_TEX_ABSENT;
        if (c->named) fw_log("mesh: model %s: model-texture-missing %s (%s not on the mod path or in the gpak): base colour only", forModel, c->name, c->path);
        else fw_log("mesh: model %s: untextured (no %s): base colour", forModel, c->path);
        return e;
    }
    char why[160];
    int w = 0, h = 0, rc = fw_png_check(bytes, len, &w, &h, why, sizeof why);
    if (rc != FW_PNG_OK) {
        e->state = FW_TEX_REFUSED;
        fw_log("mesh: model %s: model-texture-format %s: %s: base colour only", forModel, c->path, why);
        return e;
    }
    MsvcString s;
    void *tex = (g_sym[FW_SYM_App_GetTexture] && make_str(&s, c->name)) ? ((fn_GetTexture)g_sym[FW_SYM_App_GetTexture])(NULL, &s) : NULL;   /* destroys s */
    e->texture = tex; e->w = w; e->h = h;
    e->state = tex ? FW_TEX_LOADED : FW_TEX_ABSENT;
    fw_log("mesh: texture %s for %s: %s %dx%d (Texture2D %p, gl name %u at load)", c->name, forModel, tex ? "loaded" : "App_GetTexture returned NULL", w, h, tex, fw_tex_gl_name(tex));
    return e;
}

static const FwTexEntry *object_texture(const Fw3dObject *o, const FwMesh *m) {
    FwTexChoice c;
    if (!fw_tex_choose(o->texture, o->model, m && m->texture[0], &c)) {
        if (o->texture[0] && g_texLogged < MESH_LOG_TEX_MAX) { g_texLogged++; fw_log("mesh: model %s: texture name \"%s\" refused (textures/<...>.png, no ..): base colour only", o->model, o->texture); }
        return NULL;
    }
    return load_texture(&c, o->model);
}

/* the palette row a draw uses (-1 = off); loads palette.png on the first object that asks for a row */
static int object_palette(const Fw3dObject *o) {
    if (o->palette < 0) return -1;
    if (g_paletteState == 0) {
        g_paletteState = -1;
        size_t len = 0;
        const uint8_t *bytes = read_resource(FW_TEX_PREFIX FW_PALETTE_NAME, &len);
        int w = 0, h = 0;
        char why[160] = "";
        if (bytes && fw_png_check(bytes, len, &w, &h, why, sizeof why) == FW_PNG_OK) {
            MsvcString s;
            g_paletteTex = (g_sym[FW_SYM_App_GetTexture] && make_str(&s, FW_PALETTE_NAME)) ? ((fn_GetTexture)g_sym[FW_SYM_App_GetTexture])(NULL, &s) : NULL;
            if (g_paletteTex) { g_paletteState = 1; g_paletteH = h; }
        }
        fw_log("mesh: palette.png %dx%d (Texture2D %p, gl name %u at load)%s%s", w, h, g_paletteTex, fw_tex_gl_name(g_paletteTex),
               bytes ? "" : ": textures/palette.png not on the mod path or in the gpak, palette off", why);
    }
    int row = fw_palette_row(o->palette, g_paletteState > 0 ? g_paletteH : 0);
    if (row < 0 && g_rowLogged < MESH_LOG_TEX_MAX) { g_rowLogged++; fw_log("mesh: object %d palette row %d is outside palette.png (%d rows): palette off", o->handle, o->palette, g_paletteH); }
    return row;
}

/* ------------------------------------------------------------------ the functor (replay time) */
static void mesh_draw(void *user) {
    MeshSeg *seg = (MeshSeg *)user;
    MeshFrame *fr = &g_frame;
    if (!seg->n || g_glState < 0) return;
    if (g_glState == 0) {
        if (!load_gl()) { g_glState = -1; fw_log("mesh: GL entry points missing; meshes disabled"); return; }
        g_glState = 2;
    }
    FwGlState st;
    uint32_t err = 0;
    int pre = fw_gl_drain_errors(&g_gl, &err, 16);
    if (pre && g_errLogged < MESH_LOG_ERR_MAX) { g_errLogged++; fw_log("mesh: %d pre-existing GL error(s) at functor entry, first 0x%x (frame %d)", pre, err, fr->frame); }
    fw_gl_save(&g_gl, &st);
    if (g_glState == 2) {
        if (!build_program()) { fw_gl_restore(&g_gl, &st); g_glState = -1; fw_log("mesh: no program; meshes disabled"); return; }
        g_glState = 1;
    }
    g_gl.UseProgram(g_prog);
    float l[3] = { -0.4f, 1.0f, -0.6f };
    g_mg.Uniform3f(g_loc[U_LIGHT], l[0], l[1], l[2]);
    g_mg.Uniform1f(g_loc[U_AMBIENT], 0.45f);
    g_mg.Uniform1f(g_loc[U_BANDS], 0.0f);
    g_mg.Uniform1i(g_loc[U_PALETTE], -1);
    g_mg.Uniform1i(g_loc[U_FLAT], 0);
    g_mg.Uniform4f(g_loc[U_CXMUL], 1, 1, 1, 1);
    g_mg.Uniform4f(g_loc[U_CXADD], 0, 0, 0, 0);
    g_mg.Uniform1i(g_loc[U_TEX], FW_MESH_TEX_UNIT);
    g_mg.Uniform1i(g_loc[U_PALMAP], FW_MESH_PALETTE_UNIT);
    uint32_t palName = fw_tex_gl_name(g_paletteTex);
    g_gl.Enable(FW_GL_DEPTH_TEST);
    g_gl.DepthFunc(FW_GL_LESS);
    g_gl.DepthMask(1);
    g_gl.ColorMask(1, 1, 1, 1);
    g_gl.Disable(FW_GL_BLEND);
    g_gl.Disable(FW_GL_CULL_FACE);
    g_gl.Disable(FW_GL_STENCIL_TEST);
    int drawn = 0;
    for (int i = 0; i < seg->n; i++) {
        const MeshDraw *d = &fr->d[seg->idx[i]];
        if (!upload(d->mesh)) continue;
        g_gl.BindVertexArray(g_gpu[d->mesh].vao);
        g_mg.UniformMatrix4fv(g_loc[U_MVP], 1, 0, d->mvp);
        g_mg.UniformMatrix4fv(g_loc[U_MODEL], 1, 0, d->world);
        g_mg.Uniform4f(g_loc[U_COLOUR], d->colour[0], d->colour[1], d->colour[2], d->colour[3]);
        FwMeshMaterialPlan plan;
        uint32_t texName = fw_tex_gl_name(d->tex);
        fw_mesh_material_plan(texName, palName, d->palette, &plan);
        fw_gl_bind_units(&g_gl, plan.units);
        g_mg.Uniform1i(g_loc[U_HASTEX], plan.hasTex);
        g_mg.Uniform1i(g_loc[U_PALETTE], plan.palette);
        if ((texName || plan.palette >= 0) && g_texLogged < MESH_LOG_TEX_MAX) {
            g_texLogged++;
            if (texName) fw_log("mesh: texture %s gl name %u (Texture2D+0x%x, read at replay; unit %d, fw_has_tex %d)", d->texName ? d->texName : "?", texName, OFF_TEX2D_GLNAME, FW_MESH_TEX_UNIT, plan.hasTex);
            if (plan.palette >= 0) fw_log("mesh: palette.png gl name %u row %d (unit %d)", palName, plan.palette, FW_MESH_PALETTE_UNIT);
        }
        g_mg.DrawElements(FW_GL_TRIANGLES, g_gpu[d->mesh].nindices, FW_GL_UNSIGNED_INT, (const void *)0);
        drawn++;
    }
    int post = fw_gl_drain_errors(&g_gl, &err, 16);
    fw_gl_restore(&g_gl, &st);
    g_draws++;
    if (post && g_errLogged < MESH_LOG_ERR_MAX) { g_errLogged++; fw_log("mesh: %d GL error(s) after the draw, first 0x%x (frame %d)", post, err, fr->frame); }
    if (g_drawLogged < MESH_LOG_DRAW_MAX) {
        g_drawLogged++;
        fw_log("mesh draw f=%d n=%ld fbo=%d viewport=(%d %d %d %d) depthTest=%d depthFunc=0x%x blend=%d prog=%d vao=%d meshes=%d/%d errors=%d",
               fr->frame, g_draws, st.drawFramebuffer, st.viewport[0], st.viewport[1], st.viewport[2], st.viewport[3],
               st.depthTest, st.depthFunc, st.blend, st.program, st.vao, drawn, seg->n, post);
    }
    seg->n = 0;   /* one draw per recorded group */
}

/* ------------------------------------------------------------------ record time */
static void read_settings(void) {
    if (g_probe >= 0) return;
    g_probe = fw_mesh_probe_parse(getenv("MEWFW_MESH_PROBE"), &g_probeCol, &g_probeRow);
    const char *pm = getenv("MEWFW_MESH_PROBE_MODEL");
    if (g_probe && pm && *pm) snprintf(g_probeModel, sizeof g_probeModel, "%s", pm);
    const char *pt = getenv("MEWFW_MESH_PROBE_TEXTURE"), *pp = getenv("MEWFW_MESH_PROBE_PALETTE");
    if (g_probe && pt && *pt) snprintf(g_probeTexture, sizeof g_probeTexture, "%s", pt);
    if (g_probe && pp && *pp) { char *e = NULL; long v = strtol(pp, &e, 10); g_probePalette = (e && !*e && v >= 0 && v < 4096) ? (int)v : -1; }
    if (g_probe && (g_probeTexture[0] || g_probePalette >= 0)) fw_log("mesh: probe model texture %s, palette row %d (MEWFW_MESH_PROBE_TEXTURE / _PALETTE)", g_probeTexture[0] ? g_probeTexture : "(convention)", g_probePalette);
    if (g_probe) fw_log("mesh: probe cube on tile (%d,%d) (MEWFW_MESH_PROBE)%s%s", g_probeCol, g_probeRow, g_probeModel[0] ? "; probe model " : "", g_probeModel);
}

void mesh_engine_on_late_render(void *tt) {
    obj3d_engine_on_fight(tt);   /* first: a new TacticsTest clears the API registry, freed units are pruned */
    if (tt != g_tt) {
        g_tt = tt;
        g_worldFrame = 0;
        g_orderLogged = g_itemsLogged = g_fltLogged = 0;
        read_settings();
        if (g_probe > 0 && g_probeModel[0]) {
            float identity[16];
            fw_m4_identity(identity);
            int h = obj3d_engine_place(g_probeCol + 1, g_probeRow, g_probeModel, identity);   /* the API v6 path (FW_Place3DObjectOnTile) */
            if (h && (g_probeTexture[0] || g_probePalette >= 0)) obj3d_engine_set_material(h, g_probeTexture, g_probePalette);
        }
    }
    obj3d_engine_units_frame();   /* per-unit models from GON (obj3d_engine.c): discovery + facing, once per combat frame */
}

int mesh_engine_wants_layer_hook(void) {
    read_settings();
    /* the probe needs it now; API v6 objects can be registered by any native mod later, so the hook is installed
     * whenever the framework is active (a pass-through when there is nothing to draw) */
    return 1;
}

/* key/anchor: the draw's place in the units layer's painter order (fw_mesh_order.h) */
static void add_draw(int mesh, const float top[16], const float vp[16], const float iso[16], const float world[16], const float colour[4], double key, const void *anchor) {
    if (g_frame.n >= MESH_MAX_DRAWS) return;
    MeshDraw *d = &g_frame.d[g_frame.n];
    d->mesh = mesh;
    d->tex = NULL; d->texName = NULL; d->palette = -1;
    fw_mesh_object_mvp(top, vp, iso, world, d->mvp);
    memcpy(d->world, world, sizeof d->world);
    memcpy(d->colour, colour, sizeof d->colour);
    fw_mesh_order_add(&g_order, key, anchor, g_frame.n);
    g_frame.n++;
}

/* fw_mesh_order's submit callback: one group of draws -> one draw functor through Batch_SubmitFunctor (record time;
 * called from inside Layer_Draw by our filter, or after the layer) */
static void submit_group(void *ctx, const int *draws, int n) {
    (void)ctx;
    if (n <= 0 || g_nsegs >= MESH_MAX_DRAWS || g_glState < 0) return;
    MeshSeg *seg = &g_segs[g_nsegs++];
    seg->n = n;
    memcpy(seg->idx, draws, (size_t)n * sizeof draws[0]);
    FwStdFunction f;
    fw_functor_make(&f, mesh_draw, seg);
    ((fn_SubmitFunctor)g_sym[FW_SYM_Batch_SubmitFunctor])(NULL, &f);
    if (fw_functor_unexpected_deallocs()) { fw_log("mesh: the engine asked our functor to free itself; meshes disabled"); g_glState = -1; }
}

/* the frame's draws (record time, before the original Camera_RenderOneLayer: the matrix stack top is the same before
 * and after it, the original pushes and pops its own VP); returns the draw count */
static int collect(void *cam) {
    int nobj = obj3d_engine_count();
    g_frame.n = 0;
    g_nsegs = 0;
    fw_mesh_order_reset(&g_order);
    fw_mesh_hide_reset(&g_hide);
    if (g_probe <= 0 && nobj == 0) return 0;
    g_worldFrame++;
    const float *top = fw_mesh_stack_top((const void *const *)data_ptr(FW_DATA_MatStackData), (const int *)data_ptr(FW_DATA_MatStackTop));
    const float *iso = (const float *)data_ptr(FW_DATA_Iso);
    if (!top || !iso || !g_sym[FW_SYM_Batch_SubmitFunctor]) return 0;
    if (!g_modShaderRead) {   /* once, at record time (the resource getter is a game call; the functor only does GL) */
        g_modShaderRead = 1;
        size_t len = 0;
        const uint8_t *src = read_resource("shaders/fw_mesh.shader", &len);
        if (src && (g_modShader = malloc(len + 1))) { memcpy(g_modShader, src, len); g_modShader[len] = 0; }
        fw_log("mesh: shaders/fw_mesh.shader %s", g_modShader ? "found on the mod path" : "not on the mod path (mods/fw-3d): the inline shader draws");
    }
    if (!g_cubeBuilt) g_cubeBuilt = fw_mesh_unit_cube(&g_cube);
    float vp[16];
    ((fn_GetVP)g_sym[FW_SYM_Camera_GetViewProjection])(cam, vp);
    g_frame.frame = g_worldFrame;
    if (g_probe > 0 && g_cubeBuilt) {
        double c[3];
        float world[16];
        const float magenta[4] = { FW_MESH_PROBE_R, FW_MESH_PROBE_G, FW_MESH_PROBE_B, 1.0f };
        fw_m4_tile_centre(g_probeCol, g_probeRow, c);
        fw_m4_identity(world);
        world[0] = world[5] = world[10] = (float)FW_MESH_PROBE_SIZE;
        world[12] = (float)c[0]; world[13] = (float)c[1]; world[14] = (float)c[2];
        double key = fw_mesh_order_tile_key(c[0], c[2]);
        add_draw(MESH_CUBE, top, vp, iso, world, magenta, key, NULL);
        if ((g_worldFrame - 1) % MESH_LOG_PROBE_EVERY == 0 && g_probeLogged < MESH_LOG_PROBE_MAX) {
            g_probeLogged++;
            /* the cube's screen silhouette (M2 occlusion measure: editor/src/core/art/mesh-measure.ts measureOcclusion) */
            const float lo[3] = { -0.5f, 0.0f, -0.5f }, hi[3] = { 0.5f, 1.0f, 0.5f };
            double box[4], area = 0;
            if (fw_mesh_order_hull(g_frame.d[g_frame.n - 1].mvp, lo, hi, box, &area)) {
                char ob[200];
                fw_mesh_order_fmt_occ(ob, sizeof ob, g_worldFrame, g_probeCol, g_probeRow, key, box, area);
                fw_log("%s", ob);
            }
            const float mid[3] = { 0.0f, 0.5f, 0.0f };   /* the cube's centre in its local unit space (h 0..1) */
            float ndc[3] = { 0 }, model[16], vpm[16], cv[3] = { 0 };
            fw_m4_project(g_frame.d[g_frame.n - 1].mvp, mid, ndc);
            fw_m4_place(iso, c[0], c[1], c[2], FW_MESH_PROBE_SIZE, model);
            fw_m4_mul(vp, model, vpm);
            fw_m4_project(vpm, mid, cv);
            const double canvas[2] = { cv[0], cv[1] };
            char buf[200];
            fw_mesh_fmt_probe(buf, sizeof buf, g_worldFrame, g_probeCol, g_probeRow, ndc, canvas);
            fw_log("%s", buf);
        }
    }
    for (int i = 0; i < nobj; i++) {
        const Fw3dObject *o = obj3d_engine_get(i);
        if (!o) continue;
        int slot = resolve_model(o->model);
        if (slot < 0) continue;
        double xz[2], *at = NULL;
        void *rnd = NULL;
        if (!o->byTile) {
            rnd = o->character ? fw_glow_renderer(o->character) : NULL;
            void *pos = rnd ? fw_obs3d_renderer_position(rnd) : NULL;
            if (!pos) continue;
            fw_obs3d_position_xz(pos, xz);
            at = xz;
        }
        float world[16];
        fw_obj3d_model_matrix(o, at, world);
        const FwMesh *m = mesh_at(slot);
        /* painter key: a tile object by its origin; a unit-attached one right after its unit's own item */
        double key = at ? fw_mesh_order_unit_key(xz[0], xz[1]) : fw_mesh_order_tile_key(world[12], world[14]);
        int before = g_frame.n;
        add_draw(slot, top, vp, iso, world, m ? m->base_color : (const float[4]){ 1, 1, 1, 1 }, key, at ? rnd : NULL);
        if (g_frame.n == before) continue;
        /* M3: the model is drawn this frame, so a hide_sprite unit loses its sprite item (a model that failed to load
         * never got here: resolve_model < 0 above, the sprite stays) */
        if (fw_mesh_hide_wanted(o->hideSprite, o->byTile, rnd, 1)) fw_mesh_hide_add(&g_hide, rnd);
        MeshDraw *d = &g_frame.d[g_frame.n - 1];
        const FwTexEntry *te = object_texture(o, m);
        if (te && te->state == FW_TEX_LOADED) { d->tex = te->texture; d->texName = te->name; }
        d->palette = object_palette(o);
        if (g_objLogged < MESH_LOG_OBJ_MAX && g_worldFrame % MESH_LOG_PROBE_EVERY == 1) {
            g_objLogged++;
            const float mid[3] = { 0.0f, m ? (m->bmin[1] + m->bmax[1]) * 0.5f : 0.5f, 0.0f };
            float ndc[3] = { 0 };
            const float w3[3] = { world[12], world[13], world[14] };
            char buf[256];
            fw_m4_project(d->mvp, mid, ndc);
            fw_mesh_fmt_object(buf, sizeof buf, g_worldFrame, o->handle, o->model, o->byTile, w3, ndc, d->texName, d->palette);
            fw_log("%s", buf);
        }
    }
    return g_frame.n;
}

/* before Camera_RenderOneLayer(cam, layer) (record time): for the fight's world camera drawing the units layer, collect
 * the frame's draws and, when the layer is sorted and drawn forward, put our per-item filter at the camera's
 * +OFF_CAM_LAYER_FILTER (the previous impl is chained and put back in mesh_engine_after_layer): Layer_Draw 0x9896f0 then
 * calls it before every item, and it submits the meshes that are farther than that item right there (fw_mesh_order.c) */
void mesh_engine_before_layer(void *cam, int layer) {
    /* any other camera / layer (also a nested call during ours) leaves the state alone */
    if (g_glState < 0 || g_fltInstalled || !fw_mesh_draw_after_layer(g_tt, cam, layer)) return;
    g_pendingAfter = 0;
    if (!collect(cam)) return;
    const void *l = fw_obs3d_layer(fw_obs3d_cam_queue(cam), layer);
    int inter = fw_mesh_order_interleave(l);
    void *prev = fw_mesh_order_cam_filter(cam);
    if (!g_fltLogged) {
        g_fltLogged = 1;
        fw_log("mesh order: world camera filter before ours = %p (units layer sorted=%d mode=%d: %s)", prev,
               l ? *((const unsigned char *)l + OFF_LAYER_SORTED) : -1, fw_obs3d_layer_mode(l), inter ? "interleaving" : "all meshes after the layer");
    }
    if (!inter) {
        g_pendingAfter = 1;
        if (g_hide.n && !g_hideFallbackLogged) { g_hideFallbackLogged = 1; fw_log("mesh hide: the units layer cannot be interleaved; hide_sprite not applied (%d unit sprite(s) drawn)", g_hide.n); }
        return;
    }
    g_flt.order = &g_order;
    g_flt.layer = layer;
    g_flt.submit = submit_group;
    g_flt.ctx = NULL;
    g_flt.prev = prev;
    g_flt.index = 0;
    g_hideFlt.set = &g_hide;
    g_hideFlt.layer = layer;
    g_hideFlt.inner = fw_mesh_order_filter;   /* the order filter runs first (it chains the previous impl) */
    g_hideFlt.innerUser = &g_flt;
    g_hideFlt.prev = NULL;
    fw_filter_make(&g_fltImpl, fw_mesh_hide_filter, &g_hideFlt);
    g_fltCam = cam;
    g_fltPrev = prev;
    fw_mesh_order_set_cam_filter(cam, &g_fltImpl);
    g_fltInstalled = 1;
}

/* the plan lines (a few windows per fight) and, once, the units layer's MaskedRendererIso items with their tiles */
static void log_order(void *cam, int layer) {
    if ((g_worldFrame - 1) % MESH_LOG_PROBE_EVERY != 0 || g_orderLogged >= MESH_LOG_ORDER_MAX) return;
    g_orderLogged++;
    char buf[1024];
    fw_mesh_order_fmt(buf, sizeof buf, g_worldFrame, &g_order);
    fw_log("%s", buf);
    fw_mesh_order_fmt_keys(buf, sizeof buf, g_worldFrame, &g_order);
    fw_log("%s", buf);
    if (g_hide.n) { fw_mesh_hide_fmt(buf, sizeof buf, g_worldFrame, &g_hide); fw_log("%s", buf); }
    if (g_itemsLogged) return;
    g_itemsLogged = 1;
    const void *l = fw_obs3d_layer(fw_obs3d_cam_queue(cam), layer);
    int n = fw_obs3d_layer_items(l);
    const unsigned char *items = l ? *(const unsigned char *const *)((const unsigned char *)l + OFF_LAYER_ITEMS) : NULL;
    for (int i = 0; items && i < n && i < FW_MESH_ORDER_LOG_ITEMS; i++) {
        const unsigned char *it = items + ((size_t)i << CONST_LAYER_ITEM_SHIFT);
        void *rnd = (void *)fw_mesh_order_item_renderable(it);
        if (!fw_obs3d_is_masked_renderer_iso(rnd, g_base + g_build->rva_MaskedRendererIso_vftable)) continue;
        double xz[2];
        fw_obs3d_position_xz(fw_obs3d_renderer_position(rnd), xz);
        fw_mesh_order_fmt_item(buf, sizeof buf, g_worldFrame, i, fw_mesh_order_item_key(it), xz);
        fw_log("%s", buf);
    }
}

/* after Camera_RenderOneLayer(cam, layer) returned (record time): put the camera's filter back, submit the meshes
 * nearer than every item (or, when the layer could not be interleaved, all of them: the M1 path) */
void mesh_engine_after_layer(void *cam, int layer) {
    if (g_fltInstalled && cam == g_fltCam) {
        fw_mesh_order_set_cam_filter(cam, g_fltPrev);
        g_fltInstalled = 0;
        fw_mesh_order_finish(&g_flt);
        log_order(cam, layer);
    } else if (g_pendingAfter && fw_mesh_draw_after_layer(g_tt, cam, layer)) {
        int out[FW_MESH_ORDER_MAX];
        int n = fw_mesh_order_rest(&g_order, out, FW_MESH_ORDER_MAX);
        submit_group(NULL, out, n);
        log_order(cam, layer);
        g_pendingAfter = 0;
    }
}
