const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

// A product's own designs are stitched on every piece IN ADDITION to the graphic the customer picks
// (planHoopings_, 2026-10 — they used to be dropped once anything was picked), a configurable line's
// typed-in name gets its hooping, the catalog check warns about settings that contradict each other or
// that the product's setup never uses (settingConflicts_), open order lines saved with settings that no
// longer match the catalog are flagged (orderLineDrift_ → order.catalogDrift, openLinesStale), and the
// product form's "What Run Order will do" box (planProductPreview). Real migrations + db.js + orders.js.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { planHoopings_, settingConflicts_, orderLineDrift_, getCatalogIssues, planProductPreview, getOrderById };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const ok = (label, v) => console.log(label + ":", !!v);

(async () => {
  try {
    console.log("=== Run Order: the product's designs plus the customer's pick ===");
    const design = (id, name, file = "k" + id) => ({ id, name, stabilizer: "", hoopIds: [1], personalizationHoopIds: [], versionId: id,
      threadColors: [], machineFileKey: file, machineFileName: name + ".dst" });
    const ctx = { hoopNames: { 1: "Flat" }, itemDesigns: {}, itemDesignsAt: {}, graphicDesignIds: { 30: 3 },
      designs: { 2: design(2, "Back crest"), 3: design(3, "Star emblem"), 4: design(4, "Name") },
      productDesigns: { "acme|tee": [{ designId: 2, placement: "Back", isMain: true }] } };
    const line = (extra) => Object.assign({ itemId: 1, orgId: "acme", productId: "tee", configurable: true, personalized: false, persName: "",
      options: [], optionDesigns: {}, mode: "combined", persHoopId: null, offersOptions: true, hasFixedTransfers: false }, extra);
    const pick = { location: "loc1", label: "Left chest", kind: "embroidery", designId: 3, graphicId: 30, graphicName: "Star emblem" };
    let plan = lib.planHoopings_(ctx, line({ config: { locations: [pick] } }));
    ok("a configurable line runs the product's design first, then the customer's pick",
      plan.length === 2 && plan[0].designName === "Back crest" && plan[1].designName === "Star emblem" && plan[0].stepNo === 1 && plan[1].stepNo === 2);
    plan = lib.planHoopings_(ctx, line({ config: { locations: [pick] }, personalized: true, persName: "ALEX", mode: "separate", persHoopId: 1 }));
    ok("…and a typed-in name on a configurable line gets its own hooping (it used to get none)",
      plan.length === 3 && plan[2].kind === "itemDesign" && /Upload the order-specific design/.test(plan[2].blocked));
    const noPds = Object.assign({}, ctx, { productDesigns: {} });
    plan = lib.planHoopings_(noPds, line({ config: { locations: [pick] } }));
    ok("with no designs of its own, only the pick is stitched", plan.length === 1 && plan[0].designName === "Star emblem");
    plan = lib.planHoopings_(noPds, line({ config: { locations: [Object.assign({}, pick, { kind: "transfer", designId: null })] } }));
    ok("a transfer-only pick and no designs: nothing for Run Order (it's on Run Transfer Sheets)", plan.length === 0);
    plan = lib.planHoopings_(ctx, line({ config: { locations: [Object.assign({}, pick, { kind: "transfer", designId: null })] } }));
    ok("a transfer pick still gets the product's own design stitched", plan.length === 1 && plan[0].designName === "Back crest");
    plan = lib.planHoopings_(noPds, line({ productDesignId: 4, config: { locations: [pick] } }));
    ok("a stray products.designId on a configurable product adds no hooping", plan.length === 1 && plan[0].designName === "Star emblem");
    plan = lib.planHoopings_(ctx, line({ config: { locations: [] } }));
    ok("a line of a product offering graphics but saved with no pick is planned from the designs — with a warning",
      plan.length === 1 && plan[0].designName === "Back crest" && /No graphic pick is saved/.test(plan[0].staleDesign || ""));
    plan = lib.planHoopings_(ctx, line({ config: { locations: [] }, hasFixedTransfers: true }));
    ok("…but not when printed transfers let every option be left at None", plan.length === 1 && !plan[0].staleDesign);

    console.log("\n=== Settings that contradict each other or aren't used ===");
    const gBy = { 30: { id: 30, name: "Star emblem", kind: "embroidery", designId: 3, orgId: "acme" },
      31: { id: 31, name: "Club logo", kind: "embroidery", designId: 5, orgId: "acme" } };
    const names = { 2: "Back crest", 3: "Star emblem", 5: "Club logo" };
    const conflicts = (p, extra = {}) => lib.settingConflicts_(Object.assign({ configurable: 1, locationsJson: "[]", mockupGraphicsJson: "[]", noDesignNeeded: 0,
      noBlankNeeded: 0, personalizationPriceCents: null }, p), Object.assign({ used: [], options: [], offersOptions: false, graphicById: gBy,
      designName: (id) => names[id] || "#" + id, linkedSizes: [] }, extra)).map(x => x.code);
    const locs = JSON.stringify([{ key: "loc1", label: "Left chest", locationId: 1, graphicIds: [30, 31] }]);
    ok("designs on a product with graphic options: says they're stitched on top of the pick",
      conflicts({ locationsJson: locs }, { used: [2], offersOptions: true }).includes("designsPlusOptions"));
    let list = lib.settingConflicts_({ configurable: 1, locationsJson: locs, mockupGraphicsJson: JSON.stringify([{ locationId: 1, graphicId: 31 }]) },
      { used: [], options: [], offersOptions: true, graphicById: gBy, designName: (id) => names[id], linkedSizes: [] });
    ok("a mockup graphic at a spot where the customer picks: warned, naming the graphic, the spot and the section",
      list.length === 1 && list[0].code === "mockupDuplicatesOption" && /Club logo/.test(list[0].text) && /Left chest/.test(list[0].text) && list[0].section === "mockupGraphics");
    ok("a mockup graphic elsewhere on such a product with nothing stitching it: it's only a picture",
      conflicts({ locationsJson: locs, mockupGraphicsJson: JSON.stringify([{ locationId: 9, graphicId: 31 }]) }, { offersOptions: true }).includes("mockupNotStitched"));
    ok("a plain product whose mockup graphic's design isn't one of its designs",
      conflicts({ configurable: 0, mockupGraphicsJson: JSON.stringify([{ locationId: 1, graphicId: 31 }]) }, { used: [2] }).includes("mockupNotStitched"));
    ok("…but not when its design is there",
      !conflicts({ configurable: 0, mockupGraphicsJson: JSON.stringify([{ locationId: 1, graphicId: 31 }]) }, { used: [5] }).length);
    ok("“No embroidery design needed” with designs", conflicts({ configurable: 0, noDesignNeeded: 1 }, { used: [2] }).includes("noDesignButDesigns"));
    ok("“No embroidery design needed” with embroidery options", conflicts({ noDesignNeeded: 1, locationsJson: locs }, { offersOptions: true }).includes("noDesignButDesigns"));
    ok("“No blank needed” with blank links", conflicts({ noBlankNeeded: 1 }, { linkedSizes: ["M"] }).includes("noBlankButLinked"));
    ok("pick-list options with personalization off", conflicts({}, { options: ["GOLD"] }).includes("pickListOff"));
    ok("graphic options on a product that isn't configurable", conflicts({ configurable: 0, locationsJson: locs }).includes("optionsNotConfigurable"));
    ok("a clean product has none", !conflicts({ locationsJson: locs }, { offersOptions: true }).length && !conflicts({ configurable: 0 }, { used: [2] }).length);
    // OpenDecoDesk: with the Production feature off nothing is stitched, so the stitching warnings are left out.
    const off = { production: false };
    ok("Production off: no warning about designs on top of the pick, or about “No embroidery design needed”",
      !conflicts({ locationsJson: locs }, Object.assign({ used: [2], offersOptions: true }, off)).includes("designsPlusOptions") &&
      !conflicts({ configurable: 0, noDesignNeeded: 1 }, Object.assign({ used: [2] }, off)).includes("noDesignButDesigns"));
    ok("…nor about a mockup graphic nothing stitches — but a mockup graphic repeating a pick is still said",
      !conflicts({ configurable: 0, mockupGraphicsJson: JSON.stringify([{ locationId: 9, graphicId: 31 }]) }, Object.assign({ used: [2] }, off)).length &&
      conflicts({ locationsJson: locs, mockupGraphicsJson: JSON.stringify([{ locationId: 1, graphicId: 31 }]) }, Object.assign({ offersOptions: true }, off)).includes("mockupDuplicatesOption"));

    console.log("\n=== Order lines that don't match the catalog ===");
    const prod = { configurable: 1, locationsJson: locs, fixedTransfersJson: "[]" };
    ok("a line with no pick saved", /no graphic pick is saved/.test(lib.orderLineDrift_(prod, { locations: [] }, gBy).join()));
    ok("a picked graphic now linked to another design", /now links to a different design/.test(lib.orderLineDrift_(prod, { locations: [Object.assign({}, pick, { designId: 9 })] }, gBy).join()));
    ok("a picked graphic that became a transfer", /embroidery when ordered and is a transfer now/.test(lib.orderLineDrift_(prod,
      { locations: [pick] }, { 30: Object.assign({}, gBy[30], { kind: "transfer" }) }).join()));
    ok("a matching line has nothing", !lib.orderLineDrift_(prod, { locations: [pick] }, gBy).length);
    ok("a plain product's lines aren't looked at", !lib.orderLineDrift_({ configurable: 0 }, null, gBy).length);

    console.log("\n=== On the real database: catalog check, Orders and the product form's box ===");
    const d1 = await createD1();
    d1._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
    const call = async (body) => {
      const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
        request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
      return { status: res.status, body: JSON.parse(await res.text()) };
    };
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Acme','t','t');
      INSERT INTO hoops (id, name, isCapFrame, createdAt, updatedAt) VALUES (1, 'Flat', 0, 't', 't');
      INSERT INTO designs (id, orgId, name, createdAt, updatedAt) VALUES (2, 'acme', 'Back crest', 't', 't'), (3, 'acme', 'Star emblem', 't', 't'), (5, 'acme', 'Club logo', 't', 't');
      INSERT INTO design_hoops (designId, hoopId, purpose, sortOrder) VALUES (2, 1, 'design', 0), (3, 1, 'design', 0), (5, 1, 'design', 0);
      INSERT INTO design_versions (designId, machineFileKey, machineFileName, threadColorsJson, uploadedAt, createdAt) VALUES (2, 'k2', 'b.dst', '[1]', 't', 't'), (3, 'k3', 's.dst', '[1]', 't', 't');
      INSERT INTO graphics (id, orgId, name, kind, designId, createdAt, updatedAt) VALUES (30, 'acme', 'Star emblem', 'embroidery', 3, 't', 't'), (31, 'acme', 'Club logo', 'embroidery', 5, 't', 't');
      INSERT INTO products (productId, orgId, type, name, pricingMode, flatPriceCents, visible, configurable, locationsJson, mockupGraphicsJson, designId, createdAt, updatedAt)
        VALUES ('tee', 'acme', 'shirt', 'Club Tee', 'flat', 2000, 1, 1, '${locs}', '[{"locationId":1,"graphicId":31}]', 2, 't', 't');
      INSERT INTO product_designs (orgId, productId, designId, placement, isMain, sortOrder, createdAt) VALUES ('acme', 'tee', 2, 'Back', 1, 0, 't');
      INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('O-1', 'acme', 'Alex Sample', 'alex@example.com', '2026-10-30T12:00:00Z');
      INSERT INTO order_items (orderId, orgId, productId, name, type, size, qty, unitPriceCents, lineTotalCents, configJson)
        VALUES ('O-1', 'acme', 'tee', 'Club Tee', 'shirt', 'OSFA', 1, 2000, 2000, '{"locations":[]}');`);
    const issues = ((await lib.getCatalogIssues(d1, "acme")).orgs.acme.products.tee || []).map(x => x.code);
    ok("the catalog check lists the designs-on-top, the duplicate mockup graphic and the open line", issues.includes("designsPlusOptions") &&
      issues.includes("mockupDuplicatesOption") && issues.includes("openLinesStale"));
    const order = await lib.getOrderById(d1, "O-1");
    ok("the order carries what's wrong with its line, for the Orders page", order.catalogDrift.length === 1 && /no graphic pick/.test(order.catalogDrift[0].problems[0]));
    const r = await call({ action: "previewProductHoopings", org: "acme", productId: "tee" });
    const pv = r.body.preview;
    ok("the product form's box: every piece gets the Back crest", r.status === 200 && pv.always.length === 1 && pv.always[0].designName === "Back crest");
    const choices = pv.picks[0].choices;
    ok("…plus the pick at Left chest: Star emblem adds its hooping, Club logo can't run (no stitch file)",
      pv.picks[0].label === "Left chest" && choices.length === 2 && choices[0].steps.length === 1 && choices[0].steps[0].designName === "Star emblem" &&
      /no machine file/.test(choices[1].steps[0].blocked));
    ok("an unknown product is a 404", (await call({ action: "previewProductHoopings", org: "acme", productId: "nope" })).status === 404);

    console.log("\n=== The product form ===");
    const adm = read("public/admin.js"), html = read("public/index.html");
    ok("the form is cards in order: basics, what the customer chooses, blank & colors, every piece, the pick, own design, personalization, prices, pictures",
      ["prodCardBasics", "prodCardMode", "prodCardBlank", "prodCardEvery", "prodCardOptions", "prodCardCustom", "prodCardPers", "prodCardPrices", "prodCardPictures"]
        .map(id => adm.indexOf(`"${id}"`)).every((v, i, a) => v > 0 && (i === 0 || v > a[i - 1])));
    ok("the three choices of what the customer picks", /value="plain"/.test(adm) && /value="colors"/.test(adm) && /value="options"/.test(adm));
    ok("the pick card is hidden unless the customer picks a graphic", /\[data-mode="plain"\] #prodCardOptions, \.admin-form\[data-mode="colors"\] #prodCardOptions\{display:none;\}/.test(html));
    ok("printed transfers, mockup graphics, the QR and the mockups are moved into their cards", /data-slot="cfgFixedWrap"/.test(adm) && /data-slot="cfgEmbWrap"/.test(adm) &&
      /data-slot="cfgQrWrap"/.test(adm) && /data-slot="cfgMockups"/.test(adm) && /slot\.replaceChildren\(node\)/.test(adm));
    ok("each new warning has a card to outline", ["designs", "mockupGraphics", "flags", "blankLinks", "personalization", "config", "orders"].every(k => new RegExp(`\\b${k}: "prodCard`).test(adm)));
    ok("the Orders page shows a line that doesn't match the catalog", /catalogDriftPill_\(o\)/.test(adm) && /doesn't match catalog/.test(adm));
    const ordersJs = read("functions/api/orders.js");
    const listOf = (name) => (ordersJs.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`)) || [])[1] || "";
    ok("OpenDecoDesk: the box is a staff action (staff edit products there), under the Production feature",
      /"previewProductHoopings"/.test(listOf("STAFF_ACTIONS")) && !/"previewProductHoopings"/.test(listOf("MANAGER_ACTIONS")) &&
      /production: \[[\s\S]*?"previewProductHoopings"[\s\S]*?\],/.test(ordersJs));
    ok("…and with Production off the form shows no Run Order box, designs or “No embroidery design needed”",
      /if \(!adminFeatureOn_\("production"\)\) \{ box\.remove\(\); return; \}/.test(adm) &&
      /prod-sub-head" id="productDesignsBlock"\$\{adminFeatureOn_\("production"\)[^\n]*Stitched on every piece/.test(adm) && /checkbox-row"\$\{adminFeatureOn_\("production"\)[^\n]*\n\s*<input type="checkbox" id="prodFormNoDesign"/.test(adm));
    ok("…and the sales-tax box names no state", /Subject to sales tax/.test(adm) && !/Subject to [A-Z][a-z]+ sales tax/.test(adm));
  } catch (e) { console.error(e); console.log("test158 crashed:", false); }
})();
