/* Host-side tests for the pure mesh rules (src/fw_mesh_rules.c): the OBJ subset parser (corner forms, negative
 * indices, fan triangulation, dedup, errors with line numbers, CRLF, a non-NUL-terminated buffer, limits), the OBJ ->
 * game axes conversion (z mirror + winding reversal + scale), flat normals, the M1 unit cube, the model registry and
 * the model path rule. The committed text fixture test/fixtures/mesh/crate.obj is found next to this source file
 * (__FILE__ is the absolute path both test.bat and test-all.sh compile), so no runner argument is needed. */
#define FW_NO_WINDOWS
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include "../../test/minitest.h"
#include "fw_mesh_rules.h"

_Static_assert(sizeof(FwMeshVertex) == 32, "the VBO stride");
_Static_assert(offsetof(FwMeshVertex, nrm) == 12 && offsetof(FwMeshVertex, uv) == 24, "the VBO attribute offsets");

static int parse(const char *s, FwMesh *m, FwMeshError *e) {
    memset(e, 0, sizeof *e);
    return fw_mesh_obj_parse(s, strlen(s), m, e);
}
/* a parse that must succeed; on failure the test stops (the mesh is empty, so indexing it would crash) */
#define PARSE_OK(s) do { if (parse((s), &m, &e) != 1) { MT_FAIL("parse failed: %s (line %d)", e.text, e.line); return; } } while (0)
static int feq(float a, float b) { return fabsf(a - b) < 1e-5f; }
static int veq(const float *a, float x, float y, float z) { return feq(a[0], x) && feq(a[1], y) && feq(a[2], z); }
static void tri_cross(const FwMesh *m, uint32_t t, float n[3]) {
    const float *a = m->verts[m->indices[3 * t]].pos, *b = m->verts[m->indices[3 * t + 1]].pos,
                *c = m->verts[m->indices[3 * t + 2]].pos;
    float u[3] = { b[0] - a[0], b[1] - a[1], b[2] - a[2] }, v[3] = { c[0] - a[0], c[1] - a[1], c[2] - a[2] };
    n[0] = u[1] * v[2] - u[2] * v[1]; n[1] = u[2] * v[0] - u[0] * v[2]; n[2] = u[0] * v[1] - u[1] * v[0];
}
static float dot3(const float *a, const float *b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
/* every triangle's geometric normal agrees with each of its corners' normals */
static int windings_match_normals(const FwMesh *m) {
    for (uint32_t t = 0; t < m->nindices / 3; t++) {
        float n[3]; tri_cross(m, t, n);
        for (int k = 0; k < 3; k++) if (dot3(n, m->verts[m->indices[3 * t + k]].nrm) <= 0.0f) return 0;
    }
    return 1;
}
static int is_zeroed(const FwMesh *m) {
    FwMesh z; memset(&z, 0, sizeof z);
    return memcmp(m, &z, sizeof z) == 0;
}

/* ---------------- OBJ: corner forms ---------------- */
TEST(obj_triangle_with_v_vt_vn) {
    FwMesh m; FwMeshError e;
    PARSE_OK("v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nvn 0 0 1\nf 1/1/1 2/2/1 3/3/1\n");
    CHECK_EQ(m.nverts, 3); CHECK_EQ(m.nindices, 3);
    CHECK_EQ(m.has_normals, 1); CHECK_EQ(m.has_uvs, 1);
    CHECK(veq(m.verts[m.indices[1]].pos, 1, 0, 0));
    CHECK(veq(m.verts[m.indices[2]].nrm, 0, 0, 1));
    CHECK(feq(m.verts[m.indices[2]].uv[0], 0) && feq(m.verts[m.indices[2]].uv[1], 1));
    CHECK_EQ(m.indices[0], 0); CHECK_EQ(m.indices[1], 1); CHECK_EQ(m.indices[2], 2);   /* file order kept */
    fw_mesh_free(&m);
    CHECK(is_zeroed(&m));
}

TEST(obj_quad_is_fan_triangulated_into_two) {
    FwMesh m; FwMeshError e;
    PARSE_OK("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvn 0 0 1\nf 1//1 2//1 3//1 4//1\n");   /* vn: shared corners */
    CHECK_EQ(m.nverts, 4); CHECK_EQ(m.nindices, 6);
    uint32_t want[6] = { 0, 1, 2, 0, 2, 3 };
    for (int i = 0; i < 6; i++) CHECK_EQ(m.indices[i], want[i]);
    CHECK_EQ(m.has_uvs, 0);
    fw_mesh_free(&m);
}

TEST(obj_pentagon_gives_three_triangles) {
    FwMesh m; FwMeshError e;
    PARSE_OK("v 0 0 0\nv 2 0 0\nv 3 1 0\nv 1 2 0\nv -1 1 0\nvn 0 0 1\nf 1//1 2//1 3//1 4//1 5//1\n");
    CHECK_EQ(m.nindices, 9);
    uint32_t want[9] = { 0, 1, 2, 0, 2, 3, 0, 3, 4 };
    for (int i = 0; i < 9; i++) CHECK_EQ(m.indices[i], want[i]);
    fw_mesh_free(&m);
}

TEST(obj_negative_indices_resolve_against_the_current_count) {
    FwMesh m; FwMeshError e;
    /* -1 is the latest v; the second face sees 4 vertices, so -3 is v2 */
    PARSE_OK("v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\nv 5 5 5\nf -3 -2 -1\n");
    CHECK_EQ(m.nindices, 6);
    CHECK(veq(m.verts[m.indices[3]].pos, 1, 0, 0));
    CHECK(veq(m.verts[m.indices[5]].pos, 5, 5, 5));
    fw_mesh_free(&m);
}

TEST(obj_v_slash_slash_vn_has_no_uvs) {
    FwMesh m; FwMeshError e;
    PARSE_OK("v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 1\nf 1//1 2//1 3//1\n");
    CHECK_EQ(m.has_uvs, 0); CHECK_EQ(m.has_normals, 1);
    CHECK(feq(m.verts[0].uv[0], 0) && feq(m.verts[0].uv[1], 0));
    CHECK(veq(m.verts[0].nrm, 0, 0, 1));
    fw_mesh_free(&m);
}

TEST(obj_v_slash_vt_form_has_uvs_and_flat_normals) {
    FwMesh m; FwMeshError e;
    PARSE_OK("v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0.25 0.75\nf 1/1 2/1 3/1\n");
    CHECK_EQ(m.has_uvs, 1); CHECK_EQ(m.has_normals, 0);
    CHECK(feq(m.verts[0].uv[0], 0.25f) && feq(m.verts[0].uv[1], 0.75f));
    CHECK(veq(m.verts[0].nrm, 0, 0, 1));
    fw_mesh_free(&m);
}

TEST(obj_shared_corners_are_deduplicated) {
    FwMesh m; FwMeshError e;
    /* two triangles sharing an edge with identical (v, vt, vn) -> 4 verts; a different vt on v1 -> a 5th */
    PARSE_OK("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 1\nvn 0 0 1\n"
                   "f 1/1/1 2/1/1 3/1/1\nf 1/1/1 3/1/1 4/1/1\nf 1/2/1 2/1/1 4/1/1\n");
    CHECK_EQ(m.nindices, 9);
    CHECK_EQ(m.nverts, 5);
    CHECK_EQ(m.indices[3], m.indices[0]);
    CHECK_EQ(m.indices[4], m.indices[2]);
    CHECK(m.indices[6] != m.indices[0]);
    fw_mesh_free(&m);
}

TEST(obj_number_forms) {
    FwMesh m; FwMeshError e;
    PARSE_OK("v +1.5 -0.25e+1 .5\nv 1e-2 2E2 -0\nv 3. 0 0 1.0\nf 1 2 3\n");
    CHECK(veq(m.verts[0].pos, 1.5f, -2.5f, 0.5f));
    CHECK(veq(m.verts[1].pos, 0.01f, 200.0f, 0.0f));
    CHECK(veq(m.verts[2].pos, 3.0f, 0.0f, 0.0f));
    fw_mesh_free(&m);
}

TEST(obj_bounds_are_computed) {
    FwMesh m; FwMeshError e;
    PARSE_OK("v -1 2 3\nv 4 -5 6\nv 0 0 -7\nf 1 2 3\n");
    CHECK(veq(m.bmin, -1, -5, -7)); CHECK(veq(m.bmax, 4, 2, 6));
    fw_mesh_free(&m);
}

/* ---------------- OBJ: ignored things ---------------- */
TEST(obj_crlf_and_comments_are_ignored) {
    FwMesh m; FwMeshError e;
    PARSE_OK("\xEF\xBB\xBF# exported\r\nmtllib crate.mtl\r\no Thing\r\ng group1\r\ns 1\r\n\r\n   \t\r\n"
                   "v 0 0 0 # trailing comment\r\nv 1 0 0\r\nv 0 1 0\r\nusemtl Wood\r\nf 1 2 3\r\n# end");
    CHECK_EQ(m.nverts, 3); CHECK_EQ(m.nindices, 3);
    CHECK(veq(m.verts[0].pos, 0, 0, 0));
    fw_mesh_free(&m);
}

TEST(obj_buffer_is_not_nul_terminated) {
    const char src[] = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3";   /* no final newline */
    size_t n = sizeof src - 1;
    char *buf = (char *)malloc(n + 8);
    memcpy(buf, src, n);
    memcpy(buf + n, "4 5 9xx", 8);   /* bytes past len that would break the face if read */
    FwMesh m; FwMeshError e;
    CHECK_EQ(fw_mesh_obj_parse(buf, n, &m, &e), 1);
    CHECK_EQ(m.nindices, 3);
    fw_mesh_free(&m);
    /* a number cut at the end of the buffer: "v 0 0 1" with len stopping before "1" -> 2 numbers -> error */
    CHECK_EQ(fw_mesh_obj_parse("v 0 0 1\nf 1 1 1", 6, &m, &e), 0);
    free(buf);
}

/* ---------------- OBJ: errors ---------------- */
TEST(obj_index_zero_is_an_error_with_the_line) {
    FwMesh m; FwMeshError e;
    CHECK_EQ(parse("v 0 0 0\nv 1 0 0\nv 0 1 0\n\nf 0 1 2\n", &m, &e), 0);
    CHECK_EQ(e.line, 5);
    CHECK(strstr(e.text, "0") != NULL);
    CHECK(strstr(e.text, "line 5") != NULL);
    CHECK(is_zeroed(&m));
}

TEST(obj_out_of_range_index_is_an_error) {
    FwMesh m; FwMeshError e;
    CHECK_EQ(parse("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 7\n", &m, &e), 0);
    CHECK_EQ(e.line, 4);
    CHECK_STR(e.text, "face index 7 out of range (3 vertices) at line 4");
    CHECK_EQ(parse("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 -4\n", &m, &e), 0);
    CHECK_EQ(e.line, 4);
    CHECK_EQ(parse("v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nf 1/2 2/1 3/1\n", &m, &e), 0);   /* vt out of range */
    CHECK_EQ(e.line, 5);
    CHECK_EQ(parse("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1//1 2//1 3//1\n", &m, &e), 0);        /* no vn at all */
    CHECK_EQ(e.line, 4);
    CHECK(is_zeroed(&m));
}

TEST(obj_unsupported_statement_l_is_an_error) {
    FwMesh m; FwMeshError e;
    CHECK_EQ(parse("v 0 0 0\nv 1 0 0\nl 1 2\n", &m, &e), 0);
    CHECK_EQ(e.line, 3);
    CHECK(strstr(e.text, "unsupported OBJ statement 'l'") != NULL);
    const char *others[] = { "p 1\n", "curv 0 1 1 2\n", "curv2 1 2\n", "surf 0 1 0 1 1 2 3\n", "vp 0.5\n", "cstype bezier\n" };
    for (size_t i = 0; i < sizeof others / sizeof others[0]; i++) {
        CHECK_EQ(parse(others[i], &m, &e), 0);
        CHECK_EQ(e.line, 1);
        CHECK(strstr(e.text, "unsupported OBJ statement") != NULL);
    }
}

TEST(obj_face_with_fewer_than_three_corners_is_an_error) {
    FwMesh m; FwMeshError e;
    CHECK_EQ(parse("v 0 0 0\nv 1 0 0\nf 1 2\n", &m, &e), 0);
    CHECK_EQ(e.line, 3);
    CHECK_EQ(parse("v 0 0 0\nf\n", &m, &e), 0);
    CHECK_EQ(e.line, 2);
}

TEST(obj_non_number_is_an_error) {
    FwMesh m; FwMeshError e;
    const char *bad[] = { "v 1 x 2\n", "v 1 2\n", "v 1.2.3 0 0\n", "v 1e 0 0\n", "v nan 0 0\n", "v 1 2 3 q\n",
                          "vn 0 1\n", "vt\n", "vt 0 0 0 0\n", "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 a 3\n",
                          "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1/ 2/ 3/\n", "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1/1/1/1 2 3\n",
                          "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1.5 2 3\n", "v 1e999 0 0\n" };
    for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        if (parse(bad[i], &m, &e) != 0) { MT_FAIL("accepted: %s", bad[i]); fw_mesh_free(&m); continue; }
        CHECK(e.line >= 1);
        CHECK(e.text[0] != 0);
    }
}

