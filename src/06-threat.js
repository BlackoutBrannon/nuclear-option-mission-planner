/* ---------------------------------------------------------------------------
   Threat rings: what each unit projects, and drawing them.

   Part 6 of 11 of the planner. These files are plain scripts sharing one
   global scope, loaded in the order listed in index.html - not ES modules - so
   a name declared in an earlier file is visible in every later one. Order is
   therefore significant: top-level code in one file can only use values already
   declared by the files above it.
   --------------------------------------------------------------------------- */

// ---------------------------------------------------------------------------
// Automatic threat rings
//
// Every radius below comes from ranges.json, which is extracted from the game's
// own serialized fields - never from a unit description.
//
// Three kinds, told apart by LINE PATTERN rather than colour alone:
//
//   weapon    solid        the range it will actually shoot you at
//   radar     long dash    where its radar detects YOUR aircraft's RCS
//   optical   dotted       eyeball / IR range, which RCS does not change
//
// A weapon whose altitude band excludes you is drawn faint and sparse: it is
// still there, it just cannot reach you where you are.
// ---------------------------------------------------------------------------
const showRings = { radar: true, optical: false, weapon: true, mask: true };

// 'auto'  place what fits, thinning overlaps and repeats
// 'hover' label only the unit under the cursor
// 'off'   shapes only
let labelMode = 'auto';

// Which individual UNITS draw rings, held as unitPath strings - the same keys
// the layer tree uses. Empty means none: rings stay off until you ask for them,
// because a real mission has ~750 units with envelopes and all of them at once
// is unreadable. The ring-type switches decide WHICH rings; this decides WHOSE.
const ringUnits = new Set();

// Bumped whenever anything that changes the threat picture changes: which units
// are ringed, which ring types are shown, or the aircraft selected. Route
// exposure is expensive to recompute, so it is cached against this number
// rather than recomputed every frame.
let ringEpoch = 0;
function bumpRingEpoch() { ringEpoch++; }

const RING_STYLE = {
    weapon:  { colour: '#f0857a', dash: [],      width: 1.8 },
    radar:   { colour: '#8ecbff', dash: [9, 6],  width: 1.5 },
    optical: { colour: '#ffd166', dash: [2, 4],  width: 1.5 },
};

// Ring toggles. These must be wired AFTER `showRings` exists: a top-level
// `const` is in the temporal dead zone until its own line runs, so reading it
// higher up throws before the page ever paints.
const labelSelect = document.getElementById('ringLabels');
labelSelect.value = labelMode;
labelSelect.addEventListener('change', () => {
    labelMode = labelSelect.value;
    if (currentMission) draw(currentMission);
});

for (const [id, key] of [['ringWeapon', 'weapon'], ['ringRadar', 'radar'],
                         ['ringOptical', 'optical'], ['ringMask', 'mask']]) {
    const box = document.getElementById(id);
    box.checked = showRings[key];
    box.addEventListener('change', () => {
        showRings[key] = box.checked;
        bumpRingEpoch();
        if (currentMission) draw(currentMission);
    });
}

// ---------------------------------------------------------------------------
// The ring tree
//
// Same five levels as the layer tree - affiliation, group, role, type, unit -
// because that is the shape you already navigate. Ticking is per UNIT, not per
// type, so "one flight clears these three sites and the second routes past the
// rest" is expressible: untick the three, leave the others ringed.
//
// Only units that actually have envelope data appear, so the tree does not fill
// with fuel trucks that can draw nothing.
// ---------------------------------------------------------------------------
const ringTreeEl   = document.getElementById('ringTree');
const ringCollapsed = new Set();
const LONG_RANGE_M = 15000;

