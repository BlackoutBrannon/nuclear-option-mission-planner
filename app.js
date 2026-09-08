/* ---------------------------------------------------------------------------
   Nuclear Option Mission Planner

   Loaded at the end of <body>, so every element it looks up already exists and
   no DOMContentLoaded wrapper is needed. milsymbol loads before this file and
   provides the global `ms`.

   Note for tools/make_symbol_sheet.py: it parses TYPE_SIDC, ROLE_SIDC,
   ROLE_OVERRIDES and ROLE_RULES out of THIS file, so the contact sheet can
   never disagree with what the map draws. Keep those as plain top-level
   `const NAME = {` ... `};` declarations.
   --------------------------------------------------------------------------- */

  const drop = document.getElementById('drop');
const out  = document.getElementById('out');

const factionSelect = document.getElementById('faction');

// Display names and descriptions for every unit type, extracted from the game's
// own files by tools/extract_units.py. Starts empty and fills in once the file
// arrives, so anything reading it has to cope with it being empty for a moment.
let unitCatalogue = {};

async function loadCatalogue() {
    try {
        // fetch does NOT throw on 404 or 500 - it resolves with a response whose
        // ok is false. Without this check a missing file sails on to .json(),
        // which then fails on the error page's HTML with a confusing message.
        const response = await fetch('units.json?v=' + Date.now());
        if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText);

        unitCatalogue = await response.json();
        console.log('catalogue loaded:', Object.keys(unitCatalogue).length, 'unit types');
    } catch (err) {
        // Reported in the panel as well as the console: without the catalogue
        // every unit falls back to its raw key rather than a display name.
        console.error('units.json failed to load:', err);
        out.textContent =
            'units.json did not load\n\n' + err.message +
            '\n\nUnit names will fall back to raw keys.';
    }
}

// ---------------------------------------------------------------------------
// Threat data: RCS, radar parameters and weapon envelopes, extracted from the
// game's own serialized fields by tools/extract_ranges.py. Never from unit
// descriptions - those quote detection figures, not the range a launcher
// commits at.
// ---------------------------------------------------------------------------
let ranges = { units: {}, airframes: {} };

async function loadRanges() {
    try {
        const response = await fetch('ranges.json?v=' + Date.now());
        if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText);
        ranges = await response.json();
        console.log('ranges loaded:',
                    Object.keys(ranges.airframes).length, 'airframes,',
                    Object.keys(ranges.units).length, 'units with envelopes');
    } catch (err) {
        // Absent range data presents as a mission with no threats at all, so
        // the failure is reported rather than swallowed.
        console.error('ranges.json failed to load:', err);
    }
    // Run on both paths. Without range data the picker renders disabled and
    // labelled "no data", which is distinguishable from an empty list.
    buildRcsPicker();
    refreshAltField();
    updateOwnship();
}

loadCatalogue();
loadRanges();


function mapName(path) {
    if (path ==='Terrain_naval') return 'Ignus Archipelago';
    return 'Heartland';
}

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d')

const MAPS = {
    'Heartland': {
        image: 'Heartland_overview.png',
        terrain: 'Heartland',
        minX: -40960,   maxX: 40960,
        minZ: -40960,   maxZ: 40960
    },
    'Ignus Archipelago': {
        image: 'Ignus_overview.png',
        terrain: 'Ignus',
        minX: -78072.9, maxX: 79573.5,
        minZ: -39419.9, maxZ: 37316.3
    }
};

let currentMap = null;
const basemap  = new Image();
let currentMission = null;

basemap.onload = () => {
  if (currentMission) draw(currentMission);
};

const mapArea = document.getElementById('mapArea');

// ---------------------------------------------------------------------------
// Floating windows
//
// makeWindow builds one movable, resizable, closable panel. The mission panel
// and the threat-ring panel are both instances.
//
// Each window holds a single `want` object - x, y, w, h, open - saved,
// restored and clamped as a unit. `want` is the requested geometry and is
// never modified by clamping; the values written to the CSS are `want` fitted
// to the current viewport. A window too large for a small viewport therefore
// renders smaller while retaining its requested size, and returns to that size
// when the viewport allows.
// ---------------------------------------------------------------------------
const PANEL_MIN_W = 210;
const PANEL_MIN_H = 160;

// Height of the status bar, read from the CSS rather than repeated here, so the
// two can never drift apart.
function barH() {
    return parseInt(getComputedStyle(document.documentElement)
                    .getPropertyValue('--barH'), 10) || 30;
}

function makeWindow(id, storageKey, defaults) {
    const el      = document.getElementById(id);
    const head    = document.getElementById(id + 'Head');
    const closeBt = document.getElementById(id + 'Close');
    const edge    = document.getElementById(id + 'Resize');
    const corner  = document.getElementById(id + 'Corner');
    const toggle  = document.getElementById(id + 'Toggle');

    const want = Object.assign({ x: 12, y: 12, w: 300, h: 0, open: true }, defaults);

    // Only x, y, w and h are restored. `open` is not persisted, so every
    // session starts with the mission panel and its drop zone visible.
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey));
        if (saved && typeof saved === 'object') {
            for (const k of ['x', 'y', 'w', 'h']) {
                if (typeof saved[k] === 'number') want[k] = saved[k];
            }
        }
    } catch (e) { /* absent or corrupt - the defaults are fine */ }

    function apply() {
        el.hidden = !want.open;
        if (toggle) toggle.setAttribute('aria-pressed', String(want.open));
        if (!want.open) return;

        const maxW = Math.max(PANEL_MIN_W, window.innerWidth  - 40);
        const maxH = Math.max(PANEL_MIN_H, window.innerHeight - barH() - 24);

        const w = Math.min(Math.max(PANEL_MIN_W, want.w), maxW);
        const h = Math.min(Math.max(PANEL_MIN_H, want.h || maxH), maxH);
        const x = Math.min(Math.max(0, want.x), window.innerWidth  - w);
        const y = Math.min(Math.max(0, want.y), window.innerHeight - barH() - h);

        el.style.left   = x + 'px';
        el.style.top    = y + 'px';
        el.style.width  = w + 'px';
        el.style.height = h + 'px';
    }

    function save() {
        try { localStorage.setItem(storageKey, JSON.stringify(want)); }
        catch (e) { /* private mode */ }
    }

    // One drag routine for all three handles. Each supplies only what it
    // changes, so moving and resizing cannot drift apart in behaviour.
    function drag(handle, onDrag) {
        if (!handle) return;
        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();                // no text selection, no map pan

            const from = { x: e.clientX, y: e.clientY,
                           px: want.x, py: want.y, pw: want.w,
                           ph: want.h || el.offsetHeight };

            handle.classList.add('dragging');
            document.body.classList.add('resizing');

            function move(ev) {
                onDrag(from, ev.clientX - from.x, ev.clientY - from.y);
                apply();
            }
            function up() {
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
                handle.classList.remove('dragging');
                document.body.classList.remove('resizing');
                save();                        // written once, at the end
            }
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
        });
    }

    drag(head,   (f, dx, dy) => { want.x = f.px + dx; want.y = f.py + dy; });
    drag(edge,   (f, dx)     => { want.w = f.pw + dx; });
    drag(corner, (f, dx, dy) => { want.w = f.pw + dx; want.h = f.ph + dy; });

    function setOpen(open) { want.open = open; apply(); save(); }

    if (closeBt) closeBt.addEventListener('click', (e) => {
        e.stopPropagation();                   // must not also start a drag
        setOpen(false);
    });
    if (toggle) toggle.addEventListener('click', () => setOpen(!want.open));

    // Double-click the title bar to restore the default position and size.
    if (head) head.addEventListener('dblclick', (e) => {
        if (e.target === closeBt) return;
        Object.assign(want, { x: defaults.x, y: defaults.y,
                              w: defaults.w, h: defaults.h || 0 });
        apply();
        save();
    });

    apply();
    return { want: want, apply: apply, save: save, setOpen: setOpen, el: el };
}

const mainWin = makeWindow('panel', 'panel',
                           { x: 12, y: 12, w: 300, h: 0, open: true });
const ringWin = makeWindow('ringPanel', 'ringPanel',
                           { x: 326, y: 12, w: 330, h: 460, open: false });
const flightWin = makeWindow('flightPanel', 'flightPanel',
                             { x: 670, y: 12, w: 330, h: 430, open: false });

function setPanelOpen(open) { mainWin.setOpen(open); }

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
let bullseye = null;         // { x, z } in world metres, or null

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

// ---------------------------------------------------------------------------
// Role classification.
//
// APP-6 draws an icon by FUNCTION, not by vehicle model, and you brief off
// function too - a Spearhead and a Linebreaker are both armour. So every type
// is binned into a group and a role.
//
// Air defence splits three ways, and the distinction matters:
//   SAM     radar-guided, medium to long range
//   SHORAD  short range, IR-guided or mixed gun/missile mounts
//   AAA     guns only
// Radar and fire control live under Air Defence rather than beside it, because
// this game can network almost any sensor to almost any shooter - killing the
// sensor degrades the battery.
// ---------------------------------------------------------------------------

// Used where the key carries no hint of the role - aircraft, ships, buildings.
const ROLE_OVERRIDES = {
    Fighter1: 'Air/Fighter',        SmallFighter1: 'Air/Fighter',
    // Trainers are flown in the multirole role rather than as support.
    Multirole1:'Air/Multirole',     trainer:       'Air/Multirole',
    CAS1:     'Air/Strike',         COIN:          'Air/Strike',
    Darkreach:'Air/Bomber',         FastBomber1:   'Air/Bomber',
    AttackHelo1:'Air/Rotary',       UtilityHelo1:  'Air/Rotary',
    EW1:      'Air/Support',        QuadVTOL1:     'Air/Support',

    FleetCarrier1:'Naval/Carrier',  AssaultCarrier1:'Naval/Carrier', SmallCarrier1:'Naval/Carrier',
    Destroyer1:'Naval/Combatant',   Frigate1:'Naval/Combatant',      Corvette1:'Naval/Combatant',
    PatrolBoat1:'Naval/Patrol',     LandingCraft1:'Naval/Amphibious',
    Aryx_SupplyShip1:'Naval/Support',

    Helipad:'Structure/Airbase',    hangar_med:'Structure/Airbase',  revetment1:'Structure/Airbase',
    shelter1:'Structure/Airbase',   controlTower1:'Structure/Airbase', fuelTank1:'Structure/Airbase',
    pillbox:'Structure/Defensive',  gabionBunker1:'Structure/Defensive', guardTower1:'Structure/Defensive',
    factory_large:'Structure/Industry', factory_tall:'Structure/Industry',
    refinery_main:'Structure/Industry', enrichmentPlant1:'Structure/Industry',
    storageTank:'Structure/Industry',
    ammoDump:'Structure/Logistics', ammunitionBunker:'Structure/Logistics',
    VehicleDepot1:'Structure/Logistics',

    radarStation1:'Air Defence/Radar',
    Emplacement1_23mm:'Air Defence/AAA',
    Emplacement1_MANPADS:'Air Defence/SHORAD',
    Emplacement1_ATGM:'Ground/Anti-tank'
};

