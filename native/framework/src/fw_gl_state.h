/* fw_gl_state.h — the GL state a mesh draw functor saves on entry and puts back on exit. Pure, host-tested
 * (test/test_mesh_draw.c, against a fake GL that keeps state and records calls).
 *
 * Why this list (OBSERVED, .analysis/notes-r3dA.md G2): our functor runs inside Batch_Replay (0xa481d0) after its own
 * group's state was applied and before the next group. Batch_ApplyGroupState (0xa497d0) re-applies VAO, depth/stencil
 * enables, colour+depth mask, stencil func/op and blend func/equation for every group (the force bit is never cleared),
 * and Material_Bind (0x9bda20) rebinds program + textures only when its caches (last material 0x1413c1980, last shader
 * 0x1413c42b8, the 16 texture-unit cache 0x1413c19a0, the active unit 0x1412f713c) say they changed. So what a functor
 * touches and the engine would NOT redo — the program, the texture bindings and the active unit (behind those caches),
 * GL_ARRAY_BUFFER (the instance VBO 0x1412f8160), GL_DRAW_INDIRECT_BUFFER (0x1412f8164), the VAO, glDepthFunc (never
 * called by the game: GL_LESS), GL_BLEND (enabled once per frame), cull state — is read back with glGet* before we draw
 * and restored after, to the exact values. Restoring the real values keeps every engine cache truthful, so no engine
 * global is written (no data binding needed). The viewport, scissor and framebuffer are never changed: we draw into
 * whatever the replay has bound (the main RT App+0xc10 for the world camera).
 *
 * Restore order: the VAO first (it owns GL_ELEMENT_ARRAY_BUFFER, so the caller only ever binds an element buffer while
 * ITS OWN VAO is bound), then GL_ARRAY_BUFFER / GL_DRAW_INDIRECT_BUFFER, the program, each saved texture unit, the active
 * unit last, then the fixed-function state. */
#pragma once
#include <stdint.h>

/* the GL enums we use (no GL header on the host) */
#define FW_GL_NO_ERROR                    0
#define FW_GL_TRIANGLES                   0x0004
#define FW_GL_LESS                        0x0201
#define FW_GL_LEQUAL                      0x0203
#define FW_GL_FRONT                       0x0404
#define FW_GL_BACK                        0x0405
#define FW_GL_CW                          0x0900
#define FW_GL_CCW                         0x0901
#define FW_GL_CULL_FACE                   0x0B44
#define FW_GL_CULL_FACE_MODE              0x0B45
#define FW_GL_FRONT_FACE                  0x0B46
#define FW_GL_DEPTH_TEST                  0x0B71
#define FW_GL_DEPTH_WRITEMASK             0x0B72
#define FW_GL_DEPTH_FUNC                  0x0B74
#define FW_GL_STENCIL_TEST                0x0B90
#define FW_GL_VIEWPORT                    0x0BA2
#define FW_GL_BLEND                       0x0BE2
#define FW_GL_SCISSOR_TEST                0x0C11
#define FW_GL_COLOR_WRITEMASK             0x0C23
#define FW_GL_TEXTURE_2D                  0x0DE1
#define FW_GL_UNSIGNED_SHORT              0x1403
#define FW_GL_UNSIGNED_INT                0x1405
#define FW_GL_FLOAT                       0x1406
#define FW_GL_TEXTURE_BINDING_2D          0x8069
#define FW_GL_BLEND_DST_RGB               0x80C8
#define FW_GL_BLEND_SRC_RGB               0x80C9
#define FW_GL_BLEND_DST_ALPHA             0x80CA
#define FW_GL_BLEND_SRC_ALPHA             0x80CB
#define FW_GL_BLEND_EQUATION_RGB          0x8009
#define FW_GL_BLEND_EQUATION_ALPHA        0x883D
#define FW_GL_TEXTURE0                    0x84C0
#define FW_GL_ACTIVE_TEXTURE              0x84E0
#define FW_GL_ARRAY_BUFFER                0x8892
#define FW_GL_ELEMENT_ARRAY_BUFFER        0x8893
#define FW_GL_ARRAY_BUFFER_BINDING        0x8894
#define FW_GL_STATIC_DRAW                 0x88E4
#define FW_GL_FRAGMENT_SHADER             0x8B30
#define FW_GL_VERTEX_SHADER               0x8B31
#define FW_GL_COMPILE_STATUS              0x8B81
#define FW_GL_LINK_STATUS                 0x8B82
#define FW_GL_CURRENT_PROGRAM             0x8B8D
#define FW_GL_DRAW_FRAMEBUFFER_BINDING    0x8CA6
#define FW_GL_VERTEX_ARRAY_BINDING        0x85B5
#define FW_GL_DRAW_INDIRECT_BUFFER        0x8F3F
#define FW_GL_DRAW_INDIRECT_BUFFER_BINDING 0x8F43

#define FW_GL_SAVED_UNITS 2   /* texture units a mesh draw may use: 0 (albedo / palettemap), 1 */

/* the GL calls the save/restore needs (the DLL fills them from opengl32 + wglGetProcAddress; the test with a fake) */
typedef struct FwGlFns {
    void (*GetIntegerv)(uint32_t pname, int32_t *out);
    void (*GetBooleanv)(uint32_t pname, uint8_t *out);
    uint8_t (*IsEnabled)(uint32_t cap);
    void (*Enable)(uint32_t cap);
    void (*Disable)(uint32_t cap);
    void (*DepthFunc)(uint32_t func);
    void (*DepthMask)(uint8_t flag);
    void (*ColorMask)(uint8_t r, uint8_t g, uint8_t b, uint8_t a);
    void (*CullFace)(uint32_t mode);
    void (*FrontFace)(uint32_t mode);
    void (*UseProgram)(uint32_t program);
    void (*BindVertexArray)(uint32_t vao);
    void (*BindBuffer)(uint32_t target, uint32_t buffer);
    void (*ActiveTexture)(uint32_t unit);
    void (*BindTexture)(uint32_t target, uint32_t texture);
    void (*BlendFuncSeparate)(uint32_t srcRgb, uint32_t dstRgb, uint32_t srcA, uint32_t dstA);
    void (*BlendEquationSeparate)(uint32_t rgb, uint32_t a);
    uint32_t (*GetError)(void);
} FwGlFns;

typedef struct FwGlState {
    int32_t program, vao, arrayBuffer, indirectBuffer, activeTexture;
    int32_t tex2d[FW_GL_SAVED_UNITS];
    uint8_t depthTest, stencilTest, blend, cullFace, scissorTest;
    int32_t depthFunc, cullFaceMode, frontFace;
    uint8_t depthMask, colorMask[4];
    int32_t blendSrcRgb, blendDstRgb, blendSrcA, blendDstA, blendEqRgb, blendEqA;
    int32_t drawFramebuffer;   /* read for the log only: never restored, never changed */
    int32_t viewport[4];       /* likewise */
} FwGlState;

/* 1 when every function pointer the save/restore needs is set */
int fw_gl_fns_complete(const FwGlFns *gl);
void fw_gl_save(const FwGlFns *gl, FwGlState *st);
void fw_gl_restore(const FwGlFns *gl, const FwGlState *st);
/* read glGetError until GL_NO_ERROR (at most max times); the first error goes to *first (0 if none); returns the count */
int fw_gl_drain_errors(const FwGlFns *gl, uint32_t *first, int max);
