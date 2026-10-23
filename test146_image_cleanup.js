const fs = require("fs");
const { autoConfirm } = require("./testlib/confirm.js");
const { execFileSync } = require("child_process");
const os = require("os");
const path = require("path");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Image clean-up (2026-10). Blanks → Find duplicate photos: the same photo more than once on a blank color (same
// address, same file, or looks the same) is listed with a tick box under each photo — the first kept, the copies
// ticked — and Remove duplicates takes the ticked ones off by position (the same address twice keeps its first copy).
// Tools → Orphaned images: files in the image store nothing in the database points to (any text column of any table;
// a "-thumb" copy goes with its main image; uploads under 24 hours old never count), downloadable as one .zip and
// removable from storage after a server-side re-check. Real db.js / orders.js / orphanImages.js on sql.js with a
// mock R2 bucket; the windows in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createProduct, insertOrder, removeBlankColorImages, getAllBlanks };`)();
const orphanSrc = strip(read("functions/_lib/orphanImages.js"));
const orphan = new Function(orphanSrc + "\nreturn { findOrphanImages, deleteOrphanImages };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/_lib/vendorImages.js")) + "\n" + orphanSrc + "\n" +
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
const BASE = "https://images.example.com";

// A mock R2 bucket: list (paged), head, delete.
function bucket(objects){
  const store = new Map(objects.map(o => [o.key, o]));
  return {
    _store: store,
    list: async ({ cursor, limit }) => { const all = [...store.values()].sort((a, b) => a.key.localeCompare(b.key)); const start = Number(cursor || 0); const page = all.slice(start, start + Math.min(limit || 1000, 2));
      return { objects: page, truncated: start + 2 < all.length, cursor: String(start + 2) }; },
    head: async (k) => store.get(k) || null,
    delete: async (k) => { store.delete(k); },
  };
}

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);`);

  console.log("=== Removing duplicate photos from a blank ===");
  const u = (n) => `${BASE}/uploads/blanks/${n}.jpg`;
  const blankId = (await lib.createBlank(d1, { name: "Gildan Tee", productType: "shirt",
    colors: [{ color: "Black", images: [{ url: u("a") }, { url: u("a") }, { url: u("b") }, { url: u("c") }], sizes: [{ size: "M", quantity: 0 }] },
             { color: "Navy", images: [{ url: u("n") }], sizes: [{ size: "M", quantity: 0 }] }] })).id;
  const colorImgs = async (c) => (await lib.getAllBlanks(d1)).find(b => b.id === blankId).colors.find(x => x.color === c).images.map(im => im.url || im);
  let r = await lib.removeBlankColorImages(d1, blankId, [{ color: "Black", items: [{ index: 1, url: u("a") }, { index: 3, url: u("c") }] }]);
  ok("the ticked photos come off by position — the same address twice keeps its first copy", r.removed === 2 && (await colorImgs("Black")).join() === [u("a"), u("b")].join());
  r = await lib.removeBlankColorImages(d1, blankId, [{ color: "Black", items: [{ index: 1, url: u("zzz") }] }]);
  ok("a position whose photo has changed since the list was drawn is left alone", r.removed === 0 && (await colorImgs("Black")).length === 2);
  r = await lib.removeBlankColorImages(d1, blankId, [{ color: "Navy", items: [{ index: 0, url: u("n") }] }]);
  ok("a color is never emptied", r.removed === 0 && (await colorImgs("Navy")).length === 1);
  const call = async (body, env = {}) => {
    const res = await api({ env: Object.assign({ DB: d1 }, env), waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  r = await call({ action: "removeBlankImages", blankId, removals: [{ color: "Black", items: [{ index: 1, url: u("b") }] }] });
  ok("the admin action does it and audits it", r.status === 200 && r.body.removed === 1 && d1.q("SELECT count(*) n FROM audit_log WHERE action='inventory.blank_images_removed'")[0].n === 1);

  console.log("\n=== Finding orphaned images ===");
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "flat", flatPrice: 20, visible: true, images: [`${BASE}/uploads/acme/prod1.jpg`] });
  await lib.insertOrder(d1, { orderId: "O1", orgId: "acme", customerName: "C", contact: "c@x.com", placedAt: "2026-10-01T00:00:00Z" }, [{ productId: "tee", name: "Tee", type: "shirt", size: "", qty: 1, unitPrice: 20 }]);
  d1._raw.run("UPDATE order_items SET configJson=? WHERE orderId='O1'", [JSON.stringify({ locations: [{ imageUrl: `${BASE}/uploads/acme/gfx.png` }] })]);
  const old = "2026-09-01T00:00:00Z", now = Date.parse("2026-10-20T12:00:00Z"), fresh = "2026-10-20T06:00:00Z";
  const obj = (key, uploaded = old, size = 1000) => ({ key, uploaded: new Date(uploaded), size });
  const env = { IMAGES: bucket([obj("uploads/acme/prod1.jpg"), obj("uploads/acme/prod1-thumb.jpg"), obj("uploads/blanks/a.jpg"), obj("uploads/acme/gfx.png"),
    obj("uploads/acme/gone.jpg", old, 4000), obj("uploads/acme/gone-thumb.jpg", old, 500), obj("uploads/acme/new.jpg", fresh), obj("verify/abc.png", old, 2000)]), R2_PUBLIC_BASE: BASE };
  const found = await orphan.findOrphanImages(env, d1, { now });
  const keys = found.orphans.map(o => o.key);
  ok("files nothing points to are orphaned — including a verify upload whose record is gone", keys.includes("uploads/acme/gone.jpg") && keys.includes("verify/abc.png"));
  ok("…a -thumb copy goes with its main image", keys.includes("uploads/acme/gone-thumb.jpg") && found.orphans.find(o => o.key === "uploads/acme/gone-thumb.jpg").thumbOf === "uploads/acme/gone.jpg" && !keys.includes("uploads/acme/prod1-thumb.jpg"));
  ok("…in use anywhere is not: a product photo, a blank photo, an order line's snapshot", !keys.includes("uploads/acme/prod1.jpg") && !keys.includes("uploads/blanks/a.jpg") && !keys.includes("uploads/acme/gfx.png"));
  ok("…uploads from the last 24 hours are never called orphaned", !keys.includes("uploads/acme/new.jpg") && found.recent === 1);
  ok("…it reads every page of the bucket listing, and gives each file's public address and size", found.scanned === 8 && found.orphans.find(o => o.key === "verify/abc.png").url === `${BASE}/verify/abc.png` && found.totalBytes === 6500);
  // Deleting: re-checked on the server.
  d1._raw.run("UPDATE products SET imagesJson=? WHERE productId='tee'", [JSON.stringify([`${BASE}/uploads/acme/prod1.jpg`, `${BASE}/uploads/acme/gone.jpg`])]);
  const del = await orphan.deleteOrphanImages(env, d1, ["uploads/acme/gone.jpg", "verify/abc.png", "uploads/acme/new.jpg", "uploads/acme/nothere.jpg", "../etc/passwd"], { now });
  ok("deleting re-checks each file: one back in use is kept", del.kept.some(k => k.key === "uploads/acme/gone.jpg" && k.why === "in use again") && env.IMAGES._store.has("uploads/acme/gone.jpg"));
  ok("…a recent upload and a missing file are kept, a path trick is ignored", del.kept.some(k => k.key === "uploads/acme/new.jpg") && del.kept.some(k => k.key === "uploads/acme/nothere.jpg" && k.why === "already gone") && !del.kept.some(k => k.key.includes("..")));
  ok("…and the orphan is gone from storage", del.deleted.join() === "verify/abc.png" && !env.IMAGES._store.has("verify/abc.png"));
  r = await call({ action: "findOrphanImages" }, env);
  ok("the admin actions work", r.status === 200 && Array.isArray(r.body.orphans));
  env.IMAGES._store.set("uploads/acme/old2.jpg", obj("uploads/acme/old2.jpg"));
  r = await call({ action: "deleteOrphanImages", keys: ["uploads/acme/old2.jpg"] }, env);
  ok("…and a delete is audited", r.status === 200 && d1.q("SELECT count(*) n FROM audit_log WHERE action='images.orphans_deleted'")[0].n === 1);
  r = await call({ action: "findOrphanImages" }, {});
  ok("no image store → it says so", r.status === 400 && /isn't set up/.test(r.body.message));

  console.log("\n=== The windows ===");
  const adminJs = read("public/admin.js");
  const sent = [];
  class Ld extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const pageEnv = { IMAGES: bucket([obj("uploads/acme/x1.jpg", old, 3000), obj("uploads/acme/x1-thumb.jpg", old, 300), obj("uploads/acme/x2.jpg", old, 3000)]), R2_PUBLIC_BASE: BASE };
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new Ld(), url: "https://admin.example.com/#inventory", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.TextEncoder = TextEncoder; win.Blob = Blob; win.HTMLAnchorElement.prototype.click = function(){ (win.__downloads = win.__downloads || []).push(this.download); }; win.CSS = win.CSS || { escape: (x) => String(x) }; win.URL.createObjectURL = () => "blob:zip"; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b); const x = await call(b, pageEnv); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      if (String(url).includes("/api/image-proxy")) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, blob: async () => { throw new Error("no blob"); } };
      return { ok: false, status: 404, json: async () => ({ status: "error" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie";');
  // The grouping rule: originals only, by address, by file, by look.
  // 32×32 greyscale copies. A re-saved copy differs by ~1 level; a front vs back flat photo of the same garment by ~3–4
  // (measured on the shop's own photos) — close, but not the same picture.
  const pic = Array.from({ length: 1024 }, (_, i) => 60 + (i * 37) % 190), near = pic.map(v => v + 1), frontBack = pic.map((v, i) => v + (i % 2 ? 7 : -1)), other = pic.map((v, i) => (i * 91 + 40) % 255);
  const g = w.duplicatesInColor_([{ i: 0, url: "a", sha: "1", look: pic }, { i: 1, url: "a", sha: "", look: null }, { i: 2, url: "b", sha: "1", look: null }, { i: 3, url: "c", sha: "2", look: near }, { i: 4, url: "d", sha: "3", look: other }]);
  ok("…the look test: a re-saved copy matches; a front vs back that's ~3–4 levels apart doesn't; a different picture doesn't", w.looksSame_(pic, near) && !w.looksSame_(pic, frontBack) && !w.looksSame_(pic, other));
  const tagged = w.duplicatesInColor_([{ i: 0, url: "f", sha: "1", look: pic, loc: 1 }, { i: 1, url: "b", sha: "2", look: near, loc: 2 }, { i: 2, url: "g", sha: "3", look: near, loc: 1 }, { i: 3, url: "h", sha: "1", look: other, loc: 2 }]);
  ok("…a photo tagged Back is never the 'same look' as one tagged Front — but the same file under either tag still is", tagged[1].of === -1 && tagged[2].of === 0 && tagged[2].why === "looks the same" && tagged[3].of === 0 && tagged[3].why === "same file");
  ok("duplicates: the same address, the same file, a near-identical look; a different photo stays", g[1].of === 0 && g[1].why === "same address" && g[2].of === 0 && g[2].why === "same file" && g[3].of === 0 && g[3].why === "looks the same" && g[4].of === -1 && g[0].of === -1);
  // Blanks → Find duplicate photos, end to end.
  w._blanksAll = [{ id: blankId, name: "Gildan Tee", vendor: "SanMar", sku: "G1", colors: [{ color: "Black", images: [{ url: u("a") }, { url: u("a") }, { url: u("q") }] }, { color: "Navy", images: [{ url: u("n") }] }] }];
  d1._raw.run("UPDATE blank_colors SET imagesJson=? WHERE blankId=? AND color='Black'", [JSON.stringify([{ url: u("a") }, { url: u("a") }, { url: u("q") }]), blankId]);
  let refreshed = false;
  w.findDuplicateBlankPhotos_(() => { refreshed = true; });
  await wait(() => d.getElementById("dpRemove"));
  const picks = [...d.querySelectorAll(".dpPick")];
  ok("the window lists the blank's photos by color, a tick box under each — the copy ticked, the first kept", picks.length === 3 && picks.filter(x => x.checked).length === 1 && picks.find(x => x.checked).dataset.index === "1" && /Black/.test(d.getElementById("dpList").textContent) && !/Navy/.test(d.getElementById("dpList").textContent));
  ok("…with Remove duplicates (count) and Cancel", /Remove duplicates \(1\)/.test(d.getElementById("dpRemove").textContent) && !!d.getElementById("dpCancel"));
  d.getElementById("dpRemove").click();
  await wait(() => refreshed);
  ok("Remove duplicates takes the ticked copy off the blank", sent.some(b => b.action === "removeBlankImages") && (await colorImgs("Black")).join() === [u("a"), u("q")].join() && refreshed);
  // Tools → Orphaned images.
  ok("Tools has Orphaned images (admin only)", /\["orphans", "Orphaned images"\]/.test(adminJs) && w.adminPageRole_("orphans") === "admin");
  await w.renderOrphanImages(d.getElementById("app"));
  d.getElementById("orScan").click();
  await wait(() => d.querySelectorAll(".orPick").length);
  const rows = [...d.querySelectorAll(".orPick")];
  ok("the page lists the orphans, the -thumb riding with its main image, all ticked", rows.length === 2 && rows.every(x => x.checked) && rows.find(x => x.dataset.key === "uploads/acme/x1.jpg").dataset.thumb === "uploads/acme/x1-thumb.jpg");
  d.getElementById("orZip").click();
  await wait(() => /Downloaded/.test(d.getElementById("orStatus").textContent));
  ok("Download selected builds one .zip of them and saves it", /Downloaded 2 images/.test(d.getElementById("orStatus").textContent) && /^orphaned-images-\d{4}-\d\d-\d\d\.zip$/.test((w.__downloads || [])[0] || ""));
  rows[1].checked = false;
  d.getElementById("orDelete").click();
  await wait(() => d.querySelectorAll(".orPick").length === 1 || /No orphaned/.test(d.getElementById("orBody").textContent));
  ok("Remove selected deletes the ticked image and its thumbnail from storage, then re-scans", !pageEnv.IMAGES._store.has("uploads/acme/x1.jpg") && !pageEnv.IMAGES._store.has("uploads/acme/x1-thumb.jpg") && pageEnv.IMAGES._store.has("uploads/acme/x2.jpg") && d.querySelectorAll(".orPick").length === 1);
  // The .zip is a real one: Python's zipfile reads it back.
  const zip = w.makeZip_([{ name: "uploads/acme/one.jpg", bytes: new w.Uint8Array([1, 2, 3, 4]) }, { name: "verify/two.png", bytes: new w.Uint8Array([9, 8, 7]) }]);
  const buf = Buffer.from(await new Response(zip).arrayBuffer());
  const tmp = path.join(os.tmpdir(), "t136-" + process.pid + ".zip");
  fs.writeFileSync(tmp, buf);
  let listed = "";
  try { listed = execFileSync("python3", ["-I", "-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip() or 'ok', ','.join(z.namelist()), z.read('uploads/acme/one.jpg').hex())", tmp]).toString().trim(); } catch (e) { listed = "error " + e.message; }
  fs.unlinkSync(tmp);
  ok("the .zip opens with every file and its bytes intact (checked with Python's zipfile)", listed === "ok uploads/acme/one.jpg,verify/two.png 01020304");

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test146 crashed: false"); process.exit(1); });
