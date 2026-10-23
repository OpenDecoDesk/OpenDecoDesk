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

const html = fs.readFileSync(__dirname + "/public/index.html", "utf8");

function makeStorageMock(){
  const store = {};
  return {
    async set(key, value, shared){ store[key] = value; return {key, value, shared}; }
  };
}

(async () => {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", resources: "usable",
    url: "https://league101.example.com/x.html", pretendToBeVisual:true,
    beforeParse(win){
      win.fetch = async (url) => {
        const res = await REAL_CATALOG_RESPONSE({ request: { url: win.location.origin + url }, env: { STRIPE_SECRET_KEY: "sk_test_fake" } });
        return { ok: true, json: async () => JSON.parse(await res.text()), text: async () => (await res.text()) };
      };
      win.storage = makeStorageMock();
    }
  });
  const { window } = dom;
  await new Promise(r=>setTimeout(r,100));

  console.log("=== thumbUrl() maps correctly ===");
  console.log("PNG -> thumbs/*.jpg:", window.thumbUrl("images/design-detail.png") === "images/thumbs/design-detail.jpg");
  console.log("JPG -> thumbs/*.jpg:", window.thumbUrl("images/polo-a-front.jpg") === "images/thumbs/polo-a-front.jpg");

  console.log("\n=== Product images: displayed img is the THUMBNAIL, link is the FULL-SIZE original ===");
  const products = window.document.querySelectorAll(".product");
  const capCard = Array.from(products).find(p => p.innerHTML.includes("Option D"));
  const capLink = capCard.querySelector(".product-images a");
  const capImg = capCard.querySelector(".product-images img");
  console.log("Displayed <img> src points into /thumbs/:", capImg.src.includes("/thumbs/"));
  console.log("Link href points to the ORIGINAL (not thumbs):", !capLink.href.includes("/thumbs/"));
  console.log("They are genuinely different URLs:", capImg.src !== capLink.href);
  console.log("Both reference the same underlying file (cap-d-front):",
    capImg.src.includes("cap-d-front") && capLink.href.includes("cap-d-front"));

  console.log("\n=== Design preview images follow the same thumb/full split ===");
  const previewLink = window.document.querySelector(".design-preview-imgs a");
  const previewImg = window.document.querySelector(".design-preview-imgs img");
  console.log("Displayed <img> is a thumbnail:", previewImg.src.includes("/thumbs/"));
  console.log("Link opens the full-size original:", !previewLink.href.includes("/thumbs/"));
})();
