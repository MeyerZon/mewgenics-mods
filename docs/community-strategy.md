# Community adoption strategy

Drafted 2026-10-22. Owner's goal: make this toolkit **the standard way to mod Mewgenics**. Owner's idea: build a few
showcase mods and give them to content creators.

This is a plan, not a commitment. Nothing in it has been posted, sent or published. Every claim is tagged:
- **FACT**: sourced, with the source and its date.
- **INFERENCE**: our reading of the facts.
- **GAP**: we tried to find out and could not.

Read it with [`legal-and-community.md`](legal-and-community.md) (PR #137), which sets the limits this plan works
within:
- no game assets and no decompiled code, in the repo or in any mod we ship;
- non-commercial only;
- every mod requires owning the game;
- single-player only.

The capability claims in section 3 come from [`feature-inventory.md`](feature-inventory.md) (`main` at b2e13b7).

Not used, on purpose: `tcrf.net` (flagged in `CLAUDE.md`; never fetched). Nexus Mods pages returned HTTP 403 to our
fetcher on 2026-10-22, so Nexus numbers below come from search-engine snippets of those pages and may lag.

## TL;DR

1. **The standard player stack already exists, and it is not us.** It is **Mewtator** (mod manager, Nexus mod #1,
   about 881 endorsements, created three days after launch) plus **Mewjector** (the DLL chainloader we already use).
   Most Nexus mods say "requires Mewtator". **FACT**
2. **So do not build a rival mod manager.** Aim to be the standard in two places:
   - **authoring:** the editor, the validator, art, rooms, the in-game tests;
   - **native mechanics:** `mewframework.dll`.

   Ship to players *through* Mewtator, Mewjector and Nexus. SMAPI, BepInEx and REPENTOGON each became the standard by
   being the dependency other mods need, not by owning the download button. **INFERENCE**
3. **Three blockers stop a player from using a mod made here today.**
   - There are no prebuilt binaries: players must build the DLLs with GCC.
   - The framework stays off unless the game is launched with `-savesuffix`, which Mewtator does not add by default.
   - The Mewjector setup points at a repo checkout, not at a player's install.

   Authors face a fourth: the editor needs Node, npm and a git checkout. **FACT (repo)**
4. **Lead with what nobody else can do:**
   - 3D models in a 2D fight;
   - coloured unit glows set from data;
   - new statuses with per-turn native logic;
   - new cat animations;
   - campaign rooms;
   - game speed.

   Section 3 proposes 7 showcase mods. Build three first. **INFERENCE**
5. **The audience is large and concentrated.** The game sold 1M copies in about a week, and launch week had over
   100k concurrent Twitch viewers. Northernlion, Zackrawrr and Emiru led the streams. Mod-showcase and how-to-install
   videos already exist. **FACT**
6. **The biggest strategic risk is the developers' own launcher and Steam Workshop** ("eventually", per Tyler Glaiel,
   2026-02-23). Plan to be the best way to *make* Workshop mods. Keep data mods as plain `-modpaths` folders that a
   Workshop item can carry unchanged. **FACT** + **INFERENCE**

## 1. The current landscape

### 1.1 The game and its audience

| # | Finding | Tag | Source (date) |
|---|---|---|---|
| L1 | Released on Steam (Windows) 2026-02-10. 250k copies in under 12 hours, 500k in 36 hours, 1M in about a week. Alinea estimates about $25M gross. | FACT | Game Developer, https://www.gamedeveloper.com/business/mewgenics-has-sold-1-million-copies-worldwide (2026-02); RPG Site, https://www.rpgsite.net/news/19597-mewgenics-500k-copies-sold-sales-numbers-new (2026-02); Notebookcheck (2026-02) |
| L2 | Over 100k concurrent Twitch viewers on release day and 2.36M hours watched in the opening days. Top streamers: Zackrawrr (48k peak), Emiru (24k peak), Northernlion (one of his most popular streams ever by average viewers; Edmund McMillen said he watched it). | FACT | Streams Charts, https://streamscharts.com/news/mewgenics-release-viewership-twitch (2026-02-13) |
| L3 | Northernlion streamed about 109 hours of Mewgenics in 2026, his highest-average game of the year on one tracker. | FACT (one tracker; trackers disagree) | https://twitchstats.net/streamer/northernlion (read 2026-10-22) |
| L4 | Console versions (Switch 2, PS5, Xbox Series) are published by Nicalis, released 2026-09-08. The PC is the only moddable platform. | FACT / INFERENCE | https://en.wikipedia.org/wiki/Mewgenics (read 2026-10-22) |
| L5 | Latest patch line is 1.1.x. We found no September or October 2026 announcement about the launcher or Workshop. | FACT (absence in search) | Steam news for app 686060; GameWatcher patch history (read 2026-10-22) |

