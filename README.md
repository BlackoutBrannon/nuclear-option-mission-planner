# Nuclear Option Mission Planner

Loads a Nuclear Option mission file and draws it on the real game terrain, in
APP-6 symbology, with filtering and hover identification.

## Running it

**Double-click `start.bat`.** It serves this folder and opens the planner.
Close that window to stop the server.

Or do it by hand:

```
cd "path\to\Mission planner"
python -m http.server 8000
```

Then open <http://localhost:8000>.

**Opening `index.html` directly will not work.**

Browsers treat a file opened from disk as its own isolated origin and block
`fetch` across that boundary, so `units.json` cannot load from a `file://` page.
Images are exempt, which is why the basemap appears but the names do not. The
symptom is every unit showing its raw key — `SPAAG1` rather than
"AeroSentry SPAAG" — and a CORS error in the console.

`Ctrl+C` stops the server.

## Files

| | |
|---|---|
| `index.html` | Page structure only — the elements the app looks up by id. |
| `style.css` | All layout and appearance. |
| `src/*.js` | The application, in numbered parts. No framework, no build step. |
| `terrain/` | Elevation for line-of-sight masking. Generated. |
| `tiles/` | Detail imagery as a resolution pyramid. Generated. |
| `ranges.json` | Radar, optical and weapon envelopes per unit type. Generated. |
| `units.json` | Display names and descriptions per unit type. Generated. |
| `*_overview.png` | Basemaps, produced by the terrain capture tool. |
| `start.bat` | Starts the local server and opens the planner. |
| `tools/serve.py` | That server. Nothing else opens a browser. |
| `tools/extract_units.py` | Regenerates `units.json` from the game's own files. |
| `tools/extract_ranges.py` | Regenerates `ranges.json` from the decompiled assembly. |
| `tools/make_terrain.py` | Regenerates `terrain/` from a capture's elevation raster. |
| `tools/make_tiles.py` | Cuts `tiles/` from the capture's imagery. |
| `tools/make_symbol_sheet.py` | Builds `symbols.html` from the tables in `src/`. |

The parts under `src/` are **plain scripts sharing one global scope**, not ES
modules, listed in `index.html` in the order they must load. A name declared in
an earlier part is visible in every later one, so order is significant: top-level
code can only use what the parts above it have already declared. That is also
why the two start-up fetches are kicked off at the end of the last part rather
than beside the functions that define them — an async continuation must not run
before the parts it calls into exist.

They load at the end of `<body>`, so every element they look up already exists
and no `DOMContentLoaded` wrapper is needed. `vendor/milsymbol.js` loads first
and provides the global `ms`.

| part | |
|---|---|
| `01-boot.js` | Unit catalogue and threat data, map registry, canvas. |
| `02-windows.js` | The floating window factory and the three windows. |
| `03-view.js` | Map transforms, own-ship state, formatters. |
| `04-units.js` | Reading units out of a mission and classifying them. |
| `05-symbols.js` | MIL-STD-2525 symbology and the bullseye rose. |
| `06-threat.js` | Threat rings: what each unit projects, and drawing them. |
| `07-terrain.js` | Elevation, line-of-sight masking, ring labels and hit tests. |
| `08-flights.js` | Flights, routes, targets, release points and the plan file. |
| `09-tools.js` | Manual range rings and the measuring tool. |
| `10-layers.js` | Factions, the layer tree, detail tiles, and `draw()`. |
| `11-input.js` | Hover, status bar, menus, panel rendering, pointer input. |
| `12-briefing.js` | Briefing sheet, image and kneeboard exports, and start-up. |

## Regenerating the unit catalogue

After a game patch adds or renames units:

```
cd tools
python extract_units.py
```

It reads `resources.assets` from the game install and every installed workshop
mission, and reports anything it could not resolve rather than guessing. Names
it cannot find are hand-supplied in `NAME_OVERRIDES` at the top of that script,
and those survive re-running it.

It deliberately does **not** extract weapon or radar ranges. Descriptions
sometimes quote a figure, but that is prose describing detection, not the range
at which a launcher commits a missile. Anything driving a threat ring needs a
structured source.

## Basemaps

`Heartland_overview.png` and `Ignus_overview.png` come from the terrain capture
plugin in the sibling `Terrain capture` project, which extracts georeferenced
elevation and imagery from the running game. The map bounds hardcoded in `MAPS`
are the measured extents from that work.

## Coordinates

Mission files store positions in metres on a flat plane — `x` east, `z` north,
`y` altitude. `toScreen` converts those to pixels, and flips the vertical axis
because screen `y` grows downward while world `z` grows north.
