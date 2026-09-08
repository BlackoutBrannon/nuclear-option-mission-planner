/* ---------------------------------------------------------------------------
   Hover, status bar, menus, panel rendering, pointer input.

   Part 11 of 11 of the planner. These files are plain scripts sharing one
   global scope, loaded in the order listed in index.html - not ES modules - so
   a name declared in an earlier file is visible in every later one. Order is
   therefore significant: top-level code in one file can only use values already
   declared by the files above it.
   --------------------------------------------------------------------------- */

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
const stElev = document.getElementById('stElev');
const stLine = document.getElementById('stLine');

function updateStatus(sx, sy) {
    if (!currentMap) return;
    const w = toWorld(sx, sy);

    stPos.textContent  = Math.round(w.x) + ', ' + Math.round(w.z);
    stBull.textContent = bullseye ? 'BE ' + fmtBullseye(w) : '';

    // Ground elevation sampled from the captured terrain, and the height the
    // selected altitude would put you above it. AGL is what matters flying low,
    // and it is not derivable from the MSL figure in the bar without knowing
    // what the ground is doing underneath.
    if (terrain) {
        const gnd = terrainAt(w.x, w.z);
        stElev.textContent = 'GND ' + fmtAlt(gnd) +
                             '   AGL ' + fmtAlt(ownAltM - gnd);
    } else {
        stElev.textContent = '';
    }

    // The pending leg while routing, or the sight line while probing. Both
    // describe the segment the pointer is currently defining.
    stLine.textContent = pendingLegText();

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

// Writes one leg's text into an existing span. Separated from renderWaypoints
// so the labels can be refreshed without rebuilding the rows: rebuilding while
// an altitude box is being typed into would destroy that box and take the
// focus and caret with it.
function applyLegText(leg, f, i) {
    leg.style.color = '';               // cleared, or a stale colour persists

    if (i === 0) { leg.textContent = 'start'; return; }

    const br = bearingRange(f.waypoints[i - 1], f.waypoints[i]);
    let text = fmtBearing(br.bearing) + '  ' + fmtRange(br.range);

    // How much of this leg is threatened, in the same units as the leg itself,
    // so the two numbers can be read against each other.
    const legs = (showExposure && ringUnits.size) ? flightExposure(f) : null;
    const t = legs && legs[i - 1] && legs[i - 1].tally;
    if (t && (t.engaged > 1 || t.detected > 1 || t.terrain > 1)) {
        const bits = [];
        if (t.terrain  > 1) bits.push(fmtRange(t.terrain) + ' BELOW GROUND');
        if (t.engaged  > 1) bits.push(fmtRange(t.engaged) + ' engaged');
        if (t.detected > 1) bits.push(fmtRange(t.detected) + ' seen');
        text += '   ' + bits.join(', ');
        leg.style.color = t.terrain > 1 ? '#ff5c52'
                        : t.engaged > 1 ? '#f0857a' : '#ffd166';
    }
    leg.textContent = text;
}

// Every leg is refreshed, not just the one edited: a waypoint's altitude sets
// the exposure of the leg into it and the leg out of it.
function refreshLegLabels() {
    const f = flights[activeFlight];
    if (!f) return;
    waypointListEl.querySelectorAll('.wpRow .leg')
        .forEach((leg, i) => applyLegText(leg, f, i));
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
        applyLegText(leg, f, i);

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
            refreshLegLabels();          // in place, so this box keeps focus
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

document.getElementById('flightExposure').addEventListener('change', (e) => {
    showExposure = e.target.checked;
    renderFlights();
    if (currentMission) draw(currentMission);
});

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
            ...(terrain ? [{ label: 'Coverage ring from here (terrain clipped)',
              run: () => startMeasure(at, 'circle', null, true) }] : []),
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

// ---------------------------------------------------------------------------
// Start-up
//
// Last, deliberately: these fetches call back into code declared across every
// part above, and a continuation must never run before those parts exist.
// ---------------------------------------------------------------------------
loadCatalogue();
loadRanges();
