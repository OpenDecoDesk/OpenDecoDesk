const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

// Machine counters & maintenance (migrations/0071): stitch counts on design versions (from the browser on upload, from
// the DESIGNS bucket on the server, or typed in), every run adding its stitches and time to its machine — an untimed
// "Mark done" too, with an estimated time — a reading typed from the machine, per-machine maintenance tasks due by run
// hours and/or stitches, the maintenance log, the Run Times report's stitch columns, the roll-up, and the screens.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const stitchSrc = strip(read("functions/_lib/stitchCount.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, createHoop, createThread, saveDesign, addDesignVersion, setProductDesign, createProduct, saveMachine,
  maintenanceStatus, cleanStitchCount, getRunReportByDesign, listMaintenanceTasks, setFeatures };`)();
const sc = new Function(stitchSrc + "\nreturn { countStitches, countDstStitches, countDsbStitches };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + stitchSrc + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'tester@example.com';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  "const checkShippedDeliveries = async () => ({ inTransit: [], delivered: [], pickedUp: [], awaitingPickup: [] });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const tick = (ms) => new Promise(r => setTimeout(r, ms));

// A Tajima .dst: "LA:" header padded to 512 bytes, then 3-byte records (b2: 0x03 stitch, 0x83 jump, 0xC3 color, 0xF3 end).
function dst(records) {
  const head = Buffer.alloc(512, 0x20); head.write("LA:test");
  const recs = { s: [0, 0, 0x03], j: [0, 0, 0x83], c: [0, 0, 0xC3], e: [0, 0, 0xF3] };
  return new Uint8Array(Buffer.concat([head, Buffer.from(records.split("").flatMap(k => recs[k]))]));
}
// A Barudan .dsb: control byte's low 5 bits — 0 stitch, 1 jump, 7 trim, 9–23 needle, 24 end.
function dsb(records) {
  const recs = { s: [0x80, 1, 1], j: [0x81, 5, 5], t: [0xE7, 0, 0], n: [0xEA, 0, 0], e: [0xF8, 0, 0] };
  return new Uint8Array(Buffer.concat([Buffer.alloc(512, 0x20), Buffer.from(records.split("").flatMap(k => recs[k]))]));
}

(async () => {
  console.log("=== Reading stitch counts ===");
  const dstA = dst("sssjssscsssse"), dsbA = dsb("nssjstssnsse");
  ok("a DST counts only stitches (not jumps, color changes or what follows the end)", sc.countDstStitches(dstA) === 10 && sc.countDstStitches(dst("ssesss")) === 2);
  ok("a DSB counts only stitches (not jumps, trims, needle changes)", sc.countDsbStitches(dsbA) === 7);
  ok("by extension; other formats and empty files are null", sc.countStitches(dstA, "A.DST") === 10 && sc.countStitches(dsbA, "dsb") === 7
    && sc.countStitches(dstA, "x.pes") === null && sc.countStitches(new Uint8Array(100), "dst") === null && sc.countStitches(dst("jce"), "dst") === null);
  ok("a whole number ≥ 0 is a stitch count; anything else isn't", lib.cleanStitchCount("12,345") === 12345 && lib.cleanStitchCount(0) === 0
    && lib.cleanStitchCount("") === null && lib.cleanStitchCount("1.5") === null && lib.cleanStitchCount(-1) === null && lib.cleanStitchCount("abc") === null);

  console.log("\n=== Maintenance status (pure) ===");
  const ms = lib.maintenanceStatus;
  const m0 = { runSeconds: 3 * 3600, stitchCount: 1000 };
  ok("by hours: 3 of 4 h is OK, at 75%", ms({ active: true, everySeconds: 4 * 3600, lastDoneSeconds: 0 }, m0).status === "ok" && ms({ active: true, everySeconds: 4 * 3600 }, m0).pct === 0.75);
  ok("90% is due soon, 100% is due", ms({ active: true, everySeconds: 3.3 * 3600 }, m0).status === "soon" && ms({ active: true, everySeconds: 3 * 3600 }, m0).status === "due");
  ok("counted from when it was last done", ms({ active: true, everySeconds: 4 * 3600, lastDoneSeconds: 2 * 3600 }, m0).usedSeconds === 3600);
  ok("hours AND stitches: whichever comes first", ms({ active: true, everySeconds: 100 * 3600, everyStitches: 1000 }, m0).status === "due"
    && ms({ active: true, everySeconds: 3 * 3600, everyStitches: 1e9 }, m0).status === "due" && ms({ active: true, everySeconds: 100 * 3600, everyStitches: 1e9 }, m0).status === "ok");
  ok("an inactive task is off; a counter below last done never goes negative", ms({ active: false, everySeconds: 1 }, m0).status === "off"
    && ms({ active: true, everyStitches: 10, lastDoneStitches: 5000 }, m0).usedStitches === 0);

  console.log("\n=== Setup ===");
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme Shop','t','t',1);`);
  const hoop = await lib.createHoop(d1, { name: "6.9in", isCapFrame: false });
  const thread = await lib.createThread(d1, { brand: "Madeira", type: "PolyNeon", weight: "40", code: "1", name: "Red", colorHex: "cc0000" });
  const bucket = new Map([["designs/b.dst", dstA], ["designs/c.pes", new Uint8Array(600)]]);
  const env = { DB: d1, DESIGNS: { get: async (k) => (bucket.has(k) ? { arrayBuffer: async () => bucket.get(k).buffer } : null) } };
  const call = async (body, e = env) => {
    const res = await api({ env: e, waitUntil: (p) => p.then(() => {}, () => {}), request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const makeDesign = async (name, version) => {
    const id = await lib.saveDesign(d1, "acme", { name, hoopIds: [hoop] });
    const r = await call(Object.assign({ action: "saveDesignVersion", designId: id, designFileKey: "designs/" + name + ".emb", designFileName: name + ".emb",
      threadColors: [{ needle: 1, threadId: thread }] }, version));
    if (r.status !== 200) throw new Error("saveDesignVersion: " + JSON.stringify(r.body));
    await lib.createProduct(d1, "acme", { productId: name, type: "shirt", name: "Polo " + name, pricingMode: "sized", sizePricing: { L: 25 }, visible: true });
    await lib.setProductDesign(d1, "acme", name, id);
    return id;
  };
  const dA = await makeDesign("a", { machineFileKey: "designs/a.dst", machineFileName: "A.DST", machineFileExt: "dst", stitchCount: 1000 });
  const dB = await makeDesign("b", { machineFileKey: "designs/b.dst", machineFileName: "B.DST", machineFileExt: "dst" });
  const dC = await makeDesign("c", { machineFileKey: "designs/c.pes", machineFileName: "C.PES", machineFileExt: "pes" });
  ok("the browser's stitch count is saved with an uploaded version", Number(d1.q(`SELECT stitchCount FROM design_versions WHERE designId=${dA}`)[0].stitchCount) === 1000
    && d1.q(`SELECT stitchCount FROM design_versions WHERE designId=${dB}`)[0].stitchCount == null);
  const m1 = await lib.saveMachine(d1, { name: "Machine 1", needleCount: 12, hoopIds: [hoop] });
  const m2 = await lib.saveMachine(d1, { name: "Machine 2", needleCount: 15, hoopIds: [hoop] });
  let n = 0;
  const order = async (product) => {
    const id = "O" + (++n);
    await lib.insertOrder(d1, { orderId: id, orgId: "acme", customerName: "C " + id, contact: "c@x.com", placedAt: "2026-09-01T00:00:00Z" }, [{ productId: product, name: "Polo", type: "shirt", size: "L", qty: 1, unitPrice: 25 }]);
    for (const [col, v] of Object.entries({ paid: 1, blankReceivedAt: "2026-09-03", designApprovedAt: "2026-09-04", digitizingCompleteAt: "2026-09-03" })) d1._raw.run(`UPDATE orders SET ${col}=? WHERE orderId=?`, [v, id]);
    return { orderId: id, itemId: Number(d1.q(`SELECT id FROM order_items WHERE orderId='${id}'`)[0].id) };
  };
  const machine = (id) => d1.q(`SELECT stitchCount, runSeconds FROM machines WHERE id=${id}`)[0];
  const events = (id) => d1.q(`SELECT * FROM machine_counter_events WHERE machineId=${id} ORDER BY id`);
  const timedRun = async (product, machineId, minutes) => {
    const o = await order(product);
    const r = await call({ action: "startRun", org: "acme", orderId: o.orderId, itemId: o.itemId, machineId });
    if (r.status !== 200) throw new Error("startRun: " + JSON.stringify(r.body));
    d1._raw.run("UPDATE production_runs SET startedAt=? WHERE id=?", [new Date(Date.now() - minutes * 60000).toISOString(), r.body.runId]);
    return Object.assign(o, { runId: r.body.runId });
  };

  console.log("\n=== A reading typed from the machine ===");
  let r = await call({ action: "setMachineStitchCount", machineId: m1, reading: "5,000,000", runHours: 100 });
  ok("the counter becomes the reading, and the run hours", r.status === 200 && machine(m1).stitchCount === 5000000 && machine(m1).runSeconds === 360000);
  let ev = events(m1);
  ok("a reading event records the difference and the totals after", ev.length === 1 && ev[0].kind === "reading" && Number(ev[0].stitchesDelta) === 5000000 && Number(ev[0].stitchTotalAfter) === 5000000 && ev[0].actor === "tester@example.com");
  ok("a bad reading is refused; an unknown machine is a 404", (await call({ action: "setMachineStitchCount", machineId: m1, reading: "lots" })).status === 400
    && (await call({ action: "setMachineStitchCount", machineId: 999, reading: 5 })).status === 404);
  ok("the answer carries the machine list with the counters", r.body.machines.find(m => m.id === m1).stitchCount === 5000000);

  console.log("\n=== Maintenance tasks ===");
  ok("a task needs a name and a threshold", (await call({ action: "saveMaintenanceTask", task: { machineId: m1, name: "", everyHours: 4 } })).status === 400
    && (await call({ action: "saveMaintenanceTask", task: { machineId: m1, name: "Oil" } })).status === 400
    && (await call({ action: "saveMaintenanceTask", task: { machineId: m1, name: "Oil", everyHours: -1 } })).status === 400
    && (await call({ action: "saveMaintenanceTask", task: { machineId: m1, name: "Oil", everyStitches: "1.5" } })).status === 400);
  r = await call({ action: "saveMaintenanceTask", task: { machineId: m1, name: "Oil the rotary hook", everyHours: 0.5 } });
  const tOil = r.body.id;
  const tNeedles = (await call({ action: "saveMaintenanceTask", task: { machineId: m1, name: "Change needles", everyStitches: 2500 } })).body.id;
  let tasks = (await call({ action: "listMaintenanceTasks", machineId: m1 })).body.tasks;
  ok("a new task starts counting from the machine's counters now (not instantly due)", tasks.length === 2 && tasks.every(t => t.status === "ok" && t.usedSeconds === 0 && t.usedStitches === 0));

  console.log("\n=== Runs add to the machine ===");
  const a1 = await timedRun("a", m1, 30);
  r = await call({ action: "completeRun", runId: a1.runId, org: "acme", orderId: a1.orderId });
  ok("a timed run adds its design's stitches and its time", r.status === 200 && machine(m1).stitchCount === 5001000 && Math.abs(machine(m1).runSeconds - 360000 - 1800) <= 2
    && r.body.counted && r.body.counted.stitches === 1000 && !r.body.counted.estimated);
  const run1 = d1.q(`SELECT stitchCount, stitchesCounted, secondsCounted, estimated FROM production_runs WHERE id=${a1.runId}`)[0];
  ok("the run keeps its stitches and what it added", Number(run1.stitchCount) === 1000 && Number(run1.stitchesCounted) === 1000 && Number(run1.estimated) === 0);
  ok("finishing it again counts nothing more", (await call({ action: "completeRun", runId: a1.runId, org: "acme", orderId: a1.orderId })).status === 400 && events(m1).length === 2);
  ok("the finish prompt's stats carry the stitches", (await call({ action: "getRunStats", runId: a1.runId })).body.stats.stitchCount === 1000);
  tasks = (await call({ action: "listMaintenanceTasks", machineId: m1 })).body.tasks;
  ok("30 run minutes later the 30-minute oiling is due; needles 1,000 of 2,500 stitches", tasks.find(t => t.id === tOil).status === "due" && tasks.find(t => t.id === tNeedles).usedStitches === 1000 && tasks.find(t => t.id === tNeedles).status === "ok");
  const ml = (await call({ action: "listMachines" })).body.machines.find(m => m.id === m1);
  ok("listMachines has the tasks and what's due (for Run Order)", ml.maintenance.length === 2 && ml.maintenanceDue.length === 1 && ml.maintenanceDue[0].name === "Oil the rotary hook");

  const before = machine(m1);
  const a2 = await order("a");
  r = await call({ action: "markHoopingDone", org: "acme", orderId: a2.orderId, itemId: a2.itemId, machineId: m1 });
  ok("Mark done (no timing) still adds the design's stitches", r.status === 200 && machine(m1).stitchCount === before.stitchCount + 1000);
  ok("...and the design's average timed run, marked estimated", r.body.counted.estimated && Math.abs(machine(m1).runSeconds - before.runSeconds - 1800) <= 2
    && Number(d1.q("SELECT estimated FROM machine_counter_events ORDER BY id DESC LIMIT 1")[0].estimated) === 1);

  const b1 = await order("b");
  const beforeB = machine(m2);
  r = await call({ action: "markHoopingDone", org: "acme", orderId: b1.orderId, itemId: b1.itemId, machineId: m2 });
  ok("a design with no count gets it from its DST in the bucket", r.status === 200 && machine(m2).stitchCount === beforeB.stitchCount + 10
    && Number(d1.q(`SELECT stitchCount FROM design_versions WHERE designId=${dB}`)[0].stitchCount) === 10);
  ok("...a never-timed design adds no time", machine(m2).runSeconds === beforeB.runSeconds);

  const c1 = await order("c");
  r = await call({ action: "markHoopingDone", org: "acme", orderId: c1.orderId, itemId: c1.itemId, machineId: m2 });
  ok("a format that can't be read adds 0 stitches, noted on the event", r.status === 200 && r.body.counted.unknownStitches && machine(m2).stitchCount === beforeB.stitchCount + 10
    && /not known/.test(d1.q("SELECT note FROM machine_counter_events ORDER BY id DESC LIMIT 1")[0].note));

  const a3 = await order("a");
  const evCount = d1.q("SELECT COUNT(*) n FROM machine_counter_events")[0].n;
  r = await call({ action: "markHoopingDone", org: "acme", orderId: a3.orderId, itemId: a3.itemId });
  ok("with no machine picked nothing is counted, but the run keeps its stitches", r.status === 200 && d1.q("SELECT COUNT(*) n FROM machine_counter_events")[0].n === evCount
    && Number(d1.q("SELECT stitchCount FROM production_runs ORDER BY id DESC LIMIT 1")[0].stitchCount) === 1000);

  const a4 = await timedRun("a", m2, 10);
  ok("an abort with a stitch count that isn't a number is refused", (await call({ action: "abortRun", runId: a4.runId, org: "acme", orderId: a4.orderId, stitchesRun: "lots" })).status === 400);
  const beforeAbort = machine(m2);
  r = await call({ action: "abortRun", runId: a4.runId, org: "acme", orderId: a4.orderId, stitchesRun: "300" });
  ok("an aborted run adds the time it ran and the stitches entered", r.status === 200 && machine(m2).stitchCount === beforeAbort.stitchCount + 300
    && Math.abs(machine(m2).runSeconds - beforeAbort.runSeconds - 600) <= 2 && d1.q("SELECT kind FROM machine_counter_events ORDER BY id DESC LIMIT 1")[0].kind === "abort");
  ok("aborting it twice counts once", (await call({ action: "abortRun", runId: a4.runId, org: "acme", orderId: a4.orderId })).status === 400);
  const a5 = await timedRun("a", m2, 5);
  const beforeAbort2 = machine(m2);
  await call({ action: "abortRun", runId: a5.runId, org: "acme", orderId: a5.orderId, stitchesRun: "" });
  ok("an abort with no stitches entered adds only its time", machine(m2).stitchCount === beforeAbort2.stitchCount && machine(m2).runSeconds > beforeAbort2.runSeconds);

  console.log("\n=== Doing the maintenance ===");
  const now1 = machine(m1);
  r = await call({ action: "recordMaintenance", machineId: m1, taskId: tOil, note: "Two drops" });
  ok("Done logs it with the counters at that moment", r.status === 200 && r.body.entry.stitchCountAt === now1.stitchCount && r.body.entry.runSecondsAt === now1.runSeconds);
  tasks = (await call({ action: "listMaintenanceTasks", machineId: m1 })).body.tasks;
  ok("...and the task starts counting again", tasks.find(t => t.id === tOil).status === "ok" && tasks.find(t => t.id === tOil).usedSeconds === 0 && tasks.find(t => t.id === tOil).lastDoneAt);
  ok("other work is logged by name; a blank one or another machine's task is refused", (await call({ action: "recordMaintenance", machineId: m1, name: "Replaced the hook" })).status === 200
    && (await call({ action: "recordMaintenance", machineId: m1, name: " " })).status === 400
    && (await call({ action: "recordMaintenance", machineId: m2, taskId: tOil })).status === 400
    && (await call({ action: "recordMaintenance", machineId: m1, taskId: tOil, doneAt: "2999-01-01" })).status === 400);
  let log = (await call({ action: "getMaintenanceLog", machineId: m1 })).body;
  ok("the log lists both, newest first, with the note and who", log.log.length === 2 && log.log[0].taskName === "Replaced the hook" && log.log[1].note === "Two drops" && log.log[1].actor === "tester@example.com");
  ok("...and the counter changes for that machine only", log.events.length >= 3 && log.events.every(e => e.machineId === m1));
  r = await call({ action: "setMachineStitchCount", machineId: m1, reading: 0, note: "Counter reset by the technician" });
  tasks = (await call({ action: "listMaintenanceTasks", machineId: m1 })).body.tasks;
  ok("a reading below a task's last-done brings it down (a reset doesn't stall the task)", r.status === 200 && tasks.every(t => t.lastDoneStitches === 0 && t.usedStitches === 0));
  ok("...and the reading's difference is negative", Number(d1.q("SELECT stitchesDelta FROM machine_counter_events WHERE kind='reading' ORDER BY id DESC LIMIT 1")[0].stitchesDelta) < 0);
  r = await call({ action: "deleteMaintenanceTask", taskId: tNeedles });
  ok("a task can be deleted; its log entries stay", r.status === 200 && (await call({ action: "listMaintenanceTasks", machineId: m1 })).body.tasks.length === 1
    && (await call({ action: "deleteMaintenanceTask", taskId: tNeedles })).status === 404);

  console.log("\n=== Design stitch counts ===");
  const vC = Number(d1.q(`SELECT id FROM design_versions WHERE designId=${dC}`)[0].id);
  ok("a count is typed in for a format that can't be read", (await call({ action: "setDesignVersionStitches", versionId: vC, stitchCount: "4,200" })).body.stitchCount === 4200
    && (await call({ action: "setDesignVersionStitches", versionId: vC, stitchCount: "x" })).status === 400 && (await call({ action: "setDesignVersionStitches", versionId: 9999, stitchCount: 5 })).status === 404);
  const dD = await makeDesign("d", { machineFileKey: "designs/d.dsb", machineFileName: "D.DSB", machineFileExt: "dsb" });
  bucket.set("designs/d.dsb", dsbA);
  r = await call({ action: "fillDesignStitchCounts" });
  ok("Read design stitch counts fills the ones it can (DSB here)", r.status === 200 && r.body.filled === 1 && Number(d1.q(`SELECT stitchCount FROM design_versions WHERE designId=${dD}`)[0].stitchCount) === 7);
  ok("...and says so when there's no bucket", (await call({ action: "fillDesignStitchCounts" }, { DB: d1 })).status === 503);

  console.log("\n=== Run Times report ===");
  const rep = (await call({ action: "getRunReportByDesign" })).body.report;
  const repA = rep.designs.find(d => d.designId === dA);
  ok("a design's stitches, per run and per minute (timed runs)", repA.stitches === 1000 && repA.avgStitches === 1000 && repA.stitchesPerMin > 0 && repA.byMachine[0].stitches === 1000);
  ok("the summary counts the untimed runs' stitches", rep.stitchSummary.untimedRuns >= 4 && rep.stitchSummary.untimedStitches >= 2010);
  ok("each run in the log has its stitches", rep.detail.some(x => x.stitchCount === 1000) && rep.detail.some(x => x.status === "aborted" && x.stitchesCounted === 300));

  console.log("\n=== Roll-up and Communications ===");
  await call({ action: "saveMaintenanceTask", task: { machineId: m2, name: "Grease", everyHours: 0.1 } });
  const due = (await lib.listMaintenanceTasks(d1)).filter(t => t.status === "due");
  ok("due tasks name their machine", due.length === 0 || due.every(t => t.machineName));
  // Run Machine 2 a little so its new task is due.
  const a6 = await timedRun("a", m2, 10);
  await call({ action: "completeRun", runId: a6.runId, org: "acme", orderId: a6.orderId });
  const comms = (await call({ action: "getPendingCommunications" })).body;
  ok("Communications lists maintenance that's due", (comms.maintenanceDue || []).some(t => t.name === "Grease" && t.machineName === "Machine 2"));
  const emailSrc = read("functions/_lib/email.js");
  ok("the roll-up and the quiet-morning email list it, and it's not a reason to send on its own",
    /MACHINE MAINTENANCE DUE/.test(emailSrc) && /Machine maintenance due:/.test(emailSrc) && !/!maintenanceDue\.length/.test(read("functions/api/daily-digest.js")));

  console.log("\n=== Roles ===");
  const ordersSrc = read("functions/api/orders.js");
  const staffList = ordersSrc.slice(ordersSrc.indexOf("const STAFF_ACTIONS"), ordersSrc.indexOf("];", ordersSrc.indexOf("const STAFF_ACTIONS")));
  ok("every new action is a worker's (production staff)", ["setMachineStitchCount", "listMaintenanceTasks", "saveMaintenanceTask", "deleteMaintenanceTask", "recordMaintenance",
    "getMaintenanceLog", "setDesignVersionStitches", "fillDesignStitchCounts"].every(a => staffList.includes(`"${a}"`)));
  // OpenDecoDesk: machine maintenance belongs to the production feature (Global settings → Features).
  await lib.setFeatures(d1, { production: false });
  const prodList = ordersSrc.slice(ordersSrc.indexOf("const FEATURE_ACTIONS"), ordersSrc.indexOf("bookkeeping: [", ordersSrc.indexOf("const FEATURE_ACTIONS")));
  ok("the maintenance actions are production's, so switching it off refuses them (the gate itself: test106)", ["setMachineStitchCount", "listMaintenanceTasks",
    "saveMaintenanceTask", "deleteMaintenanceTask", "recordMaintenance", "getMaintenanceLog", "setDesignVersionStitches", "fillDesignStitchCounts"].every(a => prodList.includes(`"${a}"`)));
  const commsOff = (await call({ action: "getPendingCommunications" })).body;
  ok("…and Communications lists no maintenance", commsOff.status === "ok" && (commsOff.maintenanceDue || []).length === 0);
  ok("…nor does the roll-up (it checks the feature)", /getFeatures\(env\.DB\)[\s\S]{0,120}\.production\s*\?\s*\(await listMaintenanceTasks/.test(read("functions/api/daily-digest.js")));
  ok("…and the Machine maintenance page belongs to production", /maintenance: "production"/.test(read("public/admin.js")));
  await lib.setFeatures(d1, { production: true });

  // ---- The real admin screens, in jsdom, talking to the real API above ----------------------
  console.log("\n=== Screens ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const sent = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = async (url, opts) => {
        if (String(url).includes("/api/orders") && opts && opts.body) {
          const body = JSON.parse(opts.body); sent.push(body);
          const res = await call(body);
          return { ok: res.status < 400, status: res.status, json: async () => res.body };
        }
        if (String(url).includes("127.0.0.1")) throw new Error("no agent in tests");
        return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) };
      };
      autoConfirm(win, () => true);
    } });
  const w = dom.window, doc = w.document;
  await tick(150);
  await w.loadAdminScript();
  w.eval('adminKey = "x";');
  const app = doc.getElementById("app");
  const settle = async (pred) => { for (let i = 0; i < 80 && !pred(); i++) await tick(25); };

  ok("the browser's parsers count the same stitches as the server's", w.parseDst_(dstA.buffer).stitchCount === sc.countDstStitches(dstA)
    && w.parseDsb_(dsbA.buffer).stitchCount === sc.countDsbStitches(dsbA));

  await w.renderMachines(app);
  await settle(() => app.querySelector(".mch-counter"));
  const card = () => [...app.querySelectorAll("#mchBody > div")].find(d => /Machine 2/.test(d.textContent));
  ok("each machine card shows its stitch counter, run time and tasks", /Stitch counter:/.test(card().textContent) && /Run time:/.test(card().textContent)
    && card().querySelectorAll(".mch-task").length === 1 && card().querySelector(".maint-chip.maint-due"));
  ok("Machine 1's card shows its counter from the reading", /Stitch counter: 0/.test([...app.querySelectorAll("#mchBody > div")].find(d => /Machine 1/.test(d.textContent)).textContent));

  // Enter a reading.
  [...card().querySelectorAll("button")].find(b => /Enter machine reading/.test(b.textContent)).click();
  await settle(() => doc.getElementById("mrStitches"));
  doc.getElementById("mrStitches").value = "7,654,321";
  doc.getElementById("mrSave").click();
  await settle(() => !doc.getElementById("mrStitches"));
  await settle(() => /7,654,321/.test(card().textContent));
  ok("Enter machine reading saves it and the card updates", machine(m2).stitchCount === 7654321 && /7,654,321/.test(card().textContent)
    && sent.some(b => b.action === "setMachineStitchCount" && b.reading === "7654321"));

  // Tasks… → add the common ones.
  [...card().querySelectorAll("button")].find(b => /Tasks/.test(b.textContent)).click();
  await settle(() => doc.querySelector(".mtCommonTick"));
  ok("the Tasks window lists the machine's tasks and the common ones", doc.querySelectorAll("#mtList tr[data-tid]").length === 1 && doc.querySelectorAll(".mtCommonTick").length === 4);
  doc.querySelectorAll(".mtCommonTick")[0].checked = true;
  doc.querySelectorAll(".mtCommonTick")[2].checked = true;
  doc.getElementById("mtAddCommon").click();
  await settle(() => doc.querySelectorAll("#mtList tr[data-tid]").length === 3);
  const m2Tasks = (await lib.listMaintenanceTasks(d1, m2));
  ok("ticked common tasks are added with their thresholds", m2Tasks.length === 3 && m2Tasks.some(t => t.name === "Oil the rotary hook" && t.everySeconds === 4 * 3600)
    && m2Tasks.some(t => t.name === "Change needles" && t.everyStitches === 2000000));
  // Edit one in place.
  const row = [...doc.querySelectorAll("#mtList tr[data-tid]")].find(tr => /Oil/.test(tr.querySelector('[data-f="name"]').value));
  row.querySelector('[data-f="everyHours"]').value = "6";
  row.querySelector(".mtSave").click();
  await settle(() => lib.listMaintenanceTasks(d1, m2).then(() => true));
  await tick(100);
  ok("a task's hours are edited in place", (await lib.listMaintenanceTasks(d1, m2)).find(t => t.name === "Oil the rotary hook").everySeconds === 6 * 3600);
  ok("...and the machine card behind it already lists it", card().querySelectorAll(".mch-task").length === 3);
  doc.getElementById("mtClose").click();

  // Done on the due task.
  const dueBtn = [...card().querySelectorAll(".mch-task")].find(t => t.querySelector(".maint-due")).querySelector("button");
  dueBtn.click();
  await settle(() => doc.getElementById("mdSave"));
  doc.getElementById("mdNote").value = "Greased the needle bars";
  doc.getElementById("mdSave").click();
  await settle(() => !doc.getElementById("mdSave"));
  await tick(50);
  ok("Done records it and the task is no longer due", d1.q("SELECT note FROM machine_maintenance_log ORDER BY id DESC LIMIT 1")[0].note === "Greased the needle bars"
    && !card().querySelector(".maint-chip.maint-due"));

  // The maintenance page.
  await w.renderMaintenance(app, String(m2));
  await settle(() => app.querySelector(".mnt-log"));
  ok("Machine maintenance shows the log, the readings and the runs per day", /Grease/.test(app.textContent) && app.querySelector(".mnt-reading") && app.querySelector(".mnt-usage")
    && /7,654,321/.test(app.textContent));
  ok("...for the machine in the address", doc.getElementById("mntMachine").value === String(m2) && ![...app.querySelectorAll(".mnt-log")].some(r => /Replaced the hook/.test(r.textContent)));
  ok("the page is in the Production menu and open to workers", w.eval("ADMIN_NAV_GROUPS").find(g => g.label === "Production").items.some(i => i[0] === "maintenance") && w.adminPageRole_("#maintenance/3") === "staff");

  // Run Order's warning and the abort box.
  const warn = w.runMaintWarnHtml_({ id: 4, maintenanceDue: [{ name: "Oil the rotary hook", status: "due" }, { name: "Clean <lint>", status: "soon" }] });
  ok("Run Order warns about maintenance due on the proposed machine (escaped)", /⚠ Oil the rotary hook due/.test(warn) && /Clean &lt;lint&gt; due soon/.test(warn) && /#maintenance\/4/.test(warn)
    && w.runMaintWarnHtml_({ maintenanceDue: [] }) === "");
  const a7 = await timedRun("a", m1, 3);
  w.eval("window._roCtx = { abortReasons: [] }; window.refreshRunOrder_ = async () => {};");
  w.showAbortModal_(a7.runId, "acme", a7.orderId);
  await settle(() => doc.getElementById("abStitches"));
  doc.getElementById("abStitches").value = "1,234";
  doc.getElementById("abDo").click();
  await settle(() => d1.q(`SELECT status FROM production_runs WHERE id=${a7.runId}`)[0].status === "aborted");
  ok("the abort window sends the stitches run", sent.some(b => b.action === "abortRun" && b.stitchesRun === "1234")
    && Number(d1.q(`SELECT stitchesCounted FROM production_runs WHERE id=${a7.runId}`)[0].stitchesCounted) === 1234);

  // Run Times report.
  await w.renderRunReport(app);
  await settle(() => app.querySelector(".rr-stitches"));
  ok("Run Times shows stitch columns and a stitch summary", /Avg stitches/.test(app.textContent) && /Stitches\/min/.test(app.textContent) && doc.getElementById("rrStitchSummary")
    && /untimed run/.test(doc.getElementById("rrStitchSummary").textContent));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test crashed:", false); process.exit(1); });
