/* ---------------------------------------------------------------------------
   Flights, routes, waypoints, designated targets, and time on target.

   Part 8 of 11 of the planner. These files are plain scripts sharing one
   global scope, loaded in the order listed in index.html - not ES modules - so
   a name declared in an earlier file is visible in every later one. Order is
   therefore significant: top-level code in one file can only use values already
   declared by the files above it.
   --------------------------------------------------------------------------- */

// ---------------------------------------------------------------------------
// Flights and routes
//
// A flight is an ordered list of waypoints, each carrying its own altitude, so
// a route can descend into a valley and climb out again. Altitude is per
// waypoint rather than per flight because it is what decides whether a leg sits
// inside a threat envelope, and that changes along a route.
//
// Waypoints are world metres, like everything else on the map, so a route holds
// its position through pan and zoom.
// ---------------------------------------------------------------------------
const FLIGHT_COLOURS = [
    '#8ecbff', '#ffd166', '#6ee7b7', '#e58fd0', '#f0a37a', '#a5b4fc',
];

const flights = [];      // { name, colour, visible, waypoints: [{x,z,alt}] }
let activeFlight = -1;   // index into flights, or -1

// Appending waypoints to the active flight. A mode, like measuring, so the
// left button drops a waypoint rather than starting a pan.
let routeMode = false;
let routeCursor = null;  // world position of the rubber band end
let dragWaypoint = null; // { flight, index } while one is being moved

function flightTotal(f) {
    let total = 0;
    for (let i = 1; i < f.waypoints.length; i++) {
        total += bearingRange(f.waypoints[i - 1], f.waypoints[i]).range;
    }
    return total;
}

// Measuring and route editing both claim the left button, so starting either
// one ends the other. Two live modes would leave a click ambiguous.
function endRouteMode() {
    routeMode = false;
    routeCursor = null;
    canvas.style.cursor = '';
    renderFlights();
    if (currentMission) draw(currentMission);
}

function startRouteMode() {
    if (activeFlight < 0) return;
    clearMeasure();
    routeMode = true;
    canvas.style.cursor = 'crosshair';
    renderFlights();
    if (currentMission) draw(currentMission);
}

function newFlight() {
    flights.push({
        name: 'Flight ' + (flights.length + 1),
        colour: FLIGHT_COLOURS[flights.length % FLIGHT_COLOURS.length],
        visible: true,
        // Release speed feeds straight into time of flight, so a flight needs
        // one even before it has a route. 250 m/s is a workable cruise.
        speed: 250,
        waypoints: [],
    });
    activeFlight = flights.length - 1;
    startRouteMode();
}

// The waypoint under the cursor, searched newest first so an overlapping pair
// resolves to the one drawn on top.
function waypointAt(sx, sy) {
    for (let fi = flights.length - 1; fi >= 0; fi--) {
        const f = flights[fi];
        if (!f.visible) continue;
        for (let i = f.waypoints.length - 1; i >= 0; i--) {
            const p = toScreen(f.waypoints[i].x, f.waypoints[i].z);
            if (Math.hypot(sx - p.x, sy - p.y) < 9) return { flight: fi, index: i };
        }
    }
    return null;
}

