const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Global garment-location lookup (migrations/0041) — real SQL (sql.js), real db.js + orders.js admin
// API, the seeded default list, the delete-refused-while-referenced checks, and admin.js screen wiring.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { listLocations, saveLocation, deleteLocation, createBlank };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  console.log("=== Seed + db.js CRUD ===");
  let all = await lib.listLocations(d1);
  ok("migration seeds Front/Back/Left Chest/Right Chest in sort order",
    all.length === 4 && all.map(l => l.name).join(",") === "Front,Back,Left Chest,Right Chest");
  const newId = await lib.saveLocation(d1, { name: "Sleeve", sortOrder: 5, notes: "either sleeve" });
  ok("saveLocation creates when no id", d1.q("SELECT name n FROM locations WHERE id=?", newId)[0].n === "Sleeve");
  const sameId = await lib.saveLocation(d1, { id: newId, name: "Left Sleeve", sortOrder: 5 });
  ok("saveLocation updates in place when given an id (same row)", sameId === newId &&
    d1.q("SELECT name n FROM locations WHERE id=?", newId)[0].n === "Left Sleeve");
  ok("listLocations sorted by sortOrder,name", (await lib.listLocations(d1)).map(l => l.name).slice(-1)[0] === "Left Sleeve");
  await lib.deleteLocation(d1, newId);
  ok("deleteLocation removes an unreferenced row", !(await lib.listLocations(d1)).some(l => l.id === newId));

  console.log("\n=== Delete refused while referenced ===");
  const frontId = (await lib.listLocations(d1)).find(l => l.name === "Front").id;
  // (a) referenced by a configurable product's locationsJson
  d1._raw.run("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','PRIME','t','t')");
  d1._raw.run(`INSERT INTO products (productId, orgId, type, name, locationsJson, createdAt, updatedAt)
    VALUES ('tee','prime','shirt','Tee', ?, 't','t')`, [JSON.stringify([{ key: "loc" + frontId, label: "Front", locationId: frontId, graphicIds: [] }])]);
  let threwProduct = false;
  try { await lib.deleteLocation(d1, frontId); } catch (e) { threwProduct = true; }
  ok("deleting a location used by a product's design options is refused", threwProduct &&
    (await lib.listLocations(d1)).some(l => l.id === frontId));
  // (b) referenced by a blank color image tag
  const backId = (await lib.listLocations(d1)).find(l => l.name === "Back").id;
  await lib.createBlank(d1, { name: "Jerzees 1", productType: "shirt", colors: [
    { color: "Navy", images: [{ url: "https://x/img.jpg", locationId: backId }], sizes: [{ size: "L", purchasePrice: 3, quantity: 0 }] } ] });
  let threwBlank = false;
  try { await lib.deleteLocation(d1, backId); } catch (e) { threwBlank = true; }
  ok("deleting a location that tags a blank color image is refused", threwBlank);
  // Left Chest is referenced by nothing → deletes fine.
  const lcId = (await lib.listLocations(d1)).find(l => l.name === "Left Chest").id;
  await lib.deleteLocation(d1, lcId);
  ok("an unreferenced location still deletes", !(await lib.listLocations(d1)).some(l => l.id === lcId));

  console.log("\n=== Real admin API ===");
  let r = await call({ action: "listLocations" });
  ok("listLocations action returns the catalog", r.status === 200 && Array.isArray(r.body.locations));
  r = await call({ action: "saveLocation", location: { name: "" } });
  ok("name required", r.status === 400 && /required/i.test(r.body.message));
  r = await call({ action: "saveLocation", location: { name: "Yoke", sortOrder: 9 } });
  ok("valid location created via the API", r.status === 200 && !!r.body.id);
  const yokeId = r.body.id;
  r = await call({ action: "saveLocation", location: { id: yokeId, name: "Yoke (edited)", sortOrder: 9 } });
  ok("existing location updated via the API", r.status === 200 && r.body.id === yokeId &&
    (await lib.listLocations(d1)).find(l => l.id === yokeId).name === "Yoke (edited)");
  r = await call({ action: "deleteLocation", id: 999999 });
  ok("deleting a nonexistent location is a harmless no-op", r.status === 200);
  r = await call({ action: "deleteLocation", id: frontId });
  ok("the API surfaces the reference-check refusal as a 400", r.status === 400 && /product/i.test(r.body.message));
  r = await call({ action: "deleteLocation", id: yokeId });
  ok("deleting an unused location via the API succeeds", r.status === 200 && !(await lib.listLocations(d1)).some(l => l.id === yokeId));

  console.log("\n=== Screen wiring ===");
  const adminJs = read("public/admin.js");
  ok("Decoration locations is in the admin nav and routed",
    /\["locations", "Decoration locations"\]/.test(adminJs) && /renderLocationsCatalog\(app\)/.test(adminJs));
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  ok("renderLocationsCatalog + form modal exist as callable globals",
    typeof w.renderLocationsCatalog === "function" && typeof w.showLocationFormModal_ === "function");
  ok("save/delete location actions wired in the screen",
    /action: "saveLocation"/.test(adminJs) && /action: "deleteLocation"/.test(adminJs));
  ok("blank modal tags each color image with a location select + product form picks locations from the lookup",
    /data-img-loc/.test(adminJs) && /listLocations/.test(adminJs) && /class="cfgLocPick"/.test(adminJs));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
