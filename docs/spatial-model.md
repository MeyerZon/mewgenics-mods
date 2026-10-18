# Mewgenics spatial / coordinate model

## Verdict

**The game world is strictly 2D.** Gameplay happens on a single flat tile grid indexed by an
integer 2D coordinate (`iVec2D` = col,row). There is **no real built-in third gameplay dimension**:
nothing in targeting, range, line-of-sight, cover, movement, pathfinding, knockback or AOE consults a
height/elevation/Z axis. The engine does have a `Vec3D` type and an `float`/arc "height" parameter,
but those are confined to **rendering and visual arcs** (where a thrown/knocked-up sprite draws its
parabola, where a UI floater sits, particle spawns) — logically every such move is still tile→tile on
the 2D grid. "Flying" is a boolean trait, not an altitude; "layers" are object-category channels
(tiles/characters/pickups/gas), not stacked vertical levels; "jump"/"lob" are 2D repositions with an
animated hop.

> Scope: this is a **static-only** analysis. No live decompiler / debugger session was run (another
> agent held the Ghidra container). Evidence is from the exe's RTTI/symbol inventory
> (`.analysis/list_names.tsv`), already-decompiled functions (`.analysis/decompiled/`), the engine map,
> and read-only game data (`.extracted/data/**`, mirrors of `resources.gpak`). Nothing was executed and
> no bytes were modified. Claims are tagged **OBSERVED** (seen directly in symbols/data),
> **INFERRED** (reasoned from naming/usage without running code), or **COMMUNITY-SOURCED**.

---

## 1. Core math types

- **OBSERVED** — The pervasive coordinate type is a **2D vector**: `Vec2D` (float) and `iVec2D`
  (integer). `iVec2D` appears in **764** symbol lines and is the type threaded through essentially
  every grid/tactics API (see §2). The grid's bulk container is `glaiel::CustomVectorInterface<iVec2D, …>`.
- **OBSERVED** — A `Vec3D` type **does exist**, but appears in only **82** symbol lines, all in a
  narrow set of *visual* subsystems, never as a tile coordinate (detailed in §3): projectile/lob spawn,
  UI floaters, particle/animation test scenes. Examples of its signatures:
  - `glaiel::Projectile::init(Ability*, string, Vec2D, iVec2D, GonObject const&, Vec3D, function<void(int64)>)`
    — note the **gameplay target is `iVec2D`**; the `Vec3D` is a separate (visual) spawn position.
  - `glaiel::SpawnProjectileSimple(Scene*, string, iVec2D, Vec3D, DamageInstance&, GonObject const&)`
  - `glaiel::LobNewCharacter(Character*, iVec2D, Vec3D, TurnControl::SpawnIn)` /
    `glaiel::LobExistingCharacter(Character*, iVec2D, Vec3D, bool, double)` — throw-to-tile + a `Vec3D`.
  - `glaiel::Character::VirtualUIFloaterPosition(bool) -> Vec3D` — position of floating UI text.
  - lambdas returning `Vec3D` in `ParticleTest::init`, `AnimationTest::init`, `TacticsTest::init`.
- **OBSERVED** — The only engine matrix type is **`glaiel::swf::Matrix3x2`** — a **2D affine** (2×3)
  transform. There is **no** engine `Matrix4x4`, no quaternion, no perspective/ortho/look-at/FOV
  helper. A grep for `glaiel::*Perspective|*ortho|*fov|lookat|view_matrix|viewproj` returns nothing.