// Order matters: the first rule that matches wins, so specific before general.
// RSAM must be tested before _SAM, or every launcher would read as SHORAD.
const ROLE_RULES = [
    [/RSAM|SAMTrailer|RadarSAM/i, 'Air Defence/SAM'],
    [/_SAM$|MANPADS|_AA$/i,       'Air Defence/SHORAD'],
    [/SPAAG|CRAM|23mm/i,          'Air Defence/AAA'],
    [/LADS|Laser|HEL$/i,          'Air Defence/Laser'],
    [/-R$|RadarContainer/i,       'Air Defence/Radar'],
    [/-FC$/i,                     'Air Defence/Fire control'],
    [/MART|MLRS/i,                'Ground/Artillery'],
    [/_AT$|ATGM/i,                'Ground/Anti-tank'],
    [/MBT/i,                      'Ground/Armour'],
    [/_IFV$/i,                    'Ground/IFV'],
    [/_APC$|MRAP/i,               'Ground/APC'],
    [/LCV45|Recon/i,              'Ground/Recon'],
    [/-FT$|-L$|-M$|-T$|Dozer|Supply/i, 'Ground/Logistics']
];

const FALLBACK_GROUP = {
    aircraft: 'Air', ships: 'Naval', buildings: 'Structure', vehicles: 'Ground'
};

function roleOf(type, category) {
    let path = ROLE_OVERRIDES[type];

    if (!path) {
        for (const [pattern, result] of ROLE_RULES) {
            if (pattern.test(type)) { path = result; break; }
        }
    }
    if (!path) path = (FALLBACK_GROUP[category] || 'Ground') + '/Other';

    const [group, role] = path.split('/');
    return { group, role };
}

// collectUnits is not cheap - 300+ objects, each running roleOf's pattern list -
// and draw() runs on every mousemove while panning. Cache the result per
// mission and rebuild only when the mission itself changes.
//
// This is only safe because collectUnits depends on nothing that changes at
// runtime: affiliation is derived at draw time rather than stored, so switching
// sides cannot invalidate it. Store what is fixed, derive what moves.
let unitsCache = { mission: null, units: [] };

function unitsOf(mission) {
    if (unitsCache.mission !== mission) {
        unitsCache = { mission: mission, units: collectUnits(mission) };
    }
    return unitsCache.units;
}

function collectUnits(mission) {
    const units = [];
    let uid = 0;

    for (const category of ['aircraft', 'vehicles', 'ships', 'buildings']) {
        for (const u of mission[category] || []) {
            const { group, role } = roleOf(u.type, category);

            units.push({
                // A stable per-unit id. collectUnits always walks the mission in
                // the same order, so a given unit keeps the same uid across
                // calls - which is what lets the tree hide one instance.
                uid:        uid++,
                unitName:   u.UniqueName || u.type,
                category:   category,
                type:       u.type,
                faction:    u.faction,
                group:      group,
                role:       role,
                x:          u.globalPosition.x,
                z:          u.globalPosition.z,
                // Kept for the radar horizon: a mast on a hill sees further
                // than one at sea level, and the game adds both ends.
                y:          u.globalPosition.y || 0
            });
        }
    }

    return units;
}

let myFaction = null;

function affiliationOf(unit) {
    if (!myFaction) return 'unknown';
    return unit.faction === myFaction ? 'friend' : 'hostile';
}

const AFFIL_FILL = {
    friend:  '#8ecbff',
    hostile: '#ff9a9a',
    unknown: '#ffe08a'
};

// ---------------------------------------------------------------------------
// MIL-STD-2525 symbology
//
// A SIDC is a 15-character code describing a symbol:
//   1      scheme        S = warfighting
//   2      affiliation   F friend, H hostile, N neutral, U unknown
//   3      dimension     G ground, A air, S sea surface
//   4      status        P = present (as opposed to anticipated)
//   5-10   function      what the thing actually is
//   11-15  modifiers, country, order of battle - unused here
//
// Affiliation and dimension are derived from existing unit data; only the
// six-character function ID is specified per role.
// ---------------------------------------------------------------------------

const AFF_LETTER = { friend: 'F', hostile: 'H', neutral: 'N', unknown: 'U' };

// Full 15-character SIDC templates, written with F (friend) in position 2.
// sidcFor swaps that one character for the unit's actual affiliation, leaving
// scheme, dimension, function and modifiers alone.
//
// Templates rather than assembled parts because these span three coding
// schemes - S warfighting, G tactical graphics, E emergency management - and
// each has its own dimension letters. Assembling from a role plus a dimension
// could not express GFMPOHTH or EFFPLF----H at all.
//
// Every code below was validated against milsymbol's own tables.

// Per unit type. Beats the role fallback, because two units in one role can
// need different symbols - an attack helicopter and a utility helicopter are
// both Rotary but are not the same thing.
const TYPE_SIDC = {
    // --- Air ---
    'FastBomber1':   'SFAPMFB--------',   // Alkyon AB-4
    'Darkreach':     'SFAPMFB--------',   // SFB-81
    'Fighter1':      'SFAPMFF--------',   // FS-12 Revoker
    'SmallFighter1': 'SFAPMFL--------',   // FS-20 Vortex
    'Multirole1':    'SFAPMFA--------',   // KR-67 Ifrit
    'trainer':       'SFAPMFA--------',   // T/A-30 Compass, flown multirole
    'CAS1':          'SFAPMFA--------',   // A-19 Brawler
    'COIN':          'SFAPMFA--------',   // CI-22 Cricket
    'AttackHelo1':   'SFAPMHA--------',   // SAH-46 Chicane
    'UtilityHelo1':  'SFAPMHU--------',   // UH-90 Ibis
    'QuadVTOL1':     'SFAPMHU--------',   // VL-49 Tarantula
    'EW1':           'SFAPMFQRW------',   // EW-25 Medusa

    // --- Armour. Function beats mobility where both will not fit, so the
    // Linebreaker SAM stays an air defence symbol rather than a tank one.
    // Linebreaker IFV and APC have no entries here on purpose: every IFV is
    // EVATM and every APC is EVAA whatever the chassis, so the role covers them.
    'MBT':  'SFGPEVAT-------',
    'MBT1': 'SFGPEVAT-------',

    // Hexhounds are unmanned ground vehicles with their own code. The Hexhound
    // SAM variant is absent from this table: air defence takes precedence over
    // platform, so it resolves to SHORAD through ROLE_SIDC.
    'UGV1_grenade': 'SFGPUCVU-------',

    // --- Naval. Corvette and frigate share the frigate code; the destroyer
    // keeps the role default. ---
    'Corvette1': 'SFSPCLFF-------',
    'Frigate1':  'SFSPCLFF-------',

    // --- Structures ---
    'revetment1':       'EFFPLF----H----',
    'Helipad':          'EFFPLF----H----',
    'controlTower1':    'GFMPOHTH-------',   // OHT--- is not a valid code; H = high
    'guardTower1':      'GFMPOHTL-------',
    'fuelTank1':        'GFSPPR---------',
    'shelter1':         'GFMPSS---------',
    'hangar_med':       'GFMPSS---------',
    'gabionBunker1':    'GFMPSE---------',
    'pillbox':          'GFMPSE---------',
    'ammoDump':         'GFSPPAS--------',
    'ammunitionBunker': 'GFMPSU---------',
    'enrichmentPlant1': 'SFGPIRNN--H----',
    'factory_large':    'SFGPIE----H----',
    'factory_tall':     'SFGPIE----H----',
    'refinery_main':    'SFGPIP----H----',
    'storageTank':      'SFGPIR----H----',
    'VehicleDepot1':    'SFGPIMV---H----'
};

// Fallback by "Group/Role". Keyed on both because role names repeat across
// groups - Support exists under Air and Naval, Logistics under Ground and
// Structure - and keying on the role alone put an air cargo symbol on a ship.
const ROLE_SIDC = {
    'Air Defence/SAM':          'SFGPUCDM-------',
    'Air Defence/SHORAD':       'SFGPUCDS-------',
    'Air Defence/AAA':          'SFGPUCDG-------',
    'Air Defence/Laser':        'SFGPUCD--------',
    'Air Defence/Radar':        'SFGPESR--------',
    'Air Defence/Fire control': 'SFGPUUS--------',

    'Ground/Armour':    'SFGPEVAT-------',
    'Ground/IFV':       'SFGPEVATM------',   // tank, medium - all IFVs
    'Ground/APC':       'SFGPEVAA-------',   // all APCs
    'Ground/Anti-tank': 'SFGPUCAT-------',
    'Ground/Artillery': 'SFGPUCF--------',
    'Ground/Recon':     'SFGPUCR--------',
    'Ground/Logistics': 'SFGPUSS--------',
    'Ground/Other':     'SFGPUCI--------',

    'Air/Fighter':   'SFAPMFF--------',
    'Air/Multirole': 'SFAPMFA--------',
    'Air/Strike':    'SFAPMFA--------',
    'Air/Bomber':    'SFAPMFB--------',
    'Air/Rotary':    'SFAPMHU--------',
    'Air/Support':   'SFAPMFC--------',

    'Naval/Carrier':    'SFSPCLCV-------',
    'Naval/Combatant':  'SFSPCLDD-------',
    'Naval/Patrol':     'SFSPCP---------',
    'Naval/Amphibious': 'SFSPCLLL-------',
    'Naval/Support':    'SFSPCL---------',   // no auxiliary code found; generic

    'Structure/Airbase':   'SFGPIBA---H----',
    'Structure/Defensive': 'GFMPSE---------',
    'Structure/Industry':  'SFGPIE----H----',
    'Structure/Logistics': 'SFGPIMV---H----'
};

const DEFAULT_SIDC = 'SFGPU----------';


function sidcFor(unit) {
    const template = TYPE_SIDC[unit.type]
                  || ROLE_SIDC[unit.group + '/' + unit.role]
                  || DEFAULT_SIDC;

    // Position 2 is standard identity in every coding scheme, so swapping just
    // that character works whether the template is S, G or E.
    const aff = AFF_LETTER[affiliationOf(unit)] || 'U';
    return template[0] + aff + template.slice(2);
}

// Rendering a symbol is expensive and there are hundreds of units, most of them
// sharing a handful of symbols. Cache by SIDC so each distinct one is built
// once and then just blitted.
const symbolCache = new Map();

