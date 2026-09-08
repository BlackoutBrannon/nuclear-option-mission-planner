/* ---------------------------------------------------------------------------
   Map transforms, own-ship state, formatters.

   Part 3 of 11 of the planner. These files are plain scripts sharing one
   global scope, loaded in the order listed in index.html - not ES modules - so
   a name declared in an earlier file is visible in every later one. Order is
   therefore significant: top-level code in one file can only use values already
   declared by the files above it.
   --------------------------------------------------------------------------- */

// The canvas fills the window, whose aspect ratio does not match the map's, so
// the map is fitted inside it. Two transforms stack:
//
//   fit    map metres  ->  canvas pixels   (scale to fit, centre, fixed)
//   view   canvas      ->  screen          (pan and zoom, changes constantly)
//
// Separating them keeps map dimensions out of the pan and zoom maths, and lets
// a window resize recompute `fit` without disturbing `view`.
let fit = { scale: 1, offsetX: 0, offsetY: 0 };

function computeFit() {
    if (!currentMap) return;

    const mw = currentMap.maxX - currentMap.minX;
    const mh = currentMap.maxZ - currentMap.minZ;

    // The panel floats over the map and can be moved or closed, so the map is
    // fitted to the whole canvas. Reserving space for it would mean the fit
    // changing every time you dragged the window somewhere else.
    const scale = Math.min(canvas.width / mw, canvas.height / mh) * 0.96;  // margin

    fit.scale   = scale;
    fit.offsetX = (canvas.width - mw * scale) / 2;
    fit.offsetY = (canvas.height - mh * scale) / 2;
}

function sizeCanvas() {
    canvas.width  = mapArea.clientWidth;
    canvas.height = mapArea.clientHeight;
    computeFit();
}

function setMap(name) {
    currentMap  = MAPS[name];
    basemap.src = currentMap.image;
    loadTerrain(currentMap.terrain);

    sizeCanvas();
    view = { scale: 1, panX: 0, panY: 0 };
}

// Setting canvas.width wipes the canvas, so a resize always needs a redraw.
window.addEventListener('resize', () => {
    mainWin.apply();                  // keep them on screen and within limits
    ringWin.apply();
    sizeCanvas();
    if (currentMission) draw(currentMission);
});
let view = { scale: 1, panX: 0, panY: 0 };

// A single named reference point. Positions are then expressed as a bearing
// and range from it - the standard radio format, "bandits bullseye 270 for 45"
// - rather than as raw coordinates.
let bullseye = null;          // { x, z } in world metres, or null

// The exact inverse of toScreen: undo the view, then undo the fit. Every
// interaction that starts with a click - placing a bullseye, dropping a target,
// laying a waypoint, sampling terrain height - goes through this.
function toWorld(sx, sy) {
    const m = currentMap;

    const cx = (sx - view.panX) / view.scale;      // screen -> canvas
    const cy = (sy - view.panY) / view.scale;

    return {                                       // canvas -> metres
        x: (cx - fit.offsetX) / fit.scale + m.minX,
        z: m.maxZ - (cy - fit.offsetY) / fit.scale
    };
}

// ---------------------------------------------------------------------------
// Bearing and range on a flat plane. x is east, z is north, and the world has
// no curvature - so this is plane trigonometry, not great-circle navigation.
// ---------------------------------------------------------------------------
function bearingRange(from, to) {
    const dx = to.x - from.x;        // east
    const dz = to.z - from.z;        // north

    // atan2(east, north) yields degrees clockwise from north: a compass
    // bearing. The conventional argument order, atan2(y, x), yields degrees
    // anticlockwise from east, which is rotated 90 degrees and mirrored.
    let bearing = Math.atan2(dx, dz) * 180 / Math.PI;
    if (bearing < 0) bearing += 360;

    return { bearing: bearing, range: Math.hypot(dx, dz) };
}

let unitSystem = 'aviation';         // or 'metric'

