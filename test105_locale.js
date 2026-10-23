const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");

// Region (Global settings): ONE time zone for everything the server dates — saved setting, else the
// TIMEZONE variable, else UTC — and a country ("US" by default, or "OTHER") that decides whether
// addresses are held to US formats. Not full internationalisation: outside the US the postal code
// and state / region are free text and carrier shipping isn't offered.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { getLocaleSettings, setLocaleSettings, resolveTimeZone, isValidTimeZone, dateInTimeZone, localToday, cleanShippingAddress, isOutOfState, " +
  "getOrderById, getPublicCatalogData, createProduct, getOrgById, getSalesTaxSettings, getShipFromAddress, zipStates };")();
const SUBS = { acme: "acme", shipper: "shipper" };
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/quoteToken.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => { global.__inval105 = (global.__inval105 || 0) + 1; }; const getCatalogData = async () => ({ subdomainMap: " + JSON.stringify(SUBS) + ", orgs: {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn { post: onRequestPost, signQuote, canonicalItems };")();
const E = new Function(dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\nreturn { sendDigestHeartbeatEmail, sendDailyDigestEmail, sendPaymentConfirmedEmail };")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const sch = await import("./functions/_lib/schedule.js");
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES ('acme','acme','Acme','t','t',1,0), ('shipper','shipper','Shipper','t','t',1,1);`);
  for (const org of ["acme", "shipper"]) await lib.createProduct(d1, org, { productId: "tee", type: "shirt", name: "Tee", pricingMode: "sized", sizePricing: { M: 20 }, visible: true, weightOz: 6 });
  const env = { DB: d1, QUOTE_SIGNING_SECRET: "q".repeat(40), ...MAIL_ENV };
  let emails = [];
  global.fetch = async (url, init) => captureMail(url, init, emails) ? MAIL_OK : { ok: true, json: async () => ({}) };
  const post = async (host, body, e = env) => {
    const res = await api.post({ env: e, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url: `https://${host}.example.com/api/orders`, json: async () => body, headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body, e) => post("admin", Object.assign({ key: "x" }, body), e);
  const settle = () => new Promise(res => setTimeout(res, 20));

  console.log("=== Time zone: saved > TIMEZONE > UTC ===");
  ok("nothing saved, nothing set: UTC (never a US zone)", (await lib.resolveTimeZone({ DB: d1 })) === "UTC" && (await lib.resolveTimeZone({})) === "UTC" && (await lib.resolveTimeZone(null)) === "UTC");
  ok("only the TIMEZONE variable: that zone", (await lib.resolveTimeZone({ DB: d1, TIMEZONE: "America/Chicago" })) === "America/Chicago" && (await lib.resolveTimeZone({ TIMEZONE: "Europe/Paris" })) === "Europe/Paris");
  ok("a TIMEZONE the runtime doesn't know counts as not set", (await lib.resolveTimeZone({ DB: d1, TIMEZONE: "Mars/Olympus" })) === "UTC");
  ok("a database that can't be read falls through to TIMEZONE", (await lib.resolveTimeZone({ DB: { prepare(){ throw new Error("down"); } }, TIMEZONE: "Asia/Tokyo" })) === "Asia/Tokyo");
  ok("a new install: no saved zone, country US", JSON.stringify(await lib.getLocaleSettings(d1)) === JSON.stringify({ timeZone: "", country: "US" }));
  let r = await admin({ action: "getLocaleSettings" }, { ...env, TIMEZONE: "America/Chicago" });
  ok("the admin is told what's in force and where it comes from", r.status === 200 && r.body.locale.timeZone === "" && r.body.effectiveTimeZone === "America/Chicago" && r.body.envTimeZone === "America/Chicago");
  r = await admin({ action: "updateLocaleSettings", locale: { timeZone: "Eastern", country: "US" } });
  ok("a made-up zone name is refused with an example of a real one", r.status === 400 && /isn't a time zone/.test(r.body.message) && /Europe\/London/.test(r.body.message) && (await lib.getLocaleSettings(d1)).timeZone === "");
  r = await admin({ action: "updateLocaleSettings", locale: { timeZone: "Not/AZone" } });
  ok("…so is one that only looks like an IANA name", r.status === 400 && !lib.isValidTimeZone("Not/AZone") && !lib.isValidTimeZone("") && !lib.isValidTimeZone(null) && lib.isValidTimeZone("Asia/Kolkata"));
  r = await admin({ action: "updateLocaleSettings", locale: { timeZone: "Europe/London", country: "FR" } });
  ok("a country that isn't offered is refused, and nothing is half-saved", r.status === 400 && /US or OTHER/.test(r.body.message) && (await lib.getLocaleSettings(d1)).timeZone === "");
  const invalBefore = global.__inval105 || 0;
  r = await admin({ action: "updateLocaleSettings", locale: { timeZone: "  Europe/London ", country: "US" } });
  await settle();
  ok("a real zone saves (trimmed)", r.status === 200 && r.body.locale.timeZone === "Europe/London" && r.body.effectiveTimeZone === "Europe/London");
  ok("the saved zone beats the TIMEZONE variable", (await lib.resolveTimeZone({ DB: d1, TIMEZONE: "America/Chicago" })) === "Europe/London");
  const aud = d1.q("SELECT detail FROM audit_log WHERE action='settings.locale_set'");
  ok("the change is audited with what changed, and the storefront's cached catalog is refreshed", aud.length === 1 && /"timeZone":\{"from":"","to":"Europe\/London"\}/.test(aud[0].detail) && !/country/.test(aud[0].detail) && (global.__inval105 || 0) > invalBefore);
  ok("both actions are on the admin-only list, next to the business profile's", /"getBusinessProfile", "updateBusinessProfile",\s*"getLocaleSettings", "updateLocaleSettings"/.test(read("functions/api/orders.js")));
  r = await admin({ action: "updateLocaleSettings", locale: { timeZone: "" } });
  ok("a blank zone clears it — back to TIMEZONE, then UTC — and leaves the country alone", r.status === 200 && (await lib.resolveTimeZone({ DB: d1, TIMEZONE: "America/Chicago" })) === "America/Chicago" && (await lib.resolveTimeZone({ DB: d1 })) === "UTC" && r.body.locale.country === "US");

  console.log("\n=== Dates the server prints follow the zone ===");
  ok("the calendar day depends on the zone", lib.dateInTimeZone("2026-03-01T23:30:00Z", "UTC") === "2026-03-01" && lib.dateInTimeZone("2026-03-01T23:30:00Z", "Asia/Tokyo") === "2026-03-02" &&
    lib.dateInTimeZone("2026-03-01T03:30:00Z", "America/Los_Angeles") === "2026-02-28" && lib.dateInTimeZone("2026-03-01T23:30:00Z", "Nope/Nope") === "2026-03-01");
  await lib.setLocaleSettings(d1, { timeZone: "Asia/Tokyo" });
  ok("\"today\" is the business's day, not UTC's", (await lib.localToday({ DB: d1 }, new Date("2026-03-01T23:30:00Z"))) === "2026-03-02" && (await lib.localToday({}, new Date("2026-03-01T23:30:00Z"))) === "2026-03-01");
  const heartbeat = async (e) => { emails = []; await E.sendDigestHeartbeatEmail(e, { lastSentAt: "2026-03-01T23:30:00Z" }); return emails[0] ? emails[0].body : ""; };
  const tokyo = await heartbeat(env);
  ok("the roll-up's \"last roll-up on …\" is in Tokyo time (Mar 2, 8:30 AM)", /since the last roll-up on Mar 2, 8:30\sAM/.test(tokyo));
  await lib.setLocaleSettings(d1, { timeZone: "Europe/London" });
  const london = await heartbeat(env);
  ok("…in London time it's still Mar 1, 11:30 PM (GMT in March)", /since the last roll-up on Mar 1, 11:30\sPM/.test(london));
  emails = []; await E.sendDigestHeartbeatEmail(env, { lastSentAt: "2026-07-01T23:30:00Z" });
  ok("…and in July London is an hour ahead of UTC (Jul 2, 12:30 AM)", /since the last roll-up on Jul 2, 12:30\sAM/.test(emails[0].body));
  await lib.setLocaleSettings(d1, { timeZone: "" });
  const utc = await heartbeat(env);
  ok("with nothing set it's UTC, and differs from Tokyo's", /since the last roll-up on Mar 1, 11:30\sPM/.test(utc) && utc !== tokyo);
  ok("only TIMEZONE set: that zone is used (Chicago: Mar 1, 5:30 PM)", /since the last roll-up on Mar 1, 5:30\sPM/.test(await heartbeat({ ...env, TIMEZONE: "America/Chicago" })));
  const order = { orderId: "TZ-1", customerName: "Cust", contact: "c@x.com", items: [], total: 10, effectiveTotal: 10, paymentMethod: "Venmo" };
  await lib.setLocaleSettings(d1, { timeZone: "Asia/Tokyo" });
  emails = []; await E.sendPaymentConfirmedEmail(env, order, "2026-03-01T23:30:00Z");
  const paidTokyo = emails[0].htmlBody + emails[0].body;
  await lib.setLocaleSettings(d1, { timeZone: "" });
  emails = []; await E.sendPaymentConfirmedEmail(env, order, "2026-03-01T23:30:00Z");
  ok("a customer's \"payment confirmed\" date is the business's day too (March 2 in Tokyo, March 1 in UTC)", /March 2, 2026/.test(paidTokyo) && !/March 1, 2026/.test(paidTokyo) && /March 1, 2026/.test(emails[0].htmlBody + emails[0].body));
  emails = [];
  await lib.setLocaleSettings(d1, { timeZone: "Asia/Tokyo" });
  await E.sendDailyDigestEmail(env, { orders: [{ orderId: "TZ-2", orgId: "acme", customerName: "Cust", contact: "c@x.com", items: [], total: 10, paymentMethod: "Venmo", placedAt: "2026-03-01T23:30:00Z" }], orgNames: { acme: "Acme" } });
  ok("the roll-up lists an order at its local time (Mar 2, 8:30 AM in Tokyo)", emails.length === 1 && /Mar 2, 8:30\sAM/.test(emails[0].htmlBody + emails[0].body));

  console.log("\n=== The roll-up's hour ===");
  const tick = async (e, iso) => sch.isDigestHour(e, new Date(iso), await lib.resolveTimeZone(e));
  ok("saved Tokyo: 6 AM there is 21:00 UTC the day before, not 06:00 or 10:00 UTC", (await tick(env, "2026-07-14T21:00:00Z")) && !(await tick(env, "2026-07-15T06:00:00Z")) && !(await tick(env, "2026-07-15T10:00:00Z")));
  ok("…and the saved zone wins over TIMEZONE there too", (await tick({ ...env, TIMEZONE: "America/Chicago" }, "2026-07-14T21:00:00Z")) && !(await tick({ ...env, TIMEZONE: "America/Chicago" }, "2026-07-15T11:00:00Z")));
  await lib.setLocaleSettings(d1, { timeZone: "" });
  ok("only TIMEZONE set: the roll-up keeps its local hour (Chicago 6 AM = 11:00 UTC in summer, 12:00 in winter)", (await tick({ ...env, TIMEZONE: "America/Chicago" }, "2026-07-15T11:00:00Z")) && (await tick({ ...env, TIMEZONE: "America/Chicago" }, "2026-12-15T12:00:00Z")) && !(await tick({ ...env, TIMEZONE: "America/Chicago" }, "2026-12-15T11:00:00Z")));
  ok("nothing set: 06:00 UTC", (await tick(env, "2026-07-15T06:00:00Z")) && !(await tick(env, "2026-07-15T10:00:00Z")));
  ok("DIGEST_HOUR still applies with a saved zone", sch.isDigestHour({ DIGEST_HOUR: "9" }, new Date("2026-07-15T00:00:00Z"), "Asia/Tokyo") === true);
  const code = ["functions/_lib/db.js", "functions/_lib/email.js", "functions/_lib/schedule.js", "functions/_lib/deliveryCheck.js", "functions/api/daily-digest.js", "functions/api/orders.js", "src/worker.js", "public/admin.js", "public/index.html", "wrangler.toml", "scripts/setup.mjs"];
  ok("no US zone is written into the code or its copy", code.every(f => !/\b(Eastern|Central|Mountain|Pacific) (Standard |Daylight )?[Tt]ime\b|\b(EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b/.test(read(f).replace(/<option value="America\/[A-Za-z_]+">|"America\/[A-Za-z_]+"(, )?/g, ""))));

  console.log("\n=== Country US (the default): exactly as before ===");
  const C = lib.cleanShippingAddress;
  const usAddr = { name: "Pat", line1: "1 Main St", city: "Columbus", state: "ohio", zip: "43004" };
  ok("a US address is normalised to its 2-letter state", C(usAddr).address.state === "OH" && C(usAddr, "US").address.state === "OH" && C(usAddr, undefined).address.zip === "43004");
  ok("a postal code that isn't a ZIP is refused", /5 digits/.test(C({ ...usAddr, zip: "SW1A 1AA" }).error) && /5 digits/.test(C({ ...usAddr, zip: "4300" }, "US").error));
  ok("a state that isn't one is refused", /2-letter US state/.test(C({ ...usAddr, state: "Ontario" }).error));
  ok("a ZIP that contradicts the state is refused", /is in OH, but the state says PA/.test(C({ ...usAddr, state: "PA" }).error));
  ok("ZIP+4 is fine, and a blank state is filled in from the ZIP", C({ ...usAddr, zip: "43004-1234" }).address.state === "OH" && C({ ...usAddr, state: "" }).address.state === "OH");
  const items = [{ productId: "tee", size: "M", qty: 1 }];
  const place = (id, extra, host = "acme") => post(host, Object.assign({ orderId: id, orgId: host, customerName: "Cust", contact: "c@x.com", paymentMethod: "Venmo", items }, extra));
  r = await place("US-BADZIP", { shippingAddress: { ...usAddr, zip: "SW1A 1AA" } });
  ok("placing an order with a bad ZIP is refused", r.status === 400 && /5 digits/.test(r.body.message) && !(await lib.getOrderById(d1, "US-BADZIP")));
  r = await place("US-MISMATCH", { shippingAddress: { ...usAddr, state: "PA" } });
  ok("…and with a ZIP in another state than the one given", r.status === 400 && /but the state says PA/.test(r.body.message));
  // An address belongs to an order that is shipped by carrier: it comes with the signed quote for its ZIP.
  const usTok = await api.signQuote(env, { orgId: "shipper", zip: "43004", items: api.canonicalItems(items), amountCents: 900, method: "USPS Ground" });
  r = await place("US-OK", { shippingAddress: usAddr, shippingQuoteToken: usTok }, "shipper");
  ok("a good one, on an order with a carrier quote, is stored normalised", r.status === 200 && (await lib.getOrderById(d1, "US-OK")).shippingAddress.state === "OH");
  r = await place("US-PICKUP", { shippingAddress: usAddr });
  ok("pickup has no ship-to address: one sent along with it isn't kept", r.status === 200 && !(await lib.getOrderById(d1, "US-PICKUP")).shippingAddress);
  r = await admin({ action: "setShippingInfo", org: "shipper", orderId: "US-OK", shippingAddress: { ...usAddr, zip: "SW1A 1AA" } });
  ok("setShippingInfo refuses a bad ZIP", r.status === 400 && /5 digits/.test(r.body.message));
  r = await admin({ action: "setShippingInfo", org: "shipper", orderId: "US-OK", shippingAddress: { ...usAddr, state: "TX" } });
  ok("setShippingInfo refuses a ZIP/state mismatch", r.status === 400 && /but the state says TX/.test(r.body.message));
  r = await admin({ action: "setShippingInfo", org: "shipper", orderId: "US-OK", shippingAddress: usAddr });
  ok("…and a good address is stamped US", r.status === 200 && r.body.shippingAddress.country === "US" && r.body.shippingAddress.state === "OH");
  r = await admin({ action: "updateSalesTaxSettings", ratePercent: 6, jurisdiction: "Ontario" });
  ok("the tax home state must be a 2-letter code", r.status === 400 && /2-letter/.test(r.body.message));
  r = await admin({ action: "updateShipFromAddress", shipFrom: { street1: "1 Main", city: "London", state: "England", zip: "SW1A 1AA" } });
  ok("the ship-from address must have a ZIP and a 2-letter state", r.status === 400);
  r = await admin({ action: "updateOrg", orgId: "acme", subdomain: "acme", name: "Acme", ready: true, deliveryOptions: [{ type: "pickup" }, { type: "shipping" }] });
  ok("a shop can offer carrier shipping", r.status === 200 && (await lib.getOrgById(d1, "acme")).shippingEnabled === true);
  await admin({ action: "updateOrg", orgId: "acme", subdomain: "acme", name: "Acme", ready: true, deliveryOptions: [{ type: "pickup" }, { type: "custom", label: "Hand delivery", fee: 5 }] });
  const handId = (await lib.getOrgById(d1, "acme")).deliveryOptions[1].id;

  const catalog = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "const getReadyToShipByOrg = async () => []; const getBlankReadyByOrg = async () => ({});\nlet getCatalogData;\n" + strip(read("functions/api/catalog.js")) + "\nreturn { get: onRequestGet, set: (f) => { getCatalogData = f; } };")();
  catalog.set(async () => lib.getPublicCatalogData(d1));
  const cat = async (host) => { const res = await catalog.get({ request: { url: `https://${host}.example.com/api/catalog` }, env }); return JSON.parse(await res.text()); };
  let c = await cat("shipper");
  ok("the catalog tells the storefront the country (US), and a shipping shop offers shipping", c.country === "US" && c.catalog.shippingEnabled === true && c.catalog.deliveryOptions.map(o => o.type).join() === "pickup,shipping");
  ok("the admin host and an unknown host are told the country too — and nothing about the time zone", (await cat("admin")).country === "US" && (await cat("nobody")).country === "US" && !/timeZone/.test(JSON.stringify(await cat("shipper"))));

  console.log("\n=== Country OTHER: postal code and region are free text ===");
  r = await admin({ action: "updateLocaleSettings", locale: { country: "other" } });
  await settle();
  ok("the country saves (any case) and is audited", r.status === 200 && r.body.locale.country === "OTHER" && d1.q("SELECT detail FROM audit_log WHERE action='settings.locale_set' ORDER BY id DESC LIMIT 1")[0].detail.includes('"country":{"from":"US","to":"OTHER"}'));
  const uk = { name: "Pat", line1: "10 Downing St", city: "London", state: "  Greater   London ", zip: " SW1A 1AA " };
  const clean = C(uk, "OTHER").address;
  ok("an address is trimmed and capped, the region kept as typed (not upper-cased, not cut to 2 letters)", clean.zip === "SW1A 1AA" && clean.state === "Greater London" && clean.city === "London" &&
    C({ ...uk, zip: "x".repeat(60), state: "y".repeat(90) }, "OTHER").address.zip.length === 20 && C({ ...uk, state: "y".repeat(90) }, "OTHER").address.state.length === 50);
  ok("the ZIP-vs-state check doesn't run — even for something that looks like a US ZIP in the wrong state", C({ ...usAddr, state: "PA" }, "OTHER").address.state === "PA" && C({ ...uk, state: "" }, "OTHER").address.state === "");
  ok("unknown fields are still dropped", !("evil" in C({ ...uk, evil: "<script>" }, "OTHER").address));
  r = await place("UK-1", { shippingAddress: uk });
  let o = await lib.getOrderById(d1, "UK-1");
  ok("a storefront order here has no carrier shipment, so an address sent with it isn't kept (the shop adds one below)", r.status === 200 && !o.shippingAddress);
  r = await place("CA-1", { shippingAddress: { name: "Pat", line1: "1 Yonge St", city: "Toronto", state: "Ontario", zip: "M5E 1W7" }, deliveryOptionId: handId });
  o = await lib.getOrderById(d1, "CA-1");
  ok("…nor with the shop's own delivery option, which is charged at ITS fee", r.status === 200 && !o.shippingAddress && o.shippingCost === 5 && o.shippingMethod === "Hand delivery");
  r = await admin({ action: "setShippingInfo", org: "acme", orderId: "UK-1", shippingAddress: { line1: "221B Baker St", city: "London", state: "London", zip: "NW1 6XE" }, shippingCost: 7.5, shippingMethod: "Royal Mail" });
  o = await lib.getOrderById(d1, "UK-1");
  ok("setShippingInfo takes a postcode, and doesn't stamp the address US", r.status === 200 && o.shippingAddress.zip === "NW1 6XE" && o.shippingAddress.state === "London" && !o.shippingAddress.country && o.shippingCost === 7.5);
  r = await admin({ action: "setShippingInfo", org: "acme", orderId: "UK-1", shippingAddress: { line1: "221B Baker St", city: "London", state: "London", zip: "" } });
  ok("…but still needs a postal code", r.status === 400 && /postal code/.test(r.body.message));
  r = await admin({ action: "createLocalSale", org: "acme", customerName: "Walk-in", paymentMethod: "Cash", items: [{ productId: "tee", name: "Tee", type: "shirt", size: "M", qty: 1 }], shippingAddress: { line1: "5 Rue de Rivoli", city: "Paris", zip: "75001 CEDEX", state: "Île-de-France" } });
  o = r.body.orderId ? await lib.getOrderById(d1, r.body.orderId) : null;
  ok("a local sale's address follows the same rule", r.status === 200 && !!o && o.shippingAddress.state === "Île-de-France" && o.shippingAddress.zip === "75001 CEDEX");
  r = await admin({ action: "updateShipFromAddress", shipFrom: { name: "Acme", street1: "1 High St", city: "Leeds", state: "West Yorkshire", zip: "LS1 4AP", phone: "+44 113 496 0000" } });
  ok("the ship-from address takes a region and a postcode too", r.status === 200 && r.body.shipFrom.state === "West Yorkshire" && r.body.shipFrom.zip === "LS1 4AP" && r.body.shipFrom.phone === "+44 113 496 0000");

  console.log("\n=== Sales tax: in or out of the home region ===");
  r = await admin({ action: "updateSalesTaxSettings", ratePercent: 10, jurisdiction: "  Ontario ", taxMode: "exclusive" });
  ok("the home region is free text", r.status === 200 && (await lib.getSalesTaxSettings(d1)).jurisdiction === "Ontario");
  ok("the comparison ignores case and spacing; a blank region is at home", lib.isOutOfState("ontario", "Ontario") === false && lib.isOutOfState(" ONTARIO ", "Ontario") === false && lib.isOutOfState("Quebec", "Ontario") === true && lib.isOutOfState("", "Ontario") === false);
  const addrIn = (state) => ({ name: "Pat", line1: "1 Yonge St", city: "Toronto", state, zip: "M5E 1W7" });
  // Where an order goes is the shop's to record here (Edit shipping): a customer's request can't say it.
  for (const id of ["TAX-IN", "TAX-OUT", "TAX-PICKUP"]) await place(id, {});
  await admin({ action: "setShippingInfo", org: "acme", orderId: "TAX-IN", shippingAddress: addrIn("ontario") });
  await admin({ action: "setShippingInfo", org: "acme", orderId: "TAX-OUT", shippingAddress: addrIn("Québec") });
  await place("TAX-CLAIM", { shippingAddress: addrIn("Québec") });
  const [tin, tout, tpick, tclaim] = [await lib.getOrderById(d1, "TAX-IN"), await lib.getOrderById(d1, "TAX-OUT"), await lib.getOrderById(d1, "TAX-PICKUP"), await lib.getOrderById(d1, "TAX-CLAIM")];
  ok("shipped within the home region (typed in lower case): taxed — $20 + $2.00", tin.salesTax === 2 && tin.effectiveTotal === 22);
  ok("shipped to another region: not taxed — $20.00", tout.salesTax === 0 && tout.effectiveTotal === 20);
  ok("pickup (no address): taxed as the home region", tpick.salesTax === 2);
  ok("a pickup order that merely claims another region is taxed all the same", tclaim.salesTax === 2 && !tclaim.shippingAddress);
  r = await admin({ action: "setShippingInfo", org: "acme", orderId: "TAX-OUT", shippingAddress: addrIn("ONTARIO") });
  ok("moving an order's address into the home region puts the tax on", r.status === 200 && (await lib.getOrderById(d1, "TAX-OUT")).salesTax === 2);
  await admin({ action: "updateSalesTaxSettings", ratePercent: 0, jurisdiction: "", taxMode: "inclusive" });

  console.log("\n=== Carrier shipping isn't offered outside the US ===");
  r = await admin({ action: "updateOrg", orgId: "acme", subdomain: "acme", name: "Acme", ready: true, deliveryOptions: [{ type: "pickup" }, { type: "shipping" }] });
  ok("a shop can't add the Shipping option, and is told what to use instead", r.status === 400 && /only available when the country/.test(r.body.message) && /custom delivery option/.test(r.body.message) && (await lib.getOrgById(d1, "acme")).shippingEnabled === false);
  r = await admin({ action: "createOrg", orgId: "newshop", subdomain: "newshop", name: "New", deliveryOptions: [{ type: "shipping" }] });
  ok("…nor can a new shop start with it", r.status === 400 && !(await lib.getOrgById(d1, "newshop")));
  r = await admin({ action: "updateOrg", orgId: "acme", subdomain: "acme", name: "Acme", ready: true, deliveryOptions: [{ type: "pickup" }, { type: "custom", label: "Hand delivery", fee: 5, id: handId }, { type: "custom", label: "Courier", fee: 12 }] });
  ok("pickup and custom options still save", r.status === 200 && (await lib.getOrgById(d1, "acme")).deliveryOptions.length === 3);
  r = await admin({ action: "updateOrg", orgId: "shipper", subdomain: "shipper", name: "Shipper renamed", ready: true, shippingEnabled: true });
  ok("a shop that already had shipping can still be edited", r.status === 200 && (await lib.getOrgById(d1, "shipper")).name === "Shipper renamed");
  const token = await api.signQuote(env, { orgId: "shipper", zip: "43004", items: api.canonicalItems(items), amountCents: 900, method: "USPS Ground" }).catch(() => null);
  r = await place("SHIP-Q", { shippingAddress: usAddr, shippingQuoteToken: token || "x.y" }, "shipper");
  ok("…but an order with a carrier quote is refused there, with a clear message", r.status === 400 && /Carrier shipping isn't available/.test(r.body.message) && !(await lib.getOrderById(d1, "SHIP-Q")));
  r = await place("SHIP-M", { shippingAddress: uk, manualShipping: true }, "shipper");
  ok("…and so is a \"quote to follow\" shipment", r.status === 400 && /Carrier shipping isn't available/.test(r.body.message));
  r = await place("SHIP-P", {}, "shipper");
  ok("its pickup option keeps working", r.status === 200 && (await lib.getOrderById(d1, "SHIP-P")).shippingCost === 0);
  c = await cat("shipper");
  ok("the catalog says OTHER and leaves the shipping option out for the storefront", c.country === "OTHER" && c.catalog.shippingEnabled === false && c.catalog.deliveryOptions.map(o => o.type).join() === "pickup");
  ok("…while a shop's own options are all there", (await cat("acme")).catalog.deliveryOptions.map(o => o.label).join("|") === "Local pickup|Hand delivery|Courier");
  {
    const g = { rateLimited: async () => ({ blocked: false }), getBoxPresets: async () => null, selectBox: () => ({ box: {}, packing: 0, boxWeightOz: 0 }),
      getProductsByOrg: async () => [{ productId: "tee", type: "shirt", weightOz: 6 }], getShipFromAddress: async () => ({ zip: "43004" }), ...new Function(dbSrc + "\nreturn { lineQty, QTY_MESSAGE };")() };
    let called = 0;
    const ship = (locale) => new Function("g", "getCatalogData", "const { rateLimited, getBoxPresets, selectBox, getProductsByOrg, getShipFromAddress, lineQty, QTY_MESSAGE } = g; const rateLimitResponse = () => null;\n" +
      strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" + strip(read("functions/api/shipping.js")) + "\nreturn onRequestPost;")(g, async () => ({ subdomainMap: SUBS, locale }));
    const realFetch = global.fetch;
    global.fetch = async () => { called++; return { json: async () => ({ rates: [{ amount: "9.00", provider: "USPS", servicelevel: { name: "Ground" } }] }) }; };
    const quoteReq = (zip) => ({ env: { SHIPPO_API_KEY: "k", DB: {}, QUOTE_SIGNING_SECRET: "s".repeat(40) }, request: { url: "https://shipper.example.com/api/shipping", json: async () => ({ zip, items: [{ productId: "tee", qty: 1 }] }), headers: { get: () => null } } });
    let res = await ship({ country: "OTHER" })(quoteReq("SW1A 1AA"));
    const body = JSON.parse(await res.text());
    ok("/api/shipping refuses to quote, without calling the carrier", res.status === 400 && /aren't available for this shop's region/.test(body.message) && called === 0);
    res = await ship({ country: "US" })(quoteReq("43004"));
    ok("…and quotes as before in the US", res.status === 200 && JSON.parse(await res.text()).rates.length === 1 && called === 1);
    res = await ship(undefined)(quoteReq("SW1A 1AA"));
    ok("…where a non-ZIP is still refused", res.status === 400 && /5 digits/.test(JSON.parse(await res.text()).message));
    global.fetch = realFetch;
  }
  {
    const label = (locale) => new Function("getCatalogData", "const requireAdmin = async () => null; const selectBox = () => ({}); const getOrderForShipping = async () => { global.__labelRead = true; return null; }, recordShippingLabel = async () => {}, getShipFromAddress = async () => ({}), getOrderLabel = async () => null, setShippingLabelUrl = async () => {};\n" +
      strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/api/shippo-label.js")) + "\nreturn onRequestPost;")(async () => ({ subdomainMap: SUBS, locale }));
    const lreq = (action) => ({ env: { SHIPPO_API_KEY: "k", DB: {} }, request: { url: "https://admin.example.com/api/shippo-label", json: async () => ({ key: "x", action, org: "acme", orderId: "UK-1" }), headers: { get: () => null } } });
    global.__labelRead = false;
    const res = await label({ country: "OTHER" })(lreq("rates")), res2 = await label({ country: "OTHER" })(lreq("purchase"));
    ok("label rates and purchases are refused too, before anything is looked up", res.status === 400 && res2.status === 400 && /only available when the country/.test(JSON.parse(await res.text()).message) && global.__labelRead === false);
    ok("…while reprinting a label already bought isn't blocked by the country", (await label({ country: "OTHER" })(lreq("reprint"))).status === 404);
  }
  ok("the ZIP table itself is untouched by the country (only whether it's consulted)", lib.zipStates("43004").join() === "OH" && lib.zipStates("SW1A 1AA").length === 0);

  console.log("\n=== Storefront ===");
  const html = read("public/index.html");
  const page = async (answer) => { const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://acme.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => answer }); } });
    await new Promise(res => setTimeout(res, 150)); return dom.window; };
  const shopAnswer = (country) => ({ status: "ok", orgId: "acme", country, business: {}, catalog: { name: "Acme", eyebrow: "", accent: "#2563eb", ready: true, desc: "", designImages: {}, shippingEnabled: true,
    deliveryOptions: [{ id: "pickup", type: "pickup", label: "Local pickup", fee: 0 }, { id: "shipping", type: "shipping", label: "Shipping", fee: null }], products: [], enabledPayments: ["venmo"], allowOrdersAfterDeadline: true, salesTaxRate: 0, salesTaxJurisdiction: "", salesTaxMode: "inclusive" } });
  let w = await page(shopAnswer("US"));
  ok("US (and an answer with no country at all): ZIP wording and the 5-digit box", w.eval("isUS_()") === true && /ZIP for carrier rates/.test(w.eval("renderShippingSection(currentOrg)")) && /maxlength="5"/.test(w.eval("renderShippingSection(currentOrg)")) &&
    (await page(Object.assign(shopAnswer("US"), { country: undefined }))).eval("isUS_()") === true);
  w = await page(shopAnswer("OTHER"));
  const section = w.eval("renderShippingSection(currentOrg)");
  ok("OTHER: \"Postal code\", no 5-digit limit, no digits-only keyboard", w.eval("isUS_()") === false && /Postal code for carrier rates/.test(section) && !/ZIP/.test(section) && !/maxlength="5"/.test(section) && !/inputmode="numeric"/.test(section));
  const fnName = "collectShippingAddress";
  {
    const pr = w.eval(fnName + "()"); await new Promise(res => setTimeout(res, 20));
    const d = w.document;
    ok("the address form asks for \"State / region\" and \"Postal code\", with no 2-letter / 5-digit limits", d.getElementById("shipState").placeholder === "State / region" && d.getElementById("shipZip").placeholder === "Postal code" &&
      d.getElementById("shipState").maxLength === 50 && d.getElementById("shipZip").maxLength === 20 && !d.getElementById("shipZip").getAttribute("inputmode"));
    d.getElementById("shipName").value = "Pat"; d.getElementById("shipLine1").value = "10 Downing St"; d.getElementById("shipCity").value = "London";
    d.getElementById("shipState").value = "Greater London"; d.getElementById("shipZip").value = "SW1A 1AA";
    d.getElementById("shipConfirmBtn").click();
    const got = await pr;
    ok("…and accepts \"Greater London\" / \"SW1A 1AA\" as typed", got && got.state === "Greater London" && got.zip === "SW1A 1AA");
    const wu = await page(shopAnswer("US"));
    const pu = wu.eval(fnName + "()"); await new Promise(res => setTimeout(res, 20));
    const du = wu.document;
    du.getElementById("shipName").value = "Pat"; du.getElementById("shipLine1").value = "1 Main St"; du.getElementById("shipCity").value = "Columbus";
    du.getElementById("shipState").value = "OH"; du.getElementById("shipZip").value = "SW1A 1AA";
    du.getElementById("shipConfirmBtn").click();
    ok("in the US the same form still insists on a 5-digit ZIP", /ZIP must be 5 digits/.test(du.getElementById("shipAddrError").textContent) && du.getElementById("shipState").maxLength === 2 && du.getElementById("shipZip").placeholder === "ZIP");
    du.getElementById("shipState").value = "PA"; du.getElementById("shipZip").value = "43004"; du.getElementById("shipConfirmBtn").click();
    ok("…and a state that matches the ZIP", /but the state says PA/.test(du.getElementById("shipAddrError").textContent));
    du.getElementById("shipCancelBtn").click(); await pu;
  }

  console.log("\n=== Admin: Global settings → Region ===");
  {
    const adminJs = read("public/admin.js");
    const calls = [];
    let savedLocale = { timeZone: "", country: "US" };
    class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
    const dom = new JSDOM(html, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
      beforeParse(win) {
        win.fetch = async (url, opts) => {
          const body = opts && opts.body ? JSON.parse(opts.body) : {};
          const j = (x) => ({ ok: true, status: 200, json: async () => x });
          if (!body.action) return j({ status: "admin", business: {}, country: savedLocale.country });
          calls.push(body);
          if (body.action === "getGlobalSettings") return j({ status: "ok", globalSettings: { enabledPayments: {} } });
          if (body.action === "getLocaleSettings") return j({ status: "ok", locale: savedLocale, effectiveTimeZone: savedLocale.timeZone || "America/Chicago", envTimeZone: "America/Chicago" });
          if (body.action === "updateLocaleSettings") {
            if (body.locale.timeZone === "Nowhere/Land") return { ok: false, status: 400, json: async () => ({ status: "error", message: "\"Nowhere/Land\" isn't a time zone this site knows." }) };
            savedLocale = body.locale; return j({ status: "ok", locale: savedLocale, effectiveTimeZone: savedLocale.timeZone || "UTC", envTimeZone: "" });
          }
          if (body.action === "getSalesTaxSettings") return j({ status: "ok", salesTax: { ratePercent: 6, jurisdiction: "OH", taxMode: "inclusive" } });
          if (body.action === "updateSalesTaxSettings") return j({ status: "ok", salesTax: {} });
          if (body.action === "getShipFromAddress") return j({ status: "ok", shipFrom: { name: "", street1: "", city: "", state: "OH", zip: "43004", phone: "", email: "" } });
          if (body.action === "getBusinessProfile") return j({ status: "ok", business: {} });
          if (body.action === "getMachineSettings") return j({ status: "ok", machineSettings: { showDeleteButton: false } });
          if (["updateGlobalSettings", "updateBusinessProfile", "updateShipFromAddress"].includes(body.action)) return j({ status: "ok", business: {}, shipFrom: {}, globalSettings: {} });
          // The last save step fails on purpose, so the page stays on the form instead of navigating away.
          return j({ status: "error", message: "n/a" });
        };
      } });
    const w2 = dom.window, doc = w2.document;
    await new Promise(res => setTimeout(res, 150));
    await w2.loadAdminScript();
    w2.eval('adminKey = "cookie";');
    const app = doc.getElementById("app");
    const tick2 = (ms = 40) => new Promise(res => setTimeout(res, ms));
    w2.renderGlobalSettings(app); await tick2();
    const tz = doc.getElementById("gLocaleTimeZone"), country = doc.getElementById("gLocaleCountry");
    ok("there's a Region section with a time zone box and a country select", Array.from(app.querySelectorAll("h2")).some(h => h.textContent === "Region") && !!tz && !!country && country.tagName === "SELECT" && Array.from(country.options).map(x => x.value).join() === "US,OTHER" && country.value === "US");
    ok("it says which zone is in use and gives examples", /America\/Chicago is used \(from the TIMEZONE variable\)/.test(app.textContent.replace(/\s+/g, " ")) && /Europe\/London/.test(app.textContent) && tz.value === "" && tz.placeholder === "America/Chicago");
    ok("in the US the tax state and ship-from state are 2-letter boxes", doc.getElementById("gTaxJurisdiction").maxLength === 2 && doc.getElementById("gShipState").maxLength === 2 && doc.getElementById("gShipZipLabel").textContent === "ZIP");
    country.value = "OTHER"; country.dispatchEvent(new w2.Event("change")); w2.regionCountryChanged_();
    ok("switching the country loosens those boxes at once", doc.getElementById("gTaxJurisdiction").maxLength === 50 && doc.getElementById("gShipState").maxLength === 50 && doc.getElementById("gShipZipLabel").textContent === "Postal code" && doc.getElementById("gShipStateLabel").textContent === "State / region");
    tz.value = "Nowhere/Land";
    calls.length = 0;
    await w2.submitGlobalSettings(); await tick2();
    ok("a zone the server refuses stops the save and shows why", /isn't a time zone/.test(doc.getElementById("globalSettingsError").textContent) && !calls.some(c2 => c2.action === "updateShipFromAddress"));
    tz.value = " Europe/London ";
    calls.length = 0;
    await w2.submitGlobalSettings(); await tick2();
    const order2 = calls.map(c2 => c2.action);
    const sent = calls.find(c2 => c2.action === "updateLocaleSettings");
    ok("Save sends the region with the rest", !!sent && sent.locale.timeZone === "Europe/London" && sent.locale.country === "OTHER");
    ok("…before the tax state and the ship-from address, which are checked against the country", order2.indexOf("updateLocaleSettings") >= 0 && order2.indexOf("updateLocaleSettings") < order2.indexOf("updateSalesTaxSettings") && order2.indexOf("updateLocaleSettings") < order2.indexOf("updateShipFromAddress"));
    ok("the admin's own forms follow at once", w2.eval("adminIsUS_()") === false);
    doc.body.insertAdjacentHTML("beforeend", '<div id="orgFormDelivery"></div>');
    w2.setOrgDeliveryList_([{ type: "pickup" }, { type: "shipping" }]);
    const box = doc.getElementById("orgFormDelivery");
    ok("outside the US the shop form marks Shipping as not offered and explains", /not offered to customers/.test(box.textContent) && /only available when the country in Global settings → Region is US/.test(box.textContent));
    w2.setOrgDeliveryList_([{ type: "pickup" }]);
    const addShip = box.querySelector('[data-dlv-add="shipping"]');
    ok("…and + Shipping is disabled, while + Custom option isn't", !!addShip && addShip.disabled === true && box.querySelector('[data-dlv-add="custom"]').disabled === false);
    w2.applyCountry_("US"); w2.setOrgDeliveryList_([{ type: "pickup" }]);
    ok("in the US + Shipping is offered as before", box.querySelector('[data-dlv-add="shipping"]').disabled === false && !/only available when/.test(box.textContent));
    ok("phone boxes take any format; the US sample number only shows in the US", !/pattern="[^"]*\\d\{3\}/.test(adminJs) && /placeholder="\$\{adminIsUS_\(\) \? "\(555\) 555-5555" : ""\}"/.test(adminJs) && !/placeholder="\(555\) 555-5555"/.test(adminJs));
  }

  console.log("\n=== Written down ===");
  const readme = read("README.md");
  ok("the README has a Region section and no longer lists it as to-do", /^#+ Region/m.test(readme) && /UTC/.test(readme) && /OTHER/.test(readme) && !/Time zone and address-format settings/.test(readme));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("test105 crashed:", false); console.error(e); process.exit(1); });
