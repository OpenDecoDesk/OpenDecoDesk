const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Production run management: the thread catalog (migrations/0021) — real SQL
// (sql.js), real db.js + orders.js admin API, plus parseHatchChart_ against a real
// Hatch .tch file (testlib/fixtures/sample-thread-chart.tch).

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { listThreads, createThread, updateThread, deleteThread, importThreadChart,
  listSpoolSizes, saveSpoolSize, deleteSpoolSize, saveThreadInventory, deleteThreadInventory };`)();
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
  const id1 = await lib.createThread(d1, { brand: "Madeira", code: "1538", type: "PolyNeon", weight: "40", name: "Tiramisu", colorHex: "A98D5F", sourceFlag: "A" });
  console.log("created, colorHex lowercased:", d1.q("SELECT colorHex c FROM threads WHERE id=?", id1)[0].c === "a98d5f");
  await lib.updateThread(d1, id1, { brand: "Madeira", code: "1538", type: "PolyNeon", weight: "40", name: "Tiramisu Renamed", colorHex: "a98d5f", sourceFlag: "A" });
  console.log("updated:", d1.q("SELECT name n FROM threads WHERE id=?", id1)[0].n === "Tiramisu Renamed");
  const id2 = await lib.createThread(d1, { brand: "Isacord", code: "0100", type: "", weight: "40", name: "White", colorHex: "ffffff" });
  let all = await lib.listThreads(d1);
  console.log("listThreads sorted by brand,type,weight,code:", all.length === 2 && all[0].brand === "Isacord" && all[1].brand === "Madeira");
  await lib.deleteThread(d1, id2);
  console.log("deleted:", (await lib.listThreads(d1)).length === 1);

  console.log("\n=== db.js: importThreadChart upserts on (brand, type, weight, code) ===");
  let r = await lib.importThreadChart(d1, [
    { brand: "Madeira", code: "1538", type: "PolyNeon", weight: "40", name: "Tiramisu Re-imported", colorHex: "aabbcc" },
    { brand: "Madeira", code: "1643", type: "Polyneon", weight: "40", name: "Navy", colorHex: "1c2833" },
  ]);
  console.log("one updated (existing brand+type+weight+code), one created:", r.updated === 1 && r.created === 1);
  all = await lib.listThreads(d1);
  console.log("re-import refreshed the name/color rather than duplicating:", all.length === 2 && all.find(t => t.code === "1538").name === "Tiramisu Re-imported");

  console.log("\n=== A code alone isn't unique across a brand's different type/weight lines ===");
  const id3 = await lib.createThread(d1, { brand: "Madeira", code: "1538", type: "Rayon", weight: "40", name: "Different Thread, Same Code", colorHex: "336699" });
  console.log("same brand+code but a different type doesn't collide (a real, distinct thread):",
    !!id3 && (await lib.listThreads(d1)).filter(t => t.brand === "Madeira" && t.code === "1538").length === 2);
  await lib.deleteThread(d1, id3);

  console.log("\n=== Real admin API ===");
  r = await call({ action: "listThreads" });
  console.log("listThreads action:", r.status === 200 && r.body.threads.length === 2);
  r = await call({ action: "saveThread", thread: { brand: "", code: "x" } });
  console.log("brand+code required:", r.status === 400 && /required/.test(r.body.message));
  r = await call({ action: "saveThread", thread: { brand: "Sulky", code: "1001", name: "Black", colorHex: "zzzzzz" } });
  console.log("invalid hex color rejected:", r.status === 400 && /hex/.test(r.body.message));
  r = await call({ action: "saveThread", thread: { brand: "Sulky", code: "1001", name: "Black", colorHex: "000000" } });
  console.log("valid thread created via the API:", r.status === 200 && !!r.body.id);
  r = await call({ action: "saveThread", thread: { brand: "Madeira", type: "PolyNeon", weight: "40", code: "1538", name: "Dup" } });
  console.log("duplicate brand+type+weight+code (direct create, not import) refused clearly:", r.status === 400 && /already exists/.test(r.body.message));
  r = await call({ action: "saveThread", thread: { brand: "Madeira", type: "Rayon", weight: "40", code: "1538", name: "Not a dup — different type" } });
  console.log("same brand+code with a different type is accepted, not treated as a duplicate:", r.status === 200 && !!r.body.id);
  await call({ action: "deleteThread", id: r.body.id });
  const sulkyId = (await lib.listThreads(d1)).find(t => t.brand === "Sulky").id;
  r = await call({ action: "importThreadChart", rows: [{ brand: "X", code: "1", colorHex: "bad" }] });
  console.log("import validates every row's color before writing anything:", r.status === 400 && (await lib.listThreads(d1)).every(t => t.brand !== "X"));
  r = await call({ action: "deleteThread", id: 999999 });
  console.log("deleting a nonexistent thread is a harmless no-op, not a crash:", r.status === 200);
  const delReal = await call({ action: "deleteThread", id: sulkyId });
  console.log("deleting a real, unused thread succeeds (no design/machine tables yet — reference checks no-op safely) and it's gone:",
    delReal.status === 200 && !(await lib.listThreads(d1)).some(t => t.id === sulkyId));

  console.log("\n=== db.js: spool sizes + per-thread inventory (migrations/0028) ===");
  const spoolKing = await lib.saveSpoolSize(d1, { description: "King spool", meters: 1000 });
  const spoolCone = await lib.saveSpoolSize(d1, { description: "Cone", meters: 5000 });
  let spools = await lib.listSpoolSizes(d1);
  console.log("spool sizes created and sorted by meters:", spools.length === 2 && spools[0].meters === 1000 && spools[1].meters === 5000);
  await lib.saveSpoolSize(d1, { id: spoolKing, description: "King spool 1000m", meters: 1000 });
  console.log("spool size updated:", (await lib.listSpoolSizes(d1)).find(s => s.id === spoolKing).description === "King spool 1000m");
  // A thread can hold several inventory items at different spool sizes.
  const tInvId = (await lib.listThreads(d1)).find(t => t.code === "1538" && t.type === "PolyNeon").id;
  const inv1 = await lib.saveThreadInventory(d1, { threadId: tInvId, spoolSizeId: spoolKing, quantity: 3 });
  await lib.saveThreadInventory(d1, { threadId: tInvId, spoolSizeId: spoolCone, quantity: 1 });
  let withInv = (await lib.listThreads(d1)).find(t => t.id === tInvId);
  console.log("thread carries multiple inventory items with different spool sizes:",
    withInv.inventory.length === 2 && withInv.inventory.reduce((s, i) => s + i.quantity, 0) === 4);
  console.log("inventory item exposes its spool size's description + meters:",
    withInv.inventory.some(i => i.spoolDescription === "King spool 1000m" && i.meters === 1000 && i.quantity === 3));
  await lib.saveThreadInventory(d1, { id: inv1, spoolSizeId: spoolKing, quantity: 7 });
  withInv = (await lib.listThreads(d1)).find(t => t.id === tInvId);
  console.log("inventory quantity updated in place:", withInv.inventory.find(i => i.id === inv1).quantity === 7);
  let threw = false;
  try { await lib.deleteSpoolSize(d1, spoolKing); } catch (e) { threw = /used by thread inventory/.test(e.message); }
  console.log("deleting a spool size in use is refused:", threw);
  await lib.deleteThreadInventory(d1, inv1);
  withInv = (await lib.listThreads(d1)).find(t => t.id === tInvId);
  console.log("inventory item removed:", withInv.inventory.length === 1);
  // Deleting a thread cascades its inventory (ON DELETE CASCADE).
  const tmpThread = await lib.createThread(d1, { brand: "Tmp", code: "T1", name: "Tmp", colorHex: "111111" });
  await lib.saveThreadInventory(d1, { threadId: tmpThread, spoolSizeId: spoolCone, quantity: 2 });
  await lib.deleteThread(d1, tmpThread);
  console.log("deleting a thread cascades its inventory rows:", d1.q("SELECT count(*) n FROM thread_inventory WHERE threadId=?", tmpThread)[0].n === 0);

  console.log("\n=== Real admin API: spool sizes + inventory ===");
  r = await call({ action: "saveSpoolSize", spoolSize: { description: "", meters: 100 } });
  console.log("spool size description required:", r.status === 400 && /Description/.test(r.body.message));
  r = await call({ action: "saveSpoolSize", spoolSize: { description: "Mini", meters: 400 } });
  console.log("spool size created via API, returns updated list:", r.status === 200 && r.body.spoolSizes.some(s => s.description === "Mini"));
  r = await call({ action: "listSpoolSizes" });
  console.log("listSpoolSizes action:", r.status === 200 && Array.isArray(r.body.spoolSizes));
  const miniId = r.body.spoolSizes.find(s => s.description === "Mini").id;
  r = await call({ action: "saveThreadInventory", item: { threadId: tInvId, spoolSizeId: miniId, quantity: 5 } });
  console.log("saveThreadInventory via API returns threads with the new item:", r.status === 200 &&
    r.body.threads.find(t => t.id === tInvId).inventory.some(i => i.spoolSizeId === miniId && i.quantity === 5));
  r = await call({ action: "saveThreadInventory", item: { quantity: 1 } });
  console.log("saveThreadInventory without threadId or id refused:", r.status === 400);

  console.log("\n=== parseHatchChart_: a Hatch thread chart (.tch) file ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window;
  w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();

  const chartBytes = fs.readFileSync(__dirname + "/testlib/fixtures/sample-thread-chart.tch");
  const parsed = w.parseHatchChart_(new w.Uint8Array(chartBytes));
  console.log("all 24 rows parsed, none unreadable:", parsed.rows.length === 24 && parsed.errors.length === 0);
  console.log("brand/type/weight split correctly for every row (Acme / PolyBright-or-Polybright / 40):",
    parsed.rows.every(r => r.brand === "Acme" && r.weight === "40" && /^polybright$/i.test(r.type)));
  const tiramisu = parsed.rows.find(r => r.code === "1001");
  console.log("first row: code, name and RGB→hex exactly right (169,141,95 → a98d5f):",
    tiramisu.name === "Sandstone" && tiramisu.colorHex === "a98d5f" && tiramisu.sourceFlag === "A");
  const navy = parsed.rows.find(r => r.code === "1009");
  console.log("a 'C' flagged row (Navy, 28,40,51) parses too, flag kept verbatim:", navy.colorHex === "1c2833" && navy.sourceFlag === "C");
  const sum = parsed.rows.reduce((s, r) => s + r.colorHex.length, 0);
  console.log("every colorHex is exactly 6 characters:", sum === 24 * 6);

  console.log("\n=== parseHatchChart_: fallback and error cases ===");
  const plainCsv = "9999,Fake Brand Line 30,Rose,B,255,0,128\n";
  const utf8Bytes = new w.TextEncoder().encode(plainCsv);
  const csvParsed = w.parseHatchChart_(utf8Bytes);
  console.log("a plain UTF-8 CSV (no BOM) still parses:", csvParsed.rows.length === 1 && csvParsed.rows[0].colorHex === "ff0080" && csvParsed.rows[0].brand === "Fake");
  const badBytes = new w.TextEncoder().encode("not,enough,columns\ngood,one,here,X,1,2,3\n");
  const badParsed = w.parseHatchChart_(badBytes);
  console.log("a malformed line is skipped and reported, not thrown, while good lines still parse:",
    badParsed.rows.length === 1 && badParsed.errors.length === 1 && badParsed.errors[0] === "not,enough,columns");

  console.log("\n=== Screen wiring ===");
  console.log("Threads is in the persistent admin header and routed:", /\["threads", "Threads"\]/.test(adminJs) && /renderThreadCatalog\(app\)/.test(adminJs));
  console.log("Import chart file button + preview modal exist:", /id="thrImportBtn"/.test(adminJs) && /showThreadImportModal_/.test(adminJs) && /action: "importThreadChart"/.test(adminJs));
  console.log("Spool-size manager + per-thread inventory wired into the Threads screen:",
    /id="thrSpoolBtn"/.test(adminJs) && /showSpoolSizesModal_/.test(adminJs) && /showThreadInventoryModal_/.test(adminJs) &&
    /action: "saveSpoolSize"/.test(adminJs) && /action: "saveThreadInventory"/.test(adminJs));
})();
