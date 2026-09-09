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

# Air density is sampled from the game's own curve into a flat table, because
# the planner only needs to look it up, not edit it. Linear interpolation
# between 500 m steps is well inside the accuracy of everything else here.
DENSITY_STEP_M = 500
DENSITY_TOP_M  = 25000


def curve_eval(curve, t):
    """Unity AnimationCurve evaluation: cubic Hermite between keyframes."""
    keys = (curve or {}).get("m_Curve") or []
    if not keys:
        return 0.0
    if t <= keys[0]["time"]:
        return keys[0]["value"]
    if t >= keys[-1]["time"]:
        return keys[-1]["value"]
    for a, b in zip(keys, keys[1:]):
        if a["time"] <= t <= b["time"]:
            dt = b["time"] - a["time"]
            if dt <= 0:
                return a["value"]
            u = (t - a["time"]) / dt
            m0, m1 = a["outSlope"] * dt, b["inSlope"] * dt
            u2, u3 = u * u, u * u * u
            return ((2 * u3 - 3 * u2 + 1) * a["value"] + (u3 - 2 * u2 + u) * m0 +
                    (-2 * u3 + 3 * u2) * b["value"] + (u3 - u2) * m1)
    return keys[-1]["value"]


def delta_v(mass, motors):
    """Tsiolkovsky, staged, exactly as Missile.CalcDeltaV does it."""
    total, m = 0.0, mass
    for mo in motors:
        fuel = mo.get("fuelMass", 0.0)
        if fuel > 0 and m > fuel:
            exhaust = mo.get("thrust", 0.0) * mo.get("burnTime", 0.0) / fuel
            total += exhaust * math.log(m / (m - fuel))
        m -= fuel
    return total


def glide_ratio(body):
    """Best lift-to-drag over the modelled angle of attack range.

    A glide weapon's reach is set by how far it can trade height for distance,
    which is this ratio. Sampled rather than solved: the curves are arbitrary
    and a scan of one degree steps is more than precise enough against a
    weapon released by hand.
    """
    lift, drag = body.get("liftCurve"), body.get("dragCurve")
    best = 0.0
    for deg in range(1, 31):
        t = math.radians(deg)
        d = curve_eval(drag, t)
        if d > 0:
            best = max(best, curve_eval(lift, t) / d)
    return best


def scanner_height(trans, tid):
    """Height of a detector's scanner above its unit's origin, in metres.

    A sensor is not at the vehicle's feet. The radar station carries its
    antenna on a three storey building; a carrier carries it up the island.
    That height sets how far the sensor can see over terrain, so it has to come
    from the prefab rather than from a guess.

    Walks up the Transform parents summing local Y, scaled by each parent's Y
    scale. Rotation is ignored: these are upright mounts, and a scanner tilted
    far enough for it to matter would be a different problem.
    """
    height, scale, guard = 0.0, 1.0, 0
    while tid in trans and guard < 40:
        guard += 1
        t = trans[tid]
        height += (t.get("m_LocalPosition") or {}).get("y", 0.0) * scale
        scale *= (t.get("m_LocalScale") or {}).get("y", 1.0)
        nxt = t.get("m_Father")
        tid = nxt.get("m_PathID") if isinstance(nxt, dict) else None
        if not tid:
            break
    return height


def pptr(d, key):
    """Path id behind a PPtr field, or None when it is unset."""
    v = d.get(key)
    if isinstance(v, dict) and v.get("m_PathID"):
        return v["m_PathID"]
    return None


def components_of(gobj, mono, go_id):
    """Every MonoBehaviour hanging off one GameObject."""
    go = gobj.get(go_id)
    if not go:
        return []
    out = []
    for c in go.get("m_Component", []):
        ref = c.get("component") if isinstance(c, dict) else None
        if isinstance(ref, dict) and ref.get("m_PathID") in mono:
            out.append(mono[ref["m_PathID"]])
    return out


