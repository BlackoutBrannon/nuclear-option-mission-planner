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
| `app.js` | The application. No framework, no build step. |
| `units.json` | Display names and descriptions per unit type. Generated. |
| `*_overview.png` | Basemaps, produced by the terrain capture tool. |
| `tools/extract_units.py` | Regenerates `units.json` from the game's own files. |
| `tools/make_symbol_sheet.py` | Builds `symbols.html` by parsing the tables out of `app.js`. |

`app.js` is loaded at the end of `<body>`, so every element it looks up already
exists and it needs no `DOMContentLoaded` wrapper. `vendor/milsymbol.js` loads
before it and provides the global `ms`.

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
