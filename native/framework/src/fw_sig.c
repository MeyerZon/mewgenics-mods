/* Pure signature-scanning primitives; see fw_sig.h. Kept free of windows.h and stdio so
 * the host test build (framework/test.bat, -Werror) compiles them as-is. */
#include "fw_sig.h"

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int fw_parse_pattern(const char *sig, uint8_t *bytes, uint8_t *mask, size_t cap) {
    size_t n = 0;
    while (*sig) {
        while (*sig == ' ' || *sig == '\t') sig++;
        if (!*sig) break;
        if (n >= cap) return -1;
        if (sig[0] == '?') {
            bytes[n] = 0; mask[n] = 0;
            while (*sig == '?') sig++;
        } else {
            int hi = hexval(sig[0]), lo = hexval(sig[1]);
            if (hi < 0 || lo < 0) return -1;
            bytes[n] = (uint8_t)((hi << 4) | lo); mask[n] = 1;
            sig += 2;
        }
        if (*sig && *sig != ' ' && *sig != '\t') return -1; /* e.g. "48x" */
        n++;
    }
    return (int)n;
}

const uint8_t *fw_scan_buffer(const uint8_t *buf, size_t len, const uint8_t *bytes, const uint8_t *mask, size_t n, int *matches) {
    const uint8_t *found = 0;
    if (n == 0 || len < n) return 0;
    for (size_t i = 0; i + n <= len; i++) {
        size_t k = 0;
        for (; k < n; k++) if (mask[k] && buf[i + k] != bytes[k]) break;
        if (k == n) {
            if (!found) found = buf + i;
            if (++*matches > 1) return found;
        }
    }
    return found;
}
