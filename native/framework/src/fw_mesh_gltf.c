/* fw_mesh_gltf.c — RED stub: fw_mesh_gltf_parse always fails. */
#include <string.h>
#include "fw_mesh_rules.h"
int fw_mesh_gltf_parse(const uint8_t *bytes, size_t len, FwMeshReadFn read, void *user, FwMesh *out, FwMeshError *err) {
    (void)bytes; (void)len; (void)read; (void)user;
    if (out) memset(out, 0, sizeof *out);
    if (err) { strcpy(err->text, "not implemented"); err->line = 0; }
    return 0;
}
