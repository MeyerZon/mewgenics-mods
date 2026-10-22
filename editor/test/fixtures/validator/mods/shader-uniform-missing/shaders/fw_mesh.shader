#version 150
// a broken fw_mesh.shader: fw_bands is not declared and palette has the wrong type (the native side sets an int)
uniform mat4 fw_mvp;
uniform mat4 fw_model;
uniform vec3 fw_light_dir;
uniform float fw_ambient;
uniform vec4 fw_base_color;
uniform sampler2D palettemap;
uniform float palette;
uniform int fw_flat;
uniform vec4 fw_cx_mul, fw_cx_add;
uniform sampler2D fw_tex;
uniform int fw_has_tex;
#if COMPILING_VERTEX_PROGRAM
    in vec3 position;
    void vert(){ gl_Position = fw_mvp * vec4(position, 1.0); }
#elif COMPILING_FRAGMENT_PROGRAM
    out vec4 frag_color;
    void frag(){ frag_color = fw_base_color * fw_cx_mul + fw_cx_add; }
#endif