function drawFlights(ctx) {
    for (let fi = 0; fi < flights.length; fi++) {
        const f = flights[fi];
        if (!f.visible || !f.waypoints.length) continue;

        const pts = f.waypoints.slice();
        if (routeMode && fi === activeFlight && routeCursor) pts.push(routeCursor);
        const scr = pts.map(w => toScreen(w.x, w.z));

        drawExposure(ctx, f);

        ctx.save();

        // Halo then the line, as elsewhere, so a route stays legible over any
        // terrain and over the threat rings beneath it.
        for (const pass of [{ c: 'rgba(11,16,20,0.9)', w: 5 },
                            { c: f.colour,             w: 2.2 }]) {
            ctx.strokeStyle = pass.c;
            ctx.lineWidth   = pass.w;
            ctx.beginPath();
            ctx.moveTo(scr[0].x, scr[0].y);
            for (let i = 1; i < scr.length; i++) ctx.lineTo(scr[i].x, scr[i].y);
            ctx.stroke();
        }

        // Numbered waypoints. The number is what identifies a waypoint in the
        // panel, so it is on the map rather than a bare dot.
        ctx.font = '600 10px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < f.waypoints.length; i++) {
            const q = scr[i];
            const hot = dragWaypoint && dragWaypoint.flight === fi &&
                        dragWaypoint.index === i;
            ctx.beginPath();
            ctx.arc(q.x, q.y, hot ? 9 : 7, 0, Math.PI * 2);
            ctx.fillStyle   = hot ? '#ffffff' : f.colour;
            ctx.strokeStyle = '#0b1014';
            ctx.lineWidth   = 2;
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#0b1014';
            ctx.fillText(String(i + 1), q.x, q.y + 0.5);
        }

        // Leg detail at the midpoint, skipped when the leg is too short to
        // hold it without covering its own waypoints.
        for (let i = 1; i < pts.length; i++) {
            const a = scr[i - 1], b = scr[i];
            if (Math.hypot(b.x - a.x, b.y - a.y) < 60) continue;
            const br = bearingRange(pts[i - 1], pts[i]);
            plate(ctx, fmtBearing(br.bearing) + '  ' + fmtRange(br.range),
                  (a.x + b.x) / 2, (a.y + b.y) / 2, f.colour);
        }

        plate(ctx, f.name, scr[0].x, scr[0].y - 16, f.colour);
        ctx.restore();

        // ON TOP of the route line, unlike the exposure on placed legs. This is
        // a warning about the click you are about to make, so it has to win
        // against the line it is warning about.
        drawReleasePoints(ctx, f);
        if (fi === activeFlight) drawPendingLeg(ctx);
    }
}

// The centre mark, drawn on top of the units so it is never buried. Constant
// screen size, unlike the rose.
function drawBullseyeCentre(ctx) {
    if (!bullseye) return;

    const p = toScreen(bullseye.x, bullseye.z);

    ctx.save();
    // Dark halo first, then the bright mark, so it reads on any terrain.
    for (const pass of [{ c: '#0b1014', w: 4 }, { c: BULL_HEX, w: 1.6 }]) {
        ctx.strokeStyle = pass.c;
        ctx.lineWidth   = pass.w;

        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(p.x - 13, p.y); ctx.lineTo(p.x + 13, p.y);
        ctx.moveTo(p.x, p.y - 13); ctx.lineTo(p.x, p.y + 13);
        ctx.stroke();
    }

    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#0b1014';
    ctx.strokeText('BULLSEYE', p.x + 17, p.y - 6);
    ctx.fillStyle = BULL_HEX;
    ctx.fillText('BULLSEYE', p.x + 17, p.y - 6);

    ctx.restore();
}

// ---------------------------------------------------------------------------
// Route exposure
//
// Walks each leg and asks, at every sample, whether that point is inside any
// threat envelope AT THAT POINT'S ALTITUDE. This is the reason waypoints carry
// their own altitude: a leg that descends into a valley leaves envelopes a
// level leg would sit inside.
//
// Two states are distinguished, because they mean different things:
//
//   TERRAIN   below the ground: the altitude is not flyable here at all
//   ENGAGED   inside a weapon envelope whose altitude band includes you
//   DETECTED  inside a radar or optical envelope but nothing can shoot
//
// TERRAIN is checked first and reported separately because it would otherwise
// come back CLEAR - nothing can see through a mountain - which is true and
// useless. A route that reads clear because it is underground is a fatal route
// described as a safe one.
//
// Scope is the units ticked in the ring panel. That panel already means "the
// threats I am working against", and it keeps the cost bounded and predictable
// rather than silently walking all 750 units with envelope data.
// ---------------------------------------------------------------------------
const EXPOSURE_STEP = 500;      // metres between samples along a leg

let showExposure = true;

