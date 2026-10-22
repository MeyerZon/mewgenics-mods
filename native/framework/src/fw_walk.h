/* Pure entity/component walks and object edits of the status engine (no windows.h, no game calls) so they can be
 * unit-tested on the host over fake byte buffers (test/test_walk.c) and compiled into the DLL unchanged. Every
 * field is reached through the generated offsets.h macros: Character+OFF_CH_ENTITY = Entity*,
 * Entity+OFF_ENT_COMPCOUNT / +OFF_ENT_COMPS = {u32 count, Component** data} (the {cap, count, data} vector at
 * Entity+0x20 whose push LuckUp_ctor calls), Status+0 = vtable, +OFF_STATUS_* fields. status_engine.c keeps the
 * calls into the game (the template constructor, vtable slot calls, Status_Remove, the string destructor) and
 * sequences them around these writes exactly as before. */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "offsets.h"

/* ---- accessors ---- */
static inline void   *fw_walk_char_entity(const void *character) { return *(void *const *)((const char *)character + OFF_CH_ENTITY); }
static inline uint32_t fw_walk_entity_count(const void *entity) { return *(const uint32_t *)((const char *)entity + OFF_ENT_COMPCOUNT); }
static inline void  **fw_walk_entity_components(const void *entity) { return *(void **const *)((const char *)entity + OFF_ENT_COMPS); }
static inline void   *fw_walk_status_vt(const void *status) { return *(void *const *)status; }
static inline int    *fw_walk_status_stacks(void *status) { return (int *)((char *)status + OFF_STATUS_STACKS); }
static inline void   *fw_walk_status_character(const void *status) { return *(void *const *)((const char *)status + OFF_STATUS_CHARACTER); }
static inline char    fw_walk_status_removing(const void *status) { return *((const char *)status + OFF_STATUS_REMOVING); }
static inline char    fw_walk_status_temporary(const void *status) { return *((const char *)status + OFF_STATUS_TEMPORARY); }

/* The first component of `character` whose vtable is `vt` and that is neither removing nor temporary; NULL if none
 * (also when character or its entity is NULL). */
void *fw_walk_find_status(void *character, const void *vt);
/* The same over an Entity directly (the `entity` apply_status resolves from its ctx): the glow apply's merge lookup */
void *fw_walk_entity_find_status(void *entity, const void *vt);

/* The first component of `character` whose vtable is `vt` and that is not removing, temporary ones included (a
 * glow status granted as a Temporary still glows until it expires); NULL if none or NULL character/entity. */
void *fw_walk_find_live(void *character, const void *vt);

/* Index of `vt` in vts[0..count), -1 if absent (a NULL vt never matches). */
int fw_walk_vt_index(void *const *vts, int count, const void *vt);

/* Visit every non-removing component of `character` whose vtable is one of vts, in component order:
 * cb(index into vts, component, user). Returns the number of visits (0 for a NULL character/entity or count 0). */
typedef void (*FwWalkVisit)(int defIndex, void *component, void *user);
int fw_walk_each_custom(void *character, void *const *vts, int count, FwWalkVisit cb, void *user);

/* ---- apply_status(name, ctx, stacks, src, p5, p6, temporary, p8) argument resolution ---- */
typedef struct FwApplyResolved { void *character; void *entity; void *source; void *applier; } FwApplyResolved;
/* character/entity from ctx; source = src or defaultSource; applier = p5, else p6->applier, else NULL */
void fw_walk_apply_resolve(const void *ctx, void *src, void *p5, const void *p6, void *defaultSource, FwApplyResolved *out);
/* an existing instance is merged into unless the apply is temporary; otherwise a new object is constructed */
static inline int fw_walk_apply_merges(const void *existing, char temporary) { return existing != NULL && temporary == 0; }
/* the merge writes: stacks += delta, applier, applierOwner (= *(applier + OFF_APPLIER_OWNER), NULL without an applier);
 * returns the new stacks (0 = the caller removes the status) */
int fw_walk_merge_stacks(void *existing, int delta, void *applier);
/* a freshly constructed template object becomes ours: vtable swap + the temporary flag */
void fw_walk_adopt(void *obj, void **vt, char temporary);

/* ---- FW_SetStatusStacks pieces (the caller calls VT_ONSTACKSCHANGED between them, then removes at 0) ---- */
void fw_walk_write_stacks(void *status, int value);
int  fw_walk_touch_passives(void *status);   /* marks the status's character for a stat recompute; 1 if it had one */
