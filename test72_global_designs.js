const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Global designs (migrations/0033): a design marked global can be used by every shop — e.g. the
// set of cap-closure designs every shop maps its pick list to — kept and edited in one place.
// It keeps its home shop; other shops see it in their Designs list, design pickers and pick-list
// mapping, can edit it (one edit, every shop), and it can't go back to shop-only while another
// shop uses it. Real migrations + db.js + orders.js on sql.js.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, createHoop, createThread, saveDesign, getDesign, listDesigns, addDesignVersion,
  createProduct, setProductDesigns, getProductionQueue };`)();
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
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('league1','league1','League 1','t','t'), ('league2','league2','League 2','t','t');`);
    const flat = await lib.createHoop(d1, { name: "Flat 4in" });
    const capFrame = await lib.createHoop(d1, { name: "Cap frame", isCapFrame: true });
    const gold = await lib.createThread(d1, { brand: "Madeira", type: "PolyNeon", weight: "40", code: "2", name: "Gold", colorHex: "ccaa00" });

    console.log("=== Making a design global ===");
    let r = await call({ action: "saveDesign", org: "league1", design: { name: "Closure COACH", hoopIds: [flat], isGlobal: true } });
    const coach = r.body.id;
    const captain = (await call({ action: "saveDesign", org: "league1", design: { name: "Closure CAPTAIN", hoopIds: [flat] } })).body.id;
    const league1Only = (await call({ action: "saveDesign", org: "league1", design: { name: "League 1 crest", hoopIds: [capFrame] } })).body.id;
    const front2 = (await call({ action: "saveDesign", org: "league2", design: { name: "League 2 crest", hoopIds: [capFrame] } })).body.id;
    await lib.addDesignVersion(d1, coach, { designFileKey: `designs/${coach}/a.emb`, machineFileKey: `designs/${coach}/a.dst`, machineFileName: "COACH.DST", threadColors: [{ needle: 1, threadId: gold }] });
    await lib.addDesignVersion(d1, front2, { designFileKey: `designs/${front2}/a.emb`, machineFileKey: `designs/${front2}/a.dst`, machineFileName: "L2.DST", threadColors: [] });
    console.log("created as global, kept with its home shop:", (await lib.getDesign(d1, coach)).isGlobal === true && (await lib.getDesign(d1, coach)).orgId === "league1");
    r = await call({ action: "saveDesign", org: "league1", design: { id: captain, name: "Closure CAPTAIN", hoopIds: [flat], isGlobal: true } });
    console.log("an existing design can be made global:", r.status === 200 && (await lib.getDesign(d1, captain)).isGlobal === true);
    console.log("both are audited as made global:", d1.q("SELECT count(*) n FROM audit_log WHERE action='design.made_global'")[0].n === 2);

    console.log("\n=== Every shop sees global designs ===");
    const l2 = await lib.listDesigns(d1, "league2");
    console.log("another shop's list has its own designs plus the global ones — not other shops' private designs:",
      l2.map(d => d.name).join("|") === "League 2 crest|Closure CAPTAIN|Closure COACH" && !l2.some(d => d.id === league1Only));
    console.log("global designs carry their hoops:", l2.find(d => d.id === coach).hoopIds.join() === String(flat));

    console.log("\n=== Another shop uses them ===");
    await lib.createProduct(d1, "league2", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 25, personalizationPrice: 5, visible: true });
    r = await call({ action: "updateProduct", org: "league2", productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 25, personalizationPrice: 5,
      personalizationOptions: ["COACH", "CAPTAIN"], visible: true, images: [], personalizationMode: "combined",
      personalizationOptionDesigns: { COACH: coach, "CAPTAIN": captain } });
    console.log("a pick list can map to global designs from another shop:", r.status === 200);
    r = await call({ action: "setProductDesigns", org: "league2", productId: "cap", designs: [{ designId: front2, placement: "Front", isMain: true }, { designId: coach, placement: "Side" }] });
    console.log("a global design can be one of the product's designs:", r.status === 200);
    r = await call({ action: "setProductDesigns", org: "league2", productId: "cap", designs: [{ designId: league1Only, placement: "Front", isMain: true }] });
    console.log("…but another shop's PRIVATE design is still refused:", r.status === 400 && /doesn't belong/.test(r.body.message));
    await call({ action: "setProductDesigns", org: "league2", productId: "cap", designs: [{ designId: front2, placement: "Front", isMain: true }] });
    await lib.insertOrder(d1, { orderId: "L2-1", orgId: "league2", customerName: "Sam", contact: "h@x.com", placedAt: "2026-09-01T00:00:00Z" },
      [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 25, personalized: true, persName: "COACH" }]);
    d1._raw.run("UPDATE orders SET paid=1, blankReceivedAt='2026-09-03' WHERE orderId='L2-1'");
    const job = (await lib.getProductionQueue(d1)).find(j => j.orderId === "L2-1");
    console.log("Run Order runs the shared closure design for the other shop's order:",
      job && job.steps.length === 2 && job.steps[1].designName === "Closure COACH" && job.steps[1].machineFileName === "COACH.DST");

    console.log("\n=== One design, edited once ===");
    r = await call({ action: "saveDesign", org: "league2", design: { id: coach, name: "Closure COACH (crest)", hoopIds: [flat], isGlobal: true } });
    console.log("another shop can edit the global design, and the change shows for every shop:", r.status === 200 &&
      (await lib.listDesigns(d1, "league1")).find(d => d.id === coach).name === "Closure COACH (crest)");
    console.log("…without moving its home shop:", (await lib.getDesign(d1, coach)).orgId === "league1");
    r = await call({ action: "saveDesign", org: "league2", design: { id: league1Only, name: "Hijack", hoopIds: [] } });
    console.log("a shop can't edit another shop's private design:", r.status === 400 && (await lib.getDesign(d1, league1Only)).name === "League 1 crest");

    console.log("\n=== Back to shop-only ===");
    r = await call({ action: "saveDesign", org: "league1", design: { id: coach, name: "Closure COACH", hoopIds: [flat], isGlobal: false } });
    console.log("refused while another shop's product uses it:", r.status === 400 && /Other shops' products use this global design/.test(r.body.message) && (await lib.getDesign(d1, coach)).isGlobal);
    const solo = (await call({ action: "saveDesign", org: "league1", design: { name: "Unused global", hoopIds: [], isGlobal: true } })).body.id;
    r = await call({ action: "saveDesign", org: "league1", design: { id: solo, name: "Unused global", hoopIds: [], isGlobal: false } });
    console.log("an unused global design can go back to shop-only (audited):", r.status === 200 && !(await lib.getDesign(d1, solo)).isGlobal &&
      d1.q("SELECT count(*) n FROM audit_log WHERE action='design.made_shop_only'")[0].n === 1);
    console.log("saving without the flag leaves it as it is:", (await call({ action: "saveDesign", org: "league1", design: { id: captain, name: "Closure CAPTAIN", hoopIds: [flat] } })).status === 200 &&
      (await lib.getDesign(d1, captain)).isGlobal === true);

    console.log("\n=== Admin screens ===");
    const adminJs = read("public/admin.js");
    class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
    const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
      beforeParse(win) {
        win.fetch = async (url, opts) => {
          const b = opts && opts.body ? JSON.parse(opts.body) : {};
          const ok = (o) => ({ ok: true, status: 200, json: async () => Object.assign({ status: "ok" }, o) });
          if (String(url).includes("/api/catalog")) return ok({ status: "admin" });
          if (b.action === "listDesigns") return ok({ designs: await lib.listDesigns(d1, b.org) });
          if (b.action === "getDesign") return ok({ design: await lib.getDesign(d1, b.id), versions: [] });
          if (b.action === "listHoops") return ok({ hoops: [] });
          if (b.action === "listThreads") return ok({ threads: [] });
          return ok({});
        };
      } });
    const w = dom.window;
    await new Promise(res => setTimeout(res, 150));
    await w.loadAdminScript();
    w.eval('adminKey = "cookie"; adminOrgs = [{orgId:"league1", name:"League 1"}, {orgId:"league2", name:"League 2"}];');
    const app = w.document.getElementById("app");
    await w.renderDesigns(app, "league2", coach);
    await new Promise(res => setTimeout(res, 60));
    const list = w.document.getElementById("dsgList");
    console.log("the Designs list shows the shop's own designs, then a Global group:",
      !!list.querySelector(".dsg-global-head") && list.textContent.indexOf("League 2 crest") < list.textContent.indexOf("Global") &&
      list.textContent.indexOf("Global") < list.textContent.indexOf("Closure CAPTAIN"));
    const detail = w.document.getElementById("dsgDetail");
    console.log("a global design is badged, with its home shop and a warning that edits apply everywhere:",
      /GLOBAL/.test(detail.textContent) && /home shop League 1/.test(detail.textContent) && /changes here apply everywhere/.test(detail.textContent));
    [...detail.querySelectorAll("button")].find(b2 => b2.textContent.trim() === "Edit").click();
    console.log("the design form has the Global checkbox, ticked for a global design:", w.document.getElementById("dsgfGlobal").checked === true);
    w.document.querySelector("#dsgfCancel").click();
    console.log("design pickers mark global designs:", /x\.isGlobal \? " 🌐" : ""/.test(adminJs) && /d\.isGlobal \? " 🌐 global" : ""/.test(adminJs));
  } catch (e) {
    console.log("test72 crashed:", false);
    console.error(e);
    process.exit(1);
  }
})();
