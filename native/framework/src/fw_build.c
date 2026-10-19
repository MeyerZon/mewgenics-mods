/* Pure build-identity gate; see fw_build.h. */
#include "fw_build.h"

int fw_identify_build(uint32_t timeDateStamp, uint32_t sizeOfImage, const BuildInfo *table, size_t count) {
    for (size_t i = 0; i < count; i++) {
        if (table[i].timeDateStamp == timeDateStamp && table[i].sizeOfImage == sizeOfImage) return (int)i;
    }
    return -1;
}
