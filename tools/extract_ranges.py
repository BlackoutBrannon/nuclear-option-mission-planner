"""
Generate ranges.json - radar and weapon envelopes per unit type, read from the
game's own serialized data.

    python extract_ranges.py            # writes ../ranges.json

WHY THIS EXISTS
---------------
Unit descriptions quote figures, but those are prose about detection, not the
range at which a launcher commits a missile. Everything here comes from
serialized fields the game itself reads at runtime:

    UnitDefinition.radarSize            -> Unit.RCS
    Radar.RadarParameters               -> RadarParams (maxRange/minSignal/...)
    WeaponInfo.targetRequirements       -> the engagement envelope

HOW DETECTION WORKS (from RadarParams.GetSignalStrength in Assembly-CSharp)

    signal = min(maxRange / dist * RCS^0.25, maxSignal) - clutter * clutterFactor
    detected when signal >= minSignal

so, ignoring clutter, the range at which a target of a given RCS is seen is

    detection_range = maxRange / minSignal * RCS^0.25

The fourth root is literal - Mathf.Pow(RCS, 0.25f) - not an approximation on
our side. `maxRange` is therefore the detection range against an RCS of 1.0
when minSignal is 1; it is a scaling constant, not a hard cutoff.

Two limits are NOT captured in a flat ring and must be applied by the planner:

  * Radar horizon. DetectorManager rejects a contact outright when
        sqrt(12742000 * radarAlt) + sqrt(12742000 * targetAlt) < groundDistance
    (12,742,000 m is the Earth's diameter, so this is sqrt(2Rh)). Beyond the
    combined horizon nothing is detected at any signature.
  * Look-down clutter, which subtracts from the signal and grows as the target
    flies lower relative to the radar.

REQUIREMENTS
    python -m pip install UnityPy TypeTreeGeneratorAPI

The game strips type trees from release builds, so the layout of every
MonoBehaviour is regenerated from Assembly-CSharp.dll at read time. That means
this script reads whatever is installed - after a patch, just re-run it.
"""

import json, math, os, sys, collections

try:
    import UnityPy
    from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator
except ImportError:
    sys.exit("needs UnityPy and TypeTreeGeneratorAPI:\n"
             "    python -m pip install UnityPy TypeTreeGeneratorAPI")

HERE = os.path.dirname(os.path.abspath(__file__))
OUT  = os.path.join(os.path.dirname(HERE), "ranges.json")

GAME = r"C:\Program Files (x86)\Steam\steamapps\common\Nuclear Option"
DATA = os.path.join(GAME, "NuclearOption_Data")
UNITY_VERSION = "2022.3.62f2"

# RCS values the planner offers as presets. Chosen from the extracted spread of
# radarSize rather than invented; the extractor prints the real distribution so
# these can be checked against it.
REFERENCE_RCS = 1.0


def pptr(d, key):
    """Path id behind a PPtr field, or None when it is unset."""
    v = d.get(key)
    if isinstance(v, dict) and v.get("m_PathID"):
        return v["m_PathID"]
    return None


def load():
    gen = TypeTreeGenerator(UNITY_VERSION)
    gen.load_local_dll_folder(os.path.join(DATA, "Managed"))
    env = UnityPy.load(os.path.join(DATA, "resources.assets"))
    env.typetree_generator = gen
    return env


