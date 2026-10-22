/* fw_mesh_rules.c — the pure mesh rules of phase M (see fw_mesh_rules.h): OBJ subset parser, OBJ -> game axes, flat
 * normals, the unit cube, the model registry, the model path rule. C11, libc only (malloc/realloc/free, string,
 * stdio's vsnprintf, math's sqrtf); no locale dependence (numbers are parsed here, not by strtod). */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <float.h>
#include "fw_mesh_rules.h"

/* ------------------------------------------------------------------ small helpers */
static void set_err(FwMeshError *err, FwMeshCodeId code, int line, const char *fmt, ...) {
    if (!err) return;
    err->code = fw_mesh_code(code);
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(err->text, sizeof err->text, fmt, ap);
    va_end(ap);
    err->line = line;
}

static int grow(void **p, uint32_t *cap, uint32_t need, size_t elem) {
    if (need <= *cap) return 1;
    uint32_t nc = *cap ? *cap : 64;
    while (nc < need) nc = nc > 0x7fffffffu ? need : nc * 2;
    void *np = realloc(*p, (size_t)nc * elem);
    if (!np) return 0;
    *p = np; *cap = nc;
    return 1;
}

static void normalize3(float n[3], int fallbackUp) {
    float l = sqrtf(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    if (l > 1e-20f) { n[0] /= l; n[1] /= l; n[2] /= l; }
    else if (fallbackUp) { n[0] = 0; n[1] = 1; n[2] = 0; }
}

static int is_ws(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\v' || c == '\f'; }
static int is_digit(char c) { return c >= '0' && c <= '9'; }

/* the whole token [s, e) must be a decimal number: [+-]? (d+ (. d*)? | . d+) ([eE] [+-]? d+)? ; finite as a float */
static int parse_float(const char *s, const char *e, float *out) {
    const char *p = s;
    int neg = 0;
    if (p < e && (*p == '+' || *p == '-')) { neg = (*p == '-'); p++; }
    double mant = 0.0;
    int digits = 0, sig = 0, exp10 = 0;
    while (p < e && is_digit(*p)) {
        if (sig < 19) { mant = mant * 10.0 + (*p - '0'); if (mant != 0.0) sig++; } else exp10++;
        digits++; p++;
    }
    if (p < e && *p == '.') {
        p++;
        while (p < e && is_digit(*p)) {
            if (sig < 19) { mant = mant * 10.0 + (*p - '0'); if (mant != 0.0) sig++; exp10--; }
            digits++; p++;
        }
    }
    if (!digits) return 0;
    if (p < e && (*p == 'e' || *p == 'E')) {
        p++;
        int eneg = 0, ed = 0;
        long ev = 0;
        if (p < e && (*p == '+' || *p == '-')) { eneg = (*p == '-'); p++; }
        while (p < e && is_digit(*p)) { if (ev < 100000) ev = ev * 10 + (*p - '0'); ed++; p++; }
        if (!ed) return 0;
        exp10 += (int)(eneg ? -ev : ev);
    }
    if (p != e) return 0;
    double v = mant;
    if (v != 0.0) {
        if (exp10 > 60 || exp10 < -80) { if (exp10 > 0) return 0; v = 0.0; }
        else {
            double pw = 1.0;
            for (int i = 0; i < (exp10 < 0 ? -exp10 : exp10); i++) pw *= 10.0;
            v = exp10 < 0 ? v / pw : v * pw;
        }
    }
    if (v > (double)FLT_MAX) return 0;
    *out = (float)(neg ? -v : v);
    return 1;
}

/* [+-]? d+ over the whole token, |value| <= INT32 range */
static int parse_int(const char *s, const char *e, long long *out) {
    const char *p = s;
    int neg = 0;
    if (p < e && (*p == '+' || *p == '-')) { neg = (*p == '-'); p++; }
    if (p == e) return 0;
    long long v = 0;
    while (p < e) {
        if (!is_digit(*p)) return 0;
        v = v * 10 + (*p - '0');
        if (v > 0x7fffffffLL) return 0;
        p++;
    }
    *out = neg ? -v : v;
    return 1;
}

/* next whitespace-separated token in [*p, e); 0 when none */
static int next_tok(const char **p, const char *e, const char **ts, const char **te) {
    const char *q = *p;
    while (q < e && is_ws(*q)) q++;
    if (q >= e) { *p = q; return 0; }
    *ts = q;
    while (q < e && !is_ws(*q)) q++;
    *te = q; *p = q;
    return 1;
}

static int tok_is(const char *s, const char *e, const char *word) {
    size_t n = strlen(word);
    return (size_t)(e - s) == n && memcmp(s, word, n) == 0;
}
static int tok_in(const char *s, const char *e, const char *const *words) {
    for (; *words; words++) if (tok_is(s, e, *words)) return 1;
    return 0;
}

static const char *const kIgnored[] = { "o", "g", "s", "mg", "mtllib", "usemtl", "maplib", "usemap", "lod", "bevel",
                                        "c_interp", "d_interp", "shadow_obj", "trace_obj", "ctech", "stech", NULL };
static const char *const kUnsupported[] = { "l", "p", "curv", "curv2", "surf", "vp", "cstype", "deg", "bmat", "step",
                                            "parm", "trim", "hole", "scrv", "sp", "end", "con", NULL };

void fw_mesh_default_material(FwMesh *m) {
    if (!m) return;
    for (int k = 0; k < 4; k++) m->base_color[k] = 1.0f;
    m->texture[0] = 0;
}

/* ------------------------------------------------------------------ OBJ parser */
typedef struct ObjState {
    float *pos; uint32_t npos, cpos;      /* 3 floats each */
    float *tex; uint32_t ntex, ctex;      /* 2 floats each */
    float *nrm; uint32_t nnrm, cnrm;      /* 3 floats each */
    FwMeshVertex *verts; uint32_t nverts, cverts;
    int32_t *keys; uint32_t ckeys;        /* 3 per vertex: pos, tex (-1), nrm (-1) */
    uint32_t *hash; uint32_t hcap;        /* power of two; slot = vertex index + 1, 0 = empty */
    uint32_t *idx; uint32_t nidx, cidx;
    uint32_t *face; uint32_t cface;       /* the current face's vertex indices */
    int allNormals, anyUv;
} ObjState;

static void obj_state_free(ObjState *s) {
    free(s->pos); free(s->tex); free(s->nrm); free(s->verts); free(s->keys); free(s->hash); free(s->idx); free(s->face);
    memset(s, 0, sizeof *s);
}

static uint32_t key_hash(int32_t a, int32_t b, int32_t c) {
    uint32_t h = (uint32_t)a * 0x9E3779B1u;
    h ^= (uint32_t)b * 0x85EBCA77u + (h << 6) + (h >> 2);
    h ^= (uint32_t)c * 0xC2B2AE3Du + (h << 6) + (h >> 2);
    h ^= h >> 15;
    return h;
}

static int hash_rebuild(ObjState *s, uint32_t cap) {
    uint32_t *h = (uint32_t *)calloc(cap, sizeof *h);
    if (!h) return 0;
    for (uint32_t i = 0; i < s->nverts; i++) {
        uint32_t k = key_hash(s->keys[3 * i], s->keys[3 * i + 1], s->keys[3 * i + 2]) & (cap - 1);
        while (h[k]) k = (k + 1) & (cap - 1);
        h[k] = i + 1;
    }
    free(s->hash);
    s->hash = h; s->hcap = cap;
    return 1;
}

/* returns 1 and *vi, 0 on OOM, -1 on the vertex limit */
static int obj_corner_vertex(ObjState *s, int32_t pi, int32_t ti, int32_t ni, uint32_t *vi) {
    if ((s->nverts + 1) * 2 > s->hcap && !hash_rebuild(s, s->hcap ? s->hcap * 2 : 1024)) return 0;
    uint32_t k = key_hash(pi, ti, ni) & (s->hcap - 1);
    while (s->hash[k]) {
        uint32_t v = s->hash[k] - 1;
        if (s->keys[3 * v] == pi && s->keys[3 * v + 1] == ti && s->keys[3 * v + 2] == ni) { *vi = v; return 1; }
        k = (k + 1) & (s->hcap - 1);
    }
    if (s->nverts >= FW_MESH_MAX_VERTS) return -1;
    if (!grow((void **)&s->verts, &s->cverts, s->nverts + 1, sizeof *s->verts)) return 0;
    if (!grow((void **)&s->keys, &s->ckeys, 3 * (s->nverts + 1), sizeof *s->keys)) return 0;
    FwMeshVertex *v = &s->verts[s->nverts];
    memcpy(v->pos, &s->pos[3 * (uint32_t)pi], sizeof v->pos);
    if (ti >= 0) memcpy(v->uv, &s->tex[2 * (uint32_t)ti], sizeof v->uv); else v->uv[0] = v->uv[1] = 0.0f;
    if (ni >= 0) { memcpy(v->nrm, &s->nrm[3 * (uint32_t)ni], sizeof v->nrm); normalize3(v->nrm, 1); }
    else v->nrm[0] = v->nrm[1] = v->nrm[2] = 0.0f;
    s->keys[3 * s->nverts] = pi; s->keys[3 * s->nverts + 1] = ti; s->keys[3 * s->nverts + 2] = ni;
    s->hash[k] = s->nverts + 1;
    *vi = s->nverts++;
    return 1;
}

/* an OBJ index (1-based, or negative = relative) against `count` elements -> 0-based, or -1 with the error set.
 * `what` is "" for a vertex ("face index 7 out of range (5 vertices)"), "texcoord " / "normal " otherwise. */
static int32_t resolve_index(long long v, uint32_t count, const char *what, const char *plural, int line,
                             FwMeshError *err) {
    if (v == 0) {
        set_err(err, FW_MC_PARSE_ERROR, line, "face %sindex 0 is invalid (OBJ indices start at 1) at line %d", what, line);
        return -1;
    }
    long long r = v > 0 ? v - 1 : (long long)count + v;
    if (r < 0 || r >= (long long)count) {
        set_err(err, FW_MC_PARSE_ERROR, line, "face %sindex %lld out of range (%u %s) at line %d", what, v, count, plural, line);
        return -1;
    }
    return (int32_t)r;
}

/* one face corner token: i | i/j | i//k | i/j/k */
static int parse_corner(ObjState *s, const char *ts, const char *te, int line, FwMeshError *err, int32_t out[3]) {
    const char *part[3] = { ts, NULL, NULL }, *pend[3] = { te, NULL, NULL };
    int nparts = 1;
    for (const char *q = ts; q < te; q++) {
        if (*q != '/') continue;
        if (nparts == 3) { set_err(err, FW_MC_PARSE_ERROR, line, "bad face corner '%.*s' at line %d", (int)(te - ts) > 40 ? 40 : (int)(te - ts), ts, line); return 0; }
        pend[nparts - 1] = q;
        part[nparts] = q + 1; pend[nparts] = te;
        nparts++;
    }
    long long v[3] = { 0, 0, 0 };
    int has[3] = { 0, 0, 0 };
    for (int i = 0; i < nparts; i++) {
        if (part[i] == pend[i]) {
            if (i == 1 && nparts == 3) continue;   /* i//k */
            set_err(err, FW_MC_PARSE_ERROR, line, "bad face corner '%.*s' at line %d", (int)(te - ts) > 40 ? 40 : (int)(te - ts), ts, line);
            return 0;
        }
        if (!parse_int(part[i], pend[i], &v[i])) {
            set_err(err, FW_MC_PARSE_ERROR, line, "not an index '%.*s' at line %d", (int)(te - ts) > 40 ? 40 : (int)(te - ts), ts, line);
            return 0;
        }
        has[i] = 1;
    }
    out[0] = resolve_index(v[0], s->npos, "", "vertices", line, err);
    if (out[0] < 0) return 0;
    out[1] = -1; out[2] = -1;
    if (has[1] && (out[1] = resolve_index(v[1], s->ntex, "texcoord ", "texcoords", line, err)) < 0) return 0;
    if (has[2] && (out[2] = resolve_index(v[2], s->nnrm, "normal ", "normals", line, err)) < 0) return 0;
    return 1;
}

/* reads 'min..max' numbers into dst (up to `keep` stored); returns the count or -1 with the error set */
static int parse_numbers(const char **p, const char *e, float *dst, int keep, int min, int max, const char *kw,
                         int line, FwMeshError *err) {
    const char *ts, *te;
    int n = 0;
    while (next_tok(p, e, &ts, &te)) {
        float f;
        if (!parse_float(ts, te, &f)) {
            set_err(err, FW_MC_PARSE_ERROR, line, "not a number '%.*s' in '%s' at line %d", (int)(te - ts) > 40 ? 40 : (int)(te - ts), ts, kw, line);
            return -1;
        }
        if (n >= max) { set_err(err, FW_MC_PARSE_ERROR, line, "too many numbers in '%s' (max %d) at line %d", kw, max, line); return -1; }
        if (n < keep) dst[n] = f;
        n++;
    }
    if (n < min) { set_err(err, FW_MC_PARSE_ERROR, line, "'%s' needs %d numbers, got %d at line %d", kw, min, n, line); return -1; }
    return n;
}

int fw_mesh_obj_parse(const char *text, size_t len, FwMesh *out, FwMeshError *err) {
    fw_mesh_err_reset(err);
    if (!out) { set_err(err, FW_MC_PARSE_ERROR, 0, "no output mesh"); return 0; }
    memset(out, 0, sizeof *out);
    if (!text && len) { set_err(err, FW_MC_PARSE_ERROR, 0, "no text"); return 0; }
    ObjState s;
    memset(&s, 0, sizeof s);
    s.allNormals = 1;
    const char *p = text, *end = text + len;
    if (len >= 3 && (unsigned char)p[0] == 0xEF && (unsigned char)p[1] == 0xBB && (unsigned char)p[2] == 0xBF) p += 3;
    int line = 0;
    while (p < end) {
        line++;
        const char *ls = p, *le = p;
        while (le < end && *le != '\n') le++;
        p = le < end ? le + 1 : le;
        for (const char *q = ls; q < le; q++) if (*q == '#') { le = q; break; }
        while (le > ls && is_ws(le[-1])) le--;
        if (le > ls && le[-1] == '\\') { set_err(err, FW_MC_PARSE_ERROR, line, "line continuation '\\' is not supported at line %d", line); goto fail; }
        const char *cur = ls, *ks, *ke;
        if (!next_tok(&cur, le, &ks, &ke)) continue;
        if (tok_is(ks, ke, "v")) {
            float f[3];
            if (s.npos >= FW_MESH_MAX_VERTS) { set_err(err, FW_MC_LIMIT, line, "more than %u vertices (limit) at line %d", FW_MESH_MAX_VERTS, line); goto fail; }
            if (parse_numbers(&cur, le, f, 3, 3, 7, "v", line, err) < 0) goto fail;
            if (!grow((void **)&s.pos, &s.cpos, 3 * (s.npos + 1), sizeof *s.pos)) goto oom;
            memcpy(&s.pos[3 * s.npos++], f, sizeof f);
        } else if (tok_is(ks, ke, "vt")) {
            float f[2] = { 0.0f, 0.0f };
            if (s.ntex >= FW_MESH_MAX_VERTS) { set_err(err, FW_MC_LIMIT, line, "more than %u texcoords (limit) at line %d", FW_MESH_MAX_VERTS, line); goto fail; }
            if (parse_numbers(&cur, le, f, 2, 1, 3, "vt", line, err) < 0) goto fail;
            if (!grow((void **)&s.tex, &s.ctex, 2 * (s.ntex + 1), sizeof *s.tex)) goto oom;
            f[1] = 1.0f - f[1];   /* OBJ's texture origin is bottom-left, glTF's / the game's top-left (Godot's OBJ importer does the same) */
            memcpy(&s.tex[2 * s.ntex++], f, sizeof f);
        } else if (tok_is(ks, ke, "vn")) {
            float f[3];
            if (s.nnrm >= FW_MESH_MAX_VERTS) { set_err(err, FW_MC_LIMIT, line, "more than %u normals (limit) at line %d", FW_MESH_MAX_VERTS, line); goto fail; }
            if (parse_numbers(&cur, le, f, 3, 3, 3, "vn", line, err) < 0) goto fail;
            if (!grow((void **)&s.nrm, &s.cnrm, 3 * (s.nnrm + 1), sizeof *s.nrm)) goto oom;
            memcpy(&s.nrm[3 * s.nnrm++], f, sizeof f);
        } else if (tok_is(ks, ke, "f")) {
            const char *ts, *te;
            uint32_t nc = 0;
            while (next_tok(&cur, le, &ts, &te)) {
                int32_t c[3];
                if (!parse_corner(&s, ts, te, line, err, c)) goto fail;
                if (c[1] >= 0) s.anyUv = 1;
                if (c[2] < 0) s.allNormals = 0;
                uint32_t vi;
                int r = obj_corner_vertex(&s, c[0], c[1], c[2], &vi);
                if (r == 0) goto oom;
                if (r < 0) { set_err(err, FW_MC_LIMIT, line, "more than %u mesh vertices (limit) at line %d", FW_MESH_MAX_VERTS, line); goto fail; }
                if (!grow((void **)&s.face, &s.cface, nc + 1, sizeof *s.face)) goto oom;
                s.face[nc++] = vi;
            }
            if (nc < 3) { set_err(err, FW_MC_PARSE_ERROR, line, "a face needs at least 3 corners, got %u at line %d", nc, line); goto fail; }
            uint32_t add = 3 * (nc - 2);
            if ((uint64_t)s.nidx + add > FW_MESH_MAX_INDICES) { set_err(err, FW_MC_LIMIT, line, "more than %u indices (limit) at line %d", FW_MESH_MAX_INDICES, line); goto fail; }
            if (!grow((void **)&s.idx, &s.cidx, s.nidx + add, sizeof *s.idx)) goto oom;
            for (uint32_t i = 1; i + 1 < nc; i++) {   /* fan: 0, i, i+1 (convex faces only) */
                s.idx[s.nidx++] = s.face[0]; s.idx[s.nidx++] = s.face[i]; s.idx[s.nidx++] = s.face[i + 1];
            }
        } else if (tok_in(ks, ke, kIgnored)) {
            if (tok_is(ks, ke, "mtllib") || tok_is(ks, ke, "usemtl")) fw_mesh_warn(err, FW_MC_MTL_IGNORED);   /* v1: no .mtl */
            continue;
        } else if (tok_in(ks, ke, kUnsupported)) {
            set_err(err, FW_MC_PRIMITIVE_MODE, line, "unsupported OBJ statement '%.*s' at line %d", (int)(ke - ks), ks, line);
            goto fail;
        } else {
            set_err(err, FW_MC_PARSE_ERROR, line, "unknown OBJ statement '%.*s' at line %d", (int)(ke - ks) > 24 ? 24 : (int)(ke - ks), ks, line);
            goto fail;
        }
    }
    if (s.nidx == 0) { set_err(err, FW_MC_EMPTY, 0, "no faces"); goto fail; }
    out->verts = s.verts; out->nverts = s.nverts;
    out->indices = s.idx; out->nindices = s.nidx;
    out->has_uvs = s.anyUv;
    fw_mesh_default_material(out);
    out->has_normals = s.allNormals;
    s.verts = NULL; s.idx = NULL;
    obj_state_free(&s);
    if (!out->has_normals && !fw_mesh_flat_normals(out)) { fw_mesh_free(out); set_err(err, FW_MC_LIMIT, 0, "out of memory"); return 0; }
    fw_mesh_bounds(out);
    return 1;
oom:
    set_err(err, FW_MC_LIMIT, line, "out of memory at line %d", line);
fail:
    obj_state_free(&s);
    memset(out, 0, sizeof *out);
    return 0;
}

/* ------------------------------------------------------------------ mesh operations */
void fw_mesh_bounds(FwMesh *m) {
    if (!m) return;
    if (!m->verts || !m->nverts) { memset(m->bmin, 0, sizeof m->bmin); memset(m->bmax, 0, sizeof m->bmax); return; }
    memcpy(m->bmin, m->verts[0].pos, sizeof m->bmin);
    memcpy(m->bmax, m->verts[0].pos, sizeof m->bmax);
    for (uint32_t i = 1; i < m->nverts; i++)
        for (int a = 0; a < 3; a++) {
            float v = m->verts[i].pos[a];
            if (v < m->bmin[a]) m->bmin[a] = v;
            if (v > m->bmax[a]) m->bmax[a] = v;
        }
}

int fw_mesh_flat_normals(FwMesh *m) {
    if (!m || !m->indices || !m->verts) return 0;
    uint32_t n = m->nindices - m->nindices % 3;
    FwMeshVertex *nv = (FwMeshVertex *)malloc((size_t)(n ? n : 1) * sizeof *nv);
    if (!nv) return 0;
    for (uint32_t t = 0; t < n; t += 3) {
        const FwMeshVertex *a = &m->verts[m->indices[t]], *b = &m->verts[m->indices[t + 1]], *c = &m->verts[m->indices[t + 2]];
        float u[3] = { b->pos[0] - a->pos[0], b->pos[1] - a->pos[1], b->pos[2] - a->pos[2] };
        float v[3] = { c->pos[0] - a->pos[0], c->pos[1] - a->pos[1], c->pos[2] - a->pos[2] };
        float nr[3] = { u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0] };
        normalize3(nr, 1);
        nv[t] = *a; nv[t + 1] = *b; nv[t + 2] = *c;
        for (int k = 0; k < 3; k++) memcpy(nv[t + k].nrm, nr, sizeof nr);
    }
    for (uint32_t i = 0; i < n; i++) m->indices[i] = i;
    free(m->verts);
    m->verts = nv; m->nverts = n; m->nindices = n;
    return 1;
}

void fw_mesh_to_game_axes(FwMesh *m, float scale) {
    if (!m || !m->verts) return;
    if (!(scale > 0.0f)) scale = 1.0f;   /* also catches NaN */
    for (uint32_t i = 0; i < m->nverts; i++) {
        FwMeshVertex *v = &m->verts[i];
        v->pos[0] *= scale; v->pos[1] *= scale; v->pos[2] *= -scale;
        v->nrm[2] = -v->nrm[2];
        normalize3(v->nrm, 0);
    }
    if (m->indices)
        for (uint32_t t = 0; t + 2 < m->nindices; t += 3) {
            uint32_t x = m->indices[t]; m->indices[t] = m->indices[t + 2]; m->indices[t + 2] = x;
        }
    fw_mesh_bounds(m);
}

void fw_mesh_free(FwMesh *m) {
    if (!m) return;
    free(m->verts);
    free(m->indices);
    free(m->image);
    memset(m, 0, sizeof *m);
}

int fw_mesh_unit_cube(FwMesh *out) {
    if (!out) return 0;
    memset(out, 0, sizeof *out);
    /* per face: outward normal n and tangents u, v with u x v = n (so corners 0,1,2 / 0,2,3 wind outward) */
    static const float F[6][3][3] = {
        { { 1, 0, 0 }, { 0, 1, 0 }, { 0, 0, 1 } },   /* +x */
        { { -1, 0, 0 }, { 0, 0, 1 }, { 0, 1, 0 } },  /* -x */
        { { 0, 1, 0 }, { 0, 0, 1 }, { 1, 0, 0 } },   /* +h (top) */
        { { 0, -1, 0 }, { 1, 0, 0 }, { 0, 0, 1 } },  /* -h (bottom) */
        { { 0, 0, 1 }, { 1, 0, 0 }, { 0, 1, 0 } },   /* +z */
        { { 0, 0, -1 }, { 0, 1, 0 }, { 1, 0, 0 } },  /* -z */
    };
    static const float C[4][2] = { { -1, -1 }, { 1, -1 }, { 1, 1 }, { -1, 1 } };
    out->verts = (FwMeshVertex *)malloc(24 * sizeof *out->verts);
    out->indices = (uint32_t *)malloc(36 * sizeof *out->indices);
    if (!out->verts || !out->indices) { fw_mesh_free(out); return 0; }
    for (int f = 0; f < 6; f++) {
        for (int k = 0; k < 4; k++) {
            FwMeshVertex *v = &out->verts[4 * f + k];
            for (int a = 0; a < 3; a++) {
                float centre = a == 1 ? 0.5f : 0.0f;
                v->pos[a] = centre + 0.5f * (F[f][0][a] + C[k][0] * F[f][1][a] + C[k][1] * F[f][2][a]);
                v->nrm[a] = F[f][0][a];
            }
            v->uv[0] = (C[k][0] + 1.0f) * 0.5f;
            v->uv[1] = (C[k][1] + 1.0f) * 0.5f;
        }
        uint32_t b = 4u * (uint32_t)f, *ix = &out->indices[6 * f];
        ix[0] = b; ix[1] = b + 1; ix[2] = b + 2; ix[3] = b; ix[4] = b + 2; ix[5] = b + 3;
    }
    out->nverts = 24; out->nindices = 36;
    out->has_normals = 1; out->has_uvs = 1;
    fw_mesh_default_material(out);
    fw_mesh_bounds(out);
    return 1;
}

/* ------------------------------------------------------------------ registry */
int fw_mesh_reg_add(FwMeshRegistry *reg, const char *name, FwMesh *taken) {
    if (!reg || !name || !taken) return -1;
    size_t n = strlen(name);
    if (n == 0 || n > FW_MESH_NAME_MAX) return -1;
    if (!taken->verts || !taken->nverts || !taken->indices || taken->nindices < 3) return -1;
    if (reg->count < 0 || reg->count >= FW_MESH_MAX_MODELS) return -1;
    if (fw_mesh_reg_find(reg, name) >= 0) return -1;
    int i = reg->count++;
    memcpy(reg->names[i], name, n + 1);
    reg->meshes[i] = *taken;
    memset(taken, 0, sizeof *taken);
    return i;
}

int fw_mesh_reg_find(const FwMeshRegistry *reg, const char *name) {
    if (!reg || !name) return -1;
    for (int i = 0; i < reg->count && i < FW_MESH_MAX_MODELS; i++)
        if (strcmp(reg->names[i], name) == 0) return i;
    return -1;
}

const FwMesh *fw_mesh_reg_get(const FwMeshRegistry *reg, int i) {
    return reg && i >= 0 && i < reg->count && i < FW_MESH_MAX_MODELS ? &reg->meshes[i] : NULL;
}

const char *fw_mesh_reg_name(const FwMeshRegistry *reg, int i) {
    return reg && i >= 0 && i < reg->count && i < FW_MESH_MAX_MODELS ? reg->names[i] : NULL;
}

void fw_mesh_reg_clear(FwMeshRegistry *reg) {
    if (!reg) return;
    for (int i = 0; i < FW_MESH_MAX_MODELS; i++) { fw_mesh_free(&reg->meshes[i]); reg->names[i][0] = 0; }
    reg->count = 0;
}

/* ------------------------------------------------------------------ model paths */
#define MODEL_PREFIX "models/"

/* THE model path rule, shared by the loader (here), the 3D-object registry (fw_obj3d_model_path_ok) and the editor
 * (editor/src/core/model3d.ts modelPathProblem): relative to the mod folder, starts models/, printable ASCII without a
 * backslash or ':', no empty / "." / ".." segment (sub-folders are fine), a file name longer than its extension, the
 * lowercase extension .obj | .gltf | .glb giving the kind, at most FW_MESH_NAME_MAX (63) bytes (the registry's and
 * Fw3dObject's name size). *nameAt / *nameLen = the file name without its extension. */
static int model_check(const char *ref, size_t *nameAt, size_t *nameLen) {
    if (!ref) return 0;
    size_t pl = sizeof MODEL_PREFIX - 1, n = strlen(ref);
    if (n > FW_MESH_NAME_MAX || strncmp(ref, MODEL_PREFIX, pl) != 0) return 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)ref[i];
        if (c < 0x20 || c > 0x7e || c == '\\' || c == ':') return 0;
    }
    const char *seg = ref, *last = ref;
    for (;;) {
        const char *slash = strchr(seg, '/');
        size_t len = slash ? (size_t)(slash - seg) : strlen(seg);
        if (len == 0 || (len == 1 && seg[0] == '.') || (len == 2 && seg[0] == '.' && seg[1] == '.')) return 0;
        if (!slash) { last = seg; break; }
        seg = slash + 1;
    }
    static const struct { const char *ext; int kind; } kinds[] = { { ".obj", FW_MESH_KIND_OBJ }, { ".gltf", FW_MESH_KIND_GLTF }, { ".glb", FW_MESH_KIND_GLB } };
    size_t ll = strlen(last);
    for (size_t k = 0; k < sizeof kinds / sizeof kinds[0]; k++) {
        size_t el = strlen(kinds[k].ext);
        if (ll > el && strcmp(last + ll - el, kinds[k].ext) == 0) {
            if (nameAt) *nameAt = (size_t)(last - ref);
            if (nameLen) *nameLen = ll - el;
            return kinds[k].kind;
        }
    }
    return 0;
}

