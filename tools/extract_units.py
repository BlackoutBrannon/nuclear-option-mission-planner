"""
Extract unit display names and descriptions from Nuclear Option's game files.

Mission files identify units only by an internal key - "Truck2-RSAM", "MBT1",
"6x6_1_AA". The game stores a human name and a description for each of those in
resources.assets. This pulls them out into units.json for the planner to use.

WHAT THIS DOES NOT DO
---------------------
It does NOT produce weapon or radar ranges. Descriptions sometimes mention a
figure - "tracking multiple aerial targets at a range of up to 15km" - but that
is prose in a marketing blurb describing detection, not the range at which a
launcher will actually commit a missile. Those are different numbers. Treating
one as the other would produce threat rings that are confidently wrong.

Descriptions are extracted verbatim, as text for a human to read. Anything that
drives a drawn range ring has to come from a structured source, which means the
in-game extractor plugin, not this script.

USAGE
    python extract_units.py            # writes ../units.json

The extraction is heuristic - the assets are a binary format being pattern
matched, not parsed. It reports what it could not resolve rather than guessing.
"""

import json, glob, os, re, sys

# Names the automatic extraction cannot get, established by working out which
# aircraft designations in the game files were not claimed by any other key:
#   unassigned designations - FS-12 Revoker, CI-22 Cricket
#   unassigned keys         - Fighter1, SmallFighter1, COIN
# SmallFighter1 is the FS-20 Vortex, whose description reads "a compact and
# advanced multirole fighter" - compact matching "Small". That leaves Fighter1
# as the FS-12 Revoker, and COIN as the CI-22 Cricket (CI = counter-insurgency).
# Confirmed against the game by someone who plays it.
NAME_OVERRIDES = {
    "Fighter1":      "FS-12 Revoker",
    "SmallFighter1": "FS-20 Vortex",
    "COIN":          "CI-22 Cricket",
}

GAME = r"C:\Program Files (x86)\Steam\steamapps\common\Nuclear Option\NuclearOption_Data"
MISSIONS = r"C:\Program Files (x86)\Steam\steamapps\workshop\content\2168680"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "units.json")

# A plausible name or description: starts alphanumeric, contains only characters
# you would expect in English prose. Filters out the binary padding that sits
# between fields in the asset file.
CLEAN = re.compile(r"[A-Za-z0-9][A-Za-z0-9 \-\.,'()/:%+&!?]{2,}")


def unit_types_in_missions():
    """Every distinct type key used across the installed workshop missions."""
    types = {}
    for path in glob.glob(os.path.join(MISSIONS, "*", "*.json")):
        base = os.path.basename(path)
        if base in ("meta.json", "workshop.json") or "catalog" in base:
            continue
        try:
            d = json.load(open(path, encoding="utf-8-sig"))
        except Exception:
            continue
        for category in ("aircraft", "vehicles", "ships", "buildings"):
            for u in d.get(category, []):
                if u.get("type"):
                    types[u["type"]] = category
    return types


def strings_after(blob, pos, span=500):
    """Printable runs following a position, in order."""
    return [s.decode("ascii", "ignore")
            for s in re.findall(rb"[ -~]{3,}", blob[pos:pos + span])]


def find_entry(blob, key):
    """
    Locate a unit's name and description.

    Two passes, because the asset file is not consistent:
      strict - key, key, name, description with nothing between
      loose  - allow binary padding and differing capitalisation between fields
               (the file contains both "RadarSam1" and "RadarSAM1")
    """
    pattern = re.escape(key.encode() + b"\x00")

    # strict
    for m in re.finditer(pattern, blob):
        s = strings_after(blob, m.start())
        if len(s) >= 4 and s[0] == key and s[1] == key:
            return s[2], s[3]

    # loose - a shorter window, because a wide one wanders into the NEXT record
    # and returns its neighbour's name (this is how radarStation1 came back as
    # "Refinery Structure").
    for m in re.finditer(pattern, blob, re.IGNORECASE):
        s = strings_after(blob, m.end(), span=200)
        cand = [x for x in s if CLEAN.fullmatch(x) and x.lower() != key.lower()]
        for i in range(len(cand) - 1):
            if len(cand[i]) < 40 and len(cand[i + 1]) > 35:
                return cand[i], cand[i + 1]
    return None


def prettify(key):
    """
    A readable label for a key nobody has given a real name to.
    radarStation1 -> "Radar Station",  factory_tall -> "Factory Tall".

    Still flagged unresolved in the data - this only stops the interface showing
    raw identifiers. It is a presentation fallback, not a claim about the name.
    """
    s = re.sub(r"\d+$", "", key)                     # trailing version digits
    s = s.replace("_", " ").replace("-", " ")
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s)       # camelCase -> camel Case
    return " ".join(w[:1].upper() + w[1:] for w in s.split()) or key


def drop_duplicates(catalogue):
    """
    Two unit types cannot share a display name. When they do, the matcher has
    strayed into a neighbouring record - so trust neither and mark both
    unresolved rather than shipping a confidently wrong name.
    """
    by_name = {}
    for key, entry in catalogue.items():
        if entry.get("unresolved"):
            continue
        by_name.setdefault(entry["name"], []).append(key)

    clashed = []
    for name, keys in by_name.items():
        if len(keys) > 1:
            clashed.append((name, keys))
            for key in keys:
                catalogue[key] = {
                    "name": key,
                    "description": "",
                    "category": catalogue[key]["category"],
                    "unresolved": True,
                }
    return clashed


def main():
    types = unit_types_in_missions()
    print(f"{len(types)} distinct unit types across installed missions")

    path = os.path.join(GAME, "resources.assets")
    if not os.path.exists(path):
        sys.exit(f"not found: {path}")
    blob = open(path, "rb").read()
    print(f"scanning {os.path.basename(path)} ({len(blob)/1048576:.0f} MB)\n")

    catalogue, missing = {}, []
    for key in sorted(types):
        hit = find_entry(blob, key)
        if hit:
            catalogue[key] = {
                "name": hit[0],
                "description": hit[1],
                "category": types[key],
            }
        else:
            missing.append(key)
            catalogue[key] = {
                "name": key,               # fall back to the raw key
                "description": "",
                "category": types[key],
                "unresolved": True,
            }

    clashed = drop_duplicates(catalogue)
    if clashed:
        print("rejected as ambiguous - two types resolved to one name:")
        for name, keys in clashed:
            print(f"   \"{name}\"  <-  {', '.join(keys)}")
        print()
        missing += [k for _, keys in clashed for k in keys]

    # Hand-supplied names take precedence over anything found automatically,
    # and survive re-running this after a game patch.
    applied = []
    for key, name in NAME_OVERRIDES.items():
        if key in catalogue:
            catalogue[key]["name"] = name
            catalogue[key].pop("unresolved", None)
            applied.append(key)
            if key in missing:
                missing.remove(key)
    if applied:
        print(f"applied {len(applied)} name override(s): {', '.join(applied)}\n")

    # Anything still nameless gets a readable label rather than a raw key.
    for key in missing:
        catalogue[key]["name"] = prettify(key)

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(catalogue, f, indent=2, ensure_ascii=False)

    print(f"resolved {len(types) - len(missing)} of {len(types)}")
    if missing:
        print(f"\nunresolved ({len(missing)}) - these keep their raw key as a name:")
        for k in missing:
            print(f"   {k}")
        print("\nModded units will not be here at all: they live in BepInEx")
        print("plugin bundles rather than the base game's assets.")
    print(f"\nwrote {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
