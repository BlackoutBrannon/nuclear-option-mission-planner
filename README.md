# Nuclear Option Mission Planner

Plan a strike before you fly it.

Drop a Nuclear Option mission file in and the planner draws every unit on the
real game terrain in APP-6 symbology, then works out what can actually see and
shoot you. The threat rings are not estimates: the detection maths, the weapon
envelopes and the target-speed limits are read out of the game's own code, and
every ring is cut back by line of sight against the real elevation data, so a
SAM behind a ridge shows the gap instead of a circle.

From there you can lay out a route, mark targets, place release points, and get
times of flight for the munition you are actually carrying - then export a
briefing your flight can read on a second monitor or on paper.

## Planned: waypoints on the HUD

The next piece is a BepInEx mod that reads a plan straight into the cockpit, so
the steerpoints and targets you set here appear on the pilot's HUD in game
instead of being memorised or kept on a kneeboard.

The groundwork is already in place. Every exported plan carries a `nav` block
using the game's own coordinate layout, so the mod needs no conversion, and the
desktop app can write that file to a folder the mod watches. The game has no
native pilot navigation system, so the mod has to draw the symbology itself -
that is the work still to do.

## What it does

**Threats**
- Radar, optical/IR and weapon envelopes per unit, taken from the game's own
  detection model rather than from unit descriptions
- Rings scale with your aircraft's radar cross-section and altitude, and only
  radar rings respond to RCS - infrared and optical do not
- Line-of-sight masking against real terrain, so rings are cut where the ground
  blocks them
- Radar horizon, and sensor mast height per unit
- A layer tree to ring exactly what you care about on a 900-unit mission

**Routes**
- Multi-leg flights with a per-waypoint altitude
- Every leg coloured by exposure: clear, seen, engaged, or below ground
- A warning when a waypoint is inside a hill rather than over it
- Bullseye with a range-and-bearing rose, plus a measuring tool

**Weapons**
- Release points with time of flight to each target, per munition
- Flight models ported from the game: rocket motors, glide, ballistic and guns
- Whether the weapon itself is seen or engageable on the way in, using its own
  signature and speed - a fast, small missile is often untouchable where the
  aircraft is not

**Exports**
- Plan file to share or reload, carrying a `nav` block for external tools
- Printable briefing sheet: route table, detection events, times of flight,
  targets and the threat basis
- High-resolution map image with a caption recording what it was measured
  against
- Plain-text kneeboard card, sized to paste into chat

## How to use it

1. **Get a mission file.** Use the Mission Scanner, or take one from
   `steamapps/workshop/content/2168680`.
2. **Open it** - click the drop zone, or drag the file onto it.
3. **Pick your side** in *Your faction*. Everything hostile and friendly is
   decided from this.
4. **Set your aircraft** at the bottom: RCS preset and altitude. Every threat
   ring is drawn against these two numbers.
5. **Ring the threats** in the *Rings* panel. *Long range* is a good start; it
   rings everything reaching past 15 km.
6. **Draw a route** in *Flights* - New flight, then click along the map.
   Double-click or Escape to finish. Drag a waypoint to move it.
7. **Mark targets** by right-clicking a unit, or the map for a point target.
8. **Add a release point**: tick a waypoint as RP, choose the munition, and
   pick which targets it services. You get a time of flight for each.
9. **Export** from the Plan section: Plan, Sheet, Image or Card.

Right-click a unit for its details and to place the bullseye. Hover anything to
identify it. The status bar shows your position, the ground elevation under the
cursor and your height above it.

## Reporting a bug

Open an issue:
<https://github.com/BlackoutBrannon/nuclear-option-mission-planner/issues>

What makes a report easy to act on:

- **The mission file**, or its name if it came from the workshop. Most problems
  are specific to one mission's contents.
- **What you expected and what happened.** For a ring or a time of flight, the
  unit or munition involved, and your RCS and altitude at the time - those two
  change every envelope on screen.
- **A screenshot**, or the exported briefing image, which records the RCS,
  altitude and whether terrain masking was on.
- **Which build**: right-click `NOMissionPlanner.exe` and read the version from
  Properties, or say if you ran it in a browser instead.

If the app fails to start, run it once from a terminal with `--debug` and say
what appears.

## Running from source

**Double-click `start.bat`.** It serves this folder and opens the planner.
Close that window to stop the server.

Or by hand:

```
cd "path/to/Mission planner"
python -m http.server 8000
```

Then open <http://localhost:8000>.

**Opening `index.html` directly will not work.** Browsers treat a file opened
from disk as its own isolated origin and block `fetch` across that boundary, so
`units.json` cannot load. Images are exempt, which is why the basemap appears
but the names do not. The desktop app has no such problem - it maps the files to
a virtual host instead.

## The desktop app

`shell/` is a WinForms window hosting WebView2. It exists for two reasons: the
planner needs no server under it, and a browser cannot open or save a file where
you tell it to.

The planner's files are mapped to a virtual host rather than loaded over
`file://`, which is what removes the server. Under the shell the app is an
ordinary https origin, so `fetch` works and there is no port to collide with.

```
cd shell
dotnet run                     # runs against the working tree, no copy needed
dotnet publish -c Release -o ./publish
```

`publish/` holds `NOMissionPlanner.exe` and an `app/` folder beside it. That is
the whole distributable - about 127 MB, most of it map imagery. The build is
self-contained, so it runs on a machine with no .NET installed; add
`-p:SelfContained=false` for a much smaller build that needs the .NET 8 Desktop
Runtime.

`--debug` opens the DevTools protocol on port 9222 for troubleshooting. It is
off otherwise.

The same source still runs in a browser. It feature-detects the host and falls
back to downloads, so nothing here is desktop-only.

`tools/make_icon.py` draws `shell/app.ico`. Editing the numbers at the top of
that script and re-running it is the way to change the icon.

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
| `*_overview.webp` | Basemap shown when the whole map is in view. Generated. |
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

The imagery comes from the terrain capture plugin in the sibling
`Terrain capture` project, which extracts georeferenced elevation and imagery
from the running game. The map bounds hardcoded in `MAPS` are the measured
extents from that work.

`tools/make_tiles.py` turns one capture into everything the planner draws: the
`*_overview.webp` basemap and the `tiles/` pyramid under it. Both come from the
same mosaic, so they cannot end up generated from different captures.

To re-capture at a higher resolution, raise `TilesPerSide` in the plugin's
config, press F10 on each map, then run `stitch_imagery.py` followed by
`make_tiles.py`. A finer tile level appears on its own; nothing here needs
changing.

## Coordinates

Mission files store positions in metres on a flat plane — `x` east, `z` north,
`y` altitude. `toScreen` converts those to pixels, and flips the vertical axis
because screen `y` grows downward while world `z` grows north.
