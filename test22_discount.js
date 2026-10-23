const { JSDOM } = require("jsdom");
const fs = require("fs");

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

function makeStorageMock(){ const s={}; return { async set(k,v,sh){s[k]=v;return{k,v,sh};} }; }

function mockCatalogFetch(win){
  return async (url) => {
    const res = await REAL_CATALOG_RESPONSE({ request: { url: win.location.origin + url }, env: { STRIPE_SECRET_KEY: "sk_test_fake" } });
    return { ok: true, json: async () => JSON.parse(await res.text()), text: async () => (await res.text()) };
  };
}

// ---- Client-side: test with discount ON (=2) ----
let htmlOn = fs.readFileSync(__dirname + "/public/index.html", "utf8")
  .replace("const CASH_DISCOUNT_PERCENT = 0;", "const CASH_DISCOUNT_PERCENT = 2;");

// ---- Client-side: test with discount OFF (=0) ----
let htmlOff = fs.readFileSync(__dirname + "/public/index.html", "utf8");

(async () => {
  // ---- DISCOUNT ON ----
  const domOn = new JSDOM(htmlOn, {
    runScripts:"dangerously", resources:"usable",
    url:"https://league101.example.com/x.html", pretendToBeVisual:true,
    beforeParse(win){ win.fetch = mockCatalogFetch(win); win.storage = makeStorageMock(); }
  });
  const wOn = domOn.window;
  await new Promise(r=>setTimeout(r,100));

  console.log("=== CASH_DISCOUNT_PERCENT = 2: hint shows discount for Zelle ===");
  // Re-query each time — renderTicket replaces these DOM elements on every render
  const getSelectOn = () => wOn.document.getElementById("custPaymentMethod");
  const getHintOn = () => wOn.document.getElementById("paymentHint");
  getSelectOn().value = "Zelle";
  getSelectOn().dispatchEvent(new wOn.Event("change",{bubbles:true}));
  console.log("Hint contains '2% discount':", getHintOn().textContent.includes("2% discount"));

  console.log("Hint shows discount for Check:");
  getSelectOn().value = "Check";
  getSelectOn().dispatchEvent(new wOn.Event("change",{bubbles:true}));
  console.log("  Check hint has discount note:", getHintOn().textContent.includes("2% discount"));

  console.log("Hint does NOT show discount for Venmo:");
  getSelectOn().value = "Venmo";
  getSelectOn().dispatchEvent(new wOn.Event("change",{bubbles:true}));
  console.log("  Venmo hint has no discount:", !getHintOn().textContent.includes("discount"));

  console.log("Hint does NOT show discount for Card:");
  getSelectOn().value = "Card";
  getSelectOn().dispatchEvent(new wOn.Event("change",{bubbles:true}));
  console.log("  Card hint has no discount:", !getHintOn().textContent.includes("discount"));

  console.log("\n=== CASH_DISCOUNT_PERCENT = 2: confirmation screen shows discount block ===");
  // Place a Zelle order and check the confirmation screen
  wOn.go("org","league-101");
  await new Promise(r=>setTimeout(r,80));
  wOn.document.getElementById("size-A").value = "M";
  wOn.addToCart("A");
  await new Promise(r=>setTimeout(r,10));
  wOn.document.getElementById("custName").value = "Aaron";
  wOn.document.getElementById("custContact").value = "a@example.com";
  wOn.document.getElementById("custPaymentMethod").value = "Zelle";
  await wOn.placeOrder("league-101");
  await new Promise(r=>setTimeout(r,50));
  const appHtmlZelle = wOn.document.getElementById("app").innerHTML;
  console.log("Zelle confirmation shows pi-discount block:", appHtmlZelle.includes("pi-discount"));
  console.log("Zelle confirmation mentions 2% discount:", appHtmlZelle.includes("2%"));

  // Check order
  wOn.go("org","league-101");
  await new Promise(r=>setTimeout(r,80));
  wOn.document.getElementById("size-A").value = "M";
  wOn.addToCart("A");
  await new Promise(r=>setTimeout(r,10));
  wOn.document.getElementById("custName").value = "Aaron";
  wOn.document.getElementById("custContact").value = "a@example.com";
  wOn.document.getElementById("custPaymentMethod").value = "Check";
  await wOn.placeOrder("league-101");
  await new Promise(r=>setTimeout(r,50));
  const appHtmlCheck = wOn.document.getElementById("app").innerHTML;
  console.log("Check confirmation shows discount:", appHtmlCheck.includes("2%"));

  // ---- DISCOUNT OFF ----
  console.log("\n=== CASH_DISCOUNT_PERCENT = 0: no discount mention anywhere ===");
  const domOff = new JSDOM(htmlOff, {
    runScripts:"dangerously", resources:"usable",
    url:"https://league101.example.com/y.html", pretendToBeVisual:true,
    beforeParse(win){ win.fetch = mockCatalogFetch(win); win.storage = makeStorageMock(); }
  });
  const wOff = domOff.window;
  await new Promise(r=>setTimeout(r,100));
  const selectOff = wOff.document.getElementById("custPaymentMethod");
  const hintOff = wOff.document.getElementById("paymentHint");
  selectOff.value = "Zelle";
  selectOff.dispatchEvent(new wOff.Event("change",{bubbles:true}));
  console.log("Zelle hint has no discount when off:", !hintOff.textContent.includes("discount"));
  selectOff.value = "Check";
  selectOff.dispatchEvent(new wOff.Event("change",{bubbles:true}));
  console.log("Check hint has no discount when off:", !hintOff.textContent.includes("discount"));

})();
