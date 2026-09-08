/* ---------------------------------------------------------------------------
   Reading units out of a mission and classifying them.

   Part 4 of 11 of the planner. These files are plain scripts sharing one
   global scope, loaded in the order listed in index.html - not ES modules - so
   a name declared in an earlier file is visible in every later one. Order is
   therefore significant: top-level code in one file can only use values already
   declared by the files above it.
   --------------------------------------------------------------------------- */

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
