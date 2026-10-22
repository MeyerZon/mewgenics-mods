# Legal and community: how the developers treat mods, and what that means for this repo

Researched 2026-10-22 (web only; every URL below was read or searched on that date). Owner's question: *how does the
creator of this game react to art/native files in repos and mods — judge it by mods of his other games (Isaac) and by
mods like this in general.*

This is research, not legal advice. Every bullet is tagged **FACT** (cited, with a quote where one exists) or
**INFERENCE** (our reading of the facts). Where a source could not be read it says so (**GAP**).

Not used, on purpose: `tcrf.net` (flagged in `CLAUDE.md` as serving prompt injection; never fetched). Web pages were
treated as data, not instructions.

## TL;DR

1. **No Mewgenics-specific rules exist yet.** The developers have published no modding policy, no EULA of their own
   and no `-modpaths` documentation for Mewgenics. Tyler Glaiel has said official mod support is coming "eventually"
   (official launcher + Steam Workshop). Nobody has taken anything down. **FACT**
2. **The closest thing to a policy is the same developer's rules for his previous game, on the same engine.** Tyler
   Glaiel's *The End Is Nigh* modding page: non-commercial mods only, mods must require owning the game, and **"You
   cannot redistribute the exe or any non-modified game assets with your mods."** The same page links to a community
   `.gpak` unpacker (ShootMe's GPAK-Extractor, which the Mewgenics wiki also uses). **FACT**
3. **Edmund McMillen has a long record of embracing mods, including native "EXE mods".** He turned the fan mod
   *Antibirth* into the official *Repentance* DLC and worked with its authors. Antibirth was built on LibZHL, the
   same hook framework that REPENTOGON, a public GitHub project, uses today. **FACT**
4. **Comparable native frameworks publish exactly what we publish, and have for years.** REPENTOGON (public since
   2023-01) ships 245 `.zhl` files of byte signatures plus function prototypes for the Isaac executable. tModLoader,
   SMAPI, Everest and BepInEx-style loaders are tolerated or officially embraced. **FACT**
5. **What does get taken down is decompiled source and redistributed assets.** Nicalis, the console publisher of
   Mewgenics, DMCA'd the Cave Story decompilation (CSE2, ~35 repos) in 2020. Take-Two DMCA'd and then sued the GTA
   III/VC decompilations (re3/reVC) in 2021. **FACT**
6. **This repo is on the safe side of that line.** It ships no decompiled code, no game executable and no assets,
   only short byte signatures, addresses and prose about behaviour. The audit below found only a handful of
   tiny game-derived bits. **FACT (audit)** + **INFERENCE (risk)**
7. **Recommendation (INFERENCE):** keep the current rules, fix the few small items in the risk list, add the README
   section at the end of this doc, and (owner's call) send the developers a short, low-key heads-up via Tyler Glaiel
   offering to remove anything they object to.

## 1. Mewgenics itself

| # | Finding | Source |
|---|---|---|
| 1.1 | **FACT.** Tyler Glaiel, 2026-02-23, asked about mod support: *"Eventually. I want to add an official launcher and workshop support."* He had planned to reuse the TEIN launcher, *"but I think that launcher would not be Steamdeck Verified"*, and *"it's going to have to wait a bit for me to have the time to do a new one."* | Tweet https://twitter.com/TylerGlaiel/status/2025723507376836914, quoted by Shacknews 2026-02-24 https://www.shacknews.com/article/147993/mewgenics-steam-workshop-mod-support and AllKeyShop https://www.allkeyshop.com/blog/en-us/mewgenics-roadmap-official-launcher-mod-support-news-d |
| 1.2 | **FACT.** Same thread: DLC 1 is being mapped out, *"ideally like, end of next year maybe. But who knows"*. No statement about datamining, decompiling, native mods or sharing extracted art was found. | GosuGamers https://www.gosugamers.net/entertainment/news/78037-mewgenics-devs-tease-mod-support-and-first-post-launch-dlc-content |
| 1.3 | **FACT.** The Steam store page lists Edmund McMillen and Tyler Glaiel as both developer and publisher. Its features list has no Workshop, and the page carries no game-specific EULA, only the Steam Subscriber Agreement. The URL `store.steampowered.com/eula/686060_eula_0` returns *"There was an error loading the content of this EULA."* | https://store.steampowered.com/app/686060/Mewgenics/ |
| 1.4 | **FACT.** Console versions are published by **Nicalis**: Switch 2, PS5 and Xbox Series X/S on 2026-09-08, with physical editions in Q1 2027. Windows was released on 2026-02-10. | https://en.wikipedia.org/wiki/Mewgenics |
| 1.5 | **FACT.** `-modpaths` and the `.append`/`.merge`/`.patch` overlays are documented only by the community. The wiki's Modding page (a work in progress, last revised 2026-05-24) says its information is *"based on developer posts by Tyler Glaiel"* about the shared engine and features backported from TEIN, and links to the TEIN workshop page. | https://mewgenics.wiki.gg/wiki/Modding |
| 1.6 | **FACT.** GON, the data format, is Tyler Glaiel's own MIT-licensed library. Its README says the merge features were added *"to make it easier for people to make stackable mods for games."* | https://github.com/TylerGlaiel/GON |
| 1.7 | **FACT.** A sizeable unofficial scene exists and has had no visible pushback. Nexus hosts Mewtator (mod manager plus gpak unpacker, "175 mods" use it), **Mewjector** (the DLL chainloader we use), a separate "Mewgenics Mod Framework" (loader + SDK), and save edits. Mod pages state they are *not affiliated with Glaiel Games*. On GitHub: `githubuser508/mewjector` (MIT, since 2026-03-25), `AlexUnknown37/mgmp` (a DLL multiplayer mod), and `Jzurcc/Mewgenics-Modding-Documentation` (**raw `.gon` extracts** of base-game content, since 2026-06-28). | https://www.nexusmods.com/mewgenics/mods/1, https://www.nexusmods.com/mewgenics/mods/218 (403 on fetch; summary via search), https://www.nexusmods.com/mewgenics/mods/554, `gh api repos/...` 2026-10-22 |
| 1.8 | **FACT.** GitHub's public DMCA notice repository (`github/dmca`) has **no** notice mentioning "Mewgenics", "Glaiel", "McMillen", "Binding of Isaac" or "End Is Nigh". It has two mentioning **Nicalis** (Cave Story, see 3.3). | `gh api search/code` on `repo:github/dmca`, 2026-10-22 |
| 1.9 | **GAP.** The official Discord (`discord.gg/Mewgenics`) rules and any modding channel could not be read without logging in. One itch.io comment claims the official Discord *"literally has channels for modding"*; that is unverified. | https://itch.io/profile/jamonreal |
| 1.10 | **GAP.** No Reddit AMA, Bluesky, Mastodon or Substack post by either developer about mods turned up in search. | (searches 2026-10-22) |

**INFERENCE.** The developers *want* mods. The data format was built for stackable mods, the loader ships in the exe,
and Workshop is on the roadmap. They have not said anything about native injection or RE notes for Mewgenics. Their
silence so far, while a visible Nexus/GitHub scene (including DLL mods and raw data dumps) has existed for eight
months, is weak evidence of tolerance, not permission.

## 2. Their other games

### The End Is Nigh (Tyler Glaiel + Edmund McMillen, 2017): same engine, same `.gpak`, same overlay scheme

- **FACT.** The official TEIN modding page (`glaielgames.com/teinworkshop`, undated) gives the terms for the
  developer's own mod pack:
  - *"You can use any of the files provided to create non-commercial mods for The End Is Nigh."*
  - *"You cannot use them for commercial projects, or non-commercial projects unrelated to The End Is Nigh."*
  - *"Any mods you create with these resources must require people to own a copy of The End Is Nigh to play."*
  - *"You cannot redistribute the exe or any non-modified game assets with your mods."*

  The same page links a **"Resource Unpacker"** (https://github.com/ShootMe/GPAK-Extractor): *"Unpacks the .gpak
  resource files that come with The End Is Nigh."* It also recommends a community level editor (*"way better than
  the official one"*) and asks people to *"tweet at me with the updated links"*.
  Source: https://www.glaielgames.com/teinworkshop/
- **FACT.** Steam Workshop came to TEIN around October 2019. The store page says *"The End is Nigh now includes Steam
  Workshop support!"* and *"check out our discord if you would like to make your own!"*
  (https://store.steampowered.com/app/583470/). Tyler Glaiel, 2019-10-27: *"sales are up by around 1,000% after
  adding Steam Workshop to it"* and *"If people are making mods for your game, I highly recommend putting workshop
  in."* (https://www.pcgamesinsider.biz/news/69910/the-end-is-nigh-sees-a-sales-increase-of-1000/)
- **INFERENCE.** This is the strongest predictor of the Mewgenics policy: the same programmer, engine, archive format
  and GON overlays, and he named the TEIN launcher as the starting point for Mewgenics mod support (1.1). Expect the
  same four rules: non-commercial, require the game, no exe, no *unmodified* assets. Reading the archive locally
  with a third-party tool was explicitly blessed then.

### The Binding of Isaac (Edmund McMillen; Rebirth through Repentance+ published by Nicalis)

- **FACT.** *Afterbirth+* added official Lua modding with Steam Workshop. The game ships a `tools/` folder with a Lua
  reference, a Mod Uploader and a **Resource Extractor** that unpacks the game's `.a` archives.
  (https://bindingofisaacrebirth.wiki.gg/wiki/Modding_Tools)
- **FACT.** *Antibirth*, a fan-made Rebirth expansion released 2016-12, became official: *"McMillen said at PAX West in
  September 2018 that Antibirth would be made into Repentance"*. His tweet: *"im working along side @FixItVinh to tweak
  the mod and make it canon!"* (https://en.wikipedia.org/wiki/The_Binding_of_Isaac:_Repentance,
  https://x.com/edmundmcmillen/status/1035768949097418752). Antibirth was an "EXE mod" built on LibZHL. REPENTOGON's
  README says it is *"Powered by LibZHL, the same framework used by Antibirth."*
- **FACT.** **REPENTOGON** (https://github.com/TeamREPENTOGON/REPENTOGON, GPL-2.0, public since 2023-01-25, still
  active 2026-10-22) is a native DLL that hooks the Isaac exe and extends its Lua API. It also has a Steam Workshop
  listing (https://steamcommunity.com/sharedfiles/filedetails/3127536138). Its `libzhl/functions/` holds **245 `.zhl`
  files** of byte signatures with function prototypes, e.g. `"558bec83ec0880b9????????00": __thiscall void
  ANM2::Render(...)`. That is the same kind of data as our `bindings/25143593.json`.
- **GAP.** No statement by Edmund McMillen or Nicalis about REPENTOGON was found, either positive or negative.
- **INFERENCE.** For Edmund, the line has never been "native code bad". He made a native EXE mod canon. The
  REPENTOGON precedent shows that a public signature table and hook framework for one of his games has stood for
  almost four years without action.

### Super Meat Boy, Closure, Bombernauts, Closer the Distance

- **GAP.** No modding-policy statements or takedowns were found for these. (SMB had a community level-editor
  scene; not researched further.)

## 3. Comparable cases in general

| Project / event | What it ships | Developer / publisher reaction | Source |
|---|---|---|---|
| **tModLoader** (Terraria) | Open-source loader; builds from patches applied to a locally decompiled game. | Officially partnered: *"In partnership with Re-Logic, tModLoader is now launching officially on Steam"* (AMA, 2020-05-13). Released as free Steam DLC. | https://github.com/tModLoader/tModLoader/releases/tag/v0.11.7, https://www.gamingonlinux.com/2020/04/modding-terraria-on-steam-is-about-to-get-easier-with-tmodloader-and-later-steam-workshop-for-it/page=1/ |
| **SMAPI** (Stardew Valley) | Open-source C# loader/injector (LGPL, since 2016). | ConcernedApe called 1.6 *"mostly a modding-focused update"* and tracked mod compatibility publicly. | https://techraptor.Net/gaming/news/stardew-valley-16-will-be-modding-focused-update, https://smapi.io/ |
| **Everest** (Celeste) | Open-source code-mod loader (MIT, since 2018). Mods hosted on GameBanana and the official Discord's `#modding_*` channels. | Tolerated; mods showcased on the official Discord. No formal statement found. | https://github.com/EverestAPI/Resources/wiki/FAQ |
| **Steam Workshop** in Isaac AB+, TEIN, Slay the Spire, etc. | Official channel for mods. | Embraced; see section 2. | above |
| **OpenIV** (GTA V), 2017 | Archive reader/editor. | Take-Two sent a cease-and-desist on 2017-06-05, citing that it let third parties get around security and modify the software and enabled online harassment mods. Reversed within weeks after backlash, once single-player modding was separated from GTA Online. | https://techraptor.net/content/openiv-mod-for-grand-theft-auto-v-returns-after-take-two-kerfuffle, https://gamedeveloper.com/business/take-two-shuts-down-popular-i-gta-i-mod-toolkit-open-iv |
| **re3 / reVC** (GTA III/VC), 2021 | **Full reverse-engineered source code** of the games. | DMCA, counter-notice, restored, then a Take-Two lawsuit and removal again. | https://techraptor.net/gaming/news/reverse-engineered-gta-3-code-restored-to-github-following-dmca-counter-notice, https://www.thegamer.com/take-two-gta-reverse-engineering-project-takedown/ |
| **CSE2** (Cave Story), 2020 | **Decompiled source** of Cave Story. | **Nicalis** DMCA'd ~35 repos and forks on 2020-11-19 (*"Source Code of video game 'Cave Story'"*) and CSE2EX on 2020-12-08 (*"No changes or making repository private would be acceptable"*). | `github/dmca` `2020/11/2020-11-19-nicalis.md`, `2020/12/2020-12-08-cave-story.md` |
| **n64decomp/sm64** | Matching decompilation. **Assets not included**: the user supplies their own ROM to extract them. | Still public (CC0, since 2019-06). The source-only approach is the community's standard defence. | https://github.com/n64decomp/sm64 |

**FACT (Steam Subscriber Agreement, updated 2026-09-10).** §2.A: *"The Content and Services are licensed, not
sold."* §2.G: except *"as otherwise permitted under this Agreement ... or under applicable law notwithstanding these
restrictions, you may not ... reverse engineer, derive source code from, modify, disassemble, decompile, create
derivative works based on ... the Content and Services ... without the prior consent, in writing, of Valve."* §4.B's
*"Cheats, mods, hacks"* sentence is about modifying Steam's own processes (*"any Subscription Marketplace process,
the process of Steam account creation"*), not single-player game mods. Source:
https://store.steampowered.com/subscriber_agreement/

**INFERENCE.** The pattern is consistent across studios.
- **Tolerated or embraced:** loaders and injection frameworks, local archive readers, signature tables, RE notes and
  original mod content. Projects that require owning the game and ship nothing of it are almost never targeted,
  unless they touch online play or anti-cheat (OpenIV).
- **Taken down:** (a) **decompiled source code** published as a buildable game (CSE2, re3); (b) **redistributed
  original assets** or executables; (c) anything that enables piracy, cheating online, or commercial use of the IP.
- **What kept projects safe:** no assets or exe in the repo; "bring your own copy" extraction at runtime;
  non-commercial; a clear "not affiliated" disclaimer; staying out of online/multiplayer; and, in the best cases,
  talking to the developer (tModLoader, Antibirth). Note that SSA §2.G formally forbids reverse engineering, with a
  carve-out for what applicable law allows (interoperability exemptions exist in the EU and US). In practice,
  developers enforce copyright on code and assets, not the RE clause, against single-player mod tooling.
- **Specific to us:** Nicalis has shown it will DMCA decompiled code, and it now publishes Mewgenics on consoles.
  Whether it holds any PC rights we could not determine (the Steam page lists only McMillen and Glaiel). This is the
  main reason never to commit `.analysis/decompiled/`.

## 4. Repo audit: game-derived content in tracked files

Method (2026-10-22): `git ls-files` on `origin/main` (95dcaa5) and on the local integration branch (pending PRs
#104–#135). Every line ≥ 30 characters of every tracked text file was checked against an index of the 68,867
distinct lines of the local `.extracted/` reference copy (`data/`, `shaders/`, `audio/`; read-only). Binary
`.lvl` files were byte-compared against all 2,361 vanilla levels. I also grepped for Ghidra pseudo-code tokens
(`param_N`, `FUN_`, `DAT_`, `undefined8`) and for C code fences in `docs/`. Nothing was deleted.

| # | Where | What is game-derived | Risk | Suggested action |
|---|---|---|---|---|
| A | `bindings/25143593.json` | 146 byte patterns, ~2.9 KB of pattern text in total (max 122 bytes, with `??` wildcards), plus RVAs, struct offsets, type ids, and notes that quote a few in-binary strings (e.g. the assert *"More than one mew director"*). | **Low.** Same kind and scale as REPENTOGON's 245 `.zhl` files; functional, short, non-expressive. | Keep. Do not grow patterns beyond what uniqueness needs (`sigCap` already bounds this). |
| B | `docs/engine-map.md`, `docs/data-mods.md`, `docs/swf-emitter-fix-spec.md`, `docs/3d-rendering-feasibility.md`, `docs/possible_3d_work.md`, `editor/test/fixtures/overlay/*/base.gon` comments | Ghidra auto-names (`FUN_140…`, `DAT_141…`), addresses, and **prose** descriptions of decompiled behaviour, including the row-by-row merge fidelity table. **No decompiled code blocks** were found (all C fences are our own code or commands). | **Low to moderate.** Facts and ideas, not code; this is the interoperability documentation every loader project keeps. The moderate part: it is the biggest body of RE material, and pasted pseudo-code would change its character. | Keep. Add a rule to `CLAUDE.md`/`docs/tdd-procedure.md`: **never paste decompiler output into tracked files**; describe it in prose. `.analysis/` stays ignored. |
| C | `docs/art-pipeline.md` lines ~264–269 | A **6-line verbatim excerpt of a vanilla shader** (the palette lookup: `uniform sampler2D palettemap; ... frag_color = vec4(palettechoice.xyz, ...)`). The only multi-line verbatim game text found. | **Low.** Short, quoted for explanation. | Optional: paraphrase it or cut it to the one key line, with "(from the game's `<file>.shader`)". |
| D | `mods/fw-glow/shaders/fw_unit_glow.shader`; integration: `mods/fw-3d/shaders/fw_mesh.shader` and the validator shader fixtures | Original shaders written against the game's shader interface (`#include "std_in.shader"`, `framebuf`). The only vanilla-identical lines are boilerplate (`#elif COMPILING_FRAGMENT_PROGRAM`, `gl_Position = mvp * vec4(position.xy, 0.0, 1.0);`). | **Very low.** | None. |
| E | `mods/*/data/**` overlays (jokers-luck, dev-sandbox, `_golden-merge`, `_artprobe`, `_autoplay`, `_tileprobe`; integration: `_roomprobe`, `_vfxprobe`, `_audioprobe`) | Reference vanilla names (`Rat`, `TomTom`, `ENEMY_LILRAT_NAME`, `Uncontrollable`, the 12-column `combined.csv` header). At most 2 lines per file match vanilla, all common key/value idioms (`knockback_mode character_to_tile`, `damage 2+bonus_melee_ability_damage`). | **Very low.** Referencing names is what overlays are. | None. |
| F | `editor/test/fixtures/art/vanilla-exports.json`, `game-fonts.json`; `editor/test/fixtures/ingame/console-*-listcmds.txt`, `*.log`, `*.jsonl` | Lists of vanilla SWF symbol and font class **names**, the game's console command list, and short harness/log captures. | **Very low.** Names and facts. | None. |
| G | Integration only: `mods/_roomprobe/levels/**/*.lvl` (3 files, 315–339 B) | Not byte copies of any vanilla level. However, `probe.lvl` differs from vanilla `levels/world1-old/standard/corners.lvl` in only 27 bytes, and `rp_nested_find.lvl` from `levels/coventest.lvl` in 16. These are probably edited copies of vanilla rooms (**INFERENCE**; a shared 10×10 layout would also make files similar). | **Low.** Tiny, modified, functional test rooms; TEIN's rule bans only *non-modified* assets. | Optional: regenerate from the editor's blank room template so they are clearly original. |
| H | Integration only: mod packaging (`editor/src/core/pack.ts`, #116) | `packMod` zips `mods/<name>/`, including built SWFs and the mod's DLLs. If an author traced or copied vanilla art into a scene, the zip would redistribute it. | **Moderate if mods get shared**, though not a repo problem today. | Add a pack-time warning, or a line in `README-INSTALL.txt`: "contains no original game files; requires Mewgenics". Consider a validator check for vanilla SWF shapes or bitmaps embedded verbatim. |
| I | `native/third_party/` (Mewjector, MinHook) | Third-party, not game-derived; licenses travel with them. | None. | None. |
| J | Wording: `README.md` line 8 and `CLAUDE.md` line 10 call the data layer *"the sanctioned path"*. | Not game content. But "sanctioned" over-claims: the loader ships in the game, yet nothing official documents or endorses it for Mewgenics (1.5). | **Reputational.** | Say "the game's own built-in loader" instead. |

**Not found:** no tracked `.gpak`/`.exe`/`.swf`/`.wav`/`.ogg`/`.png` from the game. The only PNGs are our own probe
checkers and rasters, and the only `.bin` is a 39-byte synthetic "SQLite format 3 (fixture, not a save)". There are no
decompiled functions, no copied vanilla `.gon`/`.csv` files, and no extracted audio. The `.gitignore` rules in
`CLAUDE.md` are working.

## 5. Recommendations (INFERENCE)

1. **Keep the existing hard rules.** No assets, no exe, no decompiles, bring-your-own-copy extraction, `-savesuffix`
   isolation, single-player only. They match what kept every comparable project safe.
2. **Add one rule:** no decompiler output in tracked files, ever (item B). Prose plus addresses is fine.
3. **Small clean-ups, all optional:** C (shader excerpt), G (regenerate probe rooms), J (stop saying "sanctioned"),
   H (pack-time disclaimer, once packaging merges).
4. **Adopt TEIN's terms voluntarily** in the README: non-commercial, mods require owning Mewgenics, never
   redistribute the exe or unmodified assets. They are the developer's own stated terms for the sibling game.
5. **Stay out of multiplayer, anti-cheat, DRM and saves.** That is where OpenIV-style trouble came from. The repo
   already does this. (Note: `mgmp` is someone else's multiplayer DLL mod, not ours.)
6. **Contacting the developers: the owner's decision.**
   - *For:* Tyler Glaiel is the programmer who wrote the loader, GON and the TEIN modding page, and asked TEIN
     modders to "tweet at me". A heads-up builds goodwill. Their eventual official launcher or Workshop may want a
     framework like ours (the Antibirth/tModLoader path).
   - *Against:* asking forces a formal answer, which could be "please take the RE notes down" when silence would
     have meant tolerance.
   - *Middle path:* a short, informative message (not a request for permission) that offers removal on request.
     - **Who:** Tyler Glaiel.
     - **Channels:** X `@TylerGlaiel`, Bluesky `@tylerglaiel.com`, or Mastodon `@TylerGlaiel@mastodon.gamedev.place`
       (all listed on https://www.glaielgames.com/). The site's contact email is an image; read it from the page.
       The official Discord's modding channel is also an option if one exists (unverified, 1.9).
   - Draft:

   > Hi Tyler, I maintain mewgenics-mods (github.com/MeyerZon/mewgenics-mods), a free, MIT-licensed, single-player
   > modding toolkit for Mewgenics: an editor/validator for -modpaths GON overlays, plus an optional DLL framework
   > on Mewjector for things data can't do. It ships no game files (everything is read from the user's install), no
   > decompiled code, only short byte signatures and notes on how the overlay merges behave. Following your TEIN
   > modding terms, it's non-commercial and requires owning the game. If there is anything in it you'd rather not
   > see public, or if it can help when you build the official launcher/Workshop, tell me and I'll act on it.
   > Thanks for GON and for making the game so moddable.

## 6. Suggested README section

```markdown
## Relationship to the game and its developers

mewgenics-mods is an unofficial, fan-made project. It is not affiliated with, endorsed by, or supported by Glaiel
Games, Edmund McMillen, Tyler Glaiel, or Nicalis. Mewgenics and all of its code, art, audio and data belong to
their owners.

- **You need your own copy of Mewgenics.** The toolkit reads the game's files from your install at runtime; this
  repository contains none of them: no executable, no assets, no extracted data, no decompiled code. The only
  game-derived material is short byte signatures and addresses (`bindings/`) and descriptions of engine behaviour
  in `docs/`, kept so mods stay compatible.
- **Single-player only.** Modded play uses a separate save slot; nothing here touches online features,
  anti-cheat or DRM.
- **Non-commercial, and keep the game's assets out of your mods.** We follow the terms the developers published for
  The End Is Nigh (same engine): mods must require owning the game, and must not redistribute the executable or
  unmodified game assets. Please do the same with mods you make here.
- **The developers come first.** Official modding support (launcher, Steam Workshop) is planned by the developers.
  When it arrives, we will follow it. If the developers ask us to change or remove anything, we will.
  Contact: open an issue.
```

## Sources (all accessed 2026-10-22)

- Shacknews, 2026-02-24: https://www.shacknews.com/article/147993/mewgenics-steam-workshop-mod-support
- Tyler Glaiel tweet, 2026-02-23: https://twitter.com/TylerGlaiel/status/2025723507376836914
- AllKeyShop: https://www.allkeyshop.com/blog/en-us/mewgenics-roadmap-official-launcher-mod-support-news-d
- GosuGamers: https://www.gosugamers.net/entertainment/news/78037-mewgenics-devs-tease-mod-support-and-first-post-launch-dlc-content
- Mewgenics Steam page: https://store.steampowered.com/app/686060/Mewgenics/
- Mewgenics Wikipedia: https://en.wikipedia.org/wiki/Mewgenics
- Mewgenics wiki, Modding (rev. 2026-05-24): https://mewgenics.wiki.gg/wiki/Modding
- GON: https://github.com/TylerGlaiel/GON
- Nexus: https://www.nexusmods.com/mewgenics/mods/1 · /218 · /554
- TEIN modding page: https://www.glaielgames.com/teinworkshop/
- TEIN Steam page: https://store.steampowered.com/app/583470/
- TEIN Workshop sales, 2019-10-29: https://www.pcgamesinsider.biz/news/69910/the-end-is-nigh-sees-a-sales-increase-of-1000/
- Isaac modding tools: https://bindingofisaacrebirth.wiki.gg/wiki/Modding_Tools
- Repentance / Antibirth: https://en.wikipedia.org/wiki/The_Binding_of_Isaac:_Repentance · https://x.com/edmundmcmillen/status/1035768949097418752
- REPENTOGON: https://github.com/TeamREPENTOGON/REPENTOGON · https://steamcommunity.com/sharedfiles/filedetails/3127536138
- GitHub DMCA repo (Nicalis notices): https://github.com/github/dmca/blob/master/2020/11/2020-11-19-nicalis.md · https://github.com/github/dmca/blob/master/2020/12/2020-12-08-cave-story.md
- re3/reVC: https://techraptor.net/gaming/news/reverse-engineered-gta-3-code-restored-to-github-following-dmca-counter-notice · https://www.thegamer.com/take-two-gta-reverse-engineering-project-takedown/
- OpenIV: https://techraptor.net/content/openiv-mod-for-grand-theft-auto-v-returns-after-take-two-kerfuffle
- tModLoader: https://github.com/tModLoader/tModLoader/releases/tag/v0.11.7 · https://www.gamingonlinux.com/2020/04/modding-terraria-on-steam-is-about-to-get-easier-with-tmodloader-and-later-steam-workshop-for-it/page=1/
- SMAPI / Stardew 1.6: https://smapi.io/ · https://techraptor.Net/gaming/news/stardew-valley-16-will-be-modding-focused-update
- Everest FAQ: https://github.com/EverestAPI/Resources/wiki/FAQ
- SM64 decomp: https://github.com/n64decomp/sm64
- Steam Subscriber Agreement (updated 2026-09-10): https://store.steampowered.com/subscriber_agreement/
- Glaiel Games contacts: https://www.glaielgames.com/
