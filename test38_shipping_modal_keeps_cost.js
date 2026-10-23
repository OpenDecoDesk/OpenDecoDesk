const { JSDOM, ResourceLoader } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/public/index.html", "utf8");

// The Edit shipping window must not change an order's shipping cost unless a
// new rate (or custom amount) is chosen — saving an address/"shipping paid"
// edit must not overwrite a hand-corrected cost.

const adminJsSource = fs.readFileSync(__dirname + "/public/admin.js", "utf8");
class AdminResourceLoader extends ResourceLoader {
  fetch(url, options){
    if(url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJsSource, "utf-8"));
    return super.fetch(url, options);
  }
}

(async () => {
  const dom = new JSDOM(html, {
    runScripts: "dangerously", resources: new AdminResourceLoader(),
    url: "https://league101.example.com/x.html", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, json: async () => ({ status: "error", message: "n/a" }) }); }
  });
  const { window } = dom;
  await new Promise(r => setTimeout(r, 100));
  await window.loadAdminScript();

  const order = { orderId: "ORD-1", customerName: "Ann", contact: "a@x.com", items: [],
    shippingAddress: { name: "Ann", line1: "1 Main", city: "Springfield", state: "OH", zip: "45503" },
    totalWeightOz: 12, shippingCost: 6.25, shippingMethod: "USPS Ground Advantage", shippingPaidAmount: 6.25 };
  const pending = window.showShippingModal(order);
  await new Promise(r => setTimeout(r, 20));
  const doc = window.document;
  console.log("modal says saving keeps the current cost:", /Saving keeps this cost/.test(doc.body.textContent));
  doc.getElementById("shipPaidAmount").value = "6.25";
  doc.getElementById("shipSave").click();
  const result = await pending;
  console.log("saving without picking a rate keeps the cost and method:",
    !!result && result.shippingCost === 6.25 && result.shippingMethod === "USPS Ground Advantage");
})().catch(e => { console.log("test38 crashed:", false); console.error(e); process.exit(1); });
