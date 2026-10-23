
// A cancelled order must still offer 💰 Payments (its recorded payment has to be voided before the order can be).
{
  const fs = require("fs");
  const src = fs.readFileSync(__dirname + "/public/admin.js", "utf8");
  const m = src.match(/if\(o\.items\.every\(it => it\.cancelDate\)\)\{[\s\S]*?\n  \}/);
  console.log("a cancelled order's Action cell includes the Payments button:", !!m && /paymentsBtn/.test(m[0]));
}

// The Stock window is white; the page's default text is cream, so it must set its own dark text. Since
// finished stock (migrations/0060) it's built on inventoryModal_, which sets both.
{
  const src = require("fs").readFileSync(__dirname + "/public/admin.js", "utf8");
  const stock = src.slice(src.indexOf("async function showStockModal("), src.indexOf("function renderCreateProductForm("));
  const shared = src.match(/function inventoryModal_\(title, bodyHtml, width, opts\)\{[\s\S]*?ov\.innerHTML = `<div style="background:#fff;color:#1a1a1a;/);
  console.log("the stock window sets dark text on its white background:", /inventoryModal_\("Finished stock/.test(stock) && !!shared);
  console.log("the stock window's button has its own visible colours:", /id="fsClose"/.test(stock) && /class="admin-btn fsCorrect" style="[^"]*background:#fff;color:#333/.test(stock));
}

// Persistent admin header: every tool page appears in one of the ADMIN_NAV_GROUPS dropdowns.
// (Orders, Run Order and Manage catalog are standalone top-level buttons, not in a dropdown.)
{
  const src = require("fs").readFileSync(__dirname + "/public/admin.js", "utf8");
  const groups = (src.match(/const ADMIN_NAV_GROUPS = \[([\s\S]*?)\];/) || [])[1] || "";
  console.log("the header groups list every tool page:", ["settings", "packages", "inventory", "threads", "machines", "machinefiles", "hoops", "comms", "expenses", "money", "reconcile", "audit", "revenue", "salestax", "cogs", "books", "security"].every(h => groups.includes('["' + h + '"')));
  console.log("Global settings is in the Settings menu, not a button on Manage catalog:",
    /label: "Settings", items: \[\s*\["settings", "Global settings"\]/.test(groups) && !/location\.hash='#catalog\/settings'/.test(src)
    && /raw === "settings" \|\| raw === "catalog\/settings"/.test(src));
  console.log("Manage catalog is a top-level button (after Run Transfer Sheets), not in Tools:",
    /navGo\('runtransfer'\)">Run Transfer Sheets<\/button>\s*<button[^>]*navGo\('catalog'\)">Manage catalog</.test(src) && !groups.includes('["catalog"'));
  console.log("Run Order is a standalone top-level button, not in a dropdown:",
    /navGo\('runorder'\)">Run Order</.test(src) && !groups.includes('["runorder"'));
  console.log("the menu groups are Catalog / Production / Inventory / Finance / Reports / Settings, in that order:",
    groups.indexOf('label: "Catalog"') >= 0 && ["Catalog", "Production", "Inventory", "Finance", "Reports", "Settings"].every((l, i, a) => groups.includes('label: "' + l + '"') && (i === 0 || groups.indexOf('label: "' + a[i - 1] + '"') < groups.indexOf('label: "' + l + '"'))));
  console.log("Sign out lives in the Settings dropdown, not a top-level shops row:", /label: "Settings"[\s\S]*adminSignOut\(\)/.test(groups));
}

// Edit items: personalization (customization text) can actually be changed, not just displayed.
(async () => {
  const fs = require("fs");
  const { JSDOM, ResourceLoader } = require("jsdom");
  const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();

  const products = [
    { productId: "cap", name: "Cap", type: "cap", pricingMode: "flat", flatPrice: 20, personalizationPrice: 3, visible: true },
    { productId: "mug", name: "Mug", type: "mug", pricingMode: "flat", flatPrice: 10, personalizationPrice: null, visible: true },
  ];
  const order = { orderId: "O1", customerName: "Ann", total: 20, shippingCost: 0, items: [
    { sheetRow: 1, productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20, personalizationFee: 0, personalized: false, persName: "", lineTotal: 20, cancelDate: "" },
  ] };
  const pending = w.showEditOrderModal(order, products);
  await new Promise(res => setTimeout(res, 30));
  const ov = w.document.body.lastElementChild;
  const box = (sel) => ov.querySelector(sel);
  console.log("a product with a personalization price shows a Personalized checkbox:", !!box('input[data-field="personalized"]'));

  const chk = box('input[data-field="personalized"]');
  chk.checked = true; chk.dispatchEvent(new w.Event("change", { bubbles: true }));
  const nameInput = box('input[data-field="persName"]');
  console.log("checking it reveals a text field for the customization text, and the fee is added to the price shown:",
    !!nameInput && ov.textContent.includes("$23.00"));
  nameInput.value = "Robert"; nameInput.dispatchEvent(new w.Event("input", { bubbles: true }));

  w.document.getElementById("editOrderSave").click();
  const result = await pending;
  console.log("saving sends the personalization text even though qty/size/product never changed:",
    result && result.updates.length === 1 && result.updates[0].personalized === true && result.updates[0].persName === "Robert");

  // A product with no personalization price offers no checkbox at all.
  const order2 = { orderId: "O2", customerName: "Bo", total: 10, shippingCost: 0, items: [
    { sheetRow: 2, productId: "mug", name: "Mug", type: "mug", size: "OSFA", qty: 1, unitPrice: 10, personalizationFee: 0, personalized: false, persName: "", lineTotal: 10, cancelDate: "" },
  ] };
  const pending2 = w.showEditOrderModal(order2, products);
  await new Promise(res => setTimeout(res, 30));
  const ov2 = w.document.body.lastElementChild;
  console.log("a product with no personalization price offers no checkbox:", !ov2.querySelector('input[data-field="personalized"]'));
  w.document.getElementById("editOrderCancel").click();
  await pending2;
})();

// Blanks: a "Write off" button opens a modal offering test/shop-scrap as a reason, not just damage.
(async () => {
  const fs = require("fs");
  const { JSDOM, ResourceLoader } = require("jsdom");
  const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();

  console.log("a Write off button sits on the Blanks row, next to History:", /blankHistory\(this\.dataset\.blankId\)[\s\S]{0,300}blankWriteOff\(this\.dataset\.blankId\)/.test(adminJs));

  const blank = { id: 9, name: "Test Cap", brand: "Acme", color: "Navy", sizes: [{ size: "OSFA", quantity: 6, purchasePrice: 3 }] };
  w.showWriteOffModal_(blank, () => {});
  const ov = w.document.body.lastElementChild;
  const opts = [...ov.querySelectorAll("#woReason option")].map(o => o.value);
  console.log("the reason list includes test/shop scrap alongside damaged/lost/other:",
    opts.includes("test") && opts.includes("damaged") && opts.includes("lost") && opts.includes("other"));
  console.log("choosing 'Other' reveals a details field for a custom reason:", ov.querySelector("#woOtherWrap").style.display === "none");
  ov.querySelector("#woReason").value = "other";
  ov.querySelector("#woReason").dispatchEvent(new w.Event("change", { bubbles: true }));
  console.log("...and it's shown once selected:", ov.querySelector("#woOtherWrap").style.display === "");

  let lastWriteOff = null;
  const origFetch = w.fetch;
  w.fetch = async (url, opts) => { lastWriteOff = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ status: "ok", blanks: [] }) }; };
  ov.querySelector("#woReason").value = "test";
  ov.querySelector("#woQty").value = "2";
  w.document.getElementById("woSave").click();
  await new Promise(res => setTimeout(res, 50));
  console.log("saving sends the test/scrap reason as the note, with the size, qty and date:",
    lastWriteOff && lastWriteOff.action === "writeOffBlanks" && lastWriteOff.size === "OSFA" &&
    lastWriteOff.qty === 2 && lastWriteOff.note === "Used for testing, samples, or shop scrap" && !!lastWriteOff.occurredAt);
  w.fetch = origFetch;
})();
