const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// "No blank needed" (products.noBlankNeeded, migrations/0057): a product made with no blank at all —
// a patch is twill and thread, which are shop supplies. Its order lines skip the blank steps, don't
// hold up Run Order, stay off the shopping list, and the catalog check doesn't ask for a blank link.
// Real SQL (sql.js), real db.js + orders.js admin API, and the admin screens in jsdom.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, createProduct, updateProduct, getProductsByOrg, createBlank, setBlankLink, createHoop,
  createThread, saveDesign, addDesignVersion, setProductDesign, getCatalogIssues, stagePrereqError, setFulfillmentStage, getProductionQueue,
  getPaidUnrunOrders, getBlanksToOrder, getCogsReport, getOrdersAwaitingBlanks, importProductsCsv, saveMachine };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendInvoiceEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const tick = (ms) => new Promise(res => setTimeout(res, ms || 60));

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1);`);
  const products = async () => lib.getProductsByOrg(d1, "club", false);

  // A patch (no blank) and a polo (linked to a blank), each with a design so nothing waits on digitizing.
  const hoop = await lib.createHoop(d1, { name: "4in Round", isCapFrame: false });
  const thread = await lib.createThread(d1, { brand: "Madeira", type: "PolyNeon", weight: "40", code: "1147", name: "Red", colorHex: "cc2222" });
  const design = async (productId) => {
    const id = await lib.saveDesign(d1, "club", { name: productId + " design", stabilizer: "cutaway", hoopId: hoop });
    await lib.addDesignVersion(d1, id, { designFileKey: "d/" + productId + ".emb", designFileName: productId + ".emb", designFileExt: "emb",
      machineFileKey: "d/" + productId + ".exp", machineFileName: productId + ".exp", machineFileExt: "exp", threadColors: [{ needle: 1, threadId: thread }] });
    await lib.setProductDesign(d1, "club", productId, id);
  };

  console.log("=== The product setting ===");
  await lib.createProduct(d1, "club", { productId: "patch", type: "patch", name: "Club Patch", pricingMode: "flat", flatPrice: 6, visible: true, noBlankNeeded: true });
  await lib.createProduct(d1, "club", { productId: "polo", type: "shirt", name: "Polo", pricingMode: "sized", sizePricing: { M: 25 }, visible: true });
  await design("patch"); await design("polo");
  const blankId = (await lib.createBlank(d1, { name: "ST650", vendor: "SanMar", productType: "shirt", colors: [{ color: "", sizes: [{ size: "M", purchasePrice: 8, quantity: 0 }] }] })).id;
  await lib.setBlankLink(d1, "club", "polo", "M", blankId, "M");
  let ps = await products();
  console.log("created with it on / left off:", ps.find(p => p.productId === "patch").noBlankNeeded === true && ps.find(p => p.productId === "polo").noBlankNeeded === false);
  // An importer or script that doesn't know the field must not clear it.
  await lib.updateProduct(d1, "club", { productId: "patch", type: "patch", name: "Club Patch v2", pricingMode: "flat", flatPrice: 6, visible: true, images: [], features: [] });
  ps = await products();
  console.log("an update that doesn't mention it keeps it:", ps.find(p => p.productId === "patch").name === "Club Patch v2" && ps.find(p => p.productId === "patch").noBlankNeeded === true);
  let r = await call({ action: "updateProduct", org: "club", productId: "polo", type: "shirt", name: "Polo", pricingMode: "sized", sizePricing: { M: 25 }, images: [], features: [], visible: true, noBlankNeeded: true });
  console.log("the admin API turns it on:", r.status === 200 && (await products()).find(p => p.productId === "polo").noBlankNeeded === true);
  const audited = d1.q("SELECT detail FROM audit_log WHERE action='product.updated' ORDER BY id DESC LIMIT 1")[0];
  console.log("...and the change is in the audit log:", !!audited && /noBlankNeeded/.test(audited.detail));
  await call({ action: "updateProduct", org: "club", productId: "polo", type: "shirt", name: "Polo", pricingMode: "sized", sizePricing: { M: 25 }, images: [], features: [], visible: true, noBlankNeeded: false });
  console.log("...and off again:", (await products()).find(p => p.productId === "polo").noBlankNeeded === false);

  console.log("\n=== Catalog check ===");
  let issues = await lib.getCatalogIssues(d1, "club");
  console.log("a no-blank product isn't flagged for having no blank link:", !issues.orgs.club.products.patch);
  await lib.updateProduct(d1, "club", { productId: "patch", type: "patch", name: "Club Patch", pricingMode: "flat", flatPrice: 6, visible: true, images: [], features: [], noBlankNeeded: false });
  issues = await lib.getCatalogIssues(d1, "club");
  console.log("with the setting off, the same product is flagged:", (issues.orgs.club.products.patch || []).some(x => x.code === "noBlankLink"));
  await lib.updateProduct(d1, "club", { productId: "patch", type: "patch", name: "Club Patch", pricingMode: "flat", flatPrice: 6, visible: true, images: [], features: [], noBlankNeeded: true });

  // Orders: patch only, polo only, and one of each.
  const order = async (id, items) => {
    await lib.insertOrder(d1, { orderId: id, orgId: "club", customerName: "Cust " + id, contact: id + "@x.com", placedAt: "2026-10-01T00:00:00Z" }, items);
    d1._raw.run("UPDATE orders SET paid=1 WHERE orderId=?", [id]);
  };
  const patchLine = { productId: "patch", name: "Club Patch", type: "patch", size: "OSFA", qty: 2, unitPrice: 6 };
  const poloLine = { productId: "polo", name: "Polo", type: "shirt", size: "M", qty: 1, unitPrice: 25 };
  await order("PATCH1", [patchLine]);
  await order("POLO1", [poloLine]);
  await order("MIXED1", [patchLine, poloLine]);

  console.log("\n=== An order of only no-blank products has no blank steps ===");
  let o = await lib.getOrderById(d1, "PATCH1");
  console.log("the order says it needs no blanks; its line is marked:", o.needsBlanks === false && o.items[0].noBlank === true);
  console.log("blank progress counts no lines:", o.blankCounts.total === 0);
  console.log("Mark blank ordered / shipped / received are refused with the reason:",
    ["blankOrdered", "blankShipped", "blankReceived"].every(s => /nothing on this order uses a blank/.test(lib.stagePrereqError(o, s))));
  console.log("Mark manufactured doesn't wait for a blank:", lib.stagePrereqError(o, "manufactured") === "");
  r = await call({ action: "setFulfillmentStage", org: "club", orderId: "PATCH1", stage: "blankOrdered", vendor: "X" });
  console.log("the API refuses the blank step too (409):", r.status === 409 && /nothing on this order uses a blank/.test(r.body.message));
  o = await lib.getOrderById(d1, "POLO1");
  console.log("an ordinary order still needs its blank:", o.needsBlanks === true && o.blankCounts.total === 1 && /blank hasn't been received/.test(lib.stagePrereqError(o, "manufactured")));

  console.log("\n=== A mixed order: only the lines that use a blank go through the blank steps ===");
  o = await lib.getOrderById(d1, "MIXED1");
  console.log("it needs blanks, for one of its two lines:", o.needsBlanks === true && o.blankCounts.total === 1 && o.items.map(it => it.noBlank).join() === "true,false");
  r = await call({ action: "setFulfillmentStage", org: "club", orderId: "MIXED1", stage: "blankOrdered", vendor: "SanMar", vendorOrderId: "PO-1" });
  o = await lib.getOrderById(d1, "MIXED1");
  const patchItem = o.items.find(it => it.noBlank), poloItem = o.items.find(it => !it.noBlank);
  console.log("Mark blank ordered stamps the polo line, not the patch line:", r.status === 200 && !!poloItem.blankOrderedAt && !patchItem.blankOrderedAt);
  console.log("...and the order counts as ordered (it isn't waiting on the patch):", !!o.blankOrderedAt && o.blankCounts.ordered === 1);
  const waiting = await lib.getOrdersAwaitingBlanks(d1);
  console.log("'Waiting on blanks' lists only the polo line:", waiting.length === 1 && waiting[0].orderId === "MIXED1" && waiting[0].items.length === 1 && waiting[0].items[0].name === "Polo");

  console.log("\n=== Run Order ===");
  let queue = await lib.getProductionQueue(d1);
  const jobs = (oid) => queue.filter(j => j.orderId === oid);
  console.log("a paid patch-only order is ready to run with no blank received:", jobs("PATCH1").length === 1 && jobs("PATCH1")[0].noBlankNeeded === true && jobs("PATCH1")[0].blank === null);
  console.log("the polo-only order still waits for its blank:", jobs("POLO1").length === 0);
  console.log("on the mixed order the patch line can run now; the polo line waits:", jobs("MIXED1").length === 1 && jobs("MIXED1")[0].itemName === "Club Patch");
  await call({ action: "setFulfillmentStage", org: "club", orderId: "MIXED1", stage: "blankReceived" });
  queue = await lib.getProductionQueue(d1);
  o = await lib.getOrderById(d1, "MIXED1");
  console.log("once the polo's blank is in, the order counts as received and both lines can run:", !!o.blankReceivedAt && jobs("MIXED1").length === 2);
  const unrun = await lib.getPaidUnrunOrders(d1);
  console.log("the run backlog knows which orders need no blanks:", unrun.find(x => x.orderId === "PATCH1").needsBlanks === false && unrun.find(x => x.orderId === "POLO1").needsBlanks === true);

  console.log("\n=== Blanks to Order ===");
  const shop = await lib.getBlanksToOrder(d1);
  const allRows = shop.suppliers.flatMap(s => s.rows);
  console.log("the polo is on the shopping list:", allRows.some(x => x.blank === "ST650" && x.needed === 1));
  console.log("the patch lines are neither on the list nor reported as 'not linked':", !shop.unlinked.some(u => /Patch/.test(u.name)) && !allRows.some(x => /Patch/.test(x.blank)));

  console.log("\n=== Making it ===");
  r = await call({ action: "setFulfillmentStage", org: "club", orderId: "PATCH1", stage: "manufactured" });
  o = await lib.getOrderById(d1, "PATCH1");
  console.log("a patch-only order can be marked manufactured straight away:", r.status === 200 && !!o.manufacturedAt);
  const cogs = await lib.getCogsReport(d1, "2000-01-01", "2100-01-01");
  console.log("it isn't reported as a made item with a missing blank cost:", !cogs.missingCost.some(m => m.orderId === "PATCH1"));

  console.log("\n=== CSV import ===");
  const P = (x) => Object.assign({ sku: "", category: "", name: "", price: "", sizes: "" }, x);
  let imp = await lib.importProductsCsv(d1, "club", [P({ sku: "PATCH-B", category: "Patches", name: "Square Patch", price: "7.00", no_blank_needed: "TRUE" })], { dryRun: false });
  const madeB = (await products()).find(p => p.productId === "patch-b");
  console.log("no_blank_needed TRUE sets it:", imp.created === 1 && madeB.noBlankNeeded === true);
  console.log("...and the row isn't nagged about having no blank_style:", !imp.results[0].notes.some(n => /No blank_style/.test(n)));
  imp = await lib.importProductsCsv(d1, "club", [P({ sku: "PATCH-C", category: "Patches", name: "Oval Patch", price: "7.00" })], { dryRun: true });
  console.log("without it, the note is still there:", imp.results[0].notes.some(n => /No blank_style/.test(n)));
  imp = await lib.importProductsCsv(d1, "club", [P({ sku: "PATCH-B", category: "Patches", name: "Square Patch 2", price: "7.50" })], { dryRun: false });
  console.log("re-importing a file without the column keeps the setting:", (await products()).find(p => p.productId === "patch-b").noBlankNeeded === true && !imp.results[0].notes.some(n => /No blank_style/.test(n)));

  // ---- The admin screens -------------------------------------------------------------------
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o2){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o2); } }
  const sent = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = async (url, opts) => {
        if (String(url).includes("/api/orders") && opts && opts.body) { const b = JSON.parse(opts.body); sent.push(b); const res = await call(b); return { ok: res.status < 400, status: res.status, json: async () => res.body }; }
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

  console.log("\n=== Admin: product form ===");
  w._adminOrgRegistry = [{ orgId: "club", name: "Club" }];
  w.renderProductForm(app, "club", (await products()).find(p => p.productId === "patch"));
  console.log("the form has a 'No blank needed' box, ticked for the patch:", !!doc.getElementById("prodFormNoBlank") && doc.getElementById("prodFormNoBlank").checked === true);
  w.renderProductForm(app, "club", (await products()).find(p => p.productId === "polo"));
  console.log("...and unticked for the polo:", doc.getElementById("prodFormNoBlank").checked === false);
  console.log("saving the form sends the setting:", /noBlankNeeded: document\.getElementById\("prodFormNoBlank"\)\.checked/.test(adminJs));

  console.log("\n=== Admin: Orders table ===");
  const org = { orgId: "club", name: "Club" };
  const patchOnly = await lib.getOrderById(d1, "PATCH1");
  d1._raw.run("UPDATE orders SET manufacturedAt=NULL WHERE orderId='PATCH1'");
  d1._raw.run("UPDATE order_items SET manufacturedQty=0 WHERE orderId='PATCH1'");
  const fresh = await lib.getOrderById(d1, "PATCH1");
  console.log("the blank columns read 'Not needed' for a patch-only order:",
    ["blankOrdered", "blankShipped", "blankReceived"].every(s => /Not needed/.test(w.fulfillmentBadge("", fresh, s))));
  const polo1 = await lib.getOrderById(d1, "POLO1");
  console.log("...and stay a dash for an ordinary order:", !/Not needed/.test(w.fulfillmentBadge("", polo1, "blankOrdered")));
  const stages = (ord) => { const d = doc.createElement("div"); d.innerHTML = w.adminActionCell(org, ord); return [...d.querySelectorAll("select option")].map(x => x.value).filter(Boolean); };
  console.log("its stage menu offers Mark manufactured and none of the blank steps:", stages(fresh).includes("manufactured") && !stages(fresh).some(x => /^blank/.test(x)));
  console.log("an ordinary paid order is still offered Mark blank ordered, not Mark manufactured:", stages(polo1).includes("blankOrdered") && !stages(polo1).includes("manufactured"));
  const mixed = await lib.getOrderById(d1, "MIXED1");
  console.log("the lines offered for a blank step leave out the patch:", w.blankItemsOf_([mixed]).length === 1 && /Polo/.test(w.blankItemsOf_([mixed])[0].label));

  console.log("\n=== Admin: Run Order ===");
  await lib.saveMachine(d1, { name: "Machine 1", needleCount: 15, hoopIds: [hoop] });
  await w.renderRunOrder(app);
  await settle(() => app.querySelector(".run-job-card"));
  const text = app.textContent.replace(/\s+/g, " ");
  console.log("patch jobs are grouped under 'No blank needed', not 'No blank linked':", /No blank needed/.test(text) && !/No blank linked/.test(text));
  const patchCard = [...app.querySelectorAll(".run-job-card")].find(c => c.querySelector("[data-orderid='PATCH1']"));
  console.log("the needle line says why there's no needle type:", !!patchCard && /made without a blank, so no needle type/.test(patchCard.querySelector(".run-needle").textContent));
  console.log("the backlog says 'No blank needed' for the patch-only order:", /No blank needed<\/span>/.test(w.paidUnrunHtml_(await lib.getPaidUnrunOrders(d1))));
  void patchOnly;
})().catch(e => { console.error(e); console.log("test118 ran to the end without crashing: false"); process.exitCode = 1; });
