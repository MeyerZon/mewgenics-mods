/* fw_mesh_tex.h — the pure rules of mesh textures and the palette (3D phase M2/M3, docs/possible_3d_work.md;
 * design: SCRATCH/mesh/importer-design.md §2.7). No windows.h, no GL, no game: host-tested by test/test_mesh_tex.c and
 * compiled into mewframework.dll unchanged. mesh_engine.c is the glue (it does the game calls at record time and the GL
 * calls at replay time).
 *
 * The game side (OBSERVED, notes-r3dE G13f, decompiles App_GetTexture_0x9bb490.c / Texture2D_LoadFromFile_0xa0ad40.c):
 *  - App_GetTexture 0x9bb490 (FwSymbol 42) `Texture2D* (unused, std::string name)` loads "textures/" + name ONCE
 *    (cached forever) through ResourceManager_GetBinaryResource 0x973750 + stb_image, uploads it synchronously
 *    (glGenTextures into Texture2D+8, glTexImage2D, GL_LINEAR, GL_REPEAT, no mipmaps), premultiplies RGBA, and maps
 *    1/2-channel PNGs to GL_LUMINANCE(_ALPHA) — invalid in the 3.2 core context. It dereferences the BinaryResource
 *    WITHOUT a NULL test (0x140a0ae39): a missing file crashes the game.
 *  - So the existence check is ResourceManager_GetBinaryResource on the SAME path ("textures/" + name): the loader calls
 *    exactly that function on exactly that path, so a non-NULL result is precisely "the load will find bytes" (the -modpaths
 *    order and the gpak included), and the bytes are cached under the same key the loader then reuses (no second read).
 *    The bytes also let fw_png_check refuse a non-PNG / grey / 16-bit / huge file before stb_image sees it.
 *    (FileManager_FileExists 0x9a14c0 would answer only "a file exists" and need a new symbol.)
 *  - The GL texture name is the uint32 at Texture2D + OFF_TEX2D_GLNAME (0x8; manifest witness: `mov edx,[rbx+8]`
 *    before glBindTexture in Texture2D_LoadFromFile). Read at replay time; 0 = not uploaded: the draw skips it.
 *  - palette.png: TacticsTest::init binds App_GetTexture("palette.png") as "palettemap" (notes-r3dD G8, 0x14083429d):
 *    textures/palette.png, 16 columns x 256 rows. */
#pragma once
#include <stddef.h>
#include <stdint.h>

#define FW_TEX_NAME_MAX   63            /* chars of a texture name (under textures/), without the NUL */
#define FW_TEX_MAX_DIM    2048          /* refuse a bigger PNG (a prop texture; the importer warns above 1024) */
#define FW_TEX_PREFIX     "textures/"   /* App_GetTexture's prefix (Texture2D_LoadFromFile, "textures/" 0x141131920) */
#define FW_PALETTE_NAME   "palette.png" /* the game's palettemap, as TacticsTest::init names it */
#define FW_MESH_TEX_UNIT      0         /* fw_tex (the model's albedo) */
#define FW_MESH_PALETTE_UNIT  1         /* palettemap */

/* A texture name as App_GetTexture takes it (relative to textures/): 1..63 chars of [A-Za-z0-9_./-], ending ".png",
 * no leading '/', no empty / "." / ".." segment, so no backslash, drive colon or escape. 1 ok, 0 refused. */
int fw_tex_name_ok(const char *name);

/* The convention: models/<path>/<stem>.<ext> -> "models/<stem>.png" (the file's base name without its extension,
 * sub-folders dropped). 1 ok, 0 (out = "") when the model path is not a valid model path or it does not fit. */
int fw_tex_default_name(const char *modelPath, char *out, size_t cap);

/* Which texture an object's model uses: the explicit name (API / GON `texture`) when non-empty, else the convention.
 * named = 1 when the texture was asked for (an explicit name, or the model's own material named an image — glTF
 * baseColorTexture), so its absence is worth the `model-texture-missing` line; 0 when only the convention applies (an
 * untextured model is normal). path = FW_TEX_PREFIX + name (the existence-check path). 0 when the explicit name is
 * invalid (fw_tex_name_ok) or there is no usable name. */
typedef struct FwTexChoice { char name[FW_TEX_NAME_MAX + 1]; char path[FW_TEX_NAME_MAX + 1 + 9]; int named; int explicitName; } FwTexChoice;
int fw_tex_choose(const char *explicitName, const char *modelPath, int materialNamedImage, FwTexChoice *out);

/* A PNG's header, before App_GetTexture's stb_image sees it. Returns FW_PNG_OK and *w / *h, or a code (why = text):
 * not a PNG (signature / IHDR), a format the core context cannot sample (colour type other than 2 RGB / 6 RGBA, or a bit
 * depth other than 8: grey PNGs become GL_LUMINANCE), or bigger than FW_TEX_MAX_DIM / zero-sized. */
enum { FW_PNG_OK = 0, FW_PNG_NOT_PNG = 1, FW_PNG_FORMAT = 2, FW_PNG_SIZE = 3 };
int fw_png_check(const uint8_t *bytes, size_t len, int *w, int *h, char *why, size_t cap);

/* The palette row a draw uses: requested < 0 = off (-1); 0 <= requested < paletteHeight = that row; a row past the
 * palette (or no palette: height <= 0) = off (-1). */
int fw_palette_row(int requested, int paletteHeight);

/* Record-time cache of texture lookups by name (each name is checked and loaded once per process: App_GetTexture caches
 * forever, a missing / refused file stays refused). */
#define FW_TEX_CACHE_MAX 32
enum { FW_TEX_UNKNOWN = 0, FW_TEX_LOADED = 1, FW_TEX_ABSENT = -1, FW_TEX_REFUSED = -2 };
typedef struct FwTexEntry { char name[FW_TEX_NAME_MAX + 1]; int state; void *texture; int w, h; } FwTexEntry;
typedef struct FwTexCache { int count; FwTexEntry e[FW_TEX_CACHE_MAX]; } FwTexCache;   /* zero-initialise */
/* the entry for name (create = 1 adds an FW_TEX_UNKNOWN one); NULL when absent and not created, the cache is full, or
 * the name is empty / too long */
FwTexEntry *fw_tex_cache_get(FwTexCache *c, const char *name, int create);

/* replay time: the GL texture name of a Texture2D* (uint32 at OFF_TEX2D_GLNAME); 0 for NULL */
uint32_t fw_tex_gl_name(const void *texture2d);

/* What one draw binds and sets: unit FW_MESH_TEX_UNIT = the albedo (hasTex = 1) when its GL name is non-zero, unit
 * FW_MESH_PALETTE_UNIT = palette.png when the row is on AND its GL name is non-zero (else palette = -1 and the unit is
 * bound to 0). units[] is indexed by unit. */
typedef struct FwMeshMaterialPlan { uint32_t units[2]; int hasTex; int palette; } FwMeshMaterialPlan;
void fw_mesh_material_plan(uint32_t texName, uint32_t paletteName, int paletteRow, FwMeshMaterialPlan *out);

/* "mesh object f=<frame> handle=<h> model=<model> tile|unit world=(x y z) ndc=(x y z) tex=<name|none> palette=<row>"
 * — ndc = the object's mid-height anchor through its mvp (the shot point the T2 measurement looks at). The length
 * written, NUL-terminated (truncated to n - 1). */
int fw_mesh_fmt_object(char *buf, size_t n, int frame, int handle, const char *model, int byTile, const float world[3],
                       const float ndc[3], const char *tex, int palette);
