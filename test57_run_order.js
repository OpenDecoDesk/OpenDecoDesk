const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Production run management: the Run Order screen — getProductionQueue (real SQL via
// sql.js), the real admin API (getProductionQueue / markManufacturedOnMachine), and the pure
// client-side scoring functions (hoopChangeCost_ / needleReadiness_ / proposeMachine_).

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, createHoop, createThread, saveDesign, addDesignVersion,
  setProductDesign, createProduct, setBlankLink, createBlank, saveMachine, getMachine, getProductionQueue };`)();
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

  // ---- Fixture: an org, a product with a linked design (hoop + 2-color thread map), a blank ----
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Acme','t','t');`);
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 20, personalizationPrice: 3, visible: true });
  const blankId = (await lib.createBlank(d1, { name: "Richardson 112", brand: "Richardson", color: "Navy", productType: "cap" })).id;
  await lib.setBlankLink(d1, "acme", "cap", "OSFA", blankId, "OSFA");

  const roundHoop = await lib.createHoop(d1, { name: "4in Round", isCapFrame: false });
  const capHoop = await lib.createHoop(d1, { name: "Cap Frame", isCapFrame: true });
  const threadRed = await lib.createThread(d1, { brand: "Madeira", type: "PolyNeon", weight: "40", code: "1147", name: "Red", colorHex: "cc2222" });
  const threadBlue = await lib.createThread(d1, { brand: "Madeira", type: "PolyNeon", weight: "40", code: "1201", name: "Blue", colorHex: "2222cc" });

  const designId = await lib.saveDesign(d1, "acme", { name: "Club Logo", stabilizer: "medium cutaway", hoopId: capHoop });
  await lib.addDesignVersion(d1, designId, { designFileKey: "designs/1/a.emb", designFileName: "a.emb", designFileExt: "emb",
    machineFileKey: "designs/1/a.dst", machineFileName: "a.dst", machineFileExt: "dst",
    threadColors: [{ needle: 1, threadId: threadRed }, { needle: 2, threadId: threadBlue }] });
  await lib.setProductDesign(d1, "acme", "cap", designId);

  const machine1 = await lib.saveMachine(d1, { name: "Machine 1", needleCount: 12, hoopIds: [roundHoop] }); // wrong hoop, not eligible
  const machine2 = await lib.saveMachine(d1, { name: "Machine 2", needleCount: 15, hoopIds: [capHoop] });   // eligible, cap already mounted
  await d1.prepare("UPDATE machines SET currentHoopId=? WHERE id=?").bind(capHoop, machine2).run();
  await d1.prepare("INSERT INTO machine_needles (machineId, needle, threadId, updatedAt) VALUES (?, 1, ?, 't')").bind(machine2, threadRed).run(); // needle 1 already correct

  const order = async (id, dates = {}, itemExtra = {}) => {
    await lib.insertOrder(d1, { orderId: id, orgId: "acme", customerName: "Cust " + id, contact: id + "@x.com", placedAt: "2026-07-01T00:00:00Z" },
      [Object.assign({ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 2, unitPrice: 20 }, itemExtra)]);
    for (const [col, v] of Object.entries(dates)) d1._raw.run(`UPDATE orders SET ${col}=? WHERE orderId=?`, [v, id]);
  };

  console.log("=== db.js: getProductionQueue ===");
  // Ready to run: paid, design approved, blank received, not yet manufactured.
  await order("READY", { paid: 1, blankReceivedAt: "2026-07-05T00:00:00Z", designApprovedAt: "2026-07-06T00:00:00Z" });
  // Not ready: free-form personalization needs a design approval, and there isn't one yet. (Without
  // personalization it WOULD be ready — the cap has a design, so neither approval nor digitizing is
  // needed; test70 covers those rules.)
  await order("NOTREADY", { paid: 1, blankReceivedAt: "2026-07-05T00:00:00Z" }, { personalized: true, persName: "SAM" });
  // Already manufactured — should NOT appear.
  await order("DONE", { paid: 1, blankReceivedAt: "2026-07-05T00:00:00Z", designApprovedAt: "2026-07-06T00:00:00Z", manufacturedAt: "2026-07-07T00:00:00Z" });
  // Unpaid — should NOT appear.
  await order("UNPAID", { blankReceivedAt: "2026-07-05T00:00:00Z", designApprovedAt: "2026-07-06T00:00:00Z" });
  // Voided — should NOT appear even though otherwise ready.
  await order("VOID", { paid: 1, blankReceivedAt: "2026-07-05T00:00:00Z", designApprovedAt: "2026-07-06T00:00:00Z", voidedAt: "2026-07-08T00:00:00Z" });
  // Test order — should NOT appear.
  await order("TEST-1", { paid: 1, blankReceivedAt: "2026-07-05T00:00:00Z", designApprovedAt: "2026-07-06T00:00:00Z", isTest: 1 });

  let queue = await lib.getProductionQueue(d1);
  console.log("only the truly ready order appears:", queue.length === 1 && queue[0].orderId === "READY");
  const job = queue[0];
  console.log("joins blank, design, hoop, and thread map correctly:",
    job.blank.name === "Richardson 112" && job.design.name === "Club Logo" && job.design.hoopName === "Cap Frame" &&
    job.design.threadColors.length === 2 && job.design.threadColors[0].threadId === threadRed);
  console.log("exposes the CURRENT version's machine file (what Send design to machine sends, never the native design file):",
    job.design.machineFileKey === "designs/1/a.dst" && job.design.machineFileName === "a.dst");
  console.log("activeItemCount and org/customer carried through:", job.activeItemCount === 1 && job.orgName === "Acme" && job.customerName === "Cust READY");
  console.log("exposes per-piece progress (qty 2, none made, 2 remaining):", job.qty === 2 && job.manufacturedQty === 0 && job.remaining === 2);

  console.log("\n=== db.js: manufacturing an order removes it from the queue ===");
  d1._raw.run("UPDATE orders SET manufacturedAt=? WHERE orderId='READY'", ["2026-07-09T00:00:00Z"]);
  queue = await lib.getProductionQueue(d1);
  console.log("gone once manufactured:", queue.length === 0);
  d1._raw.run("UPDATE orders SET manufacturedAt=NULL WHERE orderId='READY'"); // put it back for the API tests below

  console.log("\n=== Real admin API: getProductionQueue ===");
  let r = await call({ action: "getProductionQueue" });
  console.log("action returns the same one ready job:", r.status === 200 && r.body.queue.length === 1 && r.body.queue[0].orderId === "READY");

  console.log("\n=== Real admin API: markManufacturedOnMachine (per physical piece) ===");
  const readyItemId = Number((await d1.prepare("SELECT id FROM order_items WHERE orderId='READY'").first()).id);
  console.log("missing itemId is refused (400):", (await call({ action: "markManufacturedOnMachine", org: "acme", orderId: "READY" })).status === 400);
  r = await call({ action: "markManufacturedOnMachine", org: "acme", orderId: "READY", itemId: readyItemId, machineId: machine2, hoopId: capHoop });
  console.log("marking one piece succeeds, order NOT yet complete (qty 2):", r.status === 200 && r.body.orderComplete === false);
  console.log("order not manufactured after just one piece:", !(await lib.getOrderById(d1, "READY")).manufacturedAt);
  r = await call({ action: "getProductionQueue" });
  console.log("still queued with one piece remaining:", r.body.queue.length === 1 && r.body.queue[0].manufacturedQty === 1 && r.body.queue[0].remaining === 1);
  r = await call({ action: "markManufacturedOnMachine", org: "acme", orderId: "READY", itemId: readyItemId, machineId: machine2, hoopId: capHoop });
  console.log("marking the last piece completes the order:", r.status === 200 && r.body.orderComplete === true);
  console.log("order actually marked manufactured once all pieces done:", !!(await lib.getOrderById(d1, "READY")).manufacturedAt);
  r = await call({ action: "getProductionQueue" });
  console.log("gone from the queue afterward:", r.body.queue.length === 0);
  const m2 = await lib.getMachine(d1, machine2);
  console.log("chosen machine's hoop updated to the design's required hoop (it was mounted to run):", m2.currentHoopId === capHoop);
  console.log("the machine's needle LOADOUT is NOT overwritten by the design's colour sequence (stays as the operator set it):",
    m2.needles[1] === threadRed && m2.needles[2] === undefined);

  console.log("\n=== Real admin API: markManufacturedOnMachine with no machine still marks pieces ===");
  await order("READY2", { paid: 1, blankReceivedAt: "2026-07-05T00:00:00Z", designApprovedAt: "2026-07-06T00:00:00Z" });
  const ready2ItemId = Number((await d1.prepare("SELECT id FROM order_items WHERE orderId='READY2'").first()).id);
  await call({ action: "markManufacturedOnMachine", org: "acme", orderId: "READY2", itemId: ready2ItemId, machineId: null, hoopId: null });
  r = await call({ action: "markManufacturedOnMachine", org: "acme", orderId: "READY2", itemId: ready2ItemId, machineId: null, hoopId: null });
  console.log("succeeds with no machine chosen and completes after all pieces:",
    r.status === 200 && r.body.orderComplete === true && !!(await lib.getOrderById(d1, "READY2")).manufacturedAt);

  console.log("\n=== Client-side pure functions: hoopChangeCost_ / needleReadiness_ / proposeMachine_ ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();

  const hoopsById = { [roundHoop]: { id: roundHoop, name: "4in Round", isCapFrame: false }, [capHoop]: { id: capHoop, name: "Cap Frame", isCapFrame: true } };
  console.log("same hoop already mounted -> 0:", w.hoopChangeCost_({ currentHoopId: roundHoop }, roundHoop, hoopsById) === 0);
  console.log("no required hoop -> 0:", w.hoopChangeCost_({ currentHoopId: roundHoop }, null, hoopsById) === 0);
  const thirdHoop = 999;
  hoopsById[thirdHoop] = { id: thirdHoop, name: "6in Oval", isCapFrame: false };
  console.log("swap between two non-cap hoops -> small, nonzero cost:", w.hoopChangeCost_({ currentHoopId: roundHoop }, thirdHoop, hoopsById) > 0);
  const nonCapSwap = w.hoopChangeCost_({ currentHoopId: roundHoop }, thirdHoop, hoopsById);
  const capSwap = w.hoopChangeCost_({ currentHoopId: roundHoop }, capHoop, hoopsById);
  console.log("a swap to/from a cap frame costs strictly more than a non-cap swap:", capSwap > nonCapSwap && nonCapSwap > 0);

  // Design colours map to machine needles BY THREAD, not by position: machine has thread1 on
  // needle 1, thread2 on needle 5 (not needle 2!), thread3 nowhere.
  const readiness = w.needleReadiness_([{ needle: 1, threadId: 1 }, { needle: 2, threadId: 2 }, { needle: 3, threadId: 3 }],
    { 1: 1, 2: 5, 5: 2 });
  console.log("colour's thread loaded -> ready, pointing at its needle (thread1 on needle1):", readiness[0].status === "ready" && readiness[0].machineNeedle === 1);
  console.log("thread on a DIFFERENT-numbered needle is still ready, pointing there (thread2 lives on needle5, NOT needle2):", readiness[1].status === "ready" && readiness[1].machineNeedle === 5);
  console.log("thread not loaded anywhere -> load from rack:", readiness[2].status === "load" && readiness[2].machineNeedle === null);
  // A colour loaded on several needles lists them all.
  const multi = w.needleReadiness_([{ needle: 1, threadId: 7 }], { 3: 7, 1: 7, 9: 7 });
  console.log("a colour on multiple needles → lowest first, all listed:", multi[0].machineNeedle === 1 && multi[0].machineNeedles.join(",") === "1,3,9");

  const machines = [
    { id: 1, name: "M1", currentHoopId: roundHoop, hoopIds: [roundHoop] },
    { id: 2, name: "M2", currentHoopId: capHoop, hoopIds: [capHoop] },
    { id: 3, name: "M3", currentHoopId: null, hoopIds: [roundHoop, capHoop] },
  ];
  const propose = w.proposeMachine_({ hoopId: capHoop }, machines, hoopsById);
  console.log("only machines supporting the required hoop are eligible:", propose.eligible.length === 2 && propose.eligible.every(m => m.id !== 1));
  console.log("the machine that already has it mounted is proposed:", propose.proposedId === 2);
  const proposeNoHoop = w.proposeMachine_({ hoopId: null }, machines, hoopsById);
  console.log("a design with no required hoop makes every machine eligible:", proposeNoHoop.eligible.length === 3);

  console.log("\n=== Screen wiring ===");
  console.log("Run Order is a top-level header button (right of Orders) and routed:",
    /navGo\('runorder'\)">Run Order</.test(adminJs) && /renderRunOrder\(app\)/.test(adminJs));
  console.log("Mark done (no timing) button + its per-hooping action exist:", /class="run-btn"/.test(adminJs) && /action: "markHoopingDone"/.test(adminJs));
  console.log("qty>1 lines split into per-piece cards (pkey, piece label, per-piece itemId sent):",
    /data-pkey=/.test(adminJs) && /Piece \$\{pieceNoShown\} of \$\{job\.qty\}/.test(adminJs) && /itemId: card\.job\.itemId/.test(adminJs));
  console.log("each job card renders the design (cached DST canvas coloured by the thread map):",
    /class="run-job-canvas"/.test(adminJs) && /function renderRunPreviews_/.test(adminJs) && /renderDstPreview_\(canvas, window\._roDstCache\[key\]/.test(adminJs));
  console.log("Send design to machine wiring exists — agent URL, ping check, send button:",
    /EMBROIDERY_AGENT_URL = "http:\/\/127\.0\.0\.1:8787"/.test(adminJs) && /function checkSendAgent_/.test(adminJs) &&
    /function sendDesignToMachine_/.test(adminJs) && /run-send-btn/.test(adminJs));
  console.log("Machine Files tool is in the persistent admin header, routed, and wired to list/delete/send:",
    /\["machinefiles", "Machine files"\]/.test(adminJs) && /renderMachineFiles\(app\)/.test(adminJs) &&
    /function listMachineFiles_/.test(adminJs) && /function deleteMachineFile_/.test(adminJs) &&
    /agentFetch_\("\/list"/.test(adminJs) && /agentFetch_\("\/delete"/.test(adminJs) && /agentFetch_\("\/send"/.test(adminJs));
  console.log("Scan for machines is wired into the Machines screen via the agent's /discover:",
    /id="mchScanBtn"/.test(adminJs) && /function showMachineScanModal_/.test(adminJs) &&
    /agentFetch_\("\/discover"/.test(adminJs));

  console.log("\n=== Send vs. Resend: already-on-machine detection ===");
  // The machine stores an upload as <base>.<NNN> (".DST" stripped, sequence appended), so the sent
  // name never equals the on-machine name — the match must be by base name, case-insensitively.
  const files = [{ name: "LOGO.031" }, { name: "Sample Cap Small Logo.020" }, { name: "OTHER.007" }];
  console.log("design already on machine under its <base>.<NNN> name → matched (logo.dst ⇔ LOGO.031):",
    w.machineHasFile_(files, "logo.dst") === true);
  console.log("match ignores case and the sequence suffix (Sample Cap Small Logo.dst ⇔ .020):",
    w.machineHasFile_(files, "Sample Cap Small Logo.DST") === true);
  console.log("a design NOT on the machine → no match:", w.machineHasFile_(files, "brand new.dst") === false);
  console.log("empty name or empty listing → no match (never a false positive):",
    w.machineHasFile_(files, "") === false && w.machineHasFile_([], "logo.dst") === false && w.machineHasFile_(null, "logo.dst") === false);
  console.log("fileBaseKey_ strips exactly one trailing segment and lowercases:",
    w.fileBaseKey_("V4.2 Logo.020") === "v4.2 logo" && w.fileBaseKey_("Design.DST") === "design");
  console.log("Run Order relabels Send→Resend (updateRunSendLabels_, machineHasFile_, cached per machine):",
    /function updateRunSendLabels_/.test(adminJs) && /Resend design \(already on machine\)/.test(adminJs) &&
    /window\._roMachineFiles/.test(adminJs));
  console.log("Machine Files relabels its Send button by the loaded listing (relabelSend/_mfRelabelSend):",
    /window\._mfRelabelSend/.test(adminJs) && /Resend to machine/.test(adminJs) && /window\._mfCtx\.files/.test(adminJs));
  console.log("sendDesignToMachine_ reports success so callers can invalidate + relabel, and says Resent/Sent:",
    /return true;/.test(adminJs) && /\$\{already \? "Resent" : "Sent"\}/.test(adminJs));

  console.log("\n=== Machine Files: show-delete global setting ===");
  let ms = await call({ action: "getMachineSettings" });
  console.log("defaults to hidden (showDeleteButton false):", ms.status === 200 && ms.body.machineSettings.showDeleteButton === false);
  ms = await call({ action: "updateMachineSettings", machineSettings: { showDeleteButton: true } });
  console.log("update returns the saved value:", ms.status === 200 && ms.body.machineSettings.showDeleteButton === true);
  ms = await call({ action: "getMachineSettings" });
  console.log("persisted across reads:", ms.body.machineSettings.showDeleteButton === true);
  ms = await call({ action: "updateMachineSettings", machineSettings: { showDeleteButton: "" } });
  console.log("coerces truthiness to a real boolean:", ms.body.machineSettings.showDeleteButton === false);
  console.log("Global Settings form has the toggle + saves it:",
    /id="gMachShowDelete"/.test(adminJs) && /action: "updateMachineSettings"/.test(adminJs) && /action: "getMachineSettings"/.test(adminJs));
  console.log("Machine Files reads the setting on load and gates the Delete button on it:",
    /action: "getMachineSettings"/.test(adminJs) && /window\._mfCtx\.showDelete/.test(adminJs) && /showDelete \?/.test(adminJs));

  console.log("\n=== Optional due date prioritizes the Run Order queue (migrations/0038) ===");
  // Three fresh ready-to-run orders; set due dates via the real admin action.
  for (const id of ["DUEA", "DUEB", "NODUE"]) await order(id, { paid: 1, blankReceivedAt: "2026-07-05T00:00:00Z", designApprovedAt: "2026-07-06T00:00:00Z" });
  console.log("setOrderDueDate persists a date and clears it:",
    (await call({ action: "setOrderDueDate", org: "acme", orderId: "DUEA", dueDate: "2026-07-20" })).body.dueDate === "2026-07-20" &&
    (await call({ action: "setOrderDueDate", org: "acme", orderId: "DUEA", dueDate: "" })).body.dueDate === "");
  console.log("a bad date is refused (400):", (await call({ action: "setOrderDueDate", org: "acme", orderId: "DUEA", dueDate: "nope" })).status === 400);
  await call({ action: "setOrderDueDate", org: "acme", orderId: "DUEA", dueDate: "2026-07-20" });
  await call({ action: "setOrderDueDate", org: "acme", orderId: "DUEB", dueDate: "2026-07-12" });
  // NODUE left with no due date.
  const q = await lib.getProductionQueue(d1);
  const pos = (oid) => q.findIndex(j => j.orderId === oid);
  console.log("soonest due first, undated orders after all dated ones:",
    pos("DUEB") >= 0 && pos("DUEB") < pos("DUEA") && pos("DUEA") < pos("NODUE") &&
    q.filter(j => j.dueDate).every((j, i, arr) => i === 0 || arr[i - 1].dueDate <= j.dueDate));
  console.log("the queue exposes dueDate on each job:", q.find(j => j.orderId === "DUEB").dueDate === "2026-07-12");
  console.log("admin surfaces the due date (Orders column + editor + run-queue badge):",
    /<th>Due<\/th>/.test(adminJs) && /function editOrderDueDate/.test(adminJs) && /action: "setOrderDates"/.test(adminJs) &&
    /function dueBadge_/.test(adminJs) && /dueBadge_\(job\.dueDate\)/.test(adminJs) && /dueBadge_\(c\.dueDate\)/.test(adminJs));

  console.log("\n=== Both run pages list all paid-but-not-run orders, due first ===");
  // DUEA(2026-07-20), DUEB(2026-07-12) dated above; NODUE/READY undated. All paid, not manufactured.
  const pu = await call({ action: "getProductionQueue" });
  const ids = (pu.body.paidUnrun || []).map(o => o.orderId);
  console.log("getProductionQueue returns a paidUnrun backlog, due-date first then undated:",
    ids.includes("DUEA") && ids.includes("DUEB") && ids.includes("NODUE") &&
    ids.indexOf("DUEB") < ids.indexOf("DUEA") && ids.indexOf("DUEA") < ids.indexOf("NODUE"));
  console.log("each backlog row carries dueDate, customer, items and a blanks flag:",
    (() => { const b = (pu.body.paidUnrun || []).find(o => o.orderId === "DUEB"); return b && b.dueDate === "2026-07-12" && b.customerName === "Cust DUEB" && Array.isArray(b.items) && typeof b.blankReceived === "boolean"; })());
  const tq = await call({ action: "getTransferQueue" });
  console.log("getTransferQueue returns the same paidUnrun backlog:", Array.isArray(tq.body.paidUnrun) && tq.body.paidUnrun.some(o => o.orderId === "DUEB"));
  console.log("both run pages render it via paidUnrunHtml_:",
    /function paidUnrunHtml_/.test(adminJs) && /paidUnrunHtml_\(paidUnrun\)/.test(adminJs) && /paidUnrunHtml_\(data\.paidUnrun \|\| \[\]\)/.test(adminJs) &&
    /Paid, not yet run — by due date/.test(adminJs));
  console.log("run backlog shows 'Blanks not ordered yet' (not the old 'No blanks yet' status):",
    /Blanks not ordered yet<\/span>/.test(adminJs) && !/>No blanks yet<\/span>/.test(adminJs));

  console.log("\n=== Bulk set due date from the orders bulk bar ===");
  let bd = await call({ action: "bulkSetDueDate", org: "acme", orderIds: ["DUEA", "NODUE"], dueDate: "2026-08-01" });
  console.log("bulkSetDueDate sets the date on every selected order:", bd.status === 200 && bd.body.updated === 2 &&
    (await lib.getOrderById(d1, "DUEA")).dueDate === "2026-08-01" && (await lib.getOrderById(d1, "NODUE")).dueDate === "2026-08-01");
  bd = await call({ action: "bulkSetDueDate", org: "acme", orderIds: ["NODUE"], dueDate: "" });
  console.log("clearing works too:", bd.body.updated === 1 && (await lib.getOrderById(d1, "NODUE")).dueDate === "");
  console.log("a bad date is refused (400):", (await call({ action: "bulkSetDueDate", org: "acme", orderIds: ["DUEA"], dueDate: "nope" })).status === 400);
  console.log("the bulk bar wires a Set-due-date button + handler:",
    /onclick="bulkSetDueDate\(this\.dataset\.org\)"/.test(adminJs) && /async function bulkSetDueDate\(orgId\)/.test(adminJs) && /action: "bulkSetDueDate"/.test(adminJs));
})();