// Threat state at one point in space, at one altitude.
function exposureAt(x, z, alt) {
    // Altitudes are MSL, so a low figure over high ground puts the aircraft
    // inside the hill rather than over it.
    if (terrain && alt < terrainAt(x, z)) return 'terrain';

    let engaged = null, detected = null;

    for (const u of unitsOf(currentMission)) {
        if (!ringUnits.has(unitPath(u))) continue;

        const rings = threatRingsFor(u, alt);
        if (!rings.length) continue;

        const br = bearingRange({ x: u.x, z: u.z }, { x: x, z: z });
        const widest = rings.reduce((m, r) => Math.max(m, r.r), 0);
        if (br.range > widest) continue;          // outside everything this unit has

        let profile = null;
        if (showRings.mask && terrain) profile = maskProfileFor(u, widest, alt);

        for (const ring of rings) {
            const reach = (ring.los && profile)
                ? ringRadiusAt(ring, profile, br.bearing * Math.PI / 180)
                : ring.r;
            if (br.range > reach) continue;

            if (ring.kind === 'weapon') {
                if (ring.inBand !== false && !engaged) engaged = ring.label;
            } else if (!detected) {
                detected = unitName(u.type);
            }
        }
        if (engaged) break;                       // engaged is the worst case
    }
    return engaged ? 'engaged' : (detected ? 'detected' : 'clear');
}

// One segment between two points that carry altitudes. Used for stored legs and
// for the leg being dragged out, which does not exist as a waypoint yet.
function segmentExposure(a, b, step) {
    const dist  = bearingRange(a, b).range;
    const steps = Math.max(2, Math.ceil(dist / (step || EXPOSURE_STEP)));
    const states = [];

    for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        states.push(exposureAt(a.x + (b.x - a.x) * t,
                               a.z + (b.z - a.z) * t,
                               a.alt + (b.alt - a.alt) * t));
    }

    // Distance in each state. A sample stands for the span around it, so each
    // interior sample counts a full step and the two ends count half.
    const span = dist / steps;
    const tally = { clear: 0, detected: 0, engaged: 0, terrain: 0 };
    for (let k = 0; k <= steps; k++) {
        tally[states[k]] += (k === 0 || k === steps) ? span / 2 : span;
    }
    return { states: states, dist: dist, tally: tally };
}

// Per-leg samples for one flight, cached against the threat picture and the
// route itself so panning and zooming never trigger a recompute.
function flightExposure(f) {
    const sig = ringEpoch + '|' + ownRCS + '|' + (terrain ? 1 : 0) + '|' +
                f.waypoints.map(w => Math.round(w.x) + ',' + Math.round(w.z) +
                                     ',' + Math.round(w.alt)).join(';');
    if (f._expSig === sig) return f._exposure;

    const legs = [];
    for (let i = 1; i < f.waypoints.length; i++) {
        legs.push(segmentExposure(f.waypoints[i - 1], f.waypoints[i]));
    }

    f._expSig = sig;
    f._exposure = legs;
    return legs;
}

// Overlaid on the route line: thick solid where a weapon reaches, medium dashed
// where something sees you but cannot shoot. Weight and pattern carry the
// distinction, not colour alone.
// Terrain carries a WHITE hazard stripe over its red bar. Engaged is red too -
// it is the danger colour and belongs on the thing that shoots you - so red
// alone cannot distinguish them, and two shades of red at a glance do not
// either. The stripe is the distinction; the red says both are bad.
// Drawn UNDER the route line as a casing around it, so the flight colour stays
// readable through the middle. The widths therefore have to clear the route's
// own 5 px halo by enough to read as a band rather than a fringe - at 8 px only
// a pixel and a half showed either side, which looked like an artefact.
const EXPOSURE_STYLE = {
    terrain:  { colour: '#ff3b30', width: 15, dash: [],
                over: '#ffffff', overWidth: 15, overDash: [6, 7] },
    engaged:  { colour: '#f0857a', width: 12, dash: [] },
    detected: { colour: '#ffd166', width: 10, dash: [9, 6] },
};