TEST(obj_unknown_statement_and_line_continuation_are_errors) {
    FwMesh m; FwMeshError e;
    CHECK_EQ(parse("v 0 0 0\nbogus 1 2\n", &m, &e), 0);
    CHECK_EQ(e.line, 2);
    CHECK_EQ(parse("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 \\\n3\n", &m, &e), 0);
    CHECK_EQ(e.line, 4);
    CHECK(strstr(e.text, "continuation") != NULL);
}

TEST(obj_no_faces_is_an_error) {
    FwMesh m; FwMeshError e;
    CHECK_EQ(parse("v 0 0 0\nv 1 0 0\nv 0 1 0\n", &m, &e), 0);
    CHECK(strstr(e.text, "no faces") != NULL);
    CHECK_EQ(parse("", &m, &e), 0);
    CHECK_EQ(fw_mesh_obj_parse(NULL, 0, &m, &e), 0);
    CHECK_EQ(fw_mesh_obj_parse("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", 32, &m, NULL), 1);   /* err may be NULL */
    fw_mesh_free(&m);
    CHECK_EQ(fw_mesh_obj_parse("f 1 2 3\n", 8, &m, NULL), 0);
}

static char *repeat(const char *line, size_t times, size_t *outLen) {
    size_t l = strlen(line);
    char *b = (char *)malloc(l * times);
    for (size_t i = 0; i < times; i++) memcpy(b + i * l, line, l);
    *outLen = l * times;
    return b;
}

