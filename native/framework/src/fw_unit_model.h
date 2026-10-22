/* Pure rules of the per-unit models (3D phase M2 item 4, docs/possible_3d_work.md): a character's or static object's
 * GON `graphics.model` (fw_gon_model_block) makes mewframework draw that model on the unit, following it as it moves.
 * No windows.h, no game calls: host-tested by test/test_unit_model.c over fake memory and compiled into the DLL
 * unchanged. obj3d_engine.c does the guarded reads, the registration (obj3d_engine_register) and the logging.
 *
 *  - the units walk: TurnControl+OFF_TC_SCENE -> Scene+OFF_SCENE_EM -> EntityManager+OFF_EM_X -> +OFF_X_CHARARRAY
 *    (RefArray: +OFF_ARR_COUNT u32, +OFF_ARR_DATA Character**), the harness's `dump` walk (docs/engine-map.md
 *    "Dev scenes and run entry"), through the caller's guarded reader;
 *  - the seen set: each (Character*, pool generation) is looked at once, so the GON walk costs one pass per unit, not
 *    one per frame; a reused pool slot (new generation) is a new unit;
 *  - the object's own transform from the block: T(offset) x Ry(yaw) x S(scale) (column-major, the game's (x, height,
 *    z) axes; yaw > 0 turns the model clockwise as the vanilla camera shows it: front lower right -> down -> lower left);
 *  - facing: the unit's Renderer_GetScreenMatrix m0 sign (+1 / -1); -1 mirrors the model across the screen vertical,
 *    which in the iso basis is the x <-> z swap (fw_obj3d_model_matrix applies it about the anchor). */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "offsets.h"
#include "fw_gon.h"

#define FW_UNIT_WALK_MAX 256   /* a longer character array is a misread pointer (the harness's MAX_UNITS idea) */
/* the fight's Character* array into out[0..cap): the count copied (<= cap), -1 unreadable / implausible (count >
 * FW_UNIT_WALK_MAX), 0 for a NULL turnControl */
int fw_unit_walk(FwMemRead rd, void *u, const void *turnControl, void **out, int cap);

#define FW_UNIT_SEEN_MAX 256
typedef struct FwUnitSeen { int n; const void *ch[FW_UNIT_SEEN_MAX]; uint64_t gen[FW_UNIT_SEEN_MAX]; } FwUnitSeen;
void fw_unit_seen_clear(FwUnitSeen *s);
/* 1 the first time (character, generation) is offered (and remembers it; a known character with a new generation is
 * updated in place), 0 after that. A full set starts over (every unit is looked at once more). */
int fw_unit_seen_first(FwUnitSeen *s, const void *character, uint64_t generation);

/* the block's transform: T(offset) x Ry(yawDeg) x S(scale); a scale <= 0 is taken as 1, offset NULL as 0 0 0 */
void fw_unit_model_transform(double scale, double yawDeg, const double offset[3], float out[16]);
/* +1, or -1 when the renderer's screen matrix m0 (x scale) is negative (the unit's sprite is mirrored) */
int fw_unit_facing(const float screen[16]);

/* "unit model: <entry> <Character*> -> <file>" plus " (block scale=<g> yaw=<g> offset=(<g> <g> <g>)[ texture=<t>]
 * [ invalid=0x<bits>])" for the block form. The length written; always NUL-terminated. */
int fw_unit_fmt_model(char *buf, size_t n, const char *entry, const void *character, const FwGonModel *m);
/* "unit model at: <entry> handle=<h> world=(<x> <z>) screen=(<m12> <m13>) facing=<+1|-1> m0=<g> ms=<epoch ms>": the
 * unit's raw world position (what the mesh engine anchors the model at), its screen matrix translation and x scale
 * (Renderer_GetScreenMatrix) and the wall clock (ms since 1970, to line the position up with a shot's file time).
 * Logged when the position moves by >= FW_UNIT_MOVE_EPS (and the first time). %.3f for world/screen, %g for m0. */
#define FW_UNIT_MOVE_EPS 0.01
int fw_unit_fmt_at(char *buf, size_t n, const char *entry, int handle, const double xz[2], const float screen[16], int facing, uint64_t epochMs);
/* 1 when the position moved by >= FW_UNIT_MOVE_EPS in x or z from `last` (or `last` is NULL = never logged) */
int fw_unit_moved(const double last[2], const double now[2]);