// The pending leg is louder than a placed one: heavier, fully opaque, and for
// terrain a hazard stripe - a solid red bar with white dashes laid over it.
// Two passes rather than one colour, so it reads as a warning by pattern as
// well as by hue.
const PENDING_STYLE = {
    terrain:  { colour: '#ff3b30', width: 10, dash: [],
                over: '#ffffff', overWidth: 10, overDash: [6, 6] },
    engaged:  { colour: '#ff6b5e', width: 7, dash: [] },
    detected: { colour: '#ffd166', width: 5, dash: [9, 6] },
};

function drawExposure(ctx, f) {
    if (!showExposure || f.waypoints.length < 2) return;
    if (!ringUnits.size || maskSuspended) return;

    const legs = flightExposure(f);

    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < legs.length; i++) {
        const a = f.waypoints[i], b = f.waypoints[i + 1];
        const states = legs[i].states, steps = states.length - 1;

        for (let k = 0; k < steps; k++) {
            // A span is drawn in the worse of the states at its two ends, so a
            // threatened stretch is never understated by half a sample.
            const s = (states[k] === 'terrain' || states[k + 1] === 'terrain')
                    ? 'terrain'
                    : (states[k] === 'engaged' || states[k + 1] === 'engaged')
                    ? 'engaged'
                    : (states[k] === 'detected' || states[k + 1] === 'detected')
                    ? 'detected' : 'clear';
            if (s === 'clear') continue;

            const t0 = k / steps, t1 = (k + 1) / steps;
            const p0 = toScreen(a.x + (b.x - a.x) * t0, a.z + (b.z - a.z) * t0);
            const p1 = toScreen(a.x + (b.x - a.x) * t1, a.z + (b.z - a.z) * t1);

            const st = EXPOSURE_STYLE[s];
            ctx.setLineDash(st.dash);
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = st.colour;
            ctx.lineWidth   = st.width;
            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            ctx.lineTo(p1.x, p1.y);
            ctx.stroke();

            if (st.over) {
                ctx.setLineDash(st.overDash);
                ctx.strokeStyle = st.over;
                ctx.lineWidth   = st.overWidth;
                ctx.beginPath();
                ctx.moveTo(p0.x, p0.y);
                ctx.lineTo(p1.x, p1.y);
                ctx.stroke();
            }
        }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.restore();
}

// ---------------------------------------------------------------------------
// The pending leg
//
// The leg being dragged out is classified the same way a placed one is, so the
// terrain and the threats it would cross are visible BEFORE the click rather
// than after it. That was the gap: a waypoint could be dropped into a hillside
// with nothing on screen to say so until it had already been placed.
//
// Its altitude runs from the last waypoint's to whatever the bar reads, which
// is exactly the altitude the new waypoint would be created with.
//
// Sampled coarsely and recomputed at most every PREVIEW_MS, because this runs
// against pointer movement rather than against an edit.
// ---------------------------------------------------------------------------
const PREVIEW_STEP = 1000;   // metres between samples on the pending leg
const PREVIEW_MS   = 90;     // shortest gap between recomputations

let previewLeg = null;       // { from, to, seg }
let previewAt  = 0;

function pendingLeg() {
    if (!routeMode || activeFlight < 0 || !routeCursor) return null;
    const f = flights[activeFlight];
    if (!f || !f.waypoints.length) return null;

    const from = f.waypoints[f.waypoints.length - 1];
    const to   = { x: routeCursor.x, z: routeCursor.z, alt: ownAltM };

    const stale = !previewLeg ||
                  previewLeg.to.x !== to.x || previewLeg.to.z !== to.z ||
                  previewLeg.from !== from;

    if (stale && performance.now() - previewAt > PREVIEW_MS) {
        previewAt = performance.now();
        previewLeg = { from: from, to: to,
                       seg: segmentExposure(from, to, PREVIEW_STEP) };
    }
    return previewLeg;
}