### 1.2 The developers and official mod support

| # | Finding | Tag | Source (date) |
|---|---|---|---|
| D1 | Tyler Glaiel, asked about mods: *"Eventually. I want to add an official launcher and workshop support."* The TEIN launcher "would not be Steamdeck Verified"; a new one must wait for time. | FACT | Tweet quoted by Shacknews, https://www.shacknews.com/article/147993/mewgenics-steam-workshop-mod-support (2026-02-24); PC Gamer, Eurogamer (2026-02) |
| D2 | In The End Is Nigh (same engine, same `.gpak`, same overlays), adding Workshop raised sales "by around 1,000%". Glaiel: *"If people are making mods for your game, I highly recommend putting workshop in."* | FACT | https://www.pcgamesinsider.biz/news/69910/the-end-is-nigh-sees-a-sales-increase-of-1000/ (2019-10-29) |
| D3 | TEIN's terms: non-commercial; mods must require the game; no redistributing the exe or unmodified assets. The TEIN page linked a *community* unpacker and recommended a *community* level editor as "way better than the official one". | FACT | https://www.glaielgames.com/teinworkshop/ (undated, read 2026-10-22); see `legal-and-community.md` §2 |
| D4 | The TEIN community editor (Joshua Robertson, itch.io) kept shipping updates until v1.0.21 in January 2022. | FACT | https://jrob774.itch.io/tein-editor/devlog |

**INFERENCE.** D3 and D4 are our best model. This developer has endorsed third-party tools before, by linking to
them from his own page. A community editor that is clearly better than anything official is the role to aim for.

### 1.3 The existing Mewgenics modding scene

