/* A read-only walk of the game's live GonObject tree (pure, host-tested by test/test_gon.c), promoted from the
 * harness's mt_gon.c (native/mods/test-harness/src/mt_gon.c, which stays as it is) for the framework's own use: the
 * 3D data seam reads `graphics.model` from a unit's entry at Character+OFF_CH_GON_ENTRY (0x240, OBSERVED by the
 * harness's `expect gon`; docs/engine-map.md "GON at runtime").
 *
 * Layout: the generated offsets.h (OFF_GON_* / GON_NODE_SIZE). The walk reproduces GonObject_child_by_name's linear
 * scan (the first child whose std::string name equals the segment) and Index's `begin + i * GON_NODE_SIZE` without
 * calling the game: no re-entrancy, and nothing reaches the game's GON ERROR sink. Every read goes through a reader
 * the caller supplies (the DLL passes a VirtualQuery-guarded one; fw_gon_direct_read is a plain copy for trusted
 * pointers and the host tests); implausible strings and children vectors are "unreadable", never followed. */
#pragma once
#include <stddef.h>
#include "offsets.h"

typedef int (*FwMemRead)(void *u, const void *addr, void *out, size_t n);   /* guarded copy: 1 ok, 0 unreadable */
int fw_gon_direct_read(void *u, const void *addr, void *out, size_t n);      /* memcpy; 0 only for NULL / n == 0 */

#define FW_GON_TEXT 256
#define FW_GON_TYPE_STRING 1
/* the string value at `path` ("graphics.model"; all-digit segments index the children vector; "" = the node itself)
 * under `node` into out (truncated to cap - 1). 1 found and a string (type 1), 0 missing or not a string, -1
 * unreadable (NULL node, a bad pointer, an implausible vector or std::string). out is "" unless 1 is returned. */
int fw_gon_get_string(FwMemRead rd, void *u, const void *node, const char *path, char *out, size_t cap);
/* `graphics.model` of a data/characters entry (the 3D data seam): fw_gon_get_string(rd, u, entry, "graphics.model", ...) */
int fw_gon_model(FwMemRead rd, void *u, const void *gonEntry, char *out, size_t cap);
/* the same through fw_gon_direct_read into a static buffer (main thread only; the next call overwrites it): the
 * `graphics.model` string, NULL when absent / not a string / unreadable. For a pointer the caller trusts. */
const char *fw_gon_entry_model(const void *gonEntry);
