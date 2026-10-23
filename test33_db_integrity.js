const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Database-design regression tests — the REAL migrations and the REAL
// functions/_lib/db.js against a real SQLite engine (sql.js), not mocks:
//   A. migrations/0006 on a seeded pre-0006 database: nothing lost, every
//      dollar amount becomes the exact integer-cents value, '' dates -> NULL,
//      paidAt backfilled, ship state/ZIP derived.
//   B. Drift guard: schema.sql (fresh installs) == pre-0006 schema + 0006.
//   C. Foreign keys + CHECK constraints actually reject bad rows.
//   D. db.js end-to-end: dollars in/out, exact cents arithmetic, and the
//      paid flag derived from the payments ledger.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const dbSrc = read("functions/_lib/db.js").replace(/export (async function|function|const)/g, "$1");
const DB_EXPORTS = ["priceItem", "insertOrder", "getOrderById", "getOrdersByOrg", "addOrderPayment",
  "deleteOrderPayment", "getOrderPaymentById", "refreshPaidStatus", "settleOrderBalance", "setOrderDiscount",
  "cancelLineItem", "createProduct", "updateProduct", "getProductsByOrg", "createBlank", "getAllBlanks",
  "getRevenueData", "setLineItemRefund", "getOrderItemById", "getOrderCheckoutState", "addShippingPayment",
  "recalcOrderTotals", "updateOrderItem", "addOrderItem", "updateOrderShipping", "deleteOrder"];
const lib = new Function(dbSrc + "\nreturn {" + DB_EXPORTS.join(",") + "};")();

const cols = (d1, t) => d1.q(`SELECT name, type, "notnull", hidden FROM pragma_table_xinfo('${t}') ORDER BY name`)
  .map(c => c.name + ":" + c.type + ":" + c.notnull + ":" + c.hidden).join(",");
const REBUILT = ["orders", "order_items", "order_payments", "design_verifications", "products", "blank_sizes"];