TEST(obj_vertex_limit_is_an_error) {
    size_t n; FwMesh m; FwMeshError e;
    char *b = repeat("v 0 0 0\n", (size_t)FW_MESH_MAX_VERTS + 1, &n);
    CHECK_EQ(fw_mesh_obj_parse(b, n, &m, &e), 0);
    CHECK(strstr(e.text, "limit") != NULL);
    CHECK_EQ(e.line, (int)FW_MESH_MAX_VERTS + 1);
    free(b);
}

TEST(obj_index_limit_is_an_error) {
    size_t n; FwMesh m; FwMeshError e;
    const char *head = "v 0 0 0\nv 1 0 0\nv 0 1 0\n";
    size_t faces = (size_t)FW_MESH_MAX_INDICES / 3 + 1, fl;
    char *f = repeat("f 1 2 3\n", faces, &fl);
    n = strlen(head) + fl;
    char *b = (char *)malloc(n);
    memcpy(b, head, strlen(head)); memcpy(b + strlen(head), f, fl);
    CHECK_EQ(fw_mesh_obj_parse(b, n, &m, &e), 0);
    CHECK(strstr(e.text, "limit") != NULL);
    CHECK_EQ(e.line, (int)(faces + 3));
    free(f); free(b);
}

/* ---------------- OBJ: normals ---------------- */
TEST(obj_missing_normals_get_flat_normals) {
    FwMesh m; FwMeshError e;
    /* a quad in the z = 0 plane, CCW seen from +z, plus a CCW triangle facing +x */
    PARSE_OK("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 1 0 1\nf 1 2 3 4\nf 2 3 5\n");
    CHECK_EQ(m.has_normals, 0);
    CHECK_EQ(m.nindices, 9);
    CHECK_EQ(m.nverts, 9);   /* flat normals unshare every triangle */
    for (int k = 0; k < 6; k++) CHECK(veq(m.verts[m.indices[k]].nrm, 0, 0, 1));
    for (int k = 6; k < 9; k++) CHECK(veq(m.verts[m.indices[k]].nrm, 1, 0, 0));
    CHECK(windings_match_normals(&m));
    fw_mesh_free(&m);
}

