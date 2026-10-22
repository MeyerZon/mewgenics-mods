// The particle content model a data mod writes (docs/data-mods.md "Particles and VFX"; docs/engine-map.md
// "Particle systems"). Two separate systems carry "particles" in Mewgenics:
//  1. particle SYSTEMS — named entries of data/particles.gon (3D, combat) and data/particles2d.gon (2D scenes),
//     decoded by `glaiel::decode(const GonObject&) -> ParticleSystemData` (funcsig string 0x112f1b0, Particles.cpp)
//     and instantiated by ParticleCore; each system emits copies of one SWF clip (`movieclip`). Referenced by name from
//     EliteParticle (a passive: a permanent aura on the unit), ParticleBurst, global_particles (tilesets.gon),
//     particles (house_weather.gon / weather.gon), FormChangeOnElementInfluence.particle, and from other systems
//     through combo / chain.
//  2. ability EFFECT CLIPS — the graphics block of an ability names SWF clips directly (effects.swf: PoisonPoof,
//     HealMed, Explosion, …; projectiles: NeedleProjectile, …) played as one-shot animations (SpellParticle).
// Neither has a colour key: the colour is the clip's own art (and its cxform / alpha curve).

/** Curve keys: each reads X (constant or [min max]) and the X_start / X_end / X_in / X_out shapes. */
export const PARTICLE_CURVE_KEYS = ["size", "alpha", "speed", "friction", "force", "rotation", "rotation_speed"] as const;
export const PARTICLE_CURVE_SUFFIXES = ["", "_start", "_end", "_in", "_out"] as const;

/**
 * Every system-level key the game reads, besides the curve keys: the decoder 0x9c5970 (movieclip … speed_scale, tags),
 * the loader 0x9c88d0 (combo), the scripts reader 0x9c9810 (scripts), the renderer side (depth_bias 0xa55470; unlit,
 * is_3D INFERRED) and the GON file loader (variant_of, INFERRED). docs/engine-map.md "Particle systems".
 */
export const PARTICLE_PLAIN_KEYS = [
  // the clip and how it is drawn
  "movieclip", "movieclip_timescale", "material", "unlit", "depth_bias", "render_mode", "render_layer", "projection_matrix",
  // simulation
  "simulation_space", "ownership", "update_mode", "max_particles", "adaptive_growth", "flat_movement", "is_3D", "live_bounds",
  "particle_lifetime", "face_moving_direction", "speed_scale", "inherit_speed", "towards", "ease_in", "ease_out",
  // emission
  "emit_rate", "emit_amount", "emit_direction", "emit_spread", "emit_box", "emit_radius", "emit_shell", "emitshape_scale",
  "emit_timespread", "emit_timespread_curve", "spurt", "tags",
  // composition
  "combo", "chain", "chain_chance", "variant_of", "scripts",
] as const;

/** Keys vanilla writes that nothing reads: no such string exists in the exe (OBSERVED 2026-10-22). */
export const PARTICLE_DEAD_KEYS = ["continual_emission"] as const;

const KEYS = new Set<string>([...PARTICLE_PLAIN_KEYS, ...PARTICLE_CURVE_KEYS.flatMap((c) => PARTICLE_CURVE_SUFFIXES.map((s) => c + s))]);

/** Is `key` a key the particle system decoder reads at the system level? */
export function isParticleKey(key: string): boolean {
  return KEYS.has(key);
}

/** Script components a system's `scripts { … }` block may name (init_custom_particle_scripts). */
export const PARTICLE_SCRIPTS = ["ParticleBouncePlane", "ParticleAttractor", "ParticleGlobalForce", "ParticleCharacterCollision", "ParticleRandomForce", "ParticleLineCollisions", "ParticleTornadoForce"] as const;

/** Keys (outside particles.gon) whose value names a particle SYSTEM; arrays name one per item. */
export const PARTICLE_REF_KEYS = ["EliteParticle", "ParticleBurst", "global_particles", "particles", "combo", "chain"] as const;

/** Keys of an ability's `graphics` block whose value names an SWF CLIP (one-shot effect or projectile). */
export const ABILITY_CLIP_KEYS = ["particle", "affected_particle", "center_particle", "area_particle", "miss_particle", "projectile"] as const;

/** `none` / `None` (and an empty string) mean "no effect" wherever a particle or clip name goes. */
export function isNoneName(s: string): boolean {
  return s === "" || s.toLowerCase() === "none";
}

/** Projectile values that are not clip names (the weapon's own art). */
export const NON_CLIP_PROJECTILE_VALUES = ["source_weapon"] as const;
