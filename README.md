# MASK

**Mission Analysis & Strike Kit** - mission planning for [Nuclear Option](https://store.steampowered.com/app/2168680/Nuclear_Option/).

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

**First run only:** the app asks where your missions live and offers the places
it found — the mission loaded in game, your subscribed workshop missions, the
scanner's output — or Browse for anywhere else. That is only where the Open
dialog starts; you can open a mission from anywhere, and dragging one onto the
window ignores it entirely. Change it later with **Mission folder…** under the
drop zone.

### The short version

1. **Open a mission** — click the drop zone. It opens straight at your missions.
2. **Pick your side** in *Your faction*.
3. **Set your aircraft** at the bottom: RCS preset and altitude.
4. **Ring the threats** — tick **Hostile > Air Defence** in the *Rings* panel.

That is a usable threat picture. Everything below adds a route to it.

### Planning against it

5. **Draw a route** in *Flights* — New flight, then click along the map.
   Double-click or Escape to finish. Drag a waypoint to move it. Each waypoint
   carries its own altitude, and every leg is coloured by what can see and shoot
   you along it.
6. **Mark targets** — right-click a unit, or the map for a point target.
7. **Add a release point** — tick a waypoint as RP, choose the munition, and
   pick which targets it services. You get a time of flight for each, and what
   happens to the weapon on the way in.
8. **Export** from the Plan section: Plan, Sheet, Image or Card.

### Worth knowing early

- **Right-click is where most things live** — designating targets, placing the
  bullseye, measuring, manual rings. It changes depending on whether you
  right-clicked a unit, empty map, or an existing ring.
- **Hover anything to identify it.** The status bar shows your position, the
  ground elevation under the cursor and your height above it — including a red
  **BELOW GROUND** when a route dips into a hill.
- **The RCS and altitude in the bottom bar drive every ring on screen.** If a
  ring looks wrong, check those two first.

## Reading the threat picture

Everything on the map is drawn against **one aircraft at one altitude** — the RCS
and ALT set in the bar along the bottom. Change either and every ring on screen
changes with it. If a ring looks wrong, check those two first.

The RCS list is the game's own airframes with their real values, stealthiest
first, so picking your aircraft is usually enough. *Custom…* takes a number if
you want to see what a different signature would do.

### The three ring types

Toggle these in the **Rings** panel. They answer different questions and it is
worth knowing which is which.

| Ring | What it means | Moves with RCS? |
|---|---|---|
| **Radar detection** | The range a radar starts seeing *you* | **Yes** |
| **Optical / IR** | Eyeballs and infrared | No |
| **Weapon envelope** | Where a launcher can actually shoot | No |

Only radar responds to your radar cross-section, because in the game only radar
uses it. Flying something stealthy shrinks the radar rings and leaves the
infrared and optical ones exactly where they were — which is the whole reason
they are drawn separately.

Weapon rings are drawn from the launcher's own engagement limits, not from a
description. If a weapon cannot reach your altitude, its ring closes up and
vanishes rather than lying to you.

### Why rings are not circles

**Clip to terrain** cuts each ring down to what the ground actually allows. A
radar behind a ridge gets a bite taken out of its envelope on that bearing, and
that gap is a real route through.

Two other things shorten a ring without any terrain involved:

- **Radar horizon.** Both ends contribute, so climbing extends the horizon and
  reveals you sooner. This is the one range that is measured along the ground.
- **Altitude difference.** Every range check in the game is slant range — a
  sphere, not a disc. What the map can draw is the ground projection of that
  sphere, so an envelope shrinks as you climb away from it and closes entirely
  once the height difference exceeds the weapon's reach.

That last one surprises people: **a SAM ring shrinking as you climb does not
mean you are safe**, it means fewer of its metres are usable horizontally. Climb
far enough and it cannot reach you at all, which is when the ring disappears.

### What "engaged" actually requires

A weapon envelope on its own is not a threat. The planner only calls a point
*engaged* when **something on that side can see you and something on that same
side can shoot you**. Ringing a launcher with no sensor of its own produces
nothing until you also ring a radar that can feed it.

That is why ringing a whole air-defence network behaves differently from ringing
one battery: the sensors and the shooters have to be in the picture together.

### Labels

Ring labels declutter automatically. On a busy map set **Labels → Hovered unit
only** and point at what you care about; **Auto** thins overlapping labels and
places what fits.

---

## Planning a route that survives

Draw a route in **Flights**: *New flight*, then click along the map,
double-click or Escape to finish. Drag any waypoint to move it. Each waypoint
carries its own altitude, and the legs between them are what get judged.

### Reading the leg colours

Every leg is drawn over with what happens along it. The distinction is carried
by **weight and pattern**, not colour alone:

| Look | Meaning |
|---|---|
| Thick red, **white dashes over it** | **Below ground** — the leg is inside a hill |
| Thick solid red | **Engaged** — seen and shootable |
| Medium dashed amber | **Seen** — detected but nothing can shoot you there |
| Nothing | Clear |

The leg label repeats it in words and distance: `043°  25.3 NM   12.1 NM engaged,
5.0 NM seen`. Read the threatened distance against the leg's own length — a leg
that is 12 NM engaged out of 40 is a different problem from one that is engaged
end to end.

### Below ground is not a warning about terrain nearby

It means the waypoint altitude is **lower than the ground beneath it**. The
status bar says `BELOW GROUND by 1004 ft` in red when your cursor is over such a
spot. This is easy to do accidentally on a low-level route through hills, and
until you fix it the exposure figures for that leg are meaningless — an
underground aircraft is not detectable, so the leg reports as clear.

### The altitude trade

There is no single right answer, which is why the tool exists:

- **Low** puts terrain between you and the radars, and the masking will show it.
  It also costs fuel and time, and risks flying into the ground.
- **High** extends your own radar horizon in both directions and puts you inside
  more long-range envelopes, but it shrinks the short-range ones and is where
  most munitions actually reach their published range.

The productive way to use it: set the altitude you intend to fly, ring the
threats, then move waypoints until the amber and red go away. The gaps you are
looking for are usually behind terrain, not around the edge of a ring.

---

## Release points and time of flight

A release point is a waypoint you have marked **RP**. It carries a munition and
the list of targets it services — not every target gets shot at from every
release point, so you choose per point.

For each target you get a **time of flight**, computed with the flight model
that matches the weapon: rocket motors, glide, ballistic or gun. Speed and
altitude at release both feed into it, which is why the same weapon shows a very
different number from 500 ft than from 30,000 ft.

### Why time of flight is the number that matters

Time of flight is measured **from release**, not from your take-off. It is how
long the weapon is in the air and the defence has time to react to it. Two
weapons that both "reach" a target are not equivalent if one takes 40 seconds
and the other takes three minutes.

If a weapon cannot make it, you get the reason rather than a blank — out of
energy before arrival, or below its minimum speed.

### Weapon exposure on the run-in

Under each target the planner reports what happens to the **weapon** on its way
in, at the weapon's own signature and speed:

> ■ engageable 19.9 NM out by T9K41 Boltstrike · ▧ seen 23.1 NM out

Those distances are **how far the weapon still has to run** when the event
happens, which is what decides whether it survives to impact — not how far it
has already flown.

This is frequently the opposite of the answer for the aircraft. Munitions carry
much smaller signatures than the thing that launched them, and many defences
refuse targets above a speed limit, so a fast small missile is often untouchable
on a run-in that would have been fatal for you. That is the case the tool is
built to find.

---

## Bullseye, measuring and manual rings

Everything here hangs off the **right-click menu**, which is worth exploring —
it changes depending on whether you right-clicked a unit, empty map, or an
existing ring.

**Bullseye** — right-click empty map, *Place bullseye here*. Every position in
the panels and in every export then reads as a `bearing / range` call instead of
raw coordinates, which is what makes a plan speakable over the radio. The rose
around it is marked every 5 NM with radials every 45 degrees. *Move bullseye
here* and *Clear bullseye* appear once one is placed.

**Measuring** — right-click, *Measure from here*, then move and click to finish.
Right-clicking a unit measures from that unit rather than from where you
clicked, which is the easy way to get a range between two things.

**Manual rings** — right-click, *Range ring from here*, then drag out to the
radius you want. Use them for anything the planner does not know about: a fuel
radius, a deconfliction line, a place you have agreed not to cross. They stack,
so you can lay several down. *Clear all rings* removes them.

Pick the colour **before** you draw — the selector in the main panel applies to
rings you draw next, not to ones already on the map. To change one that is
already there, right-click it and use *Recolour this ring*. *Remove this ring*
appears the same way.

**Coverage ring from here (terrain clipped)** is the interesting one. It draws a
ring cut to what the terrain actually allows from that spot, at your current
altitude — the same masking the threat rings use, but centred anywhere you like.
Use it to ask "if I put something here, what would it see", or to sanity-check a
gap before you commit a route to it.

---

## Choosing an export

Four buttons under **Export**, for four different jobs:

| Export | Use it for |
|---|---|
| **Plan** | Sharing the plan, or reloading it later. Needs the same mission file at the other end. |
| **Sheet** | The full briefing, printable. Route table, detection events, times of flight, targets. |
| **Image** | A picture of the map as framed, at 3×. Pan and zoom to the shot you want *first*. |
| **Card** | A 52-column text block, copied to the clipboard, sized to paste into chat. |

**Sheet and Card count hostile units only.** The map still colours your route
against everything you have ringed, so if you ring friendly radars the map and
the exports will disagree — deliberately, because a friendly emitter is not
something you brief against.

The **Image** caption records the mission, your RCS and altitude, how many
hostiles were ringed, and whether terrain masking was on. A picture without that
context is not evidence of anything, which is why it is burned in.

## Running an executable you did not build

Downloading a 60 MB binary from a stranger and running it is a reasonable thing
to be uneasy about. So:

**Everything here is the source it was built from.** No build step, no bundler,
no minification. The planner is plain HTML, CSS and JavaScript you can read in
`src/`, and the desktop shell is two C# files in `shell/`. The only third-party
code is `vendor/milsymbol.js` (MIT), vendored rather than pulled from a CDN so
it cannot change under you.

**What the shell actually does:** opens a window, points WebView2 at the files
in `app/`, and opens or saves a file when you use a dialog.

The planner makes no requests off the machine. Every `fetch` in the source is a
relative path to a file in `app/` - `units.json`, `ranges.json`, `terrain/` and
`tiles/`, and that is the complete list. There is no telemetry, no analytics and
no auto-update. WebView2 itself is Microsoft's component and behaves as it does
anywhere else on Windows; it keeps its profile in
`%LOCALAPPDATA%\MASK`.

**Build it yourself** and compare, if you would rather:

```
git clone https://github.com/BlackoutBrannon/nuclear-option-mission-planner
cd nuclear-option-mission-planner/shell
dotnet publish -c Release -o ./publish
```

That produces the same thing the release contains. It needs the .NET 8 SDK and
nothing else.

**Or skip the executable entirely.** The planner runs in a browser - see
*Running from source* below. The desktop app exists to remove the server and to
open and save files, not because anything needs to be compiled.

**Windows will warn you.** The executable is not code-signed, because a
certificate costs several hundred a year. SmartScreen will say "Windows
protected your PC" - *More info* then *Run anyway*. If that is not a trade you
want to make, run it in a browser instead.

**Checksums** for `v0.2.0`, so you can confirm the download is the file that was
published:

```
zip  6af152bbcabc24f03ed660521ffc44d44f0b47983999e369fc116d063cc2b0b5
exe  746e3d9f1042818a8a913eeaccc2d000caa2d9a658b32ec45397ae1cd1b0399b
```

Check yours with `Get-FileHash <file>` in PowerShell.

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
- **Which build**: right-click `MASK.exe` and read the version from
  Properties, or say if you ran it in a browser instead.

If the app fails to start, run it once from a terminal with `--debug` and say
what appears.

## Running from source

**Double-click `start.bat`.** It serves this folder and opens the planner.
Close that window to stop the server.

Or by hand:

```
cd "path/to/Mission planner"
python tools/serve.py 8000
```

Add `--no-browser` to start the server without opening a tab, which is what you
want when a script is driving it rather than a person.

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

`publish/` holds `MASK.exe` and an `app/` folder beside it. That is
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

## After a game patch

Most of the planner's data is read out of your own game install, so a patch that
changes ranges, adds units or rebalances weapons is a re-run rather than a code
change. Check first:

```
python tools/extract_ranges.py --check
```

That extracts exactly as normal but **writes nothing**. It compares what it
found against the committed `ranges.json` and tells you whether the difference
is the boring kind or not:

- **Additions are forgiven.** New units, new munitions, new airframes are the
  normal result of a patch and are reported as notes.
- **Losses and drift are not.** A unit that has stopped having a radar, a
  munition that has vanished, or a range that moved more than 25% is either a
  real balance change worth knowing about, or a field this extractor no longer
  reads correctly. From the outside those look identical, so both are raised.
- **A value arriving at or leaving zero always counts**, because that is exactly
  what a field falling out of the extraction looks like.

It exits `0` when clean and `2` when something wants a look, so it can gate a
script. If it is happy, accept the changes:

```
python tools/extract_ranges.py          # writes ranges.json
python tools/extract_units.py           # display names, if unit types changed
```

`ranges.json` records a `_build` block — the size and timestamp of
`resources.assets`, plus the Unity version — so you can always tell which game
build the data came from. Nuclear Option ships no version string of its own; the
executable carries only Unity's.

### What a re-run cannot fix

**The detection maths is ported code, not data.** The signal formula, the radar
horizon, the slant-to-ground projection and the four flight models live in
`src/`, and `ranges.json` only records them as `_formula` strings for reference.
If the developers change *how* detection works rather than *what the numbers
are*, the planner will keep producing confident, plausible, wrong answers and no
check will notice. That needs someone reading the decompiled assembly again.

`--check` does catch one corner of this: a weapon whose flight model is not one
the planner implements is reported by name, because such a weapon gets no time
of flight at all.

Two other things are code rather than data:

- **Map extents and terrain names** in `src/01-boot.js`. A new official map needs
  an entry there, plus a capture.
- **Terrain and imagery** come from the F10 capture, which needs the game
  running — see *Basemaps* below.

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
