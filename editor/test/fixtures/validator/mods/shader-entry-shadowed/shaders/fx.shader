#version 150
// the entry point is void vert() below — this comment holds the first " vert()" and steals the rename
#include "std_in.shader"
#if COMPILING_VERTEX_PROGRAM
    void vert(){ gl_Position = mvp * vec4(position.xy, 0.0, 1.0); }
#elif COMPILING_FRAGMENT_PROGRAM
    out vec4 frag_color;
    void frag(){ frag_color = vec4(1.0); }
#endif
