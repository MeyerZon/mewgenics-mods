#version 150
// Synthetic stand-in for a base shader name (hand-written). A mod shipping shaders/default.shader replaces it.
#include "std_in.shader"
#if COMPILING_VERTEX_PROGRAM
    void vert(){ gl_Position = mvp * vec4(position, 0.0, 1.0); }
#elif COMPILING_FRAGMENT_PROGRAM
    out vec4 frag_color;
    void frag(){ frag_color = vec4(1.0); }
#endif
