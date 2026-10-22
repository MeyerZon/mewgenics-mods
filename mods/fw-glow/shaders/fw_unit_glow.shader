#version 150
#include "std_in.shader"
// fw_unit_glow: the composite of mewframework's per-unit glow (native/framework/src/glow_engine.c, API v4).
// Same frame as the game's composite_glow.shader (a full-screen pass on the main camera at the composite layer,
// `framebuf` = the combat outline mask camera's texture), but the rim is computed here instead of by the game's blur
// chain. The mask layer's "flat" draw mode multiplies the sprite by white, so the mask's rgb is the sprite's own
// luminance (black outlines are 0) — the coverage to outline is the mask's ALPHA (cleared to 0 around the units).
// A pixel outside the masked units whose neighbourhood within glow_radius texels holds a masked pixel gets
// glow_color, fading with the distance; inside the units the band is zero, so the sprite keeps its own pixels.
uniform sampler2D framebuf;
uniform float glow_radius;
uniform vec4 glow_color;

struct vertex {
    vec4 color;
    vec4 texcoord;
};

#if COMPILING_VERTEX_PROGRAM
    out vertex v;

    void vert(){
        v.color = color;
        v.texcoord = texcoord;
        gl_Position = mvp * vec4(position.xy, 0.0, 1.0);
    }
#elif COMPILING_FRAGMENT_PROGRAM
    in vertex v;
    out vec4 frag_color;

    void frag(){
        vec2 texSize = vec2(textureSize(framebuf, 0));
        float here = texture(framebuf, v.texcoord.xy).a;
        float best = 0.0;
        // 16 directions x 3 rings: the nearest masked ring wins, farther rings fade
        for (int i = 0; i < 16; i++) {
            float a = 6.28318530718 * float(i) / 16.0;
            vec2 dir = vec2(cos(a), sin(a)) / texSize;
            for (int k = 1; k <= 3; k++) {
                float r = glow_radius * float(k) / 3.0;
                float s = texture(framebuf, v.texcoord.xy + dir * r).a;
                best = max(best, s * (1.0 - 0.3 * float(k - 1)));
            }
        }
        float rim = clamp(best - here, 0.0, 1.0);
        frag_color = vec4(glow_color.rgb, rim * glow_color.a);
    }
#endif