TEST(obj_normals_on_only_some_corners_fall_back_to_flat) {
    FwMesh m; FwMeshError e;
    PARSE_OK("v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 1 0 0\nf 1//1 2 3\n");
    CHECK_EQ(m.has_normals, 0);
    CHECK(veq(m.verts[0].nrm, 0, 0, 1));
    fw_mesh_free(&m);
}

TEST(flat_normals_degenerate_triangle_points_up) {
    FwMesh m; FwMeshError e;
    PARSE_OK("v 0 0 0\nv 1 1 1\nv 2 2 2\nf 1 2 3\n");
    CHECK(veq(m.verts[0].nrm, 0, 1, 0));
    fw_mesh_free(&m);
}

/* ---------------- the committed fixture ---------------- */
static char *read_fixture(const char *name, size_t *len) {
    char path[1024];
    const char *f = __FILE__;
    const char *slash = NULL;
    for (const char *p = f; *p; p++) if (*p == '/' || *p == '\\') slash = p;
    size_t dir = slash ? (size_t)(slash - f + 1) : 0;
    if (dir + strlen("fixtures/mesh/") + strlen(name) + 1 > sizeof path) return NULL;
    memcpy(path, f, dir);
    strcpy(path + dir, "fixtures/mesh/");
    strcat(path, name);
    FILE *fp = fopen(path, "rb");
    if (!fp) { printf("      cannot open fixture %s\n", path); return NULL; }
    fseek(fp, 0, SEEK_END); long sz = ftell(fp); fseek(fp, 0, SEEK_SET);
    char *b = (char *)malloc(sz > 0 ? (size_t)sz : 1);
    *len = fread(b, 1, (size_t)(sz > 0 ? sz : 0), fp);
    fclose(fp);
    return b;
}