function drawPendingLeg(ctx) {
    const p = pendingLeg();
    if (!p) return;

    const a = p.from, b = p.to, states = p.seg.states, steps = states.length - 1;

    ctx.save();
    ctx.lineCap = 'round';
    for (let k = 0; k < steps; k++) {
        // TERRAIN ONLY while placing. Threat exposure is worth studying once a
        // leg exists, but painting it on the leg that follows the cursor puts a
        // constantly changing warning over most of the map - and a route
        // deliberately flown into a threat ring is not an error, whereas flying
        // into a hill always is.
        const s = (states[k] === 'terrain' || states[k + 1] === 'terrain')
                ? 'terrain' : 'clear';
        if (s === 'clear') continue;

        const t0 = k / steps, t1 = (k + 1) / steps;
        const p0 = toScreen(a.x + (b.x - a.x) * t0, a.z + (b.z - a.z) * t0);
        const p1 = toScreen(a.x + (b.x - a.x) * t1, a.z + (b.z - a.z) * t1);

        const st = PENDING_STYLE[s];

        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(11,16,20,0.9)';
        ctx.lineWidth   = st.width + 3;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();

        ctx.setLineDash(st.dash);
        ctx.strokeStyle = st.colour;
        ctx.lineWidth   = st.width;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();

        if (st.over) {
            ctx.setLineDash(st.overDash);
            ctx.strokeStyle = st.over;
            ctx.lineWidth   = st.overWidth;
            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
        }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.restore();
}

// One line summarising the pending leg, for the status bar.
function pendingLegText() {
    const p = pendingLeg();
    if (!p) return '';
    const t = p.seg.tally;
    const bits = ['LEG ' + fmtRange(p.seg.dist)];
    // Matches what is drawn: terrain only. The full breakdown appears in the
    // flights panel once the waypoint is placed.
    if (t.terrain > 1) bits.push(fmtRange(t.terrain) + ' BELOW GROUND');
    return bits.join('  ');
}

// ---------------------------------------------------------------------------
// Designated targets
//
// Targets are what the PLANNER nominates, never what the mission file lists as
// its own objectives. A mission's objectives belong to whoever wrote it; a
// target is a decision made while planning against it.
//
// A target is either attached to a unit or a free point on the ground:
//
//   unit    stores the unit's path, and reads its position at draw time, so a
//           target follows the thing it designates and survives the unit list
//           being rebuilt
//   point   stores its own coordinates, for a place rather than a thing - a
//           bridge, a revetment, a mark on a road
// ---------------------------------------------------------------------------
// Ids are stable across removals, because a release point refers to targets by
// id. Positions in the list shift; a reference must not.
let nextTargetId = 1;
const targets = [];       // { id, kind, path?, x?, z?, name }

const TARGET_COLOUR = '#ff5c52';

function targetById(id) {
    return targets.find(t => t.id === id) || null;
}

function targetPos(t) {
    if (t.kind === 'point') return { x: t.x, z: t.z };
    if (!currentMission) return null;
    const u = unitsOf(currentMission).find(x => unitPath(x) === t.path);
    return u ? { x: u.x, z: u.z } : null;   // the unit is gone from this mission
}

function designateUnit(unit) {
    const path = unitPath(unit);
    if (targets.some(t => t.path === path)) return;   // already designated
    targets.push({ id: nextTargetId++, kind: 'unit', path: path,
                   name: unitName(unit.type) });
    renderTargets();
    if (currentMission) draw(currentMission);
}

function designatePoint(at) {
    targets.push({ id: nextTargetId++, kind: 'point', x: at.x, z: at.z,
                   name: 'Point target' });
    renderTargets();
    if (currentMission) draw(currentMission);
}

// Drawn ON TOP of the unit symbols: a designation is an annotation about a
// symbol, so it has to sit over the thing it refers to rather than under it.
//
// A corner reticle rather than another frame or ring - unit symbols are already
// frames and the bullseye is already rings, so the shape has to be unlike both
// at a glance.
function drawTargets(ctx) {
    if (!targets.length) return;

    ctx.save();
    ctx.font = '600 10px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    targets.forEach((t, i) => {
        const w = targetPos(t);
        if (!w) return;
        const p = toScreen(w.x, w.z);

        const R = 13, ARM = 6;
        for (const pass of [{ c: '#0b1014', lw: 5 }, { c: TARGET_COLOUR, lw: 2.4 }]) {
            ctx.strokeStyle = pass.c;
            ctx.lineWidth   = pass.lw;
            ctx.beginPath();
            for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
                ctx.moveTo(p.x + sx * R, p.y + sy * R - sy * ARM);
                ctx.lineTo(p.x + sx * R, p.y + sy * R);
                ctx.lineTo(p.x + sx * R - sx * ARM, p.y + sy * R);
            }
            ctx.stroke();
        }

        // The number is how a target is referred to everywhere else, so it is
        // on the map rather than only in the panel.
        const bx = p.x + R + 7, by = p.y - R - 3;
        ctx.beginPath();
        ctx.arc(bx, by, 8, 0, Math.PI * 2);
        ctx.fillStyle   = TARGET_COLOUR;
        ctx.strokeStyle = '#0b1014';
        ctx.lineWidth   = 2;
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#0b1014';
        ctx.fillText(String(i + 1), bx, by + 0.5);
    });

    ctx.restore();
}

