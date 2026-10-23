const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// The reorder QR code is a TRANSFER linked directly (migrations/0047) — on the shop (its default, set
// in the org page's "Reorder QR code & option prices" section) and on each product — with no graphic
// in between. Choices made the old way (through a graphic) are carried over, and still work if not.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createTransfer, createGraphic, createProduct, priceItem, getTierPrices, setOrgReorderQr, setOrgReorderQrTransfer, deleteTransfer, deleteGraphic, getProductsByOrg, insertOrder, getTransferQueue };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const migrations = (upTo) => fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && (!upTo || f < upTo)).sort();

(async () => {
  console.log("=== Carry-over of choices made through a graphic (the migration) ===");
  const old = await createD1();
  old._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations("0047")) old.execFile(read("migrations/" + f));
  old._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('a','a','A','t','t',1), ('b','b','B','t','t',1), ('c','c','C','t','t',1);
    INSERT INTO transfers (id, name, createdAt, updatedAt) VALUES (11, 'A QR DTF', 't', 't'), (12, 'Other sheet', 't', 't');
    INSERT INTO graphics (id, orgId, name, kind, transferId, createdAt, updatedAt) VALUES (6, 'a', 'QR Code', 'transfer', 11, 't', 't'), (7, 'b', 'Stitched QR', 'embroidery', NULL, 't', 't');
    UPDATE orgs SET reorderQrGraphicId = 6 WHERE orgId = 'a';
    UPDATE orgs SET reorderQrGraphicId = 7 WHERE orgId = 'b';
    INSERT INTO products (productId, orgId, type, name, createdAt, updatedAt, reorderQr) VALUES ('p-graphic','a','shirt','P1','t','t','6'), ('p-default','a','shirt','P2','t','t','default'),
      ('p-none','a','shirt','P3','t','t','none'), ('p-emb','b','shirt','P4','t','t','7');`);
  old.execFile(read("migrations/0047_reorder_qr_transfer.sql"));
  const orgRow = (id) => old.q(`SELECT reorderQrTransferId t, reorderQrGraphicId g FROM orgs WHERE orgId='${id}'`)[0];
  const prodQr = (id) => old.q(`SELECT reorderQr v FROM products WHERE productId='${id}'`)[0].v;
  ok("a shop set through a transfer graphic now points at that transfer, and the graphic pointer is cleared", orgRow("a").t === 11 && orgRow("a").g === null);
  ok("a shop set through an embroidery graphic (no transfer) is left as it was", orgRow("b").t === null && orgRow("b").g === 7);
  ok("a shop with nothing set stays that way", orgRow("c").t === null && orgRow("c").g === null);
  ok("a product set to a transfer graphic becomes 't<transferId>'", prodQr("p-graphic") === "t11");
  ok("'default' and 'none' are untouched, and an embroidery-graphic choice is left alone", prodQr("p-default") === "default" && prodQr("p-none") === "none" && prodQr("p-emb") === "7");

  console.log("\n=== Resolving the reorder QR on an order line ===");
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('league','league','League','t','t',1), ('club','club','Club','t','t',1);`);
  const tArt = await lib.createTransfer(d1, { name: "Crest sheet" });
  const tQr = await lib.createTransfer(d1, { name: "League QR DTF" });
  const tQr2 = await lib.createTransfer(d1, { name: "Special QR" });
  const tClub = await lib.createTransfer(d1, { name: "Club-only QR", orgIds: ["club"] });
  const tHidden = await lib.createTransfer(d1, { name: "Retired QR", visible: false });
  const gArt = await lib.createGraphic(d1, "league", { name: "Crest", kind: "transfer", transferId: tArt, tier: null });
  const gOldQr = await lib.createGraphic(d1, "league", { name: "Old QR graphic", kind: "transfer", transferId: tQr2, tier: "large" });
  const mk = (productId, reorderQr) => lib.createProduct(d1, "league", { productId, type: "shirt", name: productId, pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Navy"], reorderQr, locations: [{ key: "front", label: "Front", graphicIds: [gArt] }] });
  await mk("dflt", "default"); await mk("none", "none"); await mk("own", "t" + tQr2); await mk("legacy", String(gOldQr)); await mk("gone", "t9999"); await mk("hidden", "t" + tHidden);
  const cfg = { garmentColor: "Navy", locations: { front: { graphicId: gArt } } };
  const qrOf = async (productId) => ((await lib.priceItem(d1, "league", productId, "L", 1, false, cfg)).config.locations.find(l => l.location === "reorderqr")) || null;
  ok("with no shop default, a 'default' product gets no reorder QR", (await qrOf("dflt")) === null);
  await lib.setOrgReorderQrTransfer(d1, "league", tQr);
  let q = await qrOf("dflt");
  ok("the shop's transfer is applied directly: a transfer entry with that transfer, no graphic, no charge", q && q.kind === "transfer" && q.transferId === tQr && q.graphicId === null && q.graphicName === "League QR DTF" && q.addOnCents === 0 && q.auto === true);
  ok("…and the price is unchanged ($20)", (await lib.priceItem(d1, "league", "dflt", "L", 1, false, cfg)).unitPrice === 20);
  ok("a product set to None gets none", (await qrOf("none")) === null);
  ok("a product with its own transfer uses it instead of the shop's", (await qrOf("own")).transferId === tQr2);
  q = await qrOf("legacy");
  ok("a product still pointing at a graphic (the old way) keeps working", q && q.graphicId === gOldQr && q.transferId === tQr2 && q.addOnCents === 0);
  ok("a transfer that no longer exists, or is hidden, is simply not applied", (await qrOf("gone")) === null && (await qrOf("hidden")) === null);
  await lib.setOrgReorderQr(d1, "club", gOldQr);
  ok("a shop default set the old way is still reported as a graphic", (await lib.getTierPrices(d1, "club")).reorderQrGraphicId === gOldQr && (await lib.getTierPrices(d1, "club")).reorderQrTransferId === null);
  await lib.setOrgReorderQrTransfer(d1, "club", tClub);
  ok("setting the transfer replaces the graphic pointer", (await lib.getTierPrices(d1, "club")).reorderQrTransferId === tClub && (await lib.getTierPrices(d1, "club")).reorderQrGraphicId === null);

  console.log("\n=== It reaches the transfer queue like any other transfer ===");
  await lib.insertOrder(d1, { orderId: "Q1", orgId: "league", customerName: "C", contact: "c@x.com", paymentMethod: "Venmo", placedAt: "2026-10-01T00:00:00Z" },
    [{ productId: "dflt", name: "dflt", type: "shirt", size: "L", qty: 2, unitPrice: 20, config: (await lib.priceItem(d1, "league", "dflt", "L", 2, false, cfg)).config }]);
  d1._raw.run("UPDATE orders SET paid=1 WHERE orderId='Q1'");
  const queue = await lib.getTransferQueue(d1);
  const job = JSON.stringify(queue);
  ok("the order's transfers include the reorder QR by its transfer's name, marked automatic", /"graphicName":"League QR DTF"/.test(job) && /"auto":true/.test(job));

  console.log("\n=== Deleting ===");
  const refuses = async (fn) => { try { await fn(); return ""; } catch (e) { return e.message; } };
  ok("a transfer a shop uses as its reorder QR can't be deleted", /shop uses this transfer as its reorder QR code/.test(await refuses(() => lib.deleteTransfer(d1, tQr))));
  ok("…nor one a product uses", /product uses this transfer as its reorder QR code/.test(await refuses(() => lib.deleteTransfer(d1, tHidden))));
  const tSpare = await lib.createTransfer(d1, { name: "Spare" });
  ok("an unused transfer still deletes", (await refuses(() => lib.deleteTransfer(d1, tSpare))) === "");

  console.log("\n=== The admin API ===");
  const call = async (body) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}), request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  let r = await call({ action: "setTierPrices", org: "league", tiers: { small: 1, medium: 2, large: 4 }, reorderQrTransferId: tClub });
  ok("a transfer that isn't available to the shop is refused", r.status === 400 && /isn't available to this shop/.test(r.body.message) && (await lib.getTierPrices(d1, "league")).reorderQrTransferId === tQr);
  r = await call({ action: "setTierPrices", org: "league", tiers: { small: 1.5, medium: 2, large: 4 }, reorderQrTransferId: tQr2 });
  ok("setTierPrices saves the transfer with the prices and returns it", r.status === 200 && r.body.reorderQrTransferId === tQr2 && r.body.tiersCents.small === 150);
  r = await call({ action: "setTierPrices", org: "league", tiers: { small: 1.5, medium: 2, large: 4 }, reorderQrTransferId: null });
  ok("null clears it", r.body.reorderQrTransferId === null);
  r = await call({ action: "listGraphics", org: "league" });
  ok("the shop's current choice comes back with its graphics", r.body.reorderQrTransferId === null && Array.isArray(r.body.graphics));
  await call({ action: "setTierPrices", org: "league", tiers: { small: 1, medium: 2, large: 4 }, reorderQrTransferId: tQr });

  // ---- Screens ----
  const html = read("public/index.html"), adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const sent = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.CSS = win.CSS || { escape: (v) => String(v) }; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval(`adminKey = "cookie"; window._adminOrgRegistry = [{ orgId: "league", name: "League" }];`);
  const until = async (fn) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return !!fn(); };
  const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

  console.log("\n=== The shop page ===");
  w.renderOrgForm(d.getElementById("app"), { orgId: "league", subdomain: "league", name: "League", deliveryOptions: [{ id: "pickup", type: "pickup", label: "Local pickup", fee: 0 }] });
  await until(() => d.getElementById("otpSave"));
  const box = () => d.getElementById("orgTierBox"), sel = () => d.getElementById("otpQr");
  const headings = [...d.querySelectorAll("#app h3")].map(h => h.textContent.trim());
  ok("the shop page has a 'Reorder QR code & option prices' section below Delivery & pickup", headings.indexOf("Reorder QR code & option prices") === headings.indexOf("Delivery & pickup") + 1);
  ok("it offers TRANSFERS the shop can use — not graphics, not another shop's, not hidden ones", [...sel().options].map(o => o.textContent.trim()).join("|") === "— None: no reorder QR code —|Crest sheet|League QR DTF|Special QR");
  ok("it shows the transfer it's set to", sel().value === String(tQr) && /Set to the transfer “League QR DTF”/.test(text(d.getElementById("otpQrNow"))));
  ok("it points at Inventory → Transfers for adding one (no mention of needing a graphic)", !!box().querySelector('a[href="#transfers"]') && !/graphic first/i.test(text(box())));
  sel().value = String(tQr2);
  d.getElementById("otpSave").click();
  await until(() => sent.some(b => b.action === "setTierPrices" && b.reorderQrTransferId === tQr2) && /Saved/.test(d.getElementById("otpStatus").textContent));
  ok("Save sends the transfer id and the box then shows the new choice", (await lib.getTierPrices(d1, "league")).reorderQrTransferId === tQr2 && /Set to the transfer “Special QR”/.test(text(d.getElementById("otpQrNow"))));
  await lib.setOrgReorderQr(d1, "league", gOldQr);            // put the shop back the old way: graphic, no transfer
  d1._raw.run("UPDATE orgs SET reorderQrTransferId=NULL WHERE orgId='league'");
  await w.loadOrgTierBox_("league");
  ok("a shop still set through a graphic is told so, and how to link the transfer directly", /Set the old way, through the graphic “Old QR graphic” — still working/.test(text(d.getElementById("otpQrNow"))));
  await lib.setOrgReorderQrTransfer(d1, "league", tQr);

  console.log("\n=== The product page ===");
  const product = (await lib.getProductsByOrg(d1, "league", false)).find(p => p.productId === "own");
  d.getElementById("app").innerHTML = `<div id="productConfigSection"></div>`;
  await w.loadProductConfigSection("league", product);
  await until(() => d.getElementById("cfgReorderQr"));
  const opts = [...d.getElementById("cfgReorderQr").options];
  ok("the product's Reorder QR code lists the shop default by name, None, and the transfers", opts.map(o => o.textContent.trim()).join("|") === "Shop default (League QR DTF)|None|Crest sheet|League QR DTF|Special QR");
  ok("the product's own transfer is selected, stored as 't<id>'", d.getElementById("cfgReorderQr").value === "t" + tQr2 && w._productConfigGet().reorderQr === "t" + tQr2);
  ok("it says a graphic isn't needed", /doesn't need a graphic/.test(text(d.getElementById("productConfigSection"))));
  const legacy = (await lib.getProductsByOrg(d1, "league", false)).find(p => p.productId === "legacy");
  d.getElementById("app").innerHTML = `<div id="productConfigSection"></div>`;
  await w.loadProductConfigSection("league", legacy);
  await until(() => d.getElementById("cfgReorderQr"));
  ok("a product still on a graphic shows it, marked as the old way, without losing it on save", d.getElementById("cfgReorderQr").value === String(gOldQr) && /Old QR graphic \(a graphic — the old way/.test(d.getElementById("cfgReorderQr").selectedOptions[0].textContent) && w._productConfigGet().reorderQr === String(gOldQr));

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
