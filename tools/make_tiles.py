"""Slice the full-resolution basemaps into a tile pyramid.

The 2400 px overviews are what the app shows when the whole map is in view, and
they are tracked in git so a clone runs without a separate download. They run
out of detail long before the zoom does: Heartland is 81,920 m across, so 2400
px is 34 m per pixel.

The captures hold much more, but not in a form anything can use directly -
Heartland_full.png is a 101 MB PNG, and decoded it is 268 MB of memory for a
picture of which you can see a twentieth. PNG is also the wrong format for
photographic terrain, which is most of why it is that big.

So each capture is cut into 1024 px WebP tiles at several resolutions, halving
down until the overview is nearly as good. The planner fetches only the tiles on
screen, from the coarsest level that still beats the screen's pixel density, so
zooming part-way in does not drag in the finest imagery.

Levels come out of whatever the capture happens to be. Raise TilesPerSide in
brami.nuclearoption.terraincapture.cfg and re-capture, and the finer level
appears here on the next run with no code change.

    python tools/make_tiles.py

Reads ../Terrain capture/tools/<Map>_full.png, writes
tiles/<Map>/z<width>/<col>_<row>.webp and tiles/index.json.
"""

import io
import json
import os
import sys

from PIL import Image

# 1024 divides the 8192 and 16384 captures evenly, avoiding a ragged edge
# column, and keeps a decoded tile at 4 MB.
TILE = 1024
QUALITY = 82

# Stop halving once a level is no better than this multiple of the overview.
# Below it the overview is already doing the job and the level is dead weight.
OVERVIEW_PX = 2400
FLOOR = int(OVERVIEW_PX * 1.5)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOURCE = os.path.abspath(os.path.join(ROOT, "..", "Terrain capture", "tools"))
OUT = os.path.join(ROOT, "tiles")

MAPS = ["Heartland", "Ignus"]


def slice_level(img, out_dir, width, height):
    """Cut one already-resized image into tiles. Returns bytes written."""
    os.makedirs(out_dir, exist_ok=True)

    cols = (width + TILE - 1) // TILE
    rows = (height + TILE - 1) // TILE
    total = 0

    for cy in range(rows):
        for cx in range(cols):
            box = (cx * TILE, cy * TILE,
                   min((cx + 1) * TILE, width), min((cy + 1) * TILE, height))
            path = os.path.join(out_dir, "%d_%d.webp" % (cx, cy))
            img.crop(box).save(path, "WEBP", quality=QUALITY, method=6)
            total += os.path.getsize(path)

    return cols, rows, total


def build_map(name, span_m):
    src = os.path.join(SOURCE, name + "_full.png")
    if not os.path.exists(src):
        print("  %-10s SKIPPED - %s not found" % (name, src))
        return None

    Image.MAX_IMAGE_PIXELS = None       # the captures exceed the bomb guard

    print("  %s" % name)
    print("    reading %s ..." % os.path.basename(src))
    full = Image.open(src).convert("RGB")
    w, h = full.size

    # Widths to emit: native, then halving while still meaningfully better than
    # the overview. Coarsest first, which is the order the planner searches.
    widths = []
    cw, ch = w, h
    while cw >= FLOOR:
        widths.append((cw, ch))
        cw //= 2
        ch //= 2
    widths.reverse()

    # Clear old output: the set of levels changes with the capture, and a stale
    # level would be served happily by the index that no longer lists it.
    # Directories are emptied rather than removed - OneDrive keeps a handle on
    # the folder itself and refuses the rmdir, which is not worth failing over.
    map_dir = os.path.join(OUT, name)
    for dirpath, _dirnames, filenames in os.walk(map_dir):
        for fn in filenames:
            if fn.endswith(".webp"):
                os.remove(os.path.join(dirpath, fn))
    for entry in os.listdir(map_dir) if os.path.isdir(map_dir) else []:
        sub = os.path.join(map_dir, entry)
        if os.path.isdir(sub):
            try:
                os.rmdir(sub)
            except OSError:
                pass

    levels = []
    for lw, lh in widths:
        img = full if lw == w else full.resize((lw, lh), Image.LANCZOS)
        cols, rows, total = slice_level(img, os.path.join(map_dir, "z%d" % lw), lw, lh)
        if img is not full:
            img.close()

        levels.append({"dir": "z%d" % lw, "width": lw, "height": lh,
                       "cols": cols, "rows": rows, "bytes": total})
        print("    z%-6d %2d x %-2d tiles  %6.1f m/px  %5.1f MB"
              % (lw, cols, rows, span_m / lw, total / 1e6))

    full.close()
    return {"tile": TILE, "levels": levels}


def main():
    os.makedirs(OUT, exist_ok=True)

    # Ground span east-west, to report metres per pixel. Matches MAPS in
    # src/01-boot.js; only used for the printout.
    spans = {"Heartland": 81920.0, "Ignus": 157646.4}

    index = {}
    for name in MAPS:
        info = build_map(name, spans.get(name, 0.0))
        if info:
            index[name] = info

    if not index:
        sys.exit("\nNo source images found in %s" % SOURCE)

    with io.open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)

    grand = sum(l["bytes"] for v in index.values() for l in v["levels"])
    count = sum(len(v["levels"]) for v in index.values())
    print("\nwrote tiles/index.json  -  %.1f MB across %d levels, %d map(s)"
          % (grand / 1e6, count, len(index)))


if __name__ == "__main__":
    main()
