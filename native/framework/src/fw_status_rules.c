/* Pure status-definition rules; see fw_status_rules.h. Kept free of windows.h and of game memory so the host
 * test suite covers every branch. */
#include <string.h>
#include "fw_status_rules.h"
#include "fw_glow_rules.h"   /* the FwGlow_ name rule (fw_glow_parse_status_name, fw_glow_status_prefixed) */

void fw_status_table_init(FwStatusTable *t) {
    memset(t, 0, sizeof *t);
}

FwStatusRule fw_status_validate(const FwStatusDef *def, const FwStatusTable *t) {
    if (!def || !def->name || !def->template_name) return FW_STATUS_ERR_NULL;
    size_t n = strlen(def->name);
    if (n == 0) return FW_STATUS_ERR_NAME_EMPTY;
    if (n > FW_STATUS_NAME_MAX) return FW_STATUS_ERR_NAME_TOO_LONG;
    if (fw_glow_status_prefixed(def->name, n)) return FW_STATUS_ERR_RESERVED;
    if (strcmp(def->template_name, FW_STATUS_TEMPLATE) != 0) return FW_STATUS_ERR_TEMPLATE;
    if (t) {
        if (fw_status_table_find(t, def->name, n) >= 0) return FW_STATUS_ERR_DUPLICATE;
        if (t->count >= FW_STATUS_MAX_DEFS) return FW_STATUS_ERR_TABLE_FULL;
    }
    return FW_STATUS_OK;
}

int fw_status_table_add(FwStatusTable *t, const FwStatusDef *def, FwStatusRule *why) {
    FwStatusRule r = fw_status_validate(def, t);
    if (why) *why = r;
    if (r != FW_STATUS_OK) return -1;
    int i = t->count;
    memcpy(t->names[i], def->name, strlen(def->name) + 1);
    t->count = i + 1;
    return i;
}

int fw_status_table_find(const FwStatusTable *t, const char *bytes, size_t len) {
    if (!t || !bytes || len > FW_STATUS_NAME_MAX) return -1;
    for (int i = 0; i < t->count; i++) {
        if (strlen(t->names[i]) == len && memcmp(t->names[i], bytes, len) == 0) return i;
    }
    float rgba[4];
    if (fw_glow_parse_status_name(bytes, len, rgba)) return FW_STATUS_GLOW_SLOT;   /* the data glow seam: no registration */
    return -1;
}

const char *fw_status_table_name(const FwStatusTable *t, int index) {
    return (t && index >= 0 && index < t->count) ? t->names[index] : "";
}

const char *fw_status_rule_text(FwStatusRule r) {
    switch (r) {
        case FW_STATUS_OK: return "ok";
        case FW_STATUS_ERR_NULL: return "definition, name or template is NULL";
        case FW_STATUS_ERR_NAME_EMPTY: return "name is empty";
        case FW_STATUS_ERR_NAME_TOO_LONG: return "name must be at most 15 characters (SSO)";
        case FW_STATUS_ERR_TEMPLATE: return "only template LuckUp is supported on this build";
        case FW_STATUS_ERR_DUPLICATE: return "name already registered";
        case FW_STATUS_ERR_TABLE_FULL: return "table full (8)";
        case FW_STATUS_ERR_RESERVED: return "names starting with FwGlow_ are the data-level glow (no registration needed)";
        default: return "unknown rule";
    }
}

int fw_alias_in(MsvcString *name, const FwStatusTable *t, FwAliasSave *save) {
    save->did = 0;
    if (fw_status_table_find(t, msvc_str(name), name->size) < 0) return 0;
    save->did = 1;
    save->dst = (name->cap > 15) ? name->u.ptr : name->u.buf;
    save->size = name->size;                         /* <= FW_STATUS_NAME_MAX by construction */
    memcpy(save->bytes, save->dst, save->size);
    save->bytes[save->size] = 0;
    size_t n = strlen(FW_STATUS_TEMPLATE);           /* fits any buffer: SSO has 16 bytes, heap >= 16 */
    memcpy(save->dst, FW_STATUS_TEMPLATE, n + 1);
    name->size = n;
    return 1;
}

void fw_alias_out(MsvcString *name, const FwAliasSave *save) {
    if (!save->did) return;
    memcpy(save->dst, save->bytes, save->size);
    save->dst[save->size] = 0;
    name->size = save->size;
}

int fw_hier_rewrite(int *ids, uint64_t count, uint64_t cap, uintptr_t fromId, int toId) {
    int swapped = 0;
    if (count > cap) count = cap;
    for (uint64_t i = 0; i < count; i++) {
        if ((uintptr_t)ids[i] == fromId) { ids[i] = toId; swapped++; }
    }
    return swapped;
}
