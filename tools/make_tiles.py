"""Slice the full-resolution basemaps into tiles the planner can load on demand.

The 2400 px overviews are what the app shows when the whole map is in view, and
they are tracked in git so a clone runs without a separate download. They run
out of detail long before the zoom does: Heartland is 81,920 m across, so 2400
px is 34 m per pixel.

The captures are 8192 px, which is 10 m per pixel - but Heartland_full.png is a
101 MB PNG. Nothing sane downloads that to look at one airfield, and decoded it
is 268 MB of memory for a picture of which you can see a twentieth.

So it is cut into a grid and re-encoded as WebP. The planner loads only the
tiles that are actually on screen, and only once the zoom is far enough in for
the overview to be visibly soft. PNG is the wrong format for this content in
the first place - it is photographic terrain, not flat colour, which is why the
source is 101 MB and the tiles are a fraction of it.

    python tools/make_tiles.py

Reads ../Terrain capture/tools/<Map>_full.png, writes tiles/<Map>/<col>_<row>.webp
plus tiles/index.json describing the grid.
"""

import io
import json
import os
import sys

from PIL import Image

# 8192 px is not divisible by 1500 or 2000, and a ragged right-hand column is
# more special-casing at draw time than it is worth. 1024 divides evenly and
# keeps a decoded tile at 4 MB.
TILE = 1024
QUALITY = 82

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOURCE = os.path.abspath(os.path.join(ROOT, "..", "Terrain capture", "tools"))
OUT = os.path.join(ROOT, "tiles")

MAPS = ["Heartland", "Ignus"]


def slice_map(name):
    src = os.path.join(SOURCE, name + "_full.png")
    if not os.path.exists(src):
        print("  %-10s SKIPPED - %s not found" % (name, src))
        return None

    # The captures are larger than Pillow's decompression-bomb guard.
    Image.MAX_IMAGE_PIXELS = None

    print("  %-10s reading %s ..." % (name, os.path.basename(src)))
    img = Image.open(src).convert("RGB")
    w, h = img.size

    cols = (w + TILE - 1) // TILE
    rows = (h + TILE - 1) // TILE

    out_dir = os.path.join(OUT, name)
    os.makedirs(out_dir, exist_ok=True)

    total = 0
    for cy in range(rows):
        for cx in range(cols):
            box = (cx * TILE, cy * TILE,
                   min((cx + 1) * TILE, w), min((cy + 1) * TILE, h))
            tile = img.crop(box)

            path = os.path.join(out_dir, "%d_%d.webp" % (cx, cy))
            tile.save(path, "WEBP", quality=QUALITY, method=6)
            total += os.path.getsize(path)

        sys.stdout.write("\r    row %d/%d" % (cy + 1, rows))
        sys.stdout.flush()

    print("\r    %d x %d tiles, %.1f MB total   " % (cols, rows, total / 1e6))

    return {"width": w, "height": h, "tile": TILE, "cols": cols, "rows": rows,
            "bytes": total}


def main():
    os.makedirs(OUT, exist_ok=True)
    index = {}

    for name in MAPS:
        info = slice_map(name)
        if info:
            index[name] = info

    if not index:
        sys.exit("\nNo source images found in %s" % SOURCE)

    with io.open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)

    grand = sum(v["bytes"] for v in index.values())
    print("\nwrote tiles/index.json  -  %.1f MB of tiles for %d map(s)"
          % (grand / 1e6, len(index)))


if __name__ == "__main__":
    main()