function symbolFor(sidc) {
    if (symbolCache.has(sidc)) return symbolCache.get(sidc);

    let entry = null;
    try {
        // Installations render black rather than in affiliation colour. That is
        // standard-correct, and an attempt to override it with fillColor and
        // frameColor had no effect, so it is left alone. Shape still carries
        // the affiliation.
        const sym = new ms.Symbol(sidc, { size: 18, strokeWidth: 4 });
        // getAnchor gives where the symbol's centre sits within its canvas -
        // symbols are not centred in their own bitmap, so drawing at the raw
        // position would offset every marker.
        entry = { canvas: sym.asCanvas(), anchor: sym.getAnchor() };
    } catch (err) {
        console.warn('bad SIDC', sidc, err);
    }

    symbolCache.set(sidc, entry);
    return entry;
}

function drawSymbol(ctx, x, y, unit) {
    const entry = typeof ms === 'undefined' ? null : symbolFor(sidcFor(unit));

    // Fall back to the plain frames if milsymbol did not load or rejected the
    // code, so the map still works rather than going blank.
    if (!entry) {
        drawFrame(ctx, x, y, 5, affiliationOf(unit));
        return;
    }

    ctx.drawImage(entry.canvas, x - entry.anchor.x, y - entry.anchor.y);
}

const BULL     = '204,211,218';             // rose colour, rgb components
const BULL_HEX = '#ccd3da';                 // the same colour, for solid strokes

