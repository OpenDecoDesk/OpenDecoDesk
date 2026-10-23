const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Blanks from stock: an order whose blanks are already on the shelf showed "Blanks not ordered
// yet" on Run Order — only an order's own blank stages counted, never the stock on hand. Now the run
// pages say "In stock" (soonest due first, so two orders aren't both promised the same blanks) with a
// "Use from stock" button, and the Orders stage menu has "Use blanks from stock": the waiting lines are
// marked ordered + received from "In stock", the blanks are spoken for, and they come out of stock when
// the order is made. Refused, saying what's short, when the stock doesn't cover the order.
// Real db.js / orders.js on sql.js; the admin pieces in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createProduct, setBlankLink, insertOrder, settleOrderBalance, getOrderById, getPaidUnrunOrders, getBlankStockCoverage,
  getBlanksToOrder, setFulfillmentStage, stagePrereqError, getBlankReservations };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, role) => { const r = (request.headers.get('x-role') || 'admin'); const rank = { staff: 1, manager: 2, admin: 3 }; return rank[r] >= rank[role === 'staff' || role === 'manager' ? role : 'admin'] ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1);`);
  const call = async (body, { role = "staff" } = {}) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "club" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  // The real case: Royal caps, one size, 14 on hand; two cap products linked to the same blank.
  const cap = (await lib.createBlank(d1, { name: "Five Panel Cap", productType: "cap", colors: [{ color: "Royal", images: [], sizes: [{ size: "OSFA", purchasePrice: 4.5, quantity: 14 }] }] })).id;
  for (const id of ["nd-cap", "od-cap"]) {
    await lib.createProduct(d1, "club", { productId: id, type: "cap", name: "Royal Cap " + id, pricingMode: "flat", flatPrice: 22, visible: true, noDesignNeeded: true });
    await lib.setBlankLink(d1, "club", id, "", "OSFA", cap, "Royal", "OSFA");
  }
  await lib.createProduct(d1, "club", { productId: "mug", type: "cap", name: "Unlinked thing", pricingMode: "flat", flatPrice: 5, visible: true });
  await lib.createProduct(d1, "club", { productId: "patch", type: "cap", name: "Patch", pricingMode: "flat", flatPrice: 5, visible: true, noBlankNeeded: true });
  let n = 0;
  const place = async (orderId, items, { paid = true, dueDate = null } = {}) => {
    n++;
    await lib.insertOrder(d1, { orderId, orgId: "club", customerName: "C" + n, contact: "c@x.com", paymentMethod: "Venmo", placedAt: `2026-10-0${n}T15:00:00.000Z`, dueDate },
      items.map(([productId, qty]) => ({ productId, name: "Royal Cap " + productId, type: "cap", size: "OSFA", qty, unitPrice: 22 })));
    if (paid) await lib.settleOrderBalance(d1, orderId, "test");
  };
  const stock = () => Number(d1.q(`SELECT quantity FROM blank_sizes WHERE blankId=${cap}`)[0].quantity);
  await place("A", [["nd-cap", 2], ["od-cap", 1]]);   // the real order: 3 caps
  await place("B", [["nd-cap", 12]]);                  // more than is left once A has its 3
  await place("U", [["nd-cap", 1]], { paid: false });
  await place("X", [["mug", 1]]);
  await place("N", [["patch", 2]]);

  console.log("=== What the run pages say ===");
  let unrun = await lib.getPaidUnrunOrders(d1);
  const st = (id) => unrun.find(o => o.orderId === id);
  ok("an order whose blanks are on the shelf says In stock, not 'not ordered yet'", st("A").blanksInStock === true && !st("A").blankOrdered);
  ok("stock goes to the orders in list order: after A's 3 there are 11, so B (12) isn't covered", st("B").blanksInStock === false);
  ok("…and a line with no blank link is never 'in stock'", st("X").blanksInStock === false);
  ok("a 'No blank needed' product never waits on stock (and isn't offered it)", st("N").needsBlanks === false && st("N").blanksInStock === false &&
    !(await lib.getBlankStockCoverage(d1, ["N"])).N);
  const cov = await lib.getBlankStockCoverage(d1, ["B"]);
  ok("(asked about alone, B would be covered — 14 on hand)", cov.B.covered && cov.B.lines[0].free === 14);

  console.log("\n=== Use blanks from stock ===");
  let r = await call({ action: "useBlanksFromStock", orderId: "U" });
  ok("an unpaid order can't take blanks yet", r.status === 409 && /isn't paid/.test(r.body.message));
  r = await call({ action: "useBlanksFromStock", orderId: "X" });
  ok("an item with no blank link is refused, saying so", r.status === 409 && /isn't linked to a blank/.test(r.body.message));
  r = await call({ action: "useBlanksFromStock", orderId: "A", org: "other" });
  ok("the order must belong to the shop named", r.status === 404);
  const KEY = `${cap}|Royal|OSFA`;
  ok("before anything is taken, nothing is set aside", Object.keys(await lib.getBlankReservations(d1)).length === 0);
  r = await call({ action: "useBlanksFromStock", orderId: "A" });
  ok("a worker can use blanks from stock (it's an order stage)", r.status === 200 && r.body.lines.length === 2);
  const a = await lib.getOrderById(d1, "A");
  ok("every line is marked ordered and received, from 'In stock'", a.items.every(i => i.blankOrderedAt && i.blankReceivedAt && i.blankVendor === "In stock") && a.blankReceivedAt && a.blankOrderedAt);
  ok("…so the blank no longer holds up making it", lib.stagePrereqError(a, "manufactured") !== "the blank hasn't been received yet");
  ok("…the order's 3 are spoken for (Blanks to Order won't offer them to anyone else)", stock() === 14 &&
    (await lib.getBlanksToOrder(d1)).suppliers.flatMap(s => s.rows).find(x => x.blankId === cap).reserved === 3);
  ok("…and it's in the audit log", Number(d1.q("SELECT count(*) n FROM audit_log WHERE action='order.blanks_from_stock' AND orderId='A'")[0].n) === 1);
  ok("the 3 show as set aside — still on hand, not yet deducted", (await lib.getBlankReservations(d1))[KEY] === 3 && stock() === 14);
  await place("V", [["nd-cap", 2]]); await place("K", [["od-cap", 1]]);
  await call({ action: "useBlanksFromStock", orderId: "V" }); await call({ action: "useBlanksFromStock", orderId: "K" });
  ok("(two more orders take 2 and 1: 6 set aside)", (await lib.getBlankReservations(d1))[KEY] === 6);
  d1._raw.run("UPDATE orders SET voidedAt='2026-10-10T00:00:00Z' WHERE orderId='V'; UPDATE order_items SET cancelDate='2026-10-10' WHERE orderId='K'");
  ok("a voided order and a cancelled line no longer hold any", (await lib.getBlankReservations(d1))[KEY] === 3);
  unrun = await lib.getPaidUnrunOrders(d1);
  ok("the run pages now say Blanks in", st("A").blankReceived && !st("A").blanksInStock);
  r = await call({ action: "useBlanksFromStock", orderId: "B" });
  ok("an order the stock can't cover is refused, saying what's short", r.status === 409 && /need 12, 11 free in stock/.test(r.body.message) && /Five Panel Cap · Royal · OSFA/.test(r.body.message));
  ok("…and nothing on it changes", !(await lib.getOrderById(d1, "B")).items.some(i => i.blankOrderedAt || i.blankReceivedAt));
  r = await call({ action: "useBlanksFromStock", orderId: "A" });
  ok("asking again for an order whose blanks are in says there's nothing waiting", r.status === 409 && /Nothing on this order is waiting/.test(r.body.message));
  await lib.setFulfillmentStage(d1, "A", "manufactured");
  ok("making the order uses the 3 from stock (14 → 11), like blanks bought for it", stock() === 11);
  ok("…and once made they're no longer set aside", !(await lib.getBlankReservations(d1))[KEY]);
  const gb = await call({ action: "getBlanks" });
  ok("the Blanks screen's data carries what's set aside", gb.status === 200 && gb.body.reserved && typeof gb.body.reserved === "object" && Array.isArray(gb.body.blanks));

  console.log("\n=== The admin ===");
  const adminJs = read("public/admin.js");
  const sent = [];
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/#runorder", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b); const x = b.action === "useBlanksFromStock" || b.action === "getBlanks" ? await call(b) : { status: 200, body: { status: "ok" } }; return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie";');
  const opts = (o) => { const div = d.createElement("div"); div.innerHTML = w.adminActionCell({ orgId: "club" }, o); return [...div.querySelectorAll("select option")].map(x => x.value); };
  const b = await lib.getOrderById(d1, "B");
  ok("the Orders stage menu offers 'Use blanks from stock' on a paid order waiting for its blanks", opts(b).includes("blanksFromStock") && /Use blanks from stock/.test(w.adminActionCell({ orgId: "club" }, b)));
  ok("…but not once its blanks are ordered", !opts(await lib.getOrderById(d1, "A")).includes("blanksFromStock"));
  unrun = await lib.getPaidUnrunOrders(d1);
  // Free 3 more caps' worth by cancelling down B's quantity: 11 on hand covers 9.
  d1._raw.run("UPDATE order_items SET qty=9 WHERE orderId='B'");
  unrun = await lib.getPaidUnrunOrders(d1);
  const html = w.paidUnrunHtml_(unrun.map(o => Object.assign({}, o)));
  const box = d.createElement("div"); box.innerHTML = html; d.body.appendChild(box);
  const rowOf = (id) => [...box.querySelectorAll("tr")].find(tr => [...tr.querySelectorAll("a")].some(a => a.textContent === id));
  ok("Run Order's list says In stock with a 'Use from stock' button for an order the shelf covers", /In stock/.test(rowOf("B").textContent) && rowOf("B").querySelector(".ro-use-stock"));
  ok("…and still 'Blanks not ordered yet' where it doesn't (no blank linked)", /Blanks not ordered yet/.test(rowOf("X").textContent) && !rowOf("X").querySelector(".ro-use-stock"));
  let rerendered = "";
  w.eval("renderRunOrder = async () => { window.__rr = 'runorder'; }; renderRunTransfer = async () => { window.__rr = 'runtransfer'; };");
  await w.paidUnrunUseStock_(rowOf("B").querySelector(".ro-use-stock"));
  rerendered = w.__rr;
  ok("clicking it takes the blanks and redraws the page", sent.some(x => x.action === "useBlanksFromStock" && x.orderId === "B" && x.org === "club") &&
    (await lib.getOrderById(d1, "B")).blankReceivedAt && rerendered === "runorder");
  // The Blanks screen now: 11 on hand, B's 9 set aside.
  const app = d.getElementById("app");
  await w.renderAdminBlanks(app);
  for (let i = 0; i < 100 && !d.querySelector(".blank-size-cell"); i++) await new Promise(res => setTimeout(res, 10));
  const cell = d.querySelector(".blank-size-cell"), rowText = cell ? cell.closest("tr").textContent.replace(/\s+/g, " ") : "";
  ok("the Blanks screen shows each size's set-aside count next to what's on hand", cell && /OSFA: 11 · 9 set aside · (avg )?\$/.test(cell.textContent.replace(/\s+/g, " ")) &&
    /11 on hand; 9 set aside for orders whose blanks are in — they come out of stock when those pieces are made/.test(cell.title));
  ok("…and the blank's total line says how many are set aside", /11 units · 9 set aside · \$/.test(rowText));
  ok("…and the page explains when blanks come out of stock", /Blanks come out of stock when the pieces are made/.test(app.textContent));
  d1._raw.run("UPDATE order_items SET blankOrderedAt=NULL, blankReceivedAt=NULL, blankVendor='' WHERE orderId='B'; UPDATE orders SET blankOrderedAt=NULL, blankReceivedAt=NULL WHERE orderId='B'");
  d1._raw.run("UPDATE order_items SET qty=30 WHERE orderId='B'");
  const toasts = []; w.eval("showToast = (m, e) => { window.__toasts = (window.__toasts || []).concat([[m, !!e]]); };");
  const okClick = await w.useBlanksFromStock_("club", "B");
  ok("when it's short, the page says what's short and nothing changes", okClick === false && /need 30, 11 free/.test((w.__toasts || []).slice(-1)[0][0]) && (w.__toasts || []).slice(-1)[0][1]);

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test126 crashed: false"); process.exit(1); });
