#version 150
uniform mat4 xf;
#if COMPILING_VERTEX_PROGRAM
    in vec3 position;
    in vec3 a_normal;
    out vec3 v_n;
    void vert(){ v_n = a_normal; gl_Position = xf * vec4(position, 1.0); }
#elif COMPILING_FRAGMENT_PROGRAM
    in vec3 v_n;
    out vec4 frag_color;
    void frag(){ frag_color = vec4(v_n, 1.0); }
#endif
