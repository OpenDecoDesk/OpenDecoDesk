// Admin header + Tools pages: Manage catalog is a top-level button, Global settings and
// Package sizes are Tools-menu PAGES (#settings, #packages) like the other tools — Global settings
// has no Back button, and Package sizes is a page, not a pop-up — and Blanks is laid out like Threads
// (toolbar inside the page, with a search). jsdom with the real index.html +
// admin.js; fetch is mocked per action.
const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");

(async () => {
  try {
    const adminJs = read("public/admin.js");
    const calls = [];
    let saved = null;
    const presets = [
      { key: "small", name: "Small", length: 12, width: 9, height: 2, packingCost: 1.5, boxWeightOz: 4, maxShirts: 2, maxCaps: 3, maxSweatshirts: 1, maxWeightOz: 32 },
      { key: "big", name: "Big", length: 12, width: 12, height: 12, packingCost: 2.5, boxWeightOz: 12, maxShirts: null, maxCaps: null, maxSweatshirts: null, maxWeightOz: null },
    ];
    class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
    const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
      beforeParse(win) {
        win.fetch = async (url, opts) => {
          const body = opts && opts.body ? JSON.parse(opts.body) : {};
          calls.push(body.action || url);
          if (body.action === "getBoxPresets") return { ok: true, status: 200, json: async () => ({ status: "ok", presets: saved || presets }) };
          if (body.action === "setBoxPresets") { saved = body.presets; return { ok: true, status: 200, json: async () => ({ status: "ok" }) }; }
          if (body.action === "getBlanks") return { ok: true, status: 200, json: async () => ({ status: "ok", blanks: [
            { id: 1, name: "Gildan 5000", vendor: "S&S", brand: "Gildan", sku: "G500", color: "Black", productType: "shirt", sizes: [{ size: "L", quantity: 4, purchasePrice: 3 }, { size: "XL", quantity: 2, purchasePrice: 3.5 }] },
            { id: 2, name: "Richardson 112", vendor: "SanMar", brand: "Richardson", sku: "112", color: "Navy", productType: "cap", sizes: [{ size: "OSFA", quantity: 10, purchasePrice: 4 }] },
          ] }) };
          return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) };
        };
      } });
    const w = dom.window;
    await new Promise(res => setTimeout(res, 150));
    await w.loadAdminScript();
    w.eval('adminKey = "cookie";');
    const app = w.document.getElementById("app");
    const tick = (ms = 30) => new Promise(res => setTimeout(res, ms));

    console.log("=== Header ===");
    const groups = (adminJs.match(/const ADMIN_NAV_GROUPS = \[([\s\S]*?)\];/) || [])[1] || "";
    const grp = (label) => (groups.match(new RegExp('label: "' + label + '", items: \\[([\\s\\S]*?)\\]\\},')) || [])[1] || "";
    console.log("Catalog lists Package sizes and Settings lists Global settings, as pages:", /\["packages", "Package sizes"\]/.test(grp("Catalog")) && /\["settings", "Global settings"\]/.test(grp("Settings")));
    console.log("Package sizes no longer opens a pop-up from the menu:", !/showManagePackagePresets/.test(adminJs));
    console.log("Manage catalog is a top-level button, not in Tools:", /navGo\('catalog'\)">Manage catalog</.test(adminJs) && !/\["catalog"/.test(groups));
    console.log("#packages and #settings are routed:", /raw === "packages"\)\s*\{ renderPackageSizes\(app\)/.test(adminJs) && /raw === "settings" \|\| raw === "catalog\/settings"/.test(adminJs));

    console.log("\n=== Global settings: no Back button ===");
    w.renderGlobalSettings(app);
    await tick();
    const backBtn = Array.from(app.querySelectorAll("button")).find(b => /Back/.test(b.textContent));
    console.log("the page has no Back button:", !backBtn && /Global settings/.test(app.textContent));
    console.log("the breadcrumb no longer goes through Manage Catalog:", !/Manage Catalog/.test(app.querySelector(".org-hero").textContent));

    console.log("\n=== Package sizes is a page, not a pop-up ===");
    const bodyChildrenBefore = w.document.body.children.length;
    await w.renderPackageSizes(app);
    await tick();
    console.log("renders into the page with a normal admin header:", /Package sizes/.test(app.querySelector(".org-hero").textContent) && w.location.hash === "#packages");
    console.log("no overlay is added to the document:", w.document.body.children.length === bodyChildrenBefore && !w.document.querySelector('div[style*="position:fixed"]'));
    const rows = () => Array.from(app.querySelectorAll("#pkgPresetsBody tr"));
    console.log("loads the saved sizes (one row each, values filled in):", rows().length === 2 && rows()[0].querySelector(".pkg-name").value === "Small" && rows()[1].querySelector(".pkg-l").value === "12");
    console.log("blank capacity shows blank (unlimited):", rows()[1].querySelector(".pkg-max-shirts").value === "");

    app.querySelector("#pkgAddRow").click();
    console.log("+ Add size adds an empty row:", rows().length === 3 && rows()[2].querySelector(".pkg-name").value === "");
    app.querySelector("#pkgSave").click();
    await tick();
    console.log("Save refuses a row with no name, and saves nothing:", /needs a name/.test(app.querySelector("#pkgError").textContent) && saved === null);
    const r3 = rows()[2];
    const set = (cls, v) => { r3.querySelector(cls).value = v; };
    set(".pkg-name", "Cap Box"); set(".pkg-l", "10"); set(".pkg-w", "10"); set(".pkg-h", "6"); set(".pkg-cost", "1.25"); set(".pkg-max-caps", "4");
    rows()[0].querySelector("button").click(); // remove "Small"
    app.querySelector("#pkgSave").click();
    await tick(60);
    console.log("Save sends the edited list (Small removed, Cap Box added with its key and limits):",
      Array.isArray(saved) && saved.length === 2 && saved[0].name === "Big" && saved[1].key === "cap_box" &&
      saved[1].packingCost === 1.25 && saved[1].maxCaps === 4 && saved[1].maxShirts === null);
    console.log("after saving, the page reloads the saved sizes:", rows().length === 2 && rows()[1].querySelector(".pkg-name").value === "Cap Box");

    rows()[0].querySelector(".pkg-name").value = "Changed";
    app.querySelector("#pkgDiscard").click();
    await tick(60);
    console.log("Discard changes reloads the saved sizes:", rows()[0].querySelector(".pkg-name").value === "Big");

    console.log("\n=== Blanks: laid out like Threads, with a search ===");
    await w.renderAdminBlanks(app);
    await tick(60);
    const panel = app.querySelector(".admin-panel");
    console.log("no button bar above the page — the toolbar is inside the panel:",
      !app.querySelector(":scope > .admin-actions") && ["blankSearch", "blankAddBtn", "blankOrderBtn", "blankImportPdfBtn"].every(id => panel.querySelector("#" + id)));
    console.log("toolbar order matches Threads: search first, then the buttons:",
      panel.querySelector("#blankSearch").parentNode === panel.querySelector("#blankAddBtn").parentNode &&
      panel.querySelector("#blankSearch").parentNode.firstElementChild.id === "blankSearch");
    const blankRows = () => Array.from(app.querySelectorAll("#blanksPanel tbody tr")).map(tr => tr.querySelector("td").childNodes[0].textContent.trim());
    console.log("both blanks listed:", JSON.stringify(blankRows()) === JSON.stringify(["Gildan 5000", "Richardson 112"]));
    const search = app.querySelector("#blankSearch");
    const type = (v) => { search.value = v; search.dispatchEvent(new w.Event("input")); };
    type("navy");
    console.log("searching a color filters the list:", JSON.stringify(blankRows()) === JSON.stringify(["Richardson 112"]));
    type("sanmar");
    console.log("…a vendor:", JSON.stringify(blankRows()) === JSON.stringify(["Richardson 112"]));
    type("xl");
    console.log("…a size:", JSON.stringify(blankRows()) === JSON.stringify(["Gildan 5000"]));
    console.log("totals say they cover the matching blanks:", /Matching blanks' held value: \$19\.00/.test(app.textContent));
    type("zzz");
    console.log("no match shows a clear message:", /No blanks match/.test(app.querySelector("#blanksPanel").textContent));
    type("navy");
    console.log("row buttons still find the blank while filtered (cache is the full list):",
      (w._blanksCache || []).length === 2 && !!w._blanksCache.find(b => b.id === 2));
    type("");
    console.log("clearing the search shows everything again:", blankRows().length === 2 && /Total held inventory value/.test(app.textContent));
  } catch (e) {
    console.log("test65 crashed:", false);
    console.error(e);
    process.exit(1);
  }
})();
