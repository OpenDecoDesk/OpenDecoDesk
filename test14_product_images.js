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
    async set(key, value, shared){ store[key] = value; return {key, value, shared}; },
    async list(prefix, shared){ return {keys: Object.keys(store).filter(k=>!prefix || k.startsWith(prefix)), prefix, shared}; }
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

  console.log("=== Option D (cap) shows its two real product images ===");
  const products = window.document.querySelectorAll(".product");
  const capCard = Array.from(products).find(p => p.innerHTML.includes("Option D"));
  const capImgs = capCard.querySelectorAll(".product-images img");
  console.log("Two images rendered for the cap:", capImgs.length === 2);
  console.log("Front image src correct:", Array.from(capImgs).some(i => i.src.includes("cap-d-front.jpg")));
  console.log("Back image src correct:", Array.from(capImgs).some(i => i.src.includes("cap-d-back.jpg")));
  console.log("Alt text present and descriptive:", capImgs[0].alt.includes("Option D"));

  console.log("\n=== Shirt options now also show their real product images ===");
  const shirtCardA = Array.from(products).find(p => p.innerHTML.includes("Option A"));
  const shirtCardB = Array.from(products).find(p => p.innerHTML.includes("Option B"));
  const shirtCardC = Array.from(products).find(p => p.innerHTML.includes("Option C"));
  console.log("Option A shows its own image:", shirtCardA.querySelector(".product-images img").src.includes("polo-a-front.jpg"));
  console.log("Option B shows its own image:", shirtCardB.querySelector(".product-images img").src.includes("polo-b-front.jpg"));
  console.log("Option C shows its own image:", shirtCardC.querySelector(".product-images img").src.includes("polo-c-front.jpg"));
  console.log("Each shirt shows exactly one image (not mixed with another option's):",
    shirtCardA.querySelectorAll(".product-images img").length === 1 &&
    shirtCardB.querySelectorAll(".product-images img").length === 1 &&
    shirtCardC.querySelectorAll(".product-images img").length === 1);

  console.log("\n=== Product images open full-size in a new tab when clicked ===");
  const capLink = capCard.querySelector(".product-images a");
  console.log("Image wrapped in a link:", !!capLink);
  console.log("Link href matches the image src (full-size, same file):", capLink.href.includes("cap-d-front.jpg"));
  console.log("Opens the in-page image viewer, not a new tab (zoom-link, no target):", capLink.classList.contains("zoom-link") && !capLink.target);

  console.log("\n=== Design preview images also open full-size in a new tab ===");
  const previewLink = window.document.querySelector(".design-preview-imgs a");
  console.log("Design preview image wrapped in a link:", !!previewLink);
  console.log("Opens the in-page viewer:", previewLink.classList.contains("zoom-link") && !previewLink.target);
  const allImgs = window.document.querySelectorAll("img");
  const withMissingSrc = Array.from(allImgs).filter(i => !i.getAttribute("src"));
  console.log("Every rendered <img> has a real src:", withMissingSrc.length === 0);
  console.log("Total images on page (3 design preview + 3 shirts + 2 cap):", allImgs.length === 8);
  console.log("\n=== Clicking a picture opens the near-full-screen viewer (arrows through all of the product's pictures) ===");
  const click = (el, init) => el.dispatchEvent(new window.MouseEvent("click", Object.assign({ bubbles: true, cancelable: true }, init || {})));
  const ev = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  capCard.querySelector(".product-images a").dispatchEvent(ev);
  const lb = window.document.querySelector(".lb-overlay");
  console.log("Click opens the viewer and is not left to navigate a new tab:", !!lb && ev.defaultPrevented);
  console.log("Viewer is a modal dialog showing the clicked full-size image:", lb.getAttribute("role") === "dialog" && lb.querySelector(".lb-img").src.includes("cap-d-front.jpg"));
  console.log("Counter shows 1 / 2:", lb.querySelector(".lb-count").textContent === "1 / 2");
  click(lb.querySelector(".lb-next"));
  console.log("Right arrow shows the next picture (back view):", lb.querySelector(".lb-img").src.includes("cap-d-back.jpg") && lb.querySelector(".lb-count").textContent === "2 / 2");
  click(lb.querySelector(".lb-next"));
  console.log("…and wraps around to the first:", lb.querySelector(".lb-img").src.includes("cap-d-front.jpg"));
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  console.log("Keyboard ArrowLeft goes back (wraps to last):", lb.querySelector(".lb-img").src.includes("cap-d-back.jpg"));
  click(lb);
  console.log("A click outside the picture does NOT close it:", lb.isConnected);
  click(lb.querySelector(".lb-close"));
  console.log("Close button closes it:", !lb.isConnected);
  capCard.querySelector(".product-images a").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  console.log("Escape closes it:", !window.document.querySelector(".lb-overlay"));
  console.log("Ctrl/Cmd/Shift-click is left to the browser (open in a new tab still works):", /e\.ctrlKey \|\| e\.metaKey \|\| e\.shiftKey/.test(html));
  const previewEv = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  window.document.querySelector(".design-preview-imgs a").dispatchEvent(previewEv);
  const lb2 = window.document.querySelector(".lb-overlay");
  console.log("The design-preview strip opens the viewer too, cycling its 3 pictures:", !!lb2 && lb2.querySelector(".lb-count").textContent === "1 / 3");
  lb2.querySelector(".lb-close").click();

  console.log("\n=== The viewer zooms in and out ===");
  capCard.querySelector(".product-images a").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const lz = window.document.querySelector(".lb-overlay");
  const zin = lz.querySelector(".lb-zoom-in"), zout = lz.querySelector(".lb-zoom-out"), zimg = lz.querySelector(".lb-img"), zlabel = lz.querySelector(".lb-zoom");
  // jsdom doesn't lay anything out: give the picture a fitted size of 400 x 300 whenever it has no inline size.
  zimg.getBoundingClientRect = () => (zimg.style.width ? { width: parseFloat(zimg.style.width), height: parseFloat(zimg.style.height) } : { width: 400, height: 300 });
  const key = (k) => window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  console.log("Zoom in and Zoom out buttons, labelled for screen readers:", zin.getAttribute("aria-label") === "Zoom in" && zout.getAttribute("aria-label") === "Zoom out");
  console.log("Opens fitted to the screen — nothing to zoom out of yet:", zout.disabled && !zin.disabled && zlabel.textContent === "" && !lz.classList.contains("lb-zoomed") && !zimg.style.width);
  click(zin);
  console.log("Zoom in draws the picture 1.5x its fitted size and says 150%:", zimg.style.width === "600px" && zimg.style.height === "450px" && zlabel.textContent === "150%" && lz.classList.contains("lb-zoomed") && !zout.disabled);
  click(zin);
  console.log("Each step is measured from the fitted size, not the last zoom (2x = 800px, not 900):", zimg.style.width === "800px" && zlabel.textContent === "200%");
  click(zin); click(zin);
  console.log("It stops at 400% and the + button turns off:", zimg.style.width === "1600px" && zlabel.textContent === "400%" && zin.disabled);
  click(zin);
  console.log("...and clicking past the limit does nothing:", zimg.style.width === "1600px");
  click(zout);
  console.log("Zoom out steps back down (300%):", zimg.style.width === "1200px" && zlabel.textContent === "300%" && !zin.disabled);
  key("0");
  console.log("The 0 key returns to fit:", !zimg.style.width && !zimg.style.maxWidth && zlabel.textContent === "" && !lz.classList.contains("lb-zoomed") && zout.disabled);
  key("+");
  console.log("The + key zooms in:", zlabel.textContent === "150%");
  key("="); key("-");
  console.log("= (unshifted +) zooms in and - zooms out:", zlabel.textContent === "150%");
  const cur = zimg.src;
  const touch = (type, x) => { const e = new window.Event(type, { bubbles: true }); e.touches = type === "touchstart" ? [{ clientX: x }] : []; e.changedTouches = [{ clientX: x }]; lz.dispatchEvent(e); };
  touch("touchstart", 300); touch("touchend", 100);
  console.log("While zoomed, a finger moves the picture — a swipe does NOT change picture:", zimg.src === cur && zlabel.textContent === "150%");
  click(lz.querySelector(".lb-next"));
  console.log("Going to the next picture returns to fit:", zimg.src !== cur && zlabel.textContent === "" && !zimg.style.width && zout.disabled);
  const cur2 = zimg.src;
  touch("touchstart", 300); touch("touchend", 100);
  console.log("At fit, a swipe still changes picture:", zimg.src !== cur2);
  zin.focus(); click(zin); click(zin); click(zin); click(zin);
  console.log("When + reaches its limit while focused, focus moves to - (not lost):", zin.disabled && window.document.activeElement === zout);
  key("Tab"); key("Tab"); key("Tab"); key("Tab");
  console.log("Tab stays inside the viewer and skips the turned-off button:", lz.contains(window.document.activeElement) && window.document.activeElement !== zin);
  click(lz.querySelector(".lb-close"));
  console.log("Still closes from the Close button:", !lz.isConnected);
})();
