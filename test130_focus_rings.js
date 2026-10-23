// A focused text box's ring is drawn inside the box, so it never covers the label written right above
// it (a tester saw the old ring — white, 3px outside every control — cut into labels). The dark order
// panel keeps a white ring; its rule must be at least as specific as the general one, or the general
// rule's color wins there.
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/public/index.html", "utf8");
const css = html.slice(html.indexOf("<style"), html.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

// Each rule as { selectors: [...], body }.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selectors: m[1].split(",").map(s => s.trim()).filter(Boolean), body: m[2] }));
const ruleFor = (sel) => rules.find(r => r.selectors.includes(sel));
// Specificity as [ids, classes/attributes/pseudo-classes, elements]; :not(x) counts as x.
const specificity = (sel) => {
  const s = sel.replace(/:not\(([^)]*)\)/g, " $1");
  return [(s.match(/#[\w-]+/g) || []).length,
    (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length,
    (s.replace(/\[[^\]]+\]/g, "").match(/(^|[\s>+~])[a-z]+/g) || []).length];
};
const atLeast = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];

const TEXT = "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):focus-visible";
const general = ruleFor(TEXT), dark = ruleFor(".ticket " + TEXT);
ok("text boxes, pick lists and text areas have their own focus rule", general && ["select:focus-visible", "textarea:focus-visible"].every(s => general.selectors.includes(s)));
ok("…a ring drawn inside the box (negative offset), so a label right above it is never covered", general && /outline-offset:\s*-\d+px/.test(general.body));
ok("…in the shop's (or the admin's) color, not white on a light panel", general && /outline:\s*2px solid var\(--org-accent, var\(--accent\)\)/.test(general.body));
ok("checkboxes, radio buttons and buttons keep the ring outside", /:focus-visible\{outline:2px solid #fff; outline-offset:3px;\}/.test(css));
ok("the dark order panel's fields get a white ring", dark && /outline-color:\s*#fff/.test(dark.body));
ok("…and that rule is at least as specific as the general one, so its color wins", dark && atLeast(specificity(".ticket " + TEXT), specificity(TEXT)));

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
