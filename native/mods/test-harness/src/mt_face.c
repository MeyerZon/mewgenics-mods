/* mt_face.c — glaiel::Character::Face(iVec2D, bool, bool) (RVA 0x10ce50 on build 25143593) as a pure rule.
 * The harness's `face` directive calls the real function; this module says what it should have produced, so the
 * face event can report the rule next to what the game wrote (docs/engine-map.md "Facing: Character::Face"). */
#include "mt_pure.h"
#include <string.h>

const char *mt_face_name(int named) { return named == MT_FACE_FRONT ? "front" : named == MT_FACE_BACK ? "back" : ""; }

void mt_face_named_dir(int named, int sign, int *dx, int *dy) {
    int s = sign < 0 ? -1 : 1;   /* Face multiplies the direction by the sign (+-1); an unread 0 counts as 1 */
    if (named == MT_FACE_FRONT) { *dx = 0; *dy = -s; }   /* s * (0, -s) = (0, -1): F, +art_flip */
    else if (named == MT_FACE_BACK) { *dx = s; *dy = 0; } /* s * (s, 0) = (1, 0): B, +art_flip */
    else { *dx = 0; *dy = 0; }
}

int mt_face_predict(const MtFaceIn *in, MtFaceOut *out) {
    memset(out, 0, sizeof *out);
    int x = in->dx, y = in->dy;
    if (in->lockX || in->lockY) { x = in->lockX; y = in->lockY; }   /* lock_orientation replaces the argument */
    if (in->alwaysFront) {                                          /* always_face_forward: the two back directions turn front */
        if (x == 1 && y == 0) { x = 0; y = -1; }
        else if (x == 0 && y == 1) { x = -1; y = 0; }
    }
    out->dx = x; out->dy = y;
    if (!x && !y) return 0;
    if (!in->fourWay) {
        int s = in->sign < 0 ? -1 : in->sign > 0 ? in->sign : 1;
        int sx = s * x, sy = s * y;
        if (!in->noHFlip) out->flipMul = (sx < 0 || sy > 0) ? -1 : (sx > 0 || sy < 0) ? 1 : 0;
        if (sx > 0 || sy > 0) strcpy(out->suffix, "B");
        else strcpy(out->suffix, "F");
        return 1;
    }
    /* four-way: no sign, no flip; L/R then F/B */
    out->suffix[0] = (x < 0 || y > 0) ? 'L' : 'R';
    out->suffix[1] = (x > 0 || y > 0) ? 'B' : 'F';
    out->suffix[2] = 0;
    return 1;
}
