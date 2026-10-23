const { JSDOM } = require("jsdom");
const fs = require("fs");

// Storefront: a configurable product with personalization offers the name box (or the preset-word list),
// charges the fee in the price/breakdown/cart, keeps the real name apart from the picks summary, and
// refuses an empty name while personalization is ticked.
const html = fs.readFileSync(__dirname + "/public/index.html", "utf8");
const catalog = { status: "ok", orgId: "o1", catalog: { name: "League", eyebrow: "", accent: "#123456", ready: true, desc: "", designImages: { shirt: "", cap: "", detail: "" },
  enabledPayments: ["check"], salesTaxRate: 0,
  graphics: [{ id: 1, name: "Logo", kind: "transfer", imageUrl: "", thumbUrl: "", addOnCents: 200, inkColors: [], allowedLocations: [], allowedGarmentColors: [] }],
  products: [
    { id: "tee", type: "shirt", name: "Tee", sub: "", images: [], features: [], configurable: true, garmentColors: ["Navy"], sizePricing: { M: 20, L: 20 }, personalizationPrice: 3,
      locations: [{ key: "front", label: "Front", locationId: 1, graphicIds: [1] }] },
    { id: "cap", type: "cap", name: "Cap", sub: "", images: [], features: [], configurable: true, garmentColors: ["Navy"], flatPrice: 16, personalizationPrice: 4, personalizationOptions: ["COACH", "CAPTAIN"],
      locations: [{ key: "front", label: "Front", locationId: 1, graphicIds: [1] }] },
    { id: "jkt", type: "cap", name: "Jacket", sub: "", images: [], features: [], configurable: true, garmentColors: ["Navy"], flatPrice: 30, personalizationPrice: null,
      locations: [{ key: "front", label: "Front", locationId: 1, graphicIds: [1] }, { key: "back", label: "Back", locationId: 2, graphicIds: [1] }] },
    { id: "hat", type: "cap", name: "Hat", sub: "", images: [], features: [], configurable: true, garmentColors: ["Navy"], flatPrice: 10, personalizationPrice: null,
      locations: [{ key: "front", label: "Front", locationId: 1, graphicIds: [1] }] }
  ] } };
(async () => {
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable", url: "https://league.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => catalog, text: async () => JSON.stringify(catalog) }); win.alert = (m) => { win._alerts = (win._alerts || []).concat(m); }; } });
  const w = dom.window, d = w.document;
  await new Promise(r => setTimeout(r, 200));
  const ok = (m, c) => console.log(m + ":", !!c);
  const set = (id, v) => { const e = d.getElementById(id); e.value = v; e.dispatchEvent(new w.Event("change", { bubbles: true })); };
  const tick = (id, on) => { const e = d.getElementById(id); e.checked = on; e.dispatchEvent(new w.Event("change", { bubbles: true })); };

  ok("shirt card offers the personalization checkbox with a free-text name box", !!d.getElementById("pers-tee") && d.getElementById("pers-name-tee").tagName === "INPUT");
  ok("cap card with preset words offers a dropdown of exactly those words", d.getElementById("pers-name-cap").tagName === "SELECT" && [...d.getElementById("pers-name-cap").options].map(o => o.value).join("|") === "|COACH|CAPTAIN");
  ok("a product with no personalization price shows none", !d.getElementById("pers-hat"));
  ok("single-location product: no \"None\" and the first graphic is preselected (price already includes it)",
    [...d.getElementById("loc-tee-front").options].every(o => o.value !== "") && d.getElementById("loc-tee-front").value === "1" && d.getElementById("price-tee").textContent === "$22.00");
  ok("a product with several locations keeps \"None\" and starts with nothing picked", d.getElementById("loc-jkt-front").options[0].value === "" && d.getElementById("loc-jkt-front").value === "" && d.getElementById("loc-jkt-back").value === "" && d.getElementById("cadd-jkt").disabled === true);
  ok("the Add button is enabled straight away", d.getElementById("cadd-tee").disabled === false);
  ok("the name box is hidden until ticked", d.getElementById("pers-name-tee").style.display === "none");
  tick("pers-tee", true);
  ok("ticking shows the name box", d.getElementById("pers-name-tee").style.display === "block");

  set("loc-tee-front", "1");
  ok("price = base 20 + graphic 2 + personalization 3 = $25.00", d.getElementById("price-tee").textContent === "$25.00");
  ok("breakdown lists the personalization", /Personalization[\s\S]*\+\$3\.00/.test(d.getElementById("cbd-tee").textContent));

  // Empty name refused.
  d.querySelector('#cadd-tee').click();
  ok("add is refused with an empty name", /name to embroider/i.test(d.getElementById("cmsg-tee").textContent) && w.eval("cart").length === 0);
  d.getElementById("pers-name-tee").value = "  Bob  ";
  d.querySelector('#cadd-tee').click();
  const line = w.eval("cart")[0];
  ok("cart line carries personalization, the trimmed name, the fee and the total", line && line.personalized === true && line.persName === "Bob" && line.personalizationFee === 3 && line.lineTotal === 25);
  ok("the picks summary is kept separately from the name", /Front: Logo/.test(line.cfgText) && line.config && line.config.locations[0].graphicId === 1);
  const cartText = d.getElementById("ticketPanel").textContent;
  ok("the cart shows both the personalization name and the picks", /Bob/.test(cartText) && /Front: Logo/.test(cartText));
  ok("the form resets after adding", d.getElementById("pers-tee").checked === false && d.getElementById("pers-name-tee").style.display === "none");

  // Cap: word list, unticked line has no personalization.
  set("loc-cap-front", "1");
  d.querySelector('#cadd-cap').click();
  ok("a configurable line without personalization has none", w.eval("cart")[1] && w.eval("cart")[1].personalized === false && w.eval("cart")[1].persName === "" && w.eval("cart")[1].lineTotal === 18);
  tick("pers-cap", true);
  set("pers-name-cap", "CAPTAIN");
  ok("cap price = 16 + 2 + 4 = $22.00", d.getElementById("price-cap").textContent === "$22.00");
  d.querySelector('#cadd-cap').click();
  ok("the chosen preset word is the personalization", w.eval("cart")[2] && w.eval("cart")[2].persName === "CAPTAIN" && w.eval("cart")[2].lineTotal === 22);
})().catch(e => { console.log("test92 crashed:", false); console.error(e); process.exit(1); });
