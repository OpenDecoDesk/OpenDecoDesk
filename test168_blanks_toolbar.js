// Blanks screen: a short toolbar — + New blank and Receive order, then the Import, Connected vendor and
// More menus — and on each blank's row Edit, History and a "⋯" menu (Write off, Merge, Clone, Delete).
// Connected vendor only appears once a vendor is connected with a login; the desktop version doesn't ask
// while its supplier connections are off. jsdom with the real index.html + admin.js; fetch mocked per action.
const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const ok = (d, c) => console.log(d + ":", !!c);
const tick = (ms = 40) => new Promise(res => setTimeout(res, ms));

const BLANKS = [
  { id: 1, name: "Gildan 5000", vendor: "S&S", brand: "Gildan", sku: "G500", color: "Black", productType: "shirt", sizes: [{ size: "L", quantity: 4, purchasePrice: 3 }] },
  { id: 2, name: "Richardson 112", vendor: "SanMar", brand: "Richardson", sku: "112", color: "Navy", productType: "cap", sizes: [{ size: "OSFA", quantity: 10, purchasePrice: 4 }] },
];

// The Blanks page in jsdom. `connections` is what listVendorConnections answers; `desktop` makes the
// page the desktop program's ({ suppliers } = supplier connections on or off).
async function blanksPage({ connections = [], desktop = null } = {}) {
  const adminJs = read("public/admin.js");
  const calls = [];
  class L extends ResourceLoader { fetch(url, o) {
    if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs));
    const local = new URL(url).pathname.match(/^\/vendor\/fonts\/[a-z0-9.-]+$/);
    return local ? Promise.resolve(fs.readFileSync(__dirname + "/public" + local[0])) : super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: desktop ? "http://localhost:47830/" : "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = async (url, opts) => {
        const body = opts && opts.body ? JSON.parse(opts.body) : {};
        calls.push(body.action || String(url));
        if (String(url).includes("/api/catalog")) return { ok: true, status: 200, json: async () => ({ status: "admin", features: {}, ...(desktop ? { edition: "desktop", ...(desktop.suppliers ? { desktopSuppliers: true } : {}) } : {}) }) };
        if (body.action === "getBlanks") return { ok: true, status: 200, json: async () => ({ status: "ok", blanks: BLANKS }) };
        if (body.action === "listVendorConnections") return { ok: true, status: 200, json: async () => ({ status: "ok", connections }) };
        return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
      };
    } });
  const w = dom.window;
  await tick(150);
  await w.loadAdminScript();
  w.eval('adminKey = "cookie";');
  const app = w.document.getElementById("app");
  await w.renderAdminBlanks(app);
  await tick(80);
  return { w, doc: w.document, app, calls };
}
const visibleLabels = (root) => [...root.children].filter(el => el.style.display !== "none" && (el.tagName === "BUTTON" || el.matches(".admin-menu")))
  .map(el => el.matches(".admin-menu") ? el.querySelector(":scope > button").textContent.trim() + " ▾" : el.textContent.trim());

