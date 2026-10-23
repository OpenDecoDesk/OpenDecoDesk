const { JSDOM, ResourceLoader } = require("jsdom");
const fs = require("fs");

// index.html lazily loads admin.js via a real <script src="admin.js">
// tag instead of shipping the admin panel inline — a
// custom ResourceLoader intercepts that one request and serves the real
// file, so window.loadAdminScript() resolves in jsdom exactly like it
// would in a browser, instead of hitting the real network.
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

// simple in-memory storage mock mimicking window.storage API
function makeStorageMock(){
  const store = {};
  return {
    async set(key, value, shared){ store[key] = value; return {key, value, shared}; },
    async get(key, shared){ if(!(key in store)) throw new Error("not found"); return {key, value: store[key], shared}; },
    async delete(key, shared){ delete store[key]; return {key, deleted:true, shared}; },
    async list(prefix, shared){ return {keys: Object.keys(store).filter(k=>!prefix || k.startsWith(prefix)), prefix, shared}; }
  };
}

// Fake session token returned by the /api/admin-session mock below.
const FAKE_SESSION_TOKEN = "cookie"; // the real session is an HttpOnly cookie; admin.js only ever holds this marker

function makeOrdersFetchMock(win, adminPassphrase, fakeSheetRows){
  return async (url, opts) => {
    if(url.startsWith("/api/catalog")){
      const res = await REAL_CATALOG_RESPONSE({ request: { url: win.location.origin + url }, env: { STRIPE_SECRET_KEY: "sk_test_fake" } });
      return { ok: true, json: async () => JSON.parse(await res.text()), text: async () => (await res.text()) };
    }
    if(url.startsWith("/api/admin-session")){
      const body = JSON.parse(opts.body);
      if(body.key !== adminPassphrase) return { ok: true, json: async () => ({status:"error", message:"Unauthorized"}) };
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

(async () => {
  console.log("=== Test 1: Root domain shows the generic company page, no org names ===");
  const ADMIN_PASSPHRASE = "test-passphrase";
  const domRoot = new JSDOM(html, {
    runScripts: "dangerously", resources: new AdminResourceLoader(),
    url: "https://example.com/index.html", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = makeOrdersFetchMock(win, ADMIN_PASSPHRASE, []);
      win.storage = makeStorageMock();
    }
  });
  await new Promise(r => setTimeout(r, 100));
  const rootHtml = domRoot.window.document.getElementById("app").innerHTML;
  console.log("Shows generic company page:", rootHtml.includes("Our shop"));
  console.log("Does NOT list any client org names:", !rootHtml.includes("Example League") && !rootHtml.includes("Second League"));

  console.log("\n=== Test 2-6: Locked subdomain (league101.example.com) — full order flow ===");
  let fakeSheetRows = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", resources: new AdminResourceLoader(),
    url: "https://league101.example.com/index.html", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = makeOrdersFetchMock(win, ADMIN_PASSPHRASE, fakeSheetRows);
      win.storage = makeStorageMock();
    }
  });
  const { window } = dom;

  await new Promise(r => setTimeout(r, 100));

  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.error ? e.error.stack || e.message : e.message));

  const orgHtml = window.document.getElementById("app").innerHTML;
  console.log("Locked straight to Example League (no navigation needed):", orgHtml.includes("Example League 101"));
  console.log("Has product options A/B/C:", orgHtml.includes("Option A") && orgHtml.includes("Option B") && orgHtml.includes("Option C"));
  console.log("Has cap option D:", orgHtml.includes("Option D"));

  console.log("\n=== Test 3: Cart math ===");
  const sizeSelC = window.document.getElementById("size-C");
  sizeSelC.value = "L";
  window.addToCart("C"); // shirt option C, size L, qty1 -> should be $27
  const qtyD = window.document.getElementById("qty-D");
  qtyD.value = "1";
  window.addToCart("D"); // cap -> $16
  await new Promise(r=>setTimeout(r,20));
  console.log("Cart:", JSON.stringify(cartDump(window)));

  const ticketHtml = window.document.getElementById("ticketPanel").innerHTML;
  const totalMatch = ticketHtml.match(/t-amount">\$([\d.]+)</);
  console.log("Displayed total:", totalMatch ? totalMatch[1] : "NOT FOUND");

  console.log("\n=== Test 4: Place an order ===");
  window.document.getElementById("custName").value = "Alex Sample";
  window.document.getElementById("custContact").value = "aaron@example.com";
  const pmSelTest = window.document.getElementById("custPaymentMethod");
  if(pmSelTest) pmSelTest.value = "Zelle";
  await window.placeOrder("league-101");
  await new Promise(r=>setTimeout(r,50));
  console.log("Confirmation shown:", window.document.getElementById("app").innerHTML.includes("Order received"));

  console.log("\n=== Test 5: Admin view shows the order (picker -> shop -> orders) ===");
  // admin.js is lazily loaded — load it explicitly here
  // since this test calls renderAdminPicker() directly rather than going
  // through render()'s route:"admin" branch, which would trigger the load
  // itself. Once loaded, renderAdminPicker() fires loadAdminOrgList()
  // without awaiting it, and that function's first await is
  // promptAdminPassphrase() — so by the time renderAdminPicker() itself
  // returns, the passphrase overlay is already in the DOM (the Promise
  // executor that builds/appends it runs synchronously). Fill it in and
  // submit like a real user would.
  await window.loadAdminScript();
  window.renderAdminPicker(window.document.getElementById("app"));
  window.document.getElementById("adminPassInput").value = ADMIN_PASSPHRASE;
  window.document.querySelector(".admin-pass-submit").click();
  await new Promise(r=>setTimeout(r,150));
  const pickerHtml = window.document.body.innerHTML;
  console.log("Org picker lists Example League:", pickerHtml.includes("Example League 101"));
  window.selectAdminOrg("league-101");
  await new Promise(r=>setTimeout(r,150));
  const adminHtml = window.document.getElementById("app").innerHTML;
  console.log("Admin shows order row (Alex Sample):", adminHtml.includes("Alex Sample"));
  // Order ID prefix is derived from orgId: first 4 alphanumeric chars uppercased.
  // For "league-101" → "LEAG"
  console.log("Admin shows LEAG- order id:", /LEAG-/.test(adminHtml));

  console.log("\n=== Test 6: Unready org (Example Club 404's own subdomain) shows coming soon ===");
  const domUnready = new JSDOM(html, {
    runScripts: "dangerously", resources: new AdminResourceLoader(),
    url: "https://club404.example.com/index.html", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = makeOrdersFetchMock(win, ADMIN_PASSPHRASE, []);
      win.storage = makeStorageMock();
    }
  });
  await new Promise(r=>setTimeout(r,100));
  console.log("Shows coming soon:", domUnready.window.document.getElementById("app").innerHTML.includes("Catalog coming soon"));

  console.log("\n=== JS runtime errors captured (locked subdomain window) ===");
  console.log(errors.length ? errors.join("\n---\n") : "NONE");

  function cartDump(win){
    // cart is a module-level `let`, not attached to window directly; grab via eval in window context
    return win.eval("cart");
  }
})();