// ---------------------------------------------------------------------------
// Own-ship state. Threat rings are drawn against a specific aircraft at a
// specific altitude, because the game's own detection maths depends on both:
//
//   radar detection range = maxRange / minSignal * RCS^0.25
//   radar horizon         = sqrt(2 * earthRadius * altitude), per end
//
// Held in metres and in raw RCS regardless of the units displayed, so the unit
// toggle affects presentation only and never the computed values.
// ---------------------------------------------------------------------------
const EARTH_DIAMETER = 12742000;     // metres - the game uses this literal
const FT_PER_M = 3.280839895;

let ownRCS = 0.08;                   // FS-12 Revoker, a middle-of-the-road value
let ownAltM = 3048;                  // 10,000 ft

// Slider travel is CUBIC in altitude, not linear.
//
// The horizon goes as sqrt(h), so the difference between 100 ft and 1,000 ft
// matters far more than between 40,000 and 41,000. On a linear 0-60,000 ft
// track everything below 2,000 ft lives in the first 3% of the bar and is
// unusable. Cubing gives the low end most of the travel:
//
//     10% -> 60 ft    30% -> 1,620 ft    50% -> 7,500 ft    100% -> 60,000 ft
//
// The typed box is unchanged and stays authoritative, so this only affects how
// the slider feels, never what a value means.
const ALT_MAX_M = 60000 / FT_PER_M;      // 60,000 ft service ceiling
const ALT_CURVE = 3;
const SLIDER_STEPS = 1000;

const rcsPreset = document.getElementById('rcsPreset');
const altSlider = document.getElementById('altSlider');
const altInput  = document.getElementById('altInput');
const altUnit   = document.getElementById('altUnit');
const stHorizon = document.getElementById('stHorizon');

// Distance to the horizon from a given height. Each end of the link gets its
// own; the game adds them and rejects the contact if the sum falls short.
function horizonM(altM) {
    return Math.sqrt(EARTH_DIAMETER * Math.max(0, altM));
}

function buildRcsPicker() {
    const frames = Object.entries(ranges.airframes || {});
    rcsPreset.innerHTML = '';

    if (!frames.length) {
        rcsPreset.disabled = true;
        rcsPreset.appendChild(new Option('no data', ''));
        return;
    }

    // Already sorted by RCS in the file, so the list reads stealthiest first.
    for (const [key, a] of frames) {
        // The RCS value is included in the label because it sets the radar
        // ring radius.
        rcsPreset.appendChild(new Option(a.name + '  (' + a.rcs + ')', key));
    }
    rcsPreset.appendChild(new Option('Custom…', 'custom'));

    const initial = frames.find(([, a]) => a.rcs === ownRCS) || frames[0];
    rcsPreset.value = initial[0];
    ownRCS = initial[1].rcs;
}

rcsPreset.addEventListener('change', () => {
    if (rcsPreset.value === 'custom') {
        const entered = prompt('Radar cross section (game units, e.g. 0.05):', ownRCS);
        const n = parseFloat(entered);
        // Reject anything non-positive: RCS^0.25 of zero is zero range, which
        // would silently draw no rings at all.
        if (isFinite(n) && n > 0) ownRCS = n;
        else rcsPreset.value = findPresetKey();
    } else {
        ownRCS = ranges.airframes[rcsPreset.value].rcs;
    }
    updateOwnship();
});

function findPresetKey() {
    for (const [key, a] of Object.entries(ranges.airframes || {})) {
        if (a.rcs === ownRCS) return key;
    }
    return 'custom';
}

function sliderToAlt(pos) {
    const t = pos / SLIDER_STEPS;
    return ALT_MAX_M * Math.pow(t, ALT_CURVE);
}

function altToSlider(altM) {
    const t = Math.pow(Math.min(1, Math.max(0, altM / ALT_MAX_M)), 1 / ALT_CURVE);
    return Math.round(t * SLIDER_STEPS);
}