// Range rings and radials, drawn in WORLD units rather than the fixed screen
// size used by unit symbols: a 5 NM ring must span 5 NM at every zoom level.
//
// Called before the units are drawn, so a rose spanning the map renders beneath
// the symbols.
function drawBullseyeRose(ctx) {
    if (!bullseye) return;

    const p        = toScreen(bullseye.x, bullseye.z);
    const interval = unitSystem === 'aviation' ? 1852 * 5 : 5000;   // metres
    const ringPx   = interval * fit.scale * view.scale;

    if (ringPx < 6) return;                 // zoomed out so far the rings would merge

    // Extended to the furthest canvas corner, so the rose always reaches the
    // edge of the visible area.
    const far = Math.max(
        Math.hypot(p.x, p.y),
        Math.hypot(canvas.width - p.x, p.y),
        Math.hypot(p.x, canvas.height - p.y),
        Math.hypot(canvas.width - p.x, canvas.height - p.y)
    );
    const rings = Math.min(60, Math.ceil(far / ringPx));
    const outer = rings * ringPx;

    ctx.save();

    // Two passes over the whole rose: a dark halo, then the bright line on top.
    // A one-pixel line alone vanishes over pale terrain - what makes it legible
    // is the contrast step against its own backing, not the colour.
    for (const pass of [{ c: '11,16,20', w: 3, a: 0.55 },
                        { c: BULL,      w: 1, a: 1    }]) {

        ctx.lineWidth = pass.w;

        ctx.strokeStyle = 'rgba(' + pass.c + ',' + (0.45 * pass.a) + ')';
        for (let i = 1; i <= rings; i++) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, i * ringPx, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Radials every 45 degrees. Screen north is -y and east is +x, so sin
        // drives x and -cos drives y - bearingRange's convention, inverted.
        for (let deg = 0; deg < 360; deg += 45) {
            const rad = deg * Math.PI / 180;
            // Cardinals heavier than the 45s, so the two ranks are told apart
            // by weight rather than by hue.
            const alpha = (deg % 90 === 0 ? 0.75 : 0.42) * pass.a;
            ctx.strokeStyle = 'rgba(' + pass.c + ',' + alpha + ')';
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x + Math.sin(rad) * outer, p.y - Math.cos(rad) * outer);
            ctx.stroke();
        }
    }

    // Range labels up the 045 radial, so they never sit on a cardinal line.
    // Every other ring unless the rings are far apart, to limit clutter.
    const step = ringPx > 90 ? 1 : 2;
    const unit = unitSystem === 'aviation' ? 'NM' : 'km';
    const diag = Math.PI / 4;

    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = step; i <= rings; i += step) {
        const r  = i * ringPx;
        const lx = p.x + Math.sin(diag) * r;
        const ly = p.y - Math.cos(diag) * r;
        if (lx < 0 || ly < 0 || lx > canvas.width || ly > canvas.height) continue;

        const text = (i * 5) + (i === step ? ' ' + unit : '');
        ctx.lineWidth   = 3;
        ctx.strokeStyle = 'rgba(11,16,20,0.85)';
        ctx.strokeText(text, lx, ly);
        ctx.fillStyle = 'rgba(' + BULL + ',1)';
        ctx.fillText(text, lx, ly);
    }

    // Bearing labels just inside the outermost ring.
    for (let deg = 0; deg < 360; deg += 45) {
        const rad = deg * Math.PI / 180;
        const r   = outer - ringPx * 0.35;
        const lx  = p.x + Math.sin(rad) * r;
        const ly  = p.y - Math.cos(rad) * r;
        if (lx < 12 || ly < 12 || lx > canvas.width - 12 || ly > canvas.height - 12) continue;

        const text = String(deg).padStart(3, '0');
        ctx.lineWidth   = 3;
        ctx.strokeStyle = 'rgba(11,16,20,0.85)';
        ctx.strokeText(text, lx, ly);
        ctx.fillStyle = 'rgba(' + BULL + ',0.9)';
        ctx.fillText(text, lx, ly);
    }

    ctx.restore();
}

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
    setOn: (paths, on) => paths.forEach(p => on ? ringUnits.add(p)
                                                : ringUnits.delete(p)),
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
function threatRingsFor(unit) {
    if (!ringUnits.has(unitPath(unit))) return [];
    const entry = (ranges.units || {})[unit.type];
    if (!entry) return [];

    const rings = [];

    // Radar horizon: the game adds the distance to the horizon from each end
    // and rejects the contact if the sum falls short. A mast is a few metres
    // up even when the vehicle is at sea level. This one IS a ground distance -
    // DetectorManager tests it against the flattened vector.
    const emitterAlt = Math.max(unit.y, 0) + 10;
    const horizon = horizonM(ownAltM) + horizonM(emitterAlt);

    // Every range test in the game is SLANT range: Turret uses
    // aimVector.magnitude, the radar uses FastMath.Distance, and
    // FastMath.InRange sums x, y and z. A map is flat, so the drawable radius
    // is the ground projection of that sphere. An envelope therefore contracts
    // with increasing altitude difference and closes entirely once the
    // difference exceeds the slant range.
    const dh = Math.abs(ownAltM - emitterAlt);
    const groundFrom = slant =>
        slant > dh ? Math.sqrt(slant * slant - dh * dh) : 0;

    if (showRings.radar) {
        for (const r of entry.radars) {
            if (!r.minSignal) continue;
            const slant  = r.maxRange / r.minSignal * Math.pow(ownRCS, 0.25);
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

    if (showRings.optical) {
        for (const o of entry.optical) {
            const ground = groundFrom(
                Math.min(o.visualRange, ownVisibleRange() * o.magnification));
            if (ground <= 0) continue;
            rings.push({ kind: 'optical', los: true, r: ground,
                         label: 'VIS ' + fmtRange(ground) });
        }
    }

    if (showRings.weapon) {
        for (const w of entry.weapons) {
            const ground = groundFrom(w.maxRange);
            if (ground <= 0) continue;          // you are above its reach entirely
            rings.push({
                kind:   'weapon',
                // Only weapons whose targetRequirements demand line of sight
                // are masked. Indirect fire - MLRS, ballistic missiles - has
                // the flag clear and reaches over terrain.
                los:    w.lineOfSight,
                r:      ground,
                // The altitude band is a separate hard gate in
                // TargetRequirements - a weapon can be in range and still not
                // be cleared to engage at your height.
                inBand: ownAltM >= w.minAltitude && ownAltM <= w.maxAltitude,
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
            profile = maskProfileFor(unit, widest);
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
            if (rpx > 70 && labelMode !== 'off' &&
                (labelMode === 'auto' || unit === hoveredUnit)) {
                // Anchored on the ring itself, offset per ring so several rings
                // on one unit start apart before placement runs.
                //
                // A ring wider than the viewport has most of its circumference
                // off-screen, so the preferred anchor is tried first and then
                // rotated until a point lands in view. Without the rotation the
                // largest rings - the ones that matter most - go unlabelled.
                const base = -90 + i * 22;
                let lx = 0, ly = 0, onScreen = false;
                for (let k = 0; k < 12 && !onScreen; k++) {
                    const a = (base + k * 30) * Math.PI / 180;
                    lx = p.x + Math.cos(a) * rpx;
                    ly = p.y + Math.sin(a) * rpx;
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

// ---------------------------------------------------------------------------
// Terrain
//
// Elevation for the current map, produced by tools/make_terrain.py: int16
// metres at 50 m post spacing, rows north to south, columns west to east.
// Fetched as an ArrayBuffer and read directly as an Int16Array, so there is no
// per-sample parsing cost.
//
// Absent terrain is not an error. Rings fall back to plain circles, which is
// the geometry without masking rather than a wrong answer.
// ---------------------------------------------------------------------------
let terrain = null;   // { width, height, minX, maxX, minZ, maxZ, data }

async function loadTerrain(key) {
    terrain = null;
    maskCache.clear();
    if (!key) return;

    try {
        const index = await (await fetch('terrain/index.json?v=' + Date.now())).json();
        const meta = index.maps[key];
        if (!meta) throw new Error('no terrain for ' + key);

        const buf = await (await fetch('terrain/' + meta.file)).arrayBuffer();
        const data = new Int16Array(buf);
        if (data.length !== meta.width * meta.height) {
            throw new Error(`expected ${meta.width * meta.height} samples, got ${data.length}`);
        }

        terrain = Object.assign({}, meta, { data: data });
        console.log('terrain loaded:', key, meta.width + 'x' + meta.height,
                    '@', meta.spacing + ' m');
    } catch (err) {
        console.error('terrain failed to load:', err);
    }
    if (currentMission) draw(currentMission);
}

// Ground elevation in metres, bilinear between the four surrounding posts.
// Interpolating within the captured surface keeps the profile smooth; it is
// the only averaging in the masking path, and it spans one 50 m cell rather
// than smoothing the surface itself.
function terrainAt(x, z) {
    const t = terrain;
    if (!t) return 0;

    const fx = (x - t.minX) / (t.maxX - t.minX) * (t.width  - 1);
    const fz = (t.maxZ - z) / (t.maxZ - t.minZ) * (t.height - 1);
    if (!(fx >= 0 && fx <= t.width - 1 && fz >= 0 && fz <= t.height - 1)) {
        return t.seaLevel || 0;                  // off the map edge
    }

    const x0 = fx | 0, z0 = fz | 0;
    const x1 = Math.min(x0 + 1, t.width  - 1);
    const z1 = Math.min(z0 + 1, t.height - 1);
    const tx = fx - x0, tz = fz - z0;

    const d = t.data;
    const a = d[z0 * t.width + x0], b = d[z0 * t.width + x1];
    const c = d[z1 * t.width + x0], e = d[z1 * t.width + x1];

    return (a + (b - a) * tx) * (1 - tz) + (c + (e - c) * tx) * tz;
}

const MASK_STEP    = 100;    // metres between profile samples
const MASK_RADIALS = 180;    // one every two degrees
const MAST_HEIGHT  = 10;     // antenna above local ground

// Distance along one radial at which an aircraft at ownAltM passes behind
// terrain, or maxR if it never does.
//
// Compares ANGLES, not heights: a low ridge close in blocks more sky than a
// tall peak far out. The running maximum of terrain angle only rises with
// distance while the aircraft's angle only falls, so the two cross exactly
// once - one cutoff per radial, and the walk can stop there.
function maskedDistance(ox, oz, obsH, bearing, maxR) {
    const sin = Math.sin(bearing), cos = Math.cos(bearing);
    let maxAngle = -Infinity;

    for (let d = MASK_STEP; d <= maxR; d += MASK_STEP) {
        // Tested against terrain strictly closer than d, so a sample does not
        // block the aircraft sitting on top of it.
        if ((ownAltM - obsH) / d < maxAngle) return d - MASK_STEP;

        const h = terrainAt(ox + sin * d, oz + cos * d);
        const angle = (h - obsH) / d;
        if (angle > maxAngle) maxAngle = angle;
    }
    return maxR;
}

// Profiles are keyed by unit, altitude and radius. Panning and zooming reuse
// them; changing altitude does not, since every angle depends on it.
const maskCache = new Map();

function maskProfileFor(unit, maxR) {
    const key = unitPath(unit) + '|' + Math.round(ownAltM) + '|' + Math.round(maxR / 500);
    let profile = maskCache.get(key);
    if (profile) return profile;

    const obsH = terrainAt(unit.x, unit.z) + MAST_HEIGHT;
    profile = new Float32Array(MASK_RADIALS);
    for (let i = 0; i < MASK_RADIALS; i++) {
        profile[i] = maskedDistance(unit.x, unit.z, obsH,
                                    i * 2 * Math.PI / MASK_RADIALS, maxR);
    }

    if (maskCache.size > 4000) maskCache.clear();
    maskCache.set(key, profile);
    return profile;
}

// Masking is skipped while the altitude is being dragged. A full pass is tens
// of millions of samples, which would stall the drag; plain circles are drawn
// until the control settles, then the masked shapes replace them.
let maskSuspended = false;
let maskTimer = null;

function suspendMask() {
    maskSuspended = true;
    clearTimeout(maskTimer);
    maskTimer = setTimeout(() => {
        maskSuspended = false;
        if (currentMission) draw(currentMission);
    }, 180);
}

// ---------------------------------------------------------------------------
// Ring labels
//
// A mission with dozens of ringed units produces hundreds of labels, most of
// them repeats: twenty identical emplacements yield twenty identical plates.
// Two separate problems, handled separately.
//
//   OVERLAP    labels landing on top of each other. Candidates are collected
//              first, ranked, then placed only where they clear everything
//              already placed - the standard cartographic approach, and the
//              reason placement is a second pass rather than inline.
//
//   REPETITION labels that do not overlap but say the same thing. A repeat of
//              text already on screen is placed only beyond LABEL_SPACING, so
//              a cluster is labelled once rather than fifteen times.
//
// Ranking decides what survives a collision: weapon envelopes over sensors,
// then larger rings over smaller.
// ---------------------------------------------------------------------------
// Rings and labels drawn this frame, in screen coordinates, so the cursor can
// be tested against what is actually on screen - the same approach drawnUnits
// uses for the symbols.
let drawnRings  = [];
let drawnLabels = [];

// Identifies a ring across redraws. Ring objects are rebuilt every frame, so
// object identity cannot carry a hover between them.
function ringKey(unit, ring) {
    return unitPath(unit) + '|' + ring.kind + '|' + ring.label;
}

let hoveredRing = null;   // { key, unit } or null

// Radius of a ring along one bearing, following the masked outline where there
// is one. Nearest radial rather than interpolated: the profile is sampled every
// two degrees and the hit tolerance is wider than the difference.
function ringRadiusAt(ring, profile, bearing) {
    if (!profile) return ring.r;
    const i = Math.round(bearing / (Math.PI * 2) * profile.length) % profile.length;
    return Math.min(profile[i], ring.r);
}

// The ring outline under the cursor, or null. Tests the EDGE, not the interior,
// so nested rings each stay selectable.
function ringAtScreen(sx, sy) {
    for (const d of drawnRings) {
        const dx = sx - d.x, dy = sy - d.y;
        let bearing = Math.atan2(dx, -dy);
        if (bearing < 0) bearing += Math.PI * 2;

        const r = ringRadiusAt(d.ring, d.profile, bearing) * d.mPerPx;
        if (Math.abs(Math.hypot(dx, dy) - r) < 6) return d;
    }
    return null;
}

function labelAtScreen(sx, sy) {
    for (const l of drawnLabels) {
        if (sx >= l.x && sx <= l.x + l.w && sy >= l.y && sy <= l.y + l.h) return l;
    }
    return null;
}

const LABEL_SPACING = 240;      // px between repeats of the same text
const LABEL_PAD     = 3;        // px of clearance required around each plate

const KIND_RANK = { weapon: 0, radar: 1, optical: 2 };

function placeLabels(ctx, candidates) {
    candidates.sort((a, b) =>
        (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || (b.r - a.r));

    const placed = [];

    ctx.font = '11px ui-monospace, Consolas, monospace';
    for (const c of candidates) {
        const w = ctx.measureText(c.text).width + 8;
        const h = 16;
        const box = { x: c.x - w / 2, y: c.y - h / 2, w: w, h: h };

        let blocked = false;
        for (const q of placed) {
            if (q.text === c.text &&
                Math.hypot(q.cx - c.x, q.cy - c.y) < LABEL_SPACING) {
                blocked = true; break;
            }
            if (box.x - LABEL_PAD < q.x + q.w && box.x + box.w + LABEL_PAD > q.x &&
                box.y - LABEL_PAD < q.y + q.h && box.y + box.h + LABEL_PAD > q.y) {
                blocked = true; break;
            }
        }
        if (blocked) continue;

        const emphasis = hoveredRing && hoveredRing.key === c.key;
        plate(ctx, c.text, c.x, c.y, emphasis ? '#ffffff' : c.colour);
        placed.push({ x: box.x, y: box.y, w: w, h: h,
                      cx: c.x, cy: c.y, text: c.text });
        drawnLabels.push({ x: box.x, y: box.y, w: w, h: h,
                           key: c.key, unit: c.unit, ring: c.ring });
    }
}

// A circle, or the masked outline when a profile is supplied.
function ringPath(ctx, p, radiusM, mPerPx, profile) {
    ctx.beginPath();
    if (!profile) {
        ctx.arc(p.x, p.y, radiusM * mPerPx, 0, Math.PI * 2);
        return;
    }
    for (let i = 0; i < profile.length; i++) {
        const bearing = i * 2 * Math.PI / profile.length;
        const d = Math.min(profile[i], radiusM) * mPerPx;
        const x = p.x + Math.sin(bearing) * d;
        const y = p.y - Math.cos(bearing) * d;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
}

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
// Measuring tool
//
// A modal tool. While a measurement is active the left button drops a point
// rather than starting a pan, so mousedown, mousemove, dblclick, keydown and
// draw all test `measure`. Exits: double-click finishes a path, Escape
// finishes then clears.
//
// Points are stored in world metres, so a measurement holds its position on
// the ground through pan and zoom.
// ---------------------------------------------------------------------------
const MEAS = '110,231,183';                 // measuring-tool colour, rgb components

// Range ring colours. The chosen colour is stored on each ring at creation, so
// the picker sets the colour of subsequent rings only and leaves existing ones
// unchanged. Options are named as well as coloured, so a ring can be referred
// to verbally.
const RING_COLOURS = [
    ['Grey',    '#c8ced6'],
    ['White',   '#ffffff'],
    ['Amber',   '#ffd166'],
    ['Green',   '#6ee7b7'],
    ['Cyan',    '#67d4f0'],
    ['Magenta', '#e58fd0'],
    ['Red',     '#f08a7f']
];

let ringColour = RING_COLOURS[0][1];

const ringPreset = document.getElementById('ringPreset');
const ringCustom = document.getElementById('ringCustom');

for (const [name, hex] of RING_COLOURS) {
    const opt = document.createElement('option');
    opt.value = hex;
    opt.textContent = name;
    ringPreset.appendChild(opt);
}
const customOpt = document.createElement('option');
customOpt.value = 'custom';
customOpt.textContent = 'Custom…';
ringPreset.appendChild(customOpt);

function ringColourName() {
    const hit = RING_COLOURS.find(c => c[1] === ringColour);
    return hit ? hit[0].toLowerCase() : 'the chosen colour';
}

function setRingColour(hex) {
    ringColour = hex;
    ringCustom.value = hex;
    // Show the name if it is one of ours, otherwise fall to "Custom".
    ringPreset.value = RING_COLOURS.some(c => c[1] === hex) ? hex : 'custom';
}

ringPreset.addEventListener('change', () => {
    if (ringPreset.value === 'custom') ringCustom.click();   // open the picker
    else setRingColour(ringPreset.value);
});
ringCustom.addEventListener('input', () => setRingColour(ringCustom.value));

setRingColour(ringColour);

// kind 'path'    - a run of legs, each labelled with its own bearing and range
// kind 'circle'  - a ring whose radius is dragged out from a chosen centre
//
// A single mode carrying a kind, rather than two independent modes: two mode
// flags could both be set, leaving the meaning of a click undefined.
let measure = null;   // { kind, points: [{x,z}], cursor: {x,z}|null, done }

function startMeasure(at, kind, label) {
    if (routeMode) endRouteMode();
    measure = { kind: kind || 'path', points: [at], cursor: at,
                done: false, label: label || null };
    canvas.style.cursor = 'crosshair';
    if (currentMission) draw(currentMission);
}

// Completed rings, retained until cleared. Rings accumulate rather than
// replacing one another, so overlapping coverage can be read across several
// sites at once. Stored in world metres, so each ring holds its position
// through pan and zoom.
const rings = [];    // [{ x, z, r, label }]

// Index of the ring whose EDGE is under the cursor, or -1. The radial error is
// converted from metres to pixels before comparison, giving a constant 8 px
// hit target at any zoom level.
function ringAt(sx, sy) {
    const w = toWorld(sx, sy);
    for (let i = rings.length - 1; i >= 0; i--) {
        const d     = Math.hypot(w.x - rings[i].x, w.z - rings[i].z);
        const errPx = Math.abs(d - rings[i].r) * fit.scale * view.scale;
        if (errPx < 8) return i;
    }
    return -1;
}

// Drawn UNDER the units, like the bullseye rose - a kept ring is context, and
// must not sit on top of the symbols you are reading it against.
function drawRings(ctx) {
    if (!rings.length) return;

    ctx.save();
    for (const ring of rings) {
        const p   = toScreen(ring.x, ring.z);
        const rpx = ring.r * fit.scale * view.scale;

        const col = ring.colour || ringColour;

        // Dark halo underneath, then the ring. The halo supplies the contrast
        // that keeps a pale ring legible over snow or a bright coastline.
        ctx.strokeStyle = 'rgba(11,16,20,0.7)';
        ctx.lineWidth   = 4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rpx, 0, Math.PI * 2);
        ctx.stroke();

        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = col;
        ctx.lineWidth   = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rpx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fillStyle   = col;
        ctx.strokeStyle = '#0b1014';
        ctx.lineWidth   = 1.5;
        ctx.fill();
        ctx.stroke();

        // Labelled at twelve o'clock, so stacked rings stay tellable apart.
        const ly = p.y - rpx;
        if (ly > 10 && ly < canvas.height - 10 && p.x > 0 && p.x < canvas.width) {
            plate(ctx, (ring.label ? ring.label + '  ' : '') + fmtRange(ring.r),
                  p.x, ly, col);
        }
    }
    ctx.restore();
}

// Radius of a circle measurement, in metres - from the centre to whichever
// point is currently defining the edge.
function measureRadius() {
    if (!measure || measure.kind !== 'circle') return 0;
    const edge = measure.done ? measure.points[1] : measure.cursor;
    return edge ? bearingRange(measure.points[0], edge).range : 0;
}

// Finish but keep it on screen - you have measured something and want to read
// it while you look at the map.
function endMeasure() {
    if (!measure) return;

    // A finished circle becomes a kept ring and stops being the live
    // measurement, which is what lets the next one stack rather than replace.
    if (measure.kind === 'circle') {
        const r = measureRadius();
        if (r > 0) {
            rings.push({ x: measure.points[0].x, z: measure.points[0].z,
                         r: r, label: measure.label, colour: ringColour });
        }
        clearMeasure();
        return;
    }

    measure.done   = true;
    measure.cursor = null;
    canvas.style.cursor = '';
    if (currentMission) draw(currentMission);
}

function clearMeasure() {
    measure = null;
    canvas.style.cursor = '';
    if (currentMission) draw(currentMission);
}

// Total ground distance along the path, in metres.
function measureTotal() {
    if (!measure) return 0;
    let total = 0;
    for (let i = 1; i < measure.points.length; i++) {
        total += bearingRange(measure.points[i - 1], measure.points[i]).range;
    }
    return total;
}

// A label on a dark plate. Text over terrain carries its own contrast rather
// than relying on the colour alone.
function plate(ctx, text, x, y, colour) {
    colour = colour || 'rgb(' + MEAS + ')';
    ctx.font = '11px ui-monospace, Consolas, monospace';
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(11,16,20,0.85)';
    ctx.fillRect(x - w / 2 - 4, y - 8, w + 8, 16);
    // Border in the same colour but faded. globalAlpha rather than an rgba
    // string, because the colour arrives as a hex and cannot carry an alpha.
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = colour;
    ctx.lineWidth   = 1;
    ctx.strokeRect(x - w / 2 - 4, y - 8, w + 8, 16);
    ctx.restore();
    ctx.fillStyle    = colour;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
}

function drawMeasureCircle(ctx) {
    const c    = measure.points[0];
    const edge = measure.done ? measure.points[1] : measure.cursor;
    if (!edge) return;

    const p   = toScreen(c.x, c.z);
    const br  = bearingRange(c, edge);
    // Metres to screen pixels, the same product the bullseye rose uses. The
    // ring is a real distance on the ground, so it has to scale with the map.
    const rpx = br.range * fit.scale * view.scale;

    ctx.save();

    ctx.strokeStyle = 'rgba(11,16,20,0.9)';
    ctx.lineWidth   = 5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, rpx, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = ringColour;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, rpx, 0, Math.PI * 2);
    ctx.stroke();

    // The radius, dashed - a different shape from the solid path tool, so the
    // two read apart without depending on the colour difference.
    const q = toScreen(edge.x, edge.z);
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = ringColour;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle   = ringColour;
    ctx.strokeStyle = '#0b1014';
    ctx.lineWidth   = 2;
    ctx.fill();
    ctx.stroke();

    plate(ctx, 'R ' + fmtRange(br.range), (p.x + q.x) / 2, (p.y + q.y) / 2,
          ringColour);

    ctx.restore();
}

function drawMeasure(ctx) {
    if (!measure) return;
    if (measure.kind === 'circle') return drawMeasureCircle(ctx);

    // The rubber band: the leg from the last placed point to wherever the
    // cursor is, shown only while the measurement is still being built.
    const pts = measure.points.slice();
    if (!measure.done && measure.cursor) pts.push(measure.cursor);

    const scr = pts.map(pt => toScreen(pt.x, pt.z));

    ctx.save();

    // Halo pass then bright pass, as with the rose.
    for (const pass of [{ c: '11,16,20', w: 5 }, { c: MEAS, w: 2 }]) {
        ctx.strokeStyle = 'rgba(' + pass.c + ',0.9)';
        ctx.lineWidth   = pass.w;
        ctx.beginPath();
        ctx.moveTo(scr[0].x, scr[0].y);
        for (let i = 1; i < scr.length; i++) ctx.lineTo(scr[i].x, scr[i].y);
        ctx.stroke();
    }

    // A tick at every point you actually clicked - not at the cursor, which is
    // not a point yet.
    for (let i = 0; i < measure.points.length; i++) {
        const q = scr[i];
        ctx.beginPath();
        ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
        ctx.fillStyle   = 'rgb(' + MEAS + ')';
        ctx.strokeStyle = '#0b1014';
        ctx.lineWidth   = 2;
        ctx.fill();
        ctx.stroke();
    }

    // Bearing and range per leg, at the midpoint of that leg. Skipped when the
    // leg is too short to hold a label without covering its own endpoints.
    for (let i = 1; i < pts.length; i++) {
        const a = scr[i - 1], b = scr[i];
        if (Math.hypot(b.x - a.x, b.y - a.y) < 46) continue;
        const br = bearingRange(pts[i - 1], pts[i]);
        plate(ctx, fmtBearing(br.bearing) + '  ' + fmtRange(br.range),
              (a.x + b.x) / 2, (a.y + b.y) / 2);
    }

    // Running total at the far end, once there is more than one leg to add up.
    if (pts.length > 2) {
        const last = scr[scr.length - 1];
        let total = 0;
        for (let i = 1; i < pts.length; i++) {
            total += bearingRange(pts[i - 1], pts[i]).range;
        }
        plate(ctx, 'TOTAL ' + fmtRange(total), last.x, last.y - 18);
    }

    ctx.restore();
}

function drawFrame(ctx, x, y, size, affiliation) {
    ctx.beginPath();

    if (affiliation === 'hostile') {
        ctx.moveTo(x, y - size);
        ctx.lineTo(x + size, y);
        ctx.lineTo(x, y + size);
        ctx.lineTo(x - size, y);
        ctx.closePath();
    } else if (affiliation === 'friend') {
        ctx.rect(x - size, y - size * 0.7, size * 2, size * 1.4);
    } else {
        ctx.rect(x - size, y - size, size * 2, size * 2);
    }

    ctx.fillStyle = AFFIL_FILL[affiliation];
    ctx.fill();
    ctx.stroke();
}
const FACTION_LABELS = {
    'Boscali': 'BDF',
    'Primeva': 'PALA'
};

function factionLabel(name) {
    return FACTION_LABELS[name] || name;
}
function populateFactions(mission) {
    factionSelect.innerHTML = '';

    for (const f of mission.factions) {
        const option = document.createElement('option');
        option.value       = f.factionName;
        option.textContent = factionLabel(f.factionName);
        factionSelect.appendChild(option);
    }

    factionSelect.value = myFaction;
}

factionSelect.addEventListener('change', () => {
    myFaction = factionSelect.value;

    // Changing sides moves every unit between the Hostile and Friendly
    // branches, so the tree is rebuilt rather than the map merely redrawn.
    // Hidden paths are cleared: a path such as "hostile/Air Defence/SAM"
    // addresses the opposite side after the swap.
    hiddenPaths.clear();
    refreshTree();
});

// ---------------------------------------------------------------------------
// Layer tree:  affiliation -> group -> role
//
// Visibility is stored as a set of HIDDEN leaf paths ("hostile/Air Defence/SAM")
// rather than as checkbox states. Two reasons: the checkboxes are rebuilt from
// scratch on every render, so state kept on them would be lost; and a parent's
// state is then always derivable from its leaves rather than being a third
// thing that can disagree with them.
// ---------------------------------------------------------------------------
const layerTree    = document.getElementById('layerTree');
const hiddenPaths  = new Set();
const collapsedKeys = new Set();

const AFF_ORDER = ['hostile', 'friend', 'unknown'];
const AFF_LABEL = { hostile: 'Hostile', friend: 'Friendly', unknown: 'Unknown' };

// The leaf is an individual unit, not a type - so a single emplacement can be
// switched off when another flight is tasked to clear it.
function unitPath(u) {
    return typePath(u) + '/' + u.uid;
}

function groupPath(u) {
    return affiliationOf(u) + '/' + u.group;
}

function rolePath(u) {
    return groupPath(u) + '/' + u.role;
}

function typePath(u) {
    return rolePath(u) + '/' + u.type;
}

function isVisible(u) {
    return !hiddenPaths.has(unitPath(u));
}

// ---------------------------------------------------------------------------
// Tree rendering
//
// Shared by the layer tree (map visibility) and the ring tree (threat rings).
// Both render five levels - affiliation, group, role, type, unit - with
// tri-state parents derived from their leaves.
//
// A caller supplies a `spec` defining what a tick means:
//
//   container           element to render into
//   collapsed           Set of collapse keys
//   isOn(path)          is this leaf ticked?
//   setOn(paths, bool)  tick or untick these leaves
//   refresh()           redraw whatever the tree controls
//   render()            re-render the tree itself
//   filter(unit)        optional; omit units the tree should not list
//   extraForType(type)  optional; trailing detail on a type row
//
// The two trees store their state inversely - the layer tree holds a set of
// HIDDEN paths, the ring tree a set of RINGED paths - which isOn and setOn
// hide from the renderer.
//
// addNode renders one row plus an empty container for its children, and
// returns that container.
// ---------------------------------------------------------------------------
function addNode(spec, parent, depth, label, count, paths, collapseKey,
                 cssClass, unit, extra) {
    const row = document.createElement('div');
    row.className = 'ltRow';
    row.style.paddingLeft = (depth * 11 + 4) + 'px';   // five levels in 300px

    const twisty = document.createElement('span');
    twisty.className = 'ltTwisty';
    twisty.textContent = collapseKey
        ? (spec.collapsed.has(collapseKey) ? '\u25b6' : '\u25bc')
        : '';
    row.appendChild(twisty);

    // A parent is checked if ANY leaf under it is on, and indeterminate if only
    // some are - the standard tri-state you get in a file browser.
    const on = paths.filter(p => spec.isOn(p)).length;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = on > 0;
    box.indeterminate = on > 0 && on < paths.length;
    row.appendChild(box);

    const lab = document.createElement('span');
    lab.className = 'ltLabel' + (cssClass ? ' ' + cssClass : '');
    lab.textContent = label;
    row.appendChild(lab);

    // Optional trailing detail. The ring tree renders each type's reach here,
    // making long-range threats identifiable without expanding the branch.
    if (extra) {
        const ex = document.createElement('span');
        ex.className = 'ltExtra';
        ex.textContent = extra;
        row.appendChild(ex);
    }

    const cnt = document.createElement('span');
    cnt.className = 'ltCount';
    cnt.textContent = count;
    row.appendChild(cnt);

    // Hovering a unit row highlights that unit on the map, distinguishing it
    // from other emplacements of the same type.
    if (unit) {
        row.addEventListener('mouseenter', () => {
            hoveredUnit = unit;
            if (currentMission) draw(currentMission);
        });
        row.addEventListener('mouseleave', () => {
            hoveredUnit = null;
            if (currentMission) draw(currentMission);
        });
    }

    const kids = document.createElement('div');
    if (collapseKey && spec.collapsed.has(collapseKey)) kids.style.display = 'none';

    box.addEventListener('change', () => {
        spec.setOn(paths, box.checked);
        spec.refresh();
    });

    if (collapseKey) {
        row.addEventListener('click', (e) => {
            if (e.target === box) return;      // the checkbox handles its own clicks
            if (spec.collapsed.has(collapseKey)) spec.collapsed.delete(collapseKey);
            else spec.collapsed.add(collapseKey);
            spec.render();
        });
    }

    parent.appendChild(row);
    parent.appendChild(kids);
    return kids;
}

function buildTree(spec, units) {
    // affiliation -> group -> role -> type -> [units]
    // Storing the units themselves rather than counts, because the deepest
    // level needs each individual unit to hover and toggle.
    const tree = {};
    for (const u of units) {
        if (spec.filter && !spec.filter(u)) continue;
        const a = affiliationOf(u);
        tree[a] = tree[a] || {};
        tree[a][u.group] = tree[a][u.group] || {};
        tree[a][u.group][u.role] = tree[a][u.group][u.role] || {};
        const types = tree[a][u.group][u.role];
        types[u.type] = types[u.type] || [];
        types[u.type].push(u);
    }

    spec.container.innerHTML = '';

    if (!Object.keys(tree).length) {
        spec.container.innerHTML =
            '<div class="hint">' + (spec.emptyText || '') + '</div>';
        return;
    }

    // Collect every unit sitting under part of the tree, at any depth.
    function under(node) {
        if (Array.isArray(node)) return node;
        let out = [];
        for (const key of Object.keys(node)) out = out.concat(under(node[key]));
        return out;
    }
    const pathsOf = list => list.map(unitPath);

    for (const aff of AFF_ORDER) {
        if (!tree[aff]) continue;
        const groups   = tree[aff];
        const affUnits = under(groups);

        const affKids = addNode(spec, spec.container, 0, AFF_LABEL[aff],
                                affUnits.length, pathsOf(affUnits), aff, 'ltAff');

        for (const g of Object.keys(groups).sort()) {
            const roles  = groups[g];
            const gKey   = aff + '/' + g;
            const gUnits = under(roles);
            const gKids  = addNode(spec, affKids, 1, g, gUnits.length,
                                   pathsOf(gUnits), gKey, null);

            for (const r of Object.keys(roles).sort()) {
                const types  = roles[r];
                const rKey   = gKey + '/' + r;
                const rUnits = under(types);
                const rKids  = addNode(spec, gKids, 2, r, rUnits.length,
                                       pathsOf(rUnits), rKey, 'ltRole');

                // Sorted by display name, not by key - the key is an internal
                // identifier and sorting by it would look arbitrary.
                const sortedTypes = Object.keys(types)
                    .sort((a, b) => unitName(a).localeCompare(unitName(b)));

                for (const t of sortedTypes) {
                    const list  = types[t];
                    const tKey  = rKey + '/' + t;
                    const tKids = addNode(spec, rKids, 3, unitName(t), list.length,
                                          pathsOf(list), tKey, 'ltType', null,
                                          spec.extraForType && spec.extraForType(t));

                    for (const u of list) {
                        addNode(spec, tKids, 4, u.unitName, '',
                                [unitPath(u)], null, 'ltUnit', u);
                    }
                }
            }
        }
    }
}

// --- the layer tree: a tick means "shown on the map" -----------------------
const layerSpec = {
    container: layerTree,
    collapsed: collapsedKeys,
    isOn:  p => !hiddenPaths.has(p),
    setOn: (paths, on) => paths.forEach(p => on ? hiddenPaths.delete(p)
                                               : hiddenPaths.add(p)),
    refresh: () => refreshTree(),
    render:  () => renderTree(unitsOf(currentMission)),
};

function renderTree(units) {
    buildTree(layerSpec, units);
}

// Redraw the map and rebuild the tree, so counts and tri-states stay honest.
function refreshTree() {
    if (!currentMission) return;
    draw(currentMission);
    renderTree(unitsOf(currentMission));
}

// Falls back to the raw key if the catalogue has not loaded yet, or if this is a
// modded unit the extractor never saw. Never blank, never crashes.
function unitName(type) {
    const entry = unitCatalogue[type];
    return entry ? entry.name : type;
}

function draw(mission) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // The basemap goes through the same fit-then-view transform as every unit,
    // so it can never drift out of register with the markers on top of it.
    const mw = currentMap.maxX - currentMap.minX;
    const mh = currentMap.maxZ - currentMap.minZ;
    ctx.drawImage(basemap,
        fit.offsetX * view.scale + view.panX,
        fit.offsetY * view.scale + view.panY,
        mw * fit.scale * view.scale,
        mh * fit.scale * view.scale);
    ctx.strokeStyle = '#101418';
    ctx.lineWidth   = 1.5;

    const units = unitsOf(mission).filter(isVisible);

    // Remember where each marker actually landed. Hover then tests against what
    // is genuinely on screen, so filtered-out units can never be picked, and
    // pan and zoom need no special handling.
    drawnUnits = [];

    // Under the units: a rose spanning the map must not sit on top of them.
    drawBullseyeRose(ctx);
    drawRings(ctx);
    drawThreatRings(ctx, units);

    // Above the rings the route is read against, below the symbols.
    drawFlights(ctx);

    for (const unit of units) {
        const p = toScreen(unit.x, unit.z);
        drawSymbol(ctx, p.x, p.y, unit);
        drawnUnits.push({ unit: unit, sx: p.x, sy: p.y });
    }

    drawBullseyeCentre(ctx);
    drawMeasure(ctx);

    // Ring the hovered marker last, so it sits on top of its neighbours. Drawn
    // as a white ring rather than a colour change, so it reads by shape and
    // brightness rather than hue.
    if (hoveredUnit) {
        const p = toScreen(hoveredUnit.x, hoveredUnit.z);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth   = 2;
        ctx.stroke();
    }
}

drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.style.borderColor = '#5aa9d6';
});
    drop.addEventListener('dragleave', () => {
  drop.style.borderColor = '#3d4a55';
});
// ---------------------------------------------------------------------------
// Hover to identify
// ---------------------------------------------------------------------------
const tip = document.getElementById('tip');

// Filled by draw(): every marker currently on screen and where it landed.
let drawnUnits = [];

// The unit under the cursor, or null. draw() rings it.
let hoveredUnit = null;

function unitAt(mx, my) {
    let best = null;
    let bestDist = 12;               // pixels - generous, markers are ~10 across

    for (const d of drawnUnits) {
        // Math.hypot is the distance between two points: sqrt(dx*dx + dy*dy)
        const dist = Math.hypot(d.sx - mx, d.sy - my);
        if (dist < bestDist) { bestDist = dist; best = d.unit; }
    }
    return best;
}

function showTip(unit, clientX, clientY) {
    if (!unit) { tip.style.display = 'none'; return; }

    const entry = unitCatalogue[unit.type] || {};
    const affil = affiliationOf(unit);

    tip.innerHTML =
        '<div class="n">' + unitName(unit.type) + '</div>' +
        '<div class="r">' + unit.group + ' &middot; ' + unit.role + '</div>' +
        '<div>' + factionLabel(unit.faction) + ' &middot; ' + affil + '</div>' +
        (bullseye ? '<div style="color:' + BULL_HEX + ';margin-top:4px;">BULLSEYE '
                    + fmtBullseye(unit) + '</div>' : '') +
        (entry.description ? '<div style="margin-top:5px;color:#9fb0bd;">'
                             + entry.description + '</div>' : '') +
        '<div class="k" style="margin-top:5px;">' + unit.type + '</div>';

    tip.style.display = 'block';
    tip.style.left = (clientX + 14) + 'px';
    tip.style.top  = (clientY + 14) + 'px';
}

// ---- status bar ----
const stPos  = document.getElementById('stPos');
const stBull = document.getElementById('stBull');
const stMeas = document.getElementById('stMeas');

function updateStatus(sx, sy) {
    if (!currentMap) return;
    const w = toWorld(sx, sy);

    stPos.textContent  = Math.round(w.x) + ', ' + Math.round(w.z);
    stBull.textContent = bullseye ? 'BE ' + fmtBullseye(w) : '';

    // While a measurement is open the total includes the leg to the cursor, so
    // the number moves with the mouse and you can stop at a distance.
    if (!measure) {
        stMeas.textContent = rings.length
            ? rings.length + (rings.length === 1 ? ' ring' : ' rings') : '';
    } else if (measure.kind === 'circle') {
        stMeas.textContent = 'RING R ' + fmtRange(measureRadius()) +
                             (measure.done ? '' : '  (click to set)');
    } else {
        let total = measureTotal();
        if (!measure.done && measure.cursor) {
            total += bearingRange(measure.points[measure.points.length - 1],
                                  measure.cursor).range;
        }
        stMeas.textContent = 'MEAS ' + fmtRange(total) +
                             (measure.done ? '' : '  (dbl-click to finish)');
    }
}

document.getElementById('unitToggle').addEventListener('click', (e) => {
    unitSystem = (unitSystem === 'aviation') ? 'metric' : 'aviation';
    e.target.textContent = (unitSystem === 'aviation') ? 'NM / ft' : 'km / m';
    refreshAltField();
    renderWaypoints();      // waypoint altitudes are shown in the chosen unit
    updateOwnship();
});

canvas.addEventListener('mousemove', (e) => {
    // The cursor is stored before updateStatus runs, because updateStatus adds
    // the open leg into the running total and must read the current position.
    if (measure && !measure.done && !dragging) {
        measure.cursor = toWorld(e.offsetX, e.offsetY);
    }

    if (dragWaypoint) {
        const at = toWorld(e.offsetX, e.offsetY);
        const w = flights[dragWaypoint.flight].waypoints[dragWaypoint.index];
        w.x = at.x; w.z = at.z;
        updateStatus(e.offsetX, e.offsetY);
        renderFlights();
        if (currentMission) draw(currentMission);
        return;
    }

    // While the map is being dragged the readout still follows the pointer,
    // but the open leg does not: the world under the cursor is moving, and
    // chasing it makes the rubber band swing about.
    if (routeMode && activeFlight >= 0) {
        if (!dragging) routeCursor = toWorld(e.offsetX, e.offsetY);
        tip.style.display = 'none';
        updateStatus(e.offsetX, e.offsetY);
        if (currentMission) draw(currentMission);
        return;
    }

    updateStatus(e.offsetX, e.offsetY);

    // While measuring, every move redraws so the open leg tracks the cursor.
    // Hover identification is suppressed - one thing at a time under the mouse.
    if (measure && !measure.done) {
        tip.style.display = 'none';
        if (currentMission) draw(currentMission);
        return;
    }

    if (dragging) { tip.style.display = 'none'; return; }

    // Symbols first, then labels, then ring outlines: the topmost thing under
    // the cursor wins, and a label is an easier target than a one-pixel edge.
    const found = unitAt(e.offsetX, e.offsetY);
    const hit = found ? null
                      : (labelAtScreen(e.offsetX, e.offsetY) ||
                         ringAtScreen(e.offsetX, e.offsetY));

    const unit = found || (hit && hit.unit) || null;
    const key  = hit ? hit.key : null;

    // Only repaint when the hovered thing actually CHANGES. Redrawing on every
    // mousemove would mean ~60 full redraws a second for no visible difference.
    if (unit !== hoveredUnit || key !== (hoveredRing && hoveredRing.key)) {
        hoveredUnit = unit;
        hoveredRing = hit ? { key: hit.key, unit: hit.unit } : null;
        if (currentMission) draw(currentMission);
    }

    canvas.style.cursor = (measure && !measure.done) ? 'crosshair'
                        : (found || hit) ? 'pointer' : '';

    if (hit) showRingTip(hit, e.clientX, e.clientY);
    else showTip(found, e.clientX, e.clientY);
});

canvas.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
    if (hoveredRing) {
        hoveredRing = null;
        hoveredUnit = null;
        if (currentMission) draw(currentMission);
    }
});

canvas.addEventListener('dblclick', () => {
    if (routeMode) { endRouteMode(); return; }
    if (!measure || measure.done || measure.kind !== 'path') return;

    // A double-click is two clicks, and both already dropped a point. Throw the
    // second away if it landed on top of the first.
    const pts = measure.points;
    if (pts.length > 1) {
        const a = pts[pts.length - 1], b = pts[pts.length - 2];
        if (Math.hypot(a.x - b.x, a.z - b.z) < 1) pts.pop();
    }
    endMeasure();
});

// ---------------------------------------------------------------------------
// Right-click menu
//
// showMenu takes a title and a list of {label, run} items and knows nothing
// about what they do. Map features - place a bullseye, measure, draw a range
// ring - are entries here rather than controls competing for panel space.
// ---------------------------------------------------------------------------
// Tooltip for a hovered ring: which unit it belongs to, and what the ring is.
function showRingTip(hit, clientX, clientY) {
    const ring = hit.ring, unit = hit.unit;
    const kind = ring.kind === 'weapon' ? 'Weapon envelope'
               : ring.kind === 'radar'  ? 'Radar detection'
               : 'Optical / IR';

    tip.innerHTML =
        '<b>' + unitName(unit.type) + '</b>' +
        '<div style="color:#8a9aa6;margin-top:2px;">' + unit.unitName + '</div>' +
        '<div style="margin-top:4px;">' + kind + '</div>' +
        '<div style="color:#9fb6c6;">' + ring.label +
        (ring.capped ? '  (horizon limited)' : '') +
        (ring.inBand === false ? '  (altitude out of band)' : '') + '</div>' +
        (ring.los ? '' : '<div style="color:#8a9aa6;">not terrain limited</div>');

    tip.style.display = 'block';
    tip.style.left = (clientX + 14) + 'px';
    tip.style.top  = (clientY + 14) + 'px';
}

// ---------------------------------------------------------------------------
// The flights panel
// ---------------------------------------------------------------------------
const flightListEl = document.getElementById('flightList');
const waypointListEl = document.getElementById('waypointList');
const flightTotalEl = document.getElementById('flightTotal');

function renderFlights() {
    flightListEl.innerHTML = '';

    if (!flights.length) {
        flightListEl.innerHTML =
            '<div class="hint">No flights yet. New flight, then click the map.</div>';
    }

    flights.forEach((f, i) => {
        const row = document.createElement('div');
        row.className = 'flightRow' + (i === activeFlight ? ' active' : '');
        row.addEventListener('click', () => {
            activeFlight = i;
            renderFlights();
            if (currentMission) draw(currentMission);
        });

        const vis = document.createElement('input');
        vis.type = 'checkbox';
        vis.checked = f.visible;
        vis.title = 'Show this route';
        vis.addEventListener('click', e => e.stopPropagation());
        vis.addEventListener('change', () => {
            f.visible = vis.checked;
            if (currentMission) draw(currentMission);
        });

        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.style.background = f.colour;

        const name = document.createElement('input');
        name.className = 'nm';
        name.value = f.name;
        name.addEventListener('click', e => e.stopPropagation());
        name.addEventListener('input', () => {
            f.name = name.value;
            if (currentMission) draw(currentMission);
        });

        const ct = document.createElement('span');
        ct.className = 'ct';
        ct.textContent = f.waypoints.length + ' wp  ' + fmtRange(flightTotal(f));

        row.append(vis, chip, name, ct);
        flightListEl.appendChild(row);
    });

    renderWaypoints();
}

function renderWaypoints() {
    waypointListEl.innerHTML = '';
    const f = flights[activeFlight];

    if (!f) {
        flightTotalEl.textContent = '';
        waypointListEl.innerHTML = '<div class="hint">Select a flight.</div>';
        return;
    }

    flightTotalEl.textContent = f.waypoints.length
        ? fmtRange(flightTotal(f)) + (routeMode ? '   adding\u2026' : '') : '';

    f.waypoints.forEach((w, i) => {
        const row = document.createElement('div');
        row.className = 'wpRow';

        const n = document.createElement('span');
        n.className = 'n';
        n.textContent = i + 1;

        const leg = document.createElement('span');
        leg.className = 'leg';
        leg.textContent = i === 0 ? 'start'
            : (br => fmtBearing(br.bearing) + '  ' + fmtRange(br.range))
              (bearingRange(f.waypoints[i - 1], w));

        // Altitude is shown in the unit currently selected in the bar, and
        // stored in metres, so switching units never alters the route.
        const alt = document.createElement('input');
        alt.className = 'alt';
        alt.type = 'number';
        alt.step = unitSystem === 'aviation' ? 500 : 100;
        alt.value = Math.round(unitSystem === 'aviation'
                               ? w.alt * FT_PER_M : w.alt);
        alt.title = 'Altitude at this waypoint';
        alt.addEventListener('input', () => {
            const v = parseFloat(alt.value);
            if (!isFinite(v) || v < 0) return;
            w.alt = unitSystem === 'aviation' ? v / FT_PER_M : v;
            if (currentMission) draw(currentMission);
        });

        const del = document.createElement('button');
        del.className = 'del';
        del.type = 'button';
        del.textContent = '\u00d7';
        del.title = 'Remove this waypoint';
        del.addEventListener('click', () => {
            f.waypoints.splice(i, 1);
            renderFlights();
            if (currentMission) draw(currentMission);
        });

        row.append(n, leg, alt, del);
        waypointListEl.appendChild(row);
    });

    if (!f.waypoints.length) {
        waypointListEl.innerHTML =
            '<div class="hint">Click the map to place the first waypoint.</div>';
    }
}

document.getElementById('flightNew').addEventListener('click', () => {
    flightWin.setOpen(true);
    newFlight();
});

document.getElementById('flightAppend').addEventListener('click', () => {
    if (routeMode) endRouteMode(); else startRouteMode();
});

document.getElementById('flightDelete').addEventListener('click', () => {
    if (activeFlight < 0) return;
    flights.splice(activeFlight, 1);
    activeFlight = Math.min(activeFlight, flights.length - 1);
    endRouteMode();
});

renderFlights();

const menu = document.getElementById('menu');

function hideMenu() { menu.style.display = 'none'; }

function showMenu(clientX, clientY, title, subtitle, items) {
    menu.innerHTML = '';

    if (title) {
        const head = document.createElement('div');
        head.className = 'mHead';
        head.textContent = title;
        if (subtitle) {
            const sub = document.createElement('span');
            sub.textContent = subtitle;
            head.appendChild(sub);
        }
        menu.appendChild(head);
    }

    for (const item of items) {
        if (item === '-') {
            const sep = document.createElement('div');
            sep.className = 'mSep';
            menu.appendChild(sep);
            continue;
        }
        const el = document.createElement('div');
        el.className = 'mItem';
        el.textContent = item.label;
        el.addEventListener('click', () => { hideMenu(); item.run(); });
        menu.appendChild(el);
    }

    // Show it before measuring, or offsetWidth is 0 and the flip never happens.
    menu.style.display = 'block';
    menu.style.left = '0px';
    menu.style.top  = '0px';

    // Flip rather than overflow when near the right or bottom edge.
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const x = (clientX + w > window.innerWidth)  ? clientX - w : clientX;
    const y = (clientY + h > window.innerHeight) ? clientY - h : clientY;
    menu.style.left = Math.max(0, x) + 'px';
    menu.style.top  = Math.max(0, y) + 'px';
}

canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();               // suppress the browser's own menu
    tip.style.display = 'none';

    // Every item below is about a place on the map, and toWorld cannot answer
    // "where is this" before a map exists. updateStatus guards the same way.
    if (!currentMap) return;

    const unit = unitAt(e.offsetX, e.offsetY);

    if (unit) {
        showMenu(e.clientX, e.clientY,
            unitName(unit.type),
            factionLabel(unit.faction) + ' · ' + unit.role,
            [
                { label: 'Hide this unit', run: () => {
                    hiddenPaths.add(unitPath(unit));
                    refreshTree();
                }},
                { label: 'Hide all ' + unitName(unit.type), run: () => {
                    for (const u of unitsOf(currentMission)) {
                        if (u.type === unit.type) hiddenPaths.add(unitPath(u));
                    }
                    refreshTree();
                }},
                { label: 'Hide all ' + unit.role, run: () => {
                    for (const u of unitsOf(currentMission)) {
                        if (u.role === unit.role && u.group === unit.group) {
                            hiddenPaths.add(unitPath(u));
                        }
                    }
                    refreshTree();
                }},
                '-',
                // "Show only" is the inverse: clear everything, then hide what
                // does NOT match. Isolating one threat type is the common case
                // when you are working out whether a route is survivable.
                { label: 'Show only ' + unitName(unit.type), run: () => {
                    hiddenPaths.clear();
                    for (const u of unitsOf(currentMission)) {
                        if (u.type !== unit.type) hiddenPaths.add(unitPath(u));
                    }
                    refreshTree();
                }},
                { label: 'Show only ' + unit.role, run: () => {
                    hiddenPaths.clear();
                    for (const u of unitsOf(currentMission)) {
                        if (u.role !== unit.role || u.group !== unit.group) {
                            hiddenPaths.add(unitPath(u));
                        }
                    }
                    refreshTree();
                }},
                { label: 'Show only ' + unit.group, run: () => {
                    hiddenPaths.clear();
                    for (const u of unitsOf(currentMission)) {
                        if (u.group !== unit.group) hiddenPaths.add(unitPath(u));
                    }
                    refreshTree();
                }},
                '-',
                // The same two, narrowed to one side. Affiliation is derived
                // at call time, so these track the faction picker.
                { label: 'Show only ' + AFF_LABEL[affiliationOf(unit)] + ' ' + unit.role, run: () => {
                    const aff = affiliationOf(unit);
                    hiddenPaths.clear();
                    for (const u of unitsOf(currentMission)) {
                        if (u.role !== unit.role || u.group !== unit.group ||
                            affiliationOf(u) !== aff) {
                            hiddenPaths.add(unitPath(u));
                        }
                    }
                    refreshTree();
                }},
                { label: 'Show only ' + AFF_LABEL[affiliationOf(unit)] + ' ' + unit.group, run: () => {
                    const aff = affiliationOf(unit);
                    hiddenPaths.clear();
                    for (const u of unitsOf(currentMission)) {
                        if (u.group !== unit.group || affiliationOf(u) !== aff) {
                            hiddenPaths.add(unitPath(u));
                        }
                    }
                    refreshTree();
                }},
                '-',
                '-',
                { label: 'Measure from here', run: () => {
                    startMeasure({ x: unit.x, z: unit.z });
                }},
                { label: 'Range ring from here', run: () => {
                    startMeasure({ x: unit.x, z: unit.z }, 'circle',
                                 unitName(unit.type));
                }},
                ...(rings.length ? [{ label: 'Clear all rings', run: () => {
                    rings.length = 0;
                    if (currentMission) draw(currentMission);
                }}] : []),
                '-',
                { label: 'Show everything again', run: () => {
                    hiddenPaths.clear();
                    refreshTree();
                }}
            ]);
    } else {
        const at      = toWorld(e.offsetX, e.offsetY);
        const hitRing = ringAt(e.offsetX, e.offsetY);

        showMenu(e.clientX, e.clientY, null, null, [
            { label: bullseye ? 'Move bullseye here' : 'Place bullseye here', run: () => {
                bullseye = at;
                if (currentMission) draw(currentMission);
            }},
            ...(bullseye ? [{ label: 'Clear bullseye', run: () => {
                bullseye = null;
                if (currentMission) draw(currentMission);
            }}] : []),
            '-',
            { label: 'Measure from here', run: () => startMeasure(at) },
            { label: 'Range ring from here', run: () => startMeasure(at, 'circle') },
            ...(hitRing >= 0 ? [{ label: 'Remove this ring', run: () => {
                rings.splice(hitRing, 1);
                if (currentMission) draw(currentMission);
            }}, { label: 'Recolour this ring ' + ringColourName(), run: () => {
                rings[hitRing].colour = ringColour;
                if (currentMission) draw(currentMission);
            }}] : []),
            ...(rings.length > 1 ? [{ label: 'Recolour all rings ' + ringColourName(), run: () => {
                for (const r of rings) r.colour = ringColour;
                if (currentMission) draw(currentMission);
            }}] : []),
            ...(rings.length ? [{ label: 'Clear all rings', run: () => {
                rings.length = 0;
                if (currentMission) draw(currentMission);
            }}] : []),
            ...(measure ? [{ label: 'Clear measurement', run: clearMeasure }] : []),
            '-',
            { label: 'Show everything again', run: () => {
                hiddenPaths.clear();
                refreshTree();
            }}
        ]);
    }
});

// Any click elsewhere, any scroll, or Escape dismisses it.
window.addEventListener('mousedown', (e) => {
    if (!menu.contains(e.target)) hideMenu();
});
window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    // Escape unwinds one layer at a time: menu, then the measurement in
    // progress, then the finished measurement still on screen.
    if (menu.style.display === 'block')   { hideMenu(); }
    else if (routeMode)                   { endRouteMode(); }
    // A half-dragged ring is abandoned, not committed - Escape means "forget
    // this", and endMeasure would keep it.
    else if (measure && !measure.done)    {
        if (measure.kind === 'circle') clearMeasure(); else endMeasure();
    }
    else if (measure)                     { clearMeasure(); }
});

