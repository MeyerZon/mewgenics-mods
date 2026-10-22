/* Pure status-definition rules for mewframework (no windows.h, no game memory) so they can be unit-tested on the
 * host (test/test_status_rules.c) and compiled into the DLL unchanged. status_engine.c keeps the game-facing parts
 * (vtable cloning, hooks, object walks); framework.c validates a definition here BEFORE it claims the name with
 * Mewjector, so a refused definition never owns a name.
 *
 * Rules (build 25143593): at most FW_STATUS_MAX_DEFS definitions (status_engine.c has exactly that many vtable
 * thunk rows), a non-empty name of at most FW_STATUS_NAME_MAX bytes (the MSVC std::string SSO buffer: the alias
 * rewrite below must never reallocate), the template must be FW_STATUS_TEMPLATE (the only vanilla status whose
 * constructor and vtable are pinned in the bindings manifest), and names are unique. */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "framework_api.h"

#define FW_STATUS_MAX_DEFS 8
#define FW_STATUS_NAME_MAX 15
#define FW_STATUS_TEMPLATE "LuckUp"

/* MSVC release std::string (32 bytes): SSO buffer or heap pointer, size, capacity (15 = SSO). */
typedef struct MsvcString {
    union { char buf[16]; char *ptr; } u;
    size_t size;
    size_t cap;
} MsvcString;
static inline const char *msvc_str(const MsvcString *s) { return s->cap > 15 ? s->u.ptr : s->u.buf; }

typedef enum FwStatusRule {
    FW_STATUS_OK = 0,
    FW_STATUS_ERR_NULL,            /* def, def->name or def->template_name is NULL */
    FW_STATUS_ERR_NAME_EMPTY,
    FW_STATUS_ERR_NAME_TOO_LONG,   /* > FW_STATUS_NAME_MAX */
    FW_STATUS_ERR_TEMPLATE,        /* template is not FW_STATUS_TEMPLATE */
    FW_STATUS_ERR_DUPLICATE,       /* name already in the table */
    FW_STATUS_ERR_TABLE_FULL,
    FW_STATUS_ERR_RESERVED         /* the name is in the FwGlow_ namespace (the data-level glow seam, fw_glow_rules.h) */
} FwStatusRule;

/* fw_status_table_find's answer for a FwGlow_<rrggbb[aa]> name (fw_glow_parse_status_name): one past the registered
 * slots. Such a name is a custom status without registration: the alias rewrite and the apply hook treat it like a
 * registered name (template LuckUp), and the status engine gives it the glow vtable. */
#define FW_STATUS_GLOW_SLOT FW_STATUS_MAX_DEFS

/* The registered custom names, in registration order (index = the engine's definition slot). */
typedef struct FwStatusTable {
    char names[FW_STATUS_MAX_DEFS][FW_STATUS_NAME_MAX + 1];
    int count;
} FwStatusTable;

void         fw_status_table_init(FwStatusTable *t);
FwStatusRule fw_status_validate(const FwStatusDef *def, const FwStatusTable *t);
/* validate, then append; returns the new index or -1 (why = the rule that refused it, FW_STATUS_OK on success) */
int          fw_status_table_add(FwStatusTable *t, const FwStatusDef *def, FwStatusRule *why);
/* exact-length match of `len` bytes against the registered names; FW_STATUS_GLOW_SLOT for a valid FwGlow_ name; -1 if none */
int          fw_status_table_find(const FwStatusTable *t, const char *bytes, size_t len);
const char  *fw_status_table_name(const FwStatusTable *t, int index);
const char  *fw_status_rule_text(FwStatusRule r);

/* Name aliasing: for the duration of one game lookup, make a registered custom name read as the template name,
 * then restore the caller's std::string byte-for-byte. Never reallocates: both names fit the SSO buffer, and a
 * heap-backed string (reused by the caller) has a capacity of at least 16 as well. */
typedef struct FwAliasSave { int did; size_t size; char *dst; char bytes[FW_STATUS_NAME_MAX + 1]; } FwAliasSave;
int  fw_alias_in(MsvcString *name, const FwStatusTable *t, FwAliasSave *save);   /* 1 if rewritten */
void fw_alias_out(MsvcString *name, const FwAliasSave *save);

/* Type hierarchy rewrite: replace every `fromId` in ids[0..min(count,cap)) with `toId`; returns the number swapped. */
int fw_hier_rewrite(int *ids, uint64_t count, uint64_t cap, uintptr_t fromId, int toId);
