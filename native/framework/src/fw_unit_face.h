/* Pure rules of a unit model's facing (3D phase M3 `face`): the model turns with the unit's Character::Face direction
 * instead of mirroring with its sprite. No windows.h, no game calls: host-tested by test/test_unit_face.c over fake
 * memory and compiled into the DLL unchanged; obj3d_engine.c reads through its guarded reader and logs.
 *
 *  - the direction: glaiel::Character::Face 0x10ce50 stores the grid direction the unit faces as an iVec2D (int x,
 *    int y) at Character+OFF_CH_ORIENTATION (0x388, manifest entry Character_orientation, witnessed by the one store
 *    `mov [rdi+0x388],rbx` in Character_Face). Grid (dx, dy) is world (x, z): units stand at (col + 0.5, 0, row + 0.5).
 *    It is the logical direction (lock_orientation / always_face_forward already applied); the sprite's two-way art
 *    shows it as F for (0,-1) / (-1,0) and B for (1,0) / (0,1) (docs/engine-map.md "Facing: Character::Face").
 *  - the yaw: the model's front (glTF +Z / OBJ +Z, which the loaders mirror to world -z) faces dir (0,-1) at yaw 0,
 *    the lower right on screen; the GON `yaw` convention (clockwise on screen) gives dir (-1,0) = 90, (0,1) = 180,
 *    (1,0) = 270, i.e. yaw = atan2(-dx, -dy) in degrees, in [0, 360). Diagonals give the multiples of 45 between.
 *  - the fallback when the direction is unreadable or (0,0): the sprite's mirror (Renderer_GetScreenMatrix m0 sign,
 *    fw_unit_facing): -1 = dir (-1,0) = 90, +1 = 0. The GON block's own yaw stays inside the object's transform, so
 *    it adds on top (model matrix = T(anchor) x Ry(face yaw) x T(offset) x Ry(yaw) x S(scale)). */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "offsets.h"
#include "fw_gon.h"

/* the unit's facing direction from Character+OFF_CH_ORIENTATION: 1 and dir = (dx, dy) when readable and non-zero,
 * 0 for (0,0) (never faced; dir = 0 0), -1 unreadable or NULL (dir = 0 0) */
int fw_face_read_dir(FwMemRead rd, void *u, const void *character, int dir[2]);

/* 1 and *yawDeg = atan2(-dx, -dy) in degrees, normalised to [0, 360) (-0 -> 0); 0 for (0,0) / NULL (*yawDeg = 0) */
int fw_face_yaw_deg(const int dir[2], double *yawDeg);

#define FW_FACE_SRC_DIR  1   /* the yaw came from Character+OFF_CH_ORIENTATION */
#define FW_FACE_SRC_FLIP 2   /* fallback: the sprite's mirror sign */
/* the face yaw the model gets this frame: dirOk (fw_face_read_dir == 1) -> fw_face_yaw_deg(dir); else the sprite's
 * mirror sign (flip < 0 -> 90, else 0). *src (may be NULL) = FW_FACE_SRC_DIR / FW_FACE_SRC_FLIP. */
double fw_face_yaw(int dirOk, const int dir[2], int flip, int *src);

/* Ry(yawDeg) about the height axis, column-major, the same rotation as fw_unit_model_transform's (x' = c*x + s*z,
 * z' = -s*x + c*z); multiples of 90 are exact (0 / +-1 entries, no -0 from cos/sin rounding) */
void fw_face_rotation(double yawDeg, float out[16]);

/* "unit model face: <entry> handle=<h> dir=(<dx> <dy>) yaw=<g> src=dir|flip ms=<epoch ms>"; the length written,
 * always NUL-terminated. Logged when the yaw changes (and the first time). */
int fw_face_fmt(char *buf, size_t n, const char *entry, int handle, const int dir[2], double yawDeg, int src, uint64_t epochMs);
