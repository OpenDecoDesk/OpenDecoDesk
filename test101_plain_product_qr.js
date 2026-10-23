const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// A plain (non-configurable) product can carry a reorder QR code (migrations/0048), and a line that is
// both embroidered and has a transfer is in TWO queues — Run Order for the embroidery, Run Transfer
// Sheets for the transfer — each tracked on its own, so finishing one doesn't hide it from the other.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createTransfer, createGraphic, createProduct, priceItem, insertOrder, getOrderById, getTransferQueue, getGangSheet, getProductionQueue,
  setOrgReorderQrTransfer, createHoop, createThread, saveDesign, addDesignVersion, setProductDesign, saveMachine, receiveTransferSheet, listTransfers, getProductsByOrg, lineHasEmbroidery, refreshOrderLinesFromCatalog, updateGraphic, getGraphic };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { league: 'league' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  const madeQty = (orderId) => Number(d1.q("SELECT COALESCE(manufacturedQty,0) n FROM order_items WHERE orderId=?", orderId)[0].n);
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('league','league','League','t','t',1);`);
  const call = async (body, host = "admin") => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url: `https://${host}.example.com/api/orders`, json: async () => (host === "admin" ? Object.assign({ key: "x" }, body) : body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const tQr = await lib.createTransfer(d1, { name: "League QR DTF" });
  const tArt = await lib.createTransfer(d1, { name: "Crest sheet" });
  const gArt = await lib.createGraphic(d1, "league", { name: "Crest transfer", kind: "transfer", transferId: tArt, tier: null });
  const hoop = await lib.createHoop(d1, { name: "6.9in", isCapFrame: false });
  const thread = await lib.createThread(d1, { brand: "Madeira", type: "PolyNeon", weight: "40", code: "1", name: "Red", colorHex: "cc0000" });
  const design = await lib.saveDesign(d1, "league", { name: "Left chest crest", hoopIds: [hoop] });
  await lib.addDesignVersion(d1, design, { designFileKey: "d/a.emb", designFileName: "a.emb", machineFileKey: "d/a.dst", machineFileName: "A.DST", machineFileExt: "dst", threadColors: [{ needle: 1, threadId: thread }] });
  const m1 = await lib.saveMachine(d1, { name: "Machine 1", needleCount: 12, hoopIds: [hoop] });
  // Plain products: an embroidered polo; a polo that says None; a plain product with no design (transfer only).
  const plain = (productId, extra) => lib.createProduct(d1, "league", Object.assign({ productId, type: "shirt", name: productId, pricingMode: "sized", sizePricing: { L: 25 }, visible: true }, extra));
  await plain("polo"); await lib.setProductDesign(d1, "league", "polo", design);
  await plain("polo-none", { reorderQr: "none" }); await lib.setProductDesign(d1, "league", "polo-none", design);
  await plain("sticker-tee", { noDesignNeeded: true });
  // A configurable product whose only option is a transfer (transfer-only, as before).
  await lib.createProduct(d1, "league", { productId: "dtf", type: "shirt", name: "dtf", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, configurable: true, garmentColors: ["Navy"], reorderQr: "none",
    locations: [{ key: "front", label: "Front", graphicIds: [gArt] }] });

  console.log("=== A plain product's order line ===");
  let p = await lib.priceItem(d1, "league", "polo", "L", 1, false);
  ok("with no reorder QR set anywhere a plain line carries nothing (as before)", p.config === undefined && p.unitPrice === 25);
  await lib.setOrgReorderQrTransfer(d1, "league", tQr);
  p = await lib.priceItem(d1, "league", "polo", "L", 1, false);
  ok("with the shop's QR set, a plain product's line carries it as its only transfer, at no charge", p.unitPrice === 25 && p.config && p.config.plain === true && p.config.locations.length === 1 &&
    p.config.locations[0].location === "reorderqr" && p.config.locations[0].kind === "transfer" && p.config.locations[0].transferId === tQr && p.config.locations[0].auto === true && p.config.locations[0].addOnCents === 0);
  ok("a plain product set to None gets none", (await lib.priceItem(d1, "league", "polo-none", "L", 1, false)).config === undefined);
  await d1.prepare("UPDATE products SET reorderQr=? WHERE orgId='league' AND productId='sticker-tee'").bind("t" + tArt).run();
  ok("a plain product can pick its own transfer", (await lib.priceItem(d1, "league", "sticker-tee", "L", 1, false)).config.locations[0].transferId === tArt);
  await d1.prepare("UPDATE products SET reorderQr='default' WHERE orgId='league' AND productId='sticker-tee'").run();

  // A real storefront order of a plain polo.
  let r = await call({ orderId: "P1", orgId: "league", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", items: [{ productId: "polo", size: "L", qty: 2 }] }, "league");
  let o = await lib.getOrderById(d1, "P1");
  ok("a storefront order of a plain product saves the QR on the line without the browser sending anything", r.status === 200 && o.items[0].config && o.items[0].config.plain === true && o.items[0].config.locations[0].transferId === tQr && o.effectiveTotal === 50);
  const ready = (id) => { for (const [col, v] of Object.entries({ paid: 1, blankReceivedAt: "2026-10-03", designApprovedAt: "2026-10-04", digitizingCompleteAt: "2026-10-03" })) d1._raw.run(`UPDATE orders SET ${col}=? WHERE orderId=?`, [v, id]); };
  ready("P1");
  const poloItem = o.items[0].sheetRow;
  await call({ orderId: "P2", orgId: "league", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", items: [{ productId: "sticker-tee", size: "L", qty: 1 }] }, "league"); ready("P2");
  await call({ orderId: "P3", orgId: "league", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", items: [{ productId: "polo-none", size: "L", qty: 1 }] }, "league"); ready("P3");
  await call({ orderId: "P4", orgId: "league", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", items: [{ productId: "dtf", size: "L", qty: 1, config: { garmentColor: "Navy", locations: { front: { graphicId: gArt } } } }] }, "league"); ready("P4");
  const stickerItem = (await lib.getOrderById(d1, "P2")).items[0].sheetRow, dtfItem = (await lib.getOrderById(d1, "P4")).items[0].sheetRow;

  console.log("\n=== Two queues ===");
  const tq = async () => { const q = await lib.getTransferQueue(d1); return q.ready.concat(q.waiting); };
  const pq = () => lib.getProductionQueue(d1);
  let t = await tq(), jobs = await pq();
  const tCard = (id) => t.find(c => c.orderId === id), job = (id) => jobs.find(j => j.orderId === id);
  ok("the embroidered polo is on Run Order (its embroidery)…", !!job("P1") && job("P1").steps.length === 1);
  ok("…and on Run Transfer Sheets (its QR), flagged as also embroidered, embroidery not done", !!tCard("P1") && tCard("P1").hasEmbroidery === true && tCard("P1").embroideryDone === false &&
    tCard("P1").transfers.length === 1 && tCard("P1").transfers[0].graphicName === "League QR DTF" && tCard("P1").transfers[0].auto === true && tCard("P1").qty === 2);
  ok("Run Order's card says it also needs a transfer pressed", job("P1").transfers.length === 1 && job("P1").transfers[0].graphicName === "League QR DTF" && job("P1").transfersApplied === false);
  ok("a plain product with no embroidery and a QR is transfer-only on Run Transfer Sheets", !!tCard("P2") && tCard("P2").hasEmbroidery === false);
  ok("…and is no longer on Run Order (nothing to embroider)", !job("P2"));
  ok("an embroidered polo with no QR is only on Run Order", !!job("P3") && !tCard("P3") && job("P3").transfers.length === 0);
  ok("a configurable transfer-only line is still only on Run Transfer Sheets", !!tCard("P4") && tCard("P4").hasEmbroidery === false && !job("P4"));
  ok("the gang sheet counts every transfer still to press (2 QR on the polo + 1 on the tee, 1 crest)", JSON.stringify((await lib.getGangSheet(d1)).map(g => g.graphic + ":" + g.count)) === JSON.stringify(["Crest transfer:1", "League QR DTF:3"]));

  console.log("\n=== Finishing the embroidery first ===");
  d1._raw.run("UPDATE order_items SET transferReceivedAt='2026-10-05T00:00:00Z'");
  for (let piece = 0; piece < 2; piece++) {
    const s = await call({ action: "startRun", org: "league", orderId: "P1", itemId: poloItem, machineId: m1 });
    const runId = Number(d1.q("SELECT id FROM production_runs WHERE orderId='P1' AND status='running'")[0].id);
    await call({ action: "completeRun", runId, org: "league", orderId: "P1" });
  }
  o = await lib.getOrderById(d1, "P1");
  ok("both pieces are made by finishing the embroidery on Run Order", madeQty("P1") === 2 && !!o.manufacturedAt);
  ok("making the line used the QR transfer's stock once per piece", Number(d1.q(`SELECT COALESCE(SUM(qtyDelta),0) n FROM transfer_movements WHERE transferId=${tQr} AND kind='consume'`)[0].n) === -2);
  t = await tq(); jobs = await pq();
  ok("it leaves Run Order…", !job("P1"));
  ok("…but stays on Run Transfer Sheets until its QR is pressed, now showing the embroidery as done", !!tCard("P1") && tCard("P1").embroideryDone === true);
  r = await call({ action: "setTransfersApplied", orderId: "P1", itemId: poloItem, org: "league" });
  t = await tq();
  await new Promise(res => setTimeout(res, 20));
  ok("Mark transfers applied takes it off the list, and is audited", r.status === 200 && !tCard("P1") && Number(d1.q("SELECT count(*) n FROM audit_log WHERE action='order.transfers_applied'")[0].n) === 1);
  r = await call({ action: "setTransfersApplied", orderId: "P1", itemId: poloItem, org: "league", applied: false });
  t = await tq();
  ok("…and it can be undone", !!tCard("P1"));
  await call({ action: "setTransfersApplied", orderId: "P1", itemId: poloItem, org: "league" });

  console.log("\n=== Pressing the transfer first ===");
  await call({ orderId: "P5", orgId: "league", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", items: [{ productId: "polo", size: "L", qty: 1 }] }, "league"); ready("P5");
  d1._raw.run("UPDATE order_items SET transferReceivedAt='2026-10-05T00:00:00Z' WHERE orderId='P5'");
  const p5 = (await lib.getOrderById(d1, "P5")).items[0].sheetRow;
  r = await call({ action: "makeTransferLine", orderId: "P5", itemId: p5, org: "league" });
  o = await lib.getOrderById(d1, "P5");
  ok("'Mark made' on an embroidered line only marks its transfers applied — it does NOT make the piece", r.status === 200 && r.body.applied === true && madeQty("P5") === 0 && !o.manufacturedAt);
  t = await tq(); jobs = await pq();
  ok("it leaves Run Transfer Sheets and is still on Run Order, noted as pressed", !tCard("P5") && !!job("P5") && job("P5").transfersApplied === true);

  console.log("\n=== Transfer-only lines are unchanged ===");
  r = await call({ action: "makeTransferLine", orderId: "P2", itemId: stickerItem, org: "league" });
  o = await lib.getOrderById(d1, "P2");
  t = await tq();
  ok("Mark made on a plain transfer-only line makes it (and takes it off the list)", r.status === 200 && !r.body.applied && madeQty("P2") === 1 && !tCard("P2"));
  r = await call({ action: "makeTransferLine", orderId: "P4", itemId: dtfItem, org: "league" });
  ok("…and on a configurable transfer-only line", r.status === 200 && madeQty("P4") === 1);
  // An order that shipped with a transfer never marked applied doesn't linger forever.
  await call({ orderId: "P6", orgId: "league", customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", items: [{ productId: "polo", size: "L", qty: 1 }] }, "league"); ready("P6");
  d1._raw.run("UPDATE orders SET manufacturedAt='2026-10-06', shippedAt='2026-10-07' WHERE orderId='P6'"); d1._raw.run("UPDATE order_items SET manufacturedQty=1 WHERE orderId='P6'");
  t = await tq();
  ok("a shipped order is no longer listed", !tCard("P6"));

  console.log("\n=== Fixing the catalog after an order was placed ===");
  // An order placed while the graphic was a transfer with no transfer linked, on a product with no QR.
  await lib.createProduct(d1, "league", { productId: "hood", type: "sweatshirt", name: "hood", pricingMode: "flat", flatPrice: 40, visible: true, configurable: true, garmentColors: ["Black"], reorderQr: "none",
    locations: [{ key: "chest", label: "Left chest", graphicIds: [gArt] }] });
  await d1.prepare("UPDATE graphics SET transferId=NULL WHERE id=?").bind(gArt).run();
  await call({ orderId: "F1", orgId: "league", customerName: "Fix", contact: "c@x.com", paymentMethod: "Venmo", items: [
    { productId: "hood", size: "L", qty: 1, config: { garmentColor: "Black", locations: { chest: { graphicId: gArt } } } }, { productId: "polo-none", size: "L", qty: 1 }] }, "league"); ready("F1");
  const before = await lib.getOrderById(d1, "F1");
  // The fixes: the graphic is really embroidery; both products get the shop's QR.
  await d1.prepare("UPDATE graphics SET kind='embroidery', designId=?, transferId=NULL WHERE id=?").bind(design, gArt).run();
  await d1.prepare("UPDATE products SET reorderQr='default' WHERE orgId='league' AND productId IN ('hood','polo-none')").run();
  o = await lib.getOrderById(d1, "F1");
  ok("the order still shows what it was placed with (a line keeps its own copy)", o.items[0].config.locations.length === 1 && o.items[0].config.locations[0].kind === "transfer" && !o.items[1].config);
  r = await call({ action: "refreshOrderFromCatalog", orderId: "F1", org: "league", preview: true });
  ok("the preview lists what would change, per line, and changes nothing", r.status === 200 && r.body.applied === false && r.body.lines.length === 2 &&
    /Crest transfer: a transfer → embroidery/.test(r.body.lines[0].changes.join("; ")) && /Reorder QR added \(League QR DTF\)/.test(r.body.lines[0].changes.join("; ")) &&
    /Reorder QR added/.test(r.body.lines[1].changes.join("; ")) && (await lib.getOrderById(d1, "F1")).items[0].config.locations.length === 1);
  r = await call({ action: "refreshOrderFromCatalog", orderId: "F1", org: "league" });
  await new Promise(res => setTimeout(res, 20));
  o = await lib.getOrderById(d1, "F1");
  const c0 = o.items[0].config;
  ok("applying it switches the option to embroidery with its design, and adds the QR", r.body.applied === true && c0.locations.length === 2 && c0.locations[0].kind === "embroidery" && c0.locations[0].designId === design &&
    c0.locations[0].graphicId === gArt && c0.garmentColor === "Black" && c0.locations[1].auto === true && c0.locations[1].transferId === tQr);
  ok("the plain line gets its QR too", o.items[1].config && o.items[1].config.plain === true && o.items[1].config.locations[0].transferId === tQr);
  ok("prices and the order total don't move", o.items[0].unitPrice === before.items[0].unitPrice && o.items[1].unitPrice === before.items[1].unitPrice && o.effectiveTotal === before.effectiveTotal);
  ok("it's audited", Number(d1.q("SELECT count(*) n FROM audit_log WHERE action='order.lines_refreshed' AND orderId='F1'")[0].n) === 1);
  t = await tq(); jobs = await pq();
  ok("the queues follow: the hoodie is now on Run Order with its embroidery, and on Run Transfer Sheets for its QR", jobs.some(j => j.orderId === "F1" && j.steps[0].designId === design) && t.filter(c => c.orderId === "F1").length === 2);
  r = await call({ action: "refreshOrderFromCatalog", orderId: "F1", org: "league", preview: true });
  ok("a second pass finds nothing to do", r.body.lines.length === 0);
  r = await call({ action: "refreshOrderFromCatalog", orderId: "P1", org: "league", preview: true });
  ok("lines that are already made are left alone", r.body.lines.length === 0);
  d1._raw.run("UPDATE orders SET completedAt='2026-10-09' WHERE orderId='P6'");
  r = await call({ action: "refreshOrderFromCatalog", orderId: "P6", org: "league" });
  ok("a completed order is refused", r.status === 400 && /completed/.test(r.body.message));
  await d1.prepare("UPDATE graphics SET kind='transfer', designId=NULL, transferId=? WHERE id=?").bind(tArt, gArt).run();
  d1._raw.run("UPDATE order_items SET cancelDate='2026-10-09' WHERE orderId='F1'");

  // ---- Screens ----
  const html = read("public/index.html"), adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.CSS = win.CSS || { escape: (v) => String(v) }; autoConfirm(win, () => true); win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const x = await call(JSON.parse(init.body)); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval(`adminKey = "cookie";`);
  const until = async (fn) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return !!fn(); };
  const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

  console.log("\n=== Product page ===");
  const polo = (await lib.getProductsByOrg(d1, "league", false)).find(x => x.productId === "polo");
  d.getElementById("app").innerHTML = `<div id="productConfigSection"></div>`;
  await w.loadProductConfigSection("league", polo);
  await until(() => d.getElementById("cfgReorderQr"));
  const qrSel = d.getElementById("cfgReorderQr");
  ok("a product that isn't configurable still shows Reorder QR code (outside the configurable-only fields)", !d.getElementById("cfgOn").checked && d.getElementById("cfgFields").style.display === "none" &&
    !d.getElementById("cfgFields").contains(qrSel) && d.getElementById("cfgQrWrap").contains(qrSel));
  ok("it offers the shop default by name, None, and the transfers", [...qrSel.options].map(o => o.textContent.trim()).join("|") === "Shop default (League QR DTF)|None|Crest sheet|League QR DTF");
  qrSel.value = "none";
  ok("the form saves the choice for a plain product", w._productConfigGet().configurable === false && w._productConfigGet().reorderQr === "none");
  ok("it explains the two queues", /listed on Run Order \(its embroidery\) and on Run Transfer Sheets \(its QR code\)/.test(text(d.getElementById("cfgQrWrap"))));

  console.log("\n=== Run Transfer Sheets screen ===");
  await call({ orderId: "P7", orgId: "league", customerName: "Seven", contact: "c@x.com", paymentMethod: "Venmo", items: [{ productId: "polo", size: "L", qty: 1 }] }, "league"); ready("P7");
  await call({ orderId: "P8", orgId: "league", customerName: "Eight", contact: "c@x.com", paymentMethod: "Venmo", items: [{ productId: "sticker-tee", size: "L", qty: 1 }] }, "league"); ready("P8");
  d1._raw.run("UPDATE order_items SET transferReceivedAt='2026-10-05T00:00:00Z' WHERE orderId IN ('P7','P8')");
  await w.renderRunTransfer(d.getElementById("app"));
  await until(() => d.querySelector(".rtApply"));
  const cardOf = (name) => [...d.querySelectorAll("#rtBody > div")].find(el => new RegExp(name).test(el.textContent) && el.querySelector("button"));
  ok("an embroidered line says so and offers 'Mark transfers applied' (not 'Mark made')", !!cardOf("Seven") && /Also embroidered — embroidery still to run on Run Order/.test(text(cardOf("Seven"))) && !!cardOf("Seven").querySelector(".rtApply") && !cardOf("Seven").querySelector(".rtMake"));
  ok("a transfer-only line still offers 'Mark made'", !!cardOf("Eight") && !!cardOf("Eight").querySelector(".rtMake") && !cardOf("Eight").querySelector(".rtApply") && !/Also embroidered/.test(text(cardOf("Eight"))));
  cardOf("Seven").querySelector(".rtApply").click();
  await until(() => !cardOf("Seven"));
  const p7 = await lib.getOrderById(d1, "P7");
  ok("pressing it takes the line off the list without making the piece", !cardOf("Seven") && madeQty("P7") === 0 && !!cardOf("Eight"));

  console.log("\n=== Run Order card and Edit items ===");
  ok("Edit items has an 'Update from catalog…' button that previews, asks, then applies", /id="editOrderRefresh"/.test(adminJs) && /preview: true/.test(adminJs) && typeof w.refreshOrderFromCatalog_ === "function");
  await call({ orderId: "F2", orgId: "league", customerName: "Fix", contact: "c@x.com", paymentMethod: "Venmo", items: [{ productId: "polo-none", size: "L", qty: 1 }] }, "league");
  await d1.prepare("UPDATE products SET reorderQr='none' WHERE orgId='league' AND productId='polo-none'").run();
  let asked = ""; autoConfirm(w, (m) => { asked = m; return true; });
  const did = await w.refreshOrderFromCatalog_({ orderId: "F2", orgId: "league" });
  ok("the button's prompt names the line and the change, and Yes applies it", did === true && /polo-none \(L\): Reorder QR removed/.test(asked) && !(await lib.getOrderById(d1, "F2")).items[0].config);
  ok("with nothing to change it says so and asks nothing", (asked = "", await w.refreshOrderFromCatalog_({ orderId: "F2", orgId: "league" })) === false && asked === "");
  ok("the Run Order card notes the transfer: still to press, then pressed", /Also needs a transfer pressed: League QR DTF/.test(w.runTransfersNoteHtml_({ transfers: [{ graphicName: "League QR DTF", auto: true }], transfersApplied: false })) &&
    /✓ Transfers pressed: League QR DTF/.test(w.runTransfersNoteHtml_({ transfers: [{ graphicName: "League QR DTF", auto: true }], transfersApplied: true })) && w.runTransfersNoteHtml_({ transfers: [] }) === "");
  ok("Edit items treats a plain line's QR-only snapshot as a plain line (no color/graphic pickers)", /it\.config && Array\.isArray\(it\.config\.locations\) && !it\.config\.plain/.test(adminJs));
  ok("order views show nothing extra for it (the QR isn't a customer choice)", w.cfgSummary_({ config: { garmentColor: "", plain: true, locations: [{ location: "reorderqr", auto: true, graphicName: "League QR DTF" }] } }) === "");

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