// Longest reach a type has, in metres. Radar is quoted against the CURRENTLY
// selected aircraft rather than a reference target, so the number answers
// "what reaches me" and moves when you change RCS.
function typeReach(type) {
    const e = (ranges.units || {})[type];
    if (!e) return 0;
    const weapon = e.weapons.reduce((m, w) => Math.max(m, w.maxRange), 0);
    const radar  = e.radars.reduce((m, r) => Math.max(
        m, r.minSignal ? r.maxRange / r.minSignal * Math.pow(ownRCS, 0.25) : 0), 0);
    // Optical counts too, or a unit whose only sensor is a pair of eyes reads
    // as nothing while still being able to draw a ring.
    const optical = e.optical.reduce((m, o) => Math.max(
        m, Math.min(o.visualRange, ownVisibleRange() * o.magnification)), 0);

    // Projected onto the ground at your current altitude, so the column agrees
    // with the ring on the map. Emitters are assumed near sea level, which they
    // are - the per-unit y is used when the ring is actually drawn.
    const slant = Math.max(weapon, radar, optical);
    return slant > ownAltM ? Math.sqrt(slant * slant - ownAltM * ownAltM) : 0;
}

const ringSpec = {
    container: ringTreeEl,
    collapsed: ringCollapsed,
    // Only things that can draw a ring at all.
    filter: u => !!(ranges.units || {})[u.type],
    isOn:  p => ringUnits.has(p),
    setOn: (paths, on) => {
        paths.forEach(p => on ? ringUnits.add(p) : ringUnits.delete(p));
        bumpRingEpoch();
    },
    refresh: () => { renderRingTree(); if (currentMission) draw(currentMission); },
    render:  () => renderRingTree(),
    // An em dash rather than "0.0 NM": zero would look like missing data when
    // it actually means you are above everything this type can reach.
    extraForType: t => { const r = typeReach(t); return r > 0 ? fmtRange(r) : '\u2014'; },
    emptyText: 'Load a mission to list what can shoot at you.',
};

function renderRingTree() {
    if (!currentMission) {
        ringTreeEl.innerHTML =
            '<div class="hint">Load a mission to list what can shoot at you.</div>';
        return;
    }
    buildTree(ringSpec, unitsOf(currentMission));
}

// Bulk selection. Works on units, like the tree itself, so "long range" picks
// every individual emplacement of a type that reaches far enough.
function setRingUnits(pick) {
    ringUnits.clear();
    bumpRingEpoch();
    if (currentMission) {
        for (const u of unitsOf(currentMission)) {
            if (!(ranges.units || {})[u.type]) continue;
            if (pick(u)) ringUnits.add(unitPath(u));
        }
    }
    renderRingTree();
    if (currentMission) draw(currentMission);
}

document.getElementById('ringNone').addEventListener('click',
    () => setRingUnits(() => false));
document.getElementById('ringAll').addEventListener('click',
    () => setRingUnits(() => true));
document.getElementById('ringLong').addEventListener('click',
    () => setRingUnits(u => typeReach(u.type) >= LONG_RANGE_M));

// Visual range of the airframe selected in the status bar. Optical sensors
// test the target's own visibility, so this value tracks the airframe and is
// independent of RCS.
function ownVisibleRange() {
    const a = (ranges.airframes || {})[rcsPreset.value];
    return a ? a.visibleRange : 3000;
}

