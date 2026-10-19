/* Pure build-identity gate (no windows.h) so it can be unit-tested on the host
 * (framework/test/test_build.c). framework.c reads the PE header and calls this. */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "signatures.h"

/* Index into `table` of the build whose PE identity is (timeDateStamp, sizeOfImage), or -1. */
int fw_identify_build(uint32_t timeDateStamp, uint32_t sizeOfImage, const BuildInfo *table, size_t count);