async function seededPre0006(){
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('org-a','orga','Org A','t','t'), ('org-b','orgb','Org B','t','t');
    INSERT INTO products (productId, orgId, type, name, personalizationPrice, pricingMode, flatPrice, sizePricing, createdAt, updatedAt) VALUES
      ('polo','org-a','shirt','Polo',5.5,'sized',NULL,'{"S":19.99,"M":19.99,"XL":22.5}','t','t'),
      ('cap','org-a','cap','Cap',NULL,'flat',14.95,'{}','t','t');
    INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, paidAt, subtotal, shippingCost, total,
                        shippingAddress, discountAmount, shippedAt, placedAt) VALUES
      ('O-PAID','org-a','Ann','a@x.com','Venmo',1,'',59.97,8.35,68.32,'{"name":"Ann","line1":"1 Main","city":"Springfield","state":"oh","zip":"45503-1234"}',0,'2026-09-10T00:00:00Z','2026-09-01T00:00:00Z'),
      ('O-OPEN','org-a','Bob','b@x.com','Card',0,'',44.9,0,44.9,NULL,4.9,'','2026-09-02T00:00:00Z'),
      ('O-B',   'org-b','Cy', 'c@x.com','Check',1,'2026-09-05T00:00:00Z',14.95,0,14.95,NULL,0,'','2026-09-03T00:00:00Z');
    INSERT INTO order_items (orderId, orgId, productId, name, type, size, qty, unitPrice, personalizationFee, lineTotal, cancelDate, refundAmount) VALUES
      ('O-PAID','org-a','polo','Polo','shirt','S',3,19.99,0,59.97,'',NULL),
      ('O-OPEN','org-a','polo','Polo','shirt','XL',1,22.5,5.5,28.0,'',NULL),
      ('O-OPEN','org-a','cap','Cap','cap','',1,14.95,0,14.95,'2026-09-03T00:00:00Z',14.95),
      ('O-OPEN','org-a','cap','Cap','cap','',1,16.9,0,16.9,'',NULL),
      ('O-B','org-b','x','Thing','cap','',1,14.95,0,14.95,'',NULL);
    INSERT INTO order_payments (orderId, amount, note, receivedAt) VALUES
      ('O-PAID', 40.00, 'Venmo', '2026-09-01T10:00:00Z'), ('O-PAID', 28.32, 'Venmo', '2026-09-04T10:00:00Z'),
      ('O-B', 14.95, 'check', '2026-09-05T00:00:00Z');
    INSERT INTO blanks (id, name, createdAt, updatedAt) VALUES (1,'Gildan','t','t');
    INSERT INTO blank_sizes (blankId, size, purchasePrice, quantity) VALUES (1,'S',3.49,10),(1,'M',3.49,4);
    INSERT INTO design_verifications (token, orgId, orderId, customerEmail, sentAt) VALUES ('tok','org-a','O-OPEN','b@x.com','2026-09-02');
  `);
  return d1;
}

(async () => {
  // ===================================================================
  // A. Migration 0006 preserves everything
  // ===================================================================
  console.log("=== A. migrations/0006 on a seeded pre-0006 database ===");
  const d1 = await seededPre0006();
  const before = {
    orders: d1.q("SELECT orderId, CAST(round(total*100) AS INT) t, CAST(round(subtotal*100) AS INT) s, CAST(round(shippingCost*100) AS INT) sh, CAST(round(discountAmount*100) AS INT) d, paid FROM orders ORDER BY orderId"),
    items: d1.q("SELECT id, CAST(round(unitPrice*100) AS INT) u, CAST(round(personalizationFee*100) AS INT) f, CAST(round(lineTotal*100) AS INT) l, qty FROM order_items ORDER BY id"),
    pays: d1.q("SELECT id, CAST(round(amount*100) AS INT) a FROM order_payments ORDER BY id"),
  };
  d1.execFile(read("migrations/0006_ledger_integrity.sql"));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  console.log("orders: every total/subtotal/shipping/discount now exact cents:",
    same(before.orders, d1.q("SELECT orderId, totalCents t, subtotalCents s, shippingCostCents sh, discountCents d, paid FROM orders ORDER BY orderId")));
  console.log("items: unit/fee/line exact cents, qty kept:",
    same(before.items, d1.q("SELECT id, unitPriceCents u, personalizationFeeCents f, lineTotalCents l, qty FROM order_items ORDER BY id")));
  console.log("payments: exact cents, ids kept:", same(before.pays, d1.q("SELECT id, amountCents a FROM order_payments ORDER BY id")));
  console.log("float-trap values exact (19.99×3 = 5997, 68.32 = 6832):",
    d1.q("SELECT lineTotalCents FROM order_items WHERE orderId='O-PAID'")[0].lineTotalCents === 5997 &&
    d1.q("SELECT totalCents FROM orders WHERE orderId='O-PAID'")[0].totalCents === 6832);
  console.log("money columns are INTEGER:", d1.q("SELECT typeof(totalCents) t FROM orders").every(r => r.t === "integer"));
  console.log("products: size prices converted inside the JSON:",
    d1.q("SELECT sizePricingCents FROM products WHERE productId='polo'")[0].sizePricingCents === '{"S":1999,"M":1999,"XL":2250}');
  console.log("products: flat + personalization prices in cents (NULL stays NULL):",
    same(d1.q("SELECT productId, flatPriceCents f, personalizationPriceCents p FROM products ORDER BY productId"),
      [{ productId: "cap", f: 1495, p: null }, { productId: "polo", f: null, p: 550 }]));
  console.log("blank costs in cents:", same(d1.q("SELECT purchasePriceCents c FROM blank_sizes ORDER BY size"), [{ c: 349 }, { c: 349 }]));
  console.log("'' dates became NULL (none left):",
    d1.q("SELECT count(*) n FROM orders WHERE paidAt='' OR shippedAt='' OR refundedAt=''")[0].n === 0 &&
    d1.q("SELECT count(*) n FROM order_items WHERE cancelDate='' OR refundDate=''")[0].n === 0 &&
    d1.q("SELECT respondedAt FROM design_verifications")[0].respondedAt === null);
  console.log("real dates kept:", d1.q("SELECT shippedAt FROM orders WHERE orderId='O-PAID'")[0].shippedAt === "2026-09-10T00:00:00Z" &&
    d1.q("SELECT paidAt FROM orders WHERE orderId='O-B'")[0].paidAt === "2026-09-05T00:00:00Z");
  console.log("paid order missing paidAt backfilled from its latest payment:",
    d1.q("SELECT paidAt FROM orders WHERE orderId='O-PAID'")[0].paidAt === "2026-09-04T10:00:00Z");
  console.log("unpaid order still has no paidAt:", d1.q("SELECT paidAt FROM orders WHERE orderId='O-OPEN'")[0].paidAt === null);
  console.log("ship state/ZIP derived (uppercased, 5-digit):",
    same(d1.q("SELECT shipState, shipZip FROM orders WHERE orderId='O-PAID'")[0], { shipState: "OH", shipZip: "45503" }));
  console.log("no foreign-key violations:", d1.q("PRAGMA foreign_key_check").length === 0);
  console.log("old tables dropped:", d1.q("SELECT count(*) n FROM sqlite_master WHERE name LIKE '%\\_old' ESCAPE '\\'")[0].n === 0);

  // ===================================================================
  // B. Drift guard — schema.sql must equal pre-0006 + 0006
  // ===================================================================
  console.log("\n=== B. schema.sql (fresh installs) == pre-0006 fixture + EVERY later migration ===");
  // Apply the remaining migrations (0007+) to a copy of the migrated DB, so
  // schema.sql is checked against the full chain, not just 0006.
  const chain = await seededPre0006();
  const later = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_.*\.sql$/.test(f) && f >= "0006").sort();
  for(const f of later) chain.execFile(read("migrations/" + f));
  console.log("migrations applied after the fixture:", later.join(", "));
  const fresh = await createD1();
  fresh._raw.exec(read("schema.sql"));
  const tables = (db) => db.q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r.name);
  console.log("same set of tables:", tables(fresh).join(",") === tables(chain).join(","));
  for(const t of tables(chain)){
    if(cols(fresh, t) !== cols(chain, t)) console.log(t + ": fresh schema.sql == migrated:", false);
  }
  console.log("every table's columns identical:", tables(chain).every(t => cols(fresh, t) === cols(chain, t)));
  // (idx_inventory_type exists only in schema.sql — legacy, empty table; the migrations never create it)
  const idx = (db) => db.q("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND name <> 'idx_inventory_type' ORDER BY name").map(r => r.name).join(",");
  console.log("indexes identical:", idx(fresh) === idx(chain));
  const setting = (db) => (db.q("SELECT value FROM global_settings WHERE key='salesTax'")[0] || {}).value;
  // A fresh install has NO sales-tax setting (unset until the admin saves one). The migration chain
  // agrees for a database that was never used (0051 removes 0007's seed), and leaves a database
  // with order history — the fixture — exactly as it was.
  const unused = await createD1();
  unused._raw.exec(read("testlib/schema-pre-0006.sql"));
  for(const f of later) unused.execFile(read("migrations/" + f));
  console.log("no default sales-tax setting on a fresh install, same as an unused migrated database:", setting(fresh) === undefined && setting(unused) === undefined);
  console.log("a database with orders keeps its sales-tax setting:", !!setting(chain));
  // Bring the section-A database up to the latest migration too, so C and D
  // exercise the current db.js against the current schema.
  for(const f of later.filter(f => f >= "0007")) d1.execFile(read("migrations/" + f));

  // ===================================================================
  // C. Constraints reject bad data
  // ===================================================================
  console.log("\n=== C. foreign keys + CHECK constraints ===");
  const rejects = (sql) => { try{ d1._raw.run(sql); return false; }catch(e){ return true; } };
  console.log("order for an unknown org rejected:", rejects("INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('X1','nope','n','c','t')"));
  console.log("negative total rejected:", rejects("INSERT INTO orders (orderId, orgId, customerName, contact, totalCents, placedAt) VALUES ('X2','org-a','n','c',-1,'t')"));
  console.log("paid must be 0/1:", rejects("UPDATE orders SET paid=2 WHERE orderId='O-B'"));
  console.log("item with qty 0 rejected:", rejects("INSERT INTO order_items (orderId, orgId, name, type, qty) VALUES ('O-B','org-b','n','t',0)"));
  console.log("item for a missing order rejected:", rejects("INSERT INTO order_items (orderId, orgId, name, type) VALUES ('NOPE','org-b','n','t')"));
  console.log("zero-amount payment rejected:", rejects("INSERT INTO order_payments (orderId, amountCents, receivedAt) VALUES ('O-B',0,'t')"));
  console.log("negative payment ALLOWED (future refund rows):", !rejects("INSERT INTO order_payments (orderId, amountCents, note, receivedAt) VALUES ('O-B',-100,'probe','t')"));
  d1._raw.run("DELETE FROM order_payments WHERE note='probe'");
  console.log("invalid shipping-address JSON rejected:", rejects("UPDATE orders SET shippingAddress='{bad' WHERE orderId='O-B'"));
  console.log("bad pricingMode rejected:", rejects("UPDATE products SET pricingMode='free' WHERE productId='cap'"));
  console.log("bad verification status rejected:", rejects("UPDATE design_verifications SET status='maybe'"));

  // ===================================================================
  // D. db.js end-to-end on the migrated database
  // ===================================================================
  console.log("\n=== D. db.js: dollars in/out, cents inside ===");
  const p1 = await lib.priceItem(d1, "org-a", "polo", "XL", 1, true);
  console.log("priceItem sized + personalization → dollars:", p1.unitPrice === 22.5 && p1.personalizationFee === 5.5 && p1.name === "Polo");
  const p2 = await lib.priceItem(d1, "org-a", "cap", "", 1, false);
  console.log("priceItem flat → dollars:", p2.unitPrice === 14.95);

  await lib.insertOrder(d1, { orderId: "N1", orgId: "org-a", customerName: "Dee", contact: "d@x.com", paymentMethod: "Venmo",
    shippingCost: 0.1, placedAt: "2026-09-20T00:00:00Z", shippingAddress: { state: "oh", zip: "44101" } },
    [{ productId: "polo", name: "Polo", type: "shirt", size: "S", qty: 3, unitPrice: 19.99, personalizationFee: 0.1, lineTotal: 60.27 },
     { productId: "cap", name: "Cap", type: "cap", size: "", qty: 7, unitPrice: 0.1, personalizationFee: 0.2 }]);
  const n1 = d1.q("SELECT subtotalCents, totalCents, shipState FROM orders WHERE orderId='N1'")[0];
  console.log("insertOrder sums in cents: 3×(19.99+0.10) + 7×(0.10+0.20) = 62.37 exactly:", n1.subtotalCents === 6237 && n1.totalCents === 6247);
  console.log("ship state from the new order's address:", n1.shipState === "OH");
  let o = await lib.getOrderById(d1, "N1");
  console.log("getOrderById returns dollars:", o.total === 62.47 && o.items[0].lineTotal === 60.27 && o.items[1].lineTotal === 2.1);
  console.log("unset dates come back as '' (client contract unchanged):", o.paidAt === "" && o.shippedAt === "" && o.items[0].cancelDate === "");

  console.log("\n=== D. paid is derived from the payments ledger ===");
  await lib.addOrderPayment(d1, "N1", 30, "Venmo");
  o = await lib.getOrderById(d1, "N1");
  console.log("partial payment → still unpaid, balance $32.47:", o.paid === false && o.balanceDue === 32.47);
  const pid = await lib.addOrderPayment(d1, "N1", 32.47, "Venmo");
  o = await lib.getOrderById(d1, "N1");
  console.log("ledger covers total → paid, paidAt set:", o.paid === true && o.paidAt !== "" && o.balanceDue === 0);
  const pay = await lib.getOrderPaymentById(d1, pid);
  console.log("getOrderPaymentById returns dollars:", pay.amount === 32.47 && pay.orderId === "N1");
  await lib.deleteOrderPayment(d1, pid);
  o = await lib.getOrderById(d1, "N1");
  console.log("deleting that payment → unpaid again, paidAt cleared:", o.paid === false && o.paidAt === "");
  await lib.setOrderDiscount(d1, "N1", 32.47, "comp");
  o = await lib.getOrderById(d1, "N1");
  console.log("discount that covers the rest → paid:", o.paid === true && o.discountAmount === 32.47);
  await lib.setOrderDiscount(d1, "N1", 0, "");
  const recorded = await lib.settleOrderBalance(d1, "N1", "Marked paid manually (Venmo)");
  o = await lib.getOrderById(d1, "N1");
  console.log("'Mark as paid' records the $32.47 balance in the ledger and marks paid:",
    recorded === 32.47 && o.paid === true && o.payments.some(p => p.amount === 32.47 && /Marked paid/.test(p.note)));
  console.log("settling again records nothing more:", (await lib.settleOrderBalance(d1, "N1", "x")) === 0);

  const capItem = o.items.find(i => i.productId === "cap");
  await lib.cancelLineItem(d1, capItem.id);
  o = await lib.getOrderById(d1, "N1");
  console.log("cancelling an item lowers what's owed (still paid, overpaid is fine):", o.paid === true && o.effectiveTotal === 60.37);
  console.log("cancelled item has a real cancelDate:", o.items.find(i => i.id === capItem.id).cancelDate !== "");

  console.log("\n=== D. other money paths ===");
  await lib.setLineItemRefund(d1, capItem.id, 2.1);
  console.log("line-item refund round-trips in dollars:", (await lib.getOrderItemById(d1, capItem.id)).refundAmount === 2.1);
  // checkout charges the BALANCE due (items + shipping − discount − payments), not totalCents:
  // N1 is paid in full (overpaid after the cancellation), so nothing is left to charge.
  const cs = await lib.getOrderCheckoutState(d1, "N1");
  console.log("checkout state in dollars (balance due, not order total):", cs.total === 0 && cs.paid === true && cs.orgId === "org-a" && cs.voided === false);
  await lib.addShippingPayment(d1, "O-OPEN", 8.35, "Shipping — Stripe", "pi_ship");
  await lib.addShippingPayment(d1, "O-OPEN", 8.35, "Shipping — Stripe", "pi_ship");
  const oo = await lib.getOrderById(d1, "O-OPEN");
  console.log("shipping payment idempotent, shippingPaidAmount $8.35:", oo.shippingPaidAmount === 8.35 && oo.payments.length === 1);

  await lib.createProduct(d1, "org-a", { productId: "hoodie", type: "sweatshirt", name: "Hoodie", pricingMode: "sized",
    sizePricing: { S: 34.99, "2XL": 37.49 }, personalizationPrice: 7.25, visible: true });
  let prod = (await lib.getProductsByOrg(d1, "org-a")).find(p => p.productId === "hoodie");
  console.log("createProduct/getProductsByOrg round-trip dollars:", prod.sizePricing.S === 34.99 && prod.sizePricing["2XL"] === 37.49 && prod.personalizationPrice === 7.25);
  await lib.updateProduct(d1, "org-a", Object.assign({}, prod, { pricingMode: "flat", flatPrice: 29.95, personalizationPrice: null }));
  prod = (await lib.getProductsByOrg(d1, "org-a")).find(p => p.productId === "hoodie");
  console.log("updateProduct round-trip (flat, personalization cleared):", prod.flatPrice === 29.95 && prod.personalizationPrice === null);
  console.log("stored as cents:", d1.q("SELECT flatPriceCents FROM products WHERE productId='hoodie'")[0].flatPriceCents === 2995);

  await lib.createBlank(d1, { name: "Port Authority" }, [{ size: "L", purchasePrice: 12.34, quantity: 2 }]);
  const blank = (await lib.getAllBlanks(d1)).find(b => b.name === "Port Authority");
  console.log("blank purchase price round-trips in dollars:", blank.sizes[0].purchasePrice === 12.34);

  const rev = await lib.getRevenueData(d1, "2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z");
  const r1 = rev.find(r => r.orderId === "N1"), rOpen = rev.find(r => r.orderId === "O-OPEN");
  console.log("revenue report in dollars, cancelled items excluded:", r1.itemSubtotal === 60.27 && rOpen.itemSubtotal === 44.9 && rOpen.discountAmount === 4.9);

  console.log("\n=== D. deleting an order cascades ===");
  await lib.deleteOrder(d1, "O-OPEN");
  console.log("items, payments and verifications removed with the order:",
    d1.q("SELECT (SELECT count(*) FROM order_items WHERE orderId='O-OPEN') + (SELECT count(*) FROM order_payments WHERE orderId='O-OPEN') + (SELECT count(*) FROM design_verifications WHERE orderId='O-OPEN') n")[0].n === 0);
})().catch(e => { console.log("test33 crashed:", false); console.error(e); process.exit(1); });
