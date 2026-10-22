// Synthetic stand-in for the game's std_in.shader (hand-written; not game bytes). The validator only checks that
// an #include "std_in.shader" resolves against this base shaders dir.
#if COMPILING_VERTEX_PROGRAM
    in vec2 position;
    in vec4 color;
    in vec4 texcoord;
    uniform mat4 mvp;
#endif