TEST(obj_crate_fixture_parses_into_an_outward_cube) {
    size_t n = 0; char *b = read_fixture("crate.obj", &n);
    CHECK(b != NULL);
    if (!b) return;
    FwMesh m; FwMeshError e;
    if (fw_mesh_obj_parse(b, n, &m, &e) != 1) { MT_FAIL("crate.obj: %s", e.text); free(b); return; }
    CHECK_EQ(m.nverts, 24); CHECK_EQ(m.nindices, 36);
    CHECK_EQ(m.has_normals, 1); CHECK_EQ(m.has_uvs, 1);
    CHECK(veq(m.bmin, -0.5f, 0, -0.5f)); CHECK(veq(m.bmax, 0.5f, 1, 0.5f));
    CHECK(windings_match_normals(&m));
    fw_mesh_to_game_axes(&m, 1.0f);
    CHECK(windings_match_normals(&m));   /* still front-facing after the mirror */
    CHECK(veq(m.bmin, -0.5f, 0, -0.5f)); CHECK(veq(m.bmax, 0.5f, 1, 0.5f));
    fw_mesh_free(&m);
    free(b);
}

/* ---------------- axes ---------------- */
TEST(to_game_axes_mirrors_z_and_reverses_winding) {
    FwMesh m; FwMeshError e;
    PARSE_OK("v 0 0 1\nv 1 0 1\nv 0 1 2\nvn 0 0 1\nf 1//1 2//1 3//1\n");
    uint32_t i0 = m.indices[0], i1 = m.indices[1], i2 = m.indices[2];
    fw_mesh_to_game_axes(&m, 1.0f);
    CHECK_EQ(m.indices[0], i2); CHECK_EQ(m.indices[1], i1); CHECK_EQ(m.indices[2], i0);
    CHECK(veq(m.verts[i0].pos, 0, 0, -1));
    CHECK(veq(m.verts[i2].pos, 0, 1, -2));
    CHECK(veq(m.verts[i0].nrm, 0, 0, -1));
    CHECK(veq(m.bmin, 0, 0, -2)); CHECK(veq(m.bmax, 1, 1, -1));
    fw_mesh_free(&m);
}

