#version 150
// a mod shader that includes a base shader and a library of its own mod
#include "std_in.shader"
#include "fx_lib.shader"
uniform vec4 tint;

#if COMPILING_VERTEX_PROGRAM
    out vec4 v_color;
    void vert(){
        v_color = color;
        gl_Position = mvp * vec4(position.xy, 0.0, 1.0);
    }
#elif COMPILING_FRAGMENT_PROGRAM
    in vec4 v_color;
    out vec4 frag_color;
    void frag(){
        frag_color = fx_scale(v_color) * tint;
    }
#endif
