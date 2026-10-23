const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");

// Product pictures: the storefront shows the product's OWN images first (in the order set on the
// product), then the linked blank's photos for the chosen color — the blank's photos never replace
// them. The product form manages its images as thumbnail tiles that can be reordered and removed, and
// lists the blank's photos underneath, read-only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const html = read("public/index.html"), adminJs = read("public/admin.js");
const ok = (m, c) => console.log(m + ":", !!c);

(async () => {
  console.log("=== Storefront: product images first, then the blank's ===");
  const cat = { status: "ok", orgId: "o1", catalog: { name: "League", eyebrow: "", accent: "#123456", ready: true, desc: "", designImages: { shirt: "", cap: "", detail: "" },
    enabledPayments: ["check"], salesTaxRate: 0, graphics: [{ id: 1, name: "Logo", kind: "transfer", imageUrl: "", thumbUrl: "", addOnCents: 0, inkColors: [], allowedLocations: [], allowedGarmentColors: [] }],
    products: [
      { id: "both", type: "shirt", name: "Both", sub: "", features: [], sizePricing: { M: 20 }, images: ["images/own-1.jpg", "images/own-2.jpg"], colorImages: { "": ["images/blank-a.jpg", "images/own-2.jpg"] } },
      { id: "blankonly", type: "shirt", name: "Blank only", sub: "", features: [], sizePricing: { M: 20 }, images: [], colorImages: { "": ["images/blank-b.jpg"] } },
      { id: "ownonly", type: "shirt", name: "Own only", sub: "", features: [], sizePricing: { M: 20 }, images: ["images/own-3.jpg"] },
      { id: "cfg", type: "shirt", name: "Configurable", sub: "", features: [], sizePricing: { M: 20 }, configurable: true, garmentColors: ["Navy", "Black"], images: ["images/own-c.jpg"],
        colorImages: { Navy: ["images/navy-1.jpg", "images/navy-2.jpg"], Black: ["images/black-1.jpg"] }, locations: [{ key: "front", label: "Front", locationId: 1, graphicIds: [1] }] },
    ] } };
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "https://league.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => cat, text: async () => JSON.stringify(cat) }); } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 200));
  const card = (name) => [...d.querySelectorAll(".product")].find(p => p.querySelector("h3").textContent === name);
  const srcs = (name) => [...card(name).querySelectorAll(".product-images a")].map(a => a.getAttribute("href"));
  ok("a product with its own images and blank photos shows its own first, then the blank's", srcs("Both").join("|") === "images/own-1.jpg|images/own-2.jpg|images/blank-a.jpg");
  ok("…and a picture that is in both lists appears once", srcs("Both").filter(s => s === "images/own-2.jpg").length === 1);
  ok("a product with no images of its own still shows the blank's", srcs("Blank only").join("|") === "images/blank-b.jpg");
  ok("a product with no blank photos shows just its own", srcs("Own only").join("|") === "images/own-3.jpg");
  ok("a configurable product: its own image first, then the first color's blank photos", srcs("Configurable").join("|") === "images/own-c.jpg|images/navy-1.jpg|images/navy-2.jpg");
  [...card("Configurable").querySelectorAll(".cfg-swatch")].find(b => b.dataset.color === "Black").click();
  ok("picking another color swaps only the blank's part", srcs("Configurable").join("|") === "images/own-c.jpg|images/black-1.jpg");
  ok("the order of the product's own images is kept", w.productImages_({ images: ["b", "a", "c"], colorImages: { "": ["z"] } }, "").join("") === "bacz");
  // The zoom viewer walks the same list.
  card("Both").querySelector(".product-images a").dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  ok("the zoom viewer cycles the same pictures in the same order", d.querySelector(".lb-count").textContent === "1 / 3" && d.querySelector(".lb-img").src.includes("own-1.jpg"));
  d.querySelector(".lb-close").click();

  console.log("\n=== Product form: image tiles ===");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const adom = new JSDOM(html, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "admin" }) }); } });
  const aw = adom.window, ad = aw.document;
  await new Promise(res => setTimeout(res, 150));
  await aw.loadAdminScript();
  ad.getElementById("app").innerHTML = `<div id="prodImgTiles"></div><input type="file" id="prodImgUpload" multiple><input type="text" id="prodImgUrl"><button type="button" id="prodImgAddUrl"></button>
    <div id="prodImgStatus"></div><textarea id="prodFormImages"></textarea><div id="prodBlankImages"></div>`;
  aw.initProductImagesField_("league", ["images/a.jpg", "images/b.jpg", "images/c.jpg"]);
  const tiles = () => [...ad.querySelectorAll("#prodImgTiles [data-tile]")];
  const order = () => ad.getElementById("prodFormImages").value.split("\n").join("|");
  const btn = (act, i) => ad.querySelector(`#prodImgTiles button[data-act="${act}"][data-i="${i}"]`);
  ok("one thumbnail tile per image, in order, mirrored into what Save reads", tiles().length === 3 && order() === "images/a.jpg|images/b.jpg|images/c.jpg" &&
    tiles().every(t => t.querySelector("img") && t.getAttribute("draggable") === "true"));
  ok("thumbnails use the small image variant", /images\/thumbs\//.test(tiles()[0].querySelector("img").getAttribute("src")));
  ok("the first can't move earlier and the last can't move later", btn("left", 0).disabled && btn("right", 2).disabled && !btn("right", 0).disabled && !btn("left", 2).disabled);
  btn("right", 0).click();
  ok("▶ moves an image later", order() === "images/b.jpg|images/a.jpg|images/c.jpg");
  btn("left", 2).click();
  ok("◀ moves an image earlier", order() === "images/b.jpg|images/c.jpg|images/a.jpg");
  // Drag the third tile onto the first.
  const drag = (from, to) => {
    const dt = { effectAllowed: "", dropEffect: "", setData(){} };
    const fire = (el, type) => { const e = new aw.Event(type, { bubbles: true, cancelable: true }); e.dataTransfer = dt; el.dispatchEvent(e); return e; };
    fire(tiles()[from], "dragstart"); const over = fire(tiles()[to], "dragover"); fire(tiles()[to], "drop"); return over;
  };
  const over = drag(2, 0);
  ok("dragging a tile onto another reorders (and the drop target accepts it)", order() === "images/a.jpg|images/b.jpg|images/c.jpg" && over.defaultPrevented);
  btn("rm", 1).click();
  ok("✕ removes an image", order() === "images/a.jpg|images/c.jpg" && tiles().length === 2);
  const urlEl = ad.getElementById("prodImgUrl"), status = () => ad.getElementById("prodImgStatus").textContent;
  urlEl.value = "javascript:alert(1)"; ad.getElementById("prodImgAddUrl").click();
  ok("an address that isn't an image URL is refused with a reason", order() === "images/a.jpg|images/c.jpg" && /isn't an image address/.test(status()));
  urlEl.value = "images/a.jpg"; ad.getElementById("prodImgAddUrl").click();
  ok("an image already in the list isn't added twice", tiles().length === 2 && /already in the list/.test(status()));
  urlEl.value = "https://img.example/x.png"; ad.getElementById("prodImgAddUrl").click();
  ok("a pasted https:// address is added at the end", order() === "images/a.jpg|images/c.jpg|https://img.example/x.png" && urlEl.value === "");
  // Upload several files at once.
  aw.eval(`uploadImage = async (file) => { if (file.name === "bad.png") throw new Error("Too large"); return "https://img.example/up/" + file.name; };`);
  const up = ad.getElementById("prodImgUpload");
  Object.defineProperty(up, "files", { value: [new aw.File(["x"], "one.png"), new aw.File(["x"], "bad.png"), new aw.File(["x"], "two.png")], configurable: true });
  await up.onchange();
  ok("several files upload in one go; a failed one is reported and the rest are kept", order().endsWith("https://img.example/up/one.png|https://img.example/up/two.png") && /2 uploaded, 1 failed/.test(status()));
  while (btn("rm", 0)) btn("rm", 0).click();
  ok("with no images the field says so and Save gets an empty list", tiles().length === 0 && ad.getElementById("prodFormImages").value === "" && /No product images yet/.test(ad.getElementById("prodImgTiles").textContent));

  console.log("\n=== Product form: the blank's photos, for reference ===");
  const product = { productId: "polo" };
  const blanks = [{ id: 7, name: "Sport-Tek Polo", colors: [{ color: "Navy", images: [{ url: "images/navy-1.jpg", locationId: 1 }, "images/navy-2.jpg"] }, { color: "Black", images: [] }, { color: "White", images: ["images/white.jpg"] }] }];
  const links = [{ productId: "polo", productColor: "Navy", productSize: "M", blankId: 7, blankColor: "Navy" }, { productId: "polo", productColor: "Navy", productSize: "L", blankId: 7, blankColor: "Navy" },
    { productId: "polo", productColor: "Black", productSize: "M", blankId: 7, blankColor: "Black" }, { productId: "other", productColor: "White", productSize: "M", blankId: 7, blankColor: "White" }];
  aw.drawProductBlankImages_(product, blanks, links);
  const bbox = ad.getElementById("prodBlankImages");
  const groups = [...bbox.querySelectorAll("[data-blank-color]")];
  ok("the linked blank's photos are shown per product color (both image shapes), once per color", groups.length === 1 && groups[0].dataset.blankColor === "Navy" && groups[0].querySelectorAll("img").length === 2);
  ok("only THIS product's links count, and a color with no photos isn't listed", !/White/.test(bbox.textContent) && !/Black/.test(bbox.textContent));
  ok("they can't be reordered or removed here (no buttons, not draggable) and say where to change them", bbox.querySelectorAll("button").length === 0 && !bbox.querySelector("[draggable='true']") && /can't be reordered here/.test(bbox.textContent) && /Inventory → Blanks/.test(bbox.textContent));
  ok("with no product images the field points at the blank's photos", /the storefront shows the blank's photos below/.test(ad.getElementById("prodImgTiles").textContent));
  aw.drawProductBlankImages_(product, blanks, [{ productId: "polo", productColor: "Black", productSize: "M", blankId: 7, blankColor: "Black" }]);
  ok("a linked blank with no photos says so", /linked blank has no photos/.test(bbox.textContent));
  aw.drawProductBlankImages_(product, blanks, []);
  ok("an unlinked product says no blank is linked", /No blank is linked yet/.test(bbox.textContent));

  console.log("\n=== Wiring ===");
  ok("the form uses the tile field and still saves from #prodFormImages", /initProductImagesField_\(orgId, product && product\.images/.test(adminJs) && /id="prodFormImages" aria-hidden="true"/.test(adminJs) &&
    /document\.getElementById\("prodFormImages"\)\.value\.split\("\\n"\)/.test(adminJs));
  ok("the blank photos come from the data the Blank links section already loads", /drawProductBlankImages_\(product, allBlanks, links\)/.test(adminJs));
})().catch(e => { console.log("test96 crashed:", false); console.error(e); process.exit(1); });