// ---------------------------------------------------------------------------
// Munition flight and time on target
//
// A port of the game's own model rather than an estimate. Missile.CalcRange
// steps a missile forward in time, accumulating distance against drag until it
// falls below its seeker's minimum speed; running the same integration and
// stopping at the target's distance gives the time to reach it.
//
// Validated against the game's cached WeaponInfo.maxSpeed, which it computes
// once from the same equations: StratoLance R9 caches 1393 m/s and the ported
// delta-v gives 1393, Piledriver 1430 against 1430.
//
// Four kinds, because the game flies them differently:
//
//   motor      boost under thrust, then coast - the CalcRange integration
//   glide      no thrust; trades altitude for distance at its best lift/drag
//   ballistic  no thrust, no lift; falls under gravity while drag bleeds speed
//   gun        leaves at muzzle velocity and slows
//
// Every result is an estimate in the sense that the real weapon is guided and
// manoeuvring, which costs energy this model does not charge for. Treat a time
// as a floor rather than a promise.
// ---------------------------------------------------------------------------
const G = 9.81;

function airDensity(altM) {
    const d = (ranges.airDensity || {});
    const table = d.table || [];
    if (!table.length) return 1.225;

    const f = Math.max(0, altM) / (d.stepM || 500);
    const i = Math.min(table.length - 1, Math.floor(f));
    const j = Math.min(table.length - 1, i + 1);
    return table[i] + (table[j] - table[i]) * (f - i);
}

