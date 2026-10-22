/* fw_mesh_embtex.c — a model's own (embedded) texture: source precedence, decode once, upload once (fw_mesh_embtex.h).
 * Host-tested in test/test_mesh_embtex.c. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "fw_mesh_embtex.h"
#include "fw_mesh_rules.h"
#include "fw_png.h"

#define GL_TEXTURE_2D_ 0x0DE1
#define GL_TEXTURE_BINDING_2D_ 0x8069

int fw_tex_source(const char *explicitName, int hasEmbedded) {
    if (explicitName && explicitName[0]) return FW_TEXSRC_EXPLICIT;
    return hasEmbedded ? FW_TEXSRC_EMBEDDED : FW_TEXSRC_CONVENTION;
}

const char *fw_tex_source_name(int src) {
    switch (src) {
    case FW_TEXSRC_EXPLICIT: return "explicit";
    case FW_TEXSRC_EMBEDDED: return "embedded";
    case FW_TEXSRC_CONVENTION: return "convention";
    default: return "none";
    }
}

int fw_embtex_decode(FwEmbTex *t, const char *modelPath, const uint8_t *png, size_t len) {
    if (!t) return FW_EMB_REFUSED;
    if (t->state != FW_EMB_UNKNOWN) return t->state;
    snprintf(t->name, sizeof t->name, "embedded:%s", modelPath ? modelPath : "?");
    FwPngImage img;
    char why[160];
    int rc = fw_png_decode(png, len, FW_EMBTEX_MAX_DIM, &img, why, sizeof why);
    if (rc != FW_PNGD_OK) {
        t->state = FW_EMB_REFUSED;
        t->code = fw_mesh_code((rc == FW_PNGD_UNSUPPORTED || rc == FW_PNGD_SIZE) ? FW_MC_IMAGE_EMBEDDED_UNSUPPORTED : FW_MC_IMAGE_EMBEDDED_INVALID);
        snprintf(t->why, sizeof t->why, "%s", why);
        return t->state;
    }
    fw_png_premultiply(img.rgba, (size_t)img.w * (size_t)img.h);
    t->rgba = img.rgba; t->w = img.w; t->h = img.h;
    t->state = FW_EMB_DECODED;
    return t->state;
}

uint32_t fw_embtex_upload(FwEmbTex *t, const FwTexUploadGl *gl) {
    if (!t) return 0;
    if (t->state == FW_EMB_UPLOADED) return t->gl;
    if (t->state != FW_EMB_DECODED || !gl) return 0;
    int32_t prevTex = 0, prevAlign = 4, prevUnpack = 0;
    gl->GetIntegerv(GL_TEXTURE_BINDING_2D_, &prevTex);
    gl->GetIntegerv(FW_GL_UNPACK_ALIGNMENT, &prevAlign);
    gl->GetIntegerv(FW_GL_PIXEL_UNPACK_BUFFER_BINDING, &prevUnpack);
    uint32_t name = 0;
    gl->GenTextures(1, &name);
    if (!name) {
        free(t->rgba); t->rgba = NULL;
        t->state = FW_EMB_REFUSED;
        t->code = fw_mesh_code(FW_MC_IMAGE_EMBEDDED_INVALID);
        snprintf(t->why, sizeof t->why, "glGenTextures returned 0");
        return 0;
    }
    if (prevUnpack) gl->BindBuffer(FW_GL_PIXEL_UNPACK_BUFFER, 0);
    gl->BindTexture(GL_TEXTURE_2D_, name);
    gl->PixelStorei(FW_GL_UNPACK_ALIGNMENT, 1);
    gl->TexImage2D(GL_TEXTURE_2D_, 0, FW_GL_RGBA, t->w, t->h, 0, FW_GL_RGBA, FW_GL_UNSIGNED_BYTE, t->rgba);
    gl->TexParameteri(GL_TEXTURE_2D_, FW_GL_TEXTURE_MIN_FILTER, FW_GL_LINEAR);
    gl->TexParameteri(GL_TEXTURE_2D_, FW_GL_TEXTURE_MAG_FILTER, FW_GL_LINEAR);
    gl->TexParameteri(GL_TEXTURE_2D_, FW_GL_TEXTURE_WRAP_S, FW_GL_REPEAT);
    gl->TexParameteri(GL_TEXTURE_2D_, FW_GL_TEXTURE_WRAP_T, FW_GL_REPEAT);
    gl->PixelStorei(FW_GL_UNPACK_ALIGNMENT, prevAlign);
    gl->BindTexture(GL_TEXTURE_2D_, (uint32_t)prevTex);
    if (prevUnpack) gl->BindBuffer(FW_GL_PIXEL_UNPACK_BUFFER, (uint32_t)prevUnpack);
    free(t->rgba); t->rgba = NULL;
    t->gl = name;
    t->state = FW_EMB_UPLOADED;
    return name;
}

void fw_embtex_free(FwEmbTex *t) {
    if (!t) return;
    free(t->rgba);
    memset(t, 0, sizeof *t);
}

int fw_embtex_fmt_load(char *buf, size_t n, const char *model, const FwEmbTex *t) {
    int k;
    if (t && (t->state == FW_EMB_DECODED || t->state == FW_EMB_UPLOADED))
        k = snprintf(buf, n, "mesh: texture %s for %s: decoded %dx%d (source embedded: the model file's own image, decoded in the DLL, uploaded at replay)",
                     t->name, model ? model : "?", t->w, t->h);
    else
        k = snprintf(buf, n, "mesh: model %s: %s: embedded image: %s: the convention texture or the base colour draws",
                     model ? model : "?", t && t->code ? t->code : "model-image-embedded-invalid", t && t->why[0] ? t->why : "not decoded");
    if (k < 0) { if (n) buf[0] = 0; return 0; }
    return (size_t)k < n ? k : (int)(n ? n - 1 : 0);
}
