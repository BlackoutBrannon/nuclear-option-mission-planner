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


def definitions():
    """Every UnitDefinition in the game, keyed by the jsonKey missions use.

    Read through UnityPy with a regenerated type tree, exactly as
    extract_ranges.py does - which is why this module imports it rather than
    setting up a second copy of the same machinery.

    This used to scrape raw bytes out of resources.assets and pick out runs of
    plausible-looking text. That worked well enough to be believed and was
    quietly wrong: it truncated 40 of the 85 descriptions, several of them mid
    word, because a byte scan has no way to know where a string actually ends.
    A type tree does.
    """
    import extract_ranges

    env = extract_ranges.load()
    out = {}
    for o in env.objects:
        if o.type.name != "MonoBehaviour":
            continue
        try:
            d = o.read_typetree()
        except Exception:
            continue          # unrelated classes the generator cannot lay out
        # UnitDefinition identified by the fields it carries rather than by
        # script name, which lives in a different asset file.
        if "jsonKey" in d and "radarSize" in d and d.get("jsonKey"):
            out[d["jsonKey"]] = d
    return out


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

    if not os.path.isdir(GAME):
        sys.exit(f"game data not found: {GAME}")

    defs = definitions()
    print(f"{len(defs)} unit definitions in the game's assets")

    catalogue, missing = {}, []
    for key in sorted(types):
        d = defs.get(key)
        if d and d.get("unitName"):
            entry = {
                "name": d["unitName"],
                "description": d.get("description") or "",
                "category": types[key],
            }
            # The short designator the game shows on unit lists - "SAM IR",
            # "MBT". Cheap to carry and the only compact label available.
            if d.get("code"):
                entry["code"] = d["code"]
            catalogue[key] = entry
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