// Dragging lands on 3712 ft otherwise. Snap in whatever unit is on screen, so
// the number is round in the unit you are actually reading.
function snapAlt(displayValue) {
    const step = displayValue <   200 ? 10
               : displayValue <  1000 ? 20
               : displayValue < 10000 ? 100
               : 500;
    return Math.round(displayValue / step) * step;
}

altSlider.addEventListener('input', () => {
    suspendMask();
    const raw = sliderToAlt(parseInt(altSlider.value, 10));
    const inDisplay = (unitSystem === 'aviation') ? raw * FT_PER_M : raw;
    const snapped = snapAlt(inDisplay);
    ownAltM = (unitSystem === 'aviation') ? snapped / FT_PER_M : snapped;

    // Write the box directly. Setting .value does NOT fire an input event, so
    // the two controls cannot bounce updates off each other.
    altInput.value = Math.round(snapped);
    updateOwnship();
});

altInput.addEventListener('input', () => {
    suspendMask();
    const n = parseFloat(altInput.value);
    if (!isFinite(n) || n < 0) return;          // mid-typing "-" or "" - ignore
    ownAltM = (unitSystem === 'aviation') ? n / FT_PER_M : n;
    altSlider.value = altToSlider(ownAltM);
    updateOwnship();
});

// Rewrites the altitude box in the current unit and refreshes the readout.
// Called on the unit toggle as well, so the box shows feet or metres to match.
function refreshAltField() {
    altUnit.textContent = (unitSystem === 'aviation') ? 'ft' : 'm';
    altInput.step  = (unitSystem === 'aviation') ? 500 : 100;
    altInput.value = Math.round((unitSystem === 'aviation')
                                ? ownAltM * FT_PER_M : ownAltM);
    // The slider is unit-agnostic - it holds a fraction of the ceiling - so a
    // unit change only restates the box, never moves the handle.
    altSlider.value = altToSlider(ownAltM);
}

function updateOwnship() {
    stHorizon.textContent = 'HORIZON ' + fmtRange(horizonM(ownAltM));
    renderRingTree();           // radar reach in the tree depends on RCS
    if (currentMission) draw(currentMission);
}

function fmtRange(metres) {
    return unitSystem === 'aviation'
        ? (metres / 1852).toFixed(1) + ' NM'      // 1852 m is one nautical mile
        : (metres / 1000).toFixed(1) + ' km';
}

// Altitudes are feet or metres, not the nautical miles fmtRange deals in.
function fmtAlt(metres) {
    return unitSystem === 'aviation'
        ? Math.round(metres * FT_PER_M) + ' ft'
        : Math.round(metres) + ' m';
}

// Speeds are knots or kilometres per hour, matching how each system quotes them.
function fmtSpeed(mps) {
    return unitSystem === 'aviation'
        ? Math.round(mps * 1.943844) + ' kt'
        : Math.round(mps * 3.6) + ' km/h';
}

function speedToMs(shown) {
    return unitSystem === 'aviation' ? shown / 1.943844 : shown / 3.6;
}

function speedFromMs(mps) {
    return unitSystem === 'aviation' ? mps * 1.943844 : mps * 3.6;
}

function fmtBearing(deg) {
    return String(Math.round(deg) % 360).padStart(3, '0') + '°';
}

// Standard bullseye call: bearing then range, e.g. 270/45.
function fmtBullseye(point) {
    if (!bullseye) return '';
    const br = bearingRange(bullseye, point);
    return fmtBearing(br.bearing) + ' / ' + fmtRange(br.range);
}

function toScreen(x, z) {
    const m = currentMap;

    // metres -> canvas pixels. The vertical flip is here: screen y grows down,
    // world z grows north.
    const cx = (x - m.minX) * fit.scale + fit.offsetX;
    const cy = (m.maxZ - z) * fit.scale + fit.offsetY;

    // canvas pixels -> screen, applying pan and zoom.
    return {
        x: cx * view.scale + view.panX,
        y: cy * view.scale + view.panY
    };
}
