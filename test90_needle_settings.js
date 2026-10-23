const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Needle settings (migrations/0044): the needle Run Order recommends. SIZE follows the thread
// (needle_sizes: thread weight -> needle size), TYPE follows the garment (needle_types, picked per
// blank). Real SQL (sql.js), real db.js + orders.js admin API, and the real admin screens in jsdom
// talking to that API: Threads -> Needle settings, the blank form's dropdown, and Run Order.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, createHoop, createThread, saveDesign, addDesignVersion, setProductDesign, createProduct,
  setBlankLink, createBlank, updateBlank, getAllBlanks, saveMachine, getProductionQueue, normThreadWeight,
  listNeedleSizes, saveNeedleSize, deleteNeedleSize, listNeedleTypes, saveNeedleType, deleteNeedleType };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
// `without`: leave out the one migration whose number starts with this ("0044") — a database that
// has everything else, which is what production looks like when code is deployed just before it.
const newDb = async (without) => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) if (!without || !f.startsWith(without)) d1.execFile(read("migrations/" + f));
  return d1;
};
const tick = (ms) => new Promise(res => setTimeout(res, ms || 60));

(async () => {
  const d1 = await newDb();
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  console.log("=== Migration 0044: defaults ===");
  let sizes = await lib.listNeedleSizes(d1);
  console.log("40 wt -> 75/11 and 60 wt -> 65/9 are seeded:",
    sizes.length === 2 && sizes[0].weight === "40" && sizes[0].needleSize === "75/11" && sizes[1].weight === "60" && sizes[1].needleSize === "65/9");
  let types = await lib.listNeedleTypes(d1);
  console.log("needle types Sharp and Ballpoint are seeded, in that order:", types.map(t => t.name).join(",") === "Sharp,Ballpoint");
  const sharp = types[0].id, ballpoint = types[1].id;

  console.log("\n=== db.js: needle size by thread weight ===");
  console.log("weights are normalised (40wt, ' 40 WT ', '60 Weight'):",
    lib.normThreadWeight("40wt") === "40" && lib.normThreadWeight(" 40 WT ") === "40" && lib.normThreadWeight("60 Weight") === "60" && lib.normThreadWeight(null) === "");
  await lib.saveNeedleSize(d1, { weight: "40 wt", needleSize: "80/12" });
  sizes = await lib.listNeedleSizes(d1);
  console.log("saving an existing weight (typed as '40 wt') changes its size instead of adding a row:",
    sizes.length === 2 && sizes.find(z => z.weight === "40").needleSize === "80/12");
  await lib.saveNeedleSize(d1, { weight: "120", needleSize: "60/8" });
  await lib.saveNeedleSize(d1, { weight: "30", needleSize: "90/14" });
  sizes = await lib.listNeedleSizes(d1);
  console.log("listed in numeric weight order (30, 40, 60, 120 — not text order):", sizes.map(z => z.weight).join(",") === "30,40,60,120");
  let threw = "";
  try { await lib.saveNeedleSize(d1, { weight: "", needleSize: "75/11" }); } catch (e) { threw = e.message; }
  console.log("a weight is required:", /weight is required/i.test(threw));
  threw = "";
  try { await lib.saveNeedleSize(d1, { weight: "50", needleSize: " " }); } catch (e) { threw = e.message; }
  console.log("a needle size is required:", /size is required/i.test(threw));
  await lib.deleteNeedleSize(d1, "120 wt");
  await lib.deleteNeedleSize(d1, "30");
  await lib.saveNeedleSize(d1, { weight: "40", needleSize: "75/11" });
  sizes = await lib.listNeedleSizes(d1);
  console.log("deleted by weight (normalised too):", sizes.map(z => z.weight + "=" + z.needleSize).join(",") === "40=75/11,60=65/9");

  console.log("\n=== db.js: needle types ===");
  const wedge = await lib.saveNeedleType(d1, { name: "Wedge point" });
  types = await lib.listNeedleTypes(d1);
  console.log("a new type is added at the end:", types.length === 3 && types[2].id === wedge && types[2].name === "Wedge point");
  await lib.saveNeedleType(d1, { id: wedge, name: "Leather (wedge)" });
  console.log("renamed in place:", (await lib.listNeedleTypes(d1)).find(t => t.id === wedge).name === "Leather (wedge)");
  threw = "";
  try { await lib.saveNeedleType(d1, { name: "ballpoint" }); } catch (e) { threw = e.message; }
  console.log("a duplicate name is refused, whatever its case:", /already a needle type/i.test(threw) && (await lib.listNeedleTypes(d1)).length === 3);
  threw = "";
  try { await lib.saveNeedleType(d1, { name: "  " }); } catch (e) { threw = e.message; }
  console.log("a name is required:", /name is required/i.test(threw));

  console.log("\n=== Blanks carry a needle type ===");
  const teeId = (await lib.createBlank(d1, { name: "Gildan 5000", brand: "Gildan", productType: "shirt", needleTypeId: ballpoint,
    colors: [{ color: "Black", sizes: [{ size: "M", purchasePrice: 3, quantity: 0 }] }] })).id;
  const capId = (await lib.createBlank(d1, { name: "Richardson 112", brand: "Richardson", color: "Navy", productType: "cap" })).id;
  let blanks = await lib.getAllBlanks(d1);
  const tee = () => blanks.find(b => b.id === teeId), cap = () => blanks.find(b => b.id === capId);
  console.log("created with a type -> id and name come back:", tee().needleTypeId === ballpoint && tee().needleType === "Ballpoint");
  console.log("created without one -> not set:", cap().needleTypeId === null && cap().needleType === "");
  // A caller that doesn't know about needle types (PDF import, merges, older scripts) must not clear it.
  await lib.updateBlank(d1, teeId, { name: "Gildan 5000 Tee", brand: "Gildan", productType: "shirt" });
  blanks = await lib.getAllBlanks(d1);
  console.log("an update that doesn't mention the field keeps the type:", tee().name === "Gildan 5000 Tee" && tee().needleTypeId === ballpoint);
  await lib.updateBlank(d1, teeId, { name: "Gildan 5000 Tee", brand: "Gildan", productType: "shirt", needleTypeId: sharp });
  blanks = await lib.getAllBlanks(d1);
  console.log("an update that sends a type changes it:", tee().needleType === "Sharp");
  await lib.updateBlank(d1, teeId, { name: "Gildan 5000 Tee", brand: "Gildan", productType: "shirt", needleTypeId: null });
  blanks = await lib.getAllBlanks(d1);
  console.log("sending null clears it:", tee().needleTypeId === null && tee().needleType === "");
  await lib.updateBlank(d1, teeId, { name: "Gildan 5000 Tee", brand: "Gildan", productType: "shirt", needleTypeId: ballpoint });
  types = await lib.listNeedleTypes(d1);
  console.log("each type reports how many blanks use it:", types.find(t => t.id === ballpoint).blankCount === 1 && types.find(t => t.id === sharp).blankCount === 0);
  threw = "";
  try { await lib.deleteNeedleType(d1, ballpoint); } catch (e) { threw = e.message; }
  console.log("a type a blank uses can't be deleted, and says why:", /set on 1 blank/.test(threw) && (await lib.listNeedleTypes(d1)).some(t => t.id === ballpoint));
  await lib.deleteNeedleType(d1, wedge);
  console.log("an unused type is deleted:", !(await lib.listNeedleTypes(d1)).some(t => t.id === wedge));

  console.log("\n=== Real admin API ===");
  let r = await call({ action: "getNeedleSettings" });
  console.log("getNeedleSettings returns both lists:", r.status === 200 && r.body.needleSizes.length === 2 && r.body.needleTypes.length === 2);
  r = await call({ action: "saveNeedleSize", needleSize: { weight: "30", needleSize: "90/14" } });
  console.log("saveNeedleSize answers with the updated lists:", r.status === 200 && r.body.needleSizes.some(z => z.weight === "30" && z.needleSize === "90/14") && Array.isArray(r.body.needleTypes));
  r = await call({ action: "saveNeedleSize", needleSize: { weight: "30", needleSize: "" } });
  console.log("a blank size is refused (400):", r.status === 400 && /size is required/i.test(r.body.message));
  r = await call({ action: "deleteNeedleSize", weight: "30" });
  console.log("deleteNeedleSize removes it:", r.status === 200 && !r.body.needleSizes.some(z => z.weight === "30"));
  r = await call({ action: "saveNeedleType", needleType: { name: "Sharp" } });
  console.log("a duplicate type is refused (400):", r.status === 400 && /already a needle type/i.test(r.body.message));
  r = await call({ action: "deleteNeedleType", id: ballpoint });
  console.log("deleting a type in use is refused (400):", r.status === 400 && /set on 1 blank/.test(r.body.message));
  r = await call({ action: "deleteNeedleType" });
  console.log("deleteNeedleType needs an id:", r.status === 400);
  r = await call({ action: "createBlank", name: "Ghost", productType: "shirt", needleTypeId: 987654 });
  console.log("a blank can't be saved with a needle type that doesn't exist:", r.status === 400 && /no longer exists/.test(r.body.message) &&
    !(await lib.getAllBlanks(d1)).some(b => b.name === "Ghost"));
  r = await call({ action: "updateBlank", id: capId, name: "Richardson 112", brand: "Richardson", productType: "cap", needleTypeId: sharp });
  console.log("updateBlank sets the type through the API:", r.status === 200 && (await lib.getAllBlanks(d1)).find(b => b.id === capId).needleType === "Sharp");
  r = await call({ action: "getBlanks" });
  console.log("getBlanks carries needleTypeId + needleType:", r.body.blanks.find(b => b.id === teeId).needleType === "Ballpoint");

  console.log("\n=== Run Order queue ===");
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Acme','t','t');`);
  const hoop = await lib.createHoop(d1, { name: "6in Round", isCapFrame: false });
  const t40a = await lib.createThread(d1, { brand: "Madeira", type: "PolyNeon", weight: "40", code: "1147", name: "Red", colorHex: "cc2222" });
  const t40b = await lib.createThread(d1, { brand: "Madeira", type: "PolyNeon", weight: "40", code: "1201", name: "Blue", colorHex: "2222cc" });
  const t60 = await lib.createThread(d1, { brand: "Madeira", type: "PolyNeon", weight: "60", code: "1800", name: "Black", colorHex: "111111" });
  const t30 = await lib.createThread(d1, { brand: "Madeira", type: "PolyNeon", weight: "30", code: "1001", name: "White", colorHex: "ffffff" });
  const product = async (productId, blankId, size, threadIds) => {
    await lib.createProduct(d1, "acme", { productId, type: "shirt", name: productId, pricingMode: "flat", flatPrice: 20, visible: true });
    if (blankId) await lib.setBlankLink(d1, "acme", productId, size, blankId, size);
    const designId = await lib.saveDesign(d1, "acme", { name: productId + " logo", stabilizer: "cutaway", hoopId: hoop });
    await lib.addDesignVersion(d1, designId, { designFileKey: "d/" + productId + ".emb", designFileName: productId + ".emb", designFileExt: "emb",
      machineFileKey: "d/" + productId + ".exp", machineFileName: productId + ".exp", machineFileExt: "exp",
      threadColors: threadIds.map((threadId, i) => ({ needle: i + 1, threadId })) });
    await lib.setProductDesign(d1, "acme", productId, designId);
  };
  await product("tee", teeId, "M", [t40a, t40b]);        // one weight, blank = Ballpoint
  await product("capfine", capId, "OSFA", [t40a, t60]);  // mixed weights, blank = Sharp
  await product("loose", null, "M", [t30]);              // no blank linked, weight with no needle size
  let n = 0;
  const order = async (productId, size) => {
    const id = "ORD" + (++n);
    await lib.insertOrder(d1, { orderId: id, orgId: "acme", customerName: "Cust " + id, contact: id + "@x.com", placedAt: "2026-07-01T00:00:00Z" },
      [{ productId, name: productId, type: "shirt", size, qty: 1, unitPrice: 20 }]);
    d1._raw.run("UPDATE orders SET paid=1, blankReceivedAt='2026-07-05T00:00:00Z' WHERE orderId=?", [id]);
    return id;
  };
  const oTee = await order("tee", "M"), oCap = await order("capfine", "OSFA"), oLoose = await order("loose", "M");
  const queue = await lib.getProductionQueue(d1);
  const job = (oid) => queue.find(j => j.orderId === oid);
  console.log("each queued job's blank carries its needle type:", job(oTee).blank.needleType === "Ballpoint" && job(oCap).blank.needleType === "Sharp");
  console.log("a job with no blank linked still queues (blank null):", job(oLoose) && job(oLoose).blank === null);
  r = await call({ action: "getProductionQueue" });
  console.log("the getProductionQueue action also returns the needle sizes by weight:",
    r.status === 200 && r.body.needleSizes.map(z => z.weight + "=" + z.needleSize).join(",") === "40=75/11,60=65/9");

  console.log("\n=== A database that hasn't had 0044 applied yet keeps working ===");
  const old = await newDb("0044");
  console.log("the needle lists read as empty instead of failing:", (await lib.listNeedleSizes(old)).length === 0 && (await lib.listNeedleTypes(old)).length === 0);
  const oldBlank = (await lib.createBlank(old, { name: "Old blank", productType: "shirt" })).id;
  await lib.updateBlank(old, oldBlank, { name: "Old blank 2", productType: "shirt" });
  const oldBlanks = await lib.getAllBlanks(old);
  console.log("blanks can still be created, edited and listed:", oldBlanks.length === 1 && oldBlanks[0].name === "Old blank 2" && oldBlanks[0].needleType === "");
  old._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Acme','t','t');`);
  await lib.createProduct(old, "acme", { productId: "tee", type: "shirt", name: "tee", pricingMode: "flat", flatPrice: 20, visible: true });
  await lib.setBlankLink(old, "acme", "tee", "M", oldBlank, "M");
  await lib.setProductDesign(old, "acme", "tee", await lib.saveDesign(old, "acme", { name: "logo" }));
  await lib.insertOrder(old, { orderId: "OLD1", orgId: "acme", customerName: "C", contact: "c@x.com", placedAt: "2026-07-01T00:00:00Z" },
    [{ productId: "tee", name: "tee", type: "shirt", size: "M", qty: 1, unitPrice: 20 }]);
  old._raw.run("UPDATE orders SET paid=1, blankReceivedAt='2026-07-05T00:00:00Z' WHERE orderId='OLD1'");
  const oldQueue = await lib.getProductionQueue(old);
  console.log("the Run Order queue still loads:", oldQueue.length === 1 && oldQueue[0].blank.id === oldBlank);

  // ---- The real admin screens, in jsdom, talking to the real API above ----------------------
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const sent = [];
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = async (url, opts) => {
        if (String(url).includes("/api/orders") && opts && opts.body) {
          const body = JSON.parse(opts.body); sent.push(body);
          const res = await call(body);
          return { ok: res.status < 400, status: res.status, json: async () => res.body };
        }
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
  const modal = () => [...doc.querySelectorAll("#ndBody")].pop();
  const settle = async (pred) => { for (let i = 0; i < 60 && !pred(); i++) await tick(25); };

  console.log("\n=== Pure: recommendedNeedle_ ===");
  const threads = [{ id: 1, weight: "40" }, { id: 2, weight: "40 wt" }, { id: 3, weight: "60" }, { id: 4, weight: "30" }, { id: 5, weight: "" }];
  const cfg = [{ weight: "40", needleSize: "75/11" }, { weight: "60", needleSize: "65/9" }];
  const tc = (...ids) => ids.map((threadId, i) => ({ needle: i + 1, threadId }));
  let rec = w.recommendedNeedle_(tc(1, 2), threads, cfg, { needleType: "Ballpoint" });
  console.log("one weight (typed two ways) -> one size, with the blank's type:", rec.sizes.join() === "75/11" && rec.type === "Ballpoint" && !rec.missingWeights.length);
  console.log("...shown as '75/11 Ballpoint':", /Needle: <b[^>]*>75\/11 Ballpoint<\/b>/.test(w.needleLineHtml_(rec)));
  rec = w.recommendedNeedle_(tc(1, 3, 2), threads, cfg, { needleType: "Sharp" });
  console.log("mixed weights -> both sizes, in first-use order, and a size per colour:",
    rec.sizes.join() === "75/11,65/9" && rec.perColor.map(c => c.size).join() === "75/11,65/9,75/11");
  let line = w.needleLineHtml_(rec);
  console.log("...shown as the type, then each size with its weight:", />Sharp<\/b>/.test(line) && />75\/11<\/b> for 40 wt/.test(line) && />65\/9<\/b> for 60 wt/.test(line));
  rec = w.recommendedNeedle_(tc(1, 4), threads, cfg, { needleType: "Sharp" });
  line = w.needleLineHtml_(rec);
  console.log("a weight with no needle size is called out, with where to set it:",
    rec.missingWeights.join() === "30" && /no needle size set for 30 wt \(Threads → Needle settings\)/.test(line) && />75\/11<\/b> for 40 wt/.test(line));
  rec = w.recommendedNeedle_(tc(1), threads, cfg, { needleType: "" });
  console.log("a blank with no type says so:", /75\/11<\/b>/.test(w.needleLineHtml_(rec)) && /needle type not set on this blank/.test(w.needleLineHtml_(rec)));
  rec = w.recommendedNeedle_(tc(1), threads, cfg, null);
  console.log("no blank linked says so:", /no blank linked, so no needle type/.test(w.needleLineHtml_(rec)));
  rec = w.recommendedNeedle_(tc(5), threads, cfg, { needleType: "Sharp" });
  console.log("threads with no weight -> no size, said plainly:", rec.noWeight && /the threads in this design have no weight/.test(w.needleLineHtml_(rec)));
  rec = w.recommendedNeedle_([], threads, cfg, { needleType: "Sharp" });
  console.log("no colours (no design) -> just the type, no size warning:", w.needleLineHtml_(rec).replace(/<[^>]+>/g, "").trim() === "Needle: Sharp");
  console.log("an unknown thread id doesn't throw:", w.recommendedNeedle_(tc(999), threads, cfg, null).perColor[0].size === "");
  console.log("the line escapes what it shows:", !/<img/.test(w.needleLineHtml_(w.recommendedNeedle_([], [], [], { needleType: "<img src=x>" }))));

  console.log("\n=== Threads -> Needle settings ===");
  await w.renderThreadCatalog(app);
  const btn = doc.getElementById("thrNeedleBtn");
  console.log("the Threads screen has a Needle settings button:", !!btn && /Needle settings/.test(btn.textContent));
  btn.click();
  await settle(() => modal() && modal().querySelector(".ndSizeEdit"));
  let m = modal();
  const sizeRows = () => [...modal().querySelectorAll(".ndSizeEdit")].map(el => el.dataset.weight + "=" + el.value).join(",");
  const typeRows = () => [...modal().querySelectorAll(".ndTypeEdit")].map(el => el.value).join(",");
  console.log("it lists the size for each weight and the needle types:", sizeRows() === "40=75/11,60=65/9" && typeRows() === "Sharp,Ballpoint");
  console.log("it points out catalog weights with no needle size (30 wt):", [...m.querySelectorAll(".ndUnset")].map(b => b.dataset.weight).join() === "30");
  console.log("it shows which type is used by blanks:", /1 blank/.test(m.textContent));
  m.querySelector(".ndUnset").click();
  console.log("clicking a missing weight fills it in ready for a size:", m.querySelector("#ndWeight").value === "30");
  m.querySelector("#ndSize").value = "90/14";
  m.querySelector("#ndSizeAdd").click();
  await settle(() => /30=90\/14/.test(sizeRows()));
  console.log("Add saves the new weight and redraws in order:", sizeRows() === "30=90/14,40=75/11,60=65/9" && !modal().querySelector(".ndUnset"));
  let el = [...modal().querySelectorAll(".ndSizeEdit")].find(x => x.dataset.weight === "30");
  el.value = "100/16"; el.dispatchEvent(new w.Event("change"));
  // Wait for the redraw that follows the save (the box is rebuilt with the saved value as its "was").
  await settle(() => { const x = [...modal().querySelectorAll(".ndSizeEdit")].find(y => y.dataset.weight === "30"); return x && x.dataset.was === "100/16"; });
  console.log("editing a size in place saves it:", (await lib.listNeedleSizes(d1)).find(z => z.weight === "30").needleSize === "100/16");
  el = [...modal().querySelectorAll(".ndSizeEdit")].find(x => x.dataset.weight === "30");
  el.value = ""; el.dispatchEvent(new w.Event("change"));
  console.log("emptying a size puts the old value back instead of saving a blank:", el.value === "100/16" && (await lib.listNeedleSizes(d1)).find(z => z.weight === "30").needleSize === "100/16");
  [...modal().querySelectorAll(".ndSizeDel")].find(x => x.dataset.weight === "30").click();
  await settle(() => !/30=/.test(sizeRows()));
  console.log("Delete removes the weight:", sizeRows() === "40=75/11,60=65/9");
  modal().querySelector("#ndTypeName").value = "Titanium";
  modal().querySelector("#ndTypeAdd").click();
  await settle(() => /Titanium/.test(typeRows()));
  console.log("a needle type can be added:", typeRows() === "Sharp,Ballpoint,Titanium");
  modal().querySelector("#ndTypeName").value = "sharp";
  modal().querySelector("#ndTypeAdd").click();
  await settle(() => /already a needle type/.test(modal().querySelector("#ndErr").textContent));
  console.log("a duplicate is refused with the reason shown in the window:", /already a needle type/.test(modal().querySelector("#ndErr").textContent) && typeRows() === "Sharp,Ballpoint,Titanium");
  const bpDel = [...modal().querySelectorAll(".ndTypeDel")].find(x => Number(x.dataset.id) === ballpoint);
  bpDel.click();
  await settle(() => /set on 1 blank/.test(modal().querySelector("#ndErr").textContent));
  console.log("deleting a type a blank uses is refused with the reason:", /set on 1 blank/.test(modal().querySelector("#ndErr").textContent) && /Ballpoint/.test(typeRows()));
  const tiId = (await lib.listNeedleTypes(d1)).find(t => t.name === "Titanium").id;
  [...modal().querySelectorAll(".ndTypeDel")].find(x => Number(x.dataset.id) === tiId).click();
  await settle(() => !/Titanium/.test(typeRows()));
  console.log("an unused type is deleted:", typeRows() === "Sharp,Ballpoint");
  modal().querySelector("#ndClose").click();
  console.log("Done closes the window:", !doc.querySelector("#ndBody"));

  console.log("\n=== Blank form: needle type dropdown ===");
  const blankForm = async (blank) => { w.showBlankModal(blank, () => {}); await settle(() => doc.getElementById("blkNeedleType")); return doc.getElementById("blkNeedleType"); };
  let sel = await blankForm((await lib.getAllBlanks(d1)).find(b => b.id === teeId));
  console.log("offers Not set plus every needle type:", [...sel.options].map(o => o.textContent.trim()).join("|") === "— Not set —|Sharp|Ballpoint");
  console.log("an existing blank's type is preselected:", Number(sel.value) === ballpoint);
  sel.value = String(sharp);
  sent.length = 0;
  doc.getElementById("blkSaveBtn").click();
  await settle(() => !doc.getElementById("blkNeedleType"));
  let saved = sent.find(b => b.action === "updateBlank");
  console.log("saving sends the chosen type and it's stored:", saved && saved.needleTypeId === sharp && (await lib.getAllBlanks(d1)).find(b => b.id === teeId).needleType === "Sharp");
  sel = await blankForm((await lib.getAllBlanks(d1)).find(b => b.id === teeId));
  sel.value = "";
  sent.length = 0;
  doc.getElementById("blkSaveBtn").click();
  await settle(() => !doc.getElementById("blkNeedleType"));
  saved = sent.find(b => b.action === "updateBlank");
  console.log("choosing Not set clears it:", saved && saved.needleTypeId === null && (await lib.getAllBlanks(d1)).find(b => b.id === teeId).needleTypeId === null);
  sel = await blankForm(null);
  console.log("a new blank starts as Not set:", sel.value === "");
  doc.getElementById("blkName").value = "Bella 3001";
  sel.value = String(ballpoint);
  doc.getElementById("blkSaveBtn").click();
  await settle(() => !doc.getElementById("blkNeedleType"));
  console.log("a new blank is created with its type:", ((await lib.getAllBlanks(d1)).find(b => b.name === "Bella 3001") || {}).needleType === "Ballpoint");
  await lib.updateBlank(d1, teeId, { name: "Gildan 5000 Tee", brand: "Gildan", productType: "shirt", needleTypeId: ballpoint });
  await w.renderAdminBlanks(app);
  await settle(() => /Gildan 5000 Tee/.test(app.textContent));
  console.log("the Blanks list shows each blank's needle type:", /Gildan 5000 Tee\s*Needle: Ballpoint/.test(app.textContent.replace(/\s+/g, " ")));
  doc.getElementById("blankSearch").value = "ballpoint";
  doc.getElementById("blankSearch").dispatchEvent(new w.Event("input"));
  console.log("...and the search finds blanks by needle type:", /Gildan 5000 Tee/.test(app.textContent) && !/Richardson 112/.test(app.textContent));

  console.log("\n=== Run Order shows the recommended needle ===");
  await lib.saveMachine(d1, { name: "Machine 1", needleCount: 15, hoopIds: [hoop] });
  await w.renderRunOrder(app);
  await settle(() => app.querySelector(".run-job-card"));
  const card = (oid) => [...app.querySelectorAll(".run-job-card")].find(c => (c.querySelector("[data-orderid]") || {}).dataset && c.querySelector("[data-orderid]").dataset.orderid === oid);
  const needle = (oid) => (card(oid).querySelector(".run-needle") || { textContent: "" }).textContent.replace(/\s+/g, " ").trim();
  console.log("every job card has a Needle line:", app.querySelectorAll(".run-job-card").length === 3 && app.querySelectorAll(".run-job-card .run-needle").length === 3);
  console.log("one thread weight + the blank's type:", needle(oTee) === "Needle: 75/11 Ballpoint");
  console.log("mixed weights list each size with its weight:", needle(oCap) === "Needle: Sharp · 75/11 for 40 wt · 65/9 for 60 wt");
  console.log("...and each colour row says which needle size it wants:", /Red · 75\/11 needle/.test(card(oCap).textContent.replace(/\s+/g, " ")) && /Black · 65\/9 needle/.test(card(oCap).textContent.replace(/\s+/g, " ")));
  console.log("a single-weight job doesn't repeat the size on every colour row:", !/needle ⬇|75\/11 needle/.test(card(oTee).textContent));
  console.log("no size for the weight and no blank linked are both called out:",
    /no needle size set for 30 wt \(Threads → Needle settings\)/.test(needle(oLoose)) && /no blank linked, so no needle type/.test(needle(oLoose)));
  // Change the setting, reload the screen: the recommendation follows.
  await call({ action: "saveNeedleSize", needleSize: { weight: "40", needleSize: "80/12" } });
  await w.renderRunOrder(app);
  await settle(() => app.querySelector(".run-job-card"));
  console.log("changing the needle size for a weight changes what Run Order recommends:", needle(oTee) === "Needle: 80/12 Ballpoint");
})().catch(e => { console.error(e); console.log("test90 ran to the end without crashing: false"); process.exitCode = 1; });
