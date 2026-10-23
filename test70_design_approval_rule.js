const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Digitizing only when it's needed: when every product on an order already has a design
// linked and nothing is typed in, "digitizing complete" is skipped too (needsDigitizing); a product
// with no design, a custom line with no product, or free-form personalization text still needs it.
// Design approval only when it's needed: an order needs the customer's design approval
// only when an active line has FREE-FORM personalization text. No personalization, or text that is
// one of the product's preset options, skips approval — Mark manufactured then needs digitizing
// done instead (server stagePrereqError, the client stage dropdown, and the Run Order queue all
// agree). Run Order with nothing ready lists the orders "Waiting on blanks". Real SQL via sql.js.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, getOrdersByOrg, createProduct, getProductionQueue, getOrdersAwaitingBlanks, stagePrereqError };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

(async () => {
  try {
    const d1 = await createD1();
    d1._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
    const call = async (body) => {
      const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
        request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
      return { status: res.status, body: JSON.parse(await res.text()) };
    };
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','PRIME','t','t');`);
    // Free-text personalization (no options) vs preset options.
    await lib.createProduct(d1, "prime", { productId: "polo", type: "shirt", name: "Polo", pricingMode: "flat", flatPrice: 30, personalizationPrice: 5, visible: true });
    await lib.createProduct(d1, "prime", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 20, personalizationPrice: 3,
      personalizationOptions: ["Left side", "Right side"], visible: true });
    const line = (productId, extra) => Object.assign({ productId, name: productId, type: productId === "polo" ? "shirt" : "cap", size: productId === "polo" ? "L" : "OSFA", qty: 1, unitPrice: 20 }, extra || {});
    const order = async (id, items, dates = {}, extra = {}) => {
      await lib.insertOrder(d1, Object.assign({ orderId: id, orgId: "prime", customerName: "C " + id, contact: "c@x.com", placedAt: "2026-09-01T00:00:00Z" }, extra), items);
      for (const [col, v] of Object.entries(dates)) d1._raw.run(`UPDATE orders SET ${col}=? WHERE orderId=?`, [v, id]);
      // Mirror blank stamps onto the order's active items (per-item model, migrations/0039), the way
      // setFulfillmentStage would, so item-aware readers (getOrdersAwaitingBlanks) see them.
      for (const [col, v] of Object.entries(dates)) if (/^blank(OrderedAt|ShippedAt|ReceivedAt|Vendor|VendorOrderId|EstDelivery)$/.test(col))
        d1._raw.run(`UPDATE order_items SET ${col}=? WHERE orderId=? AND cancelDate IS NULL`, [v, id]);
    };
    const needs = async (id) => (await lib.getOrderById(d1, id)).needsDesignApproval;

    console.log("=== Which orders need design approval ===");
    await order("PLAIN", [line("polo"), line("cap")]);
    await order("PRESET", [line("cap", { personalized: true, persName: "Left side" })]);
    await order("FREE", [line("polo", { personalized: true, persName: "SAMWISE" })]);
    await order("MIXED", [line("cap", { personalized: true, persName: "Right side" }), line("polo", { personalized: true, persName: "FRODO" })]);
    await order("OFFLIST", [line("cap", { personalized: true, persName: "On the brim please" })]);
    await order("CUSTOM", [line("", { productId: "", name: "Custom patch", personalized: true, persName: "Team 9" })]);
    console.log("no personalization → no approval:", await needs("PLAIN") === false);
    console.log("a preset option → no approval:", await needs("PRESET") === false);
    console.log("free-form text → approval:", await needs("FREE") === true);
    console.log("any free-form line in the order → approval:", await needs("MIXED") === true);
    console.log("text that isn't one of the product's options (e.g. a hand-made request) → approval:", await needs("OFFLIST") === true);
    console.log("a personalized custom line with no product → approval:", await needs("CUSTOM") === true);
    const freeLine = d1.q("SELECT id FROM order_items WHERE orderId='MIXED' AND productId='polo'")[0].id;
    d1._raw.run("UPDATE order_items SET cancelDate='2026-09-02T00:00:00Z' WHERE id=?", [freeLine]);
    console.log("cancelling the only free-form line → no approval:", await needs("MIXED") === false);
    d1._raw.run("UPDATE products SET personalizationOptions='not json' WHERE productId='cap'");
    console.log("broken option JSON is treated as no options (approval), not an error:", await needs("PRESET") === true);
    d1._raw.run(`UPDATE products SET personalizationOptions='["Left side","Right side"]' WHERE productId='cap'`);
    const list = await lib.getOrdersByOrg(d1, "prime");
    console.log("the Orders list carries it on every order:", list.length === 6 && list.find(o => o.orderId === "PLAIN").needsDesignApproval === false && list.find(o => o.orderId === "FREE").needsDesignApproval === true);

    console.log("\n=== Mark manufactured (server stage check) ===");
    const prereq = async (id) => lib.stagePrereqError(await lib.getOrderById(d1, id), "manufactured");
    d1._raw.run("UPDATE orders SET paid=1, blankOrderedAt='2026-09-02', blankReceivedAt='2026-09-03' WHERE orderId IN ('PLAIN','FREE')");
    console.log("no approval needed, not digitized → refused for digitizing:", /digitizing isn't complete/.test(await prereq("PLAIN")));
    d1._raw.run("UPDATE orders SET digitizingCompleteAt='2026-09-03' WHERE orderId IN ('PLAIN','FREE')");
    console.log("no approval needed, digitized + blanks received → allowed:", await prereq("PLAIN") === "");
    console.log("free-form order, digitized but not approved → still refused:", /design isn't approved/.test(await prereq("FREE")));
    d1._raw.run("UPDATE orders SET designApprovedAt='2026-09-04' WHERE orderId='FREE'");
    console.log("free-form order once approved → allowed:", await prereq("FREE") === "");
    d1._raw.run("UPDATE orders SET blankReceivedAt=NULL WHERE orderId='PLAIN'");
    console.log("blanks still required either way:", /blank hasn't been received/.test(await prereq("PLAIN")));
    d1._raw.run("UPDATE orders SET blankReceivedAt='2026-09-03' WHERE orderId='PLAIN'");
    const r = await call({ action: "setFulfillmentStage", org: "prime", orderId: "PLAIN", stage: "manufactured" });
    console.log("the real setFulfillmentStage action marks it manufactured without an approval:", r.status === 200 && !!(await lib.getOrderById(d1, "PLAIN")).manufacturedAt);

    console.log("\n=== Run Order queue ===");
    await order("Q-PLAIN", [line("cap")], { paid: 1, blankOrderedAt: "2026-09-02", blankReceivedAt: "2026-09-03", digitizingCompleteAt: "2026-09-03" });
    await order("Q-PRESET", [line("cap", { personalized: true, persName: "Left side" })], { paid: 1, blankOrderedAt: "2026-09-02", blankReceivedAt: "2026-09-03", digitizingCompleteAt: "2026-09-03" });
    await order("Q-FREE", [line("polo", { personalized: true, persName: "PIPPIN" })], { paid: 1, blankOrderedAt: "2026-09-02", blankReceivedAt: "2026-09-03", digitizingCompleteAt: "2026-09-03" });
    await order("Q-NODIGI", [line("cap")], { paid: 1, blankOrderedAt: "2026-09-02", blankReceivedAt: "2026-09-03" });
    let q = (await lib.getProductionQueue(d1)).map(j => j.orderId);
    console.log("no-personalization and preset-option orders are ready once digitized — no approval:", q.includes("Q-PLAIN") && q.includes("Q-PRESET"));
    console.log("a free-form order waits for approval:", !q.includes("Q-FREE"));
    console.log("an order that isn't digitized yet isn't ready:", !q.includes("Q-NODIGI"));
    d1._raw.run("UPDATE orders SET designApprovedAt='2026-09-04' WHERE orderId='Q-FREE'");
    q = (await lib.getProductionQueue(d1)).map(j => j.orderId);
    console.log("…and joins the queue once approved:", q.includes("Q-FREE"));

    console.log("\n=== Waiting on blanks ===");
    await order("W-1", [line("polo"), line("cap", { qty: 2 })], { paid: 1, blankOrderedAt: "2026-09-05", blankVendor: "S&S", blankVendorOrderId: "SS-1", blankEstDelivery: "2026-09-09" });
    await order("W-OLD", [line("cap")], { paid: 1, blankOrderedAt: "2026-09-01" });
    await order("W-VOID", [line("cap")], { paid: 1, blankOrderedAt: "2026-09-01", voidedAt: "2026-09-02", voidReason: "x" });
    await order("W-TEST", [line("cap")], { paid: 1, blankOrderedAt: "2026-09-01", isTest: 1 });
    await order("W-CANCEL", [line("cap")], { paid: 1, blankOrderedAt: "2026-09-01" });
    d1._raw.run("UPDATE order_items SET cancelDate='2026-09-02T00:00:00Z' WHERE orderId='W-CANCEL'");
    const w = await lib.getOrdersAwaitingBlanks(d1);
    const wIds = w.map(o => o.orderId);
    console.log("lists orders with blanks ordered but not received, oldest blank order first:", wIds[0] === "W-OLD" && wIds.includes("W-1"));
    console.log("leaves out received, never-ordered, voided, test and fully cancelled orders:",
      !wIds.some(id => ["Q-PLAIN", "PRESET", "W-VOID", "W-TEST", "W-CANCEL"].includes(id)));
    const w1 = w.find(o => o.orderId === "W-1");
    console.log("carries vendor, vendor order #, expected date and the active items:",
      w1.blankVendor === "S&S" && w1.blankVendorOrderId === "SS-1" && /^2026-09-09/.test(w1.blankEstDelivery) && w1.items.length === 2 && w1.items[1].qty === 2);
    const qr = await call({ action: "getProductionQueue" });
    console.log("the getProductionQueue action returns the waiting list alongside the queue:", qr.status === 200 && Array.isArray(qr.body.queue) && qr.body.waitingOnBlanks.some(o => o.orderId === "W-1"));

    console.log("\n=== Digitizing is skipped when every product has a design ===");
    d1._raw.exec(`INSERT INTO designs (orgId, name, notes, stabilizer, createdAt, updatedAt) VALUES ('prime','Crest','','','t','t');`);
    const designId = d1.q("SELECT id FROM designs WHERE name='Crest'")[0].id;
    d1._raw.run("UPDATE products SET designId=? WHERE productId='cap'", [designId]);
    const digi = async (id) => (await lib.getOrderById(d1, id)).needsDigitizing;
    await order("D-CAP", [line("cap"), line("cap", { qty: 2 })]);
    await order("D-MIX", [line("cap"), line("polo")]);
    await order("D-CUSTOM", [line("cap"), line("", { productId: "", name: "Custom patch" })]);
    console.log("every product has a design → no digitizing:", await digi("D-CAP") === false);
    console.log("one product without a design → digitizing:", await digi("D-MIX") === true);
    console.log("a custom line with no product → digitizing:", await digi("D-CUSTOM") === true);
    d1._raw.run("UPDATE order_items SET cancelDate='2026-09-02T00:00:00Z' WHERE orderId='D-MIX' AND productId='polo'");
    console.log("cancelling the design-less line → no digitizing:", await digi("D-MIX") === false);
    d1._raw.run("UPDATE orders SET paid=1, blankOrderedAt='2026-09-02', blankReceivedAt='2026-09-03' WHERE orderId='D-CAP'");
    console.log("Mark manufactured needs neither approval nor digitizing — just the blanks:", await prereq("D-CAP") === "");
    q = (await lib.getProductionQueue(d1)).map(j => j.orderId);
    console.log("…and it's on Run Order straight away:", q.includes("D-CAP"));
    await order("D-FREE", [line("cap", { personalized: true, persName: "BILBO" })], { paid: 1, blankOrderedAt: "2026-09-02", blankReceivedAt: "2026-09-03" });
    console.log("typed-in text on a product with a design still needs digitizing (the name has to be digitized):", await digi("D-FREE") === true);
    const dFreeOrder = await lib.getOrderById(d1, "D-FREE");
    console.log("…and approval waits for it (first the order design upload, then digitizing), then manufacturing waits for approval:",
      /hasn't been uploaded/.test(lib.stagePrereqError(dFreeOrder, "designApproved")) &&
      /digitizing isn't complete/.test(lib.stagePrereqError(Object.assign({}, dFreeOrder, { orderDesignsMissing: 0 }), "designApproved")) &&
      /design isn't approved/.test(await prereq("D-FREE")) && !(await lib.getProductionQueue(d1)).some(j => j.orderId === "D-FREE"));
    await order("D-PRESET", [line("cap", { personalized: true, persName: "Left side" })]);
    console.log("a preset option on a product with a design needs neither step:", await digi("D-PRESET") === false && await needs("D-PRESET") === false);
    const listed = (await lib.getOrdersByOrg(d1, "prime")).find(o => o.orderId === "D-CAP");
    console.log("the Orders list carries needsDigitizing:", listed.needsDigitizing === false);

    console.log("\n=== Admin screens ===");
    const adminJs = read("public/admin.js");
    class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
    let qResp = { status: "ok", queue: [], waitingOnBlanks: [] };
    const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
      beforeParse(win) {
        win.fetch = async (url, opts) => {
          const b = opts && opts.body ? JSON.parse(opts.body) : {};
          const ok = (o) => ({ ok: true, status: 200, json: async () => Object.assign({ status: "ok" }, o) });
          if (String(url).includes("/api/catalog")) return ok({ status: "admin" });
          if (b.action === "getProductionQueue") return ok(qResp);
          if (b.action === "listMachines") return ok({ machines: [] });
          if (b.action === "listHoops") return ok({ hoops: [] });
          if (b.action === "listThreads") return ok({ threads: [] });
          if (b.action === "listActiveRuns") return ok({ activeRuns: [] });
          if (b.action === "listAbortReasons") return ok({ reasons: [] });
          return ok({});
        };
      } });
    const win = dom.window;
    await new Promise(res => setTimeout(res, 150));
    await win.loadAdminScript();
    win.eval('adminKey = "cookie"; adminOrgs = [{orgId:"prime", name:"Example League"}];');
    const stageOptions = (o) => { const el = win.document.createElement("div"); el.innerHTML = win.adminActionCell({ orgId: "prime", name: "PRIME" }, o);
      return [...el.querySelectorAll("select option")].map(x => x.value).filter(Boolean); };
    const base = { orderId: "X", items: [{ name: "Cap", cancelDate: "" }], paid: true, blankOrderedAt: "d", blankReceivedAt: "d", digitizingCompleteAt: "d" };
    const skip = stageOptions(Object.assign({ needsDesignApproval: false }, base));
    const need = stageOptions(Object.assign({ needsDesignApproval: true }, base));
    console.log("no approval needed: the stage menu offers Manufactured and not Design approved:", skip.includes("manufactured") && !skip.includes("designApproved"));
    console.log("approval needed: Design approved is offered and Manufactured waits for it:", need.includes("designApproved") && !need.includes("manufactured"));
    console.log("the Design Approved column says Not needed:", /Not needed/.test(win.fulfillmentBadge("", { needsDesignApproval: false }, "designApproved")) &&
      /—/.test(win.fulfillmentBadge("", { needsDesignApproval: true }, "designApproved")));
    const noDigi = Object.assign({}, base, { digitizingCompleteAt: "" });
    const dSkip = stageOptions(Object.assign({ needsDesignApproval: false, needsDigitizing: false }, noDigi));
    const dNeed = stageOptions(Object.assign({ needsDesignApproval: false, needsDigitizing: true }, noDigi));
    const dFree = stageOptions(Object.assign({ needsDesignApproval: true, needsDigitizing: true }, noDigi));
    console.log("every product has a design: no Digitizing in the menu, Manufactured offered:", !dSkip.includes("digitizingComplete") && dSkip.includes("manufactured"));
    console.log("a product without a design: Digitizing offered, Manufactured waits for it:", dNeed.includes("digitizingComplete") && !dNeed.includes("manufactured"));
    console.log("free-form text: Digitizing offered first, Design approved waits for it:", dFree.includes("digitizingComplete") && !dFree.includes("designApproved") && !dFree.includes("manufactured"));
    console.log("the Digitizing column says Not needed:", /Not needed/.test(win.fulfillmentBadge("", { needsDigitizing: false }, "digitizingComplete")) &&
      /—/.test(win.fulfillmentBadge("", { needsDigitizing: true }, "digitizingComplete")));
    const app = win.document.getElementById("app");
    qResp = { status: "ok", queue: [], waitingOnBlanks: [
      { orderId: "W-1", orgId: "prime", customerName: "Sam <i>G</i>", blankOrderedAt: "2026-09-05T00:00:00Z", blankVendor: "S&S", blankVendorOrderId: "SS-1", blankEstDelivery: "2000-01-01", items: [{ name: "Polo", type: "shirt", size: "L", qty: 2 }] }] };
    await win.renderRunOrder(app);
    await new Promise(res => setTimeout(res, 60));
    const body = win.document.getElementById("roBody");
    console.log("Run Order with nothing ready shows Waiting on blanks with each order:",
      /Waiting on blanks \(1\)/.test(body.textContent) && /W-1/.test(body.textContent) && /2 × Polo · L/.test(body.textContent) && /S&S · SS-1/.test(body.textContent));
    console.log("names are escaped, the shop is named, a past expected date is flagged overdue, the order links to its shop:",
      !body.querySelector(".ro-waiting-card i") && /Example League/.test(body.textContent) && /Overdue — expected 1\/1\/2000/.test(body.textContent) &&
      !!body.querySelector('.ro-waiting-card a[href="#orders/prime"]'));
    qResp = { status: "ok", queue: [], waitingOnBlanks: [] };
    await win.renderRunOrder(app);
    await new Promise(res => setTimeout(res, 60));
    console.log("no section when nothing is waiting:", !/Waiting on blanks/.test(win.document.getElementById("roBody").textContent));
  } catch (e) {
    console.log("test70 crashed:", false);
    console.error(e);
    process.exit(1);
  }
})();
