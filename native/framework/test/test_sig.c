/* Host-side tests for the framework's signature scanner (src/fw_sig.c): the IDA-style
 * pattern parser and the exactly-once byte matcher. No windows.h, no game. */
#include <stdint.h>
#include <stddef.h>
#include "../../test/minitest.h"
#include "fw_sig.h"

TEST(parse_plain_bytes) {
    uint8_t b[8], m[8];
    int n = fw_parse_pattern("48 8B C4 55", b, m, sizeof b);
    CHECK_EQ(n, 4);
    uint8_t want[] = { 0x48, 0x8B, 0xC4, 0x55 };
    CHECK_MEM(b, want, 4);
    CHECK(m[0] && m[1] && m[2] && m[3]);
}

TEST(parse_wildcards_and_spacing) {
    uint8_t b[8], m[8];
    int n = fw_parse_pattern("  48 ?? 8B  ? C4 ", b, m, sizeof b);
    CHECK_EQ(n, 5);
    CHECK_EQ(m[0], 1); CHECK_EQ(m[1], 0); CHECK_EQ(m[2], 1); CHECK_EQ(m[3], 0); CHECK_EQ(m[4], 1);
    CHECK_EQ(b[2], 0x8B);
    CHECK_EQ(b[1], 0);
}

TEST(parse_lowercase_hex) {
    uint8_t b[4], m[4];
    CHECK_EQ(fw_parse_pattern("ff 0a", b, m, sizeof b), 2);
    CHECK_EQ(b[0], 0xFF); CHECK_EQ(b[1], 0x0A);
}

TEST(parse_rejects_bad_hex) {
    uint8_t b[8], m[8];
    CHECK_EQ(fw_parse_pattern("48 ZZ", b, m, sizeof b), -1);
    CHECK_EQ(fw_parse_pattern("4", b, m, sizeof b), -1);
}

TEST(parse_rejects_overflow) {
    uint8_t b[4], m[4];
    CHECK_EQ(fw_parse_pattern("01 02 03 04 05", b, m, sizeof b), -1);
    CHECK_EQ(fw_parse_pattern("01 02 03 04", b, m, sizeof b), 4);
}

TEST(parse_empty_is_zero) {
    uint8_t b[4], m[4];
    CHECK_EQ(fw_parse_pattern("", b, m, sizeof b), 0);
    CHECK_EQ(fw_parse_pattern("   ", b, m, sizeof b), 0);
}

static const uint8_t HAY[] = { 0x00, 0x48, 0x8B, 0xC4, 0x55, 0x90, 0x48, 0x8B, 0xC5, 0x55, 0x00 };

TEST(scan_unique_hit_returns_offset_and_one_match) {
    uint8_t b[8], m[8];
    int n = fw_parse_pattern("48 8B C4 55", b, m, sizeof b);
    int matches = 0;
    const uint8_t *hit = fw_scan_buffer(HAY, sizeof HAY, b, m, (size_t)n, &matches);
    CHECK(hit == HAY + 1);
    CHECK_EQ(matches, 1);
}

TEST(scan_wildcard_matches_both_and_reports_two) {
    uint8_t b[8], m[8];
    int n = fw_parse_pattern("48 8B ?? 55", b, m, sizeof b);
    int matches = 0;
    const uint8_t *hit = fw_scan_buffer(HAY, sizeof HAY, b, m, (size_t)n, &matches);
    CHECK(hit == HAY + 1);
    CHECK_EQ(matches, 2);
}

TEST(scan_no_match_is_null_and_zero) {
    uint8_t b[8], m[8];
    int n = fw_parse_pattern("DE AD BE EF", b, m, sizeof b);
    int matches = 7;
    const uint8_t *hit = fw_scan_buffer(HAY, sizeof HAY, b, m, (size_t)n, &matches);
    CHECK(hit == NULL);
    CHECK_EQ(matches, 0);
}

TEST(scan_pattern_longer_than_buffer_is_zero) {
    uint8_t b[16], m[16];
    int n = fw_parse_pattern("00 48 8B C4 55 90 48 8B C5 55 00 11", b, m, sizeof b);
    int matches = 0;
    CHECK(fw_scan_buffer(HAY, sizeof HAY, b, m, (size_t)n, &matches) == NULL);
    CHECK_EQ(matches, 0);
}

TEST(scan_matches_accumulate_across_buffers) {
    /* the framework scans section by section with one shared counter; a hit in each must add up */
    uint8_t b[8], m[8];
    int n = fw_parse_pattern("48 8B C4 55", b, m, sizeof b);
    int matches = 0;
    const uint8_t *h1 = fw_scan_buffer(HAY, sizeof HAY, b, m, (size_t)n, &matches);
    const uint8_t *h2 = fw_scan_buffer(HAY, sizeof HAY, b, m, (size_t)n, &matches);
    CHECK(h1 == HAY + 1);
    CHECK(h2 == HAY + 1);
    CHECK_EQ(matches, 2);
}

TEST(scan_stops_counting_at_two) {
    uint8_t rep[64];
    for (int i = 0; i < 64; i++) rep[i] = 0x90;
    uint8_t b[4], m[4];
    int n = fw_parse_pattern("90 90", b, m, sizeof b);
    int matches = 0;
    fw_scan_buffer(rep, sizeof rep, b, m, (size_t)n, &matches);
    CHECK_EQ(matches, 2);
}

TEST(scan_zero_length_pattern_is_rejected) {
    uint8_t b[4], m[4];
    int matches = 0;
    CHECK(fw_scan_buffer(HAY, sizeof HAY, b, m, 0, &matches) == NULL);
    CHECK_EQ(matches, 0);
}

int main(void) { return MT_RUN_ALL(); }
