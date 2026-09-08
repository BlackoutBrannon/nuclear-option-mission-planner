/* ---------------------------------------------------------------------------
   Flights, routes and waypoints.

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

// Per-leg samples for one flight, cached against the threat picture and the
// route itself so panning and zooming never trigger a recompute.
function flightExposure(f) {
    const sig = ringEpoch + '|' + ownRCS + '|' + (terrain ? 1 : 0) + '|' +
                f.waypoints.map(w => Math.round(w.x) + ',' + Math.round(w.z) +
                                     ',' + Math.round(w.alt)).join(';');
    if (f._expSig === sig) return f._exposure;

    const legs = [];
    for (let i = 1; i < f.waypoints.length; i++) {
        const a = f.waypoints[i - 1], b = f.waypoints[i];
        const dist  = bearingRange(a, b).range;
        const steps = Math.max(2, Math.ceil(dist / EXPOSURE_STEP));
        const states = [];

        for (let k = 0; k <= steps; k++) {
            const t = k / steps;
            states.push(exposureAt(a.x + (b.x - a.x) * t,
                                   a.z + (b.z - a.z) * t,
                                   a.alt + (b.alt - a.alt) * t));
        }

        // Distance in each state, for the panel. A sample stands for the span
        // around it, so each interior sample counts a full step and the two
        // ends count half.
        const span = dist / steps;
        const tally = { clear: 0, detected: 0, engaged: 0, terrain: 0 };
        for (let k = 0; k <= steps; k++) {
            tally[states[k]] += (k === 0 || k === steps) ? span / 2 : span;
        }
        legs.push({ states: states, dist: dist, tally: tally });
    }

    f._expSig = sig;
    f._exposure = legs;
    return legs;
}

// Overlaid on the route line: thick solid where a weapon reaches, medium dashed
// where something sees you but cannot shoot. Weight and pattern carry the
// distinction, not colour alone.
const EXPOSURE_STYLE = {
    // White on the dark halo the route already carries, in a tight dash no
    // other overlay uses: unflyable has to be unmistakable rather than merely
    // a different colour.
    terrain:  { colour: '#ffffff', width: 7, dash: [3, 3] },
    engaged:  { colour: '#f0857a', width: 6, dash: [] },
    detected: { colour: '#ffd166', width: 4, dash: [7, 5] },
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
            ctx.globalAlpha = 0.75;
            ctx.strokeStyle = st.colour;
            ctx.lineWidth   = st.width;
            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            ctx.lineTo(p1.x, p1.y);
            ctx.stroke();
        }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.restore();
}