// Rings a single unit produces at the current own-ship settings. Recomputed
//per draw, since every radius depends on the RCS and altitude in the status bar.
// `alt` defaults to the altitude on the bar. Route legs pass their own, so the
// same envelope maths answers both "what reaches me where I am" and "what
// reached me at that point on the route".
// `all` ignores the ring-type switches. Those switches say what to DRAW, and
// analysis must not change because a ring was hidden to reduce clutter: turning
// off optical rings would otherwise take every eyeball-only site out of the
// exposure answer while leaving it very much in the mission.
function threatRingsFor(unit, alt, rcs, all) {
    if (!ringUnits.has(unitPath(unit))) return [];
    const entry = (ranges.units || {})[unit.type];
    if (!entry) return [];

    const ownAlt = (alt === undefined) ? ownAltM : alt;
    // The signature being detected. Defaults to the aircraft on the bar, but a
    // munition in flight is a much smaller target and asks the same question.
    const sig = (rcs === undefined) ? ownRCS : rcs;

    const rings = [];

    // Radar horizon: the game adds the distance to the horizon from each end
    // and rejects the contact if the sum falls short. A mast is a few metres
    // up even when the vehicle is at sea level. This one IS a ground distance -
    // DetectorManager tests it against the flattened vector.
    const emitterAlt = sensorHeight(unit);
    const horizon = horizonM(ownAlt) + horizonM(emitterAlt);

    // Every range test in the game is SLANT range: Turret uses
    // aimVector.magnitude, the radar uses FastMath.Distance, and
    // FastMath.InRange sums x, y and z. A map is flat, so the drawable radius
    // is the ground projection of that sphere. An envelope therefore contracts
    // with increasing altitude difference and closes entirely once the
    // difference exceeds the slant range.
    const dh = Math.abs(ownAlt - emitterAlt);
    const groundFrom = slant =>
        slant > dh ? Math.sqrt(slant * slant - dh * dh) : 0;

    if (all || showRings.radar) {
        for (const r of entry.radars) {
            if (!r.minSignal) continue;
            const slant  = r.maxRange / r.minSignal * Math.pow(sig, 0.25);
            const ground = groundFrom(slant);
            if (ground <= 0) continue;
            rings.push({
                kind:  'radar',
                los:   true,          // detection raycasts against terrain
                r:     Math.min(ground, horizon),
                // Set when the horizon, not the radar, is the binding limit.
                // Such a ring expands again with altitude.
                capped: ground > horizon,
                label: 'RADAR ' + fmtRange(Math.min(ground, horizon)),
            });
        }
    }

    if (all || showRings.optical) {
        for (const o of entry.optical) {
            const ground = groundFrom(
                Math.min(o.visualRange, ownVisibleRange() * o.magnification));
            if (ground <= 0) continue;
            rings.push({ kind: 'optical', los: true, r: ground,
                         label: 'VIS ' + fmtRange(ground) });
        }
    }

    if (all || showRings.weapon) {
        for (const w of entry.weapons) {
            const ground = groundFrom(w.maxRange);
            if (ground <= 0) continue;          // you are above its reach entirely
            rings.push({
                kind:   'weapon',
                // Only weapons whose targetRequirements demand line of sight
                // are masked. Indirect fire - MLRS, ballistic missiles - has
                // the flag clear and reaches over terrain.
                los:    w.lineOfSight,
                // A weapon refuses a target moving faster than this. It is what
                // makes a fast missile untouchable by short range air defence.
                maxSpeed: w.maxSpeed || 0,
                r:      ground,
                // The altitude band is a separate hard gate in
                // TargetRequirements - a weapon can be in range and still not
                // be cleared to engage at your height.
                inBand: ownAlt >= w.minAltitude && ownAlt <= w.maxAltitude,
                label:  w.name + '  ' + fmtRange(ground),
            });
        }
    }

    return rings;
}