let dragging = false;
let lastX = 0, lastY = 0;

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    hideMenu();      // the menu is placed in screen pixels; zooming moves the map out from under it

    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const mx = e.offsetX;
    const my = e.offsetY;

    const desired = view.scale * factor;
    // A floor of 0.5 allows zooming out past the initial fit, leaving context
    // visible around the map's edges. The map occupies part of a larger canvas,
    // so a floor of 1 would clamp at the fitted size.
    const clamped = Math.min(25, Math.max(0.5, desired));
    const actual  = clamped / view.scale;

    view.panX = mx - (mx - view.panX) * actual;
    view.panY = my - (my - view.panY) * actual;
    view.scale = clamped;

    if (currentMission) draw(currentMission);
});


// A press that is waiting to become either a click or a drag.
//
// Placing tools and panning both want the left button, and taking it for
// placement outright makes the map immovable while a route or measurement is
// open. The press is therefore held until the button is released: moved more
// than DRAG_SLOP, it was a pan; otherwise it places a point at where the press
// began, not where the pointer ended up.
const DRAG_SLOP = 4;             // px of travel before a press counts as a drag
let press = null;                // { ox, oy, x, y, moved } while held

canvas.addEventListener('mousedown', (e) => {
    // Middle button always pans, in every mode, so there is a way to move the
    // map that never has to be disambiguated from anything else.
    if (e.button === 1) {
        e.preventDefault();      // suppress autoscroll
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        return;
    }

    if (e.button !== 0) return;  // right-click opens the menu

    // Grabbing an existing waypoint is unambiguous and takes precedence.
    const grab = waypointAt(e.offsetX, e.offsetY);
    if (grab) {
        dragWaypoint = grab;
        activeFlight = grab.flight;
        renderFlights();
        if (currentMission) draw(currentMission);
        return;
    }

    const placing = (routeMode && activeFlight >= 0) || (measure && !measure.done);
    if (placing) {
        press = { ox: e.offsetX, oy: e.offsetY,
                  x: e.clientX, y: e.clientY, moved: false };
    }

    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
});

