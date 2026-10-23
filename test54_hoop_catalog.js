const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Production run management: the global hoop catalog (migrations/0022) — real SQL
// (sql.js), real db.js + orders.js admin API, plus the admin.js screen wiring.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { listHoops, createHoop, updateHoop, deleteHoop };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  console.log("=== db.js: create/update/list/delete ===");
  const id1 = await lib.createHoop(d1, { name: "4in Round", widthMm: "100", heightMm: "100", isCapFrame: false, notes: "small logo", sortOrder: 1 });
  console.log("created:", d1.q("SELECT name n FROM hoops WHERE id=?", id1)[0].n === "4in Round");
  await lib.updateHoop(d1, id1, { name: "4in Round (renamed)", widthMm: "100", heightMm: "100", isCapFrame: false, notes: "small logo", sortOrder: 1 });
  console.log("updated:", d1.q("SELECT name n FROM hoops WHERE id=?", id1)[0].n === "4in Round (renamed)");
  const id2 = await lib.createHoop(d1, { name: "Cap Frame", widthMm: "130", heightMm: "60", isCapFrame: true, notes: "", sortOrder: 0 });
  let all = await lib.listHoops(d1);
  console.log("listHoops sorted by sortOrder,name:", all.length === 2 && all[0].id === id2 && all[1].id === id1);
  console.log("isCapFrame round-trips as boolean:", all[0].isCapFrame === true && all[1].isCapFrame === false);
  await lib.deleteHoop(d1, id2);
  console.log("deleted:", (await lib.listHoops(d1)).length === 1);

  console.log("\n=== Real admin API ===");
  let r = await call({ action: "listHoops" });
  console.log("listHoops action:", r.status === 200 && r.body.hoops.length === 1);
  r = await call({ action: "saveHoop", hoop: { name: "" } });
  console.log("name required:", r.status === 400 && /required/.test(r.body.message));
  r = await call({ action: "saveHoop", hoop: { name: "6in Oval", widthMm: "150", heightMm: "90", isCapFrame: false, notes: "", sortOrder: 2 } });
  console.log("valid hoop created via the API:", r.status === 200 && !!r.body.id);
  const ovalId = r.body.id;
  r = await call({ action: "saveHoop", hoop: { id: ovalId, name: "6in Oval (edited)", widthMm: "150", heightMm: "90", isCapFrame: false, notes: "note", sortOrder: 2 } });
  console.log("existing hoop updated via the API:", r.status === 200 && r.body.id === ovalId);
  r = await call({ action: "listHoops" });
  console.log("update reflected:", r.body.hoops.find(h => h.id === ovalId).name === "6in Oval (edited)");
  r = await call({ action: "deleteHoop", id: 999999 });
  console.log("deleting a nonexistent hoop is a harmless no-op, not a crash:", r.status === 200);
  const delReal = await call({ action: "deleteHoop", id: ovalId });
  console.log("deleting a real, unused hoop succeeds (no design/machine tables yet — reference checks no-op safely) and it's gone:",
    delReal.status === 200 && !(await lib.listHoops(d1)).some(h => h.id === ovalId));

  console.log("\n=== Screen wiring ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();

  console.log("Hoops is in the persistent admin header and routed:", /\["hoops", "Hoops"\]/.test(adminJs) && /renderHoopCatalog\(app\)/.test(adminJs));
  console.log("renderHoopCatalog and the form modal exist as callable globals:", typeof w.renderHoopCatalog === "function" && typeof w.showHoopFormModal_ === "function");
  console.log("New-hoop button + save action exist:", /id="hpNewBtn"/.test(adminJs) && /action: "saveHoop"/.test(adminJs) && /action: "deleteHoop"/.test(adminJs));
})();