// Drawn UNDER the unit symbols, like the bullseye rose and the manual rings.
function drawThreatRings(ctx, units) {
    if (!ringUnits.size) return;
    if (!showRings.radar && !showRings.optical && !showRings.weapon) return;

    const mPerPx = fit.scale * view.scale;
    const masking = showRings.mask && terrain && !maskSuspended;

    const labels = [];
    drawnRings  = [];
    drawnLabels = [];

    ctx.save();
    for (const unit of units) {
        const rings = threatRingsFor(unit);
        if (!rings.length) continue;

        const p = toScreen(unit.x, unit.z);

        // One profile per unit, walked to its widest ring. The cutoff along a
        // radial does not depend on which ring is being drawn, so narrower
        // rings clamp the same profile rather than recomputing it.
        let profile = null;
        if (masking) {
            const widest = rings.reduce((m, r) => Math.max(m, r.r), 0);
            profile = maskProfileFor(unit, widest, ownAltM);
        }

        for (let i = 0; i < rings.length; i++) {
            const ring = rings[i];
            const rpx = ring.r * mPerPx;
            if (rpx < 3) continue;                   // too small to read
            const style = RING_STYLE[ring.kind];
            const inert = ring.inBand === false;

            const prof = ring.los ? profile : null;
            const key  = ringKey(unit, ring);
            const hot  = hoveredRing && hoveredRing.key === key;

            drawnRings.push({ x: p.x, y: p.y, mPerPx: mPerPx, profile: prof,
                              ring: ring, unit: unit, key: key });

            // Halo first, as everywhere else, so a thin ring survives terrain.
            ctx.setLineDash(inert ? [3, 7] : style.dash);
            ctx.strokeStyle = 'rgba(11,16,20,0.55)';
            ctx.lineWidth   = style.width + 2;
            ringPath(ctx, p, ring.r, mPerPx, prof);
            ctx.stroke();

            // The hovered ring is drawn white and thicker. Brightness and
            // weight rather than a colour change, so it separates from its
            // neighbours without depending on hue.
            ctx.globalAlpha = hot ? 1 : (inert ? 0.3 : 0.85);
            ctx.strokeStyle = hot ? '#ffffff' : style.colour;
            ctx.lineWidth   = hot ? style.width + 1.6 : style.width;
            ringPath(ctx, p, ring.r, mPerPx, prof);
            ctx.stroke();
            ctx.globalAlpha = 1;

            // Labelled only above 70 px radius, to limit clutter on a dense
            // map. Labels are spaced 22 degrees apart around the upper arc so
            // that concentric rings on one unit do not overlap.
            // Widest point the ring actually reaches. A masked ring can be a
            // fraction of its nominal radius, and labelling it by the radius it
            // would have had puts a number where there is no ring.
            let visibleR = ring.r;
            if (prof) {
                visibleR = 0;
                for (let k = 0; k < prof.length; k++) {
                    visibleR = Math.max(visibleR, Math.min(prof[k], ring.r));
                }
            }

            if (visibleR * mPerPx > 70 && labelMode !== 'off' &&
                (labelMode === 'auto' || unit === hoveredUnit)) {
                // Anchored ON the outline, offset per ring so several rings on
                // one unit start apart before placement runs.
                //
                // A ring wider than the viewport has most of its circumference
                // off-screen, so the preferred anchor is tried first and then
                // rotated until a point lands in view. Without the rotation the
                // largest rings - the ones that matter most - go unlabelled.
                //
                // The radius is re-read for each angle tried, because a masked
                // ring reaches a different distance along every bearing.
                const base = -90 + i * 22;
                let lx = 0, ly = 0, onScreen = false;
                for (let k = 0; k < 12 && !onScreen; k++) {
                    const deg = base + k * 30;
                    const a   = deg * Math.PI / 180;

                    // Screen angle -90 is up, which is bearing 000.
                    const bearing = (((deg + 90) % 360) + 360) % 360 * Math.PI / 180;
                    const rHere = (prof ? ringRadiusAt(ring, prof, bearing) : ring.r)
                                  * mPerPx;
                    if (rHere < 10) continue;      // masked to nothing this way

                    lx = p.x + Math.cos(a) * rHere;
                    ly = p.y + Math.sin(a) * rHere;
                    onScreen = lx > 40 && lx < canvas.width - 40 &&
                               ly > 12 && ly < canvas.height - 12;
                }
                if (onScreen) {
                    labels.push({
                        text: ring.label + (ring.capped ? ' (horizon)' : ''),
                        x: lx, y: ly, kind: ring.kind, r: ring.r,
                        colour: inert ? 'rgba(240,133,122,0.5)' : style.colour,
                        key: ringKey(unit, ring), unit: unit, ring: ring,
                    });
                }
            }
        }
    }
    ctx.setLineDash([]);

    // Placed after every ring is drawn, so a label is never buried by a ring
    // rendered later.
    placeLabels(ctx, labels);
    ctx.restore();
}
