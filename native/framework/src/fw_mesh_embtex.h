/* fw_mesh_embtex.h — a model's OWN texture (3D phase M3): the image a .glb embeds (material -> baseColorTexture ->
 * texture -> image with bufferView + mimeType image/png, or a data:image/png;base64 URI), decoded in the DLL
 * (fw_png.c) and uploaded with our own glTexImage2D — in memory only, nothing is written to disk. Pure C11 (no
 * windows.h, no game): host-tested by test/test_mesh_embtex.c against a fake GL; mesh_engine.c is the glue (it decodes
 * at record time and uploads inside the draw functor at replay, where the GL context is current and the state is saved).
 *
 * Which texture an object draws with (fw_tex_source):
 *   1. an explicit name (GON `texture`, FW_Set3DObjectMaterial, MEWFW_MESH_PROBE_TEXTURE) — textures/<name> through
 *      App_GetTexture (fw_mesh_tex.c); a missing / refused explicit file draws the base colour (no fallback);
 *   2. else the model's embedded image, when the model file carries one;
 *   3. else the convention textures/models/<stem>.png (fw_tex_default_name), and also when the embedded image does not
 *      decode (its warning is logged once).
 * The winner is named in the texture's load line: "(source explicit|embedded|convention)". */
#pragma once
#include <stddef.h>
#include <stdint.h>

enum { FW_TEXSRC_NONE = 0, FW_TEXSRC_EXPLICIT = 1, FW_TEXSRC_EMBEDDED = 2, FW_TEXSRC_CONVENTION = 3 };
/* the rule above: explicitName non-empty -> EXPLICIT; else hasEmbedded -> EMBEDDED; else CONVENTION */
int fw_tex_source(const char *explicitName, int hasEmbedded);
const char *fw_tex_source_name(int src);   /* "explicit" | "embedded" | "convention" | "none" */

#define FW_EMBTEX_MAX_DIM 2048     /* = FW_TEX_MAX_DIM: refuse a bigger embedded image */
enum { FW_EMB_UNKNOWN = 0, FW_EMB_DECODED = 1, FW_EMB_UPLOADED = 2, FW_EMB_REFUSED = -1 };
typedef struct FwEmbTex {
    int state;
    int w, h;
    uint8_t *rgba;          /* FW_EMB_DECODED: premultiplied RGBA8 waiting for the upload (freed by it) */
    uint32_t gl;            /* FW_EMB_UPLOADED: our GL texture name */
    char name[96];          /* "embedded:<model path>": the log's / the object line's texture name */
    const char *code;       /* FW_EMB_REFUSED: model-image-embedded-invalid | model-image-embedded-unsupported */
    char why[160];
} FwEmbTex;

/* record time: decodes the model's embedded PNG bytes once (any state other than UNKNOWN: returns it unchanged).
 * DECODED (pixels premultiplied the game's way, fw_png_premultiply) or REFUSED with code + why:
 *   a corrupt / truncated / not-PNG image -> model-image-embedded-invalid,
 *   bit depth != 8, interlaced, an unknown critical chunk, a side over FW_EMBTEX_MAX_DIM -> model-image-embedded-unsupported. */
int fw_embtex_decode(FwEmbTex *t, const char *modelPath, const uint8_t *png, size_t len);

/* the GL a texture upload needs (the DLL fills them from opengl32: all GL 1.1 exports; the test with a fake) */
#define FW_GL_UNPACK_ALIGNMENT             0x0CF5
#define FW_GL_TEXTURE_MAG_FILTER           0x2800
#define FW_GL_TEXTURE_MIN_FILTER           0x2801
#define FW_GL_TEXTURE_WRAP_S               0x2802
#define FW_GL_TEXTURE_WRAP_T               0x2803
#define FW_GL_LINEAR                       0x2601
#define FW_GL_REPEAT                       0x2901
#define FW_GL_RGBA                         0x1908
#define FW_GL_UNSIGNED_BYTE                0x1401
#define FW_GL_PIXEL_UNPACK_BUFFER          0x88EC
#define FW_GL_PIXEL_UNPACK_BUFFER_BINDING  0x88EF
typedef struct FwTexUploadGl {
    void (*GetIntegerv)(uint32_t pname, int32_t *out);
    void (*GenTextures)(int n, uint32_t *out);
    void (*BindTexture)(uint32_t target, uint32_t texture);
    void (*PixelStorei)(uint32_t pname, int32_t v);
    void (*TexImage2D)(uint32_t target, int level, int32_t internalFormat, int w, int h, int border, uint32_t format, uint32_t type, const void *pixels);
    void (*TexParameteri)(uint32_t target, uint32_t pname, int32_t v);
    void (*BindBuffer)(uint32_t target, uint32_t buffer);
} FwTexUploadGl;

/* replay time (GL context current): DECODED -> one texture like Texture2D_LoadFromFile makes it (GL_RGBA, unpack
 * alignment 1, GL_LINEAR min/mag, GL_REPEAT s/t, no mipmaps), pixels freed, state UPLOADED; returns the GL name.
 * UPLOADED -> its name; any other state -> 0. Puts back what it changes: the 2D binding of the active unit, the unpack
 * alignment and the pixel-unpack buffer binding (unbound for the upload when one was bound). A GenTextures that yields 0
 * refuses the texture (REFUSED, "glGenTextures returned 0"). */
uint32_t fw_embtex_upload(FwEmbTex *t, const FwTexUploadGl *gl);

void fw_embtex_free(FwEmbTex *t);   /* frees pending pixels, zeroes it (the GL name is not deleted: textures live as long as the process, like App_GetTexture's cache) */

/* "mesh: texture embedded:<model> for <model>: decoded WxH (source embedded: the model file's own image, decoded in the
 * DLL, uploaded at replay)" or "mesh: model <model>: <code>: embedded image: <why>: <fallback>" — the length written */
int fw_embtex_fmt_load(char *buf, size_t n, const char *model, const FwEmbTex *t);
