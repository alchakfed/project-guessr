# ProjectGuessr — GeoGuessr for your own Minecraft worlds

Take 360° panoramas in-game (logged with their exact coordinates), stitch your
JourneyMap exploration into a map, and play a GeoGuessr-style guessing game —
solo or multiplayer with friends on your network.

This is modeled on the fan-made **HermitGuessr** (Hermitcraft GeoGuessr), which
used [Pannellum](https://pannellum.org/) for the 360° viewer and
[Leaflet](https://leafletjs.com/) for the guess map. ProjectGuessr copies that
stack but sources its data from **your** world: panoramas from a purpose-built
Fabric mod, and the map from **JourneyMap** tiles.

```
project guessr/
├── mod/     Fabric mod (MC 1.21.11): capture panoramas + log coordinates
├── tools/   Node scripts: trim JourneyMap, stitch map, build manifest, compress panoramas, roam graph
└── web/     Node web app: Pannellum + Leaflet, multiplayer rooms (no accounts)
```

## Why a custom mod?

The [panorama-screenshot](https://modrinth.com/mod/panorama-screenshot) mod can
already save the six vanilla `panorama_0..5.png` faces, **but it does not record
where each shot was taken.** GeoGuessr needs the answer — the world coordinate.
So this mod triggers the same built-in vanilla panorama capture *itself*, writes
each set into its own folder, and appends the player's `(x, y, z)` + dimension to
a log (`captures.jsonl`). It also adds the requested **auto-capture every N
blocks** toggle and an on-screen **HUD indicator**.

---

## Prerequisites

- **Java 21** (to build the mod).
- **Node.js 18+** (for `tools/` and `web/`).
- **Minecraft 1.21.11** with **Fabric Loader**, **Fabric API**, and **JourneyMap**.
- Internet access for the *first* `gradlew build` and `npm install`.

---

## Step 1 — Build & install the mod

```powershell
cd mod
# The wrapper jar downloads on first run; if you don't have one, run once:
#   gradle wrapper --gradle-version 8.14
./gradlew build
```

Copy `mod/build/libs/projectguessr-1.0.0.jar` into your `.minecraft/mods/`
folder, alongside **Fabric API** and **JourneyMap**.

> **First-compile note (mappings):** the mod calls Minecraft's built-in panorama
> method via an `@Invoker` in `GameRendererAccessor.java`. If the build fails
> saying the invoker doesn't match, open the 1.21.11 mappings
> (`./gradlew yarn` launches Enigma, search **"panorama"**) and update the method
> name/signature in that one file. See the comments in
> `GameRendererAccessor.java` and `PanoramaCapture.java` for the fallback.

### Controls (rebindable in Options → Controls → ProjectGuessr)

| Key | Action |
|-----|--------|
| `F4` | Take one 360° panorama at your current spot |
| `G`  | Toggle **auto-capture** (fires every 5 blocks you walk) |

The HUD (top-left) shows `Auto-capture: ON/OFF` and the session shot count.
Interval and panorama resolution are configurable in
`.minecraft/config/projectguessr.json`.

### What the mod writes

Under `.minecraft/screenshots/projectguessr/`:

```
captures.jsonl                  # one line per shot: id, x, y, z, yaw, pitch, dimension, world
pano_000000/panorama_0..5.png   # the six vanilla cubemap faces
pano_000001/panorama_0..5.png
...
```

---

## Step 2 — Explore & capture

1. Load your world with JourneyMap active and **walk around the areas you want in
   the game** — JourneyMap only maps terrain you've actually seen.
2. Take panoramas: press `F4` at interesting spots, **or** press `G` and just
   walk to auto-capture every 5 blocks.

More exploration = a more complete guessing map. More panoramas = more rounds.

---

## Step 3 — Prepare the game data

```powershell
cd tools
npm install
```

**3a. (Optional) Snapshot just the surface JourneyMap tiles.**
A fully-explored JourneyMap folder can be 20+ GB — most of it is `.mca`/`.jmc`
region caches and underground cave-layer renders the game never needs. This
tool **copies only the surface tiles** (`day/night/topo/biome`) into a small
local folder, leaving your in-game JourneyMap data untouched. Dry-run by
default; add `--apply` to actually copy.

```powershell
# Dry-run: report what would be copied and how big it is.
node trim-journeymap.js --input "$env:APPDATA\.minecraft\journeymap"
# Copy surface tiles into ../journeymap-surface (override with --out).
node trim-journeymap.js --input "$env:APPDATA\.minecraft\journeymap" --apply
```

**3b. Stitch your JourneyMap tiles into one map image + coordinate metadata.**
Point `--input` at the tiles folder for ONE dimension (use the trimmed snapshot
from 3a if you made one).

```powershell
node build-map.js --input "$env:APPDATA\.minecraft\journeymap\data\sp\MyWorld\overworld"
# ...or the trimmed snapshot from 3a (multiplayer worlds live under data\mp\<server>):
node build-map.js --input "..\journeymap-surface\data\sp\MyWorld\overworld\day"
```

**3c. Build the answer-key manifest from the mod's capture log.**
Auto-detects the `screenshots/projectguessr` folder; override with `--captures`.

```powershell
node build-manifest.js --dimension minecraft:overworld
# ...or point at a non-default captures folder:
node build-manifest.js --dimension minecraft:overworld --captures "$env:APPDATA\.minecraft\screenshots\projectguessr"
```

**3d. Copy the panorama images into the web app.**

```powershell
node copy-panoramas.js
# ...or a non-default captures folder:
node copy-panoramas.js --captures "$env:APPDATA\.minecraft\screenshots\projectguessr"
```

**3e. Compress the panoramas.**
The vanilla faces are 1024px PNGs (~32 MB per spot) — far more than a 360°
viewer needs. This re-encodes each face to WebP at a smaller resolution,
typically **−96%** on disk with no visible loss. Dry-run by default; add
`--apply` to overwrite. On apply it deletes the original when the extension
changes (`.png` → `.webp`), so set `PANO_FACE_EXT: 'webp'` in
`web/public/js/config.js` to match.

```powershell
node compress-panoramas.js --apply --size 720
```

**3f. (Optional) Build the free-roam movement graph.**
For Street-View-style navigation arrows between nearby capture spots. Reads the
manifest coordinates and writes `web/public/links.json` containing only
**relative bearings + distances** — never absolute world coordinates — so
players can't read the answer out of it. Requires `ENABLE_MOVEMENT: true` in
`config.js`.

```powershell
node build-links.js
node build-links.js --radius 8 --max-links 4
```

Outputs land in `web/public/`: `map/map.png`, `map/map-meta.json`,
`manifest.json`, `panoramas/<id>/…`, and (if you ran 3f) `links.json`.

> JourneyMap's on-disk layout varies slightly by version. If `build-map.js` finds
> no tiles, open the `journeymap/data/sp/<world>/` folder and point `--input` at
> the subfolder that directly contains files named like `0,0.png`, `-1,2.png`.
> Flags `--region-blocks` and `--tile-size` cover non-default configs.

---

## Step 4 — Play

```powershell
cd web
npm install
node server.js
```

Open **http://localhost:3000**. Enter a name, **Create room**, share the 4-letter
code. Friends on your network open `http://<your-LAN-ip>:3000`, **Join** with the
code. Host presses **Start**. Each round: look around the 360° panorama, click the
map to drop a pin, hit **Guess**. Closest to the real spot scores up to 5000.

If you built the movement graph (Step 3f), the panorama shows **Street-View-style
arrows** to nearby spots — click to roam the path while keeping your current look
direction. Scoring always uses the **round's starting spot**, and a **Back to
start** button returns you there. Toggle the whole feature with
`ENABLE_MOVEMENT` in `config.js`.

Single-player just works too — a room of one.

---

## How scoring works

Euclidean distance in blocks between your guess and the true `(x, z)`, mapped to
0–5000 with exponential falloff scaled to your map's size (see
`web/game.js#scoreGuess`). Land exactly on it → ~5000; a world away → ~0.

## Notes & tuning

- **Panorama looks rotated / seams misaligned?** Adjust
  `MC_FACE_FOR_PANNELLUM_SLOT` / `FACE_ROTATION` at the top of
  `web/public/js/game.js`. That's the only place face order is defined.
- **Movement arrows point the wrong way?** The bearings in `links.json` are in
  world space; align them to the viewer with a single `PANO_YAW_OFFSET` in
  `config.js` (e.g. set it to `180` if forward and back are swapped).
- **Panoramas too big / too small?** Re-run `compress-panoramas.js --apply
  --size <px>` (default 720). Keep `PANO_FACE_EXT` in `config.js` matching the
  `--format` you encoded to (`webp` by default).
- **Run fully offline?** The page loads Pannellum/Leaflet from CDNs. To vendor
  them, download into `web/public/vendor/` and update the `<link>`/`<script>`
  tags in `index.html`. See the comment there.
- **The server never sends a round's true coordinates to the client** until the
  round is scored — so players can't peek at the answer in devtools.

## Credits & licenses

- Design inspired by **HermitGuessr** (Pannellum + Leaflet approach).
- Panorama capture reuses Minecraft's own vanilla code, the same approach as the
  GPL-3.0 **panorama-screenshot** mod. The mod in `mod/` is therefore licensed
  **GPL-3.0-or-later** (see `mod/LICENSE`).
- **JourneyMap**, **Pannellum**, **Leaflet**, **Fabric** are the property of
  their respective authors.
