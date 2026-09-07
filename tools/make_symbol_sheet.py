"""
Generate symbols.html - a contact sheet of every unit type and the symbol it
draws, for reviewing the symbology away from a cluttered map.

Reads the tables out of app.js rather than restating them, so the sheet can
never disagree with what the planner actually renders. Re-run after changing
TYPE_SIDC, ROLE_SIDC, ROLE_OVERRIDES or ROLE_RULES.

    python make_symbol_sheet.py      # writes ../symbols.html

Symbols are rendered in the browser by milsymbol, the same library and the same
SIDC strings the planner uses - so what you see here is what the map draws.
"""

import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
APP   = os.path.join(ROOT, "app.js")
UNITS = os.path.join(ROOT, "units.json")
OUT   = os.path.join(ROOT, "symbols.html")


def block(src, name, opener="{", closer="};"):
    """The body of a top-level `const NAME = { ... };` declaration."""
    pattern = (r"const " + re.escape(name) + r"\s*=\s*" + re.escape(opener) +
               r"(.*?)\n" + re.escape(closer))
    m = re.search(pattern, src, re.S)
    if not m:
        sys.exit(f"could not find {name} in app.js")
    return m.group(1)


def parse_sidc_table(src, name):
    return dict(re.findall(r"'([^']+)':\s*'([A-Z0-9-]{15})'", block(src, name)))


def parse_role_tables(src):
    overrides = dict(re.findall(r"([A-Za-z0-9_]+)\s*:\s*'([\w ]+/[\w -]+)'",
                                block(src, "ROLE_OVERRIDES")))
    rules = [(re.compile(p, re.I), v)
             for p, v in re.findall(r"\[/([^/]+)/i,\s*'([^']+)'\]",
                                    block(src, "ROLE_RULES", "[", "];"))]
    return overrides, rules


FALLBACK_GROUP = {"aircraft": "Air", "ships": "Naval",
                  "buildings": "Structure", "vehicles": "Ground"}


def main():
    src = open(APP, encoding="utf-8").read()
    cat = json.load(open(UNITS, encoding="utf-8"))

    type_sidc = parse_sidc_table(src, "TYPE_SIDC")
    role_sidc = parse_sidc_table(src, "ROLE_SIDC")
    overrides, rules = parse_role_tables(src)
    default = re.search(r"const DEFAULT_SIDC = '([A-Z0-9-]{15})'", src).group(1)

    rows = []
    for key in sorted(cat):
        entry = cat[key]
        cate  = entry["category"]

        # Same precedence the app uses: explicit override, then pattern, then
        # a fallback derived from the collection the unit came from.
        path = overrides.get(key)
        if not path:
            for pattern, value in rules:
                if pattern.search(key):
                    path = value
                    break
        if not path:
            path = FALLBACK_GROUP.get(cate, "Ground") + "/Other"
        group, role = path.split("/")

        if key in type_sidc:
            sidc, source = type_sidc[key], "type"
        elif f"{group}/{role}" in role_sidc:
            sidc, source = role_sidc[f"{group}/{role}"], "role"
        else:
            sidc, source = default, "DEFAULT"

        rows.append({
            "key": key, "name": entry["name"], "group": group, "role": role,
            "sidc": sidc, "source": source,
            "unresolved": bool(entry.get("unresolved")),
        })

    html = PAGE.replace("__ROWS__", json.dumps(rows, indent=0))
    open(OUT, "w", encoding="utf-8").write(html)

    by_source = {}
    for r in rows:
        by_source[r["source"]] = by_source.get(r["source"], 0) + 1
    print(f"{len(rows)} unit types")
    for k, v in sorted(by_source.items()):
        print(f"   {v:3d} from {k}")
    print(f"\nwrote {OUT}")
    print("open http://localhost:8000/symbols.html")


PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Symbology sheet</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 28px 60px;
    font-family: system-ui, sans-serif;
    background: #12181d; color: #e6edf3;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #7d8b96; font-size: 13px; margin-bottom: 22px; }
  .sub b { color: #b8c5d0; font-weight: 600; }

  h2 {
    font-size: 12px; letter-spacing: .1em; text-transform: uppercase;
    color: #8ecbff; margin: 26px 0 8px;
    border-bottom: 1px solid #2a353d; padding-bottom: 5px;
  }
  h3 { font-size: 13px; color: #b8c5d0; margin: 16px 0 6px; font-weight: 600; }

  table { border-collapse: collapse; width: 100%; max-width: 1000px; }
  td { padding: 5px 10px; border-bottom: 1px solid #1e272e; vertical-align: middle; }
  td.sym { width: 54px; text-align: center; }
  td.sym svg { width: 40px; height: 40px; vertical-align: middle; }
  td.name { font-size: 13px; }
  td.key, td.code {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 11px; color: #6f7d88; white-space: nowrap;
  }
  td.src { width: 60px; font-size: 10px; text-transform: uppercase;
           letter-spacing: .06em; color: #6f7d88; }
  .role  { color: #8a9aa6; }
  .guess { color: #d69a3c; }
  thead td { color: #6f7d88; font-size: 10px; text-transform: uppercase;
             letter-spacing: .08em; border-bottom: 1px solid #2a353d; }
</style>
</head>
<body>
  <h1>Symbology sheet</h1>
  <div class="sub">
    Every unit type, drawn with the same SIDC the planner uses.
    <b>Hostile</b> and <b>friendly</b> shown side by side so frame errors are visible.
    <span class="role">ROLE</span> in the source column means it fell back to the
    role symbol rather than having one of its own.
    <span class="guess">Amber</span> names were never resolved from the game files.
  </div>
  <div id="out"></div>

<script src="vendor/milsymbol.js"></script>
<script>
const ROWS = __ROWS__;

function sym(template, aff) {
  const sidc = template[0] + aff + template.slice(2);
  try { return new ms.Symbol(sidc, { size: 28, strokeWidth: 5 }).asSVG(); }
  catch (e) { return '<span style="color:#e2796f">bad</span>'; }
}

const groups = {};
for (const r of ROWS) {
  groups[r.group] = groups[r.group] || {};
  (groups[r.group][r.role] = groups[r.group][r.role] || []).push(r);
}

let html = '';
for (const g of Object.keys(groups).sort()) {
  html += '<h2>' + g + '</h2>';
  for (const role of Object.keys(groups[g]).sort()) {
    html += '<h3>' + role + '</h3><table><thead><tr>' +
            '<td>Hostile</td><td>Friend</td><td>Name</td>' +
            '<td>Type key</td><td>SIDC</td><td>Source</td></tr></thead><tbody>';
    for (const r of groups[g][role]) {
      html += '<tr>' +
        '<td class="sym">' + sym(r.sidc, 'H') + '</td>' +
        '<td class="sym">' + sym(r.sidc, 'F') + '</td>' +
        '<td class="name' + (r.unresolved ? ' guess' : '') + '">' + r.name + '</td>' +
        '<td class="key">' + r.key + '</td>' +
        '<td class="code">' + r.sidc + '</td>' +
        '<td class="src' + (r.source === 'role' ? ' role' : '') + '">' + r.source + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
  }
}
document.getElementById('out').innerHTML = html;
</script>
</body>
</html>
"""

if __name__ == "__main__":
    main()
