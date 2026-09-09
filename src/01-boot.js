/* ---------------------------------------------------------------------------
   Unit catalogue and threat data, map registry, canvas.

   Part 1 of 11 of the planner. These files are plain scripts sharing one
   global scope, loaded in the order listed in index.html - not ES modules - so
   a name declared in an earlier file is visible in every later one. Order is
   therefore significant: top-level code in one file can only use values already
   declared by the files above it.
   --------------------------------------------------------------------------- */

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

// Both are STARTED from the last part rather than here. They are async, and a
// fetch that resolves quickly - a warm cache, a local server - runs its
// continuation as soon as this file finishes, before the later parts have
// executed. The continuation calls into those parts, so starting the loads here
// intermittently threw "renderRingTree is not defined". Kicking them off once
// every part is loaded removes the race rather than making it rarer.


// Terrain prefab name -> key in MAPS, or null for anything unrecognised.
//
// Returning null rather than defaulting to Heartland is the point. A map the
// planner has no imagery or extents for would otherwise draw every unit at a
// confidently wrong position on the wrong terrain - which reads as working, and
// is worse than refusing.
function mapName(path) {
    if (path === 'Terrain_naval') return 'Ignus Archipelago';
    if (path === 'Terrain1')      return 'Heartland';
    return null;
}

// What a mission has to have before anything else can run. Returns a message to
// put in front of whoever dropped the file, or null when it is usable.
//
// The checks are separate rather than one catch-all because the responses
// differ: "this is not a mission file" and "this mission is on a map the
// planner does not have" are different problems for the person holding it.
function missionProblem(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
        return 'That file is not a mission - the JSON is not an object.';
    }
    if (!m.MapKey || !m.MapKey.Path) {
        return 'That file has no MapKey, so it is not a Nuclear Option ' +
               'mission save.';
    }
    if (!mapName(m.MapKey.Path)) {
        return 'This mission is on "' + m.MapKey.Path + '". The planner only ' +
               'has terrain and imagery for Heartland and Ignus.';
    }
    const populated = ['aircraft', 'vehicles', 'ships', 'buildings']
        .some(k => Array.isArray(m[k]) && m[k].length);
    if (!populated) {
        return 'That mission has no aircraft, vehicles, ships or buildings ' +
               'in it.';
    }
    return null;
}

// Some scanner builds write a faction on every unit but no factions list.
// That is recoverable rather than fatal: the list is the distinct factions in
// first-seen order, which is the order they are written in anyway.
function repairMission(m) {
    if (Array.isArray(m.factions) && m.factions.length) return;

    const seen = [];
    for (const key of ['buildings', 'vehicles', 'ships', 'aircraft']) {
        for (const u of m[key] || []) {
            if (u.faction && seen.indexOf(u.faction) === -1) seen.push(u.faction);
        }
    }
    m.factions = seen.map(name => ({ factionName: name }));
}

const canvas = document.getElementById('map');
// Not const: exporting an image points this at an offscreen context for one
// draw and puts it back. canvas itself never moves - every label placer culls
// against its size, and an export wants the same framing, only larger.
let ctx = canvas.getContext('2d')

const MAPS = {
    'Heartland': {
        image: 'Heartland_overview.webp',
        terrain: 'Heartland',
        minX: -40960,   maxX: 40960,
        minZ: -40960,   maxZ: 40960
    },
    'Ignus Archipelago': {
        image: 'Ignus_overview.webp',
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