TEST(to_game_axes_scales_by_model_scale) {
    FwMesh m; FwMeshError e;
    PARSE_OK("v 1 2 3\nv 2 2 3\nv 1 3 3\nvn 0 0 2\nf 1//1 2//1 3//1\n");
    fw_mesh_to_game_axes(&m, 0.5f);
    CHECK(veq(m.verts[0].pos, 0.5f, 1.0f, -1.5f));
    CHECK(veq(m.verts[0].nrm, 0, 0, -1));   /* normals mirrored and unit, not scaled */
    CHECK(veq(m.bmax, 1.0f, 1.5f, -1.5f));
    fw_mesh_free(&m);
    PARSE_OK("v 1 2 3\nv 2 2 3\nv 1 3 3\nf 1 2 3\n");
    fw_mesh_to_game_axes(&m, 0.0f);          /* <= 0 -> 1 */
    CHECK(veq(m.verts[m.indices[2]].pos, 1, 2, -3));
    fw_mesh_to_game_axes(&m, -3.0f);
    CHECK(veq(m.verts[m.indices[0]].pos, 1, 2, 3));
    fw_mesh_free(&m);
}

/* ---------------- unit cube ---------------- */
TEST(unit_cube_counts_bounds_and_outward_unit_normals) {
    FwMesh m;
    CHECK_EQ(fw_mesh_unit_cube(&m), 1);
    CHECK_EQ(m.nverts, 24); CHECK_EQ(m.nindices, 36);
    CHECK_EQ(m.has_normals, 1); CHECK_EQ(m.has_uvs, 1);
    CHECK(veq(m.bmin, -0.5f, 0, -0.5f)); CHECK(veq(m.bmax, 0.5f, 1, 0.5f));
    int axisCount[6] = { 0 };
    for (uint32_t i = 0; i < m.nverts; i++) {
        const float *n = m.verts[i].nrm, *p = m.verts[i].pos;
        CHECK(feq(dot3(n, n), 1.0f));
        /* outward: the normal points away from the cube's centre (0, 0.5, 0) */
        float c[3] = { p[0], p[1] - 0.5f, p[2] };
        CHECK(dot3(n, c) > 0.0f);
        for (int a = 0; a < 3; a++) {
            if (feq(n[a], 1.0f)) axisCount[2 * a]++;
            if (feq(n[a], -1.0f)) axisCount[2 * a + 1]++;
        }
        CHECK(m.verts[i].uv[0] >= 0 && m.verts[i].uv[0] <= 1 && m.verts[i].uv[1] >= 0 && m.verts[i].uv[1] <= 1);
    }
    for (int a = 0; a < 6; a++) CHECK_EQ(axisCount[a], 4);
    for (uint32_t i = 0; i < m.nindices; i++) CHECK(m.indices[i] < m.nverts);
    CHECK(windings_match_normals(&m));
    fw_mesh_free(&m);
}

