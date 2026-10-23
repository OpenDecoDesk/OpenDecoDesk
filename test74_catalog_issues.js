const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Catalog health check: getCatalogIssues lists what's missing — per shop, per product,
// per design — for the ⚠ markers on Manage catalog (next to each shop's Products / Designs
// buttons), the product list and form, and the Designs screen. "No embroidery design needed"
// (products.noDesignNeeded, migrations/0034) keeps DTF products from being flagged forever.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createHoop, saveDesign, addDesignVersion, createProduct, setProductDesigns, setBlankLink, createBlank,
  insertOrder, getCatalogIssues, getProductsByOrg };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

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
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, shippingEnabled, createdAt, updatedAt) VALUES ('league','league','League',1,'t','t'), ('club','club','Club',0,'t','t');`);
    const capHoop = await lib.createHoop(d1, { name: "Cap", isCapFrame: true });
    const front = await lib.saveDesign(d1, "league", { name: "Front", hoopIds: [capHoop] });
    await lib.addDesignVersion(d1, front, { machineFileKey: `designs/${front}/a.dst`, machineFileName: "F.DST", threadColors: [{ needle: 1, threadId: 1 }] });
    const noFile = await lib.saveDesign(d1, "league", { name: "Closure COACH", hoopIds: [capHoop], isGlobal: true });
    const noHoop = await lib.saveDesign(d1, "league", { name: "Back", hoopIds: [] });
    await lib.addDesignVersion(d1, noHoop, { machineFileKey: `designs/${noHoop}/a.dst`, machineFileName: "B.DST", threadColors: [] });
    const blank = (await lib.createBlank(d1, { name: "Richardson 112", productType: "cap" }, [{ size: "OSFA", quantity: 1 }])).id;

    // Products: good / no design / design with issues / unmapped pick list (legacy) / no weight / DTF / hidden.
    const mk = (id, extra) => lib.createProduct(d1, "league", Object.assign({ productId: id, type: "cap", name: id, pricingMode: "flat", flatPrice: 25, weightOz: 4, visible: true }, extra || {}));
    await mk("good"); await lib.setProductDesigns(d1, "league", "good", [{ designId: front, isMain: true }]); await lib.setBlankLink(d1, "league", "good", "OSFA", blank, "OSFA");
    await mk("nodesign");
    await mk("badback"); await lib.setProductDesigns(d1, "league", "badback", [{ designId: front, isMain: true }, { designId: noHoop }]);
    await mk("picklist", { personalizationPrice: 5, personalizationOptions: ["COACH", "CAPTAIN"] });
    await lib.setProductDesigns(d1, "league", "picklist", [{ designId: front, isMain: true }]);
    d1._raw.run(`UPDATE products SET personalizationOptionDesigns=? WHERE productId='picklist'`, [JSON.stringify({ COACH: noFile })]);
    await mk("noweight", { weightOz: null }); await lib.setProductDesigns(d1, "league", "noweight", [{ designId: front, isMain: true }]);
    await mk("dtf", { noDesignNeeded: true });
    await mk("hidden", { visible: false });
    await mk("hiddenopen", { visible: false });
    await lib.insertOrder(d1, { orderId: "O1", orgId: "league", customerName: "C", contact: "c@x.com", placedAt: "2026-09-01T00:00:00Z" },
      [{ productId: "hiddenopen", name: "x", type: "cap", size: "OSFA", qty: 1, unitPrice: 25 }]);

    const issues = await lib.getCatalogIssues(d1);
    const prod = issues.orgs.league.products, codes = (id) => (prod[id] || []).map(x => x.code).sort().join(",");
    console.log("=== Products ===");
    console.log("a complete product has no issues:", !prod.good);
    console.log("no design linked → an error (with the DTF hint):", codes("nodesign").includes("noDesign") && /No embroidery design needed/.test(prod.nodesign[0].text));
    console.log("a linked design's own problem shows on the product:", codes("badback") === "designIssue,noBlankLink" && /Design “Back”: no hoops picked/.test(prod.badback[0].text));
    console.log("an unmapped pick-list option, and a mapped design missing its file:",
      /Pick-list option with no design: CAPTAIN/.test(prod.picklist.map(x => x.text).join()) && prod.picklist.some(x => /Closure COACH.*no stitch/.test(x.text)));
    console.log("no weight when the shop ships → an error:", codes("noweight").split(",").includes("noWeight"));
    console.log("no blank link → a warning, not an error:", prod.noweight.find(x => x.code === "noBlankLink").level === "warn");
    console.log("“No embroidery design needed” products aren't flagged for a design…", !prod.dtf.some(x => x.code === "noDesign"));
    console.log("…but unlinked sizes still are (a DTF tee is still a blank to track):", codes("dtf") === "noBlankLink" && prod.dtf[0].level === "warn");
    console.log("hidden products are checked too, as warnings until shown — unless on an open order (and they say so):",
      prod.hidden && prod.hidden.every(x => x.level === "warn" && /hidden — fix before showing it/.test(x.text)) && /hidden, but on an open order/.test(prod.hiddenopen[0].text));
    console.log("the shop's product count:", issues.orgs.league.productCount === 7);

    console.log("\n=== Designs ===");
    const des = issues.orgs.league.designs;
    console.log("a complete design has no issues:", !des[front]);
    console.log("no stitch file → error; no hoops → error; no thread colors → warning:",
      des[noFile][0].code === "noStitchFile" && des[noHoop].some(x => x.code === "noHoops" && x.level === "error") && des[noHoop].some(x => x.code === "noThreads" && x.level === "warn"));
    console.log("global designs are listed separately too:", !!issues.globalDesigns[noFile] && !issues.globalDesigns[noHoop]);
    console.log("design count, and a shop with nothing wrong has none:", issues.orgs.league.designCount === 2 && issues.orgs.club.productCount === 0 && issues.orgs.club.designCount === 0);
    const forClub = await lib.getCatalogIssues(d1, "club");
    console.log("asking for one shop returns just it (plus global designs):", Object.keys(forClub.orgs).join() === "club" && !!forClub.globalDesigns[noFile]);

    console.log("\n=== API + the No-design-needed flag ===");
    let r = await call({ action: "getCatalogIssues", org: "league" });
    console.log("getCatalogIssues action:", r.status === 200 && r.body.issues.orgs.league.productCount === 7);
    r = await call({ action: "updateProduct", org: "league", productId: "nodesign", type: "cap", name: "nodesign", pricingMode: "flat", flatPrice: 25, weightOz: 4, visible: true, images: [], noDesignNeeded: true });
    console.log("ticking “No embroidery design needed” clears the design error (blank links still flagged):", r.status === 200 &&
      (await lib.getCatalogIssues(d1, "league")).orgs.league.products.nodesign.map(x => x.code).join() === "noBlankLink" &&
      (await lib.getProductsByOrg(d1, "league")).find(p => p.productId === "nodesign").noDesignNeeded === true);
    console.log("…and it's audited:", d1.q("SELECT detail FROM audit_log WHERE action='product.updated'").some(x => /noDesignNeeded/.test(x.detail)));

    console.log("\n=== Admin screens ===");
    const adminJs = read("public/admin.js");
    const live = await lib.getCatalogIssues(d1);
    class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
    const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
      beforeParse(win) {
        win.CSS = win.CSS || { escape: (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) };
        win.fetch = async (url, opts) => {
          const b = opts && opts.body ? JSON.parse(opts.body) : {};
          const ok = (o) => ({ ok: true, status: 200, json: async () => Object.assign({ status: "ok" }, o) });
          if (String(url).includes("/api/catalog")) return ok({ status: "admin" });
          if (b.action === "getCatalogIssues") return ok({ issues: live });
          if (b.action === "listOrgsAdmin") return ok({ orgs: [{ orgId: "league", subdomain: "league", name: "League", ready: true }, { orgId: "club", subdomain: "club", name: "Club", ready: true }] });
          if (b.action === "listProducts") return ok({ products: await lib.getProductsByOrg(d1, b.org) });
          if (b.action === "listDesigns") return ok({ designs: [{ id: front, name: "Front", hoopIds: [capHoop] }, { id: noHoop, name: "Back", hoopIds: [] }, { id: noFile, name: "Closure COACH", isGlobal: true, hoopIds: [capHoop] }] });
          if (b.action === "getDesign") return ok({ design: { id: noHoop, orgId: "league", name: "Back", hoopIds: [] }, versions: [] });
          return ok({});
        };
      } });
    const w = dom.window;
    await new Promise(res => setTimeout(res, 150));
    await w.loadAdminScript();
    w.eval('adminKey = "cookie"; adminOrgs = [{orgId:"league", name:"League"}, {orgId:"club", name:"Club"}];');
    const tick = (ms = 80) => new Promise(res => setTimeout(res, ms));
    const app = w.document.getElementById("app");
    await w.renderAdminOrgList(app);
    await tick();
    const btn = (org, kind) => app.querySelector(`button[data-org="${org}"][data-issues="${kind}"]`);
    console.log("Manage catalog: ⚠ count next to the shop's Products and Designs buttons:",
      /⚠ 7/.test(btn("league", "products").textContent) && /⚠ 2/.test(btn("league", "designs").textContent));
    console.log("red when any issue is an error:", /background:#b03a2e/.test(btn("league", "products").innerHTML));
    console.log("no marker for a shop with nothing missing, and a note explaining the markers:",
      !btn("club", "products").querySelector(".cat-issue-badge") && /⚠ marks a shop's products or designs/.test(app.textContent));
    await w.renderProductList(app, "league");
    await tick();
    const rowIssues = (id) => app.querySelector(`.prod-issues[data-product="${id}"]`);
    console.log("Products: each product with issues lists them under its name, with a ⚠ count:",
      /No design linked/.test(rowIssues("badback").textContent) === false && /Design “Back”/.test(rowIssues("badback").textContent) &&
      /⚠ 2/.test(app.querySelector('.prod-issue-badge[data-product="badback"]').textContent) && rowIssues("good").textContent === "");
    w.renderProductForm(app, "league", (await lib.getProductsByOrg(d1, "league")).find(p => p.productId === "badback"));
    await tick();
    console.log("the product form shows what needs attention at the top, and has the No-design-needed box:",
      /Needs attention/.test(app.querySelector("#prodFormIssues").textContent) && !!app.querySelector("#prodFormNoDesign"));
    await w.renderDesigns(app, "league", null);
    await tick();
    const dbtn = (id) => w.document.querySelector(`#dsgList button[data-did="${id}"]`);
    console.log("Designs: ⚠ on each design with issues — the shop's and global ones:",
      !!dbtn(noHoop).querySelector(".cat-issue-badge") && !!dbtn(noFile).querySelector(".cat-issue-badge") && !dbtn(front).querySelector(".cat-issue-badge"));
    await w.renderDesigns(app, "league", noHoop);
    await tick(150);
    console.log("the open design lists what needs attention:", /No hoops picked/.test(w.document.getElementById("dsgDetailIssues").textContent));
  } catch (e) {
    console.log("test74 crashed:", false);
    console.error(e);
    process.exit(1);
  }
})();
