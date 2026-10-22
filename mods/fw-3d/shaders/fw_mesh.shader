#version 150
// fw_mesh: mewframework's mesh shader (3D phase M, docs/possible_3d_work.md). The game compiles it like its own
// shaders (glaiel::Shader::compile 0xa55470): the entry points below are renamed to main() per stage and the
// COMPILING_* guards become 1/0. Self-contained on purpose: no #include (std_in.shader declares `in vec2 position`,
// which would clash with the vec3 position here).
//
// Contract with the native side (editor/src/core/shader/dialect.ts FW_MESH_UNIFORMS / FW_MESH_ATTRIBUTES pin it):
//   material   ShaderManager_GetOrCreateMaterial(mgr, "fw_mesh", "fw_mesh.shader"); Material_Bind inside the replayed
//              draw functor; uniforms with glUniform* on the program *(int*)(*(Material+0x18)+8) by
//              glGetUniformLocation (an unused uniform may be optimised out: location -1, glUniform* is a no-op).
//   attributes the engine calls glBindAttribLocation by NAME before linking every program (position 0, color 1,
//              texcoord 2), so these names give the mesh VBO (stride 32) exactly:
//                location 0  position  vec3  model-space position  (offset 0)
//                location 1  color     vec3  model-space NORMAL    (offset 12)
//                location 2  texcoord  vec2  uv                    (offset 24)
//   uniforms   fw_mvp        mat4   canvas ortho x world VP x model, column-major (transpose GL_FALSE)
//              fw_model      mat4   world from model, for normals (uniform scale only)
//              fw_light_dir  vec3   world, toward the light (normalised again here)
//              fw_ambient    float  shade floor, 0..1
//              fw_bands      float  lighting bands; 0 = smooth Lambert
//              fw_base_color vec4   the mesh colour; grey (r=g=b within .001) = a palette index like cat art
//              palettemap    sampler2D the game's palette.png (16 x 256): set the sampler's texture unit
//              palette       int    palette row; < 0 = no remap
//              fw_flat       int    1 = output fw_base_color unlit and untransformed (the M1 probe)
//              fw_cx_mul/fw_cx_add vec4  colour transform (identity = (1,1,1,1) / (0,0,0,0))
// Depth is left fixed-function: the sprites' bias_depth() writes gl_FragCoord.z - depth_bias * .001, which with no
// bias is the fixed-function value, and not writing gl_FragDepth keeps early depth testing.

uniform mat4 fw_mvp;
uniform mat4 fw_model;
uniform vec3 fw_light_dir;
uniform float fw_ambient;
uniform float fw_bands;
uniform vec4 fw_base_color;
uniform sampler2D palettemap;
uniform int palette;
uniform int fw_flat;
uniform vec4 fw_cx_mul;
uniform vec4 fw_cx_add;

#if COMPILING_VERTEX_PROGRAM
    in vec3 position;
    in vec3 color; // carries the normal
    in vec2 texcoord;
    out vec3 v_normal;
    out vec2 v_uv;

    void vert(){
        v_normal = mat3(fw_model) * color;
        v_uv = texcoord;
        gl_Position = fw_mvp * vec4(position, 1.0);
    }

#elif COMPILING_FRAGMENT_PROGRAM
    in vec3 v_normal;
    in vec2 v_uv;
    out vec4 frag_color;

    void frag(){
        if (fw_flat != 0) {
            frag_color = fw_base_color;
            return;
        }
        vec4 c = fw_base_color;
        float len = length(v_normal);
        vec3 n = len > 0.0 ? v_normal / len : vec3(0.0, 1.0, 0.0);
        float l = max(dot(n, normalize(fw_light_dir)), 0.0);
        if (fw_bands > 0.0) l = floor(l * fw_bands + 0.5) / fw_bands;
        float shade = clamp(fw_ambient + (1.0 - fw_ambient) * l, 0.0, 1.0);

        // the paletted_full.shader rule: a grey colour is a palette index (column round(grey * 15), row `palette`);
        // lighting moves the index along the ramp instead of darkening the looked-up colour
        vec3 rgb = c.rgb * shade;
        bool grey = abs(c.r - c.g) < .001 && abs(c.r - c.b) < .001;
        if (grey && palette >= 0) {
            rgb = texelFetch(palettemap, ivec2(int(clamp(c.r * shade, 0.0, 1.0) * 15.0 + 0.5), palette), 0).rgb;
        }
        frag_color = vec4(rgb, c.a) * fw_cx_mul + fw_cx_add;
    }

#endif
