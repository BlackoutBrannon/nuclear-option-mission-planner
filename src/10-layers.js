/* ---------------------------------------------------------------------------
   Factions, the layer tree, tree rendering, and draw().

   Part 10 of 11 of the planner. These files are plain scripts sharing one
   global scope, loaded in the order listed in index.html - not ES modules - so
   a name declared in an earlier file is visible in every later one. Order is
   therefore significant: top-level code in one file can only use values already
   declared by the files above it.
   --------------------------------------------------------------------------- */

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
