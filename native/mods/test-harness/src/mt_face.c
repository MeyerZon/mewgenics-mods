/* mt_face.c — Character::Face (0x10ce50) as a pure rule (red stub: not implemented yet). */
#include "mt_pure.h"
#include <string.h>

const char *mt_face_name(int named) { (void)named; return ""; }
void mt_face_named_dir(int named, int sign, int *dx, int *dy) { (void)named; (void)sign; *dx = 0; *dy = 0; }
int mt_face_predict(const MtFaceIn *in, MtFaceOut *out) { (void)in; memset(out, 0, sizeof *out); return 0; }