(async () => {
  console.log("=== The toolbar ===");
  let p = await blanksPage();
  const bar = p.doc.getElementById("blankAddBtn").parentNode;
  const shown = visibleLabels(bar).filter(t => t);
  ok("with no vendor connected: + New blank, Receive order, then the Import and More menus — nothing else", JSON.stringify(shown) === JSON.stringify(["+ New blank", "Receive order", "Import ▾", "More ▾"]));
  ok("…after the search box and the which-blanks filter", bar.firstElementChild.id === "blankSearch" && bar.querySelector("#blankGroup"));
  ok("…the Connected vendor menu is there but hidden", p.doc.getElementById("blankVendorMenu") && p.doc.getElementById("blankVendorMenu").style.display === "none");
  const items = (id) => [...p.doc.getElementById(id).closest(".admin-menu").querySelectorAll(".admin-menu-item")].map(b => b.textContent.trim());
  ok("Import holds the four file imports, named by what the file is", JSON.stringify(items("blankImportPdfBtn")) === JSON.stringify(["Vendor invoice (PDF)…", "Vendor product file — new blanks…", "Vendor product file — update prices…", "Spreadsheet (CSV)…"]));
  ok("More holds the two photo tools", JSON.stringify(items("blankDupPhotosBtn")) === JSON.stringify(["Find duplicate photos…", "Repair photo thumbnails…"]));
  ok("Connected vendor holds looking up a style and refreshing prices", JSON.stringify(items("blankVendorLiveBtn")) === JSON.stringify(["Look up a style → new blank…", "Refresh prices and colors…"]));

  console.log("\n=== Opening and closing a menu ===");
  const importMenu = p.doc.getElementById("blankImportPdfBtn").closest(".admin-menu");
  const importBtn = importMenu.querySelector(":scope > button");
  importBtn.click();
  ok("clicking Import opens its list", importMenu.classList.contains("open") && importBtn.getAttribute("aria-expanded") === "true");
  p.doc.querySelector(".admin-menu:not(#blankVendorMenu) + .admin-menu, #blankDupPhotosBtn").closest(".admin-menu").querySelector(":scope > button").click();
  ok("opening another menu closes the first", !importMenu.classList.contains("open"));
  p.doc.body.click();
  ok("a click elsewhere closes it", !p.doc.querySelector(".admin-menu.open"));
  importBtn.click();
  importBtn.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  ok("the down arrow moves into the list", p.doc.activeElement && p.doc.activeElement.id === "blankImportPdfBtn");
  p.doc.activeElement.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok("Escape closes it and returns to its button", !importMenu.classList.contains("open") && p.doc.activeElement === importBtn);
  let picked = 0;
  p.doc.getElementById("blankImportPdfFile").click = () => { picked++; };
  importBtn.click();
  p.doc.getElementById("blankImportPdfBtn").click();
  ok("choosing Vendor invoice (PDF)… asks for the PDF, as the old button did, and closes the menu", picked === 1 && !importMenu.classList.contains("open"));

  console.log("\n=== Each blank's row ===");
  const row = p.doc.querySelector('[data-blank-row="1"]');
  const rowButtons = [...row.querySelectorAll("td:last-child > button")].map(b => b.textContent.trim());
  ok("a row shows Edit and History", JSON.stringify(rowButtons) === JSON.stringify(["Edit", "History"]));
  const rowMenu = row.querySelector(".admin-menu");
  ok("…and a ⋯ menu with Write off, Merge, Clone and (set apart, in red) Delete", rowMenu && rowMenu.querySelector(":scope > button").textContent.trim() === "⋯" &&
    JSON.stringify([...rowMenu.querySelectorAll(".admin-menu-item")].map(b => b.textContent.trim())) === JSON.stringify(["Write off…", "Merge…", "Clone", "Delete…"]) &&
    rowMenu.querySelector(".admin-menu-sep") && rowMenu.querySelector(".admin-menu-item:last-child").classList.contains("danger"));
  ok("…the ⋯ button is named for screen readers", rowMenu.querySelector(":scope > button").getAttribute("aria-label") === "More for Gildan 5000");
  let wrote = null;
  p.w.blankWriteOff = (id) => { wrote = id; };
  rowMenu.querySelector(":scope > button").click();
  rowMenu.querySelector(".admin-menu-item").click();
  ok("Write off… still opens the write-off for that blank", wrote === "1" && !rowMenu.classList.contains("open"));
  p.w.close();

  console.log("\n=== Connected vendor appears only with a connected vendor ===");
  p = await blanksPage({ connections: [{ id: 1, name: "SanMar", hasCredentials: false }] });
  ok("a vendor saved without a login doesn't count", p.doc.getElementById("blankVendorMenu").style.display === "none");
  p.w.close();
  p = await blanksPage({ connections: [{ id: 1, name: "SanMar", hasCredentials: true }] });
  ok("with a vendor connected (and its login saved), the Connected vendor menu is shown", p.doc.getElementById("blankVendorMenu").style.display === "");
  p.w.close();
  p = await blanksPage({ connections: [{ id: 1, name: "SanMar", hasCredentials: true }], desktop: { suppliers: false } });
  ok("in the desktop version with supplier connections off, it doesn't even ask (and stays hidden)", !p.calls.includes("listVendorConnections") && p.doc.getElementById("blankVendorMenu").style.display === "none");
  p.w.close();
  p = await blanksPage({ connections: [{ id: 1, name: "SanMar", hasCredentials: true }], desktop: { suppliers: true } });
  ok("…and with them on, it asks and shows it", p.calls.includes("listVendorConnections") && p.doc.getElementById("blankVendorMenu").style.display === "");
  p.w.close();
})().catch(e => { console.error(e); process.exit(1); });
