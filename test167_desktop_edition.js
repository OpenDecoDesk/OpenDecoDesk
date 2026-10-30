const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { splitSql, readSources, migrate } = require("./desktop/migrate.js");

// The desktop edition (desktop/, EDITION=desktop): the same code run on one computer. This file
// covers the parts that differ from a cloud install —
//   A. desktop/migrate.js builds and updates the database without wrangler.
//   B. localhost is the admin panel, and no other name is anything.
//   C. The features that need the internet are locked off, and the start-up step saves them off
//      and makes a default shop.
//   D. Actions that need the internet are refused.
//   E. Setup status lists only what the person running it fills in.
// A cloud install (no EDITION) behaves as before — every other test file runs without it.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const ok = (d, c) => { console.log(d + ":", !!c); };
const tables = (db) => db.q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY name").map(r => r.name);
const cols = (db, t) => db.q(`SELECT name, type, "notnull", hidden FROM pragma_table_xinfo('${t}') ORDER BY name`).map(c => c.name + ":" + c.type + ":" + c.notnull + ":" + c.hidden).join(",");
const named = (db, type) => db.q(`SELECT name FROM sqlite_master WHERE type='${type}' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map(r => r.name).join(",");

(async () => {
  const src = readSources(__dirname);

  console.log("=== A. The database: made and updated by desktop/migrate.js ===");
  {
    const stmts = splitSql("CREATE TABLE a (x TEXT DEFAULT 'a;b'); -- c;d\nCREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = CASE WHEN x = ';' THEN 'y' END; DELETE FROM a WHERE 0; END;\n/* only; a comment */ INSERT INTO \"we;ird\" VALUES (1);\n-- the end");
    ok("statements split at ';' but not inside strings, comments or a trigger's BEGIN … END", stmts.length === 3 && /^(--[^\n]*\n)?CREATE TRIGGER[\s\S]*END$/.test(stmts[1]) && /'a;b'/.test(stmts[0]) && /we;ird/.test(stmts[2]));
    const trig = splitSql(src.schema).filter(s => /CREATE\s+TRIGGER/i.test(s));
    ok("schema.sql's trigger stays one statement", trig.length === 1 && /END$/.test(trig[0]));

    const fresh = await createD1();
    const r = await migrate(fresh, src);
    const viaFile = await createD1();
    viaFile._raw.exec(src.schema);
    ok("a new database gets every table from schema.sql", r.isNew && tables(fresh).join() === tables(viaFile).join() && tables(fresh).length > 40);
    ok("…with the same columns, indexes and triggers", tables(fresh).every(t => cols(fresh, t) === cols(viaFile, t)) && named(fresh, "index") === named(viaFile, "index") && named(fresh, "trigger") === named(viaFile, "trigger"));
    ok("…and a record that every migration is part of it", Number(fresh.q("SELECT count(*) n FROM d1_migrations")[0].n) === src.migrations.length);
    let called = 0;
    const again = await migrate(fresh, src, { beforeChange: () => { called++; } });
    ok("starting again changes nothing and makes no backup", !again.isNew && again.applied.length === 0 && called === 0);

    // An older install: the database as it was before 0006, with 0001–0005 recorded. Every later
    // migration goes through migrate() — so every migration file is split and run the desktop way.
    const old = await createD1();
    old._raw.exec(read("testlib/schema-pre-0006.sql"));
    old._raw.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
    for (const m of src.migrations.filter(m => m.name < "0006")) old.q("INSERT INTO d1_migrations (name) VALUES (?)", m.name);
    let backedUp = null;
    const up = await migrate(old, src, { beforeChange: (names) => { backedUp = names; } });
    ok("an older database gets only the migrations it hasn't had, in order", up.applied.length === src.migrations.filter(m => m.name >= "0006").length && up.applied[0].startsWith("0006") && up.applied.join() === [...up.applied].sort().join());
    ok("…after the backup step, which is told what will be applied", Array.isArray(backedUp) && backedUp.join() === up.applied.join());
    ok("…and ends up with the same tables and columns as a new one", tables(old).join() === tables(viaFile).join() && tables(old).every(t => cols(old, t) === cols(viaFile, t)));

    // A migration that fails leaves the database as it was before it, and isn't recorded.
    const broken = { schema: src.schema, migrations: [...src.migrations, { name: "9999_broken.sql", sql: "CREATE TABLE half_done (x);\nALTER TABLE no_such_table ADD COLUMN y;" }] };
    let err = null;
    try { await migrate(fresh, broken); } catch (e) { err = e; }
    ok("a failing migration is reported with its name", err && /9999_broken\.sql/.test(err.message));
    ok("…and nothing of it is left behind", !tables(fresh).includes("half_done") && !fresh.q("SELECT 1 FROM d1_migrations WHERE name = '9999_broken.sql'").length);

    const odd = await createD1();
    odd._raw.exec("CREATE TABLE orgs (orgId TEXT)");
    err = null; try { await migrate(odd, src); } catch (e) { err = e; }
    ok("tables with no migration record are refused rather than guessed at", err && /can't be updated safely/.test(err.message));
  }

  console.log("\n=== B. localhost is the admin panel ===");
  const host = new Function(strip(read("functions/_lib/hostConfig.js")) + "\nreturn { classifyHost, isDesktopEdition, desktopLockedFeatures };")();
  const DESK = { EDITION: "desktop" };
  ok("in the desktop edition, localhost and 127.0.0.1 are the admin", host.classifyHost("localhost", {}, DESK).kind === "admin" && host.classifyHost("127.0.0.1", {}, DESK).kind === "admin");
  ok("…and any other name is refused (a page pointing its own name at this computer gets nothing)", host.classifyHost("evil.example.net", {}, DESK).kind === "unknown" && host.classifyHost("shop.example.com", { shop: "shop" }, { ...DESK, ROOT_DOMAIN: "example.com" }).kind === "unknown");
  ok("a cloud install still treats localhost as the root domain", host.classifyHost("localhost", {}, {}).kind === "root" && host.classifyHost("admin.example.com", {}, {}).kind === "admin");
  ok("only EDITION=desktop is the desktop edition", host.isDesktopEdition({ EDITION: " Desktop " }) && !host.isDesktopEdition({}) && !host.isDesktopEdition({ EDITION: "cloud" }) && !host.isDesktopEdition(null));

  console.log("\n=== C. Locked features, and the start-up step ===");
  const d1 = await createD1();
  await migrate(d1, src);
  const lib = new Function(strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/desktop.js")) +
    "\nreturn { getFeatures, setFeatures, getAllOrgs, ensureDesktopReady, DESKTOP_DEFAULT_SHOP };")();
  ok("the locked features are the storefront, carrier shipping and design approval", host.desktopLockedFeatures({ EDITION: "desktop" }).join() === "storefront,shipping,designVerification");
  ok("…and carrier shipping is unlocked once the program has a Shippo key", host.desktopLockedFeatures({ EDITION: "desktop", SHIPPO_API_KEY: "k" }).join() === "storefront,designVerification");
  let s = await lib.ensureDesktopReady({ DB: d1 });
  let f = await lib.getFeatures(d1);
  ok("the start-up step saves them off", s.changed && f.storefront === false && f.shipping === false && f.designVerification === false);
  ok("…and leaves production and bookkeeping on", f.production === true && f.bookkeeping === true);
  const shops = await lib.getAllOrgs(d1);
  ok("a database with no shop gets the default shop, open for orders", shops.length === 1 && shops[0].orgId === "shop" && shops[0].name === "My shop" && Number(shops[0].ready) === 1);
  ok("…with no card payments (there is no Stripe) and no carrier shipping", (typeof shops[0].enabledPayments === "string" ? JSON.parse(shops[0].enabledPayments) : shops[0].enabledPayments).card === false && Number(shops[0].shippingEnabled) === 0);
  const ver = Number(d1.q("SELECT value FROM global_settings WHERE key = 'catalogVersion'")[0].value);
  ok("…and the cached catalog is told to re-read", ver >= 1);
  await d1.prepare("UPDATE orgs SET name = 'Renamed' WHERE orgId = 'shop'").run();
  s = await lib.ensureDesktopReady({ DB: d1 });
  ok("the next start changes nothing (a renamed shop stays renamed, no second shop)", !s.changed && (await lib.getAllOrgs(d1)).length === 1 && (await lib.getAllOrgs(d1))[0].name === "Renamed");
  await lib.setFeatures(d1, { shipping: true });
  await lib.ensureDesktopReady({ DB: d1 });
  ok("a locked feature found on is switched off again at start-up", (await lib.getFeatures(d1)).shipping === false);

  // The admin's own requests, through the real orders.js.
  const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
    "const requireAdmin = async (env, host, key) => host.kind === 'admin' && key === 'x' ? null : jsonResponse({ status: 'error', message: 'Unauthorized' }, 401); const adminActor = () => 'test';\n" +
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
    "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async (env) => ({ subdomainMap: {}, ...(await getPublicCatalogData(env.DB)) });\n" +
    "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
    strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
  const post = async (env, body, hostname = "localhost") => {
    const res = await api({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url: `http://${hostname}:47123/api/orders`, json: async () => body, headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const env = { DB: d1, EDITION: "desktop" };
  let r = await post(env, { action: "getFeatures", key: "x" });
  ok("the admin is told which switches are locked", r.status === 200 && r.body.locked.join() === "storefront,shipping,designVerification");
  r = await post(env, { action: "updateFeatures", key: "x", features: { storefront: true } });
  ok("turning a locked feature on is refused, in plain words", r.status === 400 && r.body.message === "Storefront isn't part of the desktop version." && (await lib.getFeatures(d1)).storefront === false);
  r = await post(env, { action: "updateFeatures", key: "x", features: { production: false } });
  ok("the other switches still work", r.status === 200 && r.body.features.production === false && r.body.features.storefront === false);
  await post(env, { action: "updateFeatures", key: "x", features: { production: true } });
  r = await post({ DB: d1 }, { action: "getFeatures", key: "x" }, "admin.example.com");
  ok("a cloud install locks nothing", r.status === 200 && Array.isArray(r.body.locked) && r.body.locked.length === 0);
  r = await post(env, { action: "listOrgs", key: "x" }, "evil.example.net");
  ok("an admin request under any other name is refused", r.status === 404);

  console.log("\n=== D. Actions that need the internet ===");
  for (const action of ["sendTestEmail", "sendInvoice", "createShippingPaymentLink", "setupOrgDomain", "saveVendorConnection", "placeSupplierOrder", "copyVendorImage"]) {
    r = await post(env, { action, key: "x", org: "shop" });
    if (!(r.status === 403 && r.body.code === "desktop")) ok(action + " is refused in the desktop edition", false);
  }
  r = await post(env, { action: "sendTestEmail", key: "x" });
  ok("actions that need the internet are refused (403), saying why", r.status === 403 && /needs the internet/.test(r.body.message));
  r = await post(env, { action: "sendTestEmail", key: "wrong" });
  ok("…after the sign-in check, so a stranger learns nothing", r.status === 401);
  r = await post(env, { action: "listOrgs", key: "x" });
  ok("the back office itself answers", r.status === 200 && r.body.orgs.length === 1);
  const ordersSrc = read("functions/api/orders.js");
  const refused = (ordersSrc.match(/const DESKTOP_REFUSED_ACTIONS = new Set\(\[([\s\S]*?)\]\)/) || [])[1] || "";
  const names = refused.match(/"([A-Za-z]+)"/g).map(n => n.slice(1, -1));
  ok("every refused action is a real admin action", names.length > 10 && names.every(n => ordersSrc.includes(`body.action === "${n}"`)));

  console.log("\n=== E. Setup status ===");
  const { setupStatus } = new Function(strip(read("functions/_lib/setupStatus.js")) + "\nreturn { setupStatus };")();
  const items = setupStatus({ EDITION: "desktop", DB: d1 }, { business: {}, salesTax: {}, locale: {} });
  ok("the desktop list is the database, business profile, sales tax and time zone", items.map(i => i.key).join() === "database,business,salesTax,timeZone");
  ok("…with nothing about domains, email, buckets or online services", !items.some(i => /domain|email|bucket|stripe|shippo/i.test(i.key)));
  const named_ = setupStatus({ EDITION: "desktop", DB: d1 }, { business: { name: "Stitch Co" }, salesTax: {}, locale: {} });
  ok("a business name is all the profile needs (no email is sent)", named_.find(i => i.key === "business").ready === true);
  ok("a cloud install keeps the full list", setupStatus({ DB: d1 }, {}).some(i => i.key === "rootDomain") && setupStatus({ DB: d1 }, {}).length > 10);

  console.log("\n=== F. The desktop program (desktop/server.js) ===");
  const server = require("./desktop/server.js");
  // The real password code (adminAuth.js) makes the record; the program must read its mark the same way.
  const auth = await import("./functions/_lib/adminAuth.js");
  const pw = await createD1();
  await migrate(pw, src);
  const authEnv = { DB: pw, PROXY_ADMIN_PASSPHRASE: "p".repeat(64) };
  ok("with no users, the program offers its passphrase for the first sign-in", !(await server.adminHasUsablePassword(pw, authEnv.PROXY_ADMIN_PASSPHRASE)));
  pw.q("INSERT INTO users (email, name, role, status, createdAt, updatedAt) VALUES ('o@x.com', 'Owner', 'admin', 'active', 't', 't')");
  const owner = pw.q("SELECT id FROM users")[0].id;
  await auth.setUserPassword(authEnv, owner, "a long enough password");
  ok("once the owner has a password, it doesn't", await server.adminHasUsablePassword(pw, authEnv.PROXY_ADMIN_PASSPHRASE) && !(await auth.bootstrapState(authEnv)).open);
  ok("after Reset sign-in (a new passphrase) it does again — as the sign-in code agrees", !(await server.adminHasUsablePassword(pw, "q".repeat(64))) && (await auth.bootstrapState({ ...authEnv, PROXY_ADMIN_PASSPHRASE: "q".repeat(64) })).open);
  const csp = server.desktopCsp((read("public/_headers").match(/Content-Security-Policy: (.*)/) || [])[1]);
  ok("the window's security policy names no Cloudflare or Google address, and allows the bundled fonts", !/cloudflare|google|gstatic/.test(csp) && /font-src 'self'/.test(csp) && /default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp));
  ok("…and still lets the page reach the send-agent on this computer (machines)", /connect-src [^;]*http:\/\/127\.0\.0\.1:8787/.test(csp) && read("public/admin.js").includes('const EMBROIDERY_AGENT_URL = "http://127.0.0.1:8787"'));
  const os = require("os"), path = require("path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odd-desktop-"));
  fs.writeFileSync(path.join(tmp, "desktop.json"), JSON.stringify({ port: 47830, secretsProtected: "not readable here" }));
  let thrown = null;
  try { await server.startServer({ dataDir: tmp }); } catch (e) { thrown = e; }
  ok("saved secrets this computer can't read stop the start, rather than being replaced (which would void every password)", thrown && thrown.code === "SECRETS_UNREADABLE" && /secretsProtected/.test(fs.readFileSync(path.join(tmp, "desktop.json"), "utf8")));
  server.resetSignIn(tmp);
  const after = JSON.parse(fs.readFileSync(path.join(tmp, "desktop.json"), "utf8"));
  ok("…and Reset sign-in is the deliberate way past it: new secrets, the port kept", after.port === 47830 && after.secrets && /^[0-9a-f]{64}$/.test(after.secrets.PROXY_ADMIN_PASSPHRASE));
  thrown = null;
  try { server.restoreState(tmp, tmp); } catch (e) { thrown = e; }
  ok("restoring refuses a folder that isn't a backup", thrown && /isn't an OpenDecoDesk backup/.test(thrown.message));
  fs.rmSync(tmp, { recursive: true, force: true });
  ok("pictures are stored under an address that can never be a real site", /^https:\/\/[a-z.]+\.invalid$/.test(server.IMAGES_BASE));

  console.log("\n=== H. Shipping: by hand, and with a Shippo key ===");
  {
    const keyed = { ...env, SHIPPO_API_KEY: "shippo_test_key" };
    r = await post(env, { action: "updateFeatures", key: "x", features: { shipping: true } });
    ok("without a key, turning Shipping on is refused and says where the key goes", r.status === 400 && /needs a Shippo key — add it under Global settings → Carrier shipping/.test(r.body.message) && (await lib.getFeatures(d1)).shipping === false);
    r = await post(keyed, { action: "getFeatures", key: "x" });
    ok("with a key, Shipping is no longer locked", r.status === 200 && !r.body.locked.includes("shipping") && r.body.locked.includes("storefront"));
    r = await post(keyed, { action: "updateFeatures", key: "x", features: { shipping: true } });
    ok("…and can be turned on", r.status === 200 && r.body.features.shipping === true);
    await lib.ensureDesktopReady(keyed);
    ok("with a key, the start-up step leaves Shipping as the owner set it", (await lib.getFeatures(d1)).shipping === true);
    await lib.ensureDesktopReady(env);
    ok("…and once the key is removed, the next start switches it off again", (await lib.getFeatures(d1)).shipping === false);

    // Local sale → Ship this order (the form is shared, so a cloud install gets it too).
    const sale = (e, extra, hostname) => post(e, { action: "createLocalSale", key: "x", org: "shop", paymentMethod: "Cash", customerName: "Pat",
      items: [{ productId: "__custom__", name: "Club tee", qty: 2, customUnitPrice: 20, type: "shirt" }], ...extra }, hostname);
    const addr = { name: "Pat", line1: "1 Main St", city: "Columbus", state: "OH", zip: "43215" };
    r = await sale(env, { shippingAddress: addr, shippingCost: 9.5, shippingMethod: "UPS  Ground " });
    const row = r.status === 200 ? d1.q("SELECT * FROM orders WHERE orderId = ?", r.body.orderId)[0] : {};
    ok("a local sale that ships keeps its address, method and charge", r.status === 200 && JSON.parse(row.shippingAddress).line1 === "1 Main St" && row.shippingMethod === "UPS Ground" && Number(row.shippingCostCents) === 950);
    ok("…and the charge is part of what the customer pays", Number(row.totalCents) === 4950);
    r = await sale(env, { shippingCost: 9.5, shippingMethod: "UPS Ground" });
    ok("a shipping charge with no address to ship to is refused", r.status === 400 && /needs the address/.test(r.body.message));
    r = await sale(env, { shippingAddress: addr, shippingCost: -1 });
    ok("…and so is a charge that isn't a sensible amount", r.status === 400 && /between \$0 and \$10,000/.test(r.body.message));
    r = await sale({ DB: d1 }, { shippingAddress: addr, shippingCost: 4, shippingMethod: "USPS Ground Advantage" }, "admin.example.com");
    ok("a cloud install's Local sale takes shipping the same way", r.status === 200 && Number(d1.q("SELECT shippingCostCents c FROM orders WHERE orderId = ?", r.body.orderId)[0].c) === 400);
    r = await sale(env, {});
    ok("a sale that doesn't ship is as before", r.status === 200 && Number(d1.q("SELECT shippingCostCents c FROM orders WHERE orderId = ?", r.body.orderId)[0].c) === 0);

    // Tracking: the program's scheduled run (src/worker.js) only checks tracking, and only with a key.
    const worker = await import("./src/worker.js");
    const shipped = d1.q("SELECT orderId FROM orders WHERE shippingMethod = 'UPS Ground'")[0].orderId;
    d1._raw.run("UPDATE orders SET shippedAt = '2026-10-20T15:00:00Z', trackingNumber = '1Z999AA10123456784' WHERE orderId = ?", [shipped]);
    const realFetch = global.fetch, looked = [];
    global.fetch = async (u) => {
      looked.push(String(u));
      if (/api\.goshippo\.com\/tracks\//.test(String(u))) return { ok: true, json: async () => ({ tracking_status: { status: "DELIVERED", status_date: "2026-10-22T18:00:00Z" }, tracking_history: [] }) };
      throw new Error("unexpected request " + u);
    };
    let out = await worker.handleScheduled({ scheduledTime: Date.now() }, { ...env });
    ok("without a key the desktop's scheduled run does nothing (no lookups)", out.ran === false && looked.length === 0);
    out = await worker.handleScheduled({ scheduledTime: Date.now() }, { ...keyed });
    ok("with a key but Shipping off, it looks nothing up", out.ran === true && /turned off/.test(out.deliveries.skipped || "") && looked.length === 0);
    await lib.setFeatures(d1, { shipping: true });
    out = await worker.handleScheduled({ scheduledTime: Date.now() }, { ...keyed });
    ok("with Shipping on, it checks the tracking (with the carrier the order's method names) and marks the order delivered", out.deliveries.delivered.some(x => x.orderId === shipped) &&
      looked.some(u => /\/tracks\/ups\/1Z999AA10123456784$/.test(u)) && !!d1.q("SELECT deliveredAt d FROM orders WHERE orderId = ?", shipped)[0].d);
    ok("…and nothing else: no roll-up, no Stripe, no email (only Shippo was asked)", looked.every(u => /api\.goshippo\.com/.test(u)) && out.desktop === true);
    global.fetch = realFetch;
    await lib.setFeatures(d1, { shipping: false });
  }

  console.log("\n=== G. The admin page in the desktop program ===");
  // The real page and admin.js in jsdom, talking to the real catalog.js and orders.js above.
  const catalog = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/db.js")) + "\n" +
    "const getCatalogData = async (env) => ({ subdomainMap: {}, ...(await getPublicCatalogData(env.DB)) });\n" + strip(read("functions/api/catalog.js")) + "\nreturn onRequestGet;")();
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){
    if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs));
    const local = new URL(url).pathname.match(/^\/vendor\/fonts\/[a-z0-9.-]+$/);
    return local ? Promise.resolve(fs.readFileSync(__dirname + "/public" + local[0])) : super.fetch(url, o); } }
  const sent = [];
  let askedForKey = 0;
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "http://localhost:47830/", pretendToBeVisual: true,
    beforeParse(win){
      win.fetch = async (url, opts) => {
        if (String(url).includes("/api/orders") && opts && opts.body) {
          const body = JSON.parse(opts.body); sent.push(body.action);
          const res = await post(env, { ...body, key: "x" });
          return { ok: res.status < 400, status: res.status, json: async () => res.body };
        }
        if (String(url).includes("/api/catalog")) { const res = await catalog({ request: { url: "http://localhost:47830/api/catalog" }, env }); const body = JSON.parse(await res.text()); return { ok: res.ok, status: res.status, json: async () => body }; }
        return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) };
      };
      // What desktop/preload.js gives the page.
      win.oddDesktop = { edition: "desktop", firstRunKey: async () => { askedForKey++; return null; } };
      win.confirm = () => true;
      win.CSS = win.CSS || { escape: (x) => String(x) };
    } });
  const w = dom.window, doc = w.document;
  const tick = (ms) => new Promise(res => setTimeout(res, ms || 40));
  await tick(200);
  ok("the page learns it is in the desktop program from /api/catalog", w.eval("siteEdition") === "desktop" && w.eval("featureOn_('storefront')") === false);
  await w.loadAdminScript();
  await tick(200);
  ok("signing in first asks the program for its first-run passphrase", askedForKey >= 1);
  w.eval('adminKey = "x"; adminOrgs = [{orgId:"shop", name:"My shop"}]; window._ordersFilter = {from:"", to:""};');
  w.renderAdminNav();
  const navLabels = [...doc.querySelectorAll("#adminNav .admin-nav-row .admin-nav-btn")].map(b => b.textContent.trim());
  ok("the menu has no Communications or Vendor integrations", !navLabels.includes("Communications") && !navLabels.includes("Vendor integrations"));
  ok("…and keeps the back office (Orders, Blanks, Expenses, Global settings, Machines)", ["Orders", "Blanks", "Expenses", "Global settings", "Machines"].every(l => navLabels.includes(l)));
  sent.length = 0;
  w.location.hash = "#comms"; await w.adminRoute(); await tick(60);
  ok("opening one of those pages says it isn't in the desktop version, and asks the server nothing", !!doc.getElementById("desktopOffPanel") && sent.length === 0);
  const cell = w.adminActionCell({ orgId: "shop" }, { orderId: "X1", paid: false, items: [{}], balanceDue: 20 });
  ok("an order has no Send received / Resend email or Send invoice button", /Mark as paid/.test(cell) && !/resendEmail|showSendInvoiceModal/.test(cell));
  ok("a paid one has no email button either", !/resendEmail/.test(w.adminActionCell({ orgId: "shop" }, { orderId: "X2", paid: true, items: [{}], shippingAddress: { line1: "1 Main" } })));
  ok("there is nothing to publish", w.publishStateHtml_({ state: "never" }) === "");
  const shippo = w.desktopShippoSectionHtml_(false, false);
  ok("Global settings explains carrier shipping by hand and with a Shippo key, and takes the key in a password field", /Ship this order/.test(shippo) && /No Shippo key yet/.test(shippo) && /type="password" id="gShippoKey"/.test(shippo) && !/gShippoRemove/.test(shippo));
  ok("…with a key set it offers to remove it, and never shows the key", /A Shippo key is set — turn on Shipping/.test(w.desktopShippoSectionHtml_(true, false)) && /gShippoRemove/.test(w.desktopShippoSectionHtml_(true, true)));
  ok("a tracking number on an order sent by FedEx links to FedEx", /fedex\.com\/fedextrack\/\?trknbr=7712/.test(w.trackingCell({ orgId: "shop" }, { orderId: "F1", trackingNumber: "7712", shippingMethod: "FedEx Ground", items: [{}], labels: [] })));
  ok("Local sale has a Ship this order section with the address, carrier and charge", ["lsShip", "lsShipLine1", "lsShipCity", "lsShipZip", "lsShipCarrier", "lsShipService", "lsShipCost"].every(id => adminJs.includes(`id="${id}"`)) && !adminJs.includes('id="lsAddress"'));
  w.eval('siteEdition = ""');
  ok("…while a cloud install's admin keeps all of them", /resendEmail/.test(w.adminActionCell({ orgId: "shop" }, { orderId: "X1", paid: false, items: [{}], balanceDue: 20 })) && /showSendInvoiceModal/.test(w.adminActionCell({ orgId: "shop" }, { orderId: "X1", paid: false, items: [{}], balanceDue: 20 })) && /Not published yet/.test(w.publishStateHtml_({ state: "never" })));
  ok("the page loads its fonts from this site, not Google", /href="\/vendor\/fonts\/fonts\.css"/.test(read("public/index.html")) && !/googleapis|gstatic/.test(read("public/index.html") + adminJs + read("public/_headers")) && fs.existsSync(__dirname + "/public/vendor/fonts/OFL-Fraunces.txt"));
  ok("every font file the stylesheet names is there", (read("public/vendor/fonts/fonts.css").match(/url\(([^)]+)\)/g) || []).every(u => fs.existsSync(__dirname + "/public/vendor/fonts/" + u.slice(4, -1))));
  w.close();
})().catch(e => { console.error(e); process.exit(1); });
