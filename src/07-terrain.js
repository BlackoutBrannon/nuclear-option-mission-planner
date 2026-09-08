/* ---------------------------------------------------------------------------
   Elevation, line-of-sight masking, ring labels and hit tests.

   Part 7 of 11 of the planner. These files are plain scripts sharing one
   global scope, loaded in the order listed in index.html - not ES modules - so
   a name declared in an earlier file is visible in every later one. Order is
   therefore significant: top-level code in one file can only use values already
   declared by the files above it.
   --------------------------------------------------------------------------- */

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

// Distance along one radial at which an aircraft at `alt` passes behind
// terrain, or maxR if it never does.
//
// The altitude is a parameter rather than read from the bar, because a route
// leg is evaluated at its own altitude, which is not the one on screen.
//
// Compares ANGLES, not heights: a low ridge close in blocks more sky than a
// tall peak far out. The running maximum of terrain angle only rises with
// distance while the aircraft's angle only falls, so the two cross exactly
// once - one cutoff per radial, and the walk can stop there.
function maskedDistance(ox, oz, obsH, bearing, maxR, alt) {
    const sin = Math.sin(bearing), cos = Math.cos(bearing);
    let maxAngle = -Infinity;

    for (let d = MASK_STEP; d <= maxR; d += MASK_STEP) {
        // Tested against terrain strictly closer than d, so a sample does not
        // block the aircraft sitting on top of it.
        if ((alt - obsH) / d < maxAngle) return d - MASK_STEP;

        const h = terrainAt(ox + sin * d, oz + cos * d);
        const angle = (h - obsH) / d;
        if (angle > maxAngle) maxAngle = angle;
    }
    return maxR;
}

// Profiles are keyed by unit, altitude and radius. Panning and zooming reuse
// them; changing altitude does not, since every angle depends on it.
const maskCache = new Map();

// Altitudes are bucketed before they reach the cache. A climbing leg passes
// through a continuum of altitudes, and keying on each one exactly would mean a
// fresh profile - some milliseconds of ray walking - for every sample along it.
const MASK_ALT_BUCKET = 250;   // metres

function maskProfileFor(unit, maxR, alt) {
    const a = Math.round((alt === undefined ? ownAltM : alt) / MASK_ALT_BUCKET)
              * MASK_ALT_BUCKET;
    const key = unitPath(unit) + '|' + a + '|' + Math.round(maxR / 500);
    let profile = maskCache.get(key);
    if (profile) return profile;

    const obsH = terrainAt(unit.x, unit.z) + MAST_HEIGHT;
    profile = new Float32Array(MASK_RADIALS);
    for (let i = 0; i < MASK_RADIALS; i++) {
        profile[i] = maskedDistance(unit.x, unit.z, obsH,
                                    i * 2 * Math.PI / MASK_RADIALS, maxR, a);
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
