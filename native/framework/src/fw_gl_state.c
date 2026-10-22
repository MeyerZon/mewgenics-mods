/* fw_gl_state.c — save / restore the GL state around a mesh draw functor (fw_gl_state.h). Pure, host-tested. */
#include <string.h>
#include "fw_gl_state.h"

int fw_gl_fns_complete(const FwGlFns *gl) {
    if (!gl) return 0;
    const void *const *p = (const void *const *)gl;
    for (size_t i = 0; i < sizeof *gl / sizeof(void *); i++) if (!p[i]) return 0;
    return 1;
}

void fw_gl_save(const FwGlFns *gl, FwGlState *st) {
    memset(st, 0, sizeof *st);
    gl->GetIntegerv(FW_GL_CURRENT_PROGRAM, &st->program);
    gl->GetIntegerv(FW_GL_VERTEX_ARRAY_BINDING, &st->vao);
    gl->GetIntegerv(FW_GL_ARRAY_BUFFER_BINDING, &st->arrayBuffer);
    gl->GetIntegerv(FW_GL_DRAW_INDIRECT_BUFFER_BINDING, &st->indirectBuffer);
    gl->GetIntegerv(FW_GL_ACTIVE_TEXTURE, &st->activeTexture);
    for (int u = 0; u < FW_GL_SAVED_UNITS; u++) {
        gl->ActiveTexture(FW_GL_TEXTURE0 + (uint32_t)u);
        gl->GetIntegerv(FW_GL_TEXTURE_BINDING_2D, &st->tex2d[u]);
    }
    gl->ActiveTexture((uint32_t)st->activeTexture);
    st->depthTest = gl->IsEnabled(FW_GL_DEPTH_TEST);
    st->stencilTest = gl->IsEnabled(FW_GL_STENCIL_TEST);
    st->blend = gl->IsEnabled(FW_GL_BLEND);
    st->cullFace = gl->IsEnabled(FW_GL_CULL_FACE);
    st->scissorTest = gl->IsEnabled(FW_GL_SCISSOR_TEST);
    gl->GetIntegerv(FW_GL_DEPTH_FUNC, &st->depthFunc);
    gl->GetIntegerv(FW_GL_CULL_FACE_MODE, &st->cullFaceMode);
    gl->GetIntegerv(FW_GL_FRONT_FACE, &st->frontFace);
    gl->GetBooleanv(FW_GL_DEPTH_WRITEMASK, &st->depthMask);
    gl->GetBooleanv(FW_GL_COLOR_WRITEMASK, st->colorMask);
    gl->GetIntegerv(FW_GL_BLEND_SRC_RGB, &st->blendSrcRgb);
    gl->GetIntegerv(FW_GL_BLEND_DST_RGB, &st->blendDstRgb);
    gl->GetIntegerv(FW_GL_BLEND_SRC_ALPHA, &st->blendSrcA);
    gl->GetIntegerv(FW_GL_BLEND_DST_ALPHA, &st->blendDstA);
    gl->GetIntegerv(FW_GL_BLEND_EQUATION_RGB, &st->blendEqRgb);
    gl->GetIntegerv(FW_GL_BLEND_EQUATION_ALPHA, &st->blendEqA);
    gl->GetIntegerv(FW_GL_DRAW_FRAMEBUFFER_BINDING, &st->drawFramebuffer);
    gl->GetIntegerv(FW_GL_VIEWPORT, st->viewport);
}

static void set_cap(const FwGlFns *gl, uint32_t cap, uint8_t on) {
    if (on) gl->Enable(cap); else gl->Disable(cap);
}

void fw_gl_restore(const FwGlFns *gl, const FwGlState *st) {
    gl->BindVertexArray((uint32_t)st->vao);   /* first: it owns GL_ELEMENT_ARRAY_BUFFER */
    gl->BindBuffer(FW_GL_ARRAY_BUFFER, (uint32_t)st->arrayBuffer);
    gl->BindBuffer(FW_GL_DRAW_INDIRECT_BUFFER, (uint32_t)st->indirectBuffer);
    gl->UseProgram((uint32_t)st->program);
    for (int u = 0; u < FW_GL_SAVED_UNITS; u++) {
        gl->ActiveTexture(FW_GL_TEXTURE0 + (uint32_t)u);
        gl->BindTexture(FW_GL_TEXTURE_2D, (uint32_t)st->tex2d[u]);
    }
    gl->ActiveTexture((uint32_t)st->activeTexture);   /* last */
    set_cap(gl, FW_GL_DEPTH_TEST, st->depthTest);
    set_cap(gl, FW_GL_STENCIL_TEST, st->stencilTest);
    set_cap(gl, FW_GL_BLEND, st->blend);
    set_cap(gl, FW_GL_CULL_FACE, st->cullFace);
    set_cap(gl, FW_GL_SCISSOR_TEST, st->scissorTest);
    gl->DepthFunc((uint32_t)st->depthFunc);
    gl->CullFace((uint32_t)st->cullFaceMode);
    gl->FrontFace((uint32_t)st->frontFace);
    gl->DepthMask(st->depthMask);
    gl->ColorMask(st->colorMask[0], st->colorMask[1], st->colorMask[2], st->colorMask[3]);
    gl->BlendFuncSeparate((uint32_t)st->blendSrcRgb, (uint32_t)st->blendDstRgb, (uint32_t)st->blendSrcA, (uint32_t)st->blendDstA);
    gl->BlendEquationSeparate((uint32_t)st->blendEqRgb, (uint32_t)st->blendEqA);
}

int fw_gl_drain_errors(const FwGlFns *gl, uint32_t *first, int max) {
    int n = 0;
    *first = 0;
    while (n < max) {
        uint32_t e = gl->GetError();
        if (e == FW_GL_NO_ERROR) break;
        if (!n) *first = e;
        n++;
    }
    return n;
}

void fw_gl_bind_units(const FwGlFns *gl, const uint32_t units[FW_GL_SAVED_UNITS]) { (void)gl; (void)units; }   /* RED stub */
