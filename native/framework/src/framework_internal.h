/* Shared between framework.c and status_engine.c; not part of the public API. */
#pragma once
#include <stdint.h>
#include "mewjector.h"
#include "framework_api.h"
#include "signatures.h"
#include "offsets.h"
#include "fw_status_rules.h"   /* MsvcString, the status table rules (pure, host-tested) */

extern MewjectorAPI g_mj;
extern int g_mjAvailable;
extern uintptr_t g_base;
extern const BuildInfo *g_build;
extern uintptr_t g_sym[FW_SYMBOL_COUNT_];

void fw_log(const char *fmt, ...);

/* status_engine.c */
int status_engine_install_hooks(void);  /* called once the framework is active */
int status_engine_register(const FwStatusDef *def);
const FwStatusTable *status_engine_table(void);   /* the registered names, for fw_status_validate() */
int status_engine_set_stacks(void *status, int value);
int status_engine_has_status(void *character, const char *statusName);
void status_engine_on_begin_turn(void *character);
