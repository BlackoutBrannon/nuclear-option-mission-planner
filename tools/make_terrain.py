"""
Build the elevation data the planner loads for terrain masking.

    python make_terrain.py            # writes ../terrain/

Reads the DEMs produced by the terrain capture plugin and writes, per map:

    <Map>.bin     elevation in metres, int16 little-endian, row-major,
                  north-to-south then west-to-east
    index.json    dimensions, spacing and world bounds for every map

The raw captures are float32 at 25 m post spacing - 41 MB for Heartland and
74 MB for Ignus, too large to fetch. Resampling to 50 m and storing metres as
int16 gives 5.1 MB and 9.2 MB, which is still four times finer than the step
the line-of-sight walk uses.

SEA AND VOIDS
Water has no collider, so a ray over the sea returns no hit. The capture plugin
already resolves those to sea level - a measured constant of 0 for both maps -
under its Clamp sub-sea mode, so the .f32 files contain no NaN: 3.9 M of
Heartland's 10.7 M cells and 18.0 M of Ignus's 19.4 M read exactly 0. The NaN
guard below is retained because the plugin can be configured to leave voids
unfilled, and a NaN reaching the profile comparison would make over-water sight
lines undefined rather than raising an error.

REQUIREMENTS
    python -m pip install numpy
"""

import json, os, sys

try:
    import numpy as np
except ImportError:
    sys.exit("needs numpy:\n    python -m pip install numpy")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT  = os.path.join(os.path.dirname(HERE), "terrain")

CAP = (r"C:\Program Files (x86)\Steam\steamapps\common"
       r"\Nuclear Option\BepInEx\plugins\TerrainCapture")

TARGET_SPACING = 50          # metres between posts in the output
SEA_LEVEL = 0                # measured, and matches the capture's subSeaMode


def convert(name):
    src = os.path.join(CAP, name)
    meta = json.load(open(os.path.join(src, "meta.json"), encoding="utf-8"))
    d, b = meta["dem"], meta["bounds"]

    raw = np.fromfile(os.path.join(src, d["file"]), dtype="<f4")
    if raw.size != d["width"] * d["height"]:
        sys.exit(f"{name}: expected {d['width'] * d['height']} samples, "
                 f"read {raw.size}")
    grid = raw.reshape(d["height"], d["width"])

    voids = int(np.isnan(grid).sum())
    grid = np.nan_to_num(grid, nan=SEA_LEVEL)

    # Decimate rather than average. A ridge line is what blocks a sight line,
    # and averaging a ridge with the valley beside it lowers it - which would
    # report line of sight through terrain that actually masks it. Taking the
    # maximum of each block would be the conservative alternative; plain
    # decimation keeps the surface closest to the captured one.
    step = TARGET_SPACING // d["postSpacing"]
    if step < 1:
        sys.exit(f"{name}: capture spacing {d['postSpacing']} m is coarser "
                 f"than the {TARGET_SPACING} m target")
    small = grid[::step, ::step]

    out = np.clip(np.rint(small), -32768, 32767).astype("<i2")
    path = os.path.join(OUT, name + ".bin")
    out.tofile(path)

    print(f"{name:10} {d['width']}x{d['height']} @ {d['postSpacing']} m  ->  "
          f"{out.shape[1]}x{out.shape[0]} @ {TARGET_SPACING} m   "
          f"{os.path.getsize(path) / 1048576:.1f} MB")
    print(f"{'':10} elevation {out.min()}..{out.max()} m, "
          f"{voids} voids filled to sea level")

    return {
        "file":    name + ".bin",
        "width":   int(out.shape[1]),
        "height":  int(out.shape[0]),
        "spacing": TARGET_SPACING,
        "minX": b["minX"], "maxX": b["maxX"],
        "minZ": b["minZ"], "maxZ": b["maxZ"],
        "seaLevel": SEA_LEVEL,
        "capturedUtc": meta.get("capturedUtc"),
        "gameVersion": meta.get("gameVersion"),
    }


def main():
    if not os.path.isdir(CAP):
        sys.exit(f"capture folder not found: {CAP}\n"
                 f"Run the terrain capture plugin (F10 in game) first.")

    os.makedirs(OUT, exist_ok=True)

    index = {}
    for name in sorted(os.listdir(CAP)):
        if os.path.isfile(os.path.join(CAP, name, "meta.json")):
            index[name] = convert(name)

    if not index:
        sys.exit(f"no captures found under {CAP}")

    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump({
            "_format": "int16 little-endian metres, row-major, "
                       "north-to-south rows, west-to-east columns",
            "maps": index,
        }, f, indent=1)

    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
