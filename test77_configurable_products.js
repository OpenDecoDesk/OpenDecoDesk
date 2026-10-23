const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Configurable products (migrations/0036): base + tier add-ons priced server-side, all-None and
// disallowed options rejected, the config snapshot round-trips onto the order, the reorder QR is an
// unpriced auto application, and the Run Transfer Sheets queue / gang sheet / mark-made work.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, priceItem, createProduct, createBlank, setBlankLink, receiveBlanks,
  createTransfer, receiveTransferSheet, createGraphic, setTierPrices, setOrgReorderQr, getOrderById, setOrderPaid,
  createHoop, saveDesign, addDesignVersion, getProductionQueue, pricingError_ };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const near = (a, b) => Math.abs(a - b) < 0.005;

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('colonnade','colonnade','Colonnade','t','t');`);
  // Two transfer graphics; Lockup = medium (+$2), Capital = large (+$4). Capital only allowed Front.
  const tLock = await lib.createTransfer(d1, { name: "Lockup sheet" });
  const tCap = await lib.createTransfer(d1, { name: "Capital sheet" });
  const gLock = await lib.createGraphic(d1, "colonnade", { name: "Lockup", kind: "transfer", transferId: tLock, tier: "medium", inkColors: ["White", "Old Gold"] });
  const gCap = await lib.createGraphic(d1, "colonnade", { name: "Capital + crest", kind: "transfer", transferId: tCap, tier: "large", allowedLocations: ["front"] });
  const gFree = await lib.createGraphic(d1, "colonnade", { name: "Included mark", kind: "transfer", transferId: tLock, tier: null });
  // Configurable raglan, base flat $18, Front offers Lockup+Capital+Free, Back offers Lockup+Free.
  await lib.createProduct(d1, "colonnade", { productId: "rag", type: "shirt", name: "Raglan", pricingMode: "flat", flatPrice: 18, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Navy", "Heather"], reorderQr: "none",
    locations: [{ key: "front", label: "Front", graphicIds: [gLock, gCap, gFree] }, { key: "back", label: "Back", graphicIds: [gLock, gFree] }] });

  const price = (cfg) => lib.priceItem(d1, "colonnade", "rag", "L", 1, false, cfg);

  console.log("=== Base + tier add-on pricing (server-side) ===");
  ok("Lockup only → $20", near((await price({ garmentColor: "Navy", locations: { front: { graphicId: gLock, ink: "White" } } })).unitPrice, 20));
  ok("Capital only → $22", near((await price({ garmentColor: "Navy", locations: { front: { graphicId: gCap } } })).unitPrice, 22));
  ok("both (Front Capital + Back Lockup) → $24",
    near((await price({ garmentColor: "Navy", locations: { front: { graphicId: gCap }, back: { graphicId: gLock, ink: "White" } } })).unitPrice, 24));
  ok("a NULL-tier option adds $0 (still $18)", near((await price({ garmentColor: "Navy", locations: { front: { graphicId: gFree } } })).unitPrice, 18));

  console.log("\n=== Validation ===");
  const throws = async (cfg) => { try { await price(cfg); return false; } catch (e) { return !!e.userFacing; } };
  ok("all-None rejected (blank garment)", await throws({ garmentColor: "Navy", locations: {} }));
  ok("an option not offered at that location rejected", await throws({ garmentColor: "Navy", locations: { back: { graphicId: gCap } } }));
  ok("an ink not on the graphic rejected", await throws({ garmentColor: "Navy", locations: { front: { graphicId: gLock, ink: "Purple" } } }));
  ok("a garment color not offered rejected", await throws({ garmentColor: "Lime", locations: { front: { graphicId: gLock, ink: "White" } } }));

  console.log("\n=== Config snapshot round-trips onto the order ===");
  const priced = await price({ garmentColor: "Navy", locations: { front: { graphicId: gLock, ink: "Old Gold" }, back: { graphicId: gFree } } });
  await lib.insertOrder(d1, { orderId: "O1", orgId: "colonnade", customerName: "C", contact: "c@x.com", placedAt: "2026-07-05T00:00:00Z" },
    [{ productId: "rag", name: "Raglan", type: "shirt", size: "L", qty: 1, unitPrice: priced.unitPrice, config: priced.config }]);
  const saved = (await lib.getOrderById(d1, "O1")).items[0];
  ok("stored config has the Front/Back picks with ink + add-ons", saved.config && saved.config.locations.length === 2 &&
    saved.config.locations[0].graphicName === "Lockup" && saved.config.locations[0].ink === "Old Gold" && saved.config.locations[0].addOnCents === 200);

  console.log("\n=== Reorder QR is an unpriced auto application ===");
  const qr = await lib.createGraphic(d1, "colonnade", { name: "Reorder QR", kind: "transfer", transferId: tLock, tier: "large" });
  await lib.setOrgReorderQr(d1, "colonnade", qr);
  await lib.createProduct(d1, "colonnade", { productId: "rag2", type: "shirt", name: "Raglan QR", pricingMode: "flat", flatPrice: 18, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Navy"], reorderQr: "default", locations: [{ key: "front", label: "Front", graphicIds: [gLock] }] });
  const qrPriced = await lib.priceItem(d1, "colonnade", "rag2", "L", 1, false, { garmentColor: "Navy", locations: { front: { graphicId: gLock, ink: "White" } } });
  ok("reorder QR adds no price (still $20) but rides in the snapshot", near(qrPriced.unitPrice, 20) &&
    qrPriced.config.locations.some(l => l.location === "reorderqr" && l.auto && l.addOnCents === 0));

  console.log("\n=== Real API: tier prices, Run Transfer queue, gang sheet, mark made ===");
  let r = await call({ action: "setTierPrices", org: "colonnade", tiers: { small: 1, medium: 2, large: 4 } });
  ok("setTierPrices persists", r.status === 200 && r.body.tiersCents.large === 400);
  r = await call({ action: "listGraphics", org: "colonnade" });
  ok("listGraphics returns the org's options + tiers", r.status === 200 && r.body.graphics.length >= 4);

  // Stock the Lockup transfer + the blank so the make can consume.
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: tLock, count: 20, pctOfSheet: 100 }], totalCents: 4000, receivedAt: "2026-07-01" });
  // Color is a stock dimension now (migrations/0037): stock the Navy/L blank and link the raglan's
  // Navy garment color explicitly to it (configurable products map each garment color).
  const blankId = (await lib.createBlank(d1, { name: "63374", productType: "shirt",
    colors: [{ color: "Navy", images: [], sizes: [{ size: "L", purchasePrice: 0, quantity: 0 }] }] })).id;
  await lib.setBlankLink(d1, "colonnade", "rag", "Navy", "L", blankId, "Navy", "L");
  await lib.receiveBlanks(d1, { blankId, lines: [{ color: "Navy", size: "L", qty: 10, unitCost: 5 }], receivedAt: "2026-07-01" });
  await lib.setOrderPaid(d1, "O1", null, "paid");

  const itemId = saved.id;
  r = await call({ action: "getTransferQueue" });
  ok("queue: unreceived line is WAITING (blank+DTF not received yet)", r.body.waiting.some(c => c.itemId === itemId) && !r.body.ready.some(c => c.itemId === itemId));
  d1._raw.run("UPDATE orders SET blankReceivedAt='2026-07-06T00:00:00Z' WHERE orderId='O1'");
  await call({ action: "setTransferReceived", itemId, received: true, orderId: "O1" });
  r = await call({ action: "getTransferQueue" });
  const card = r.body.ready.find(c => c.itemId === itemId);
  ok("blank + transfer received → READY, card shows the blank and the graphic", !!card && card.blank.name === "63374" && card.transfers.some(t => t.graphicName === "Lockup"));

  r = await call({ action: "getGangSheet" });
  // Its transfers are in hand (marked received, and in stock), so there's nothing left to print for it —
  // the gang sheet's totalling is covered by test100 / test134.
  ok("gang sheet leaves out a line whose transfers are in hand", r.status === 200 && !r.body.rows.some(x => x.graphic === "Lockup"));

  r = await call({ action: "makeTransferLine", org: "colonnade", orderId: "O1", itemId });
  ok("mark made succeeds and completes the order", r.status === 200 && r.body.orderComplete === true);
  // 1 blank @ $5 + two transfer applications (Front Lockup + Back mark, both on the $2.00 Lockup sheet).
  ok("made line now has COGS (blank + both transfer apps = $9)", near((await lib.getOrderById(d1, "O1")).items[0].cogs, 5 + 2 + 2));
  r = await call({ action: "getTransferQueue" });
  ok("gone from the queue after made", !r.body.ready.some(c => c.itemId === itemId) && !r.body.waiting.some(c => c.itemId === itemId));

  console.log("\n=== Embroidery option on a configurable line → embroidery Run Order queue ===");
  // A design with a machine file + hoop, an embroidery graphic pointing at it, a configurable product
  // offering it at Front. An order with that pick should show in getProductionQueue as a hooping;
  // a transfer-only configurable line should NOT (it belongs on Run Transfer Sheets).
  const hoop = await lib.createHoop(d1, { name: "4in Round", isCapFrame: false });
  const designId = await lib.saveDesign(d1, "colonnade", { name: "Club Crest", stabilizer: "cutaway", hoopId: hoop });
  await lib.addDesignVersion(d1, designId, { designFileKey: "d/c.emb", designFileName: "c.emb", designFileExt: "emb",
    machineFileKey: "d/c.dst", machineFileName: "c.dst", machineFileExt: "dst", threadColors: [] });
  const gEmb = await lib.createGraphic(d1, "colonnade", { name: "Crest", kind: "embroidery", designId, tier: "medium" });
  await lib.createProduct(d1, "colonnade", { productId: "polo", type: "shirt", name: "Polo", pricingMode: "flat", flatPrice: 30, visible: true,
    configurable: true, garmentColors: ["Navy"], reorderQr: "none", locations: [{ key: "lc", label: "Left chest", graphicIds: [gEmb] }] });
  const bId = (await lib.createBlank(d1, { name: "Polo blank", productType: "shirt" })).id;
  await lib.setBlankLink(d1, "colonnade", "polo", "L", bId, "L");
  const embPriced = await lib.priceItem(d1, "colonnade", "polo", "L", 1, false, { garmentColor: "Navy", locations: { lc: { graphicId: gEmb } } });
  ok("embroidery option priced (base $30 + medium $2 = $32)", near(embPriced.unitPrice, 32));
  await lib.insertOrder(d1, { orderId: "EMB1", orgId: "colonnade", customerName: "E", contact: "e@x.com", placedAt: "2026-07-05T00:00:00Z" },
    [{ productId: "polo", name: "Polo", type: "shirt", size: "L", qty: 1, unitPrice: embPriced.unitPrice, config: embPriced.config }]);
  await lib.setOrderPaid(d1, "EMB1", null, "paid");
  d1._raw.run("UPDATE orders SET blankReceivedAt='2026-07-06T00:00:00Z', designApprovedAt='2026-07-06T00:00:00Z', digitizingCompleteAt='2026-07-06T00:00:00Z' WHERE orderId='EMB1'");
  const queue = await lib.getProductionQueue(d1);
  const embJob = queue.find(j => j.orderId === "EMB1");
  ok("configurable embroidery line appears in the Run Order queue", !!embJob);
  ok("its hooping is the chosen option's design (Crest, left chest, with a machine file)",
    embJob && embJob.steps.length === 1 && embJob.steps[0].designId === designId && embJob.steps[0].machineFileKey === "d/c.dst" && !embJob.steps[0].blocked);
  // A fresh transfer-only configurable order (rag), paid + blank received + not made: it's ready to
  // run but has no embroidery hooping, so it must be excluded from the embroidery Run Order queue.
  const tPriced = await price({ garmentColor: "Navy", locations: { front: { graphicId: gLock, ink: "White" } } });
  await lib.insertOrder(d1, { orderId: "TRANS1", orgId: "colonnade", customerName: "T", contact: "t@x.com", placedAt: "2026-07-05T00:00:00Z" },
    [{ productId: "rag", name: "Raglan", type: "shirt", size: "L", qty: 1, unitPrice: tPriced.unitPrice, config: tPriced.config }]);
  await lib.setOrderPaid(d1, "TRANS1", null, "paid");
  d1._raw.run("UPDATE orders SET blankReceivedAt='2026-07-06T00:00:00Z' WHERE orderId='TRANS1'");
  ok("a transfer-only configurable line is NOT in the embroidery Run Order queue", !(await lib.getProductionQueue(d1)).some(j => j.orderId === "TRANS1"));

  console.log("\n=== Edit a configurable line's picks (editOrder reprices + rewrites the snapshot) ===");
  const p3 = await price({ garmentColor: "Navy", locations: { front: { graphicId: gLock, ink: "White" } } });
  await lib.insertOrder(d1, { orderId: "O3", orgId: "colonnade", customerName: "D", contact: "d@x.com", placedAt: "2026-08-02T00:00:00Z" },
    [{ productId: "rag", name: "Raglan", type: "shirt", size: "L", qty: 1, unitPrice: p3.unitPrice, config: p3.config }]);
  const it3 = (await lib.getOrderById(d1, "O3")).items[0];
  ok("starts at $20 (Front Lockup)", near((await lib.getOrderById(d1, "O3")).total, 20));
  // Change Front Lockup → Capital (large tier, +$4) and add the free Back mark.
  r = await call({ action: "editOrder", org: "colonnade", orderId: "O3",
    updates: [{ itemId: it3.id, productId: "rag", size: "L", qty: 1, config: { garmentColor: "Navy", locations: [{ location: "front", graphicId: gCap }, { location: "back", graphicId: gFree }] } }] });
  ok("editOrder succeeds", r.status === 200 && r.body.status !== "error");
  const o3 = await lib.getOrderById(d1, "O3");
  ok("repriced server-side to $22 (base + large tier), client price ignored", near(o3.total, 22));
  ok("the stored snapshot is rebuilt from the new picks", o3.items[0].config.locations.some(l => l.graphicName === "Capital + crest") &&
    o3.items[0].config.locations.some(l => l.location === "back" && l.graphicName === "Included mark"));
  // A tampered edit that empties the garment is refused; the line is left unchanged.
  r = await call({ action: "editOrder", org: "colonnade", orderId: "O3",
    updates: [{ itemId: it3.id, productId: "rag", size: "L", qty: 1, config: { garmentColor: "Navy", locations: [] } }] });
  ok("all-None edit rejected (400) and the line is unchanged ($22)", r.status === 400 && near((await lib.getOrderById(d1, "O3")).total, 22));

  console.log("\n=== admin.js + storefront wiring ===");
  const a = read("public/admin.js");
  ok("admin nav + routes: Transfers, Run Transfer Sheets, Graphics",
    /\["transfers", "Transfers"\]/.test(a) && /navGo\('runtransfer'\)/.test(a) && /raw === "transfers"/.test(a) &&
    /raw === "runtransfer"/.test(a) && /graphicsMatch/.test(a) && /location\.hash='#graphics\/'/.test(a));
  ok("admin screens exist", /async function renderTransfers/.test(a) && /async function renderGraphics/.test(a) &&
    /async function renderRunTransfer/.test(a) && /function showReceiveTransferModal_/.test(a) && /function loadProductConfigSection/.test(a) && /function loadOrgTierBox_/.test(a));
  ok("admin wires the new actions", /action: "receiveTransferSheet"/.test(a) && /action: "makeTransferLine"/.test(a) &&
    /action: "setTransferReceived"/.test(a) && /action: "getGangSheet"/.test(a) && /action: "saveGraphic"/.test(a) && /action: "setTierPrices"/.test(a));
  ok("Inventory & COGS shows a Transfer sheets section", /Transfer sheets<\/h3>/.test(a) && /d\.transfers/.test(a));
  ok("the gang sheet totals offer a CSV download", /id="rtGangCsv"/.test(a) &&
    /downloadCsv_\(`odd-gang-sheet-\$\{[^}]+\}\.csv`, rows,/.test(a));
  ok("Receive sheet can attach a stored receipt and import the total from a PDF",
    /id="trReceipt"/.test(a) && /id="trImport"/.test(a) && /function parseInvoiceTotal_/.test(a) && /body\.receiptKey = r\.key/.test(a));
  ok("Edit items has a configurable-line picker that sends config (server reprices)",
    /function cfgEditorHtml_/.test(a) && /data-cfgfield="graphic"/.test(a) && /row\.configurable \? \{ config: row\.config \}/.test(a) &&
    /showEditOrderModal\(order, products, \{ graphics, tiersCents \}\)/.test(a));

  // A graphic's "offered at" locations + garment colors are picked from checklists built from the
  // org's real configurable-product values — not free-typed names that must match a location key
  // exactly (a mismatch would silently hide the options). gfChecklist_ is pure, so unit-test it.
  const gfMatch = a.match(/function gfChecklist_\(items, selected, cls\)\{[\s\S]*?\n\}/);
  ok("gfChecklist_ helper exists", !!gfMatch);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const gfChecklist_ = new Function("escapeHtml", gfMatch[0] + "\nreturn gfChecklist_;")(esc);
  const items = [{ value: "front", label: "Front (front)", prods: ["Raglan", "Polo"] }, { value: "back", label: "Back (back)", prods: ["Raglan"] }];
  const h1 = gfChecklist_(items, ["front"], "gfLocChk");
  ok("checklist checks only the selected value", (h1.match(/checked/g) || []).length === 1 &&
    /value="front"[^>]*checked/.test(h1) && /value="back"(?![^>]*checked)/.test(h1));
  ok("each value lists the products that use it (its cross-product reach)",
    /Raglan, Polo/.test(h1) && /value="back"[\s\S]*?Raglan</.test(h1));
  const stale = gfChecklist_(items, ["sleeve"], "gfLocChk");
  ok("a graphic value no product uses any more is kept (checked, marked unused)",
    /value="sleeve"[^>]*checked/.test(stale) && /sleeve \(unused\)/.test(stale) && /used by no product/.test(stale));
  ok("no boxes checked = any (nothing checked for an empty selection)", !/checked/.test(gfChecklist_(items, [], "gfLocChk")));
  ok("empty catalog shows a note instead of a checklist", /None defined on a configurable product/.test(gfChecklist_([], [], "gfLocChk")));
  ok("the Graphics screen loads the org's products, records which use each value, and builds both checklists",
    /action: "listProducts", org: orgId/.test(a) && /products\.filter\(p => p\.configurable\)/.test(a) &&
    /prods: locMap\[k\]\.prods/.test(a) && /prods: colorMap\[c\]\.prods/.test(a) &&
    /gfChecklist_\(\(ctx\.allLocations/.test(a) && /gfChecklist_\(\(ctx\.allColors/.test(a) &&
    /querySelectorAll\("#gfLocs \.gfLocChk:checked"\)/.test(a) && /querySelectorAll\("#gfColors \.gfColorChk:checked"\)/.test(a));
  ok("the form explains leaving boxes unchecked offers it wherever a product offers the graphic",
    /Leave all unchecked to offer it wherever a product offers this graphic/.test(a));

  const h = read("public/index.html");
  ok("storefront: configurable branch + configurator + cart config",
    /if\(p\.configurable\) return renderConfigurableProduct/.test(h) && /function renderConfigurableProduct/.test(h) &&
    /function cfgRefresh_/.test(h) && /function cfgPicks_/.test(h) && /if\(product\.configurable\)/.test(h) && /garmentColor: color, locations:/.test(h));

  console.log("\n=== Personalization on a configurable product (typed name / preset words) ===");
  await lib.createProduct(d1, "colonnade", { productId: "cap9", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 16, visible: true, noDesignNeeded: true,
    personalizationPrice: 3, personalizationOptions: ["COACH", "CAPTAIN"],
    configurable: true, garmentColors: ["Navy"], reorderQr: "none", locations: [{ key: "front", label: "Front", graphicIds: [gLock] }] });
  const cfgCap = { garmentColor: "Navy", locations: { front: { graphicId: gLock, ink: "White" } } };
  const plain = await lib.priceItem(d1, "colonnade", "cap9", "OSFA", 1, false, cfgCap);
  const pers = await lib.priceItem(d1, "colonnade", "cap9", "OSFA", 1, true, cfgCap);
  ok("personalized configurable line adds the product's personalization fee (server-side)", near(plain.personalizationFee, 0) && near(pers.personalizationFee, 3) && near(pers.unitPrice, plain.unitPrice));
  const noPers = await lib.priceItem(d1, "colonnade", "rag", "L", 1, true, { garmentColor: "Navy", locations: { front: { graphicId: gLock, ink: "White" } } });
  ok("a product with no personalization price still charges nothing", near(noPers.personalizationFee, 0));

  const hh = read("public/index.html");
  ok("storefront: the configurable card has the personalization box (shared with plain products)",
    /function personalizeHtml_\(p\)/.test(hh) && /\$\{personalizeHtml_\(p\)\}\s*\n\s*<div class="cfg-preview"/.test(hh) && /const personalizeRow = personalizeHtml_\(p\)/.test(hh));
  ok("storefront: the cart line keeps the real name apart from the picks summary and charges the fee",
    /personalized: cPersonalized, persName: cPersName, cfgText: summary, personalizationFee: cPersFee, lineTotal: \(unitPrice \+ cPersFee\) \* qty/.test(hh) && /c\.cfgText/.test(hh));
  ok("storefront: price and breakdown include the personalization fee",
    /persFee = \(persEl && persEl\.checked && p\.personalizationPrice != null\)/.test(hh) && /<span>Personalization<\/span>/.test(hh));
  const em = read("functions/_lib/email.js"), ad = read("public/admin.js");
  ok("emails and the admin show the picks AND the personalization together",
    /function lineDetail_\(it\)/.test(em) && /lineDetail_\(it\)/.test(em) && /function lineDetail_\(it\)/.test(ad) && (ad.match(/lineDetail_\(it\)/g) || []).length >= 6);

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