def main():
    if not os.path.isdir(DATA):
        sys.exit(f"game data not found: {DATA}")

    env = load()

    mono = {}                 # path_id -> parsed dict
    failed = 0
    for o in env.objects:
        if o.type.name != "MonoBehaviour":
            continue
        try:
            d = o.read_typetree()
        except Exception:
            failed += 1       # a class the generator could not lay out
            continue
        if isinstance(d, dict):
            mono[o.path_id] = d

    # --- the three tables, identified by their fields ----------------------
    # Script names live in a different asset file, so classes are recognised by
    # the fields they carry. That is also robust to a rename in a patch.
    unitdefs = {i: d for i, d in mono.items() if "jsonKey" in d and "radarSize" in d}
    weapons  = {i: d for i, d in mono.items() if "targetRequirements" in d}

    # --- map a prefab GameObject back to the unit type it belongs to -------
    prefab_key = {}
    for d in unitdefs.values():
        gid = pptr(d, "unitPrefab")
        if gid:
            prefab_key[gid] = d["jsonKey"]

    def owner_of(comp):
        """jsonKey of the unit a component is attached to, or None.

        Components point at their Unit via `attachedUnit`; that Unit's
        GameObject is the prefab root the UnitDefinition names.
        """
        uid = pptr(comp, "attachedUnit")
        if uid is None:
            return None
        unit = mono.get(uid)
        if unit is None:
            return None
        gid = pptr(unit, "m_GameObject")
        return prefab_key.get(gid)

    # --- collect per unit --------------------------------------------------
    out = {}
    for d in unitdefs.values():
        out[d["jsonKey"]] = {
            "name":         d.get("unitName") or d["jsonKey"],
            "code":         d.get("code") or "",
            "rcs":          round(d.get("radarSize", 0.0), 6),
            "visibleRange": d.get("visibleRange", 0.0),
            "iconRange":    d.get("iconRange", 0.0),
            "armorTier":    d.get("armorTier", 0.0),
            "value":        d.get("value", 0.0),
            "size":         [d.get("length", 0.0), d.get("width", 0.0), d.get("height", 0.0)],
            "radars":       [],
            "optical":      [],
            "weapons":      [],
        }

    orphan_radars = orphan_weapons = 0

    for d in mono.values():
        rp = d.get("RadarParameters")
        if not isinstance(rp, dict):
            continue
        key = owner_of(d)
        if key is None or key not in out:
            orphan_radars += 1
            continue
        maxr, mins = rp.get("maxRange", 0.0), rp.get("minSignal", 0.0)
        out[key]["radars"].append({
            "maxRange":      maxr,
            "maxSignal":     rp.get("maxSignal", 0.0),
            "minSignal":     mins,
            "clutterFactor": rp.get("clutterFactor", 0.0),
            "dopplerFactor": rp.get("dopplerFactor", 0.0),
            "cone":          d.get("radarCone", 0.0),
            "jamTolerance":  d.get("jamTolerance", 0.0),
            # Detection range against REFERENCE_RCS, for sanity-checking only.
            # The planner recomputes this for the RCS the user selects.
            "refDetection":  round(maxr / mins * REFERENCE_RCS ** 0.25, 1) if mins else 0.0,
        })

    # Optical / IR detectors. These are the SAME TargetDetector base class as
    # radar, but they never touch RCS: TargetDetector.InVisualRange tests
    # `target.GetVisibility() * magnification`, and GetVisibility returns
    # `definition.visibleRange` - a per-airframe metres value, not a signature.
    # So these rings do NOT move when the user changes RCS.
    #
    # Detection needs BOTH: inside the detector's own visualRange sweep, and
    # inside target.visibleRange * magnification. Hence the min() at draw time.
    for d in mono.values():
        vr = d.get("visualRange")
        if not isinstance(vr, (int, float)) or vr <= 0:
            continue
        if isinstance(d.get("RadarParameters"), dict):
            continue                      # that one is handled as a radar
        key = owner_of(d)
        if key is None or key not in out:
            continue
        entry = {"visualRange": vr,
                 "magnification": d.get("magnification", 1.0) or 1.0,
                 "maxSpeed": d.get("maxSpeed", 0.0)}
        if entry not in out[key]["optical"]:
            out[key]["optical"].append(entry)

    # Weapon stations are serialised INLINE on the turret. Their `WeaponInfo`
    # field is EMPTY on disk: WeaponStation assigns it at runtime from
    # `Weapons[0].info` (WeaponStation.cs:419). The envelope is therefore
    # reached through station -> Weapon component -> its `info` asset. The
    # serialised WeaponInfo field must not be used; it resolves to unrelated
    # weapons without raising an error.
    for d in mono.values():
        stations = d.get("weaponStations")
        if not stations:
            continue
        key = owner_of(d)
        for st in stations:
            info = None
            for wref in st.get("Weapons") or []:
                weapon = mono.get(wref.get("m_PathID")) if isinstance(wref, dict) else None
                if weapon:
                    info = weapons.get(pptr(weapon, "info"))
                    if info:
                        break
            if info is None:
                continue
            if key is None or key not in out:
                orphan_weapons += 1
                continue
            tr = info.get("targetRequirements", {})
            entry = {
                "name":        info.get("weaponName") or info.get("m_Name", ""),
                "minRange":    tr.get("minRange", 0.0),
                "maxRange":    tr.get("maxRange", 0.0),
                "minAltitude": tr.get("minAltitude", 0.0),
                "maxAltitude": tr.get("maxAltitude", 0.0),
                "maxSpeed":    tr.get("maxSpeed", 0.0),
                "minRadar":    tr.get("minRadar", 0.0),
                "minIR":       tr.get("minIR", 0.0),
                "lineOfSight": bool(tr.get("lineOfSight", 0)),
                "missile":     bool(info.get("missile", 0)),
                "gun":         bool(info.get("gun", 0)),
                "armorTierEffectiveness": info.get("armorTierEffectiveness", 0.0),
            }
            if entry not in out[key]["weapons"]:
                out[key]["weapons"].append(entry)

    # Units with neither a radar nor a weapon carry no threat and no sensor;
    # keeping them would bloat the file the planner has to fetch.
    armed = {k: v for k, v in out.items()
             if v["radars"] or v["weapons"] or v["optical"]}

    # Every airframe that can be flown or shot at, for the planner's RCS picker.
    # Emitted SEPARATELY from `units` because that list is filtered to things
    # with a sensor or a weapon - QuadVTOL1 has neither and would vanish from
    # the picker, which is exactly the sort of hole you only notice in the air.
    airframes = {
        d["jsonKey"]: {
            "name":         d.get("unitName") or d["jsonKey"],
            "rcs":          round(d.get("radarSize", 0.0), 6),
            "visibleRange": d.get("visibleRange", 0.0),
        }
        for d in unitdefs.values()
        # AircraftDefinition subclasses UnitDefinition and adds
        # `aircraftParameters`, which identifies an aircraft. RCS is not a valid
        # discriminator: bombs and missiles are tracked units and each carries a
        # radarSize of its own.
        if "aircraftParameters" in d
    }

    payload = {
        "_source": "extracted from resources.assets - see extract_ranges.py",
        "_formula": "radar detection_range = maxRange / minSignal * RCS**0.25",
        "_optical": "optical/IR range = min(visualRange, target.visibleRange * magnification) "
                    "- independent of RCS",
        "_horizon": "sqrt(12742000*radarAlt) + sqrt(12742000*targetAlt) >= groundDist",
        "units": dict(sorted(armed.items())),
        "airframes": dict(sorted(airframes.items(), key=lambda kv: kv[1]["rcs"])),
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=1)

    # --- report ------------------------------------------------------------
    no = sum(len(v["optical"]) for v in armed.values())
    nr = sum(len(v["radars"]) for v in armed.values())
    nw = sum(len(v["weapons"]) for v in armed.values())
    print(f"{len(unitdefs)} unit definitions, {len(weapons)} weapon definitions")
    print(f"{len(armed)} units with a radar or a weapon")
    print(f"   {nr} radars, {no} optical detectors, {nw} weapon envelopes")
    if orphan_radars or orphan_weapons:
        print(f"   unattached: {orphan_radars} radars, {orphan_weapons} weapons")
    if failed:
        print(f"   {failed} MonoBehaviours could not be laid out (unrelated classes)")

    print(f"   {len(airframes)} airframes for the RCS picker")
    rcs = sorted(v["rcs"] for v in out.values() if v["rcs"] > 0)
    if rcs:
        print(f"\nRCS spread across {len(rcs)} types: "
              f"min {rcs[0]}, median {rcs[len(rcs)//2]}, max {rcs[-1]}")

    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
