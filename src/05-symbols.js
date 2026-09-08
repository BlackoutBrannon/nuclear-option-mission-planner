/* ---------------------------------------------------------------------------
   MIL-STD-2525 symbology and the bullseye rose.

   Part 5 of 11 of the planner. These files are plain scripts sharing one
   global scope, loaded in the order listed in index.html - not ES modules - so
   a name declared in an earlier file is visible in every later one. Order is
   therefore significant: top-level code in one file can only use values already
   declared by the files above it.
   --------------------------------------------------------------------------- */

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
