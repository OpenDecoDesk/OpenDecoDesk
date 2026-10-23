// Admin consistency (2026-10 usability round): the menus (Catalog / Production / Inventory / Finance / Reports /
// Settings, with Designs and Graphics reachable from the menu), one page heading (adminPageHead_) and one tab-title
// format (adminTitle_), "shop" not "org" in what the admin reads, one danger-button style, the shared confirm window
// (confirmModal_) for Void / Cancel / Revoke / Ignore, one stacking order for windows with toasts above them, and
// list tables that become cards on a phone. jsdom with the real index.html + admin.js.
const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const ok = (m, c) => console.log(m + ":", !!c);

(async () => {
  const adminJs = read("public/admin.js"), indexHtml = read("public/index.html");
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(indexHtml, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) { win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window, d = w.document;
  await new Promise(r => setTimeout(r, 150));
  await w.loadAdminScript();
  const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

  console.log("=== Menus ===");
  const groups = w.eval("ADMIN_NAV_GROUPS");
  ok("the menus are Catalog, Production, Inventory, Finance, Reports, Settings", groups.map(g => g.label).join("|") === "Catalog|Production|Inventory|Finance|Reports|Settings");
  const items = (label) => groups.find(g => g.label === label).items.filter(Array.isArray).map(i => i[0]);
  ok("Catalog has Designs and Graphics (no longer reachable only from a shop's row), categories, locations, brand rules and boxes",
    ["designs", "graphics", "categories", "locations", "brandrules", "packages"].every(h => items("Catalog").includes(h)));
  ok("Production has the machines, files, hoops, threads and abort reasons", ["machines", "maintenance", "machinefiles", "hoops", "threads", "abortreasons"].every(h => items("Production").includes(h)));
  ok("Settings has Global settings, vendors, Communications, images, Users and the sign-in pages", ["settings", "vendors", "comms", "orphans", "users", "security", "password"].every(h => items("Settings").includes(h)));
  const labels = groups.flatMap(g => g.items.map(i => Array.isArray(i) ? i[1] : i.label));
  ok("menu entries are in sentence case", ["Audit log", "Revenue report", "Sales tax report", "Blanks to order", "Machine files", "Run times", "Periods & export"].every(l => labels.includes(l)) &&
    !labels.some(l => /\b(Report|Log|Order|Files|Times|Export)\b/.test(l.replace(/^Run Order$/, ""))));
  // OpenDecoDesk: a worker manages catalog content, graphics included (saveGraphic is a staff action there).
  ok("a worker can open Designs and Graphics from the menu", w.adminPageRole_("designs") === "staff" && w.adminPageRole_("graphics") === "staff");
  w.eval(`adminOrgs = [{orgId: "acme", name: "Acme"}, {orgId: "northside", name: "Northside"}]; window._adminLastShop = "northside";`);
  ok("Designs / Graphics from the menu open the shop last worked on", w.adminLastShop_() === "northside");
  w.eval(`window._adminLastShop = "gone";`);
  ok("…or the first shop when that one isn't there", w.adminLastShop_() === "acme");

  console.log("\n=== The shop bar ===");
  const ctxAt = (h) => { w.location.hash = h; return w.shopBarContext_(); };
  ok("every catalog screen knows its shop and page", JSON.stringify(ctxAt("#designs/northside/3")) === '{"shop":"northside","page":"designs"}' &&
    ctxAt("#catalog/orgs/acme/products/new").page === "products" && ctxAt("#catalog/orgs/acme/edit").page === "edit" &&
    ctxAt("#wizard/acme").page === "setup" && ctxAt("#graphics/acme").shop === "acme" && ctxAt("#catalog").page === "catalog" &&
    ctxAt("#categories").page === "categories" && ctxAt("#locations").shop === null);
  ok("…and pages outside the catalog get no bar", ctxAt("#orders/acme") === null && ctxAt("#runorder") === null && ctxAt("#catalog/settings") === null);
  w.eval(`window._shopBarData = { at: Date.now(), wizards: [{ orgId: "northside", done: false }], publish: { northside: { state: "changed" }, acme: { state: "current" } } };`);
  const bar = w.shopBarHtml_({ shop: "northside", page: "designs" });
  ok("the bar: ← Manage catalog, the shop picker (this shop chosen), Shop setup / Products / Designs / Graphics, Publish",
    /href="#catalog">&larr; Manage catalog/.test(bar) && /value="northside" selected/.test(bar) && /value="acme"/.test(bar) &&
    /href="#catalog\/orgs\/northside\/products"/.test(bar) && /href="#designs\/northside"[^>]*aria-current="page"/.test(bar) && /href="#graphics\/northside"/.test(bar) &&
    /shop-bar-pub"[^>]*>Publish changes</.test(bar));
  ok("…and Shop settings (the shop's own form), marked when it's the page open", /href="#catalog\/orgs\/northside\/edit">Shop settings</.test(bar) &&
    /href="#catalog\/orgs\/acme\/edit"[^>]*aria-current="page">Shop settings</.test(w.shopBarHtml_({ shop: "acme", page: "edit" })));
  ok("…an unfinished setup reads Resume shop setup; a finished or unstarted one Shop setup", /Resume shop setup/.test(bar) && /Shop setup</.test(w.shopBarHtml_({ shop: "acme", page: "products" })));
  ok("…a shop shoppers already see as it is shows ✓ Published, not a button to press", /disabled[^>]*>✓ Published</.test(w.shopBarHtml_({ shop: "acme", page: "products" })));
  ok("…on Manage catalog itself it's titled, with the picker asking for a shop", /shop-bar-title">Manage catalog</.test(w.shopBarHtml_({ shop: null, page: "catalog" })) && /Choose a shop/.test(w.shopBarHtml_({ shop: null, page: "catalog" })));
  w.eval(`adminMe = { role: "staff" };`);
  const staffBar = w.shopBarHtml_({ shop: "northside", page: "designs" });
  // OpenDecoDesk: a worker manages products, designs and graphics; Shop setup and Publish stay a manager's.
  ok("a worker's bar has Manage catalog, Products, Designs and Graphics — no Shop setup, Shop settings or Publish", /Manage catalog/.test(staffBar) && /Products/.test(staffBar) && /Designs/.test(staffBar) &&
    /Graphics/.test(staffBar) && !/Publish|Shop setup|Shop settings/.test(staffBar));
  w.eval(`siteFeatures = Object.assign({}, siteFeatures || {}, { production: false });`);
  ok("…and Designs leaves the bar while the Production feature is off", !/>Designs</.test(w.shopBarHtml_({ shop: "northside", page: "products" })));
  w.eval(`siteFeatures = Object.assign({}, siteFeatures, { production: true });`);
  w.eval(`adminMe = null;`);
  w.location.hash = "#designs/northside"; w.eval(`window._shopBarCtx = { shop: "northside", page: "designs" };`); w.shopBarPick_("acme");
  ok("picking another shop opens the same page for it", w.location.hash === "#designs/acme");
  w.eval(`window._shopBarCtx = { shop: null, page: "categories" };`); w.shopBarPick_("acme");
  ok("…from a catalog-wide list it opens that shop's products", w.location.hash === "#catalog/orgs/acme/products");
  ok("the old per-page back buttons and shop switches are gone from Products, Designs, Graphics and the shop form",
    !/adminShopSwitch_/.test(adminJs) && !/&larr; All shops/.test(adminJs) && !/onclick="location\.hash='#catalog'">&larr; Manage catalog/.test(adminJs));
  ok("catalog screens are one max-width light column under a black bar", /#shopBar\{[^}]*background:#000/.test(indexHtml) && /body\.shop-mgmt #app\{max-width:1200px;[^}]*background:var\(--card\)/.test(indexHtml));
  ok("a page inside a menu entry lights up that entry (#designs/<shop>/3 → Designs)", (() => { w.location.hash = "#designs/acme/3"; return w.adminNavActive_() === "designs"; })());

  console.log("\n=== One heading, one tab title ===");
  w.eval(`window._bizNameCache = null;`);
  ok("tab titles read '<Business> — <Page> (Admin)'", / — Blanks \(Admin\)$/.test(w.adminTitle_("Blanks")));
  ok("every page sets its tab title through adminTitle_", !/document\.title = (?!adminTitle_\()/.test(adminJs));
  w.location.hash = "#threads";
  const head = w.adminPageHead_("Threads");
  ok("a page in a menu gets '<Menu> › <Page>' breadcrumbs above its title", /bc-group">Production</.test(head) && /bc-current">Threads</.test(head) && /<h1 class="org-name">Threads<\/h1>/.test(head));
  ok("the title is escaped", /&lt;b&gt;/.test(w.adminPageHead_("<b>x</b>", { crumbs: [] })));
  ok("no page builds the old one-line heading by hand any more", !/<div class="org-hero admin-hero" style="--org-accent:var\(--accent\);"><h1 class="org-name">/.test(adminJs));
  ok("'Manage Catalog' is 'Manage catalog' everywhere", !/Manage Catalog/.test(adminJs));

  console.log("\n=== 'Shop', not 'org' ===");
  ok("the catalog's buttons, headings and columns say shop", /＋ New shop setup<\/button>/.test(adminJs) && /<h2>Shops<\/h2>/.test(adminJs) && /<th>Shop ID<\/th>/.test(adminJs) && !/\+ New Org\b/.test(adminJs) && !/>Org<\/th>|>Org<\/label>|>Org<br>/.test(adminJs));
  ok("…and the shop form's own wording", /"Create shop"/.test(adminJs) && !/All orgs|pick an org|>[^<]*this org's|for this org\./.test(adminJs.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n")));

  console.log("\n=== Danger buttons ===");
  ok("destructive buttons share one class, not hand-picked reds", (adminJs.match(/admin-btn-danger/g) || []).length >= 40 && !/<button[^>]*style="[^"]*background:#fee2e2;color:#b03a2e/.test(adminJs));
  ok("…styled once in the page's CSS (red text on white, a solid red for the few that can't be undone)", /\.admin-btn-danger, \.admin-btn\.admin-btn-danger\{background:#fff;color:#b03a2e;/.test(indexHtml) && /\.admin-btn-danger\.admin-btn-danger-solid\{background:#b03a2e;color:#fff;/.test(indexHtml));

  console.log("\n=== The confirm window ===");
  let p = w.confirmModal_({ title: "Void <this>?", text: "It stays in history.", reason: "required", confirmLabel: "Void", danger: true });
  await tick();
  const modal = d.querySelector(".admin-modal.confirm-modal");
  ok("Void opens one styled window (title escaped), with a reason box", !!modal && /Void &lt;this&gt;\?/.test(modal.querySelector("h3").innerHTML) && !!d.getElementById("cmReason"));
  ok("a required reason keeps the button off until something is typed", d.getElementById("cmOk").disabled === true);
  d.getElementById("cmReason").value = "  Duplicate  "; d.getElementById("cmReason").dispatchEvent(new w.Event("input"));
  ok("…then it's on, and red", d.getElementById("cmOk").disabled === false && d.getElementById("cmOk").classList.contains("admin-btn-danger-solid"));
  d.getElementById("cmOk").click();
  let ans = await p;
  ok("it answers yes with the reason trimmed, and closes", ans.ok === true && ans.reason === "Duplicate" && !d.querySelector(".confirm-modal"));
  p = w.confirmModal_({ title: "Cancel this item?", reason: "optional" });
  await tick();
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ans = await p;
  ok("Escape answers no", ans.ok === false && !d.querySelector(".confirm-modal"));
  p = w.confirmModal_({ title: "Revoke?" });
  await tick();
  d.querySelector(".confirm-modal [data-modal-close]").click();
  ok("✕ answers no too", (await p).ok === false);
  ok("the old prompt() boxes for void / cancel / revoke / ignore reasons are gone",
    !/prompt\("(Bulk cancel|Cancel: |Void this entry|Why is this approval|Why can this line|Void reason)/.test(adminJs) && !/prompt\(`Mark order/.test(adminJs));

  console.log("\n=== Yes / no questions (askConfirm_) ===");
  ok("the admin never uses the browser's confirm() box any more", !/(?<![A-Za-z_.])confirm\(/.test(adminJs.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n")));
  let q = w.askConfirm_("Delete \"Hoop A\"? Its history stays.");
  await tick();
  let cm = d.querySelector(".confirm-modal");
  ok("a question becomes the shared window: the question as its title, the rest as the explanation", cm.querySelector("h3").textContent === 'Delete "Hoop A"?' && cm.querySelector(".cm-text").textContent === "Its history stays.");
  ok("…a delete gets a red button named for what it does", d.getElementById("cmOk").textContent === "Delete" && d.getElementById("cmOk").classList.contains("admin-btn-danger-solid") && d.getElementById("cmCancel").textContent === "Cancel");
  d.getElementById("cmOk").click();
  ok("…and answers true", (await q) === true);
  q = w.askConfirm_("Undo this void?\n\nThe entry will count again.");
  await tick();
  ok("a paragraph break also splits title from text; other questions get a plain button", d.querySelector(".confirm-modal h3").textContent === "Undo this void?" && d.getElementById("cmOk").textContent === "Undo" && !d.getElementById("cmOk").classList.contains("admin-btn-danger"));
  d.getElementById("cmCancel").click();
  ok("…Cancel answers false", (await q) === false);
  q = w.askConfirm_("Cancel this restock order? Its blanks will be suggested again.");
  await tick();
  ok("'Cancel this…' reads 'Yes, cancel it' / 'Keep it', so the two buttons can't be confused", d.getElementById("cmOk").textContent === "Yes, cancel it" && d.getElementById("cmCancel").textContent === "Keep it");
  d.getElementById("cmCancel").click(); await q;
  ok("leaving a form with unsaved changes asks in the same window (Leave / Stay)", /askConfirm_\("Leave without saving\?/.test(adminJs) && /confirmLabel: "Leave", cancelLabel: "Stay"/.test(adminJs));

  console.log("\n=== Windows and toasts ===");
  const zs = [...adminJs.matchAll(/z-index:(\d+)/g)].map(m => Number(m[1])).filter(z => z > 100);
  ok("every window sits at one level (9999)", zs.length >= 1 && zs.every(z => z === 9999));
  ok("toasts show above windows, so an error inside one is seen", Number((indexHtml.match(/\.toast-region\{\s*position:fixed; top:16px; right:16px; z-index:(\d+)/) || [])[1]) > 9999);

  console.log("\n=== Phones ===");
  d.body.insertAdjacentHTML("beforeend", `<table class="stack-mobile" id="t1"><thead><tr><th>Name</th><th>Qty</th><th></th></tr></thead>
    <tbody><tr><td>Thread A</td><td>3</td><td><button>Edit</button></td></tr><tr><td colspan="3">note</td></tr><tr><td data-label="Own">x</td><td>1</td><td></td></tr></tbody></table>`);
  await tick(30);
  const cells = [...d.querySelectorAll("#t1 tbody tr")].map(tr => [...tr.children].map(td => td.getAttribute("data-label")));
  ok("a list table marked stack-mobile gets its cells labelled from the headings (a card per row on a phone)", cells[0][0] === "Name" && cells[0][1] === "Qty" && cells[0][2] === null);
  ok("…leaving full-width rows and labels already set alone", cells[1][0] === null && cells[2][0] === "Own" && cells[2][1] === "Qty");
  ok("Threads, Hoops, Locations, Abort reasons, Transfers, Users, Blanks and Expenses lists are marked", (adminJs.match(/class="stack-mobile/g) || []).length >= 13);
  ok("every admin field is 16px on a phone (pages and windows), so iOS doesn't zoom", /\.admin-panel select, \.admin-panel textarea,[\s\S]{0,200}\.admin-modal select, \.admin-modal textarea\{font-size:16px!important;\}/.test(indexHtml) && /ov\.className = "admin-modal";/.test(adminJs));
  ok("the machine's hoop and needles say they save as you change them", /Current hoop:<\/b> <span[^>]*>\(saves as you change it\)/.test(adminJs) && /Needles<\/b> <span[^>]*>— saves as you change it/.test(adminJs));
  process.exit(0);
})().catch(e => { console.error(e); console.log("test crashed: false"); process.exit(1); });
