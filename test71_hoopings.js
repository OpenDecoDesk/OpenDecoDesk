const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Multiple hoopings per piece (migrations/0032): designs with several hoops (on their own / with a
// typed-in name), products with several designs (run order, one MAIN), a pick list mapped option →
// design (always its own hooping), typed-in personalization combined with the main design or its
// own hooping (needs an order-specific design uploaded), and Run Order tracking each hooping's start
// and finish separately until the piece is made. Real migrations + db.js + orders.js on sql.js.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, createHoop, createThread, saveDesign, getDesign, listDesigns, deleteDesign, deleteHoop,
  addDesignVersion, setProductDesign, setProductDesigns, listProductDesigns, createProduct, getProductsByOrg, saveMachine, getMachine,
  getProductionQueue, addOrderItemDesign, getRunReportByDesign };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

const migrationsUpTo = (upTo) => fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && (!upTo || f < upTo)).sort();

(async () => {
  try {
    console.log("=== Migration 0032 backfills from the one-design / one-hoop columns ===");
    {
      const d1 = await createD1();
      d1._raw.exec(read("testlib/schema-pre-0006.sql"));
      for (const f of migrationsUpTo("0032")) d1.execFile(read("migrations/" + f));
      d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','PRIME','t','t');
        INSERT INTO hoops (id, name, isCapFrame, createdAt, updatedAt) VALUES (5, 'Cap frame', 1, 't', 't');
        INSERT INTO designs (id, orgId, name, hoopId, createdAt, updatedAt) VALUES (7, 'prime', 'Crest', 5, 't', 't');
        INSERT INTO products (productId, orgId, type, name, pricingMode, createdAt, updatedAt, designId) VALUES ('cap', 'prime', 'cap', 'Cap', 'flat', 't', 't', 7);`);
      d1.execFile(read("migrations/0032_hoopings.sql"));
      console.log("a design's hoop becomes its first 'design' hoop:", JSON.stringify(d1.q("SELECT designId, hoopId, purpose FROM design_hoops")) === '[{"designId":7,"hoopId":5,"purpose":"design"}]');
      const pd = d1.q("SELECT designId, isMain, placement FROM product_designs WHERE productId='cap'");
      console.log("a product's design becomes its MAIN design:", pd.length === 1 && pd[0].designId === 7 && pd[0].isMain === 1);
      console.log("existing products default to 'combined' personalization with no pick-list map:",
        JSON.stringify(d1.q("SELECT personalizationMode m, personalizationOptionDesigns o FROM products")[0]) === '{"m":"combined","o":"{}"}');
    }

    const d1 = await createD1();
    d1._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of migrationsUpTo()) d1.execFile(read("migrations/" + f));
    const call = async (body) => {
      const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
        request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
      return { status: res.status, body: JSON.parse(await res.text()) };
    };
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','PRIME','t','t'), ('other','other','Other','t','t');`);
    const capFrame = await lib.createHoop(d1, { name: "Cap frame", isCapFrame: true });
    const flat = await lib.createHoop(d1, { name: "Flat 4in", isCapFrame: false });
    const small = await lib.createHoop(d1, { name: "6.9in", isCapFrame: false });
    const big = await lib.createHoop(d1, { name: "7.7x12.5in", isCapFrame: false });
    const red = await lib.createThread(d1, { brand: "Madeira", type: "PolyNeon", weight: "40", code: "1", name: "Red", colorHex: "cc0000" });
    const gold = await lib.createThread(d1, { brand: "Madeira", type: "PolyNeon", weight: "40", code: "2", name: "Gold", colorHex: "ccaa00" });
    const version = (designId, name, threadId) => lib.addDesignVersion(d1, designId, { designFileKey: `designs/${designId}/a.emb`, designFileName: name + ".emb",
      machineFileKey: `designs/${designId}/a.dst`, machineFileName: name + ".DST", machineFileExt: "dst", threadColors: [{ needle: 1, threadId }] });

    console.log("\n=== Designs: several hoops, on their own and with a typed-in name ===");
    const front = await lib.saveDesign(d1, "prime", { name: "Cap front", hoopIds: [capFrame] });
    const back = await lib.saveDesign(d1, "prime", { name: "Cap back", hoopIds: [capFrame] });
    const coach = await lib.saveDesign(d1, "prime", { name: "Closure COACH", hoopIds: [flat] });
    const captain = await lib.saveDesign(d1, "prime", { name: "Closure CAPTAIN", hoopIds: [flat] });
    const chest = await lib.saveDesign(d1, "prime", { name: "Left chest", hoopIds: [small], personalizationHoopIds: [big] });
    const otherShop = await lib.saveDesign(d1, "other", { name: "Not ours", hoopIds: [flat] });
    for (const [id, n, t] of [[front, "FRONT", red], [back, "BACK", gold], [coach, "COACH", gold], [captain, "CAPTAIN", gold], [chest, "CHEST", red]]) await version(id, n, t);
    let ch = await lib.getDesign(d1, chest);
    console.log("a design keeps its own hoops and its with-a-name hoops:", JSON.stringify(ch.hoopIds) === `[${small}]` && JSON.stringify(ch.personalizationHoopIds) === `[${big}]` && ch.hoopId === small);
    await lib.saveDesign(d1, "prime", { id: chest, name: "Left chest", hoopIds: [small, big] });
    ch = await lib.getDesign(d1, chest);
    console.log("several hoops allowed; saving without the with-a-name list keeps it:", JSON.stringify(ch.hoopIds) === `[${small},${big}]` && JSON.stringify(ch.personalizationHoopIds) === `[${big}]`);
    await lib.saveDesign(d1, "prime", { id: chest, name: "Left chest", hoopIds: [small], personalizationHoopIds: [big] });
    const legacy = await lib.saveDesign(d1, "prime", { name: "Old style", hoopId: flat });
    console.log("an old single hoopId still works (→ one design hoop):", JSON.stringify((await lib.getDesign(d1, legacy)).hoopIds) === `[${flat}]`);
    console.log("listDesigns carries the hoop lists:", (await lib.listDesigns(d1, "prime")).find(d => d.id === chest).personalizationHoopIds[0] === big);

    console.log("\n=== Products: several designs, run order, one main ===");
    await lib.createProduct(d1, "prime", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 25, personalizationPrice: 5, visible: true });
    let r = await call({ action: "setProductDesigns", org: "prime", productId: "cap", designs: [{ designId: front, placement: "Front", isMain: true }, { designId: back, placement: "Back" }] });
    const pds = await lib.listProductDesigns(d1, "prime", "cap");
    console.log("saved in run order with placements and one main:", r.status === 200 && pds.map(x => x.placement).join(",") === "Front,Back" && pds[0].isMain && !pds[1].isMain);
    console.log("products.designId mirrors the main design:", (await d1.prepare("SELECT designId FROM products WHERE productId='cap'").first()).designId === front);
    r = await call({ action: "setProductDesigns", org: "prime", productId: "cap", designs: [{ designId: otherShop }] });
    console.log("another shop's design is refused:", r.status === 400 && /doesn't belong/.test(r.body.message));
    console.log("audited:", d1.q("SELECT count(*) n FROM audit_log WHERE action='product.designs_set'")[0].n === 1);
    console.log("getProductsByOrg lists each product's designs:", (await lib.getProductsByOrg(d1, "prime")).find(p => p.productId === "cap").designs.length === 2);

    console.log("\n=== Pick list: every option needs a design ===");
    const capBody = { action: "updateProduct", org: "prime", productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 25,
      personalizationPrice: 5, personalizationOptions: ["COACH", "CAPTAIN"], visible: true, images: [], personalizationMode: "combined" };
    r = await call(Object.assign({}, capBody, { personalizationOptionDesigns: { COACH: coach } }));
    console.log("an unmapped option is refused, naming it:", r.status === 400 && /CAPTAIN/.test(r.body.message));
    r = await call(Object.assign({}, capBody, { personalizationOptionDesigns: { COACH: coach, "CAPTAIN": otherShop } }));
    console.log("another shop's design is refused:", r.status === 400 && /doesn't belong/.test(r.body.message));
    r = await call(Object.assign({}, capBody, { personalizationOptionDesigns: { COACH: coach, "CAPTAIN": captain, STALE: chest } }));
    const capRow = (await lib.getProductsByOrg(d1, "prime")).find(p => p.productId === "cap");
    console.log("mapped options save (and a stale option drops out of the map):", r.status === 200 &&
      JSON.stringify(capRow.personalizationOptionDesigns) === JSON.stringify({ COACH: coach, "CAPTAIN": captain }));
    await lib.createProduct(d1, "prime", { productId: "shirt", type: "shirt", name: "Shirt", pricingMode: "flat", flatPrice: 30, personalizationPrice: 6, visible: true });
    await lib.setProductDesign(d1, "prime", "shirt", chest);
    const shirtBody = { action: "updateProduct", org: "prime", productId: "shirt", type: "shirt", name: "Shirt", pricingMode: "flat", flatPrice: 30,
      personalizationPrice: 6, personalizationOptions: [], visible: true, images: [], personalizationOptionDesigns: {} };
    r = await call(Object.assign({}, shirtBody, { personalizationMode: "separate" }));
    console.log("typed-in text as its own hooping needs a hoop:", r.status === 400 && /hoop/.test(r.body.message));
    r = await call(Object.assign({}, shirtBody, { personalizationMode: "combined" }));
    console.log("combined with the main design saves:", r.status === 200);

    console.log("\n=== The hoopings each line needs ===");
    const line = (productId, extra) => Object.assign({ productId, name: productId, type: productId === "shirt" ? "shirt" : "cap", size: productId === "shirt" ? "L" : "OSFA", qty: 1, unitPrice: 25 }, extra || {});
    const ready = { paid: 1, blankReceivedAt: "2026-09-03", designApprovedAt: "2026-09-04", digitizingCompleteAt: "2026-09-03" };
    const order = async (id, items, dates = ready) => {
      await lib.insertOrder(d1, { orderId: id, orgId: "prime", customerName: "C " + id, contact: "c@x.com", placedAt: "2026-09-01T00:00:00Z" }, items);
      for (const [col, v] of Object.entries(dates)) d1._raw.run(`UPDATE orders SET ${col}=? WHERE orderId=?`, [v, id]);
      return Number(d1.q(`SELECT id FROM order_items WHERE orderId='${id}' ORDER BY id`)[0].id);
    };
    const jobOf = async (itemId) => (await lib.getProductionQueue(d1)).find(j => j.itemId === itemId);
    const capPlain = await order("CAP-PLAIN", [line("cap")]);
    let job = await jobOf(capPlain);
    console.log("a cap with a front and a back design: two hoopings, in order, each on its own hoops:",
      job.steps.length === 2 && job.steps[0].label === "Front" && job.steps[1].label === "Back" &&
      job.steps.every(s => s.hoopIds.join() === String(capFrame) && !s.blocked) && job.steps[1].machineFileName === "BACK.DST");
    console.log("the old single-design fields still describe the first hooping:", job.design.name === "Cap front" && job.design.hoopId === capFrame);
    const capCoach = await order("CAP-COACH", [line("cap", { personalized: true, persName: "COACH" })]);
    job = await jobOf(capCoach);
    console.log("a pick-list option adds its own hooping with the option's design on a flat hoop:",
      job.steps.length === 3 && job.steps[2].label === "Personalization: COACH" && job.steps[2].designName === "Closure COACH" &&
      job.steps[2].hoopIds.join() === String(flat) && job.steps[2].threadColors[0].threadId === gold);
    const shirtName = await order("SHIRT-NAME", [line("shirt", { personalized: true, persName: "SAMWISE" })]);
    job = await jobOf(shirtName);
    console.log("typed-in text combined: ONE hooping, the main design + name, on the design's with-a-name hoop:",
      job.steps.length === 1 && job.steps[0].kind === "itemDesign" && job.steps[0].hoopIds.join() === String(big) && /\+ personalization/.test(job.steps[0].label));
    console.log("…blocked until the order-specific design is uploaded:", /Upload the order-specific design for "SAMWISE"/.test(job.steps[0].blocked));
    const shirtPlain = await order("SHIRT-PLAIN", [line("shirt")]);
    console.log("the same shirt with no name runs the plain design on its own hoop:", (await jobOf(shirtPlain)).steps[0].hoopIds.join() === String(small));
    const bad = await call({ action: "saveOrderItemDesign", itemId: shirtName, machineFileKey: "designs/1/x.dst" });
    console.log("an order design must be a line-item file:", bad.status === 400);
    r = await call({ action: "saveOrderItemDesign", org: "prime", itemId: shirtName, machineFileKey: `order-files/${shirtName}/abc123.dst`, machineFileName: "SAMWISE.DST",
      machineFileExt: "dst", threadColors: [{ needle: 1, threadId: red }, { needle: 2, threadId: gold }] });
    job = await jobOf(shirtName);
    console.log("after the upload the hooping runs the order design (its file and thread map):", r.status === 200 && !job.steps[0].blocked &&
      job.steps[0].machineFileName === "SAMWISE.DST" && job.steps[0].threadColors.length === 2);
    console.log("getOrderItemDesigns returns it:", (await call({ action: "getOrderItemDesigns", itemId: shirtName })).body.designs[0].machineFileName === "SAMWISE.DST");
    await call(Object.assign({}, shirtBody, { personalizationMode: "separate", personalizationHoopId: flat }));
    job = await jobOf(shirtName);
    console.log("typed-in text as its own hooping: the plain design, then the name on the product's hoop:",
      job.steps.length === 2 && job.steps[0].hoopIds.join() === String(small) && job.steps[1].label === "Personalization" &&
      job.steps[1].hoopIds.join() === String(flat) && job.steps[1].machineFileName === "SAMWISE.DST");
    await call(Object.assign({}, shirtBody, { personalizationMode: "combined" }));

    console.log("\n=== Run Order: each hooping started and finished on its own ===");
    const m1 = await lib.saveMachine(d1, { name: "M1", needleCount: 12, hoopIds: [capFrame, flat] });
    const m2 = await lib.saveMachine(d1, { name: "M2", needleCount: 15, hoopIds: [flat] });
    const start = (b) => call(Object.assign({ action: "startRun", org: "prime", orderId: "CAP-COACH", itemId: capCoach }, b));
    r = await start({ machineId: m1 });
    const run1 = r.body.runId;
    console.log("a new piece starts at hooping 1:", r.status === 200 && r.body.pieceNo === 1 && r.body.stepNo === 1);
    console.log("the machine's mounted hoop becomes the hooping's hoop:", (await lib.getMachine(d1, m1)).currentHoopId === capFrame);
    r = await start({ machineId: m2, pieceNo: 1 });
    console.log("the same piece can't run a second hooping at once:", r.status === 400 && /already running a hooping/.test(r.body.message));
    r = await call({ action: "completeRun", runId: run1, org: "prime", orderId: "CAP-COACH" });
    console.log("finishing hooping 1 of 3 doesn't make the piece — it names the next hooping:", r.status === 200 && r.body.pieceComplete === false && r.body.nextStepNo === 2);
    console.log("no blank used yet:", d1.q(`SELECT manufacturedQty q FROM order_items WHERE id=${capCoach}`)[0].q === 0);
    job = await jobOf(capCoach);
    console.log("the queue shows the piece between hoopings (done [1], next 2), no idle pieces:",
      job.pieces.length === 1 && job.pieces[0].pieceNo === 1 && job.pieces[0].done.join() === "1" && job.pieces[0].nextStepNo === 2 && !job.pieces[0].running && job.idlePieces === 0);
    r = await start({ machineId: m1, pieceNo: 1, stepNo: 3 });
    console.log("hoopings run in order (asking for 3 while 2 is next is refused):", r.status === 400 && /Hooping 2 of this piece is next/.test(r.body.message));
    r = await start({ machineId: m1 });
    console.log("a qty-1 line can't start a second piece:", r.status === 400 && /already started or made/.test(r.body.message));
    r = await start({ machineId: m1, pieceNo: 1, stepNo: 2 });
    const run2 = r.body.runId;
    r = await call({ action: "completeRun", runId: run2, org: "prime", orderId: "CAP-COACH" });
    console.log("hooping 2 done → next is the closure:", r.body.nextStepNo === 3);
    r = await start({ machineId: m2, pieceNo: 1, stepNo: 3, hoopId: capFrame });
    console.log("a hoop that isn't one of the hooping's hoops is refused:", r.status === 400 && /isn't one of this hooping's hoops/.test(r.body.message));
    r = await start({ machineId: m2, pieceNo: 1, stepNo: 3 });
    const run3 = r.body.runId;
    console.log("the closure runs on a flat hoop on another machine:", r.status === 200 && (await lib.getMachine(d1, m2)).currentHoopId === flat);
    r = await call({ action: "completeRun", runId: run3, org: "prime", orderId: "CAP-COACH" });
    console.log("the last hooping makes the piece, uses the blank and finishes the order:", r.body.pieceComplete === true && r.body.orderComplete === true &&
      d1.q(`SELECT manufacturedQty q FROM order_items WHERE id=${capCoach}`)[0].q === 1 && !!(await lib.getOrderById(d1, "CAP-COACH")).manufacturedAt);
    console.log("…and it leaves the queue:", !(await jobOf(capCoach)));
    r = await call({ action: "completeRun", runId: run3 });
    console.log("finishing it twice is refused:", r.status === 400);
    const rows = d1.q(`SELECT stepNo, stepLabel, hoopId, timed, status FROM production_runs WHERE itemId=${capCoach} ORDER BY stepNo`);
    console.log("each hooping has its own timed row with its label and hoop:", rows.length === 3 && rows.every(x => x.status === "done" && x.timed === 1) &&
      rows.map(x => x.stepLabel).join("|") === "Front|Back|Personalization: COACH" && rows[2].hoopId === flat);

    console.log("\n=== Untimed hoopings, aborts, more pieces ===");
    const capTwo = await order("CAP-TWO", [line("cap", { qty: 2 })]);
    r = await call({ action: "markHoopingDone", org: "prime", orderId: "CAP-TWO", itemId: capTwo, machineId: m1 });
    console.log("Mark done (no timing) on a new piece records hooping 1 and points at 2:", r.status === 200 && r.body.pieceNo === 1 && r.body.nextStepNo === 2 && r.body.pieceComplete === false);
    r = await call({ action: "startRun", org: "prime", orderId: "CAP-TWO", itemId: capTwo, machineId: m1 });
    console.log("a qty-2 line starts its second piece alongside:", r.status === 200 && r.body.pieceNo === 2 && r.body.stepNo === 1);
    await call({ action: "abortRun", runId: r.body.runId, abortReasonId: 1 });
    job = await jobOf(capTwo);
    console.log("aborting piece 2's only hooping returns it to not-started:", job.pieces.length === 1 && job.pieces[0].pieceNo === 1 && job.idlePieces === 1);
    r = await call({ action: "markHoopingDone", org: "prime", orderId: "CAP-TWO", itemId: capTwo, pieceNo: 1, stepNo: 2 });
    console.log("finishing piece 1's last hooping untimed makes the piece:", r.body.pieceComplete === true && d1.q(`SELECT manufacturedQty q FROM order_items WHERE id=${capTwo}`)[0].q === 1);
    const report = await lib.getRunReportByDesign(d1, {});
    console.log("untimed hoopings stay out of the timing report:", report.detail.every(x => x.orderId !== "CAP-TWO" || x.status === "aborted") &&
      d1.q("SELECT count(*) n FROM production_runs WHERE timed=0")[0].n === 2);
    console.log("the report's detail names each hooping:", report.detail.some(x => x.stepLabel === "Personalization: COACH"));
    r = await call({ action: "startRun", org: "prime", orderId: "SHIRT-PLAIN", itemId: shirtPlain, machineId: m2 });
    console.log("a machine without any of the hooping's hoops still starts (the hoop falls back to the hooping's first):", r.status === 200);
    const nameItem = await order("SHIRT-NAME2", [line("shirt", { personalized: true, persName: "FRODO" })]);
    r = await call({ action: "startRun", org: "prime", orderId: "SHIRT-NAME2", itemId: nameItem, machineId: m1 });
    console.log("a hooping waiting on its order design can't start:", r.status === 400 && /Upload the order-specific design for "FRODO"/.test(r.body.message));

    console.log("\n=== Digitizing / approval wait for the order design upload ===");
    const gate = await order("GATE", [line("shirt", { personalized: true, persName: "MERRY" }), line("cap")], { paid: 1 });
    let go = await lib.getOrderById(d1, "GATE");
    console.log("the order says how many typed-in lines still need their order design:", go.orderDesignsMissing === 1);
    r = await call({ action: "setFulfillmentStage", org: "prime", orderId: "GATE", stage: "digitizingComplete" });
    console.log("Digitizing complete is refused until it's uploaded:", r.status === 409 && /1 order design hasn't been uploaded/.test(r.body.message));
    d1._raw.run("UPDATE orders SET digitizingCompleteAt='2026-09-03' WHERE orderId='GATE'");
    r = await call({ action: "setFulfillmentStage", org: "prime", orderId: "GATE", stage: "designApproved" });
    console.log("…and so is Design approved:", r.status === 409 && /hasn't been uploaded/.test(r.body.message));
    r = await call({ action: "bulkSetFulfillmentStage", org: "prime", orderIds: ["GATE"], stage: "designApproved" });
    console.log("the bulk bar can't approve it either:", !(await lib.getOrderById(d1, "GATE")).designApprovedAt);
    r = await call({ action: "sendDesignVerification", org: "prime", orderIds: ["GATE"], message: "Please approve" });
    console.log("the verification email isn't sent before the upload (so the customer can't approve nothing):",
      r.status === 200 && r.body.sent === 0 && /order design not uploaded/.test(r.body.skippedReasons.join()));
    const gateItem = Number(d1.q("SELECT id FROM order_items WHERE orderId='GATE' AND productId='shirt'")[0].id);
    await call({ action: "saveOrderItemDesign", org: "prime", itemId: gateItem, machineFileKey: `order-files/${gateItem}/abc.dst`, machineFileName: "MERRY.DST", threadColors: [] });
    go = await lib.getOrderById(d1, "GATE");
    r = await call({ action: "setFulfillmentStage", org: "prime", orderId: "GATE", stage: "designApproved" });
    console.log("once uploaded, Design approved is allowed:", go.orderDesignsMissing === 0 && r.status === 200);
    console.log("the Orders list carries the count too:", (await call({ action: "getOrders", org: "prime" })).body.orders.find(o => o.orderId === "SHIRT-NAME2").orderDesignsMissing === 1);

    console.log("\n=== Deleting is refused while something uses it ===");
    let err = ""; try { await lib.deleteDesign(d1, back); } catch (e) { err = e.message; }
    console.log("a design in a product's design list:", /still uses this design/.test(err));
    err = ""; try { await lib.deleteDesign(d1, captain); } catch (e) { err = e.message; }
    console.log("a design mapped to a pick-list option:", /still uses this design/.test(err));
    err = ""; try { await lib.deleteHoop(d1, big); } catch (e) { err = e.message; }
    console.log("a hoop in a design's hoop list:", /design's hoops/.test(err));

    console.log("\n=== Admin screens ===");
    const adminJs = read("public/admin.js");
    class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
    let queueResp = null;
    const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
      beforeParse(win) {
        win.fetch = async (url, opts) => {
          const b = opts && opts.body ? JSON.parse(opts.body) : {};
          const ok = (o) => ({ ok: true, status: 200, json: async () => Object.assign({ status: "ok" }, o) });
          if (String(url).includes("/api/catalog")) return ok({ status: "admin" });
          if (b.action === "getProductionQueue") return ok(queueResp);
          if (b.action === "listMachines") return ok({ machines: [{ id: 1, name: "M1", currentHoopId: capFrame, hoopIds: [capFrame, flat], needles: {} }, { id: 2, name: "M2", currentHoopId: flat, hoopIds: [flat], needles: {} }] });
          if (b.action === "listHoops") return ok({ hoops: [{ id: capFrame, name: "Cap frame", isCapFrame: true }, { id: flat, name: "Flat 4in", isCapFrame: false }] });
          if (b.action === "listThreads") return ok({ threads: [] });
          if (b.action === "listActiveRuns") return ok({ activeRuns: [] });
          if (b.action === "listAbortReasons") return ok({ reasons: [] });
          // Designs screen: the list was loaded before an edit; getDesign returns the saved values.
          if (b.action === "listDesigns") return ok({ designs: [{ id: 5, orgId: "prime", name: "Crest", hoopIds: [capFrame], personalizationHoopIds: [] }] });
          if (b.action === "getDesign") return ok({ design: { id: 5, orgId: "prime", name: "Crest v2", hoopIds: [capFrame, flat], personalizationHoopIds: [flat] }, versions: [] });
          return ok({});
        };
      } });
    const w = dom.window;
    await new Promise(res => setTimeout(res, 150));
    await w.loadAdminScript();
    w.eval('adminKey = "cookie"; adminOrgs = [{orgId:"prime", name:"PRIME"}];');
    const hoopsById = { [capFrame]: { id: capFrame, isCapFrame: true }, [flat]: { id: flat, isCapFrame: false } };
    const machines = [{ id: 1, name: "M1", currentHoopId: capFrame, hoopIds: [capFrame, flat] }, { id: 2, name: "M2", currentHoopId: flat, hoopIds: [flat] }];
    const p = w.proposeMachine_({ hoopIds: [flat] }, machines, hoopsById);
    console.log("a flat-hoop hooping proposes the machine with the flat hoop already mounted (not a cap-frame swap):", p.proposedId === 2 && p.eligible.length === 2);
    console.log("with several allowed hoops, a machine uses the one it has mounted:", w.hoopForMachine_(machines[0], { hoopIds: [flat, capFrame] }, hoopsById) === capFrame);
    console.log("an old single-hoop design still works:", w.proposeMachine_({ hoopId: capFrame }, machines, hoopsById).proposedId === 1);

    // The CAP-COACH job, piece 1 between hoopings (front done), plus an idle second piece.
    const fresh = (await lib.getProductionQueue(d1)).find(j => j.itemId === capTwo);
    queueResp = { status: "ok", waitingOnBlanks: [], queue: [Object.assign({}, fresh, { orgName: "PRIME",
      pieces: [{ pieceNo: 3, done: [1], nextStepNo: 2, running: null }], idlePieces: 1 })] };
    const app = w.document.getElementById("app");
    await w.renderRunOrder(app);
    await new Promise(res => setTimeout(res, 80));
    const cards = [...w.document.querySelectorAll(".run-job-card")];
    console.log("one card per piece, each at its current hooping:", cards.length === 2 && /Hooping 2 of 2 · Back/.test(cards[0].textContent) && /Hooping 1 of 2 · Front/.test(cards[1].textContent));
    console.log("the hooping progress shows done / current / to-do:", /✓ 1\. Front/.test(cards[0].querySelector(".run-hoopings").textContent) && /▶ 2\. Back/.test(cards[0].textContent));
    console.log("Start names the hooping, and sends that piece and step:", /Start hooping 2/.test(cards[0].querySelector(".run-start-btn").textContent) &&
      cards[0].querySelector(".run-start-btn").dataset.piece === "3" && cards[0].querySelector(".run-start-btn").dataset.step === "2" &&
      cards[1].querySelector(".run-start-btn").dataset.piece === "");
    const blockedJob = (await lib.getProductionQueue(d1)).find(j => j.itemId === nameItem);
    queueResp = { status: "ok", waitingOnBlanks: [], queue: [Object.assign({}, blockedJob, { orgName: "PRIME" })] };
    await w.renderRunOrder(app);
    await new Promise(res => setTimeout(res, 80));
    const bc = w.document.querySelector(".run-job-card");
    console.log("a hooping waiting on its order design says so, offers the upload and can't start:",
      /Upload the order-specific design for "FRODO"/.test(bc.textContent) && !!bc.querySelector(".run-upload-item-design-btn") && !bc.querySelector(".run-start-btn"));
    const opts = (o) => { const el = w.document.createElement("div"); el.innerHTML = w.adminActionCell({ orgId: "prime", name: "PRIME" }, o); return [...el.querySelectorAll("select option")]; };
    const waitingOrder = { orderId: "G", items: [{ name: "Shirt", cancelDate: "" }], paid: true, needsDigitizing: true, needsDesignApproval: true, orderDesignsMissing: 1 };
    const os = opts(waitingOrder);
    console.log("the stage menu greys out Digitizing until the upload, saying why:",
      os.some(x => x.disabled && /digitizing complete — upload the order design first/i.test(x.textContent)) && !os.some(x => x.value === "digitizingComplete"));
    console.log("the Digitizing / Design approved columns flag the missing upload:",
      /Order design<br>not uploaded/.test(w.fulfillmentBadge("", waitingOrder, "designApproved")) && /Order design<br>not uploaded/.test(w.fulfillmentBadge("", waitingOrder, "digitizingComplete")));
    await w.renderDesigns(app, "prime", 5);
    await new Promise(res => setTimeout(res, 60));
    const editBtn = [...w.document.querySelectorAll("#dsgDetail button")].find(b2 => b2.textContent.trim() === "Edit");
    editBtn.click();
    const form = w.document.querySelector("#dsgfName").closest("div");
    console.log("Edit right after a save shows the SAVED hoops and name, not the page's stale list:",
      w.document.querySelector("#dsgfName").value === "Crest v2" &&
      [...w.document.querySelectorAll(".dsgfHoopOwn:checked")].map(c => Number(c.value)).sort().join() === [capFrame, flat].sort().join() &&
      [...w.document.querySelectorAll(".dsgfHoopPers:checked")].map(c => Number(c.value)).join() === String(flat));
    console.log("…and the list shows the new name:", w.document.querySelector('#dsgList button[data-did="5"]').textContent === "Crest v2");
    w.document.querySelector("#dsgfCancel").click();
    console.log("the upload window takes an order design (item id, optional native file):", /action: "saveOrderItemDesign", itemId/.test(adminJs) && /itemId=\$\{itemId\}/.test(adminJs));
    console.log("design.js role-checks an order design's two files:", /if \(designId \|\| roleParam\)/.test(read("functions/api/design.js")));
    console.log("design form: two hoop lists; product form: designs list + pick-list mapping:",
      /class="\$\{cls\}"/.test(adminJs) && /dsgfHoopPers/.test(adminJs) && /action: "setProductDesigns"/.test(adminJs) && /class="pers-opt-design"/.test(adminJs));
  } catch (e) {
    console.log("test71 crashed:", false);
    console.error(e);
    process.exit(1);
  }
})();