// Called from mouseup when a press never travelled far enough to be a drag.
function placeAtPress(p) {
    if (routeMode && activeFlight >= 0) {
        const at = toWorld(p.ox, p.oy);
        flights[activeFlight].waypoints.push({ x: at.x, z: at.z, alt: ownAltM });
        renderFlights();
        if (currentMission) draw(currentMission);
        return;
    }

    if (measure && !measure.done) {
        measure.points.push(toWorld(p.ox, p.oy));
        // A circle is finished by the one click that sets its radius - there is
        // no second leg to add, so there is nothing to double-click to end.
        if (measure.kind === 'circle') endMeasure();
        else if (currentMission) draw(currentMission);
    }
}

window.addEventListener('mousemove', (e) => {
    if (!dragging) return;

    // Below the slop threshold the map does not move at all, so a click that
    // wobbles by a pixel still places a point exactly where it was pressed.
    if (press && !press.moved) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_SLOP) return;
        press.moved = true;
        lastX = press.x;
        lastY = press.y;
    }

    view.panX += e.clientX - lastX;
    view.panY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (currentMission) draw(currentMission);
});

window.addEventListener('mouseup', () => {
    dragging = false;

    if (press) {
        const p = press;
        press = null;
        if (!p.moved) placeAtPress(p);
    }

    if (dragWaypoint) {
        dragWaypoint = null;
        if (currentMission) draw(currentMission);
    }
});
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.style.borderColor = '#3d4a55';

  const file = e.dataTransfer.files[0];
  const text = await file.text();

  const mission = JSON.parse(text);

  // Order matters here. Affiliation depends on myFaction, and the tree is built
  // from affiliations - so the faction has to be settled before anything is
  // counted or drawn.
  myFaction      = mission.factions[0].factionName;
  currentMission = mission;
  populateFactions(mission);

  // A new mission starts with everything visible. Without this, layers hidden
  // in the previous mission would stay hidden in this one.
  hiddenPaths.clear();

  // Everything below affiliation starts collapsed, so a large mission opens as
  // two rows, Hostile and Friendly. Each tree keeps its own collapse set, so
  // expanding a branch in one does not expand it in the other.
  collapsedKeys.clear();
  ringCollapsed.clear();
  for (const u of unitsOf(mission)) {
      for (const keys of [collapsedKeys, ringCollapsed]) {
          keys.add(groupPath(u));
          keys.add(rolePath(u));
          keys.add(typePath(u));
      }
  }

  // A new mission means a new threat picture: forget which types were ringed,
  // and rebuild the list from what is actually out there.
  ringUnits.clear();

  setMap(mapName(mission.MapKey.Path));
  renderRingTree();

  out.textContent = `${file.name}

map:       ${mapName(mission.MapKey.Path)}
aircraft:  ${mission.aircraft.length}
vehicles:  ${mission.vehicles.length}
ships:     ${mission.ships.length}
buildings: ${mission.buildings.length}`;

  renderTree(unitsOf(mission));
  draw(mission);
});
