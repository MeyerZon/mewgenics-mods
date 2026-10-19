/* Shared between framework.c and status_engine.c; not part of the public API. */
#pragma once
#include <stdint.h>
#include "mewjector.h"
#include "framework_api.h"
#include "signatures.h"
#include "offsets.h"

extern MewjectorAPI g_mj;
extern int g_mjAvailable;
extern uintptr_t g_base;
extern const BuildInfo *g_build;
extern uintptr_t g_sym[FW_SYMBOL_COUNT_];

void fw_log(const char *fmt, ...);

/* MSVC release std::string (32 bytes): SSO buffer or heap pointer, size, capacity (15 = SSO). */
typedef struct MsvcString {
    union { char buf[16]; char *ptr; } u;
    size_t size;
    size_t cap;
} MsvcString;
static inline const char *msvc_str(const MsvcString *s) { return s->cap > 15 ? s->u.ptr : s->u.buf; }

/* status_engine.c */
int status_engine_install_hooks(void);  /* called once the framework is active */
int status_engine_register(const FwStatusDef *def);
int status_engine_set_stacks(void *status, int value);
int status_engine_has_status(void *character, const char *statusName);
void status_engine_on_begin_turn(void *character);
