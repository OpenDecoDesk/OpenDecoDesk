const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Inventory races and ship-to addresses:
//   * Inventory writes are atomic and race-safe: two requests making the same line at the same
//     moment (double-click, two tabs, Run Order + Orders) consume its blanks ONCE; a double
//     "Finish" on a run makes one piece; concurrent receives of one size end with the right stock
//     and weighted-average cost; a write-off's movement and stock change land together.
//   * Ship-to addresses are whitelisted and the state must agree with the ZIP (it decides
//     sales tax): cleanShippingAddress, and the real orders.js refusing a home-state ZIP with an
//     out-of-state "state" on storefront orders, local sales and admin shipping edits.
// Real SQL (sql.js) + real db.js / orders.js. The concurrent calls really interleave: each D1 call
// is an await, so Promise.all runs both requests' reads before either one's writes.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, createProduct, createBlank, setBlankLink, saveMachine, receiveBlanks, writeOffBlanks,
  consumeBlanksForOrder, markItemPieceManufactured, startProductionRun, completeProductionRun, getOrderById,
  cleanShippingAddress, zipStates, zipIsInState, setSalesTaxSettings };`)();
const A = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  strip(read("functions/_lib/quoteToken.js")) + "\nconst verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn { post: onRequestPost, signQuote, canonicalItems };")();
const api = A.post;

(async () => {
  try {
    const d1 = await createD1();
    d1._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, ready, createdAt, updatedAt) VALUES ('acme','acme','Acme',1,'t','t');`);
    await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 20, visible: true });
    const blankId = (await lib.createBlank(d1, { name: "Richardson 112", brand: "Richardson", color: "Navy", productType: "cap" })).id;
    await lib.setBlankLink(d1, "acme", "cap", "OSFA", blankId, "OSFA");
    await lib.receiveBlanks(d1, { blankId, lines: [{ size: "OSFA", qty: 100, unitCost: 4 }], vendor: "S&S", receivedAt: "2026-06-01T00:00:00Z" });
    const stock = () => Number(d1.q(`SELECT quantity q FROM blank_sizes WHERE blankId=${blankId} AND size='OSFA'`)[0].q);
    const avg = () => Number(d1.q(`SELECT purchasePriceCents c FROM blank_sizes WHERE blankId=${blankId} AND size='OSFA'`)[0].c);
    const consumes = (orderId) => d1.q(`SELECT qtyDelta FROM inventory_movements WHERE kind='consume' AND orderId='${orderId}'`);
    const line = (orderId) => d1.q(`SELECT id, manufacturedQty, cogsCents, cogsSource FROM order_items WHERE orderId='${orderId}'`)[0];
    const order = async (id, qty) => lib.insertOrder(d1, { orderId: id, orgId: "acme", customerName: "C", contact: "c@x.com",
      placedAt: "2026-07-01T00:00:00Z" }, [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty, unitPrice: 20 }]);

    console.log("=== S1: whole-order consume, two requests at once ===");
    await order("R1", 3);
    let s0 = stock();
    const res = await Promise.all([lib.consumeBlanksForOrder(d1, "R1"), lib.consumeBlanksForOrder(d1, "R1")]);
    console.log("exactly one request consumed the line:", res[0] + res[1] === 1);
    console.log("one consume movement of 3, not two:", JSON.stringify(consumes("R1")) === JSON.stringify([{ qtyDelta: -3 }]));
    console.log("stock went down by 3 once (100 → 97):", stock() === s0 - 3);
    console.log("COGS is 3 × $4 once, not twice:", line("R1").cogsCents === 1200 && line("R1").cogsSource === "consumed" && line("R1").manufacturedQty === 3);
    await lib.consumeBlanksForOrder(d1, "R1");
    console.log("calling it again later changes nothing (idempotent):", consumes("R1").length === 1 && stock() === s0 - 3);

    console.log("\n=== S1: per-piece, two clicks at once on a qty-3 line ===");
    await order("R2", 3);
    s0 = stock();
    const id2 = line("R2").id;
    const pr = await Promise.all([lib.markItemPieceManufactured(d1, "R2", id2), lib.markItemPieceManufactured(d1, "R2", id2)]);
    console.log("both clicks count as one more piece each (2 made, not 1 and not a double-consume of 1):",
      pr.every(x => x.pieceMarked) && line("R2").manufacturedQty === 2);
    console.log("two 1-piece consume movements, stock down 2, COGS 2 × $4:",
      consumes("R2").length === 2 && consumes("R2").every(m => m.qtyDelta === -1) && stock() === s0 - 2 && line("R2").cogsCents === 800);
    const last = await Promise.all([lib.markItemPieceManufactured(d1, "R2", id2), lib.markItemPieceManufactured(d1, "R2", id2)]);
    console.log("racing for the LAST piece: one makes it, the other reports the line complete:",
      last.filter(x => x.pieceMarked).length === 1 && last.filter(x => x.alreadyComplete).length === 1);
    console.log("never over-made: 3 of 3, 3 blanks used, order stamped manufactured:",
      line("R2").manufacturedQty === 3 && consumes("R2").length === 3 && stock() === s0 - 3 && !!(await lib.getOrderById(d1, "R2")).manufacturedAt);

    console.log("\n=== S1: a double-clicked Finish makes one piece ===");
    await order("R3", 2);
    d1._raw.run("UPDATE orders SET paid=1, blankReceivedAt='2026-07-05', designApprovedAt='2026-07-06' WHERE orderId='R3'");
    const machine = await lib.saveMachine(d1, { name: "Machine 1", needleCount: 12, hoopIds: [] });
    const runId = await lib.startProductionRun(d1, { orgId: "acme", orderId: "R3", itemId: line("R3").id, machineId: machine });
    s0 = stock();
    const fin = await Promise.allSettled([lib.completeProductionRun(d1, runId), lib.completeProductionRun(d1, runId)]);
    console.log("one Finish succeeds, the other is told the job isn't running:",
      fin.filter(x => x.status === "fulfilled").length === 1 && fin.some(x => x.status === "rejected" && /not running/.test(x.reason.message)));
    console.log("…so exactly one piece was made and one blank used:", line("R3").manufacturedQty === 1 && consumes("R3").length === 1 && stock() === s0 - 1);

    console.log("\n=== S1: concurrent receives of the same size ===");
    const b2 = (await lib.createBlank(d1, { name: "Gildan 5000", brand: "Gildan", color: "Black", productType: "shirt" })).id;
    await Promise.all([
      lib.receiveBlanks(d1, { blankId: b2, lines: [{ size: "L", qty: 10, unitCost: 5 }], vendor: "A", receivedAt: "2026-06-02T00:00:00Z" }),
      lib.receiveBlanks(d1, { blankId: b2, lines: [{ size: "L", qty: 10, unitCost: 7 }], vendor: "B", receivedAt: "2026-06-02T00:00:00Z" }),
    ]);
    const L = d1.q(`SELECT quantity, purchasePriceCents FROM blank_sizes WHERE blankId=${b2} AND size='L'`)[0];
    console.log("stock is 20 and the weighted average is $6.00 (not $7 from a stale read):", L.quantity === 20 && L.purchasePriceCents === 600);
    console.log("both purchase movements recorded:", d1.q(`SELECT count(*) n FROM inventory_movements WHERE blankId=${b2} AND kind='purchase'`)[0].n === 2);
    await lib.receiveBlanks(d1, { blankId: b2, lines: [{ size: "L", qty: 5, unitCost: 3.01 }], vendor: "C", receivedAt: "2026-06-03T00:00:00Z" });
    console.log("averaging still rounds like before: (20×600 + 5×301)/25 = 540.2 → 540¢:",
      d1.q(`SELECT purchasePriceCents c FROM blank_sizes WHERE blankId=${b2} AND size='L'`)[0].c === 540);
    d1._raw.run(`UPDATE blank_sizes SET quantity = -3 WHERE blankId=${b2} AND size='L'`);
    await lib.receiveBlanks(d1, { blankId: b2, lines: [{ size: "L", qty: 2, unitCost: 8 }], vendor: "D", receivedAt: "2026-06-04T00:00:00Z" });
    const neg = d1.q(`SELECT quantity q, purchasePriceCents c FROM blank_sizes WHERE blankId=${b2} AND size='L'`)[0];
    console.log("negative on-hand counts as 0 for the average (new cost wins), stock still adds up:", neg.c === 800 && neg.q === -1);

    console.log("\n=== S1: a write-off's movement and stock change land together ===");
    s0 = stock();
    await lib.writeOffBlanks(d1, { blankId, size: "OSFA", qty: 2, note: "Damaged", occurredAt: "2026-07-10T00:00:00Z" });
    const wo = d1.q(`SELECT qtyDelta, unitCostCents, blankName FROM inventory_movements WHERE kind='writeoff'`)[0];
    console.log("write-off: −2 at the average cost, named, stock down 2:", wo.qtyDelta === -2 && wo.unitCostCents === 400 && wo.blankName === "Richardson 112" && stock() === s0 - 2);

    console.log("\n=== L-1: cleanShippingAddress ===");
    const C = lib.cleanShippingAddress;
    const Z = lib.zipStates;
    console.log("ZIP → state for a spread of states (first three digits):",
      Z("43601").join() === "OH" && Z("19103").join() === "PA" && Z("10001").join() === "NY" && Z("90210").join() === "CA" &&
      Z("77002").join() === "TX" && Z("33101").join() === "FL" && Z("60601").join() === "IL" && Z("98101").join() === "WA" &&
      Z("99501").join() === "AK" && Z("96813")[0] === "HI" && Z("02108").join() === "MA" && Z("00901").join() === "PR" &&
      Z("19103").join() === "PA" && Z("19801").join() === "DE" && Z("30301").join() === "GA" && Z("80202").join() === "CO");
    console.log("state borders fall where they should (OH 430–459, IN 460–479, KY 400–427, MI 480–499, IA from 500):",
      Z("42799").join() === "KY" && Z("43000").join() === "OH" && Z("45999").join() === "OH" && Z("46000").join() === "IN" &&
      Z("47999").join() === "IN" && Z("48000").join() === "MI" && Z("49999").join() === "MI" && Z("50001").join() === "IA");
    console.log("a prefix that straddles a state line lists both; El Paso is Texas inside the New Mexico range:",
      Z("06390").includes("CT") && Z("06390").includes("NY") && Z("83414").includes("WY") && Z("83414").includes("ID") &&
      Z("88501").join() === "TX" && Z("87501").join() === "NM" && Z("20500").includes("DC"));
    console.log("prefixes the USPS list shows crossing a state line accept either state, main one first:",
      Z("02901").join() === "RI,MA" && Z("41001").join() === "KY,OH" && Z("83801").join() === "ID,WA" && Z("19901").join() === "DE,MD" && Z("79801").join() === "TX,NM");
    console.log("military mail is addressed AE / AA / AP though it's handled in NJ, FL and CA:",
      Z("09012").includes("AE") && Z("34002").includes("AA") && Z("96201").includes("AP") && lib.zipIsInState("09012", "AE") && !lib.zipIsInState("09012", "TX"));
    console.log("a prefix USPS doesn't use is never held against an address:", Z("21300").length === 0 && Z("51700").length === 0);
    console.log("an unassigned prefix or a malformed ZIP names no state:", Z("00100").length === 0 && Z("4360").length === 0 && Z("").length === 0);
    console.log("zipIsInState takes a code or a name:", lib.zipIsInState("43601", "OH") && lib.zipIsInState("43601", "ohio") && !lib.zipIsInState("43601", "IN") && lib.zipIsInState("10001-0001", "New York"));
    const zipTable = (src) => (/const ZIP3_STATES_ = ([\s\S]*?);/.exec(src) || [])[1].replace(/\s+/g, " ");
    console.log("the storefront's copy of the ZIP table is the same as the server's:",
      zipTable(read("public/index.html")) === zipTable(read("functions/_lib/db.js")) && zipTable(read("public/index.html")).length > 500);
    let c = C({ name: "A", line1: "1 Main", city: "Toledo", state: "ohio", zip: "43601", evil: "<script>", nested: { a: 1 } });
    console.log("a good address: state name normalised to its code, unknown fields dropped:", c.address && c.address.state === "OH" && !("evil" in c.address) && !("nested" in c.address));
    const bad = C({ line1: "1", city: "Toledo", state: "IN", zip: "43601" }).error || "";
    console.log("a home-state (Ohio) ZIP with state IN is refused (it would drop the order's tax), naming the ZIP's state:", /43601 is in OH, but the state says IN/.test(bad));
    console.log("…the other way round too — another state's ZIP with the home state:", /46201 is in IN, but the state says OH/.test(C({ line1: "1", city: "Indianapolis", state: "OH", zip: "46201" }).error || ""));
    console.log("…and between two states that are neither (the rule doesn't depend on the home state):", /is in TX/.test(C({ line1: "1", city: "Houston", state: "CA", zip: "77002" }).error || ""));
    console.log("a message names the two states involved and no other:", !/\b(?!OH\b|IN\b)[A-Z]{2}\b/.test(bad));
    console.log("an out-of-state ZIP with its own state is fine:", C({ line1: "1", city: "Indianapolis", state: "Indiana", zip: "46201" }).address.state === "IN");
    console.log("either state of a straddling prefix is accepted:", C({ state: "NY", zip: "06390" }).address.state === "NY" && C({ state: "CT", zip: "06390" }).address.state === "CT" && !!C({ state: "NJ", zip: "06390" }).error);
    console.log("blank state + a ZIP that names one state → filled in:", C({ line1: "1", city: "Toledo", zip: "43601" }).address.state === "OH" && C({ line1: "1", zip: "46201" }).address.state === "IN");
    console.log("blank state + a ZIP that can't name one → refused (a blank state is taxed as the home state):", !!C({ line1: "1", zip: "06390" }).error && !!C({ line1: "1", zip: "00100" }).error);
    console.log("an unassigned prefix is never held against a state that was typed in:", C({ state: "OH", zip: "00100" }).address.state === "OH");
    console.log("not a state code → refused:", !!C({ state: "XX", zip: "43601" }).error);
    console.log("bad ZIP → refused; ZIP+4 accepted:", !!C({ state: "OH", zip: "4360" }).error && !C({ state: "OH", zip: "43601-1234" }).error);
    console.log("long fields are capped:", C({ name: "x".repeat(500), state: "OH", zip: "43601" }).address.name.length === 200);
    console.log("no address / empty object → null (pickup):", C(null).address === null && C({}).address === null && C([]).address === null);

    console.log("\n=== L-1: orders.js uses it everywhere an address comes in ===");
    const call = async (body, url = "https://admin.example.com/api/orders") => {
      const r = await api({ env: ENV, waitUntil: (p) => p.then(() => {}, () => {}),
        request: { url, json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
      return { status: r.status, body: JSON.parse(await r.text()) };
    };
    // A shipped order carries a signed carrier quote for its ZIP: that is what makes its address count.
    const ENV = { DB: d1, SIGNING_SECRET: "s".repeat(40) };
    d1._raw.exec("UPDATE orgs SET shippingEnabled = 1 WHERE orgId = 'acme'");
    const capItems = [{ productId: "cap", qty: 1 }];
    const storefront = (orderId, extra) => call({ orderId, orgId: "acme", customerName: "Bea", contact: "bea@example.com", paymentMethod: "Venmo", items: capItems, ...extra }, "https://acme.example.com/api/orders");
    const shop = async (orderId, addr) => storefront(orderId, { shippingAddress: addr,
      shippingQuoteToken: await A.signQuote(ENV, { orgId: "acme", zip: String(addr.zip), items: A.canonicalItems(capItems), amountCents: 500, method: "USPS Ground" }) });
    await lib.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH" });   // the home state is a setting: Ohio here
    let r = await shop("S-1", { name: "Bea", line1: "1 Main", city: "Toledo", state: "IN", zip: "43601" });
    console.log("storefront: a home-state ZIP + state IN is refused, nothing saved:", r.status === 400 && /is in OH/.test(r.body.message) && !(await lib.getOrderById(d1, "S-1")));
    r = await shop("S-2", { name: "Bea", line1: "1 Main", city: "Toledo", state: "oh", zip: "43601", junk: "x".repeat(10000) });
    const s2 = await lib.getOrderById(d1, "S-2");
    console.log("storefront: a good address is saved cleaned (state OH, junk dropped) and taxed:",
      r.status === 200 && s2.shippingAddress.state === "OH" && !("junk" in s2.shippingAddress) && s2.salesTax > 0);
    r = await shop("S-3", { name: "Bea", line1: "1 Main", city: "Indianapolis", state: "IN", zip: "46201" });
    console.log("storefront: a real out-of-state (Indiana) address is accepted and untaxed:", r.status === 200 && (await lib.getOrderById(d1, "S-3")).salesTax === 0);
    // Pickup has no ship-to address, so one sent along with it is not kept — and can't drop the tax.
    r = await storefront("S-4", { shippingAddress: { name: "Bea", line1: "1 Main", city: "Indianapolis", state: "IN", zip: "46201" } });
    const s4 = await lib.getOrderById(d1, "S-4");
    console.log("storefront: a pickup order sent with an out-of-state address keeps no address and is taxed:", r.status === 200 && !s4.shippingAddress && s4.salesTax > 0);
    r = await storefront("S-5", { shippingAddress: { state: "IN" } });
    console.log("…a bare out-of-state \"state\" on a pickup order does nothing either:", r.status === 200 && (await lib.getOrderById(d1, "S-5")).salesTax > 0);
    r = await call({ action: "setShippingInfo", orderId: "S-2", shippingAddress: { line1: "1 Main", city: "Toledo", state: "IN", zip: "43601" }, shippingCost: 5 });
    console.log("admin Edit shipping: the same contradiction is refused:", r.status === 400 && /is in OH/.test(r.body.message));
    console.log("…and the order keeps its Ohio address and tax:", (s => s.shippingAddress.state === "OH" && s.salesTax > 0)(await lib.getOrderById(d1, "S-2")));
  } catch (e) {
    console.log("test64 crashed:", false);
    console.error(e);
    process.exit(1);
  }
})();
