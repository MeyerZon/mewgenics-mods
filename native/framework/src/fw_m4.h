/* fw_m4.h — the 4x4 matrix maths of the 3D mesh path (docs/possible_3d_work.md phase M). Pure, host-tested
 * (test/test_mesh_draw.c). Convention = the game's: float m[16] column-major, m[c*4 + r]; m12/m13/m14 = translation.
 *
 * The vanilla scene is orthographic: a sprite's model matrix is Renderer_GetScreenMatrix (0x78d600): m12/m13 = the ISO
 * projection of the world point (x, height, z) into "camera-2D" units, m14 = 0. The world camera's VP
 * (Camera_GetViewProjection 0x9785e0 = K x inverse(view)) maps camera-2D to the 1280x720 canvas, and the matrix stack's
 * base (MatStack_Ortho, set by FrameBegin) maps the canvas to NDC with z_ndc = 1e-4 * z. So a mesh vertex goes
 *   NDC = stackTop x VP x Model x (x, h, z, 1)
 * where Model = the ISO basis (x, height, z -> camera-2D x, y) with a VIEW DEPTH in its z row (fw_m4_iso_basis), times
 * the placement (tile centre, scale). The z row is ours: the vanilla scene never writes depth on its normal layers, so
 * the mesh's depth only has to order the mesh against itself (and, in phase M2, against sprites). */
#pragma once

/* camera-2D z per world unit along the view direction: |z| stays far inside the base ortho's +-10 000 (1e-4 scale)
 * for any board, and 24-bit depth keeps ~1 600 steps per world unit */
#define FW_M4_DEPTH_SCALE 100.0f

void fw_m4_identity(float o[16]);
/* o = a x b (column-major: apply b first). o may alias a or b. */
void fw_m4_mul(const float a[16], const float b[16], float o[16]);
double fw_m4_det(const float m[16]);
/* 1 and o = m^-1; 0 when singular (o untouched) */
int fw_m4_inverse(const float m[16], float o[16]);
/* out = m x p (p is a full homogeneous vec4) */
void fw_m4_apply(const float m[16], const float p[4], float out[4]);

/* the vanilla view direction in world (x, height, z): yaw 45 deg, pitch 30 deg (notes-r3dF F2: the ISO columns'
 * up/right ratio is sin 30), pointing INTO the screen; dot(p, dir) grows with distance */
void fw_m4_view_dir(float dir[3]);

/* the ISO basis with a depth row: column 0 = (iso[0], iso[1], D*dir.x, 0), column 1 = (iso[4], iso[5], D*dir.h, 0),
 * column 2 = (iso[8], iso[9], D*dir.z, 0), column 3 = (0, 0, 0, 1), D = FW_M4_DEPTH_SCALE. `iso` is the game's ISO
 * matrix (FwData Iso 0x12f7a00: x -> (0.894, 0.447), height -> (0, 1), z -> (-0.894, 0.447)). */
void fw_m4_iso_basis(const float iso[16], float out[16]);

/* the model matrix of a mesh placed at world (x, height, z) with a uniform scale: isoBasis x T(x, h, z) x S(scale) */
void fw_m4_place(const float iso[16], double x, double h, double z, double scale, float out[16]);

/* the world point at the centre of tile (col, row) on the ground: (col + 0.5, 0, row + 0.5) — the tile picker's
 * centres (TacticsGrid_PickTileUnderMouse 0x8abc50) and the units' positions in the T2 run (2.5, 5.5) */
void fw_m4_tile_centre(int col, int row, double out[3]);

/* project a local point through mvp: out = (x, y, z) / w in NDC; 0 when w is ~0 */
int fw_m4_project(const float mvp[16], const float local[3], float ndc[3]);

/* NDC -> a pixel of a w x h image whose row 0 is the TOP (a shot): px = (x + 1) / 2 * w, py = (1 - y) / 2 * h */
void fw_m4_ndc_to_pixel(const float ndc[3], double w, double h, double out[2]);
