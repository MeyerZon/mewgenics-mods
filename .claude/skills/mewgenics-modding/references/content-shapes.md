# Content shapes

This is the informal schema seen in the base pack. It is practical guidance, not
a formal spec — field sets vary by entry. Always confirm real field names and
values with `read_base_entry` (and `search_components` for class names) before
authoring an overlay.

## GON syntax notes

- `Key { ... }` objects, `[ ... ]` arrays (the braces are tokens on their own; `a{b 1}` is fine).
- Bare tokens, including numeric expressions like
  `3+bonus_melee_ability_damage` and leading-dot decimals like `.25`.
- Quoted strings `"..."`; integer keys (`0`, `1`, `2`, ...). Inside quotes only `\n` is an escape
  (`\t` is a plain `t`).
- `//` line comments, `/* */` blocks and `#` to end of line.
- `,` `:` `=` are whitespace — commas are optional, `a=5` is `a 5`.
- Whitespace-insignificant layout.
- Typing is by text, never by quoting (the game drops the quotes): `"5"` and `5` are both numbers
  (`.add` / `.multiply` work on either), `""` is the number 0, `0x10` is 16, exactly `true` / `false` are bools,
  `null` is null, and `5%`, `yes`, `True` are strings. A string that must stay a string needs non-numeric text.
  Details: `docs/data-mods.md` "GON typing fidelity".

## Abilities (`data/abilities/*.gon`)

```gon
Name {
  template ...
  class glaiel::SomeAbility
  meta { name ABILITY_Name_name; desc ABILITY_Name_desc; class Fighter }
  graphics { /* ... */ }
  sounds { /* ... */ }
  cost { mana 2; infcantrip true }
  target { target_mode ...; aoe_mode ...; knockback_mode ...; multihit ... }
  damage_instance {
    damage "3+bonus_melee_ability_damage"
    knockback 1
    effects { Rot 2 }          // apply status Rot, magnitude 2
  }
  temporary_effects { Haste 1 }
}
```

`variant_of X` inherits from another ability and overrides selected fields:

```gon
MyStrikePlus {
  variant_of MyStrike
  damage_instance { damage "5" }
}
```

## Passives (`data/passives/*.gon`)

Numeric keys are passive **levels**; the inner keys are C++ component class
names (confirm with `search_components`).

```gon
Name {
  name PASSIVE_Name_name
  desc PASSIVE_Name_desc
  class Butcher
  1 { passives { AddStatusToBasicAttack { Rot 1 } } }
  2 { passives { UncappedHP true; StatusOnEatFood { Regen 1 } } }
}
```

## Items (`data/items/*.gon`)

```gon
Name {
  name ITEM_Name_name
  desc ITEM_Name_desc
  rarity common
  kind head            // head | face | neck | ...
  frame 12
  set Scrap
  shield 4
  passives { Metal 1 }
}
```

## Characters (`data/characters/*.gon`)

```gon
Name {
  variant_of Base
  properties { faction allies; inherit_faction true }
  abilities { can_get_bonus true }
  ai { brain PlayerBrain }
  graphics { tint [255 255 255 255] }   // [r g b a]
}
```

## Classes (`data/classes/classes.gon`)

```gon
Fighter {
  meta { /* ... */ }
  graphics { palette 54; alt_animations [ /* ... */ ] }
  attack_pool [ /* ... */ ]
  ability_pool [ /* ... */ ]
}
```

## Difficulties (`data/difficulties.gon`)

Numeric keys are difficulty tiers.

```gon
0 {
  boss_health_multiplier 1.0
  wallet_size 500
  easy { /* ... */ }
  hard { /* ... */ }
}
// 1 { ... } 2 { ... } ...
```

## SWF art list (`swfs/swflist.gon`)

A `game [ ... ]` array. Add art with `swflist.gon.append`:

```gon
// swfs/swflist.gon.append
game [
  "my_new_art.swf"
]
```

## Text (`data/text/combined.csv`)

The 12-column localization table — see
[gon-overlays.md](gon-overlays.md#csv-overlays-datatextcombinedcsv) for the
column list and the append-vs-merge rules.

## The recombination boundary

The data layer only **recombines** the ~1,750 existing C++ behavior components
(the `glaiel::<Name>` classes `search_components` lists). An ability, passive,
or item is a configuration of components that already ship with the game —
status effects, damage instances, triggers, and so on.

A mechanic that no component expresses — new status tick logic, a new system, or
new UI — cannot be built in the data layer. It needs the native layer
(`native/`), which is out of scope for this skill. When a request implies new
behavior, say so and reach for an existing component that approximates it rather
than inventing a field or class name.
