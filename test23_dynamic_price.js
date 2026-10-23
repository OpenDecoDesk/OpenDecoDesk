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

// Enable discount so we can test the discounted total
let html = fs.readFileSync(__dirname + "/public/index.html", "utf8")
  .replace("const CASH_DISCOUNT_PERCENT = 0;", "const CASH_DISCOUNT_PERCENT = 2;");

(async () => {
  const dom = new JSDOM(html, {
    runScripts:"dangerously", resources:"usable",
    url:"https://league101.example.com/x.html", pretendToBeVisual:true,
    beforeParse(win){ win.fetch = mockCatalogFetch(win); win.storage = makeStorageMock(); }
  });
  const { window } = dom;
  await new Promise(r=>setTimeout(r,100));

  // ---- Dynamic product price on size change ----
  console.log("=== Product price updates when size changes ===");
  const sizeSelectA = window.document.getElementById("size-A");
  const priceA = window.document.getElementById("price-A");

  // Default size (XS = $23)
  // Sizes priced differently: "from" the lowest until a size is picked.
  console.log("Default price shown as 'from $23.00' (sizes priced differently):", priceA.textContent === "from $23.00");

  // Change to 2XL ($24)
  sizeSelectA.value = "2XL";
  sizeSelectA.dispatchEvent(new window.Event("change", { bubbles:true }));
  console.log("Price updates to $24.00 for 2XL:", priceA.textContent === "$24.00");

  // Change to 3XL ($26)
  sizeSelectA.value = "3XL";
  sizeSelectA.dispatchEvent(new window.Event("change", { bubbles:true }));
  console.log("Price updates to $26.00 for 3XL:", priceA.textContent === "$26.00");

  // Change back to L ($23)
  sizeSelectA.value = "L";
  sizeSelectA.dispatchEvent(new window.Event("change", { bubbles:true }));
  console.log("Price reverts to $23.00 for L:", priceA.textContent === "$23.00");

  // Cap has no size, no price-D to update
  const priceD = window.document.getElementById("price-D");
  console.log("Cap price is flat $16.00 (no size select):", priceD.textContent === "$16.00");

  // ---- Discount total on payment method change ----
  console.log("\n=== Ticket total reflects discount when Zelle/Check selected ===");
  // Add an item first so the total is non-zero
  sizeSelectA.value = "L"; // $23
  window.addToCart("A");
  await new Promise(r=>setTimeout(r,20));

  const getTotalText = () => {
    const el = window.document.querySelector(".ticket-total");
    return el ? el.innerHTML : "";
  };

  // No payment method — full price
  // Re-query each time — renderTicket replaces the select DOM element on every render
  const gp = () => window.document.getElementById("custPaymentMethod");

  gp().value = "";
  gp().dispatchEvent(new window.Event("change", { bubbles:true }));
  await new Promise(r=>setTimeout(r,20));
  console.log("No payment selected — full $23.00 shown:", getTotalText().includes("$23.00") && !getTotalText().includes("line-through"));

  // Select Zelle — should show 2% discount ($23 * 0.98 = $22.54)
  gp().value = "Zelle";
  gp().dispatchEvent(new window.Event("change", { bubbles:true }));
  await new Promise(r=>setTimeout(r,20));
  const zelleHtml = getTotalText();
  console.log("Zelle shows discounted total ($22.54):", zelleHtml.includes("$22.54"));
  console.log("Zelle also shows strikethrough original ($23.00):", zelleHtml.includes("line-through") && zelleHtml.includes("$23.00"));

  // Select Check — same discount
  gp().value = "Check";
  gp().dispatchEvent(new window.Event("change", { bubbles:true }));
  await new Promise(r=>setTimeout(r,20));
  console.log("Check shows same discounted total:", getTotalText().includes("$22.54"));

  // Select Venmo — back to full price
  gp().value = "Venmo";
  gp().dispatchEvent(new window.Event("change", { bubbles:true }));
  await new Promise(r=>setTimeout(r,20));
  const venmoHtml = getTotalText();
  console.log("Venmo shows full price $23.00:", venmoHtml.includes("$23.00") && !venmoHtml.includes("line-through"));

  // Select Card — full price
  gp().value = "Card";
  gp().dispatchEvent(new window.Event("change", { bubbles:true }));
  await new Promise(r=>setTimeout(r,20));
  console.log("Card shows full price $23.00:", getTotalText().includes("$23.00") && !getTotalText().includes("line-through"));

  // ---- Discount label visible in ticket ----
  gp().value = "Zelle";
  gp().dispatchEvent(new window.Event("change", { bubbles:true }));
  await new Promise(r=>setTimeout(r,20));
  const ticketHtml = getTotalText();
  console.log("\nDiscount % label shown in ticket:", ticketHtml.includes("2% discount applied"));
})();

// ---- Personalization price tests ----
;(async () => {
  const { JSDOM } = require("jsdom");
  const fs = require("fs");
  const html = fs.readFileSync(__dirname + "/public/index.html", "utf8");
  const dom = new JSDOM(html, {
    runScripts:"dangerously", resources:"usable",
    url:"https://league101.example.com/z.html", pretendToBeVisual:true,
    beforeParse(win){ win.fetch = mockCatalogFetch(win); win.storage = { async set(){} }; }
  });
  const { window } = dom;
  await new Promise(r=>setTimeout(r,100));

  console.log("\n=== Personalization checkbox adds $2 to displayed price ===");
  const priceA = window.document.getElementById("price-A");
  const persA  = window.document.getElementById("pers-A");
  const sizeA  = window.document.getElementById("size-A");

  // Baseline L = $23
  sizeA.value = "L";
  sizeA.dispatchEvent(new window.Event("change",{bubbles:true}));
  console.log("Base price L = $23.00:", priceA.textContent === "$23.00");

  // Check personalization — should add $2
  persA.checked = true;
  persA.dispatchEvent(new window.Event("change",{bubbles:true}));
  console.log("With personalization = $25.00 ($23 + $2):", priceA.textContent === "$25.00");

  // Change size to 2XL ($24 + $2 = $26)
  sizeA.value = "2XL";
  sizeA.dispatchEvent(new window.Event("change",{bubbles:true}));
  console.log("2XL + personalization = $26.00 ($24 + $2):", priceA.textContent === "$26.00");

  // Uncheck personalization — back to base 2XL price ($24)
  persA.checked = false;
  persA.dispatchEvent(new window.Event("change",{bubbles:true}));
  console.log("Uncheck personalization reverts to $24.00:", priceA.textContent === "$24.00");

  // Cap also gets personalization fee
  console.log("\n=== Cap has no personalization checkbox (disabled, personalizationPrice: null) ===");
  const persD = window.document.getElementById("pers-D");
  const priceD = window.document.getElementById("price-D");
  console.log("Cap D has no personalization checkbox:", persD === null);
  console.log("Cap price stays flat $16.00 regardless:", priceD.textContent === "$16.00");
})();
