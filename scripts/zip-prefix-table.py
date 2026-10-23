#!/usr/bin/env python3
"""Builds the 3-digit ZIP prefix -> state table used by zipStates() from USPS's own list.

  python3 scripts/zip-prefix-table.py /path/to/Zip_Locale_Detail.xlsx [--write]

The spreadsheet is "ZIP Locale Detail" from USPS PostalPro (https://postalpro.usps.com/ZIP_Locale_Detail),
which lists every ZIP Code with the state of the post office that serves it. For each 3-digit prefix this
collects every state that has at least one ZIP under it.

That is the POST OFFICE's state, which is not always the state written on the address: military mail
(APO/FPO/DPO) is handled at offices in NJ, FL and CA but addressed to AE / AA / AP, and a few towns get
their mail from an office across a state line. Those address states are added from ADDRESS_STATES below,
so the check never refuses them. The check this table feeds is deliberately lenient: a prefix accepts
every state listed for it. Without --write it prints the table and what
would change; with --write it replaces the ZIP3_STATES_ constant in functions/_lib/db.js and
public/index.html (the two copies must stay identical — a test checks). The spreadsheet itself is not
kept in the repository. Standard library only.
"""
import os, re, sys, zipfile, collections
import xml.etree.ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

# Address states the spreadsheet can't show (it has the serving post office's state). Added to the
# prefixes below when the prefix is in use.
ADDRESS_STATES = {
    # Military: Armed Forces Europe / Americas / Pacific.
    **{f"{p:03d}": ["AE"] for p in range(90, 100)}, "340": ["AA"], **{f"{p:03d}": ["AP"] for p in range(962, 967)},
    # Served from across a state line, or government ZIPs addressed to a neighbouring jurisdiction.
    "834": ["WY"],        # Alta, WY — served from Driggs, ID
    "739": ["TX"],        # Texhoma, TX — served from Oklahoma
    "201": ["DC"], "205": ["MD", "VA"],
}

def read_states(path):
    """{prefix: {state: number of ZIPs}} from every sheet's DELIVERY ZIPCODE (col D) / PHYSICAL STATE (col K)."""
    z = zipfile.ZipFile(path)
    shared = ["".join(t.text or "" for t in si.iter(NS + "t")) for si in ET.parse(z.open("xl/sharedStrings.xml")).getroot().findall(NS + "si")]
    out = collections.defaultdict(collections.Counter)
    seen = set()
    for name in sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n)):
        for _, el in ET.iterparse(z.open(name)):
            if el.tag != NS + "row": continue
            cells = {}
            for c in el.findall(NS + "c"):
                v = c.find(NS + "v")
                if v is not None: cells[re.match(r"[A-Z]+", c.get("r")).group(0)] = (shared[int(v.text)] if c.get("t") == "s" else v.text or "").strip()
            el.clear()
            zip5, state = cells.get("D", ""), cells.get("K", "").upper()
            if not re.fullmatch(r"\d{5}", zip5) or not re.fullmatch(r"[A-Z]{2}", state): continue
            if (zip5, state) in seen: continue
            seen.add((zip5, state)); out[zip5[:3]][state] += 1
    for prefix, extra in ADDRESS_STATES.items():
        if prefix in out:
            for st in extra: out[prefix].setdefault(st, 0)
    return out, len({z5 for z5, _ in seen})

def to_table(states):
    """Compact text: the main state of each prefix as ranges, then one entry per extra state."""
    main = {p: c.most_common(1)[0][0] for p, c in states.items()}
    parts = []            # (sort key, text)
    run = None
    for p in sorted(main):
        if run and run[2] == main[p] and int(p) == int(run[1]) + 1: run[1] = p
        else:
            if run: parts.append((run[0], 0, (run[0] if run[0] == run[1] else run[0] + "-" + run[1]) + ":" + run[2]))
            run = [p, p, main[p]]
    if run: parts.append((run[0], 0, (run[0] if run[0] == run[1] else run[0] + "-" + run[1]) + ":" + run[2]))
    for p in sorted(states):
        for st in sorted(s for s in states[p] if s != main[p]): parts.append((p, 1, p + ":" + st))
    return " ".join(t for _, _, t in sorted(parts))

def parse_table(text):
    m = collections.defaultdict(set)
    for part in text.split():
        rng, st = part.split(":"); a, _, b = rng.partition("-")
        for i in range(int(a), int(b or a) + 1): m[f"{i:03d}"].add(st)
    return m

def js_constant(table, width=118):
    lines, cur = [], ""
    for part in table.split(" "):
        if cur and len(cur) + 1 + len(part) > width: lines.append(cur + " "); cur = part
        else: cur = (cur + " " + part) if cur else part
    lines.append(cur)
    return 'const ZIP3_STATES_ = ' + "\n  + ".join('"' + l + '"' for l in lines) + ";"

CONST_RE = re.compile(r'const ZIP3_STATES_ = (?:"[^"]*"\s*\+?\s*)+;')

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args: sys.exit(__doc__)
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
    states, nzip = read_states(args[0])
    table = to_table(states)
    print(f"{nzip} ZIP Codes, {len(states)} prefixes in use")
    files = [os.path.join(root, "functions", "_lib", "db.js"), os.path.join(root, "public", "index.html")]
    try:
        src = open(files[0]).read(); old = CONST_RE.search(src).group(0)
        old_map = parse_table(" ".join(re.findall(r'"([^"]*)"', old)).replace("  ", " "))
        new_map = parse_table(table)
        for p in sorted(set(old_map) | set(new_map)):
            if old_map.get(p, set()) != new_map.get(p, set()):
                detail = ", ".join(f"{s} {n}" for s, n in states.get(p, collections.Counter()).most_common())
                print(f"  {p}: {' '.join(sorted(old_map.get(p, [])) ) or '(none)':10s} -> {' '.join(sorted(new_map.get(p, []))) or '(none)':14s} [{detail}]")
    except Exception as e:
        print("(could not compare with the current table:", e, ")")
    print(); print(js_constant(table))
    if "--write" in sys.argv:
        for f in files:
            s = open(f).read()
            if not CONST_RE.search(s): sys.exit("ZIP3_STATES_ not found in " + f)
            open(f, "w").write(CONST_RE.sub(lambda _: js_constant(table), s, count=1))
        print("\nwrote", ", ".join(os.path.relpath(f, root) for f in files))