/* ---------------- registry ---------------- */
static FwMesh cube(void) { FwMesh m; fw_mesh_unit_cube(&m); return m; }

TEST(reg_add_find_get_take_ownership) {
    FwMeshRegistry r; memset(&r, 0, sizeof r);
    FwMesh a = cube(), b = cube();
    FwMeshVertex *av = a.verts;
    CHECK_EQ(fw_mesh_reg_add(&r, "crate", &a), 0);
    CHECK(is_zeroed(&a));
    CHECK_EQ(fw_mesh_reg_add(&r, "Crate", &b), 1);   /* case-sensitive */
    CHECK_EQ(r.count, 2);
    CHECK_EQ(fw_mesh_reg_find(&r, "crate"), 0);
    CHECK_EQ(fw_mesh_reg_find(&r, "Crate"), 1);
    CHECK_EQ(fw_mesh_reg_find(&r, "CRATE"), -1);
    CHECK_EQ(fw_mesh_reg_find(&r, NULL), -1);
    CHECK(fw_mesh_reg_get(&r, 0) != NULL && fw_mesh_reg_get(&r, 0)->verts == av);
    CHECK(fw_mesh_reg_get(&r, 2) == NULL); CHECK(fw_mesh_reg_get(&r, -1) == NULL);
    CHECK_STR(fw_mesh_reg_name(&r, 1), "Crate");
    CHECK(fw_mesh_reg_name(&r, 5) == NULL);
    fw_mesh_reg_clear(&r);
}

TEST(reg_refuses_dup_empty_long_and_empty_meshes) {
    FwMeshRegistry r; memset(&r, 0, sizeof r);
    FwMesh a = cube(), b = cube();
    CHECK_EQ(fw_mesh_reg_add(&r, "crate", &a), 0);
    FwMeshVertex *bv = b.verts;
    CHECK_EQ(fw_mesh_reg_add(&r, "crate", &b), -1);
    CHECK(b.verts == bv);                              /* refused: still the caller's */
    CHECK_EQ(fw_mesh_reg_add(&r, "", &b), -1);
    CHECK_EQ(fw_mesh_reg_add(&r, NULL, &b), -1);
    CHECK_EQ(fw_mesh_reg_add(&r, "x", NULL), -1);
    CHECK_EQ(fw_mesh_reg_add(NULL, "x", &b), -1);
    char longName[80]; memset(longName, 'a', 64); longName[64] = 0;
    CHECK_EQ(fw_mesh_reg_add(&r, longName, &b), -1);
    longName[63] = 0;                                  /* exactly 63 is fine */
    CHECK_EQ(fw_mesh_reg_add(&r, longName, &b), 1);
    FwMesh empty; memset(&empty, 0, sizeof empty);
    CHECK_EQ(fw_mesh_reg_add(&r, "empty", &empty), -1);
    CHECK_EQ(r.count, 2);
    fw_mesh_reg_clear(&r);
}

