const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// A garment color on a configurable product with no blank links of its own (the blank gained the color from a vendor
// import and the product offered it, but its size links were never saved — so the shop showed the first color's photos
// and the product form showed none). Now: the shop and the admin take
// that color's photos from the same-named color of a blank the product is already linked to, and the product form
// fills the missing links from that blank by color and size name, so one Save changes links them.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createProduct, setBlankLink, getPublicCatalogData };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/_lib/vendorImages.js")) + "\n" + strip(read("functions/_lib/orphanImages.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const wait = async (cond, n = 300) => { for (let i = 0; i < n && !cond(); i++) await new Promise(r => setTimeout(r, 10)); return cond(); };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('northside','northside','Northside','t','t',1);`);
  const img = (n) => [{ url: `https://images.example.com/uploads/blanks/${n}.jpg`, locationId: null }];
  const sizes = ["S", "M", "L"];
  const blankId = (await lib.createBlank(d1, { name: "Sample Pique Polo", productType: "shirt", vendor: "SanMar", sku: "SP100",
    colors: [{ color: "Deep Black", images: img("black"), sizes: sizes.map(size => ({ size, quantity: 0 })) },
             { color: "Harbor Blue", images: img("harbor"), sizes: sizes.map(size => ({ size, quantity: 0 })) }] })).id;
  await lib.createProduct(d1, "northside", { productId: "polo", type: "shirt", name: "Pique Polo", pricingMode: "sized", sizePricing: { S: 30, M: 30, L: 30 }, visible: true,
    noDesignNeeded: true, configurable: true, garmentColors: ["Deep Black", "Harbor Blue"] });
  for (const z of sizes) await lib.setBlankLink(d1, "northside", "polo", "Deep Black", z, blankId, "Deep Black", z);   // Harbor Blue never linked

  console.log("=== The shop ===");
  const cat = await lib.getPublicCatalogData(d1);
  const ci = cat.orgs.northside.products.find(p => p.productId === "polo").colorImages;
  ok("a linked color shows its blank color's photos", ci["Deep Black"][0].endsWith("/black.jpg"));
  ok("a color with no links of its own shows the same-named color of the product's blank (not the first color's)", ci["Harbor Blue"] && ci["Harbor Blue"][0].endsWith("/harbor.jpg"));

  console.log("\n=== The product form ===");
  const adminJs = read("public/admin.js");
  const sent = [];
  class Ld extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new Ld(), url: "https://admin.example.com/#catalog", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.CSS = win.CSS || { escape: (x) => String(x).replace(/["\\]/g, "\\$&") }; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: false, status: 404, json: async () => ({ status: "error" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "northside", name: "Northside" }]; window._adminOrgRegistry = [{ orgId: "northside", name: "Northside" }];');
  const product = (await call({ action: "listProducts", org: "northside" })).body.products.find(p => p.productId === "polo");
  w.renderProductForm(d.getElementById("app"), "northside", product);
  await wait(() => d.querySelector("#blankLinksSection .bl-autofilled"));
  ok("the form says Harbor Blue wasn't linked and was linked automatically by name — Save to keep it", /Harbor Blue wasn't linked to the blank yet/.test((d.querySelector("#blankLinksSection .bl-autofilled") || {}).textContent || ""));
  const rowSel = (z) => d.querySelector(`.bl-blank[data-pc="Harbor Blue"][data-ps="${z}"]`);
  ok("…each Harbor Blue size now points at the blank's Harbor Blue in that size", sizes.every(z => rowSel(z) && rowSel(z).value === String(blankId) &&
    d.querySelector(`.bl-color[data-pc="Harbor Blue"][data-ps="${z}"]`).value === "Harbor Blue" && d.querySelector(`.bl-size[data-pc="Harbor Blue"][data-ps="${z}"]`).value === z));
  await wait(() => d.querySelector('#prodBlankImages [data-blank-color="Harbor Blue"]'));
  ok("the Blank photos panel shows Harbor Blue's photos too", !!d.querySelector('#prodBlankImages [data-blank-color="Harbor Blue"] img'));
  sent.length = 0;
  const saved = await w._blankLinksSave.save();
  ok("one Save writes the missing links", saved === "" && sizes.every(z => d1.q("SELECT 1 FROM product_blank_links WHERE productId='polo' AND productColor='Harbor Blue' AND productSize=? AND blankColor='Harbor Blue'", z).length === 1));
  w.renderProductForm(d.getElementById("app"), "northside", product);
  await wait(() => d.querySelector('.bl-blank[data-pc="Harbor Blue"]'));
  await new Promise(r => setTimeout(r, 50));
  ok("once linked, the form doesn't say it again", !d.querySelector("#blankLinksSection .bl-autofilled"));

  console.log("\n=== The real root cause: the blank re-filed under another type ===");
  // The blank was changed to another type after it was linked (e.g. long-sleeve polo → shirt). The product form used
  // to list only blanks of the product's own type, so with none left it showed "No blanks of type …" and no links at all.
  d1._raw.run("DELETE FROM product_blank_links WHERE productId='polo' AND productColor='Harbor Blue'");
  d1._raw.run("UPDATE blanks SET productType='hoodie' WHERE id=?", [blankId]);
  w.renderProductForm(d.getElementById("app"), "northside", product);
  await wait(() => d.querySelector("#blankLinksSection .bl-type-mismatch") || /No blanks of type/.test((d.getElementById("blankLinksSection") || {}).textContent || ""));
  const sec = d.getElementById("blankLinksSection");
  ok("a linked blank filed under another type still shows in the links table (no 'No blanks of type …')", !/No blanks of type/.test(sec.textContent) && !!d.querySelector('.bl-blank[data-pc="Deep Black"]') && d.querySelector('.bl-blank[data-pc="Deep Black"][data-ps="S"]').value === String(blankId));
  ok("…the form says the blank is filed under another type than the product", /is filed as/.test((sec.querySelector(".bl-type-mismatch") || {}).textContent || ""));
  ok("…and the missing color still gets linked from it", /Harbor Blue wasn't linked/.test((sec.querySelector(".bl-autofilled") || {}).textContent || "") && d.querySelector('.bl-blank[data-pc="Harbor Blue"][data-ps="M"]').value === String(blankId));
  const issues = (await call({ action: "getCatalogIssues", org: "northside" })).body.issues;
  ok("the catalog check warns about the type mismatch", ((issues.orgs.northside.products || {}).polo || []).some(x => x.code === "blankTypeMismatch" && /filed as hoodie/.test(x.text)));
  await wait(() => d.getElementById("cfgBlankFilter"));
  const listNames = () => [...d.querySelectorAll("#cfgBlankList .pick-row")].map(r => r.textContent);
  ok("the Blanks picker lists a ticked blank of another type, labelled with its type", listNames().some(t => /Sample Pique Polo/.test(t) && /HOODIE/.test(t)));
  ok("source: searching the picker also finds blanks of other types", /\(!otherType\(b\) \|\| f\)/.test(adminJs));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test151 crashed: false"); process.exit(1); });
