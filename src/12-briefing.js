// ---------------------------------------------------------------------------
// 12 - Briefing sheet
//
// Plain scripts in one global scope; see 01-boot.js. This part is last because
// it reads from every other one and nothing reads from it.
//
// Turns the current plan into a printable page: the same numbers the panels
// show, laid out to be read away from the screen. It is generated fresh on
// every click rather than kept in sync, so it can never disagree with the map.
//
// The sheet prints on white. The planner is dark because it sits under a map;
// a briefing sheet ends up on paper or on a kneeboard, where a dark background
// is wasted ink and worse contrast.
//
// Threat states are named in words and carry their own glyph. Colour is a
// third cue here, never the only one, and it disappears entirely on a mono
// printer - which is most of them.
// ---------------------------------------------------------------------------

// Names come from the user - a flight called "A & B", or a unit type with an
// angle bracket in it, would otherwise break the markup.
function esc(s) {
    return String(s === undefined || s === null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A bullseye call where there is a bullseye, otherwise the raw grid position.
// A blank position column would make the sheet useless.
function briefPos(p) {
    if (bullseye) return fmtBullseye(p);
    return Math.round(p.x) + ', ' + Math.round(p.z);
}

// Word plus glyph. The glyph shapes differ from one another, so the states stay
// distinguishable in monochrome and to a colourblind reader.
const BRIEF_STATE = {
    terrain:  { glyph: '▲', word: 'BELOW GROUND', cls: 'st-terrain' },
    engaged:  { glyph: '■', word: 'ENGAGED',      cls: 'st-engaged' },
    detected: { glyph: '▧', word: 'SEEN',         cls: 'st-detected' },
};

// The threat on one leg, as text. Mirrors the leg labels in the flight panel,
// so the sheet and the screen never read differently.
function briefLegThreat(f, i) {
    if (!ringUnits.size) return '<span class="quiet">no rings set</span>';
    const legs = flightExposure(f);
    const t = legs[i - 1] && legs[i - 1].tally;
    if (!t) return '<span class="quiet">&mdash;</span>';

    const bits = [];
    for (const key of ['terrain', 'engaged', 'detected']) {
        if (t[key] > 1) {
            const s = BRIEF_STATE[key];
            bits.push('<span class="' + s.cls + '">' + s.glyph + ' ' +
                      esc(fmtRange(t[key])) + ' ' + s.word + '</span>');
        }
    }
    return bits.length ? bits.join('<br>') : '<span class="clear">clear</span>';
}

// One flight: the route table, then a block for each release point on it.
function briefFlight(f) {
    const speed = f.speed || 250;
    let cum = 0;

    let rows = '';
    f.waypoints.forEach((w, i) => {
        const prev = i > 0 ? f.waypoints[i - 1] : null;
        const br   = prev ? bearingRange(prev, w) : null;
        if (br) cum += br.range;

        rows +=
            '<tr>' +
            '<td class="num">' + (i + 1) + '</td>' +
            '<td>' + (w.rp ? '<strong>RP</strong>' : 'WP') + '</td>' +
            '<td>' + esc(briefPos(w)) + '</td>' +
            '<td class="num">' + esc(fmtAlt(w.alt)) + '</td>' +
            '<td class="num">' + (br ? esc(fmtBearing(br.bearing)) : '&mdash;') + '</td>' +
            '<td class="num">' + (br ? esc(fmtRange(br.range)) : '&mdash;') + '</td>' +
            '<td class="num">' + esc(fmtRange(cum)) + '</td>' +
            '<td class="num">' + esc(fmtTime(cum / speed)) + '</td>' +
            '<td>' + (br ? briefLegThreat(f, i)
                         : '<span class="quiet">&mdash;</span>') + '</td>' +
            '</tr>';
    });

    let blocks = '';
    f.waypoints.forEach((w, i) => { if (w.rp) blocks += briefRelease(f, i, w); });

    return '<section class="flight">' +
        '<h2>' + esc(f.name) + '</h2>' +
        '<p class="sub">Release speed ' + esc(fmtSpeed(speed)) +
            ' &middot; ' + f.waypoints.length + ' waypoints &middot; ' +
            esc(fmtRange(flightTotal(f))) + ' total &middot; ' +
            esc(fmtTime(flightTotal(f) / speed)) + ' en route</p>' +
        '<table>' +
        '<thead><tr><th>#</th><th>Type</th>' +
        '<th>' + (bullseye ? 'Bullseye' : 'Position') + '</th>' +
        '<th class="num">Alt</th><th class="num">Brg</th>' +
        '<th class="num">Leg</th><th class="num">Cum</th><th class="num">ETE</th>' +
        '<th>Threat on leg in</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>' +
        briefDetection(f) +
        blocks +
        '</section>';
}

// One release point: what is being shot, at what, and what happens to the
// weapon on the way in.
function briefRelease(f, i, w) {
    const mun  = w.munition ? (ranges.arsenal || {})[w.munition] : null;
    const sols = releaseSolutions(f, i);

    if (!w.munition) {
        return '<div class="rp"><h3>Release point &mdash; waypoint ' + (i + 1) +
               '</h3><p class="warn">No munition selected.</p></div>';
    }
    if (!sols.length) {
        return '<div class="rp"><h3>Release point &mdash; waypoint ' + (i + 1) +
               '</h3><p class="sub">' + esc(w.munition) +
               '</p><p class="warn">No targets assigned.</p></div>';
    }

    let rows = '';
    for (const s of sols) {
        const exp = munitionExposure(f, i, s.id);

        let tot = '<span class="warn">' +
                  esc(s.error || (s.sol ? s.sol.reason : 'no solution')) + '</span>';
        if (s.sol && s.sol.reach) tot = '<strong>' + esc(fmtTime(s.sol.time)) + '</strong>';

        // Distances here are how far the weapon still has to run when the event
        // happens. That is the number deciding whether it survives to impact,
        // not how far it has already flown.
        let threat = '<span class="quiet">&mdash;</span>';
        if (exp) {
            const bits = [];
            if (exp.shot) {
                bits.push('<span class="st-engaged">' + BRIEF_STATE.engaged.glyph +
                          ' engageable ' + esc(fmtRange(exp.shot.d)) + ' out' +
                          (exp.shot.by ? ' by ' + esc(exp.shot.by) : '') + '</span>');
            }
            if (exp.seen) {
                bits.push('<span class="st-detected">' + BRIEF_STATE.detected.glyph +
                          ' seen ' + esc(fmtRange(exp.seen.d)) + ' out</span>');
            }
            threat = bits.length ? bits.join('<br>')
                                 : '<span class="clear">unobserved</span>';
        }

        rows += '<tr>' +
            '<td>' + esc(s.name) + '</td>' +
            '<td class="num">' +
                (s.bearing !== undefined ? esc(fmtBearing(s.bearing)) : '&mdash;') + '</td>' +
            '<td class="num">' +
                (s.range !== undefined ? esc(fmtRange(s.range)) : '&mdash;') + '</td>' +
            '<td class="num">' + tot + '</td>' +
            '<td>' + threat + '</td>' +
            '</tr>';
    }

    const rcs = mun && mun.flight && mun.flight.rcs;
    return '<div class="rp">' +
        '<h3>Release point &mdash; waypoint ' + (i + 1) + '</h3>' +
        '<p class="sub">' + esc(w.munition) +
            ' &middot; released at ' + esc(fmtAlt(w.alt)) +
            ', ' + esc(fmtSpeed(f.speed || 250)) +
            (rcs ? ' &middot; weapon RCS ' + rcs : '') + '</p>' +
        '<table><thead><tr><th>Target</th><th class="num">Brg</th>' +
        '<th class="num">Range</th><th class="num">TOT</th>' +
        '<th>Weapon exposure</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>';
}

function briefTargets() {
    if (!targets.length) return '';

    let rows = '';
    targets.forEach((t, i) => {
        const p = targetPos(t);
        rows += '<tr>' +
            '<td class="num">' + (i + 1) + '</td>' +
            '<td>' + esc(t.name) + '</td>' +
            '<td>' + esc(t.kind) + '</td>' +
            '<td>' + (p ? esc(briefPos(p))
                        : '<span class="warn">not in this mission</span>') + '</td>' +
            '<td class="num">' +
                (p && terrain ? esc(fmtAlt(terrainAt(p.x, p.z))) : '&mdash;') + '</td>' +
            '</tr>';
    });

    return '<section><h2>Targets</h2><table><thead><tr><th>#</th><th>Name</th>' +
        '<th>Type</th><th>' + (bullseye ? 'Bullseye' : 'Position') + '</th>' +
        '<th class="num">Elev</th></tr></thead><tbody>' + rows +
        '</tbody></table></section>';
}

// ---------------------------------------------------------------------------
// Hostile detection along a route
//
// The question a briefing has to answer is not which radars exist, it is when
// they know you are there. So the route is walked end to end and only the
// TRANSITIONS are reported: the point where detection starts, and the point
// where it lapses. Losing detection and regaining it is two events, because
// each pickup is a fresh problem to solve.
//
// Hostile sensors only, and only whether they see. Friendly emitters are not a
// threat, and a full list of everything with line of sight is the inventory
// this replaced.
// ---------------------------------------------------------------------------
const DETECT_STEP = 500;      // metres between samples along the route

// Which hostile unit sees this point, if any. Kept separate from exposureAt
// rather than folded into it: that function runs thousands of times per frame
// and returns a bare string on purpose, while this one runs a handful of times
// per sheet and needs to name a unit.
function hostileDetectorAt(x, z, alt) {
    let best = null, count = 0;

    for (const u of unitsOf(currentMission)) {
        if (!ringUnits.has(unitPath(u))) continue;
        if (affiliationOf(u) !== 'hostile') continue;

        // Sensor rings only. A weapon envelope you have not been detected in
        // is not a detection.
        const rings = threatRingsFor(u, alt, undefined, true)
                          .filter(r => r.kind !== 'weapon');
        if (!rings.length) continue;

        const br = bearingRange({ x: u.x, z: u.z }, { x: x, z: z });
        const widest = rings.reduce((m, r) => Math.max(m, r.r), 0);
        if (br.range > widest) continue;

        let profile = null;
        if (showRings.mask && terrain) profile = maskProfileFor(u, widest, alt);

        for (const ring of rings) {
            const reach = (ring.los && profile)
                ? ringRadiusAt(ring, profile, br.bearing * Math.PI / 180)
                : ring.r;
            if (br.range > reach) continue;

            count++;
            // Of everything that can see this point, the one with the most
            // reach to spare is the one that got there first and the one you
            // would have to fly furthest to escape.
            const slack = reach - br.range;
            if (!best || slack > best.slack) {
                best = { slack: slack, name: unitName(u.type) };
            }
            break;                      // count units, not rings
        }
    }

    return best ? { name: best.name, others: count - 1 } : null;
}

// The whole route as one continuous line, so a detection that happens to span
// a waypoint is one event rather than two.
function detectionRuns(f) {
    if (f.waypoints.length < 2) return [];

    const runs = [];
    let cum = 0, open = null;

    for (let i = 1; i < f.waypoints.length; i++) {
        const a = f.waypoints[i - 1], b = f.waypoints[i];
        const dist  = bearingRange(a, b).range;
        const steps = Math.max(2, Math.ceil(dist / DETECT_STEP));

        // Legs after the first skip k=0: it is the previous leg's last sample.
        for (let k = (i === 1 ? 0 : 1); k <= steps; k++) {
            const t   = k / steps;
            const x   = a.x + (b.x - a.x) * t;
            const z   = a.z + (b.z - a.z) * t;
            const alt = a.alt + (b.alt - a.alt) * t;
            const at  = cum + dist * t;

            const who = hostileDetectorAt(x, z, alt);
            if (who && !open) {
                open = { at: at, x: x, z: z, by: who };
            } else if (!who && open) {
                open.until = at;
                runs.push(open);
                open = null;
            }
        }
        cum += dist;
    }

    if (open) { open.until = null; runs.push(open); }   // still held at the end
    return runs;
}

function briefDetection(f) {
    if (f.waypoints.length < 2) return '';      // no route, nothing to walk
    if (!ringUnits.size) {
        return '<h3>Hostile detection</h3>' +
               '<p class="warn">No threats ringed, so nothing was measured.</p>';
    }

    const runs  = detectionRuns(f);
    const speed = f.speed || 250;

    if (!runs.length) {
        return '<h3>Hostile detection</h3>' +
               '<p class="clear">Not detected at any point on this route.</p>';
    }

    let rows = '';
    runs.forEach((r, i) => {
        const held = (r.until === null ? flightTotal(f) : r.until) - r.at;
        rows += '<tr>' +
            '<td class="num">' + (i + 1) + '</td>' +
            '<td class="num">' + esc(fmtRange(r.at)) + '</td>' +
            '<td class="num">' + esc(fmtTime(r.at / speed)) + '</td>' +
            '<td>' + esc(briefPos({ x: r.x, z: r.z })) + '</td>' +
            '<td><span class="st-detected">' + BRIEF_STATE.detected.glyph + ' ' +
                esc(r.by.name) + '</span>' +
                (r.by.others > 0
                    ? ' <span class="quiet">+' + r.by.others + ' more</span>'
                    : '') + '</td>' +
            '<td class="num">' + (r.until === null
                    ? '<span class="warn">to end</span>'
                    : esc(fmtRange(r.until))) + '</td>' +
            '<td class="num">' + esc(fmtRange(held)) + '</td>' +
            '</tr>';
    });

    return '<h3>Hostile detection</h3>' +
        '<p class="sub">Each row is a fresh pickup. Detection lapsing and ' +
        'resuming counts twice, because each one is a separate problem.</p>' +
        '<table><thead><tr><th>#</th><th class="num">At</th>' +
        '<th class="num">ETE</th>' +
        '<th>' + (bullseye ? 'Bullseye' : 'Position') + '</th>' +
        '<th>First detected by</th><th class="num">Until</th>' +
        '<th class="num">Held for</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
}

// What the detection above was measured against. A sheet that does not say
// which threats were considered invites the reader to assume all of them were.
function briefBasis() {
    let hostile = 0;
    const types = new Set();
    for (const u of unitsOf(currentMission)) {
        if (!ringUnits.has(unitPath(u))) continue;
        if (affiliationOf(u) !== 'hostile') continue;
        hostile++;
        types.add(unitName(u.type));
    }

    if (!hostile) {
        return '<section><h2>Threat basis</h2>' +
               '<p class="warn">No hostile units are ringed. The detection ' +
               'above is not measured against anything.</p></section>';
    }

    return '<section><h2>Threat basis</h2><p class="sub">' +
        hostile + ' hostile units ringed across ' + types.size +
        ' types, against RCS ' + ownRCS + ' at ' + esc(fmtAlt(ownAltM)) +
        '. Terrain masking ' +
        (showRings.mask && terrain ? 'applied' : '<strong>not applied</strong>') +
        '. Friendly emitters are excluded; the threat column in the route ' +
        'table matches the map and counts every ringed unit.</p></section>';
}

const BRIEF_CSS = [
// Capped and centred. Left to fill a wide monitor the columns spread so far
// apart that the eye loses the row between the name and its numbers, which is
// the one thing a briefing table has to get right.
'  body { font: 12px/1.45 -apple-system, Segoe UI, Roboto, sans-serif;',
'         color: #111; background: #fff; margin: 0 auto; max-width: 1000px;',
'         padding: 24px 28px; }',
'  h1 { font-size: 19px; margin: 0 0 2px; letter-spacing: .3px; }',
'  h2 { font-size: 14px; margin: 22px 0 6px; padding-bottom: 3px;',
'       border-bottom: 2px solid #111; text-transform: uppercase;',
'       letter-spacing: .6px; }',
'  h3 { font-size: 12px; margin: 0 0 4px; text-transform: uppercase;',
'       letter-spacing: .5px; }',
'  p { margin: 0 0 6px; }',
'  .sub   { color: #555; font-size: 11px; }',
'  .quiet { color: #999; }',
'  .clear { color: #444; }',
'  .warn  { color: #a11; font-weight: 600; }',
'  table { border-collapse: collapse; width: 100%; margin: 4px 0 10px; }',
'  th { text-align: left; font-size: 10px; text-transform: uppercase;',
'       letter-spacing: .5px; color: #333; border-bottom: 1px solid #111;',
'       padding: 3px 6px; white-space: nowrap; }',
'  td { padding: 3px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }',
// Banding only helps the eye stay on a row; it never carries meaning. Browsers
// drop background fills when printing unless the user opts in, which is why
// every row also keeps its own rule underneath.
'  tbody tr:nth-child(even) { background: #f4f5f6; }',
'  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums;',
'       font-family: ui-monospace, Consolas, monospace; }',
'  .rp { margin: 8px 0 14px; padding: 8px 10px; border: 1px solid #bbb;',
'        border-left: 4px solid #111; background: #fafafa; }',
// Each state reads as a word first; the colour is only ever a third cue.
'  .st-terrain  { color: #a11; font-weight: 600; }',
'  .st-engaged  { color: #b34; }',
'  .st-detected { color: #86610a; }',
'  .toolbar { position: sticky; top: 0; background: #fff; padding: 0 0 12px;',
'             border-bottom: 1px solid #ddd; margin-bottom: 14px; }',
'  .toolbar button { font: inherit; padding: 5px 14px; cursor: pointer;',
'             border: 1px solid #888; border-radius: 3px; background: #f2f2f2; }',
'  @media print {',
'    body { padding: 0; font-size: 10.5px; }',
'    .toolbar { display: none; }',
'    section, .rp, tr { break-inside: avoid; }',
'    h2 { break-after: avoid; }',
'  }',
].join('\n');

function briefingHTML() {
    const when = new Date();
    const flightHTML = flights.length
        ? flights.map(briefFlight).join('')
        : '<section><h2>Flights</h2><p class="warn">No flights planned.</p></section>';

    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
        '<title>Briefing - ' + esc(currentMission._name || 'mission') + '</title>' +
        '<style>\n' + BRIEF_CSS + '\n</style></head><body>' +
        '<div class="toolbar"><button onclick="window.print()">Print</button></div>' +
        '<h1>Mission briefing</h1>' +
        '<p class="sub">' + esc(currentMission._name || '') +
            ' &middot; ' +
            esc(currentMap ? currentMap.image.replace(/_overview\.png$/, '') : '') +
            ' &middot; generated ' +
            esc(when.toISOString().slice(0, 16).replace('T', ' ')) + 'Z' +
            ' &middot; ' + (unitSystem === 'aviation' ? 'NM / ft / kt' : 'km / m / km/h') +
            (bullseye ? ' &middot; bullseye ' + Math.round(bullseye.x) + ', ' +
                        Math.round(bullseye.z)
                      : ' &middot; no bullseye set') +
        '</p>' +
        flightHTML + briefTargets() + briefBasis() +
        '</body></html>';
}

// Opened in a tab rather than downloaded: the point of the sheet is to be read
// and printed, and a tab does both without leaving a file behind. Ctrl-S in
// that tab still saves it.
//
// The URL is deliberately not revoked. Revoking frees a few kilobytes but
// breaks the tab as soon as anyone reloads it, and a briefing sheet is exactly
// the kind of page that stays open and gets reloaded.
function openBriefing() {
    const html = briefingHTML();
    const url  = URL.createObjectURL(new Blob([html], { type: 'text/html' }));

    // A pop-up blocker returns null. Rather than telling someone to go and
    // change a browser setting, hand them the same sheet as a file.
    const win = window.open(url, '_blank');
    if (!win) {
        const base = (currentMission._name || 'plan').replace(/\.json$/i, '');
        const a = document.createElement('a');
        a.href = url;
        a.download = base + '.briefing.html';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
    return html.length;
}

document.getElementById('planBrief').addEventListener('click', () => {
    if (!currentMission) return;
    openBriefing();
});

// ---------------------------------------------------------------------------
// Start-up
//
// Last, deliberately: these fetches call back into code declared across every
// part above, and a continuation must never run before those parts exist.
// ---------------------------------------------------------------------------
loadCatalogue();
loadRanges();
