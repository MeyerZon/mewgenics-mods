# 3D importer design — OBJ + glTF 2.0, engine (C11) and editor (TypeScript)

Status 2026-10-22. Phase M3 of [`possible_3d_work.md`](possible_3d_work.md) ("assets + data seam"). This is the design
the mesh work follows (lead `mesh`, branches `feat/3d-meshes-m1` / `-obj` / `-api` / `-shader`, which already ship the
OBJ subset parser `native/framework/src/fw_mesh_rules.c`, the 3D registry, the GON `graphics.model` key and the
`fw_mesh.shader`), and the next phase after it. The editor half's readers are built and tested in this PR
(`editor/src/core/art/{obj-read,gltf-read,model-read}.ts`, `editor/test/model-read-tests.ts`); the DLL half is
specified here and is the `mesh` lead's to build. Inputs: `.analysis/notes-r3dF.md` §1 (the loader sketch),
`.analysis/notes-r3dE.md` (G13: the resource layer), `docs/engine-map.md` "3D rendering path (2026-10-22)".

The owner-facing export recipe is [`data-mods.md` "3D models: exporting from Blender"](data-mods.md#3d-models-exporting-from-blender).

## Sources (pinned)

Every "Godot" / "Blender" / "spec" reference below is a permalink at these revisions:

| Source | Revision | Root |
|---|---|---|
| Godot | `4.7.2-stable` = `ed1daf0bf001b61586d9930840f2f1394092c079` | `https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/` |
| Blender (incl. the bundled `io_scene_gltf2`, glTF-Blender-IO) | `v5.2.3` = `e13b728c6880d3084d9d57c30031ed5df8b39dee` (GitHub mirror) | `https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/` |
| glTF 2.0 specification | Khronos registry, 2.0.1 | `https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html` |
| glTF sample models | `KhronosGroup/glTF-Sample-Assets` `15cd02d304e54cb42a4db4eefe719f76190f4b68` | `https://github.com/KhronosGroup/glTF-Sample-Assets/tree/15cd02d304e54cb42a4db4eefe719f76190f4b68/Models/` |

Short names used below (`GD:` / `BL:` = the roots above):

- **GD gltf_document** = `GD:modules/gltf/gltf_document.cpp` — `_parse_glb` [L268–308](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L268-L308), `_parse_buffers` [L764–806](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L764-L806), `_parse_accessors` [L858–877](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L858-L877), `_parse_meshes` [L1402–1980](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L1402-L1980) (mode table [L1492](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L1492), CCW→CW index swap [L1525](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L1525), unused-vertex compaction [L1535](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L1535)), `_parse_images` [L2302](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L2302) (bufferView without mimeType [L2397](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L2397)), `_parse_image_save_image` (extract textures) [L2191](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L2191), `_parse_materials` [L2947](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L2947), `_parse` [L6676](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L6676), `_parse_asset_header` [L7089](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L7089), `_parse_gltf_state` [L7106–7189](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L7106-L7189), `generate_scene` [L7217](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L7217), `append_from_buffer` [L7313](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L7313), `_parse_gltf_extensions` [L7364](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L7364), supported-extension set [L6968](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/gltf_document.cpp#L6968).
- **GD accessor** = `GD:modules/gltf/structures/gltf_accessor.cpp` — `_determine_pad_skip` [L263](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/structures/gltf_accessor.cpp#L263), `_decode_sparse_indices` [L555](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/structures/gltf_accessor.cpp#L555), `_decode_raw_numbers` [L594–733](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/structures/gltf_accessor.cpp#L594-L733) (alignment WARN [L625–630](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/structures/gltf_accessor.cpp#L625-L630), stride [L633–644](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/structures/gltf_accessor.cpp#L633-L644), size check [L645–647](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/structures/gltf_accessor.cpp#L645-L647)), `_decode_as_numbers` (sparse) [L736](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/structures/gltf_accessor.cpp#L736).
- **GD buffer_view** = `GD:modules/gltf/structures/gltf_buffer_view.cpp` `load_buffer_view_data` [L113–122](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/structures/gltf_buffer_view.cpp#L113-L122).
- **GD skin_tool** = `GD:modules/gltf/skin_tool.cpp` `_determine_skeletons` [L298](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/skin_tool.cpp#L298).
- **GD importer_mesh** = `GD:scene/resources/3d/importer_mesh.cpp` `merge_importer_meshes` [L44–130](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/scene/resources/3d/importer_mesh.cpp#L44-L130), `generate_lods` [L570](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/scene/resources/3d/importer_mesh.cpp#L570); `importer_mesh.h` [L40–80](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/scene/resources/3d/importer_mesh.h#L40-L80).
- **GD obj** = `GD:editor/import/3d/resource_importer_obj.cpp` — MTL [L42–219](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/editor/import/3d/resource_importer_obj.cpp#L42-L219) (`map_Kd` [L118](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/editor/import/3d/resource_importer_obj.cpp#L118)), COFF guard [L224–236](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/editor/import/3d/resource_importer_obj.cpp#L224-L236), continuation [L265](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/editor/import/3d/resource_importer_obj.cpp#L265), `vt` with `1 - v` [L299–306](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/editor/import/3d/resource_importer_obj.cpp#L299-L306), faces / fan / negative indices [L316–387](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/editor/import/3d/resource_importer_obj.cpp#L316-L387), `s` [L388–401](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/editor/import/3d/resource_importer_obj.cpp#L388-L401), surface commit on `usemtl`/`o` + `generate_normals` [L402–428](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/editor/import/3d/resource_importer_obj.cpp#L402-L428), options [L642–651](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/editor/import/3d/resource_importer_obj.cpp#L642-L651).
- **GD scene import** = `GD:editor/import/3d/resource_importer_scene.cpp` options [L2641–2651](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/editor/import/3d/resource_importer_scene.cpp#L2641-L2651) (`nodes/apply_root_scale`, `nodes/root_scale`, `meshes/ensure_tangents`, `meshes/generate_lods`, `meshes/force_disable_compression`), per-mesh `generate/lods` [L2298](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/editor/import/3d/resource_importer_scene.cpp#L2298); `GD:modules/gltf/editor/editor_scene_importer_gltf.cpp` [L44–101](https://github.com/godotengine/godot/blob/ed1daf0bf001b61586d9930840f2f1394092c079/modules/gltf/editor/editor_scene_importer_gltf.cpp#L44-L101) (`gltf/embedded_image_handling`, default "Extract Textures").
- **BL io** = `BL:scripts/addons_core/io_scene_gltf2/io/imp/gltf2_io_gltf.py` — `check_version` [L84–91](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/io/imp/gltf2_io_gltf.py#L84-L91), `checks` [L93–106](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/io/imp/gltf2_io_gltf.py#L93-L106), `load_glb` [L108–139](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/io/imp/gltf2_io_gltf.py#L108-L139), `load_uri` [L193](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/io/imp/gltf2_io_gltf.py#L193); `.../io/imp/gltf2_io_binary.py` `decode_accessor_obj` [L131–220](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/io/imp/gltf2_io_binary.py#L131-L220).
- **BL mesh** = `BL:scripts/addons_core/io_scene_gltf2/blender/imp/mesh.py` — `do_primitives` [L168](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/blender/imp/mesh.py#L168) (all primitives concatenated into one mesh, material slots per primitive), `points_edges_tris` [L661–763](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/blender/imp/mesh.py#L661-L763), `uvs_gltf_to_blender` [L778](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/blender/imp/mesh.py#L778), `skin_into_bind_pose` [L784](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/blender/imp/mesh.py#L784), `set_poly_smoothing` [L865](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/blender/imp/mesh.py#L865), `merge_duplicate_verts` [L931](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/blender/imp/mesh.py#L931); `.../blender/imp/blender_gltf.py` `set_convert_functions` [L65–123](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/blender/imp/blender_gltf.py#L65-L123) (Y-up→Z-up [L72](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/blender/imp/blender_gltf.py#L72), unit scale [L68](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/blender/imp/blender_gltf.py#L68)).
- **BL export** = `BL:scripts/addons_core/io_scene_gltf2/__init__.py` — formats [L139–157](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/__init__.py#L139-L157), `export_image_format` [L353](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/__init__.py#L353), `export_texture_dir` [L390](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/__init__.py#L390), UVs / Normals [L424–435](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/__init__.py#L424-L435), Draco [L462](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/__init__.py#L462), Tangents [L516](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/__init__.py#L516), Materials [L522](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/__init__.py#L522), Selected Objects [L618](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/__init__.py#L618), `+Y Up` [L673](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/__init__.py#L673), Apply Modifiers [L679](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/__init__.py#L679), Animations [L692](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/__init__.py#L692), Skinning [L920](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/__init__.py#L920), Shape Keys [L939](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/__init__.py#L939), "Use Sparse Accessor if Better" [L979](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/__init__.py#L979); `.../blender/exp/primitive_extract.py` loop triangles + per-material primitives [L390–413](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/blender/exp/primitive_extract.py#L390-L413); `.../blender/exp/material/texture_info.py` `KHR_texture_transform` from a Mapping node [L160–164](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/scripts/addons_core/io_scene_gltf2/blender/exp/material/texture_info.py#L160-L164).
- **BL obj** = `BL:source/blender/io/wavefront_obj/importer/obj_import_file_reader.cc` — `parse_vertex_index` [L159–178](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/source/blender/io/wavefront_obj/importer/obj_import_file_reader.cc#L159-L178), `geom_add_polygon` (bad index → face dropped) [L221–326](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/source/blender/io/wavefront_obj/importer/obj_import_file_reader.cc#L221-L326), `geom_update_group` / `geom_update_smooth_group` / `geom_new_object` [L398–440](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/source/blender/io/wavefront_obj/importer/obj_import_file_reader.cc#L398-L440), mmap [L443–462](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/source/blender/io/wavefront_obj/importer/obj_import_file_reader.cc#L443-L462), `parse_keyword` [L474–490](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/source/blender/io/wavefront_obj/importer/obj_import_file_reader.cc#L474-L490), `read_next_obj_line` (continuations) [L508–560](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/source/blender/io/wavefront_obj/importer/obj_import_file_reader.cc#L508-L560), `parse_string_buffer` [L564–696](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/source/blender/io/wavefront_obj/importer/obj_import_file_reader.cc#L564-L696) (unknown → `CLOG_WARN` [L693](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/source/blender/io/wavefront_obj/importer/obj_import_file_reader.cc#L693)); `.../obj_import_mesh.cc` `fixup_invalid_faces` [L122](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/source/blender/io/wavefront_obj/importer/obj_import_mesh.cc#L122); `.../importer_mesh_utils.cc` `fixup_invalid_face` (constrained Delaunay) [L28–60](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/source/blender/io/wavefront_obj/importer/importer_mesh_utils.cc#L28-L60); `BL:source/blender/io/common/IO_string_utils.hh` (the p/end slice design note) [L9–19](https://github.com/blender/blender/blob/e13b728c6880d3084d9d57c30031ed5df8b39dee/source/blender/io/common/IO_string_utils.hh#L9-L19).
- **spec §** = the registry spec with these anchors: [`#coordinate-system-and-units`](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#coordinate-system-and-units), [`#accessor-data-types`](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#accessor-data-types), [`#data-alignment`](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#data-alignment), [`#sparse-accessors`](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#sparse-accessors), [`#meshes-overview`](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#meshes-overview), [`#transformations`](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#transformations), [`#texture-data`](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#texture-data), [`#default-material`](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#default-material), [`#binary-gltf-layout`](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout), [`#chunks`](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#chunks), [`#uris`](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#uris).

Nothing from these projects is copied: they are read for behaviour and wording. Godot is MIT, Blender GPL-2.0+ — so
no code is ported from Blender at all, only the rules (which are the spec's or the OBJ format's).

## 1. The shape of both importers (what we borrow from the big ones)

Godot's glTF importer is **two-phase**: `_parse_gltf_state` turns the file into a `GLTFState` of plain structures
(buffers → bufferViews → accessors → nodes → images → materials → skins → meshes → animations, in that order:
GD gltf_document L7106–7189), and only `generate_scene` builds engine objects from it (L7217). Between the two sits
`ImporterMesh` (GD importer_mesh.h L40–80): an engine-neutral surface list (arrays + material + LODs) that importers
fill and the engine turns into a GPU mesh later. Blender's glTF importer has the same split (`io/imp` reads, `blender/
imp` creates). **We keep the split and shrink both halves**:

```
bytes (borrowed, ResourceManager_GetBinaryResource)            bytes (fs)          editor
   │ phase 1: parse + validate (pure C11, host-tested)            │ readModel()      (TypeScript, same rules)
   ▼                                                              ▼
FwMesh  = ONE flattened triangle list in file axes, + FwModelMaterial, + a list of findings
   │ fw_mesh_to_game_axes (mirror z, reverse winding, scale)      │ toGameAxes()
   ▼                                                              ▼
registry (by mod path) ──► phase 2 (GL thread, in the functor):   validator codes model-*, iso wireframe,
   VBO/IBO upload once, texture via App_GetTexture, draw          budgets, texture extraction
```

The intermediate is not a scene: every node's world matrix is **baked into its primitives** and all primitives are
**merged into one triangle list** — Godot's `ImporterMesh::merge_importer_meshes` with relative transforms (GD
importer_mesh L44–130), and what Blender does per mesh object (BL mesh `do_primitives` concatenates all primitives).
One model = one VBO + one IBO + one draw call inside the one functor per frame (r3dF "one functor per frame for all
meshes"). The game never needs our node tree in v1: placement comes from the unit / tile and the GON `model` block.

**What we reject from both, on purpose:** extension plugin points (`GLTFDocumentExtension`), import option matrices
(Godot's ~90 scene-import options, GD scene import L2641–2651), LOD generation (GD importer_mesh `generate_lods` L570;
a prop is ~100 px tall on screen), mesh compression, tangent generation (MikkTSpace; we have no normal maps),
lightmap UV2, physics/navmesh shapes, material-variant handling, point clouds, NURBS (BL obj `obj_import_nurbs.cc`).
Each would be code in a DLL that must not crash the game; none changes a pixel of a palette-shaded prop.

## 2. Engine side (C11, inside `mewframework.dll`)

### 2.1 Modules (all pure: no windows.h, no GL, no game; host-tested; compiled into the DLL unchanged)

| File | Role | Status |
|---|---|---|
| `fw_mesh_rules.c/.h` | `FwMesh`, OBJ subset, game axes, flat normals, unit cube, registry, model paths | **built** (`feat/3d-meshes-obj`, `test_mesh_rules.c`) |
| `fw_json.c/.h` | jsmn-style JSON tokenizer (state machine, two-pass, no allocation in the scan) | to build |
| `fw_gltf.c/.h` | glTF 2.0 subset (§2.4) on `fw_json`: GLB container, buffers, accessors, node baking, material | to build |
| `fw_b64.c` (or static in `fw_gltf.c`) | strict base64 for `data:` URIs | to build |
| `mesh_engine.c` (glue, not pure) | bytes via `ResourceManager_GetBinaryResource`, dispatch by extension, texture via `App_GetTexture`, the log lines (§2.6) | built for OBJ; extend |

### 2.2 Parsers as state machines over a borrowed buffer

The bytes come from `ResourceManager_GetBinaryResource` 0x973750: data `res+0x28`, size `res+0x30`, **borrowed** from
the FileManager cache for the process lifetime (r3dE G13b). Parsing finishes synchronously inside the call that asked
for the model, so the parser **never copies the file** and never needs a streaming reader: "streaming" here means a
single forward pass over `[p, end)` slices with no per-token allocation — Blender's design (BL obj mmaps the whole
file, `IO_string_utils.hh` keeps `(p, end)` pointer pairs because returning slices costs registers on the hot path),
not Godot's (`String::split(" ")` and `split("/")` per face corner, GD obj L316–333).

- **OBJ** (built): one loop per line; a line is `[ls, le)` after stripping `#…` and trailing whitespace; the keyword
  decides the state (`v`/`vt`/`vn`/`f`/ignored/unsupported/unknown). Numbers are parsed by our own locale-free
  `parse_float` (no `strtod`: the game may set a C locale). The output arrays grow by doubling; the corner
  dedup is an open-addressing hash on (v, vt, vn).
- **JSON** (`fw_json.c`): a jsmn-like tokenizer — states `VALUE`, `KEY`, `COLON`, `COMMA_OR_CLOSE`, `STRING`
  (+`ESCAPE`, `UNICODE`), `NUMBER`, `LITERAL` — producing `{type, start, end, size, parent}` tokens (16 B). **Pass 1
  counts tokens with a NULL output; pass 2 fills an array allocated to exactly that count** (one `malloc`, no
  `realloc`). Depth limit 64 (a hostile nesting is an error, not a stack overflow — the tokenizer is iterative, the
  depth limit bounds the parent stack). Strings are not unescaped in the scan; `fw_json_str_eq` compares escaped
  text against a key, `fw_json_str_copy` unescapes on demand (`\uXXXX` → UTF-8; URIs may carry it).
  Lookups (`fw_json_find(obj, "key")`, `fw_json_index(arr, i)`) walk siblings by `size` — O(n) per lookup is fine:
  a prop's JSON is a few KB.
- **glTF** (`fw_gltf.c`): not a state machine of its own but an ordered **validate-then-read** over the token tree,
  in the order a failure is cheapest to report: container → `asset.version` → `extensionsRequired` → (only now)
  buffers → the default scene's node tree → for each mesh instance: primitives → accessors (bounds-checked) → bake;
  then the material of the first primitive. Godot reads buffers before it checks `extensionsRequired` (GD
  gltf_document L7116–7126); we check first, so a Draco file costs no base64 decode.

### 2.3 Memory plan

| Item | Size | Lifetime |
|---|---|---|
| file bytes | borrowed (`BinaryResource`) | process (engine-owned); copy only if a hot-reload must survive (dev feature, G13b) |
| JSON tokens | 16 B × tokens (exact, from pass 1); cap 262 144 tokens = 4 MiB | freed before return |
| decoded `data:` buffers | ¾ × base64 length | freed before return |
| output `FwMeshVertex[]` (32 B) + `uint32_t[]` indices | **exact**: glTF accessor counts are known before decoding, so V = Σ instances × POSITION.count and I = Σ index counts → one `malloc` each | until the GL upload; then freed (the registry keeps counts + bounds + GL names) |
| OBJ arrays | doubling growth (counts unknown up front) | same |

Peak for the budget prop (5 000 triangles, ≤ 15 000 vertices): file + 480 KB vertices + 60 KB indices. Every count
read from the file is **bounded before it sizes an allocation** — by the bytes of its bufferView, or by the caps
below for a view-less (all-zero) accessor. The editor reader had exactly this bug (a `count` of 2e9 aborted V8 before
the bounds check); it is fixed and pinned by a test, and the C reader must keep the same order.

### 2.4 Limits (refuse vs warn) and why

| Limit | Value | Kind | Why |
|---|---|---|---|
| file size | 16 MiB | refuse (`model-limit`) | a prop is 0.05–1 MB; 16 MiB is a misdirected file |
| vertices per model | 1 048 576 (`FW_MESH_MAX_VERTS`) | refuse | built value; a misread count, not a prop |
| indices per model | 3 145 728 (`FW_MESH_MAX_INDICES`) | refuse | same |
| JSON tokens / depth | 262 144 / 64 | refuse | bounds the token array and the parent stack |
| nodes / tree depth / primitives | 1 024 / 64 / 256 | refuse | bounds the recursion and the bake loop |
| models per process | 32 (`FW_MESH_MAX_MODELS`) | refuse the 33rd, log once | built value; fixed array registry |
| texture side | 1 024 px | warn (`model-texture-size`) | no mipmaps (Texture2D: GL_LINEAR, no mip, r3dE G13f): a 1024² texture on a ~100 px prop shimmers; 256–512 is the sweet spot |
| triangles | 5 000 | warn (`model-heavy`) | at the fight zoom a tile is ~100 px wide: 5 000 triangles on ~1 tile is < 2 px² each |
| below floor | h < −0.01 | warn (`model-below-floor`) | origin not at the feet: it sinks into the floor |
| footprint | \|x\| or \|z\| > 0.5 (+0.01) | warn (`model-footprint`) | wider than its tile: overlaps neighbours' sprites (depth, M2) |

### 2.5 The glTF subset — compatibility matrix

`v1` = this phase (M3), `v2` = the next, `v3` = later; **R** = refused with an error, **I** = ignored with a finding,
**✓** = supported. Editor (`gltf-read.ts`) = v1 today.

| Feature | v1 | v2 | v3 | Notes (source) |
|---|---|---|---|---|
| `.glb` (header, JSON chunk, BIN chunk), `.gltf` + `data:` URI, `.gltf` + external `.bin` | ✓ | | | spec §binary-gltf-layout; GLB checks with Blender's words (BL io `load_glb`) |
| GLB `version` ≠ 2, `length` ≠ file size, chunk length % 4 ≠ 0, first chunk not JSON | R | | | Godot ignores version/length (GD `_parse_glb`); Blender refuses (BL io L108–139) |
| unknown GLB chunk types | I | | | spec §chunks: clients MUST ignore them |
| `asset.version` major ≠ 2, `minVersion` > 2.0 | R | | | Godot parses but never checks (GD L7089); Blender wants exactly "2.0" (BL io L84–91); spec: check the major version and `minVersion` |
| `extensionsRequired` (any) | R | R* | R* | *v2 accepts `KHR_materials_unlit`, `KHR_texture_transform`, `KHR_mesh_quantization` when supported |
| `extensionsUsed` | I (info) | | | |
| `KHR_draco_mesh_compression`, `EXT_meshopt_compression` | R | R | R | a decoder library — repo rule: no third-party code |
| scenes / nodes: `scene` (default 0), TRS or `matrix`, children | ✓ baked | | | GD importer_mesh `merge_importer_meshes`; spec §transformations |
| node with det < 0 (negative scale) | ✓ winding reversed | | | spec §transformations: det < 0 ⇒ clockwise; Godot swaps (GD importer_mesh L58, L79+) |
| node cycles, multiple parents | R | | | spec: disjoint strict trees; Godot `ERR_CONTINUE` "node already has a parent" (GD gltf_document L639) |
| several meshes / primitives | ✓ merged | ✓ per-material ranges | | Blender merges a mesh's primitives (BL mesh `do_primitives`) |
| `mode` 4 TRIANGLES | ✓ | | | |
| `mode` 5 / 6 STRIP / FAN | ✓ converted | | | BL mesh `points_edges_tris`; Godot maps FAN to TRIANGLES (a TODO in its table, GD L1492) |
| `mode` 0–3 points / lines | R | | | |
| `POSITION` VEC3 FLOAT | ✓ (required) | | | spec: MUST have min/max (not trusted: bounds are recomputed) |
| `NORMAL` VEC3 FLOAT | ✓ (absent → flat normals, info) | | | |
| `TEXCOORD_0` VEC2 FLOAT / normalized u8 / u16 | ✓ | | | spec §accessor-data-types; decode = GD accessor L657–700 |
| `TEXCOORD_1+`, `TANGENT`, `COLOR_0` | I (info) | `COLOR_0` ✓ | | |
| `JOINTS_n` / `WEIGHTS_n`, `skins` | I (bind pose) | | ✓ | §2.8 |
| morph `targets` | I (base shape) | | ✓ (POSITION only) | their accessors are never decoded, so their sparse data is harmless |
| `animations` | I | | ✓ | §2.8 |
| indices u8 / u16 / u32 | ✓ | | | |
| index ≥ vertex count, index = 255/65535/2³²−1 (restart), count % 3 ≠ 0 | R | | | spec §meshes-overview; Godot's message for % 3 (GD L1524) |
| accessor `byteOffset` / view offset not a multiple of the component size; vertex attribute not 4-aligned | R | | | spec §data-alignment; Godot only WARNs "will try to load it anyway" (GD accessor L625–630) |
| `byteStride` not a multiple of 4, outside 4..252, smaller than the element | R | | | Godot errors on % 4 (GD accessor L636) |
| accessor past its view, view past its buffer | R | | | Godot's `slice` silently clamps (GD buffer_view L113–122) and then fails the size check |
| sparse accessor on a used attribute / indices | R | ✓ | | GD accessor `_decode_as_numbers` L736; Blender writes sparse for shape keys by default (BL export L979) |
| accessor without `bufferView` (all zeros) | ✓ | | | spec; Godot fills zeros (GD accessor L617) |
| `KHR_mesh_quantization` (int positions/normals) | R | ✓ | | |
| material: `baseColorFactor` | ✓ (one material: the first primitive's) | ✓ per primitive | | spec: linear (§2.7) |
| material: `baseColorTexture` → image `uri` (PNG/JPEG) | ✓ via the file convention (§2.7) | | | |
| image in a `bufferView` (GLB-embedded) / `data:` image | I (editor extracts to a file) | ✓ decode in-DLL with the game's stb_image | | Godot's default "Extract Textures" (GD editor_scene_importer_gltf L94–101, `_parse_image_save_image` L2191) |
| `texCoord` ≠ 0 | I (warn) | | | |
| `KHR_texture_transform` | I (warn) | ✓ offset/scale baked into UVs | | Blender emits it for a Mapping node (BL export texture_info L160–164) |
| `alphaMode` OPAQUE / MASK + `alphaCutoff` | ✓ (cut-out `discard`) | | | r3dF gotcha: cut-out only |
| `alphaMode` BLEND | I → drawn as MASK (warn) | | | no translucent mesh sorting |
| `doubleSided` | ✓ (culling off) | | | |
| metallic/roughness, normal/occlusion/emissive, `KHR_materials_*` | I | `KHR_materials_unlit` ✓ | | the palette shader has no PBR |
| WebP / KTX2 sources (`EXT_texture_webp`, `KHR_texture_basisu`) | I (warn) | | | the game links stb_image (PNG/JPEG), r3dE G13e |
| cameras, `KHR_lights_punctual` | I | | | |

### 2.6 Error taxonomy → framework log lines

One code list for both halves. The DLL's `FwMeshError` gains a `const char *code` next to `text`/`line`; the glue
logs **one line per model per process** (a failed model is cached as failed, so a broken file costs one parse and
one line, not one per frame) and the unit keeps drawing its 2D `movieclip` — a broken model is a missing model, never
a crash (the same fail-closed rule as the build gate):

```
mesh: models/crate.glb: model-extension-required: glTF: Can't import file, required extension 'KHR_draco_mesh_compression' is not supported (export without it) — drawing the 2D clip
mesh: models/crate.obj: model-parse-error: face index 7 out of range (3 vertices) at line 4 — drawing the 2D clip
mesh: models/crate.glb: loaded 812 vertices, 1204 triangles, bounds x -0.42..0.42 h 0..0.9 z -0.4..0.4, texture textures/models/crate.png (256x256)
mesh: models/crate.glb: model-texture-missing: textures/models/crate.png not found — drawing the base colour only
```

| Code | Sev. | Meaning (message modelled on) |
|---|---|---|
| `model-parse-error` | E | OBJ syntax (the DLL's words, e.g. "face index 0 is invalid (OBJ indices start at 1) at line 2"); JSON syntax ("glTF: Error parsing .gltf JSON data: …", GD `_parse`) |
| `model-extension` | E | not `.obj` / `.gltf` / `.glb` |
| `model-glb-header` | E | "GLB version must be 2; got N", "Bad GLB: file size doesn't match", "Bad GLB: first chunk not JSON", chunk not 4-aligned (BL io `load_glb`) |
| `model-gltf-version` | E | "Bad glTF: no asset in json", "glTF version must be 2.x; got 1.0" (BL io `check_version`) |
| `model-extension-required` | E | "glTF: Can't import file, required extension 'X' is not supported" (GD `_parse_gltf_extensions`) |
| `model-uri-unsupported` | E | absolute path / `http:` / unknown `data:` type ("glTF: Got buffer with an unknown URI data type", GD `_parse_buffers`) |
| `model-buffer-missing` | E | "glTF: Binary file not found: tri.bin" (GD `_parse_buffers`) |
| `model-buffer-range` | E | "glTF import: The buffer view size was smaller than the minimum required size for the accessor" (GD accessor L647) + the numbers |
| `model-accessor-invalid` | E | bad componentType / type / count, alignment ("MUST be a multiple of the size of the accessor's component type", spec), stride ("The declared buffer view byte stride N was not a multiple of 4", GD accessor L636), dangling indices |
| `model-sparse-unsupported` | E | a used accessor is sparse (v1) |
| `model-primitive-mode` | E | points / lines |
| `model-attribute-missing` / `model-attribute-format` | E | no POSITION; POSITION not VEC3 FLOAT (quantized) etc. |
| `model-index-range` | E | index ≥ vertices, restart value, "Indexed triangle meshes MUST have an index array with a size that is a multiple of 3, but got N indices." (GD L1524) |
| `model-node-invalid` / `model-node-cycle` | E | dangling node / mesh / scene index; a cycle or a second parent |
| `model-empty` | E | no node of the default scene has a mesh; "no faces" (OBJ) |
| `model-limit` | E | a cap of §2.4 |
| `model-multi-material` | W | > 1 material in use: v1 draws all with the first |
| `model-ngon-concave` | W | OBJ n-gon the fan will draw wrong (Blender would re-triangulate with CDT, BL obj `fixup_invalid_face`) |
| `model-skin-ignored` / `model-animation-ignored` / `model-morph-ignored` | W | v1 skips them |
| `model-texcoord-set` / `model-texture-transform-ignored` / `model-alpha-blend` / `model-image-format` | W | material features v1 cannot honour |
| `model-texture-no-uvs` | W | a texture but no TEXCOORD_0 |
| `model-heavy` / `model-below-floor` / `model-footprint` | W | §2.4 budgets |
| `model-texture-missing` / `model-texture-format` / `model-texture-size` | W | the PNG the engine would load is absent / grey-only (GL_LUMINANCE, invalid in a core profile, r3dE G13f) / > 1024 |
| `model-no-normals` / `model-texture-embedded` / `model-mtl-ignored` / `model-extension-ignored` / `model-attribute-ignored` | I | the engine fills in (flat normals) or the editor handles it (texture extraction) |

The editor keeps the mesh lead's path/file codes as they are (`model-path-invalid`, `model-file-missing`,
`model-unregistered`, `editor/src/core/validate/validator.ts` on `feat/3d-meshes-api`) and adds the codes above by
running `readModel` over the file the path names.

### 2.7 Axes, units, origin, depth, textures

- **Axes.** glTF is right-handed, +Y up, front faces +Z, metres (spec §coordinate-system-and-units). Blender is Z-up;
  its exporter's "+Y Up" (BL export L673, default on) converts with a **rotation** (det +1; the importer's inverse is
  `(x, −z, y)`, BL blender_gltf L72). The game's world `(x, height, z)` is **left-handed** (r3dF F2; the observer's
  ISO columns x → (0.894, 0.447), h → (0, 1), z → (−0.894, 0.447) pinned in
  `editor/test/fixtures/ingame/observe3d-log.txt`). So import is a **reflection**: `x_g = s·x, h = s·y, z_g = −s·z`,
  normals mirrored the same way, **every triangle's index order reversed** (det −1 flips winding: the rule Godot
  applies in `merge_importer_meshes` for det < 0). Built as `fw_mesh_to_game_axes`; the editor's `toGameAxes` is the
  same. Face culling then follows `sign(det(mvp))` at draw time, because the game's VP already has det < 0 (the
  observer: `det < 0`, flip −1) — never a hard-coded `glFrontFace`. No "up axis" import option: glTF fixes +Y up, and
  Godot offers none for glTF either (only `nodes/root_scale`, GD scene import L2642).
- **Facing.** A model's front (glTF +Z, Blender −Y = what Blender's Front view shows) becomes game −z, which the
  vanilla camera draws toward the **lower right** of the screen. The GON `yaw` (§3.2) turns it.
- **Units and scale.** 1 game world unit = 1 tile (K19); 1 Blender metre = 1 glTF metre = 1 tile at `scale 1`. A
  vanilla sprite's height is squashed to 0.913 of a physical iso height (r3dF F2); meshes go through the same VP, so
  they get the same squash and stand next to sprites consistently. Unit scale in Blender scenes with a non-1
  `scale_length` is handled by the exporter (BL blender_gltf L68 is the importer's mirror of it).
- **Origin.** The model's origin is the anchor: the tile centre on the floor (`FW_Place3DObjectOnTile`) or the unit's
  position. Origin at the feet; `model-below-floor` warns otherwise.
- **Depth (M2, INFERRED until M2 lands).** Sprites get depth from `Renderer_GetScreenMatrix` m14 = the view-depth key
  scaled into the ±10 000 window (K5); meshes must use **the same affine depth function** of world position, applied
  per vertex in `fw_mesh.shader`, or they will not interleave with sprites. A model stays within ~1 tile of its
  anchor (`model-footprint`), so its depth span is a small slice of the window; a board diagonal of ~40 tiles at
  ≤ 250 depth units per tile fits ±10 000.
- **UVs.** glTF's uv origin is the top-left of the image (spec §texture-data); the game uploads PNGs top row first
  (stb_image, `Texture2D_LoadFromFile` 0xa0ad40, no vertical flip seen — INFERRED). So glTF uvs are used as is, and
  **OBJ `vt` v is flipped (`v' = 1 − v`)** because OBJ's origin is bottom-left — Godot does exactly this (GD obj
  L305) and Blender does the reverse for glTF (BL mesh `uvs_gltf_to_blender`, since Blender's own origin is
  bottom-left). `obj-read.ts` flips; **the DLL's `fw_mesh_obj_parse` does not yet** (it copies `vt` as is) — harmless
  until a texture is sampled, required before M3 textures (§5).
- **Textures (v1).** Through the game: `App_GetTexture` 0x9bb490 (`std::string name`) loads `"textures/" + name` with
  stb_image, premultiplied RGBA, GL_LINEAR, GL_REPEAT, no mipmaps, cached forever — and **dereferences a missing file**
  (r3dE G13f). So: check `FileManager_FileExists` 0x9a14c0 on `"textures/" + name` first; ship RGB / RGBA PNGs only
  (grey PNGs become GL_LUMINANCE, invalid in a core context); the shader treats the texel as **premultiplied**
  (the glTF spec says stored texels are not premultiplied — the game premultiplies on load, so un-premultiply is
  never needed, but blending must use `ONE, ONE_MINUS_SRC_ALPHA` and the cut-out compares `a`). Which file: the GON
  `texture` key (§3.2), else the convention `textures/models/<model name>.png` when it exists, else none (base
  colour only, `model-texture-missing` once if the material named a texture). The glTF image itself is **not** read
  by the v1 DLL: for a `.glb` the editor extracts it to that conventional path (Godot's import-time "Extract
  Textures" mode, GD L2191), for a separate `.gltf` the owner copies the PNG there. v2: decode embedded images in the
  DLL through the game's statically linked stb_image memory loader (0xa7c960, r3dE G13e — needs a manifest entry
  and a signature) and upload with our own `glTexImage2D`, so a `.glb` is self-contained.
- **Colour.** `baseColorFactor` is linear (spec §texture-data: "the factor value acts as a linear multiplier"; the
  base colour texture is sRGB-encoded). The game shades in gamma space (its sprites and `palette.png` are used as
  stored). v1 rule: **convert the factor to sRGB once at load** (`c^(1/2.2)`, or the exact sRGB OETF) so the colour
  the owner picked in Blender's colour picker (displayed in sRGB) is the colour drawn; sample the texture as stored.
  A grey result (r = g = b within .001) is a palette index in `fw_mesh.shader` (`paletted_full.shader`'s rule), so a
  grey base colour is recoloured per palette — wanted for cat-coloured props, avoidable with `palette false` (§3.2).

### 2.8 Skins and animation later (v3 sketch, not v1)

Skins: Godot's `SkinTool::_determine_skeletons` (GD skin_tool L298) groups joints into skeletons and re-parents
non-joint subtrees — needed for an engine with a skeleton node type, not for us. Plan: CPU skinning in the functor
(`JOINTS_0` / `WEIGHTS_0`, ≤ 4 influences, ≤ 64 joints, weights renormalised as Godot does after decode,
GD gltf_document L1664 and L1701; the inverse bind matrices accessor MAT4 FLOAT; joint world matrices from the node tree
evaluated per frame), uploading the skinned VBO with `glBufferSubData` — a 5 000-triangle prop is ~15 000 vertices,
trivial on the CPU. Animations: `TRS` channels on joint/mesh nodes, `LINEAR` / `STEP` (quaternion slerp), `CUBICSPLINE`
later; sampled by a clock the native mod drives (an API like `FW_Set3DObjectAnimation(handle, name, t)`), because
a GON key has no notion of time. Morph targets: POSITION deltas only. Until then v1 draws the bind pose and the
editor warns (`model-skin-ignored`, `model-animation-ignored`, `model-morph-ignored`).

## 3. Editor side (TypeScript)

### 3.1 Readers (built in this PR)

- `editor/src/core/art/model-read.ts` — the shared types (`TriMesh`, `ModelRead`, `ModelFinding`, `ModelMaterial`),
  `readModel(relPath, bytes, resolve?)` (dispatch by extension, 16 MiB cap), `toGameAxes`, `meshBounds`,
  `isoProject` (the observer's ISO columns), `isoWireframeSvg` (a wireframe of the game-axes mesh over its tile's
  diamond, bounds in the `<title>` — a string, no DOM, so the web UI, the MCP server and a T3 card can all show it),
  `modelBudgetFindings` (`model-heavy`, `model-below-floor`, `model-footprint`), `MODEL_LIMITS`.
- `editor/src/core/art/obj-read.ts` — the DLL's OBJ subset with **the DLL's error words** (copied from
  `fw_mesh_rules.c`, so the validator and the engine reject with the same sentence), plus editor-only findings:
  `model-multi-material` (second distinct `usemtl`), `model-ngon-concave` (convexity per n-gon on its dominant
  plane), `model-no-normals`, `model-mtl-ignored`. `vt` v flipped (§2.7).
- `editor/src/core/art/gltf-read.ts` — the v1 subset of §2.5 and the codes of §2.6. Node trees are baked
  (`matrix` or TRS, normals by the inverse-transpose, det < 0 → triangles reversed), strips/fans converted, all
  primitives merged; materials returned per primitive (`primitiveMaterials`) with the texture as a `uri` or the
  embedded bytes + `mimeType`. No Node `Buffer` (own strict base64), so it also runs in the browser.
- Tests: `editor/test/model-read-tests.ts` (34 tests): every fixture is **synthetic**, built in the test from numbers
  and shaped like a Khronos sample model — `Triangle` / `TriangleWithoutIndices` (u8/u16/u32 indices, data URI vs
  .glb, generated indices), `Box` (the root `matrix` that turns the model −90° about X: baking must rotate the +Z
  face to +Y), `BoxInterleaved` (byteStride 32), `BoxTextured` (factor + `uri`), `SimpleMeshes` (one mesh, two nodes),
  `SimpleSparseAccessor` (sparse refused on POSITION, harmless inside morph targets). No sample file enters git (they
  are CC-BY 4.0 with attribution files; synthesising them keeps the repo's "no third-party bytes" line clean). Plus a
  seeded 3 000-mutation fuzz guard (GLB, .gltf, OBJ: no throw, every read ends in a mesh or an error, no index past
  the vertex count) and the hostile-count regression.

### 3.2 The GON `model` value: string now, block next

The mesh lead's v1 (on `feat/3d-meshes-api`) is a string inside `graphics`:
`graphics { movieclip Crate  model "models/crate.obj" }` (or `"@Name"` for a native-registered model). Keep it. The
next step allows a **block** in the same key, so one `.merge` still touches one key and the string form stays valid:

```
graphics {
    movieclip Crate                      // the 2D fallback (vanilla launches, unknown build, a model that failed)
    model {
        file "models/crate.glb"          // required: models/<...>.obj|.gltf|.glb (or "@Name")
        scale 1.0                        // uniform, > 0; 1 = 1 Blender metre per tile
        yaw 0                            // degrees about the height axis (0 = front toward the lower right)
        offset [0 0 0]                   // game axes (x, height, z), tiles, after scale and yaw
        texture "models/crate.png"       // under textures/ (App_GetTexture's prefix); default textures/models/<name>.png
        tint [1 1 1 1]                   // multiplies the base colour (sRGB space)
        palette true                     // grey = palette index (fw_mesh.shader); false = colours as authored
        double_sided false               // overrides the material's doubleSided
    }
}
```

Validator rules for the block (to add once `feat/3d-meshes-api` is merged, in its `checkModel`): `file` →
the existing path rule + `readModel` findings; `scale` a number > 0 (`model-scale`, error); `yaw` a number
(`model-yaw`, error; warning when not a multiple of 45 — the iso view's natural steps); `offset` 3 numbers
(`model-offset`, error); `texture` exists under `mods/<mod>/textures/` and is an RGB/RGBA 8-bit PNG ≤ 1024²
(`model-texture-missing` / `model-texture-format` / `model-texture-size`); unknown keys (`model-key-unknown`,
warning). Native: `fw_gon_model` returns the string today; a `fw_gon_model_block` walker reads the block with the
same GonObject offsets (host-tested by `test_gon.c` like the string form). Godot's per-file import options
(`nodes/root_scale`, `scale_mesh`/`offset_mesh` for OBJ, GD obj L648–649) are the model for `scale` / `offset`; there
is deliberately no "up axis" option (glTF fixes it; OBJ follows Blender's export default, Y up, −Z forward).

### 3.3 Wiring (next, once the mesh branches merge)

1. `validator.ts` `checkModel`: after the path/file checks pass, read the file and `readModel(rel, bytes, resolve)`
   with `resolve` confined to the mod folder; report its findings at `<Entry>.graphics.model`; then
   `modelBudgetFindings(toGameAxes(mesh, scale))`; then the texture rules.
2. MCP: `read_model { mod, path }` → stats, bounds, findings and the wireframe SVG (r3dF §5 "optional later").
3. `extract_model_texture { mod, path }`: write a `.glb`'s embedded PNG to `mods/<mod>/textures/models/<name>.png`
   (refuses to overwrite; the editor's write guard keeps it inside `mods/<mod>/`).
4. Web UI: the wireframe card next to the model key (Data mode), with the findings.

## 4. Test fixtures to mirror (synthetically) for the C suite

`test_gltf.c` should build the same shapes as `model-read-tests.ts` from C arrays (`make_glb(...)`, r3dF §1) so the
two readers stay comparable case by case: Triangle (u16 indices, view 0 indices / view 1 positions — the sample's own
layout), TriangleWithoutIndices, Box (the −90° X root matrix + child mesh), BoxInterleaved (stride 32),
BoxTextured (factor + texture uri), SimpleMeshes (two nodes, one mesh), SimpleSparseAccessor (sparse POSITION →
refused), plus the error cases of §2.6 one by one and a seeded mutation loop under the host sanitizers.
Sample models at the pinned commit for a human cross-check: [Triangle](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/15cd02d304e54cb42a4db4eefe719f76190f4b68/Models/Triangle), [TriangleWithoutIndices](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/15cd02d304e54cb42a4db4eefe719f76190f4b68/Models/TriangleWithoutIndices), [Box](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/15cd02d304e54cb42a4db4eefe719f76190f4b68/Models/Box), [BoxInterleaved](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/15cd02d304e54cb42a4db4eefe719f76190f4b68/Models/BoxInterleaved), [BoxTextured](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/15cd02d304e54cb42a4db4eefe719f76190f4b68/Models/BoxTextured), [SimpleMeshes](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/15cd02d304e54cb42a4db4eefe719f76190f4b68/Models/SimpleMeshes), [SimpleSparseAccessor](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/15cd02d304e54cb42a4db4eefe719f76190f4b68/Models/SimpleSparseAccessor); later [SimpleSkin](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/15cd02d304e54cb42a4db4eefe719f76190f4b68/Models/SimpleSkin) and [AnimatedTriangle](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/15cd02d304e54cb42a4db4eefe719f76190f4b68/Models/AnimatedTriangle) for v3, and [TextureCoordinateTest](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/15cd02d304e54cb42a4db4eefe719f76190f4b68/Models/TextureCoordinateTest) for the uv origin (a T2/T3 shot).

## 5. For the mesh lead — deltas against what is built (`feat/3d-meshes-m1`)

1. **OBJ `vt` flip** (`v' = 1 − v`) in `fw_mesh_obj_parse` before textures are sampled; `obj-read.ts` already does it
   and its test pins it.
2. **Model path rule mismatch:** `mesh_engine.c` loads through `fw_mesh_model_path` (exactly `models/<name>.obj`, no
   sub-folder), while the GON / validator rule (`fw_obj3d_model_path_ok`, `editor/src/core/model3d.ts`) accepts
   `models/props/tire.obj` — a sub-folder model validates clean and then never loads. One rule for both; also extend it
   to `.gltf` / `.glb`.
3. `FwMeshError` gains a `code` (§2.6) and the glue logs one line per model with the code, then caches the failure.
4. `fw_json.c` + `fw_gltf.c` per §2.2–2.5; counts bounded before any allocation (§2.3).
5. Texture: `FileManager_FileExists` before `App_GetTexture`; factor → sRGB at load; premultiplied blending (§2.7).
