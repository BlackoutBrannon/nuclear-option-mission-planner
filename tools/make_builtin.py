"""Turn a survey from the HUD mod into the list of units built into a map.

    python tools/make_builtin.py <survey.json> [--out builtin/<Map>.json]

A mission file holds what its author placed. The map itself holds more - on
Heartland, radar stations on the best hilltops, factories, storage tanks,
refineries - and none of that is in any mission file, because the game adds
it from the terrain scene when the mission loads. The first detection log
showed three of the five radars that saw the pilot were built-in; the plan
could not have known they existed.

The HUD mod's survey (F10 in a mission) writes every live unit with a
placement field. Everything marked BuiltIn is fixed for that map, so it is
extracted once and shipped with the planner, which merges it into every
mission on that map. Take the survey at spawn, before any ground fighting:
the SIDE of a built-in structure is what the map author gave it, and it
changes the moment either faction parks a vehicle beside it.
"""
import argparse
import io
import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Structures that belong to an airbase and take its side. Measured against a
# survey: inside an airbase's capture ring these matched the airbase's faction
# 87 times out of 87, while radar stations and industry inside the same rings
# stayed neutral. The planner uses this to give a built-in a side only when
# the mission file gives it a reason; the survey's own sides are not shipped.
AIRBASE_FURNITURE = {"shelter1", "Helipad", "ammunitionBunker", "hangar_med", "revetment1", "controlTower1"}


def map_name(path):
    if not path or path == "Terrain1":
        return "Heartland"
    if path == "Terrain_naval":
        return "Ignus"
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("survey")
    ap.add_argument("--out", help="destination; default builtin/<Map>.json")
    ap.add_argument("--legacy", action="store_true",
                    help="survey from a mod older than the placement field: a building with a blank "
                         "placement is taken as built-in, and its identity synthesised from position")
    args = ap.parse_args()

    survey = json.load(io.open(args.survey, encoding="utf-8"))
    if survey.get("format") != "mask-survey":
        sys.exit("not a MASK survey: %s" % args.survey)

    name = map_name((survey.get("MapKey") or {}).get("Path", ""))
    if not name:
        sys.exit("unknown map %r" % (survey.get("MapKey") or {}).get("Path"))

    out = {"aircraft": [], "vehicles": [], "ships": [], "buildings": []}
    kept = Counter()
    for cat in out:
        for u in survey.get(cat, []):
            placement = u.get("placement", "")
            if args.legacy and cat == "buildings" and placement == "":
                placement = "BuiltIn"
            if placement != "BuiltIn":
                continue
            g = u["globalPosition"]
            unique = u.get("UniqueName") or ""
            if args.legacy or "@" not in unique:
                # the same string the mod writes: type and position on a 5 m grid
                unique = "%s@%d,%d" % (u["type"], round(g["x"] / 5), round(g["z"] / 5))
            out[cat].append({
                "type": u["type"],
                # No side is shipped. The planner assigns one from the mission
                # file: a ground vehicle parked beside it, or the airbase whose
                # ring it stands in if it is that airbase's furniture. The side
                # seen in the survey is kept for reference only.
                "faction": "",
                "observedSide": u.get("faction", ""),
                "attached": u["type"] in AIRBASE_FURNITURE,
                "UniqueName": unique,
                "globalPosition": u["globalPosition"],
                "placement": "BuiltIn",
            })
            kept[u["type"]] += 1

    total = sum(len(v) for v in out.values())
    if not total:
        sys.exit("no BuiltIn units in that survey - was it taken with a mod older than the placement field?")

    result = {
        "_format": "mask-builtin",
        "_map": name,
        "_from": os.path.basename(args.survey),
        "_surveyTakenUtc": survey.get("takenUtc"),
        "_note": ("Units the map itself provides, absent from every mission file. Merged into any mission "
                  "on this map. faction is deliberately blank: the planner gives a unit a side only when the "
                  "mission file offers a reason - a ground vehicle parked beside it, or the airbase whose "
                  "capture ring it stands in when attached is true. observedSide is what one survey saw."),
    }
    result.update(out)

    dest = args.out or os.path.join(ROOT, "builtin", name + ".json")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with io.open(dest, "w", encoding="utf-8", newline="\n") as f:
        json.dump(result, f, indent=1)
        f.write("\n")

    print("%s: %d built-in units -> %s" % (name, total, os.path.relpath(dest, ROOT)))
    for t, n in kept.most_common():
        print("  %-22s %d" % (t, n))


if __name__ == "__main__":
    main()
