const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Assorted behaviours:
//   - the 6 AM roll-up's "new since last email" cursor is orders.insertedAt (migrations/0031, set by a
//     trigger), not the implicit rowid a VACUUM/rebuild can renumber — incl. backdated orders, the
//     one-run switch-over from an {afterRowid} state, and the pre-migration fallback
//   - at most one RUNNING job per machine (unique index) — two Starts at once can't both succeed
//   - csvSafe also catches a leading tab / CR, leading spaces and full-width formula characters
//   - the storefront/admin have no direct-to-another-backend or in-browser-storage mode
// ("In transit" alone never sends the roll-up — that's in test48.)

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const L = new Function(dbSrc + `\nreturn { insertOrder, getOrdersForDigest, createProduct, saveMachine, startProductionRun };`)();

async function migrated(upTo) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && (!upTo || f < upTo)).sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, ready, createdAt, updatedAt) VALUES ('prime','prime','PRIME',1,'t','t');`);
  return d1;
}
const order = (d1, id, placedAt, o = {}) => L.insertOrder(d1, { orderId: id, orgId: "prime", customerName: "C " + id, contact: "c@x.com", placedAt, isTest: !!o.isTest },
  [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
const ids = (r) => r.orders.map(o => o.orderId).sort().join(",");
const tick = () => new Promise(r => setTimeout(r, 3));

(async () => {
  try {
    console.log("=== S3: orders.insertedAt drives the roll-up cursor ===");
    let d1 = await migrated();
    await order(d1, "A1", new Date().toISOString());
    const a1 = d1.q("SELECT insertedAt FROM orders WHERE orderId='A1'")[0].insertedAt;
    console.log("the trigger stamps insertedAt on insert (no code change needed):", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(a1));
    let r = await L.getOrdersForDigest(d1, null);
    console.log("first run: the last 24 hours, and a cursor at the newest order:", ids(r) === "A1" && r.cursor.afterOrderId === "A1" && r.cursor.afterInsertedAt === a1);
    let state = r.cursor;
    await tick(); await order(d1, "B1", "2026-01-05T00:00:00Z");                 // a backdated local sale
    await tick(); await order(d1, "T1", new Date().toISOString(), { isTest: true });
    await tick(); await order(d1, "C1", new Date().toISOString());
    d1._raw.run("UPDATE orders SET isTest = 1 WHERE orderId = 'T1'");
    r = await L.getOrdersForDigest(d1, state);
    console.log("next run: everything written since — a BACKDATED order too — but not test orders:", ids(r) === "B1,C1");
    console.log("the cursor moves past the test order as well, so it's never reconsidered:", r.cursor.afterOrderId === "C1");
    state = r.cursor;
    r = await L.getOrdersForDigest(d1, state);
    console.log("nothing new → nothing reported, cursor unchanged:", r.orders.length === 0 && r.cursor.afterOrderId === "C1" && r.cursor.afterInsertedAt === state.afterInsertedAt);
    d1._raw.run("VACUUM");
    await tick(); await order(d1, "D1", new Date().toISOString());
    r = await L.getOrdersForDigest(d1, state);
    console.log("a VACUUM can't make it skip or repeat orders:", ids(r) === "D1");

    console.log("\n=== S3: switch-over from a state saved by the old rowid code ===");
    d1 = await migrated();
    await order(d1, "O1", new Date().toISOString()); await order(d1, "O2", new Date().toISOString());
    const rowidO1 = d1.q("SELECT rowid r FROM orders WHERE orderId='O1'")[0].r;
    await tick(); await order(d1, "O3", "2026-02-01T00:00:00Z");
    r = await L.getOrdersForDigest(d1, { afterRowid: rowidO1 });
    console.log("that one run reports exactly what the old code would (after the old rowid):", ids(r) === "O2,O3");
    console.log("…and switches the cursor to the newest order:", r.cursor.afterOrderId === "O3" && typeof r.cursor.afterInsertedAt === "string" && !("afterRowid" in r.cursor));
    await tick(); await order(d1, "O4", new Date().toISOString());
    r = await L.getOrdersForDigest(d1, r.cursor);
    console.log("from then on it's insertedAt-based:", ids(r) === "O4");

    console.log("\n=== S3: before migration 0031 is applied ===");
    d1 = await migrated("0031");
    await order(d1, "P1", new Date().toISOString());
    r = await L.getOrdersForDigest(d1, null);
    console.log("no insertedAt column yet → the old rowid logic still runs (deploy-order safe):", ids(r) === "P1" && Number.isFinite(r.cursor.afterRowid));

    console.log("\n=== S2: one running job per machine ===");
    d1 = await migrated();
    await L.createProduct(d1, "prime", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 20, visible: true });
    await L.insertOrder(d1, { orderId: "R1", orgId: "prime", customerName: "R", contact: "r@x.com", placedAt: new Date().toISOString() },
      [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 3, unitPrice: 20 }]);
    const item = d1.q("SELECT id FROM order_items WHERE orderId='R1'")[0].id;
    const m = await L.saveMachine(d1, { name: "Machine 1", needleCount: 12, hoopIds: [] });
    const both = await Promise.allSettled([L.startProductionRun(d1, { orgId: "prime", orderId: "R1", itemId: item, machineId: m }),
                                           L.startProductionRun(d1, { orgId: "prime", orderId: "R1", itemId: item, machineId: m })]);
    console.log("two Starts on one machine at once: one runs, the other is told the machine is busy:",
      both.filter(x => x.status === "fulfilled").length === 1 && both.some(x => x.status === "rejected" && /already running a job/.test(x.reason.message)));
    console.log("only one running row exists:", d1.q(`SELECT count(*) n FROM production_runs WHERE machineId=${m} AND status='running'`)[0].n === 1);
    console.log("the database itself refuses a second running row for a machine:",
      (() => { try { d1._raw.run(`INSERT INTO production_runs (orgId, orderId, itemId, machineId, startedAt, status, createdAt) VALUES ('prime','R1',${item},${m},'t','running','t')`); return false; } catch (e) { return /UNIQUE/.test(e.message); } })());
    d1._raw.run(`INSERT INTO production_runs (orgId, orderId, itemId, machineId, startedAt, status, createdAt) VALUES ('prime','R1',${item},${m},'t','done','t')`);
    console.log("…while finished runs for that machine are unrestricted:", d1.q(`SELECT count(*) n FROM production_runs WHERE machineId=${m}`)[0].n === 2);

    console.log("\n=== L-4: spreadsheet-formula guard ===");
    const adminJs = read("public/admin.js");
    const csvSafe = new Function(adminJs.slice(adminJs.indexOf("function csvSafe("), adminJs.indexOf("\n}\n", adminJs.indexOf("function csvSafe(")) + 2) + "\nreturn csvSafe;")();
    console.log("neutralised: =, leading spaces before =, tab, carriage return, full-width ＝, @:",
      ["=1+1", "  =1", "\t=1", "\r=1", "＝1", "@SUM(A1)"].every(v => csvSafe(v).startsWith("'")));
    console.log("a tab or line break inside a value can't start a new cell or row:", csvSafe("Ann\t=HYPERLINK(1)") === "Ann =HYPERLINK(1)" && csvSafe("Ann\r\n=1+1") === "Ann =1+1" && !/[\t\r\n]/.test(csvSafe("a\tb\nc\rd\u2028e")));
    console.log("ordinary text and numbers are left alone:", csvSafe("Ann Smith") === "Ann Smith" && csvSafe("12.50") === "12.50" && csvSafe("") === "");

    console.log("\n=== A-2: dead storefront/admin modes are gone ===");
    const html = read("public/index.html");
    console.log("no direct-to-another-backend switch or in-browser storage in the pages:",
      !/const PROXY_MODE|GOOGLE_SCRIPT_URL\s*=|window\.storage/.test(html) && !/PROXY_MODE|GOOGLE_SCRIPT_URL|window\.storage/.test(adminJs));
    console.log("orders still submit to /api/orders, and the admin still loads them from there:",
      /async function saveOrder\(order\)\{\n  const turnstileToken[\s\S]*?fetch\("\/api\/orders"/.test(html) && /async function fetchOrders\(orgId\)\{[\s\S]*?fetch\("\/api\/orders"/.test(adminJs));
  } catch (e) {
    console.log("test68 crashed:", false);
    console.error(e);
    process.exit(1);
  }
})();
