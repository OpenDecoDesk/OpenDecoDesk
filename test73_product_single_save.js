// One Save changes on the product form: it saves the product, then its designs list, then
// its blank links — there are no separate "Save designs" / "Save all links" buttons. A designs row
// with no design stops the save before anything is written; a later failure keeps the page open
// with what went wrong. jsdom with the real index.html + admin.js; fetch is mocked per action.
const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");

(async () => {
  try {
    const adminJs = read("public/admin.js");
    const calls = [];
    let failDesigns = false;
    class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
    const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
      beforeParse(win) {
        win.CSS = win.CSS || { escape: (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) };
        win.fetch = async (url, opts) => {
          const b = opts && opts.body ? JSON.parse(opts.body) : {};
          const ok = (o) => ({ ok: true, status: 200, json: async () => Object.assign({ status: "ok" }, o) });
          if (String(url).includes("/api/catalog")) return ok({ status: "admin" });
          if (b.action) calls.push(b);
          switch (b.action) {
            case "listDesigns": return ok({ designs: [{ id: 2, name: "Cap front", hoopIds: [1], personalizationHoopIds: [] }, { id: 14, name: "Cap Closure - Coach", isGlobal: true, hoopIds: [4], personalizationHoopIds: [] }] });
            case "listHoops": return ok({ hoops: [{ id: 1, name: "Cap Hoop" }, { id: 4, name: "Maggie 5.1" }] });
            case "listProductDesigns": return ok({ designs: [] });
            case "getBlanks": return ok({ blanks: [{ id: 7, name: "Richardson 112", productType: "cap", sizes: [{ size: "OSFA", quantity: 3 }] }] });
            case "getBlankLinks": return ok({ links: [] });
            case "setProductDesigns": return failDesigns ? { ok: false, status: 400, json: async () => ({ status: "error", message: "Design 2 doesn't belong to this shop" }) }
              : ok({ designs: b.designs.map((d, i) => Object.assign({ id: i + 1 }, d)) });
            default: return ok({});
          }
        };
      } });
    const w = dom.window;
    await new Promise(res => setTimeout(res, 150));
    await w.loadAdminScript();
    w.eval('adminKey = "cookie"; adminOrgs = [{orgId:"shop1", name:"Sample Shop"}];');
    const tick = (ms = 60) => new Promise(res => setTimeout(res, ms));
    const app = w.document.getElementById("app");
    const product = { productId: "cap", type: "cap", name: "Royal Blue 5 Panel Cap", pricingMode: "flat", flatPrice: 25, personalizationPrice: 5,
      personalizationOptions: [], visible: true, taxable: true, images: [], features: [], designs: [] };
    w.renderProductForm(app, "shop1", product);
    await tick(120);

    console.log("=== One save button ===");
    const labels = [...app.querySelectorAll("button")].map(b => b.textContent.trim());
    console.log("no separate Save designs / Save all links buttons:", !labels.includes("Save designs") && !labels.includes("Save all links") && labels.includes("Save changes"));
    console.log("both sections say they're saved with Save changes:", /Saved with Save changes/.test(app.querySelector("#productDesignSection").parentNode.textContent) &&
      /Saved with Save changes below/.test(app.querySelector("#blankLinksSection").textContent));

    console.log("\n=== A half-filled designs row stops the save before anything is written ===");
    app.querySelector("#pdAdd").click();
    calls.length = 0;
    w.submitProductForm("shop1", true);
    await tick();
    console.log("refused with the reason, nothing sent:", /pick a design on every row/.test(app.querySelector("#prodFormError").textContent) &&
      !calls.some(c => c.action === "updateProduct"));

    console.log("\n=== Save changes saves the product, its designs and its blank links ===");
    const sel = app.querySelector(".pd-design"); sel.value = "2"; sel.dispatchEvent(new w.Event("change"));
    const pl = app.querySelector(".pd-placement"); pl.value = "Front"; pl.dispatchEvent(new w.Event("input"));
    const blank = app.querySelector(".bl-blank"); blank.value = "7"; blank.dispatchEvent(new w.Event("change", { bubbles: true }));
    await tick();
    calls.length = 0;
    await w.submitProductForm("shop1", true);
    await tick();
    const order = calls.map(c => c.action).filter(a => ["updateProduct", "setProductDesigns", "setBlankLink", "saveBlankLinks"].includes(a));
    console.log("in order: product, then designs, then blank links (one request for all of them):", order.join(",") === "updateProduct,setProductDesigns,saveBlankLinks");
    const pd = calls.find(c => c.action === "setProductDesigns");
    console.log("the designs list is sent as shown (design, placement, main):", pd.designs.length === 1 && pd.designs[0].designId === 2 && pd.designs[0].placement === "Front" && pd.designs[0].isMain === true);
    const bl = calls.find(c => c.action === "saveBlankLinks");
    console.log("the blank link is sent:", bl.set.length === 1 && bl.set[0].blankId === 7 && bl.set[0].productSize === "OSFA" && bl.set[0].blankSize === "OSFA" && !bl.remove.length);
    console.log("then it goes back to the products list:", w.location.hash === "#catalog/orgs/shop1/products");
    calls.length = 0;
    const again = await w._blankLinksSave.save();
    console.log("saving again with nothing changed sends no link request at all:", again === "" && !calls.some(c => c.action === "saveBlankLinks" || c.action === "setBlankLink"));

    console.log("\n=== A failure after the product saved keeps the page open and says so ===");
    w.renderProductForm(app, "shop1", product);
    await tick(120);
    app.querySelector("#pdAdd").click();
    const sel2 = app.querySelector(".pd-design"); sel2.value = "2"; sel2.dispatchEvent(new w.Event("change"));
    failDesigns = true;
    w.location.hash = "#catalog/orgs/shop1/products/cap/edit";
    await w.submitProductForm("shop1", true);
    await tick();
    console.log("the error names the part that failed, and the page stays:", /The product was saved, but: Designs: Design 2 doesn't belong/.test(app.querySelector("#prodFormError").textContent) &&
      w.location.hash === "#catalog/orgs/shop1/products/cap/edit");
  } catch (e) {
    console.log("test73 crashed:", false);
    console.error(e);
    process.exit(1);
  }
})();