| # | Tool / venue | What it is | Tag | Source (date) |
|---|---|---|---|---|
| S1 | **Mewtator** (dancomstock) | Mod manager: enable/disable, dependency rules with semver, auto-sort, launch options, export `.bat` launch scripts, unpack/repack of `resources.gpak`, modlist import/export, multi-language. v0.6.0 (2026-09-09, new UI); v0.5.0 added DLL mods through Mewjector. Nexus mod #1, about 881 endorsements. GitHub repo created 2026-02-13 (three days after launch), 10 stars, no license file. | FACT | https://www.nexusmods.com/mewgenics/mods/1 (via search, 2026-10-22); https://github.com/dancomstock/mewtator (`gh api`, 2026-10-22) |
| S2 | Mewtator mod format | One folder per mod; the folder name is the id. `description.json` (or `info.json`/`modinfo.json`) holds `title`, `author`, `version`, `description`, `url`, `requirements` (e.g. `"CoreFramework>=1.5.0"`) and `dll_order`; an optional `preview.png`. | FACT | `MOD_AUTHOR_GUIDE.md` in the Mewtator repo (read 2026-10-22) |
| S3 | **Mewjector** (githubuser508) | `version.dll` chainloader, MIT. Detects Mewtator and loads its DLL manifest. `Mod1`–`Mod9` load slots are reserved for frameworks it knows about. Last push 2026-10-11. Nexus #218. | FACT | https://github.com/githubuser508/mewjector (2026-10-22) |
| S4 | **Mewgenics Mod Framework** (pilout) | A rival native framework: a NativeAOT C# loader and SDK with an in-game F1 overlay, v1.2.2, about 17 endorsements. Also installs as **`version.dll`**. | FACT | https://www.nexusmods.com/mewgenics/mods/183 (via search) |
| S5 | Save editor + "ModCreator" | MewgenicsSaveEditorV4.2, about 389 endorsements; includes a mod-creation tab. | FACT | https://www.nexusmods.com/mewgenics/mods/20 (via search) |
| S6 | Content mods | "Requires Mewtator" is the norm (e.g. More Rooms #470, Reroll Level ups #31). Popular kinds: Better Difficulties, Better Loot, Set Bonus Tooltips, Bigger Wallet, a Summoner class (#83), a Tactician Collar, a randomizer. Mewtator's page says 175 mods use it. | FACT | Nexus pages via search; `legal-and-community.md` 1.7 |
| S7 | Other loaders | A Vortex extension (Nexus site mod #1691, updated 2026-07-29). EdredBrando/MewgenicsModLoader, which describes itself as "extremely one dimensional" and openly AI-made. | FACT | search results 2026-10-22 |
| S8 | Venues | Community Discord `discord.gg/6utN4YAktp` (linked from Mewjector's page); wiki Discord; official Discord `discord.gg/Mewgenics`; r/Mewgenics; the wiki.gg Modding page (WIP, rev. 2026-05-24). | FACT (links) | wiki.gg Modding page; Nexus #218 |
| S9 | Venues we could not read | Discord channel activity, Reddit threads and Steam forum threads did not come back from fetch or search. | GAP | — |
| S10 | Creator coverage of mods | YouTube has mod showcases ("These Mods Are GAMECHANGERS!", "NEW Summoner BREAKS THE GAME!", "The Mewgenics TACTICIAN Collar Mod Is PEAK", a randomizer video), how-to-install guides, and trainer promos (WeMod/PLITCH). | FACT (titles) | YouTube search results 2026-10-22, e.g. https://www.youtube.com/watch?v=1vuiE8m_Qq4, https://www.youtube.com/watch?v=SMXlT4DQV-8, https://www.youtube.com/watch?v=MNI8SqK_lRw, https://www.youtube.com/watch?v=6TJn-yWDfXg |

**INFERENCE (where we stand).**
- **Players:** Mewtator plus Nexus already won, eight months in. Its maintainer ships regularly and its format is what
  authors know.
- **Native mods:** Mewjector is the de-facto loader, and we already ride it. The C# framework (S4) is our only direct
  competitor at the native layer. It installs as a second `version.dll`, so a player cannot run it and Mewjector
  side by side without a conflict (an INFERENCE from both install guides; not tested).
- **Authoring:** nobody offers a validator, merge preview, art pipeline, room editor, 3D, glow or in-game test
  harness. That gap is ours to fill.

### 1.4 How comparable toolkits became the standard

| Project | How it got there | Lesson for us | Tag / source |
|---|---|---|---|
| **SMAPI** (Stardew) | First release two days after the game launched. A rewrite put backwards compatibility first. It became the dependency nearly every mod needs, and keeps a public mod-compatibility list across game updates. Created 2016-03-02, about 2.8k stars, LGPL. | Be the dependency, and be trusted across updates. Our `port-bindings` pipeline is exactly this capability; publish how fast we port. | FACT: Pathoschild, "SMAPI turns 10", https://www.patreon.com/posts/151853907; SMAPI 2.6 notes; `gh api` 2026-10-22 |
| **tModLoader** (Terraria) | Years as an unofficial tool, then the developer made it a free Steam "DLC" (2020-05-16) and handed "the keys to the fans". | The best end state is the developer adopting or blessing the community tool. That only happens with a good relationship and a clean legal footprint. | FACT: PC Gamer, https://pcgamer.com/terraria-mod-loader-steam-tmodloader (2020); `legal-and-community.md` §3 |
| **BepInEx + r2modman/Thunderstore** (Unity games) | A generic loader, plus a one-click manager tied to one mod site. Players never handle DLLs by hand. | Install friction decides adoption. Players need one-click installs, not a README. | FACT: Thunderstore r2modman listings (v3.2.18, 2026-06-25); https://outward.wiki.gg/wiki/Installing_Mods |
| **Steamodded + Lovely** (Balatro) | Lovely is a tiny `version.dll` injector. Steamodded is the framework and API every content mod declares. Both were open source and Discord-centred, distributed on GitHub, Nexus and Thunderstore. About 1k and 600 stars. | Split the thin injector from the rich framework. We already have this split (Mewjector + `mewframework.dll`). | FACT: https://github.com/Steamodded/smods, https://github.com/ethangreen-dev/lovely-injector (`gh api` 2026-10-22) |
| **REPENTOGON** (Isaac) | Native DLL framework, public since 2023-01. Ships an updater/launcher exe, and keeps a Steam Workshop *pointer page* that says "this is NOT a traditional mod" and links to the installer. Content mods declare it as a requirement. | Workshop can be a discovery channel for a native framework even when Workshop cannot install it. Expect installer friction and "broke after game update" reports. | FACT: https://github.com/TeamREPENTOGON/REPENTOGON, https://steamcommunity.com/sharedfiles/filedetails/3127536138 |
| **Everest** (Celeste) | Code-mod loader plus a one-click installer (Olympus), GameBanana hosting, and a modding channel on the official Discord. | Living next to the developer's community helps legitimacy. | FACT: https://github.com/EverestAPI/Resources/wiki/FAQ |
| **TEIN community editor** | A standalone editor that the developer himself recommended over the official one. | Win authoring, and the developer may point to you. | FACT: D3, D4 |

**INFERENCE (pattern).** Every one of these won on three things:
1. It was there early, or it was clearly better.
2. Content mods *depended* on it.
3. Installing it took one step.

None of them won by marketing alone. Showcase mods help only once a player can install them in one step.

## 2. Gaps blocking adoption today

Checked against the repo at b2e13b7.

### 2.1 For players (someone who just wants to play a mod)

| # | Gap | Evidence | Fix | Effort |
|---|---|---|---|---|
| P1 | **No prebuilt binaries.** `mewframework.dll` and mod DLLs are built locally with w64devkit GCC. There are no GitHub Releases. | FACT: `native/*/build.bat`; `gh repo view` shows no releases | Build the release DLLs in CI (MinGW cross-compile on Linux, or a Windows runner). Attach them to tagged GitHub Releases with SHA-256 sums. **INFERENCE:** reproducible builds plus published source answer the "DLLs run with full privileges" worry that Mewtator's guide raises. | M |
| P2 | **The framework is off without `-savesuffix`.** `framework.c` logs "vanilla launch (no -savesuffix …); framework inactive". The gate exists for the harness, but a Mewtator launch does not add the flag. `engine-map.md` "Save safety" also says the suffix gives **no** save isolation on this build. | FACT: `native/framework/src/framework.c`; `docs/data-mods.md` "Saves" | Owner decision (section 7): keep the gate and document "add `-savesuffix mod` in Mewtator's launch options", or replace it for player builds with an explicit opt-in such as a `mewframework.ini` `Enabled=1`. Either way, keep the build gate (fail closed). | S |
| P3 | **The Mewjector config targets a repo checkout.** `native/chainloader.ini` uses `ScanPath=__REPO__\native\dist`, filled in by `install-mewjector.bat`. | FACT | Ship a player layout: `mewframework.dll` claims a `[LoadOrder]` slot and installs into Mewjector's `mods/` folder or the Mewtator DLL manifest. Ask the Mewjector author for a reserved `Mod1`–`Mod9` framework slot (they reserve those "for framework DLLs it knows about"). | S |
| P4 | **Packs are not Mewtator-shaped.** `pack` writes `mod.json` plus `README-INSTALL.txt` with a raw `-modpaths` line. Mewtator reads `description.json`, `requirements` and `dll_order`, and shows `preview.png`. | FACT: `docs/data-mods.md` "Shipping a mod"; S2 | Have `pack` also write a Mewtator `description.json`: requirements `mewframework>=x.y.z` when native, `dll_order`, `url`. Emit a `preview.png` from a `shot`. Make "install with Mewtator" the first line of the README. | S–M |
| P5 | **No player-facing docs.** The README opens with layers, MCP and RE. There is no "play a mod in 3 steps" page. | FACT: `README.md` | A short `PLAYERS.md` (or a GitHub Pages site) and a Nexus description. Add the "Relationship to the game" section from `legal-and-community.md` §6. | S |
| P6 | **Pinned to one game build.** Every patch disables native mods until the bindings are ported. That is safe (fail closed), but players see "my mod stopped working". | FACT: `docs/binding-port.md` | Publish a compatibility table (SMAPI-style): game build → framework release. Measure and publish the time to port. Have the framework show an in-game or log notice "waiting for an update for build X". | M |
| P7 | **Steam Deck / Proton untested.** The framework and harness are Windows-only and were never run under Proton. Mewjector has a Wine mode. | FACT (absence); S3 | Test one data mod plus glow on Proton. Data mods should just work, since `-modpaths` is the game's own loader (INFERENCE). | M |
| P8 | **Save risk.** Mods that change content can affect saves, and `-savesuffix` is no isolation. | FACT: `engine-map.md` "Save safety" | Every showcase README says "back up your saves folder", and points to a backup step (Mewtator or manual). | S |

### 2.2 For authors (someone who wants to make a mod)

| # | Gap | Evidence | Fix | Effort |
|---|---|---|---|---|
| A1 | **The editor needs a dev setup:** git clone, Node ≥ 22.18, `npm install`, `npm run build:index`, `npm run build`, `npm run web`. | FACT: `CLAUDE.md`, README | A **portable editor release**: one zip with a pinned Node runtime, the built web UI and a `Start Editor.bat` that indexes the user's own game install on first run. No game data is shipped, so the "bring your own copy" rule holds. | M–L |
| A2 | **Non-programmer docs are missing.** The docs are deep RE and contract notes (`engine-map.md`, `data-mods.md`). There are no task tutorials ("make a new ability in 10 minutes"). | FACT | 5–6 short illustrated tutorials, one per template kind (`ability`, `room`, `glowing-character`, `particle`, cat animation, 3D model). Re-use the web UI's built-in tours and worked examples. | M |
| A3 | **Native authoring is C with GCC**, while the rival framework offers C# with IntelliSense (S4). | FACT | Keep C, since its ABI is stable and append-only. Add a `native/mods/template/` with one-command build, and **expose more from data** (glow v3 already shows the pattern: a `FwGlow_` status with no DLL). Every feature that becomes data-driven removes this gap for most authors. | M per feature |
| A4 | **The in-game harness needs this repo's setup**, and parts of it are dev-only. | FACT | Keep it as the "pro" feature. Document `run_ingame_test` for authors who already use Claude Code. | S |
| A5 | **The AI angle needs care.** The MCP server is a real differentiator for agent users. Part of the community is wary of AI-made tools, and one loader on GitHub carries an AI disclaimer (S7). | FACT (S7) / INFERENCE (sentiment; we could not read the Discord or Reddit, S9) | Present the web UI and validator first, and the MCP server as an extra. Be transparent about AI-assisted development; do not hide it, do not lead with it. Owner decision. | — |

## 3. Showcase mod slate

Selection rule (**INFERENCE**): each mod must
1. be visibly impossible with plain data mods, or with Mewtator alone;
2. read in a 10-second clip;
3. contain no game assets (all art, models and sounds original);
4. install in one step once P1–P4 are done.

"Status" uses the feature-inventory tags. OBSERVED means proven in the real game; DOC means documented, never run.

| # | Mod | The hook (what a viewer sees) | Demonstrates | Toolkit features | Status of the features | Effort |
|---|---|---|---|---|---|---|
| 1 | **Aura Cats** | Every cat and enemy gets a coloured rim by element or status: burning = orange, poisoned = green, a boss = pulsing magenta. Pure data, no DLL authored. | The data/native seam: data asks, the framework draws. | `FwGlow_<rrggbb>` statuses, timed glow, `glowing-character` template, `fw-glow` shader, validator `invalid-glow-name` | OBSERVED (glow v1–v3, data-glow, data-glow-expiry); open T3 looks on the clover icon and hover rim | **S** |
| 2 | **Turbo Fights** | Hold a key or toggle 2×/4×/8×; the same fight plays out, just faster. Streamer quality of life on long runs. | Native mechanics the game lacks, with identical updates (a seeded fight is the same fight). | `FW_SetTimeScale` / `FW_GetTimeScale`, a small native mod with a hotkey, Mewtator `requirements` | Speed engine OBSERVED via the harness `speed` directive; the hotkey input hook is **new work** | **M** |
| 3 | **Paper Cats, Real Boxes** (3D in a 2D fight) | Real 3D crates, pillars and a slowly spinning 3D yarn-ball "boss" in a hand-drawn fight. They are occluded correctly behind and in front of units, and the units cast their colours on them. | Something no other Mewgenics tool can do; the most clip-worthy item. | `graphics.model` on units, `FW_Place3DObjectOnTile`, OBJ/glTF/GLB loaders, palette rule, painter-order occlusion, Blender export recipe | Phase M OBSERVED (Crate, pillar); `hide_sprite`, facing yaw and `.glb` textures are in **open PR #138**; no animation or skins yet | **M** (static props) / **L** (an animated boss needs skins) |
| 4 | **Joker's Wild** status pack | 5–6 chaos statuses with real per-turn logic: luck reroll (exists), "Swap places with a random ally", "Gain a stack each time you are missed", and so on, each with tooltips and loc. | New status *mechanics*, not recombinations; the full data plus native loop. | `FW_RegisterStatus`, `FW_SetStatusStacks`, `FW_CharacterHasStatus`, `FW_Random`, `status-data` template, `keyword_tooltips` + `combined.csv` | JokersLuck OBSERVED; each new status needs its own host test and `.mewtest` | **M** |
| 5 | **Victory Dance** (new cat animations) | Cats wave, dance or bow after a win, or as a new idle, made from each cat's *own* parts, so every mutant cat dances in its own body. | The cat rig and animation pipeline, which is the hardest art problem in this game. | Cat animations `<name>F/B` with empty slot sprites, `alt_animations`, back-facing rig, Art mode Rig and Timeline tabs, ghost-cat preview | Wave OBSERVED (`--cat-wave`); back facing OBSERVED; four-way quartet DOC only; **T3 look pending** (`pr76-wave-in-game`) | **M** |
| 6 | **The Junkyard** (room and tileset pack) | 8–12 new hand-built fight rooms in a new tileset, drawn into the real campaign pool, plus one new particle aura and one new sound. | A non-programmer could make this in the web UI (Rooms mode). This mod sells the *editor*. | Rooms mode, `.lvl` codec, `alley.gon.merge` level pools, new tileset, `particles.gon.append`, sound groups, the `lvl-*` validator | All OBSERVED (`_roomprobe` walk-battle, new-tileset; `_vfxprobe`; `_audioprobe`). Differentiate from Nexus "More Rooms" (#470) by theme and by the tutorial video | **S–M** |
| 7 | **Rival Gang** (a new enemy family) | A new three-enemy family with original SWF art, its own death VFX, sounds, glow and one 3D prop: everything at once, as the "made with the toolkit" capstone. | The whole pipeline: art scenes to SWF, fonts and loc, particles, audio, validator, `pack`. | Art mode (shapes, sprites, timeline, PNG import), `build_swf`, character templates, particles, audio, glow, optional model, `pack_mod` | All components OBSERVED individually; never combined in one mod | **L** |

**Recommended first three: 1, 6, 3.**
- **Aura Cats** is the quickest proof.
- **The Junkyard** proves the *editor* to would-be authors. Pair it with a "make your own room" video.
- **Paper Cats, Real Boxes** is the headline clip.

Turbo Fights (2) is the best *streamer quality-of-life* mod and could replace 1 if the hotkey work is small.
(**INFERENCE**)

Excluded on purpose: anything multiplayer, anything that edits saves, trainer or cheat-style mods (the trainer niche
is taken, see S10, and it is off-brand), and any tribute that copies Isaac or other McMillen assets.

## 4. Creator outreach plan

Do no outreach until phase 2 exit (section 5): working one-step installs and at least two finished showcase mods.

### 4.1 Who

| Tier | Who | Why | Tag |
|---|---|---|---|
| A: reach, low odds | Northernlion, Zackrawrr, Emiru | The launch-week leaders (L2, L3). Northernlion has a long Isaac history, played 109 hours of Mewgenics, and Edmund watched his stream. | FACT (numbers) / INFERENCE (fit) |
| B: best odds | Mid-size YouTubers who already make **Mewgenics mod showcases and how-to-install videos** (S10). | They already cover mods, their audience is exactly our players, and they need fresh mods to show. | FACT (videos exist) / **GAP**: channel names did not come through search; collect them by hand from the video pages |
| C: community | Nexus curators ("Mods of the Month"), the wiki.gg Modding page editors, the modding Discord (S8), r/Mewgenics | A wiki link and a Nexus feature last longer than one video. | INFERENCE |
| D: ecosystem | Mewtator's maintainer (dancomstock), Mewjector's author (githubuser508) | Not "creators", but the people whose tools our mods ride on. Talk to them first: a broken install in front of a creator is worse than no video. | INFERENCE |

### 4.2 What creators need (INFERENCE, from how the S10 videos are framed)

- **A ready download:** one Nexus page per mod, installable through Mewtator, plus a 3-line install box. Tested on a
  clean Steam install, not on the owner's machine.
- **A hook in the title:** "3D in Mewgenics?!", "Every cat glows now", "I made cats dance". The slate's hook column
  is written for this.
- **A press kit per mod:** 3–4 GIFs and shots (the harness `shot` and the T3 gallery already produce these), a
  20-second clip, a one-paragraph description, the requirements, and a known-issues line.
- **Safety and legitimacy lines:** "Single-player, does not touch your saves' format, back up anyway, no game files
  included, unofficial and unaffiliated." Creators avoid recommending things that could break viewers' saves.
- **A direct contact** for the day they record, so a broken install gets fixed within hours.

### 4.3 Timing

- **Good windows:** right after a game patch, *once we have ported* (show the port speed); around the DLC news cycle
  (DLC 1 targeted "end of next year maybe", D1/1.2 in the legal doc); and slow weeks when creators are looking for
  Mewgenics content to make.
- **Avoid:** the week of a big official patch, before our port lands; and the official launcher or Workshop launch
  week. Plan to *join* that moment (section 6), not to compete with it.
- **Sequence:**
  1. tell the developers first (the heads-up in `legal-and-community.md` §5.6, owner's call);
  2. then the Mewtator and Mewjector maintainers;
  3. then the Nexus release;
  4. then tier B and C creators;
  5. then a single, low-key note to tier A, with the best existing video attached.

### 4.4 The message

Owner-approved text only. Draft skeleton for tier B:

> Hi <name>, I saw your <video> on Mewgenics mods. I've made a free mod that <hook>. It's on Nexus and installs
> through Mewtator in one click. GIFs and a 20 s clip are here: <link>. It's single-player, ships no game files, and I'm
> around to fix anything if you try it. No strings attached.

Never offer payment, and do not ask for coverage. Keep it non-commercial, in line with the TEIN terms (D3).

## 5. Phased milestones

The order matters: install before showcases, and showcases before outreach.

| Phase | Goal | Deliverables | Exit criterion |
|---|---|---|---|
| **0. Groundwork** (≈1–2 weeks) | Settle the stance and the decisions | Owner answers section 7; README "Relationship to the game" section (`legal-and-community.md` §6); `PLAYERS.md` draft; optional heads-up to Tyler Glaiel | Decisions recorded in `TODO.md` "Open decisions" |
| **1. One-step install** (≈2–4 weeks) | A player with Steam and Mewtator can run a native-backed mod | CI release builds of `mewframework.dll` (P1); the player-mode gate (P2); a Mewjector slot or manifest install (P3); `pack` emits a Mewtator `description.json` + `preview.png` (P4); a compatibility table (P6) | A clean-machine test passes: a fresh Windows user follows only the Nexus page and sees Joker's Luck working |
| **2. Showcase wave 1** (≈3–5 weeks) | Three mods worth a video | Aura Cats, The Junkyard, Paper Cats Real Boxes (with #138 merged); press kit per mod; Nexus pages under the framework as a requirement | Each mod: T2 green, T3 looks ticked, installed from Nexus on a clean machine |
| **3. Ecosystem and creators** (≈2–4 weeks, overlaps 2) | Visibility | Talk with the Mewtator and Mewjector maintainers; post in the modding Discord; get listed on the wiki.gg Modding page; tier B/C outreach | ≥ 1 independent video or wiki listing; first third-party mod that declares `mewframework` as a requirement |
| **4. Authors** (≈4–8 weeks) | Others build with it | Portable editor release (A1); 5–6 task tutorials (A2); a native mod template (A3); a "Made with mewgenics-mods" tag on Nexus | ≥ 5 third-party mods made with the editor or depending on the framework |
| **5. Showcase wave 2 and Workshop readiness** (ongoing) | Stay the standard when official support lands | Turbo Fights, Joker's Wild, Victory Dance, Rival Gang; a Workshop-ready export (section 6) | When Workshop ships: an editor update the same week that publishes to it |

**Metrics (INFERENCE; pick a few):**
- Nexus unique downloads of the framework;
- number of Nexus mods that list `mewframework` as a requirement;
- time from a game patch to a ported framework release;
- GitHub stars and issues from people outside the project;
- Discord mentions.

## 6. Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | **The official launcher or Workshop makes our distribution obsolete.** D1 says "eventually". The Steam Deck Verified constraint suggests the official path will favour data mods and may not run DLLs at all. Steam Workshop is enabled by the developer, so a third party cannot add it (INFERENCE from how Steamworks works; FACT for TEIN, where the developer added it). | High likelihood within 12–18 months / high impact on *distribution*, low on *authoring* | **Align, don't compete.** (a) Keep data mods as plain `-modpaths` folders, the format the official loader already reads; avoid any packaging the game cannot read. (b) Position the editor as "the best way to make Workshop mods": the validator, merge preview, art, rooms and harness all stay useful. (c) Make the native framework *optional*, with a REPENTOGON-style Workshop pointer page if DLLs are not allowed there. (d) Offer the developers our export and validator code (MIT), and be ready to drop our own install path the day theirs is better: the tModLoader and TEIN-editor path. (e) Never brand our tooling "official" or "the launcher". |
| R2 | **Mewtator ships its own editor features**, or the C# framework (S4) wins native authors | Medium / medium | Cooperate. Emit Mewtator's format, link Mewtator as the player tool, and offer our validator as a library or CLI it can call. On the native side, compete on data-driven features (glow v3 style), 3D and status depth, and avoid the `version.dll` clash (P3). |
| R3 | **Game patches break native mods** (build-pinned) | Certain, recurring / medium | Fail closed (already); the port-bindings pipeline; a public compatibility table and port-time metric; harvest anchors before every update. |
| R4 | **Legal or developer pushback**, including Nicalis's history of DMCAs on decompiled code | Low if the rules hold / high | Follow `legal-and-community.md`: no assets, no decompiles, non-commercial, owning the game required, single-player only. A pack-time check that no vanilla art is embedded (item H there). Consider the heads-up before any public push. |
| R5 | **A save is lost on stream** | Low / very high reputational damage | Showcase mods do not change save-relevant data shapes; every README says back up; test each mod on a used save copy; the framework writes nothing to saves. |
| R6 | **DLL trust**: players are told "DLLs run with full privileges" | Medium / medium | Open source, CI-built releases, published hashes, no network access in the framework; consider code signing later. |
| R7 | **Perception of AI-made tooling** | Unknown (GAP S9) / medium | Lead with the human-facing UI and the results. Be honest about AI-assisted development when asked. A human answers in community channels. |
| R8 | **Bus factor**: one owner; agent-driven development | High / high for "standard" status | Lower it: contributor docs, `good first issue` labels, a co-maintainer from the community (e.g. a Mewtator or Mewjector contributor). Standards outlive their founders only with more than one maintainer (SMAPI changed hands early, §1.4). |
| R9 | **Over-promising 3D** (preview, no animation) | Medium / medium | Label it "preview" and use static props in the showcase; no animated-boss promise until skins exist. |

## 7. Decisions for the owner

1. **Positioning.** Agree that we are the *authoring toolkit + native framework* and ship through Mewtator, Mewjector
   and Nexus, instead of building our own mod manager or launcher.
2. **The player-mode gate.** Keep "framework only on `-savesuffix`" (and document the Mewtator launch option), or add
   an explicit opt-in for player builds (P2)?
3. **Release binaries.** Approve CI-built, tagged GitHub Releases of `mewframework.dll` and showcase DLLs (P1).
   Code signing: now, later or never?
4. **Developer heads-up first?** Send the `legal-and-community.md` §5.6 note to Tyler Glaiel before any public push:
   yes, no, or after phase 2.
5. **First three showcases.** Approve Aura Cats + The Junkyard + Paper Cats Real Boxes, or swap in Turbo Fights.
6. **Where we live.** A Nexus author account and pages under the owner's name. Join the existing modding Discord
   rather than starting our own?
7. **AI transparency line.** How the README and Nexus pages describe AI-assisted development and the MCP server.
8. **Outreach.** The owner sends every message personally, unpaid. Approve the tier order (D → C → B → A) and the
   message skeleton (§4.4).

## Sources (all read or searched 2026-10-22 unless dated)

- Mewtator: https://www.nexusmods.com/mewgenics/mods/1 (via search) · https://github.com/dancomstock/mewtator · `MOD_AUTHOR_GUIDE.md`
- Mewjector: https://github.com/githubuser508/mewjector · https://www.nexusmods.com/mewgenics/mods/218
- Mewgenics Mod Framework: https://www.nexusmods.com/mewgenics/mods/183 (via search)
- Save editor: https://www.nexusmods.com/mewgenics/mods/20 · More Rooms: /mods/470 · Reroll Level ups: /mods/31 · Vortex extension: https://www.nexusmods.com/site/mods/1691
- Other loader: https://github.com/EdredBrando/MewgenicsModLoader
- Wiki Modding page (rev. 2026-05-24): https://mewgenics.wiki.gg/wiki/Modding
- Sales: https://www.gamedeveloper.com/business/mewgenics-has-sold-1-million-copies-worldwide · https://www.rpgsite.net/news/19597-mewgenics-500k-copies-sold-sales-numbers-new · https://www.notebookcheck.net/Mewgenics-has-surpassed-one-million-copies-sold-in-just-a-week-generating-over-23-million-in-revenue.1228640.0.html
- Twitch: https://streamscharts.com/news/mewgenics-release-viewership-twitch (2026-02-13) · https://twitchstats.net/streamer/northernlion
- Official mod support: https://www.shacknews.com/article/147993/mewgenics-steam-workshop-mod-support (2026-02-24) · https://www.pcgamer.com/games/roguelike/mewgenics-is-getting-official-mod-support-and-could-have-dlc-out-by-the-end-of-next-year/ · https://www.gosugamers.net/entertainment/news/78037-mewgenics-devs-tease-mod-support-and-first-post-launch-dlc-content
- Patches: https://store.steampowered.com/news/app/686060 · https://www.gamewatcher.com/mewgenics-patch-notes-and-roadmap-of-updates
- YouTube (titles): https://www.youtube.com/watch?v=1vuiE8m_Qq4 · https://www.youtube.com/watch?v=_kezEobxkKU · https://www.youtube.com/watch?v=SMXlT4DQV-8 · https://www.youtube.com/watch?v=MNI8SqK_lRw · https://www.youtube.com/watch?v=T74qG_qneSo · https://www.youtube.com/watch?v=6TJn-yWDfXg · https://www.youtube.com/watch?v=Zr2BPjC6TNY
- TEIN: https://www.glaielgames.com/teinworkshop/ · https://www.pcgamesinsider.biz/news/69910/the-end-is-nigh-sees-a-sales-increase-of-1000/ (2019-10-29) · https://jrob774.itch.io/tein-editor/devlog
- SMAPI: https://www.patreon.com/posts/151853907 · https://smapi.io/
- tModLoader: https://pcgamer.com/terraria-mod-loader-steam-tmodloader · https://github.com/tModLoader/tModLoader/releases/tag/v0.11.7
- BepInEx / r2modman: https://github.com/BepInEx/BepInEx · https://thunderstore.io/c/house-of-legacy/p/ebkr/r2modman/v/3.1.24/versions · https://outward.wiki.gg/wiki/Installing_Mods
- Balatro: https://github.com/Steamodded/smods · https://github.com/ethangreen-dev/lovely-injector
- REPENTOGON: https://github.com/TeamREPENTOGON/REPENTOGON · https://steamcommunity.com/sharedfiles/filedetails/3127536138
- Everest: https://github.com/EverestAPI/Everest · https://github.com/EverestAPI/Resources/wiki/FAQ
- GitHub stats: `gh api repos/<owner>/<repo>` on 2026-10-22 (stars, created and pushed dates, licenses).
- In-repo: `docs/feature-inventory.md` (branch `docs/feature-inventory`), `docs/legal-and-community.md` (PR #137), `native/framework/src/framework.c`, `native/chainloader.ini`, `docs/data-mods.md` "Shipping a mod".