- **OBSERVED (clarified)** — Hits for `Matrix4`, `Frustum`, `Projection`, `glMatrixOrthoEXT`,
  `uniform mat4 u_projection`, etc. are **OpenGL loader entry-point strings and a shader uniform**, not
  engine types. The whole GL API string table is present because SDL's GL loader is statically linked
  (consistent with the engine map's note that SDL is linked whole). `mat4 u_projection` is the standard
  2D **orthographic** projection a 2D GL renderer uses to map screen coords to clip space — not a 3D scene.
- **OBSERVED** — `glaiel::Camera` exists but is a **2D render camera**: its only real methods are
  `bind_render_target_texture(int)`, `push_scissor()`, `pop_scissor()` (render-to-texture + rectangular
  scissor clipping). No projection/view/FOV method. (Most "Camera" symbols in the exe are SDL's
  *webcam* API: `SDL_OpenCamera`, `SDL_AcquireCameraFrame`, …) A `VerticalCameraPanner` string implies
  the 2D view simply pans/scrolls over a tall 2D map.

**Takeaway:** the math toolkit is a 2D affine toolkit. `Vec3D` is a render-space convenience, not a
world coordinate.

---

## 2. Entity / world position & the tile grid

- **OBSERVED** — Tactics entities move and are located by **2D integer tile coords (`iVec2D`)**. All of
  these take `iVec2D`:
  - `glaiel::TacticsObject::Move(iVec2D, bool, bool)`
  - `glaiel::DisplacementManager::DisplaceCharacterTo(Character*, iVec2D, BlockedBehavior, double, …)`
  - `glaiel::TacticsGrid::closest_enemy(iVec2D, Character*)`,
    `closest_open_tile(CustomVectorInterface<iVec2D,…>, …)`,
    `nearest_open_tile_opposite_side_of_hit(TacticsObject*, iVec2D, iVec2D, int, TacticsLayer)`
  - `glaiel::Character::Face(iVec2D, bool, bool)`, `glaiel::Character::AddAuras(iVec2D)`
  - AOE/targeting: `Ability::TargetIsValid(iVec2D, iVec2D)`, `Ability::AOETileIsValid(iVec2D,iVec2D,iVec2D)`,
    `Ability::do_aoe_spell_effect(iVec2D,iVec2D,iVec2D)`, and every `construct_on_projectile_hit_callback(iVec2D,iVec2D,iVec2D)`.
- **OBSERVED** — `Character`/`TacticsObject` expose no `GetX/GetY/GetZ/height/elevation` out-of-line
  symbol; position accessors are header-inlined. There is **no `z`/`height`/`elevation`/`altitude`
  field name** anywhere in `glaiel::` symbols (grep returns nothing).
- **OBSERVED** — Tiles carry a single `tile_layer` and it is uniformly **`tile_layer 0`** across all 26
  tile definitions in `data/tiles.gon`. No stacked/elevated tile levels.
- **INFERRED** — The grid is a flat col/row board; pathfinding (`choose_displacement*`,
  `closest_*`) operates purely on `iVec2D`. Multi-tile creatures use a 2D **footprint**
  (`aoe_considers_character_size`, 76 `false` / 91 `true`), i.e. width×height tiles — not vertical size.

---

## 3. Is any "z/height/layer" a real dimension — or just rendering?

Three distinct things in the data all turn out **not** to be a vertical gameplay axis:

### (a) `layer` / `glaiel::TacticsLayer` = object-category channel, not altitude — **OBSERVED**
The `layer` key in ability GON takes only these values:
`tiles` (3), `characters` (18), `pickups` (12), `gas` (3), `self` (2), `all` (3).
`glaiel::TacticsLayer` is passed to pathing/placement (`choose_displacement(…, TacticsLayer, …)`,
`closest_open_tile(…, TacticsLayer, …)`). These are **parallel occupancy channels at the same (col,row)**
— a tile can simultaneously hold terrain, a character, a pickup, and a gas cloud. They are *categories*,
not stacked heights. (**INFERRED:** that each layer is itself a 2D plane co-located with the others.)

### (b) `flying` = boolean trait/flag, not a Z coordinate — **OBSERVED**
- In character GON, `flying true/false` sits among plain scalar `properties` next to
  `health`, `movement`, `faction` (e.g. a bug enemy: `health 6 / movement 2 / flying true`). It is a
  flag on a grid entity, not a position.
- Engine has `glaiel::Flying` (a Passive/Component, with vftable + RTTI) and a `Conditional_Flying`
  status condition; druid abilities grant it as a status (`Flying 1`). So flight is a
  component/condition that *modifies movement/targeting rules* (**INFERRED:** ignore ground
  hazards/pits/water), while the creature still occupies a normal 2D tile.
- **Nuance / INFERRED:** The Bone Worm's text — "Gains more range the taller it becomes. Loses height
  when it takes damage. Can only take 1 damage at a time when tall." — uses "height/tall" as a
  **per-creature scalar stat (a stack counter)** that scales its attack range, *not* a world-space Z.
  It is flavor over a status-style counter, not grid elevation.

### (c) `Vec3D` / `height` / `lob` / `jump` = visual arcs over a 2D move — **OBSERVED + INFERRED**
- `lob true/false` is pervasive on throw/ranged abilities (**OBSERVED**). Paired with the
  `Lob*Character(iVec2D, Vec3D, …)` and `SpawnProjectile(iVec2D, Vec3D, …)` signatures, the `iVec2D` is
  the gameplay target tile and the `Vec3D` is the **render-space arc** (**INFERRED:** x,y + arc-height /
  draw value). `lob false` = straight shot, `lob true` = parabola — a *drawing* choice.
- The knockback effects `KnockUpAndAway { distance N, height N, stacks N }` and
  `KnockUpTowardsAndCollide { height N }` (**OBSERVED**: `glaiel::KnockUpAndAway`,
  `glaiel::KnockUpTowardsAndCollide` exist) pair a grid `distance` (tiles moved) with an arc `height`
  (**INFERRED:** amplitude of the visual up-arc). The creature lands on a tile; `height` does not persist.
- `BasicJump` uses `template jump_attack`, `target_mode tile`, `max_range mov`, `aoe_mode occupied_tiles`,
  with `jump_attack_animation land` (**OBSERVED**) — i.e. a jump *targets a tile* within movement range
  and plays a land animation. A dev TODO in `butcher_abilities.gon` even calls the jump phases
  "air states- up, up/down, down, and land" (**OBSERVED**) — these are **animation** states, not Z values.
  `DisplacementManager::choose_displacement_minjump(…)` likewise returns a destination `iVec2D`.

### Supporting: combat geometry is all 2D — **OBSERVED**
- `aoe_mode` values are planar shapes only: `circle, cone, line, cross, square, diagcross, 8cross,
  narrow_cone, occupied_tiles, map_edges, …`. No vertical/column AOE.
- `knockback_mode` values are 2D directions only: `character_to_tile, tile_to_character,
  pull_to_character, orientation, perp_towards_facing, …`.
- Line of sight is a **2D grid ray**: `must_have_line_of_sight` (60×), `must_have_piercing_line_of_sight`
  (7×), served by a 2D physics broadphase (`glaiel::Broadphase::RaycastAll`, `RaycastResult`,
  `Collider`, `CollisionFilter`). There is **no** `high_ground`, `cover`, or `elevation` key anywhere,
  and no `LineOfSight`-vs-height logic — the only LOS-ish class is `LineOfSightTrueSightAura`
  (reveals through fog/stealth, not elevation).

---

## 4. Rendering stack (confirming the 2D model)

- **OBSERVED** — The scene is drawn by a **2D vector/SWF renderer** ("glaielswf"): the `glaiel::swf::`
  namespace is a Flash-style 2D scene graph — `DisplayObject`, `DisplayObjectContainer`,
  `DisplayObjectContainer_DynamicBatched`, `MovieClip`, `DefineShape`, `DefineSprite`, `PlaceObject`,
  `ColorTransform`, and the 2D affine `Matrix3x2`. This matches the engine map (custom SWF player +
  ActionScript interpreter, OpenGL via SDL).
- **OBSERVED** — Draw ordering is handled by SWF display-list child/placement order (`PlaceObject`,
  container batching), not by a world Z axis; no `z_order`/`draw_order`/`sort_key` engine field name
  exists. Depth sorting of sprites (so a cat behind draws before one in front) is **INFERRED** to use
  screen-Y / display-list order — a *draw-order* concern, orthogonal to gameplay space.
- **OBSERVED** — SDL_GPU / Vulkan / D3D12 symbols are present only because SDL 3.2 is statically linked
  whole (per engine map); the engine renders through OpenGL with the 2D SWF pipeline. Their presence is
  **not** evidence of a 3D scene.

---

## 5. Verdict & nuance

**Strictly 2D (X/Y gameplay; Z only for draw order and visual arcs).** The deciding evidence:

1. Every tactics/position/pathfinding/targeting API is typed on **`iVec2D`** (764 sites); no entity
   has a z/height/elevation field.
2. The only matrix type is the **2D affine `Matrix3x2`**; `glaiel::Camera` is a 2D render-target/scissor
   camera; there is no projection/FOV/frustum/quaternion anywhere in `glaiel::`.
3. AOE, knockback, and line-of-sight are entirely 2D (planar shapes, grid directions, grid rays); there
   is no high-ground/cover/elevation data key at all.
4. The `Vec3D`/`height`/`lob`/`jump` machinery lives in projectile spawn, knockback and particle/UI
   **rendering** — a thrown or knocked-up unit draws a parabola but logically moves tile→tile.

**Nuances to keep honest (all INFERRED unless noted):**
- A `Vec3D` and an arc `height` genuinely exist, so a modder could *read/animate* those values; they
  just don't feed gameplay rules.
- "Flying" is a real, gameplay-relevant trait — but a **flag/component** (OBSERVED), not a coordinate.
  Its rule is pinned down by community docs (§7, COMMUNITY-SOURCED): flyers **ignore tile effects and
  pass over units/obstacles**, yet are **still targeted and attacked normally** (not "untargetable
  because high up"); some tiles (e.g. Fire) explicitly still affect flyers — reinforcing
  "tile-exemption flag," not altitude.
- "Layers" (`TacticsLayer`) are a real gameplay concept (co-located category channels), but horizontal,
  not vertical.
- Not verified via a live decompiler: the exact field offsets of a character's tile position and the
  precise semantics of the `Vec3D` z-component. These are INFERRED from signatures and data.

---

## 6. What this means for modding

- **Space is fundamentally 2D.** Data-only mods (GON) can freely place, move, knock back, and target on
  the col/row grid, choose `aoe_mode`/`knockback_mode`/`layer`, set `flying`, and tune `lob`/`height`
  **arc visuals**. All of that is recombining existing 2D behaviors — no native code needed.
- **You cannot add genuine verticality (height/elevation/high-ground/3D LOS) with data alone, and not
  easily with native code either.** There is no z gameplay axis, no elevation field on tiles or
  entities, and no height input to range/LOS/cover. A real height dimension would require new native
  systems (a per-entity elevation state plus elevation-aware pathfinding, targeting, LOS and AOE) —
  effectively new engine behaviors, well beyond GON recomposition.
- **Faux-verticality is cheap, though.** Because `Vec3D`/arc `height`/`lob` already exist for rendering,
  a mod can lean on them for *visual* elevation (bigger hops, higher lobs, "flying" look) while the
  logic stays tile-based. New discrete "layers" (à la gas/pickups) are a more plausible native
  extension than a continuous Z, since the grid already supports categorical layers.

---

## 7. Community corroboration (COMMUNITY-SOURCED)

Checked against the official Mewgenics Wiki (`mewgenics.wiki.gg`) plus third-party guides (not
tcrf.net). The community model is strongly consistent with the strictly-2D static finding, and pins
down a few rules the binary alone left INFERRED:

- **Board** — "The battle takes place on a board, made of a **10×10 square grid of tiles**." Units have
  a refreshing **movement action**; some tiles cost extra (`Bramble` "costs 2 movement", `Road` "0.5")
  — i.e. movement points over a flat grid. (`/wiki/Battle`, `/wiki/Tiles`)
- **Range / LOS** — "every action has a defined **range from 0 to 20**" (matches the data's
  `max_aoe`/`max_range` ceiling of 20); areas use **Manhattan / Euclidean distance**; LOS is blocked by
  2D "cones/vectors" from occupying units. **Elevation/height/high-ground never appear.**
  (`/wiki/Range_and_Area`)
- **Flying** — "Flying status: **Ignores tile effects, can pass over units and objects.**" Flyers are
  targeted/attacked normally; some tiles still affect them "unless indicated otherwise." Confirms
  flying = tile-exemption flag, not altitude. (`/wiki/Fly`, `/wiki/Tiles`)
- **Jumps** — jump skills "**Jump to a tile in range N**" and land there (e.g. Gravity Slam, Meteor
  Slam, Pogo, Belly Flop) — tile-to-tile repositions, no height axis. (`/wiki/Gravity_Slam` et al.)
- **Knockback** — "Push a unit … away from you 10 tiles"; knockback is N-tile sliding with
  collision/chain damage; some tiles (Snow) stop it. Pure 2D displacement. (`/wiki/Telekinesis`,
  `/wiki/Chain_Knockback`)
- **"Layers"** — the wiki describes a tile's stacked **content layers** (units / gas / pickups / traps /
  tile-type) — **content categories on one tile, not vertical elevation.** This matches
  `glaiel::TacticsLayer` and the GON `layer` values exactly. (`/wiki/Battle`)
- **Lone outlier (dismissed)** — one third-party guide (`games.gg`) lists a bare, unexplained bullet
  "*Elevation affects line of sight and damage*" amid generic filler. It cites no rule, is contradicted
  by the official wiki's fully-2D model, and no other source supports it. Noted for honesty; **not**
  treated as evidence of a height dimension.

---

*Static-only; no live decompiler session. Engine symbols/data are ground truth; §7 is community
corroboration, not a substitute. Generated from build 1.1.21239 (Steam build 25143593) artifacts under
`.analysis/` and `.extracted/`.*
