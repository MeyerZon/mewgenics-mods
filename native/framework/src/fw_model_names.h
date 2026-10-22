/* Named models (3D phase M3, "@Name"): a mod declares models once by name in data/models.gon and a unit refers to one
 * with `graphics { model "@Crate" }` or `graphics { model { file "@Crate"  scale 2 } }` (importer design §3.2: the
 * `file` value is "models/<...>.obj|.gltf|.glb or @Name"). Pure: no windows.h, no game calls; host-tested by
 * test/test_model_names.c over fake GonObject memory and compiled into the DLL unchanged. obj3d_engine.c loads the
 * merged registry through the game's own GON loader (Gon_LoadFile on the resource map: -modpaths, overlays of every
 * mod applied in mod-path order) and does the logging.
 *
 *     data/models.gon (mods/fw-3d ships the empty base; a mod adds entries with data/models.gon.append / .merge / .patch)
 *         Crate  { file "models/crate.obj"  scale 0.8  yaw 45  texture "models/crate.png" }   // the block form
 *         Pillar "models/pillar.glb"                                                         // the string form
 *
 * An entry carries every key of the graphics.model block (fw_gon_model_node). A unit's reference resolves to the entry;
 * the keys the unit's own block sets (FwGonModel.given, texture / palette / double_sided when given) override it.
 * An entry must name a model file: no "@Other" chains (one level, so no cycles). */
#pragma once
#include <stddef.h>
#include "fw_gon.h"

#define FW_MODEL_REGISTRY_FILE "data/models.gon"
#define FW_MODEL_NAMES_MAX 64          /* entries kept per load; more are counted in `dropped` */
#define FW_MODEL_NAME_MAX 63           /* an entry name longer than this is kept truncated and never matches */

/* why an entry is refused (FwModelName.bad); a refused entry still "exists" (a reference to it gets the
 * model-registry-entry code, not model-name-unknown) */
enum {
    FW_MODEL_ENTRY_OK = 0,
    FW_MODEL_ENTRY_NOT_MODEL,   /* neither a string nor a block (a number, an array, a bool) */
    FW_MODEL_ENTRY_NO_FILE,     /* a block without a string `file` */
    FW_MODEL_ENTRY_CHAIN,       /* `file` is itself an "@Name" */
    FW_MODEL_ENTRY_PATH         /* `file` is not a models/<...>.obj|.gltf|.glb path (fw_mesh_model_kind) */
};

typedef struct FwModelName {
    char name[FW_MODEL_NAME_MAX + 1];
    FwGonModel m;               /* the parsed entry (isBlock 0 for the string form) */
    int bad;                    /* FW_MODEL_ENTRY_* */
} FwModelName;

typedef struct FwModelNames {
    int loaded;                 /* 0 never loaded / cleared, 1 loaded (possibly empty), -1 the registry is unreadable */
    int n;
    int dropped;                /* entries past FW_MODEL_NAMES_MAX */
    FwModelName e[FW_MODEL_NAMES_MAX];
} FwModelNames;

void fw_model_names_clear(FwModelNames *r);
/* every child of `root` (the registry file's root GonObject; NULL = the file is absent: an empty registry) into r:
 * the number of entries kept (>= 0), -1 when root is unreadable (r->loaded = -1). A later duplicate name replaces the
 * earlier entry (the last definition wins, as a .merge would leave it). */
int fw_model_names_load(FwMemRead rd, void *u, const void *root, FwModelNames *r);
/* the entry called `name` (no "@"), NULL when none */
const FwModelName *fw_model_names_find(const FwModelNames *r, const char *name);

/* resolve a unit's model value:
 *   FW_MODEL_REF_NONE    0: unit->file is not an "@Name" reference; *out = *unit
 *   FW_MODEL_REF_OK      1: *out = the entry with the unit's given keys over it (file = the entry's model path)
 *   FW_MODEL_REF_UNKNOWN -1: no entry of that name (model-name-unknown)
 *   FW_MODEL_REF_BAD     -2: the entry is refused (model-registry-entry; *hit says why)
 * On -1 / -2 *out = *unit. hit (may be NULL) receives the entry for 1 / -2. */
enum { FW_MODEL_REF_BAD = -2, FW_MODEL_REF_UNKNOWN = -1, FW_MODEL_REF_NONE = 0, FW_MODEL_REF_OK = 1 };
int fw_model_names_resolve(const FwModelNames *r, const FwGonModel *unit, FwGonModel *out, const FwModelName **hit);

/* the one log line of a failed reference (design §2.6 shape; unitEntry may be NULL):
 *   "mesh: @Box: model-name-unknown: no data/models.gon entry named Box (unit Rat; 2 named models) — drawing the 2D clip"
 *   "mesh: @Box: model-registry-entry: data/models.gon entry Box <why> (unit Rat) — drawing the 2D clip"
 * Returns the length written; always NUL-terminated. */
int fw_model_names_fmt_error(char *buf, size_t n, const char *ref, int rc, const char *unitEntry, const FwModelNames *r, const FwModelName *hit);
/* "model names: data/models.gon: <n> entr(y|ies)[: A, B, ...][ (<k> dropped)]" or "...: absent (no mod ships it; mods/fw-3d
 * has the base)" (root NULL) or "...: unreadable" — the load line */
int fw_model_names_fmt_loaded(char *buf, size_t n, const FwModelNames *r, int absent);

/* the once-per-process gate of the error line: 1 the first time `ref` is offered (remembered), 0 after (and when full) */
#define FW_MODEL_NAMES_LOGGED_MAX 64
typedef struct FwModelNamesLogged { int n; char ref[FW_MODEL_NAMES_LOGGED_MAX][FW_MODEL_NAME_MAX + 2]; } FwModelNamesLogged;
int fw_model_names_log_first(FwModelNamesLogged *g, const char *ref);
