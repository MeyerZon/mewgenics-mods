/* Pure signature-scanning primitives (no windows.h) so they can be unit-tested on the
 * host (framework/test/test_sig.c). framework.c wraps them with the PE section walk. */
#pragma once
#include <stdint.h>
#include <stddef.h>

#define FW_SIG_MAX_BYTES 128

/* Parse an IDA-style pattern ("48 8B ?? C4") into bytes + mask (1 = must match).
 * Returns the byte count, 0 for an empty pattern, -1 on bad hex or more than `cap` bytes. */
int fw_parse_pattern(const char *sig, uint8_t *bytes, uint8_t *mask, size_t cap);

/* Scan `len` bytes for the masked pattern. Returns the FIRST hit (or NULL) and ADDS the
 * number of hits to *matches, stopping early once *matches reaches 2 (the caller only
 * cares about "exactly one"). A zero-length pattern never matches. */
const uint8_t *fw_scan_buffer(const uint8_t *buf, size_t len, const uint8_t *bytes, const uint8_t *mask, size_t n, int *matches);