// Time for one munition to cover `dist` on the ground, released at `speed` and
// `launchAlt`, against a target at `targetAlt`. Returns null when it cannot
// reach - out of envelope, or out of energy before it arrives.
function timeOfFlight(w, dist, speed, launchAlt, targetAlt) {
    const f = w && w.flight;
    if (!f || !(dist > 0)) return null;
    if (w.maxRange && dist > w.maxRange) return { reach: false, reason: 'beyond max range' };
    if (w.minRange && dist < w.minRange) return { reach: false, reason: 'inside min range' };

    // Density is taken at the midpoint of the climb or dive, as the game does.
    const rho = airDensity((launchAlt + targetAlt) / 2);
    const drop = launchAlt - targetAlt;

    if (f.kind === 'gun') {
        // BulletSim decelerates a shell by dragCoef/muzzleVelocity, not by the
        // frontal-area form the bodies use:
        //     v -= |v| * v * (dragCoef * dt / muzzleVelocity)
        const muzzle = f.muzzle || 0;
        if (muzzle <= 0) return { reach: false, reason: 'no muzzle velocity' };

        const k = (f.dragCoef || 0) / muzzle;
        let v = muzzle + speed, t = 0, d = 0;
        const dt = 0.05;
        while (d < dist && t < 300 && v > 40) {
            d += dt * v; t += dt; v -= dt * v * v * k;
        }
        return d >= dist ? { reach: true, time: t, impact: v }
                         : { reach: false, reason: 'out of energy' };
    }

    if (f.kind === 'ballistic') {
        // The game's own CCIP integration, in two dimensions: gravity plus
        // quadratic drag along the velocity vector, stepped until it reaches
        // the target's height.
        //     k = 0.5 * Cd * rho * finArea / mass
        if (drop <= 0) return { reach: false, reason: 'no height to fall' };

        const k = 0.5 * (f.cd || 0.05) * rho * (f.finArea || 0.2) /
                  Math.max(1, f.dryMass || f.mass || 250);
        let vx = speed + (f.muzzle || 0), vy = 0, h = drop, d = 0, t = 0;
        const dt = 0.05;

        while (h > 0 && t < 300) {
            const v = Math.hypot(vx, vy) || 1;
            d  += vx * dt;
            h  -= vy * dt;
            t  += dt;
            vy += (G * (f.gravMult || 1) - (vy / v) * k * v * v) * dt;
            vx -= (vx / v) * k * v * v * dt;
            if (d >= dist) break;
        }
        if (h > 0) return { reach: false, reason: 'falls short' };
        return d >= dist ? { reach: true, time: t, impact: Math.hypot(vx, vy) }
                         : { reach: false, reason: 'falls short' };
    }

    if (f.kind === 'glide') {
        // A glider trades height for distance at its best lift-to-drag, so its
        // reach is drop * L/D. Along the glide, gravity feeds energy in at
        // g*sin(theta) while drag takes it out, and the speed settles where the
        // two balance - which is what makes a heavy, clean weapon arrive sooner
        // than a light draggy one over the same distance.
        const ld = f.glideRatio || 0;
        if (ld <= 0) return { reach: false, reason: 'no glide performance' };
        if (drop <= 0) return { reach: false, reason: 'no height to trade' };
        if (dist > drop * ld) return { reach: false, reason: 'beyond glide range' };

        const sinTheta = 1 / Math.sqrt(1 + ld * ld);
        const k = 0.5 * (f.cd || 0.02) * rho * (f.finArea || 0.5) /
                  Math.max(1, f.dryMass || f.mass || 250);

        let v = Math.max(40, speed), d = 0, t = 0;
        const dt = 0.1;
        while (d < dist && t < 600) {
            d += v * dt;
            t += dt;
            v += (G * sinTheta - k * v * v) * dt;
            if (v < 30) break;
        }
        return d >= dist ? { reach: true, time: t, impact: v }
                         : { reach: false, reason: 'out of energy' };
    }

    // --- motor: the CalcRange integration -------------------------------
    const cd = f.cd || 0.02, area = f.finArea || 1, dry = Math.max(1, f.dryMass || 1);
    const vTerm = Math.sqrt((f.lastThrust || 0) / (cd * rho * 0.5 * area));
    const vPeak = Math.min(speed + (f.deltaV || 0), vTerm);
    const burn  = f.burnTime || 0;

    // Boost covers ground too. The game averages launch and peak speed over the
    // burn for short burns, and uses the terminal speed for sustained ones.
    let d = (burn < 30) ? ((speed + vPeak) / 2) * burn : vTerm * burn;
    let t = burn;
    if (d >= dist) return { reach: true, time: dist / Math.max(1, d / burn), impact: vPeak };

    let v = vPeak, dt = 0.1;
    const k = 0.5 * cd * rho * area / dry;
    const minSpeed = f.minSpeed || 0;

    for (let i = 0; i < 120 && d < dist; i++) {
        d += dt * v;
        t += dt;
        v -= dt * v * v * k;
        dt += 0.05;                       // the game grows its step the same way
        if (i > 10 && v < minSpeed) break;
    }
    return d >= dist ? { reach: true, time: t, impact: v }
                     : { reach: false, reason: 'out of energy' };
}

