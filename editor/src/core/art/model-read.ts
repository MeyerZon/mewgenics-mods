// 3D model readers: shared types, game axes, budgets, preview (docs/3d-importer-design.md). Stub (red).
export interface TriMesh { positions: Float32Array; normals: Float32Array | null; uvs: Float32Array | null; indices: Uint32Array }
export type ModelSeverity = "error" | "warning" | "info";
export interface ModelFinding { code: string; severity: ModelSeverity; message: string; line?: number }
export interface ModelTexture { uri?: string; mimeType?: string; embedded?: Uint8Array; texCoord: number }
export interface ModelMaterial { name?: string; baseColor: [number, number, number, number]; texture: ModelTexture | null; alphaMode: "OPAQUE" | "MASK" | "BLEND"; alphaCutoff: number; doubleSided: boolean }
export interface ModelStats { vertices: number; triangles: number; meshes: number; primitives: number; nodes: number }
export interface ModelRead { format: "obj" | "gltf" | "glb" | "unknown"; mesh: TriMesh | null; materials: ModelMaterial[]; primitiveMaterials: number[]; findings: ModelFinding[]; stats: ModelStats }
export const MODEL_LIMITS = { budgetTriangles: 5000 };
const todo = (): never => { throw new Error("not implemented"); };
export function readModel(_p: string, _b: Uint8Array, _r?: (uri: string) => Uint8Array | null): ModelRead { return todo(); }
export function toGameAxes(_m: TriMesh, _s = 1): TriMesh { return todo(); }
export function isoProject(_x: number, _h: number, _z: number): [number, number] { return todo(); }
export function isoWireframeSvg(_m: TriMesh): string { return todo(); }
export function modelBudgetFindings(_m: TriMesh): ModelFinding[] { return todo(); }