TEST(reg_full_refuses_the_33rd) {
    FwMeshRegistry r; memset(&r, 0, sizeof r);
    char name[16];
    for (int i = 0; i < FW_MESH_MAX_MODELS; i++) {
        FwMesh m = cube(); snprintf(name, sizeof name, "m%d", i);
        CHECK_EQ(fw_mesh_reg_add(&r, name, &m), i);
    }
    FwMesh extra = cube();
    CHECK_EQ(fw_mesh_reg_add(&r, "extra", &extra), -1);
    CHECK(extra.verts != NULL);
    fw_mesh_free(&extra);
    fw_mesh_reg_clear(&r);
}

TEST(reg_clear_frees_and_resets) {
    FwMeshRegistry r; memset(&r, 0, sizeof r);
    FwMesh a = cube();
    fw_mesh_reg_add(&r, "crate", &a);
    fw_mesh_reg_clear(&r);
    CHECK_EQ(r.count, 0);
    CHECK_EQ(fw_mesh_reg_find(&r, "crate"), -1);
    CHECK(r.meshes[0].verts == NULL);
    FwMesh b = cube();
    CHECK_EQ(fw_mesh_reg_add(&r, "crate", &b), 0);   /* reusable after a clear */
    fw_mesh_reg_clear(&r);
    fw_mesh_reg_clear(&r);                           /* twice is fine */
    fw_mesh_free(NULL);
}

/* ---------------- model paths ---------------- */
TEST(model_path_accepts_models_name_obj) {
    char out[96];
    CHECK_EQ(fw_mesh_model_path("models/crate.obj", out, sizeof out), 1);
    CHECK_STR(out, "models/crate.obj");
    CHECK_EQ(fw_mesh_model_path("models/Big_Crate-2.obj", out, sizeof out), 1);
    CHECK_STR(out, "models/Big_Crate-2.obj");
    CHECK_EQ(fw_mesh_name_from_path("models/crate.obj", out, sizeof out), 1);
    CHECK_STR(out, "crate");
    CHECK_EQ(fw_mesh_name_from_path("models/Big_Crate-2.obj", out, sizeof out), 1);
    CHECK_STR(out, "Big_Crate-2");
}

TEST(model_path_rejects_everything_else) {
    const char *bad[] = { "", "crate.obj", "models/.obj", "models/crate", "models/crate.OBJ", "models/crate.gltf",
                          "models/crate.obj.bak", "models/../crate.obj", "../models/crate.obj", "/models/crate.obj",
                          "C:/models/crate.obj", "models\\crate.obj", "models/sub/crate.obj", "models//crate.obj",
                          "Models/crate.obj", "models/cr ate.obj", "models/cr.ate.obj", "./models/crate.obj",
                          "models/crate.obj ", "textures/crate.obj" };
    char out[96];
    for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        strcpy(out, "junk");
        if (fw_mesh_model_path(bad[i], out, sizeof out) != 0) MT_FAIL("model_path accepted \"%s\"", bad[i]);
        CHECK_STR(out, "");
        strcpy(out, "junk");
        if (fw_mesh_name_from_path(bad[i], out, sizeof out) != 0) MT_FAIL("name_from_path accepted \"%s\"", bad[i]);
        CHECK_STR(out, "");
    }
    CHECK_EQ(fw_mesh_model_path(NULL, out, sizeof out), 0);
    char longRef[100] = "models/"; memset(longRef + 7, 'a', 64); strcpy(longRef + 71, ".obj");   /* 64-char name */
    CHECK_EQ(fw_mesh_model_path(longRef, out, sizeof out), 0);
    char small[10];
    CHECK_EQ(fw_mesh_model_path("models/crate.obj", small, sizeof small), 0);   /* does not fit */
    CHECK_STR(small, "");
    CHECK_EQ(fw_mesh_name_from_path("models/crate.obj", small, 5), 0);         /* "crate" + NUL needs 6 */
    CHECK_EQ(fw_mesh_name_from_path("models/crate.obj", small, 6), 1);
    CHECK_STR(small, "crate");
}

int main(void) { return MT_RUN_ALL(); }