int fw_mesh_model_kind(const char *path) { return model_check(path, NULL, NULL); }

int fw_mesh_model_path(const char *ref, char *out, size_t cap) {
    if (out && cap) out[0] = 0;
    if (!out || !model_check(ref, NULL, NULL)) return 0;
    size_t n = strlen(ref);
    if (n + 1 > cap) return 0;
    memcpy(out, ref, n + 1);
    return 1;
}

int fw_mesh_name_from_path(const char *path, char *out, size_t cap) {
    if (out && cap) out[0] = 0;
    size_t at = 0, nl = 0;
    if (!out || !model_check(path, &at, &nl) || nl + 1 > cap) return 0;
    memcpy(out, path + at, nl);
    out[nl] = 0;
    return 1;
}

/* ------------------------------------------------------------------ model codes (design §2.6) */
/* THE list. editor/src/core/model-codes.ts mirrors it entry for entry (editor/test/model-codes-tests.ts parses this
 * initializer, so keep one `[FW_MC_X] = { "model-x", "severity" },` per line). */
const FwMeshCode FW_MESH_CODES[FW_MC_COUNT] = {
    [FW_MC_PATH_INVALID] = { "model-path-invalid", "error" },
    [FW_MC_FILE_MISSING] = { "model-file-missing", "error" },
    [FW_MC_UNREGISTERED] = { "model-unregistered", "error" },
    [FW_MC_PARSE_ERROR] = { "model-parse-error", "error" },
    [FW_MC_EXTENSION] = { "model-extension", "error" },
    [FW_MC_GLB_HEADER] = { "model-glb-header", "error" },
    [FW_MC_GLTF_VERSION] = { "model-gltf-version", "error" },
    [FW_MC_EXTENSION_REQUIRED] = { "model-extension-required", "error" },
    [FW_MC_URI_UNSUPPORTED] = { "model-uri-unsupported", "error" },
    [FW_MC_BUFFER_MISSING] = { "model-buffer-missing", "error" },
    [FW_MC_BUFFER_RANGE] = { "model-buffer-range", "error" },
    [FW_MC_ACCESSOR_INVALID] = { "model-accessor-invalid", "error" },
    [FW_MC_SPARSE_UNSUPPORTED] = { "model-sparse-unsupported", "error" },
    [FW_MC_PRIMITIVE_MODE] = { "model-primitive-mode", "error" },
    [FW_MC_ATTRIBUTE_MISSING] = { "model-attribute-missing", "error" },
    [FW_MC_ATTRIBUTE_FORMAT] = { "model-attribute-format", "error" },
    [FW_MC_INDEX_RANGE] = { "model-index-range", "error" },
    [FW_MC_NODE_INVALID] = { "model-node-invalid", "error" },
    [FW_MC_NODE_CYCLE] = { "model-node-cycle", "error" },
    [FW_MC_EMPTY] = { "model-empty", "error" },
    [FW_MC_LIMIT] = { "model-limit", "error" },
    [FW_MC_MULTI_MATERIAL] = { "model-multi-material", "warning" },
    [FW_MC_NGON_CONCAVE] = { "model-ngon-concave", "warning" },
    [FW_MC_SKIN_IGNORED] = { "model-skin-ignored", "warning" },
    [FW_MC_ANIMATION_IGNORED] = { "model-animation-ignored", "warning" },
    [FW_MC_MORPH_IGNORED] = { "model-morph-ignored", "warning" },
    [FW_MC_TEXCOORD_SET] = { "model-texcoord-set", "warning" },
    [FW_MC_TEXTURE_TRANSFORM_IGNORED] = { "model-texture-transform-ignored", "warning" },
    [FW_MC_ALPHA_BLEND] = { "model-alpha-blend", "warning" },
    [FW_MC_IMAGE_FORMAT] = { "model-image-format", "warning" },
    [FW_MC_TEXTURE_NO_UVS] = { "model-texture-no-uvs", "warning" },
    [FW_MC_HEAVY] = { "model-heavy", "warning" },
    [FW_MC_BELOW_FLOOR] = { "model-below-floor", "warning" },
    [FW_MC_FOOTPRINT] = { "model-footprint", "warning" },
    [FW_MC_TEXTURE_MISSING] = { "model-texture-missing", "warning" },
    [FW_MC_TEXTURE_FORMAT] = { "model-texture-format", "warning" },
    [FW_MC_TEXTURE_SIZE] = { "model-texture-size", "warning" },
    [FW_MC_IMAGE_EMBEDDED_INVALID] = { "model-image-embedded-invalid", "warning" },
    [FW_MC_IMAGE_EMBEDDED_UNSUPPORTED] = { "model-image-embedded-unsupported", "warning" },
    [FW_MC_NO_NORMALS] = { "model-no-normals", "info" },
    [FW_MC_TEXTURE_EMBEDDED] = { "model-texture-embedded", "info" },
    [FW_MC_MTL_IGNORED] = { "model-mtl-ignored", "info" },
    [FW_MC_EXTENSION_IGNORED] = { "model-extension-ignored", "info" },
    [FW_MC_ATTRIBUTE_IGNORED] = { "model-attribute-ignored", "info" },
};

