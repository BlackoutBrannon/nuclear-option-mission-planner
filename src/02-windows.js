/* ---------------------------------------------------------------------------
   The floating window factory and the three windows.

   Part 2 of 11 of the planner. These files are plain scripts sharing one
   global scope, loaded in the order listed in index.html - not ES modules - so
   a name declared in an earlier file is visible in every later one. Order is
   therefore significant: top-level code in one file can only use values already
   declared by the files above it.
   --------------------------------------------------------------------------- */

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
