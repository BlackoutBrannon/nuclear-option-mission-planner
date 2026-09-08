/* ---------------------------------------------------------------------------
   Manual range rings and the measuring tool.

   Part 9 of 11 of the planner. These files are plain scripts sharing one
   global scope, loaded in the order listed in index.html - not ES modules - so
   a name declared in an earlier file is visible in every later one. Order is
   therefore significant: top-level code in one file can only use values already
   declared by the files above it.
   --------------------------------------------------------------------------- */

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