// The distance a munition can actually cover from these launch conditions,
// ignoring the release gate.
//
// Two different numbers get called "range". targetRequirements.maxRange is the
// gate the game tests before letting a launch happen, and it is a fixed number
// - it does not move with speed or altitude. What does move is how far the
// weapon can physically get, which is what this returns. For most shots the
// gate is the binding one, which is why the picker quotes it; this says whether
// that is still true at the speed and height being flown.
//
// Found by bisection rather than by integrating to exhaustion, so it uses the
// same four flight models as everything else instead of a fifth copy.
function kinematicReach(w, speed, launchAlt, targetAlt) {
    if (!w || !w.flight) return 0;
    const bare = { flight: w.flight, maxRange: 0, minRange: 0 };

    let lo = 0, hi = Math.max((w.maxRange || 0) * 3, 200000);
    for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        const r = timeOfFlight(bare, mid, speed, launchAlt, targetAlt);
        if (r && r.reach) lo = mid; else hi = mid;
    }
    return lo;
}

function fmtTime(seconds) {
    const s = Math.round(seconds);
    return s < 60 ? s + 's' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Release points
//
// A waypoint marked as a release point carries a munition and the targets it is
// engaging, and reports a time of flight to each. Not every target gets shot at
// from every release point, so the targets are chosen per release point rather
// than assumed.
//
// The time is measured from the release point, which is what matters against an
// air defence: it is how long the munition is in the air and the defence has to
// react, not how long the aircraft has been flying.
// ---------------------------------------------------------------------------
function isReleasePoint(w) {
    return !!w.rp;
}

// Time of flight from one release point to each of its targets.
function releaseSolutions(f, i) {
    const w = f.waypoints[i];
    if (!w || !w.rp) return [];

    const munition = (ranges.arsenal || {})[w.munition];
    return (w.targetIds || []).map(id => {
        const t = targetById(id);
        const pos = t && targetPos(t);
        if (!pos) return { id: id, name: '(target gone)', error: 'missing' };

        const br = bearingRange(w, pos);
        // Target altitude is the ground under it: a designated target is a
        // thing on the map, not something at the aircraft's height.
        const groundAlt = terrain ? terrainAt(pos.x, pos.z) : 0;

        if (!munition) {
            return { id: id, name: t.name, bearing: br.bearing, range: br.range,
                     error: 'no munition' };
        }
        const sol = timeOfFlight(munition, br.range, f.speed || 250,
                                 w.alt, groundAlt);
        return { id: id, name: t.name, bearing: br.bearing, range: br.range,
                 sol: sol };
    });
}

// Release points are drawn as a filled triangle with lines to what they engage,
// so a glance shows which targets are being serviced from where.
function drawReleasePoints(ctx, f) {
    if (!f.visible) return;

    ctx.save();
    f.waypoints.forEach((w, i) => {
        if (!w.rp) return;
        const p = toScreen(w.x, w.z);

        for (const sol of releaseSolutions(f, i)) {
            const t = targetById(sol.id);
            const pos = t && targetPos(t);
            if (!pos) continue;
            const q = toScreen(pos.x, pos.z);

            ctx.setLineDash([6, 5]);
            ctx.strokeStyle = 'rgba(11,16,20,0.8)';
            ctx.lineWidth = 4;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();

            // A shot that cannot reach is drawn faint, so an impossible pairing
            // is visible without opening the panel.
            const ok = sol.sol && sol.sol.reach;
            ctx.globalAlpha = ok ? 0.95 : 0.35;
            ctx.strokeStyle = f.colour;
            ctx.lineWidth = 1.8;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.setLineDash([]);

            const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
            if (Math.hypot(q.x - p.x, q.y - p.y) > 70) {
                plate(ctx, ok ? 'TOT ' + fmtTime(sol.sol.time)
                              : (sol.sol ? sol.sol.reason : 'no munition'),
                      mx, my, ok ? f.colour : 'rgba(240,133,122,0.8)');
            }
        }

        // The marker itself, over the line ends.
        for (const pass of [{ c: '#0b1014', lw: 5 }, { c: f.colour, lw: 2 }]) {
            ctx.strokeStyle = pass.c;
            ctx.lineWidth   = pass.lw;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y - 11);
            ctx.lineTo(p.x + 10, p.y + 7);
            ctx.lineTo(p.x - 10, p.y + 7);
            ctx.closePath();
            ctx.stroke();
        }
        ctx.fillStyle = f.colour;
        ctx.fill();
    });
    ctx.restore();
}