const char *fw_mesh_code(FwMeshCodeId id) {
    return (int)id >= 0 && (int)id < FW_MC_COUNT ? FW_MESH_CODES[id].code : NULL;
}

const char *fw_mesh_code_severity(const char *code) {
    if (!code) return NULL;
    for (int i = 0; i < FW_MC_COUNT; i++) if (FW_MESH_CODES[i].code && !strcmp(FW_MESH_CODES[i].code, code)) return FW_MESH_CODES[i].severity;
    return NULL;
}

void fw_mesh_err_reset(FwMeshError *e) { if (e) memset(e, 0, sizeof *e); }

int fw_mesh_has_warning(const FwMeshError *e, FwMeshCodeId id) {
    const char *c = fw_mesh_code(id);
    if (!e || !c) return 0;
    for (int i = 0; i < e->nwarnings && i < FW_MESH_MAX_WARNINGS; i++) if (e->warnings[i] == c) return 1;
    return 0;
}

void fw_mesh_warn(FwMeshError *e, FwMeshCodeId id) {
    const char *c = fw_mesh_code(id);
    if (!e || !c || fw_mesh_has_warning(e, id) || e->nwarnings < 0 || e->nwarnings >= FW_MESH_MAX_WARNINGS) return;
    e->warnings[e->nwarnings++] = c;
}
