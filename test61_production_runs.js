const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Production run management, run tracking (migrations/0030): start/finish/abort a timed run per
// physical piece + per machine, machine-busy locking, the managed abort-reason list, and the
// run-time report grouped by design with a per-machine breakdown. Real SQL via sql.js + the real
// orders.js admin API, plus source-regex wiring asserts for the admin.js Run Order / report UI.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, createHoop, saveDesign, addDesignVersion,
  setProductDesign, createProduct, setBlankLink, createBlank, saveMachine, getProductionQueue,
  listActiveRuns, getRunReportByDesign };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let pass = 0, fail = 0;
const ok = (desc, cond) => { console.log(desc + ":", !!cond); if (cond) pass++; else fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const itemIdOf = async (orderId) => Number((await d1.prepare("SELECT id FROM order_items WHERE orderId=?").bind(orderId).first()).id);

  // ---- Fixture ----
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Acme','t','t');`);
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 20, visible: true });
  const blankId = (await lib.createBlank(d1, { name: "Richardson 112", brand: "Richardson", color: "Navy", productType: "cap" })).id;
  await lib.setBlankLink(d1, "acme", "cap", "OSFA", blankId, "OSFA");
  const capHoop = await lib.createHoop(d1, { name: "Cap Frame", isCapFrame: true });
  const designId = await lib.saveDesign(d1, "acme", { name: "Club Logo", stabilizer: "medium", hoopId: capHoop });
  await lib.addDesignVersion(d1, designId, { designFileKey: "d/a.emb", designFileName: "a.emb", designFileExt: "emb",
    machineFileKey: "d/a.dst", machineFileName: "a.dst", machineFileExt: "dst", threadColors: [] });
  await lib.setProductDesign(d1, "acme", "cap", designId);
  const machine1 = await lib.saveMachine(d1, { name: "Machine 1", needleCount: 12, hoopIds: [capHoop] });
  const machine2 = await lib.saveMachine(d1, { name: "Machine 2", needleCount: 15, hoopIds: [capHoop] });
  const order = async (id) => {
    await lib.insertOrder(d1, { orderId: id, orgId: "acme", customerName: "Cust " + id, contact: id + "@x.com", placedAt: "2026-07-01T00:00:00Z" },
      [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 2, unitPrice: 20 }]);
    d1._raw.run("UPDATE orders SET paid=1, blankReceivedAt='2026-07-05T00:00:00Z', designApprovedAt='2026-07-06T00:00:00Z' WHERE orderId=?", [id]);
  };

  console.log("=== Abort reasons: seeded + CRUD ===");
  let r = await call({ action: "listAbortReasons" });
  ok("migration seeds 6 reasons, 'Machine problem' first", r.status === 200 && r.body.reasons.length === 6 && r.body.reasons[0].label === "Machine problem");
  r = await call({ action: "saveAbortReason", reason: { label: "Power outage", sortOrder: 9 } });
  ok("create adds a reason", r.status === 200 && r.body.reasons.some(x => x.label === "Power outage"));
  const powerId = r.body.reasons.find(x => x.label === "Power outage").id;
  r = await call({ action: "saveAbortReason", reason: { id: powerId, label: "Power loss", sortOrder: 9 } });
  ok("update renames it", r.body.reasons.find(x => x.id === powerId).label === "Power loss");
  ok("blank label refused", (await call({ action: "saveAbortReason", reason: { label: "  " } })).status === 400);
  r = await call({ action: "deleteAbortReason", id: powerId });
  ok("delete removes it (always safe — label snapshotted on runs)", !r.body.reasons.some(x => x.id === powerId));
  const machineProblemId = (await call({ action: "listAbortReasons" })).body.reasons.find(x => x.label === "Machine problem").id;

  console.log("\n=== startRun: snapshots, busy + capacity guards ===");
  await order("READY");
  const readyItem = await itemIdOf("READY");
  r = await call({ action: "startRun", org: "acme", orderId: "READY", itemId: readyItem, machineId: machine2 });
  ok("start returns a runId", r.status === 200 && r.body.runId > 0);
  const run1 = r.body.runId;
  let active = await lib.listActiveRuns(d1);
  ok("listActiveRuns shows it with machine + design-name snapshot", active.length === 1 && active[0].machineName === "Machine 2" && active[0].designName === "Club Logo");
  ok("order not manufactured while a piece is only running", !(await lib.getOrderById(d1, "READY")).manufacturedAt);
  ok("still queued (started ≠ made)", (await call({ action: "getProductionQueue" })).body.queue.some(j => j.orderId === "READY"));
  ok("a second card can't pick the busy machine (startRun refuses)",
    (await call({ action: "startRun", org: "acme", orderId: "READY", itemId: readyItem, machineId: machine2 })).status === 400);
  r = await call({ action: "startRun", org: "acme", orderId: "READY", itemId: readyItem, machineId: machine1 });
  ok("second piece starts on a free machine", r.status === 200 && r.body.runId > 0);
  const run2 = r.body.runId;
  ok("a third start is refused — both pieces now in progress",
    (await call({ action: "startRun", org: "acme", orderId: "READY", itemId: readyItem, machineId: machine2 })).status === 400);

  console.log("\n=== completeRun: finishes + completes the piece, order done on the last ===");
  d1._raw.run("UPDATE production_runs SET startedAt=? WHERE id=?", [new Date(Date.now() - 60000).toISOString(), run1]); // 60s run
  r = await call({ action: "completeRun", runId: run1, org: "acme", orderId: "READY" });
  ok("first completeRun succeeds, order NOT yet complete", r.status === 200 && r.body.orderComplete === false);
  ok("one blank consumed + manufacturedQty bumped to 1",
    Number((await d1.prepare("SELECT manufacturedQty FROM order_items WHERE id=?").bind(readyItem).first()).manufacturedQty) === 1);
  r = await call({ action: "completeRun", runId: run2, org: "acme", orderId: "READY" });
  ok("last completeRun completes the order", r.status === 200 && r.body.orderComplete === true);
  ok("order marked manufactured + gone from the queue",
    !!(await lib.getOrderById(d1, "READY")).manufacturedAt && !(await call({ action: "getProductionQueue" })).body.queue.some(j => j.orderId === "READY"));
  ok("no runs left running", (await lib.listActiveRuns(d1)).length === 0);
  ok("completing an already-finished run is refused", (await call({ action: "completeRun", runId: run1 })).status === 400);

  console.log("\n=== abortRun: records reason, frees machine, piece returns to the queue ===");
  await order("READY2");
  const r2Item = await itemIdOf("READY2");
  const run3 = (await call({ action: "startRun", org: "acme", orderId: "READY2", itemId: r2Item, machineId: machine2 })).body.runId;
  r = await call({ action: "abortRun", runId: run3, org: "acme", orderId: "READY2", abortReasonId: machineProblemId, abortNote: "needle broke" });
  ok("abort succeeds", r.status === 200);
  ok("machine freed (no active runs)", (await lib.listActiveRuns(d1)).length === 0);
  ok("nothing consumed — manufacturedQty still 0",
    Number((await d1.prepare("SELECT manufacturedQty FROM order_items WHERE id=?").bind(r2Item).first()).manufacturedQty) === 0);
  ok("piece back in the queue with both pieces remaining",
    (await call({ action: "getProductionQueue" })).body.queue.find(j => j.orderId === "READY2").remaining === 2);
  ok("aborting a non-running run is refused", (await call({ action: "abortRun", runId: run3 })).status === 400);

  console.log("\n=== Report by design (+ per-machine breakdown) ===");
  r = await call({ action: "getRunReportByDesign", from: "2026-01-01", to: "2030-12-31" });
  const rep = r.body.report;
  const d = rep.designs.find(x => x.designName === "Club Logo");
  ok("design row: 2 completed runs", r.status === 200 && d && d.runs === 2);
  ok("average over DONE runs only, and the 60s run is reflected (avg ≥ 30s)", d.avgMs >= 30000);
  ok("aborted counted separately (1), not in the average", d.abortedCount === 1);
  ok("per-machine breakdown lists both machines", d.byMachine.length === 2 && d.byMachine.every(m => m.runs === 1));
  const aborted = rep.detail.find(x => x.status === "aborted");
  ok("detail log includes the aborted run with its reason + note", aborted && aborted.abortReasonLabel === "Machine problem" && aborted.abortNote === "needle broke");
  ok("detail log includes 2 done runs with durations", rep.detail.filter(x => x.status === "done" && x.durationMs != null).length === 2);
  r = await call({ action: "getRunReportByDesign", from: "2000-01-01", to: "2000-12-31" });
  ok("date range excludes out-of-range runs", r.body.report.designs.length === 0 && r.body.report.detail.length === 0);

  console.log("\n=== admin.js wiring (Run Order cards, abort modal, screens, nav, routes) ===");
  const a = read("public/admin.js");
  ok("idle cards have Start job + untimed Mark-done; running cards have complete/abort buttons",
    /class="run-start-btn"/.test(a) && /class="run-complete-btn"/.test(a) && /class="run-abort-btn[ "]/.test(a) && /class="run-btn"/.test(a));
  ok("busy machines are excluded from idle pickers (proposeMachine_ takes a busy set)",
    /busyMachineIds/.test(a) && /proposeMachine_\(step, machines, hoopsById, window\._roCtx\.busyMachineIds\)/.test(a));
  ok("run actions wired", /action: "startRun"/.test(a) && /action: "completeRun"/.test(a) && /action: "abortRun"/.test(a));
  ok("abort modal defaults to 'Machine problem'", /function showAbortModal_/.test(a) && /\/\^machine problem\$\/i/.test(a));
  ok("abort-reasons management screen exists + wired", /function renderAbortReasons/.test(a) && /function showAbortReasonFormModal_/.test(a) && /action: "saveAbortReason"/.test(a));
  ok("run-time report screen exists + calls the report action", /function renderRunReport/.test(a) && /action: "getRunReportByDesign"/.test(a));
  ok("nav entries + routes added", /\["abortreasons", "Abort reasons"\]/.test(a) && /\["runreport", "Run times"\]/.test(a) &&
    /raw === "abortreasons"/.test(a) && /raw === "runreport"/.test(a));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