def flight_model(info, gobj, mono):
    """Everything needed to fly one munition, or None if it is not a weapon.

    Four kinds, because the game flies them differently:

      motor      thrust, then coast against drag - Missile.CalcRange
      glide      no thrust; trades altitude for distance at its best L/D
      ballistic  no thrust, no lift; falls under gravity while drag bleeds speed
      gun        leaves at muzzle velocity and slows
    """
    gid = pptr(info, "weaponPrefab")
    body = seeker = None
    for comp in components_of(gobj, mono, gid) if gid else []:
        if "motors" in comp or "supersonicDrag" in comp:
            body = comp
        elif "minSpeed" in comp:
            seeker = comp

    # The munition's own radar signature, for working out when the WEAPON is
    # seen rather than the aircraft. It lives on the projectile's UnitDefinition
    # - a missile in flight is a unit like any other, which is also why air
    # defences can shoot at one.
    rcs = 0.0
    for comp in components_of(gobj, mono, gid) if gid else []:
        dref = pptr(comp, "definition")
        if dref and dref in mono and "radarSize" in mono[dref]:
            rcs = mono[dref]["radarSize"]
            break

    common = {
        "rcs":      round(rcs, 6),
        "muzzle":   info.get("muzzleVelocity", 0.0),
        "dragCoef": info.get("dragCoef", 0.0),
        "gravMult": info.get("gravMult", 1.0),
        "mass":     info.get("massPerRound", 0.0),
    }

    if info.get("gun"):
        return dict(common, kind="gun")

    if not body:
        return dict(common, kind="ballistic")

    motors = [m for m in (body.get("motors") or [])]
    thrust = max((m.get("thrust", 0.0) for m in motors), default=0.0)

    model = {
        "bodyMass": body.get("mass", 0.0),
        "finArea":  body.get("finArea", 0.0),
        "cd":       round(curve_eval(body.get("dragCurve"), math.pi / 360), 6),
        "superDrag": body.get("supersonicDrag", 0.0),
        "minSpeed": (seeker or {}).get("minSpeed", 0.0),
    }
    model.update(common)

    if thrust > 0:
        dry = body.get("mass", 0.0) - sum(m.get("fuelMass", 0.0) for m in motors)
        model.update(
            kind="motor",
            dryMass=round(dry, 2),
            burnTime=round(sum(m.get("burnTime", 0.0) for m in motors), 3),
            lastThrust=motors[-1].get("thrust", 0.0),
            deltaV=round(delta_v(body.get("mass", 0.0), motors), 1),
        )
    else:
        ratio = glide_ratio(body)
        model.update(kind="glide" if ratio > 1.5 else "ballistic",
                     dryMass=round(body.get("mass", 0.0), 2),
                     glideRatio=round(ratio, 2))
    return model


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
    gobj = {}                 # path_id -> GameObject, for prefab components
    trans = {}                # path_id -> Transform, for scanner heights
    failed = 0
    for o in env.objects:
        if o.type.name == "GameObject":
            try:
                gobj[o.path_id] = o.read_typetree()
            except Exception:
                pass
            continue
        if o.type.name == "Transform":
            try:
                trans[o.path_id] = o.read_typetree()
            except Exception:
                pass
            continue
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
            "mast":          round(scanner_height(trans, pptr(d, "scanner")), 2),
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
                 "mast": round(scanner_height(trans, pptr(d, "scanner")), 2),
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
                "flight":      flight_model(info, gobj, mono),
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
    # The tallest sensor on the unit. Line of sight is worked out once per
    # unit, so it uses the best vantage point that unit has.
    for v in out.values():
        masts = [s.get("mast", 0.0) for s in v["radars"] + v["optical"]]
        v["mast"] = round(max(masts), 2) if masts else 0.0

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

    # Every weapon in the game, not only those bolted to a unit. Release points
    # fire aircraft munitions, and aircraft carry no fixed stations - their
    # loadouts are chosen per mission - so those weapons appear nowhere in
    # `units` and would be missing from the munition picker.
    arsenal = {}
    for info in weapons.values():
        name = info.get("weaponName") or info.get("m_Name") or ""
        # Energy weapons, jammers, troops and cargo are not munitions with a
        # time of flight, and a release point has nothing to do with them.
        if not name or any(info.get(f) for f in
                           ("hideInDisplay", "cargo", "energy", "jammer",
                            "troops", "sling", "rearmGround")):
            continue
        tr = info.get("targetRequirements", {})
        arsenal[name] = {
            "short":       info.get("shortName") or name,
            "flight":      flight_model(info, gobj, mono),
            "minRange":    tr.get("minRange", 0.0),
            "maxRange":    tr.get("maxRange", 0.0),
            "minAltitude": tr.get("minAltitude", 0.0),
            "maxAltitude": tr.get("maxAltitude", 0.0),
            "guided":      bool(info.get("missile") or info.get("laserGuided")
                                or info.get("glideBomb")),
            # RoleIdentity weights. antiSurface separates a strike weapon from
            # an air-to-air one far more reliably than the name does.
            "roles":       {k: round(v, 3) for k, v in
                            (info.get("effectiveness") or {}).items()},
            "nuclear":     bool(info.get("nuclear")),
        }

    # The air density curve lives on GameAssets and is shared by every weapon.
    density = None
    for d in mono.values():
        if "airDensityAltitude" in d:
            density = [round(curve_eval(d["airDensityAltitude"], m / 1000.0), 5)
                       for m in range(0, DENSITY_TOP_M + 1, DENSITY_STEP_M)]
            break

    payload = {
        "_source": "extracted from resources.assets - see extract_ranges.py",
        "_formula": "radar detection_range = maxRange / minSignal * RCS**0.25",
        "_optical": "optical/IR range = min(visualRange, target.visibleRange * magnification) "
                    "- independent of RCS",
        "_horizon": "sqrt(12742000*radarAlt) + sqrt(12742000*targetAlt) >= groundDist",
        "units": dict(sorted(armed.items())),
        "airDensity": {"stepM": DENSITY_STEP_M, "table": density or []},
        "arsenal": dict(sorted(arsenal.items())),
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

    tall = sorted(((v["mast"], k) for k, v in armed.items() if v["mast"] > 0),
                  reverse=True)[:3]
    if tall:
        print("   tallest sensors: " +
              ", ".join(f"{k} {m:.1f} m" for m, k in tall))
    print(f"   {len(airframes)} airframes for the RCS picker")
    kinds = {}
    for v in armed.values():
        for w in v["weapons"]:
            k = (w.get("flight") or {}).get("kind", "none")
            kinds[k] = kinds.get(k, 0) + 1
    print("   flight models: " + ", ".join(f"{v} {k}" for k, v in sorted(kinds.items())))
    akinds = {}
    for w in arsenal.values():
        k = (w.get("flight") or {}).get("kind", "none")
        akinds[k] = akinds.get(k, 0) + 1
    print(f"   arsenal: {len(arsenal)} weapons - " +
          ", ".join(f"{v} {k}" for k, v in sorted(akinds.items())))
    print(f"   air density table: {len(density or [])} steps of {DENSITY_STEP_M} m")
    rcs = sorted(v["rcs"] for v in out.values() if v["rcs"] > 0)
    if rcs:
        print(f"\nRCS spread across {len(rcs)} types: "
              f"min {rcs[0]}, median {rcs[len(rcs)//2]}, max {rcs[-1]}")

    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
