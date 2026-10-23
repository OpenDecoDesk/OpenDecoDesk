/**
 * D1 query helpers. All functions take `env.DB` as their first argument.
 *
 * insertOrder() is the most critical: it uses D1 batch() to write the orders
 * row + all order_items rows in a single atomic transaction.
 *
 * priceItem() performs server-side pricing from the products table — the
 * client-supplied unit price is never trusted.
 *
 * MONEY: every amount is stored as INTEGER CENTS in *Cents columns
 * (migrations/0006). This file is the only place that converts: callers pass
 * and receive DOLLARS. Totals are summed in cents, never in floating-point
 * dollars.
 *
 * DATES: "not set" is NULL in the database. The parse*_ helpers hand callers
 * "" for unset dates, which is what the admin and storefront expect.
 *
 * PAID: the payments ledger (order_payments) is the source of truth.
 * orders.paid/paidAt are a cache that refreshPaidStatus() recomputes after
 * anything that changes what's owed or what's been received.
 */

// ---- Money helpers -------------------------------------------------------
const toCents = (dollars) => {
  const n = Number(dollars);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const toCentsOrNull = (dollars) =>
  (dollars === null || dollars === undefined || dollars === "") ? null : toCents(dollars);
const fromCents = (cents) => (Number(cents) || 0) / 100;
const fromCentsOrNull = (cents) => (cents === null || cents === undefined) ? null : Number(cents) / 100;
const mapValues_ = (obj, fn) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, fn(v)]));

// An error whose message is safe to show a customer (e.g. "Size XL not
// available"). Anything else thrown while pricing is internal and reaches the
// storefront only as a generic message (orders.js).
function pricingError_(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

// ---- Sales tax (migrations/0007, 0052) -------------------------------------
// Two ways to price, chosen in Global settings and snapshotted on each order (orders.taxMode):
// INCLUSIVE (the default): the listed price includes the tax, which is backed out of each line's
// total once: $16.00 at 6% -> $15.09 net + $0.91 tax; a 3 x $16 line -> $45.28 + $2.72.
// Must match the SQL backfill in migrations/0007 exactly (test34 checks).
// EXCLUSIVE: the tax is added on top of each line's total (addTaxExclusive).
export function splitTaxInclusive(grossCents, rateBps) {
  const gross = Math.round(Number(grossCents) || 0);
  const bps = Math.max(0, Math.round(Number(rateBps) || 0));
  if (!bps || gross <= 0) return { netCents: gross, taxCents: 0 };
  const netCents = Math.round(gross * 10000 / (10000 + bps));
  return { netCents, taxCents: gross - netCents };
}

// The same per-line rounding the other way: tax ADDED to a net line total. $15.09 at 6% -> + $0.91
// = $16.00, so a price entered net here and the matching tax-included price in inclusive mode
// record the same net and the same tax.
export function addTaxExclusive(netCents, rateBps) {
  const net = Math.round(Number(netCents) || 0);
  const bps = Math.max(0, Math.round(Number(rateBps) || 0));
  if (!bps || net <= 0) return { grossCents: net, taxCents: 0 };
  const taxCents = Math.round(net * bps / 10000);
  return { grossCents: net + taxCents, taxCents };
}
export const TAX_MODES = ["inclusive", "exclusive"];
const taxMode_ = (m) => (m === "exclusive" ? "exclusive" : "inclusive");
// The tax on an amount of listed prices (a line total, or the taxable part of a discount).
const taxOn_ = (cents, rateBps, mode) =>
  (taxMode_(mode) === "exclusive" ? addTaxExclusive(cents, rateBps) : splitTaxInclusive(cents, rateBps)).taxCents;

// Until the admin sets them (Global settings → Sales tax) there is no rate and no home state: nothing
// is taxed. jurisdiction is the 2-letter code of the state the business collects tax for (outside
// the US — Region → country OTHER — the region's name as free text). taxMode
// applies to NEW orders; an existing order keeps its own (orders.taxMode). A setting saved before
// modes existed has none, and means inclusive.
const DEFAULT_SALES_TAX = { rateBps: 0, taxShipping: false, jurisdiction: "", taxMode: "inclusive" };

export async function getSalesTaxSettings(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='salesTax'").first();
  const s = { ...DEFAULT_SALES_TAX, ...(row ? tryParse_(row.value, {}) : {}) };
  s.taxMode = taxMode_(s.taxMode);
  return s;
}

export async function setSalesTaxSettings(db, { rateBps, jurisdiction, taxMode }) {
  const current = await getSalesTaxSettings(db);
  const next = { ...current, rateBps, jurisdiction, taxMode: taxMode_(taxMode === undefined ? current.taxMode : taxMode) };
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', ?)")
    .bind(JSON.stringify(next)).run();
  return next;
}

// ---- What the customer owes --------------------------------------------------
// THE formula, in integer cents: active items, plus shipping while anything is still on the order,
// minus the discount — plus the sales tax when the order's prices don't include it (taxMode
// "exclusive"; shipping is never taxed). Everything that needs "the order's total", "the balance" or "is it paid"
// goes through here (refreshPaidStatus, the card checkout amount, the order loaders, the revenue
// report), so they can't drift apart. `itemsTaxCents` / `discountTaxCents` are the tax recorded on
// the active lines and the discount's share of it.
//   owedCents      what the customer pays in all (before payments received)
//   taxCents       sales tax in that amount (never negative)
//   netSalesCents  goods revenue: no tax, no shipping
//   grossGoodsCents what the customer pays for the goods, tax included, after the discount
//   shippingCents  shipping actually charged (0 once every line is cancelled)
//   taxAddedCents  the part of taxCents that is on top of the listed prices (0 when inclusive)
export function orderAmounts({ itemsCents, itemsTaxCents, shippingCents, discountCents, discountTaxCents, taxMode }) {
  const items = Number(itemsCents) || 0, discount = Number(discountCents) || 0;
  const shipping = items > 0 ? Number(shippingCents) || 0 : 0;
  const taxCents = Math.max(0, (Number(itemsTaxCents) || 0) - (Number(discountTaxCents) || 0));
  const taxAddedCents = taxMode_(taxMode) === "exclusive" ? taxCents : 0;
  const owedCents = Math.max(0, items + shipping - discount + taxAddedCents);
  return {
    owedCents,
    taxCents,
    netSalesCents: Math.max(0, items - discount - (taxCents - taxAddedCents)),
    grossGoodsCents: Math.max(0, items - discount + taxAddedCents),
    shippingCents: shipping,
    taxAddedCents,
  };
}
// The columns orderAmounts needs, for the order aliased `o` (one row per order).
const ORDER_AMOUNT_COLS_ = `o.shippingCostCents, o.discountCents, o.discountTaxCents, o.taxMode,
      COALESCE((SELECT SUM(lineTotalCents) FROM order_items WHERE orderId = o.orderId AND cancelDate IS NULL), 0) AS itemsCents,
      COALESCE((SELECT SUM(taxCents) FROM order_items WHERE orderId = o.orderId AND cancelDate IS NULL), 0) AS itemsTaxCents`;
const orderAmountsOfRow_ = (row) => orderAmounts({ itemsCents: row.itemsCents, itemsTaxCents: row.itemsTaxCents,
  shippingCents: row.shippingCostCents, discountCents: row.discountCents, discountTaxCents: row.discountTaxCents, taxMode: row.taxMode });
// Runs a query that reads orders.taxMode, written as a function of how to spell that column
// ("o.taxMode"). On a database from before migrations/0052 the column doesn't exist and every order
// is inclusive, so the query is retried with that constant instead (tests pin older schemas).
async function withTaxMode_(run) {
  try { return await run("o.taxMode"); }
  catch (e) {
    if (!/no such column: (o\.)?taxMode/i.test(String(e && e.message))) throw e;
    return run("'inclusive'");
  }
}

// ---- What's taxed (migrations/0013) ----------------------------------------
// A line is taxed at the order's snapshotted rate only when (1) its product is
// taxable, (2) the order isn't tax-exempt and (3) the order doesn't ship to a
// state other than the jurisdiction (shipments out of the home state aren't
// its sales; pickup / hand delivery / no address = in state).
const US_STATE_CODES_ = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO", CONNECTICUT: "CT",
  DELAWARE: "DE", "DISTRICT OF COLUMBIA": "DC", FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL",
  INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD",
  MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT",
  NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY",
  "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA",
  "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT",
  VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY",
};
// "oh", "Ohio", " ohio. " → "OH"; unknown text passes through uppercased.
export function stateCode(s) {
  const t = String(s || "").trim().toUpperCase().replace(/\.$/, "").replace(/\s+/g, " ");
  return US_STATE_CODES_[t] || t;
}
// Out of the home state = not taxed. A blank ship-to state (pickup, hand delivery) is in the home
// state; with no home state configured nothing counts as out of state (the rate decides alone).
// Outside the US (Region → country OTHER) both sides are free text — "Ontario", "ontario " — and
// stateCode makes that comparison case- and spacing-insensitive, so the same rule holds.
export function isOutOfState(shipState, jurisdiction) {
  const st = stateCode(shipState), home = stateCode(jurisdiction);
  return !!st && !!home && st !== home;
}
// Which state a ZIP code is in, from its first three digits. Built from USPS's "ZIP Locale Detail"
// list (PostalPro, file dated 2026-10-01) by scripts/zip-prefix-table.py — regenerate it with that
// script, don't edit it by hand. Dozens of prefixes straddle a state line (029 is RI plus one MA ZIP,
// 838 is ID plus three WA ZIPs…) and military prefixes are addressed AE / AA / AP, so the answer is a
// LIST and any state on it is accepted; a prefix not in use gives [] and is never held against an address.
const ZIP3_STATES_ = "005:NY 006-007:PR 008:VI 009:PR 010-027:MA 028-029:RI 029:MA 030-038:NH 036:VT 039-049:ME 039:NH 050-054:VT 055:MA "
  + "056-059:VT 060-069:CT 063:NY 070-099:NJ 090:AE 091:AE 092:AE 093:AE 094:AE 095:AE 096:AE 097:AE 098:AE 099:AE "
  + "100-149:NY 150-196:PA 197-199:DE 199:MD 200:DC 200:MD 200:VA 201:VA 201:DC 202-205:DC 205:MD 205:VA 206-212:MD "
  + "214-219:MD 218:DE 220-246:VA 241:WV 246:WV 247-268:WV 270-289:NC 290-299:SC 300-319:GA 307:TN 320-342:FL 340:AA 344:FL "
  + "346-347:FL 349:FL 350-352:AL 354-369:AL 357:TN 370-385:TN 373:GA 376:VA 382:KY 386-397:MS 398-399:GA 400-418:KY 410:OH "
  + "411:WV 415:WV 420-427:KY 430-459:OH 452:KY 453:IN 460-479:IN 470:OH 471:KY 480-499:MI 500-516:IA 515:NE 520-528:IA "
  + "530-532:WI 534-535:WI 537-549:WI 550-551:MN 553-567:MN 565:ND 567:ND 570-577:SD 576:ND 580-588:ND 585:SD 590-599:MT "
  + "593:SD 600-620:IL 612:IA 622-629:IL 630-631:MO 633-641:MO 644-658:MO 660-662:KS 664-679:KS 666:MO 680-681:NE "
  + "683-693:NE 700-701:LA 703-708:LA 710-714:LA 716-729:AR 718:TX 730-731:OK 733:TX 734-741:OK 739:TX 743-749:OK "
  + "750-770:TX 755:AR 772-799:TX 798:NM 800-816:CO 820-831:WY 832-838:ID 834:WY 838:WA 840-847:UT 847:AZ 850-853:AZ "
  + "855-857:AZ 859-860:AZ 860:UT 863-865:AZ 870-871:NM 873-884:NM 885:TX 890-891:NV 893-895:NV 897-898:NV 900-908:CA "
  + "910-928:CA 930-966:CA 962:AP 963:AP 964:AP 965:AP 966:AP 966:NJ 967-968:HI 967:AS 969:GU 969:FM 969:MH 969:MP 969:PW "
  + "970-979:OR 979:ID 980-986:WA 988-994:WA 994:ID 995-999:AK";
const ZIP3_MAP_ = (() => {
  const m = {};
  for (const part of ZIP3_STATES_.split(" ")) {
    const [range, st] = part.split(":"), [a, b] = range.split("-").map(Number);
    for (let i = a; i <= (b === undefined ? a : b); i++) {
      const k = String(i).padStart(3, "0");
      if (!(m[k] || (m[k] = [])).includes(st)) m[k].push(st);
    }
  }
  return m;
})();
export function zipStates(zip) {
  const m = /^(\d{3})\d{2}/.exec(String(zip || "").trim());
  return (m && ZIP3_MAP_[m[1]]) || [];
}
export function zipIsInState(zip, state) {
  return zipStates(zip).includes(stateCode(state));
}
const VALID_STATE_CODES_ = new Set([...Object.values(US_STATE_CODES_), "PR", "GU", "VI", "AS", "MP", "AA", "AE", "AP"]);

// One reading of a storefront cart line's quantity. The rate quote (functions/api/shipping.js) and
// the order (functions/api/orders.js) both go through it, so the pieces that were weighed, the
// pieces the quote is signed for and the pieces that are ordered are always the same number — a
// rate weighed for 1 item can't be accepted on an order for 50.
// A whole number from 1 to MAX_LINE_QTY, sent as a JSON number; a line with no qty at all counts
// as 1. Anything else — a string, a fraction, zero, a negative, more than the cap — is not a
// quantity: it comes back null and the caller refuses the request rather than guessing.
export const MAX_LINE_QTY = 50;
export const QTY_MESSAGE = `Each item's quantity must be a whole number from 1 to ${MAX_LINE_QTY}.`;
export function lineQty(v) {
  if (v === undefined || v === null) return 1;
  return (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_LINE_QTY) ? v : null;
}

// What an order's shippingMethod reads while its shipping is still to be quoted: a cart no box fits
// is placed without a carrier rate and the shop sets the shipping afterwards (which replaces this).
// Until then the order can't go through card checkout (getOrderCheckoutState → shippingPending).
export const SHIPPING_QUOTE_PENDING = "Quote pending";

// Validates and normalises a ship-to address before it's stored. Whitelists the known fields with
// length caps (anything else in the object is dropped), turns the state into its 2-letter code,
// and — because the state decides whether the order is taxed — refuses a state that contradicts the
// ZIP: a home-state ZIP with another "state" would drop the order's sales tax, and the signed
// shipping quote only binds the ZIP, so the ZIP is the trusted half. The rule is the same for every
// state, so it holds whatever the configured home state is (and with none configured). A blank
// state is filled in from the ZIP when the ZIP names exactly one; otherwise it's refused (a blank
// state is taxed as the home state). Returns {address} (null for no address) or {error} (a
// customer-facing message).
//
// `country` is the install's Region setting (getLocaleSettings). "US" (the default) is everything
// above. "OTHER": the postal code and the state / region are free text — trimmed and length-capped,
// the region kept as typed — and there is no postal-code check at all; nothing can be filled in
// from the postal code, so a blank region stays blank (and is taxed as the home region).
export function cleanShippingAddress(a, country) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return { address: null };
  const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const addr = {
    name: str(a.name, 200), line1: str(a.line1, 200), line2: str(a.line2, 200), city: str(a.city, 100),
    state: str(a.state, 50), zip: str(a.zip, 20), phone: str(a.phone, 50),
  };
  if (a.country) addr.country = str(a.country, 2).toUpperCase();
  if (!Object.values(addr).some(Boolean)) return { address: null };
  if (localeCountry_(country) === "OTHER") {
    addr.state = addr.state.replace(/\s+/g, " ");
    addr.zip = addr.zip.replace(/\s+/g, " ");
    return { address: addr };
  }
  if (addr.zip && !/^\d{5}(-\d{4})?$/.test(addr.zip)) return { error: "ZIP code must be 5 digits (or ZIP+4)." };
  if (addr.state) {
    const code = stateCode(addr.state);
    if (!VALID_STATE_CODES_.has(code)) return { error: "State must be a 2-letter US state code (e.g. NY)." };
    addr.state = code;
  }
  if (addr.zip) {
    const states = zipStates(addr.zip);
    if (!addr.state) {
      if (states.length !== 1) return { error: "Please enter the state for this address." };
      addr.state = states[0];
    } else if (states.length && !states.includes(addr.state)) {
      return { error: `ZIP code ${addr.zip} is in ${states.join(" or ")}, but the state says ${addr.state}. Please check the address.` };
    }
  }
  return { address: addr };
}

function stateOf_(shippingAddress) {
  if (!shippingAddress) return "";
  try { const a = typeof shippingAddress === "string" ? JSON.parse(shippingAddress) : shippingAddress; return String((a && a.state) || ""); }
  catch (_) { return ""; }
}

// Recomputes every line's tax (and the discount's tax share) on an existing
// order from its own snapshot — rate and exemption as of when it was placed,
// never today's — plus its current ship-to state and each line's taxable
// flag. Called after anything that can change what's taxed: item add/edit,
// discount, shipping address.
async function recomputeOrderTax_(db, orderId) {
  const [o, settings] = await Promise.all([
    withTaxMode_((tm) => db.prepare(`SELECT o.taxRateBps, o.taxExempt, o.shippingAddress, o.discountCents, ${tm} AS taxMode FROM orders o WHERE o.orderId=?`).bind(orderId).first()),
    getSalesTaxSettings(db),
  ]);
  if (!o) return;
  const mode = taxMode_(o.taxMode);   // the order's own, never today's setting
  const orderRate = !o.taxExempt && !isOutOfState(stateOf_(o.shippingAddress), settings.jurisdiction) ? Number(o.taxRateBps) || 0 : 0;
  const { results: items } = await db.prepare("SELECT id, lineTotalCents, taxable, cancelDate FROM order_items WHERE orderId=?").bind(orderId).all();
  const stmts = items.map(it => {
    const rate = it.taxable ? orderRate : 0;
    return db.prepare("UPDATE order_items SET taxRateBps=?, taxCents=? WHERE id=?")
      .bind(rate, taxOn_(Number(it.lineTotalCents), rate, mode), it.id);
  });
  // A discount reduces tax only in proportion to the taxable goods it's taken off.
  const active = items.filter(it => !it.cancelDate);
  const gross = active.reduce((a, it) => a + Number(it.lineTotalCents), 0);
  const taxableGross = active.filter(it => it.taxable).reduce((a, it) => a + Number(it.lineTotalCents), 0);
  const disc = Math.min(Number(o.discountCents) || 0, gross);
  const taxableDisc = gross > 0 ? Math.round(disc * taxableGross / gross) : 0;
  stmts.push(db.prepare("UPDATE orders SET discountTaxCents=? WHERE orderId=?")
    .bind(taxOn_(taxableDisc, orderRate, mode), orderId));
  await db.batch(stmts);
  // With tax on top, the tax is part of the order's total, so the stored totals move with it
  // (an address change into or out of the home state changes what the customer owes).
  if (mode === "exclusive") await storeOrderTotals_(db, orderId);
}

// orders.subtotalCents / totalCents: the active lines, and that plus shipping — plus the lines' tax
// when it's added on top. The total BEFORE any discount; what's owed is orderAmounts.
async function storeOrderTotals_(db, orderId) {
  const row = await withTaxMode_((tm) => db.prepare(`SELECT ${ORDER_AMOUNT_COLS_.replace("o.taxMode", tm + " AS taxMode")} FROM orders o WHERE o.orderId=?`).bind(orderId).first());
  const subtotalCents = row ? Number(row.itemsCents) || 0 : 0;
  const totalCents = subtotalCents + (row ? Number(row.shippingCostCents) || 0 : 0)
    + (row && taxMode_(row.taxMode) === "exclusive" ? Number(row.itemsTaxCents) || 0 : 0);
  await db.prepare("UPDATE orders SET subtotalCents=?, totalCents=? WHERE orderId=?").bind(subtotalCents, totalCents, orderId).run();
  return { subtotalCents, totalCents };
}

// ---- Org helpers -------------------------------------------------------

export async function getAllOrgs(db) {
  const { results } = await db.prepare("SELECT * FROM orgs ORDER BY orgId").all();
  return results.map(parseOrg_);
}

export async function getOrgById(db, orgId) {
  const row = await db.prepare("SELECT * FROM orgs WHERE orgId = ?").bind(orgId).first();
  return row ? parseOrg_(row) : null;
}

// ---- Publish per shop (migrations/0076) --------------------------------------------------------
// A shop's published catalog is its orgs row + products rows as they were when it was last published. Shoppers see
// it and orders are priced from it; admin edits are a draft until the shop is published again. A shop that has
// never been published since this (no snapshot) is served live, as before. Graphics, transfers, locations, blank
// links and tier prices aren't part of the snapshot — they stay live.
async function liveShopRows_(db, orgId) {
  const org = await db.prepare("SELECT * FROM orgs WHERE orgId=?").bind(orgId).first();
  if (!org) return null;
  const { results: products } = await db.prepare("SELECT * FROM products WHERE orgId=? ORDER BY productId").bind(orgId).all();
  return { org, products };
}
export async function getCatalogSnapshot(db, orgId) {
  let r = null;
  try { r = await db.prepare("SELECT json, publishedAt, publishedBy FROM catalog_snapshots WHERE orgId=?").bind(orgId).first(); } catch (e) { return null; }   // before 0076
  if (!r) return null;
  const rows = tryParse_(r.json, null);
  return rows && rows.org ? { ...rows, publishedAt: r.publishedAt, publishedBy: r.publishedBy || "" } : null;
}
// The rows shoppers get: the snapshot, else the live rows (never published).
export async function publishedShopRows_(db, orgId) {
  return (await getCatalogSnapshot(db, orgId)) || (await liveShopRows_(db, orgId));
}
export async function publishShop(db, orgId, by = "") {
  const rows = await liveShopRows_(db, orgId);
  if (!rows) return null;
  const at = new Date().toISOString();
  await db.prepare("INSERT INTO catalog_snapshots (orgId, json, publishedAt, publishedBy) VALUES (?, ?, ?, ?) ON CONFLICT(orgId) DO UPDATE SET json=excluded.json, publishedAt=excluded.publishedAt, publishedBy=excluded.publishedBy")
    .bind(orgId, JSON.stringify(rows), at, String(by || "").slice(0, 200)).run();
  return { publishedAt: at, products: rows.products.length };
}
// Discard unpublished changes: put the shop's settings and products back to the published snapshot. A product added
// since it was published is deleted with its blank links, designs and mockups — unless something already refers to it
// (an order line, finished stock, a brand approval, a customer's upload), then it's hidden instead. Graphics, transfers,
// locations, blank links and tier prices aren't in the snapshot (they're live), so they aren't touched.
// planDiscardShopChanges says what would happen; discardShopChanges does it. null = never published.
const PRODUCT_HISTORY_TABLES_ = ["order_items", "finished_goods_movements", "brand_approvals", "customer_design_uploads"];
export async function planDiscardShopChanges(db, orgId) {
  const snap = await getCatalogSnapshot(db, orgId);
  if (!snap) return null;
  const live = await liveShopRows_(db, orgId);
  if (!live) return null;
  const skip = new Set(["updatedAt"]);
  const diff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !skip.has(k) && JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
  const pubBy = new Map(snap.products.map(p => [p.productId, p]));
  const restore = [], added = [], missing = [];
  for (const p of live.products) {
    const was = pubBy.get(p.productId);
    if (!was) {
      let history = false;
      for (const t of PRODUCT_HISTORY_TABLES_) {
        const r = await db.prepare(`SELECT 1 FROM ${t} WHERE orgId=? AND productId=? LIMIT 1`).bind(orgId, p.productId).first().catch(() => null);
        if (r) { history = true; break; }
      }
      added.push({ productId: p.productId, name: p.name || p.productId, history });
    } else if (JSON.stringify(Object.keys(p).sort().map(k => [k, p[k]])) !== JSON.stringify(Object.keys(was).sort().map(k => [k, was[k]]))) {
      restore.push({ productId: p.productId, name: was.name || p.productId, fields: diff(was, p) });
    }
  }
  const liveIds = new Set(live.products.map(p => p.productId));
  for (const p of snap.products) if (!liveIds.has(p.productId)) missing.push({ productId: p.productId, name: p.name || p.productId });
  const shopFields = diff(snap.org, live.org);
  const shopChanged = JSON.stringify(Object.keys(snap.org).sort().map(k => [k, snap.org[k]])) !== JSON.stringify(Object.keys(live.org).sort().map(k => [k, live.org[k]]));
  return { orgId, publishedAt: snap.publishedAt, publishedBy: snap.publishedBy, shopChanged, shopFields, restore, added, missing,
    anything: shopChanged || restore.length > 0 || added.length > 0 || missing.length > 0, snap, live };
}
export async function discardShopChanges(db, orgId) {
  const plan = await planDiscardShopChanges(db, orgId);
  if (!plan) return null;
  const cols = async (table) => new Set(((await db.prepare(`PRAGMA table_info(${table})`).all()).results || []).map(c => c.name));
  const orgCols = await cols("orgs"), productCols = await cols("products");
  const stmts = [];
  if (plan.shopChanged) {
    const ks = Object.keys(plan.snap.org).filter(k => k !== "orgId" && orgCols.has(k));
    if (ks.length) stmts.push(db.prepare(`UPDATE orgs SET ${ks.map(k => `"${k}"=?`).join(", ")} WHERE orgId=?`).bind(...ks.map(k => plan.snap.org[k]), orgId));
  }
  const pubBy = new Map(plan.snap.products.map(p => [p.productId, p]));
  for (const r of plan.restore) {
    const was = pubBy.get(r.productId), ks = Object.keys(was).filter(k => k !== "orgId" && k !== "productId" && productCols.has(k));
    stmts.push(db.prepare(`UPDATE products SET ${ks.map(k => `"${k}"=?`).join(", ")} WHERE orgId=? AND productId=?`).bind(...ks.map(k => was[k]), orgId, r.productId));
  }
  for (const m of plan.missing) {
    const was = pubBy.get(m.productId), ks = Object.keys(was).filter(k => productCols.has(k));
    stmts.push(db.prepare(`INSERT INTO products (${ks.map(k => `"${k}"`).join(", ")}) VALUES (${ks.map(() => "?").join(", ")})`).bind(...ks.map(k => was[k])));
  }
  const deleted = [], hidden = [];
  for (const a of plan.added) {
    if (a.history) { stmts.push(db.prepare("UPDATE products SET visible=0 WHERE orgId=? AND productId=?").bind(orgId, a.productId)); hidden.push(a); continue; }
    for (const t of ["product_blank_links", "product_designs", "product_graphic_images", "ready_to_ship"]) stmts.push(db.prepare(`DELETE FROM ${t} WHERE orgId=? AND productId=?`).bind(orgId, a.productId));
    stmts.push(db.prepare("DELETE FROM products WHERE orgId=? AND productId=?").bind(orgId, a.productId));
    deleted.push(a);
  }
  if (stmts.length) await db.batch(stmts);
  const removedRows = plan.live.products.filter(p => deleted.some(d => d.productId === p.productId));
  return { restored: plan.restore.length, shopRestored: plan.shopChanged, reinserted: plan.missing.length, deleted, hidden, removedRows };
}

// The admin's link to preview a shop's unpublished draft: HMAC over the shop id and an expiry (1 hour), with the
// install's signing secret under its own label. Only the admin mints one (getPreviewLink); catalog.js checks it.
// (Plain functions returning promises, like the rest of this file's exports.)
const PREVIEW_TOKEN_TTL_SECONDS_ = 60 * 60;
function previewMac_(env, data) {
  const secret = (env && (env.SIGNING_SECRET || env.LINK_SIGNING_SECRET || env.QUOTE_SIGNING_SECRET || env.STRIPE_SECRET_KEY)) || "";
  if (!secret) return Promise.resolve(null);
  const enc = new TextEncoder();
  return crypto.subtle.importKey("raw", enc.encode("odd-catalog-preview-v1:" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .then(key => crypto.subtle.sign("HMAC", key, enc.encode(data)))
    .then(sig => Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, "0")).join(""));
}
export function signPreviewToken(env, orgId) {
  if (!orgId) return Promise.resolve(null);
  const exp = Math.floor(Date.now() / 1000) + PREVIEW_TOKEN_TTL_SECONDS_;
  return previewMac_(env, String(orgId) + "|" + exp).then(mac => mac ? exp + "." + mac : null);
}
export function verifyPreviewToken(env, orgId, token) {
  const m = /^(\d{9,12})\.([0-9a-f]{64})$/.exec(typeof token === "string" ? token : "");
  if (!orgId || !m || Number(m[1]) < Math.floor(Date.now() / 1000)) return Promise.resolve(false);
  return previewMac_(env, String(orgId) + "|" + m[1]).then(expected => {
    if (!expected) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2].charCodeAt(i);
    return diff === 0;
  });
}
// The shop as shoppers see it (published orgs row), for order submission's checks (open, deadline, delivery fees).
export async function getPublishedOrg(db, orgId) {
  const rows = await publishedShopRows_(db, orgId).catch(() => null);
  return rows && rows.org ? parseOrg_(rows.org) : null;
}
export async function publishedProductRow_(db, orgId, productId) {
  const snap = await getCatalogSnapshot(db, orgId);
  if (snap) return snap.products.find(p => p.productId === productId) || null;
  return db.prepare("SELECT * FROM products WHERE orgId=? AND productId=?").bind(orgId, productId).first();
}
// Per shop: never published, published and current, or with unpublished changes (which products / shop settings).
// A row "changed" when any stored value differs — updatedAt included, so saving with no change also counts.
export async function getPublishState(db) {
  const { results: orgs } = await db.prepare("SELECT orgId FROM orgs ORDER BY orgId").all();
  const out = {};
  for (const { orgId } of orgs) {
    const snap = await getCatalogSnapshot(db, orgId);
    if (!snap) { out[orgId] = { state: "never" }; continue; }
    const live = await liveShopRows_(db, orgId);
    const key = (r) => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]]));
    const pubBy = new Map(snap.products.map(p => [p.productId, key(p)]));
    const liveBy = new Map(live.products.map(p => [p.productId, key(p)]));
    const changed = [];
    for (const [id, k] of liveBy) if (pubBy.get(id) !== k) changed.push(id);
    for (const id of pubBy.keys()) if (!liveBy.has(id)) changed.push(id);
    const shopChanged = key(snap.org) !== key(live.org);
    out[orgId] = { state: changed.length || shopChanged ? "changed" : "current", publishedAt: snap.publishedAt, publishedBy: snap.publishedBy, changedProducts: changed, shopChanged };
  }
  return out;
}

export async function createOrg(db, o) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO orgs
    (orgId,subdomain,name,eyebrow,accent,desc,ready,shippingEnabled,enabledPayments,
     orderDeadline,closedMessage,allowOrdersAfterDeadline,
     designImageShirt,designImageCap,designImageDetail,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      o.orgId, o.subdomain, o.name, o.eyebrow || "", o.accent || "#2563eb",
      o.desc || "", o.ready ? 1 : 0, o.shippingEnabled ? 1 : 0,
      JSON.stringify(o.enabledPayments || { card: true, venmo: true, zelle: true, check: true }),
      o.orderDeadline || null,
      o.closedMessage || null, o.allowOrdersAfterDeadline !== false ? 1 : 0,
      o.designImageShirt || "", o.designImageCap || "", o.designImageDetail || "",
      now, now
    ).run();
}

// Written separately from updateOrg on purpose: updateOrg overwrites every
// column, so a caller that doesn't know about tax fields
// must not be able to silently clear an org's exemption.
export async function setOrgTaxExemption(db, orgId, { taxExempt, certificate, expires }) {
  await db.prepare("UPDATE orgs SET taxExempt=?, taxExemptCertificate=?, taxExemptExpires=?, updatedAt=? WHERE orgId=?")
    .bind(taxExempt ? 1 : 0, certificate || "", expires || null, new Date().toISOString(), orgId).run();
}

// Open or close a shop for orders without touching anything else on it (Shop setup → Go live). Like every shop
// setting it reaches shoppers on the shop's next Publish.
export async function setOrgReady(db, orgId, ready) {
  await db.prepare("UPDATE orgs SET ready = ?, updatedAt = ? WHERE orgId = ?").bind(ready ? 1 : 0, new Date().toISOString(), orgId).run();
}

export async function updateOrg(db, orgId, o) {
  const now = new Date().toISOString();
  await db.prepare(`UPDATE orgs SET
    subdomain=?, name=?, eyebrow=?, accent=?, desc=?, ready=?, shippingEnabled=?,
    enabledPayments=?, orderDeadline=?, closedMessage=?, allowOrdersAfterDeadline=?,
    designImageShirt=?, designImageCap=?, designImageDetail=?, updatedAt=?
    WHERE orgId=?`)
    .bind(
      o.subdomain,
      o.name, o.eyebrow || "", o.accent || "#2563eb", o.desc || "",
      o.ready ? 1 : 0, o.shippingEnabled ? 1 : 0,
      JSON.stringify(o.enabledPayments || { card: true, venmo: true, zelle: true, check: true }),
      o.orderDeadline || null,
      o.closedMessage || null, o.allowOrdersAfterDeadline !== false ? 1 : 0,
      o.designImageShirt || "", o.designImageCap || "", o.designImageDetail || "",
      now, orgId
    ).run();
}

// ---- Delivery / pickup options per shop (migrations/0045) ---------------------------------------
// The list a customer picks from at checkout: at most one `pickup` (Local pickup, free), at most one
// `shipping` (carrier rates by ZIP — the fee varies, so it's null here) and any number of `custom`
// entries with the shop's own wording and a flat fee ("Delivery at practice", $0). Order matters:
// it's the order shown, and the first non-shipping entry is preselected.
export const DELIVERY_MAX_OPTIONS = 12;
const DELIVERY_PICKUP_ = { id: "pickup", type: "pickup", label: "Local pickup", fee: 0 };
const DELIVERY_SHIPPING_ = { id: "shipping", type: "shipping", label: "Shipping", fee: null };
// What a shop with no saved list offers: free local pickup, plus carrier shipping when enabled.
export function defaultDeliveryOptions(shippingEnabled) {
  return [{ ...DELIVERY_PICKUP_ }, ...(shippingEnabled ? [{ ...DELIVERY_SHIPPING_ }] : [])];
}
// Validates and tidies a list from the admin form (or from storage). → { options } or { error }.
export function cleanDeliveryOptions(list) {
  if (!Array.isArray(list) || !list.length) return { error: "Add at least one delivery or pickup option." };
  if (list.length > DELIVERY_MAX_OPTIONS) return { error: `That's more than ${DELIVERY_MAX_OPTIONS} delivery options.` };
  const out = [], ids = new Set(), names = new Set();
  for (const raw of list) {
    const type = raw && raw.type;
    if (type === "pickup" || type === "shipping") {
      if (out.some(o => o.type === type)) return { error: type === "pickup" ? "Local pickup can only be in the list once." : "Shipping can only be in the list once." };
      out.push(type === "pickup" ? { ...DELIVERY_PICKUP_ } : { ...DELIVERY_SHIPPING_ });
      continue;
    }
    if (type !== "custom") return { error: "Unknown delivery option type." };
    const label = String(raw.label == null ? "" : raw.label).replace(/\s+/g, " ").trim().slice(0, 60);
    if (!label) return { error: "Give each custom delivery option a name." };
    if (names.has(label.toLowerCase())) return { error: `Two delivery options are both named "${label}".` };
    names.add(label.toLowerCase());
    const fee = raw.fee == null || raw.fee === "" ? 0 : Number(raw.fee);
    if (!Number.isFinite(fee) || fee < 0 || fee > 1000) return { error: `The fee for "${label}" must be a number from 0 to 1000.` };
    let id = /^c[a-z0-9]{6,16}$/.test(String(raw.id || "")) && !ids.has(raw.id) ? raw.id : "";
    while (!id || ids.has(id)) id = "c" + [...crypto.getRandomValues(new Uint8Array(5))].map(b => b.toString(16).padStart(2, "0")).join("");
    ids.add(id);
    out.push({ id, type: "custom", label, fee: Math.round(fee * 100) / 100 });
  }
  return { options: out };
}
// Written apart from updateOrg (which overwrites every column it knows), so a caller that has never
// heard of the list can't clear it. Keeps orgs.shippingEnabled in step with the list.
export async function setOrgDeliveryOptions(db, orgId, options) {
  await db.prepare("UPDATE orgs SET deliveryOptionsJson=?, shippingEnabled=?, updatedAt=? WHERE orgId=?")
    .bind(JSON.stringify(options), options.some(o => o.type === "shipping") ? 1 : 0, new Date().toISOString(), orgId).run();
}

function parseOrg_(row) {
  // A stored list wins; without one the shop offers the default (see defaultDeliveryOptions).
  const stored = row.deliveryOptionsJson ? cleanDeliveryOptions(tryParse_(row.deliveryOptionsJson, null)) : null;
  const deliveryOptions = stored && stored.options ? stored.options : defaultDeliveryOptions(!!row.shippingEnabled);
  return {
    orgId: row.orgId,
    subdomain: row.subdomain,
    name: row.name,
    eyebrow: row.eyebrow || "",
    accent: row.accent || "#2563eb",
    desc: row.desc || "",
    ready: !!row.ready,
    shippingEnabled: deliveryOptions.some(o => o.type === "shipping"),
    deliveryOptions,
    deliveryOptionsStored: !!(stored && stored.options),
    enabledPayments: tryParse_(row.enabledPayments, { card: true, venmo: true, zelle: true, check: true }),
    orderDeadline: row.orderDeadline || null,
    closedMessage: row.closedMessage || null,
    allowOrdersAfterDeadline: row.allowOrdersAfterDeadline !== 0,
    taxExempt: !!row.taxExempt,
    taxExemptCertificate: row.taxExemptCertificate || "",
    taxExemptExpires: row.taxExemptExpires || "",
    designImages: {
      shirt: row.designImageShirt || "",
      cap: row.designImageCap || "",
      detail: row.designImageDetail || "",
    },
  };
}

// ---- Product helpers ----------------------------------------------------

export async function getProductsByOrg(db, orgId, visibleOnly = false) {
  const sql = visibleOnly
    ? "SELECT * FROM products WHERE orgId=? AND visible=1 ORDER BY sortOrder, productId"
    : "SELECT * FROM products WHERE orgId=? ORDER BY sortOrder, productId";
  const { results } = await db.prepare(sql).bind(orgId).all();
  return productsFromRows_(db, orgId, results);
}
// Parsed products (+ their designs) from products rows — live, or a published snapshot's (migrations/0076).
async function productsFromRows_(db, orgId, results) {
  const products = results.map(parseProduct_);
  // Each product's designs in run order (migrations/0032) — one query for the whole org.
  const byProduct = {};
  try {
    const { results: pd } = await db.prepare(
      "SELECT * FROM product_designs WHERE orgId=? ORDER BY sortOrder, id").bind(orgId).all();
    for (const r of pd) (byProduct[r.productId] = byProduct[r.productId] || []).push(parseProductDesign_(r));
  } catch (e) { /* pre-0032 database */ }
  products.forEach(p => {
    p.designs = byProduct[p.productId] || [];
    if (p.customDesign) p.customDesignRequired = customDesignRequired(p);   // migrations/0054
  });
  // Shipping weight (migrations/0077): the product's own weightOz is an override; otherwise its linked blank sizes'.
  const weights = await getBlankWeights(db, orgId);
  products.forEach(p => {
    const w = weights[orgId + "|" + p.productId];
    p.blankWeightOz = w ? w.max : null;
    p.blankWeightBySize = w ? w.bySize : {};
    p.shipWeightOz = productShipWeightOz(p);
  });
  return products;
}

// Linked blank weights per product (migrations/0077): {"orgId|productId": {bySize: {size: oz}, max}} — a size's weight is
// its heaviest linked color. orgId null = every shop. A database before 0076 answers {}.
export async function getBlankWeights(db, orgId) {
  const out = {};
  try {
    const { results } = await db.prepare(`SELECT l.orgId, l.productId, l.productSize, MAX(bs.weightOz) AS w
      FROM product_blank_links l JOIN blank_sizes bs ON bs.blankId = l.blankId AND bs.color = l.blankColor AND bs.size = l.blankSize
      WHERE bs.weightOz IS NOT NULL ${orgId ? "AND l.orgId = ?" : ""} GROUP BY l.orgId, l.productId, l.productSize`).bind(...(orgId ? [orgId] : [])).all();
    for (const r of results) {
      const k = r.orgId + "|" + r.productId, w = Number(r.w);
      if (!(w > 0)) continue;
      const e = out[k] = out[k] || { bySize: {}, max: null };
      e.bySize[r.productSize || "OSFA"] = w;
      if (e.max == null || w > e.max) e.max = w;
    }
  } catch (e) { /* pre-0076 database */ }
  return out;
}
// One piece's shipping weight in ounces: the product's own weight (an override), else its linked blank's for that size,
// else the heaviest linked size; null = not known (callers fall back to their default).
export function productShipWeightOz(p, size) {
  if (!p) return null;
  if (p.weightOz != null && Number(p.weightOz) > 0) return Number(p.weightOz);
  const by = p.blankWeightBySize || {};
  const z = size == null || size === "" ? "OSFA" : String(size);
  if (by[z] > 0) return by[z];
  return p.blankWeightOz > 0 ? p.blankWeightOz : null;
}

export async function createProduct(db, orgId, p) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT OR REPLACE INTO products
    (productId,orgId,type,name,sub,weightOz,personalizationPriceCents,personalizationOptions,
     pricingMode,flatPriceCents,sizePricingCents,imagesJson,featuresJson,visible,sortOrder,createdAt,updatedAt,taxable)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      p.productId, orgId, p.type, p.name, p.sub || "",
      p.weightOz ?? null, toCentsOrNull(p.personalizationPrice),
      JSON.stringify(p.personalizationOptions || []),
      p.pricingMode, toCentsOrNull(p.flatPrice),
      JSON.stringify(mapValues_(p.sizePricing, toCents)),
      JSON.stringify(p.images || []),
      JSON.stringify(p.features || []),
      p.visible ? 1 : 0, p.sortOrder ?? 0,
      now, now, p.taxable === false ? 0 : 1
    ).run();
  if (p.noDesignNeeded !== undefined) await setProductNoDesignNeeded_(db, orgId, p.productId, !!p.noDesignNeeded);
  if (p.noBlankNeeded !== undefined) await setProductNoBlankNeeded_(db, orgId, p.productId, !!p.noBlankNeeded);
  if (p.versionGroup !== undefined || p.versionLabel !== undefined) await setProductVersion(db, orgId, p.productId, { group: p.versionGroup, label: p.versionLabel });
  if (p.customDesign !== undefined) await setProductCustomDesign_(db, orgId, p.productId, p.customDesign, p.customDesignPrice);
  await setProductConfig_(db, orgId, p);
  if (p.personalizationMode !== undefined || p.personalizationOptionDesigns !== undefined || p.personalizationHoopId !== undefined)
    await setProductPersonalization(db, orgId, p.productId, { mode: p.personalizationMode, hoopId: p.personalizationHoopId, optionDesigns: p.personalizationOptionDesigns });
  if (p.colorGroupsCents !== undefined) await setProductColorGroups_(db, orgId, p.productId, p.colorGroupsCents);
  await setProductCosting_(db, orgId, p);
}

// The order a shop's products are listed in (admin → Products → ↑ ↓). `productIds` is EVERY product
// of the shop, in the order wanted; anything else (a product added or removed in another tab since
// the list was drawn) is refused rather than half-applied. Numbers go up in tens, so a product can
// still be slotted between two others from its own form. Returns how many rows changed.
export async function setProductOrder(db, orgId, productIds) {
  const ids = (Array.isArray(productIds) ? productIds : []).map(String);
  const { results } = await db.prepare("SELECT productId, sortOrder FROM products WHERE orgId=?").bind(orgId).all();
  const have = new Map(results.map(r => [r.productId, Number(r.sortOrder) || 0]));
  if (ids.length !== have.size || new Set(ids).size !== ids.length || ids.some(id => !have.has(id))) {
    throw new Error("The product list changed since this page was loaded — reload it and try again");
  }
  const stmts = [];
  ids.forEach((id, i) => {
    const n = (i + 1) * 10;
    if (have.get(id) !== n) stmts.push(db.prepare("UPDATE products SET sortOrder=? WHERE orgId=? AND productId=?").bind(n, orgId, id));
  });
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

// Copy products from one shop to another (admin → Products → Copy from another shop). `rows` say which
// source products and what each copy is called: [{fromProductId, productId, name, sub, type,
// versionLabel, visible}] — the caller has already checked the ids, names and categories. A copy takes
// everything about the product — prices and sizes, weight, features, personalization, garment colors,
// configurable locations, settings, blank links (blanks are shared by every shop) — and its photos only
// when `copyImages`. Never its overlay mockups or its ready-to-ship stock. The source shop's own artwork
// can't come along: a graphic or a (non-global) design is matched to THIS shop's one of the same name,
// else left out, and each copy's `notes` say what was matched or left out. Versions of a product
// (migrations/0059) are copied together or not at all and linked again under their new ids.
// Throws a userFacing error (nothing written) for an unknown source product, an id this shop already
// has or that's used twice, or a version whose other version isn't in the list.
export async function copyProductsFromOrg(db, fromOrg, toOrg, rows, { copyImages = false } = {}) {
  const src = new Map((await getProductsByOrg(db, fromOrg, false)).map(p => [p.productId, p]));
  const mine = await getProductsByOrg(db, toOrg, false);
  const taken = new Set(mine.map(p => p.productId));
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  for (const r of list) {
    if (!src.has(r.fromProductId)) throw pricingError_(`“${r.fromProductId}” isn't a product of the shop you're copying from.`);
    if (taken.has(r.productId)) throw pricingError_(`This shop already has a product with the id “${r.productId}” — give the copy another id.`);
    if (seen.has(r.productId)) throw pricingError_(`The id “${r.productId}” is used for two copies — give each its own.`);
    seen.add(r.productId);
  }
  const picked = new Set(list.map(r => r.fromProductId));
  for (const r of list) {
    const g = src.get(r.fromProductId).versionGroup;
    if (!g) continue;
    const missing = [...src.values()].filter(p => p.versionGroup === g && !picked.has(p.productId));
    if (missing.length) throw pricingError_(`“${src.get(r.fromProductId).name}” comes in versions — copy ${missing.map(p => `“${p.versionLabel || p.productId}”`).join(" and ")} too.`);
  }
  // This shop's graphics and designs, by name, for the source's own artwork.
  const key = (s) => String(s || "").trim().toLowerCase();
  const myGraphics = new Map(), myDesigns = new Map(), designById = new Map();
  for (const g of await listGraphics(db, toOrg)) if (g.orgId === toOrg && !myGraphics.has(g.kind + "|" + key(g.name))) myGraphics.set(g.kind + "|" + key(g.name), g);
  for (const d of await listDesigns(db, toOrg)) if (d.orgId === toOrg && !myDesigns.has(key(d.name))) myDesigns.set(key(d.name), d);
  for (const d of await listDesigns(db, fromOrg)) designById.set(Number(d.id), d);
  const srcGraphics = new Map((await listGraphics(db, fromOrg)).map(g => [Number(g.id), g]));
  const blankLinks = await getBlankLinks(db, fromOrg);
  // A design the copy may use: a global one as it is, else this shop's of the same name, else none.
  const mapDesign = (id, notes, what) => {
    const d = designById.get(Number(id));
    if (!d) return null;
    if (d.isGlobal) return Number(d.id);
    const m = myDesigns.get(key(d.name));
    notes.push(m ? `${what} “${d.name}” → this shop's design of the same name` : `${what} “${d.name}” belongs to the other shop — left out; link this shop's design`);
    return m ? Number(m.id) : null;
  };
  const mapGraphic = (id, notes, where) => {
    const g = srcGraphics.get(Number(id));
    if (!g) return null;
    if (g.isGlobal) return Number(g.id);   // a global graphic (migrations/0078) is every shop's — kept as it is
    const m = myGraphics.get(g.kind + "|" + key(g.name));
    notes.push(m ? `${where}: graphic “${g.name}” → this shop's graphic of the same name` : `${where}: graphic “${g.name}” isn't in this shop — left out`);
    return m ? Number(m.id) : null;
  };
  const groupId = {};   // source version group → the new id of its first copy
  let sortOrder = mine.reduce((n, p) => Math.max(n, Number(p.sortOrder) || 0), 0);
  const copied = [];
  for (const r of list) {
    const p = src.get(r.fromProductId), notes = [];
    const locations = (p.locations || []).map(loc => Object.assign({}, loc, {
      graphicIds: (loc.graphicIds || []).map(id => mapGraphic(id, notes, loc.label || loc.key)).filter(id => id != null) }));
    // Printed transfers (migrations/0068) use this shop's graphic of the same name; locations are shared.
    const fixedTransfers = (p.fixedTransfers || []).map(f => ({ ...f, graphicId: mapGraphic(f.graphicId, notes, "Printed transfer") })).filter(f => f.graphicId != null);
    const mockupGraphics = (p.mockupGraphics || []).map(f => ({ ...f, graphicId: mapGraphic(f.graphicId, notes, "Embroidered graphic (mockups)") })).filter(f => f.graphicId != null);
    const graphicMap = {};
    for (const loc of p.locations || []) for (const id of loc.graphicIds || []) { const g = srcGraphics.get(Number(id)); const m = g && (g.isGlobal ? g : myGraphics.get(g.kind + "|" + key(g.name))); if (m) graphicMap[Number(id)] = Number(m.id); }
    const optionDesigns = {};
    for (const [opt, id] of Object.entries(p.personalizationOptionDesigns || {})) { const m = mapDesign(id, notes, `Pick-list option “${opt}”: design`); if (m) optionDesigns[opt] = m; }
    if (p.versionGroup && !groupId[p.versionGroup]) groupId[p.versionGroup] = r.productId;
    sortOrder += 10;
    await createProduct(db, toOrg, Object.assign({}, p, {
      productId: r.productId, name: r.name, sub: r.sub, type: r.type, visible: !!r.visible, sortOrder,
      images: copyImages ? (p.images || []) : [], locations, fixedTransfers, mockupGraphics, personalizationOptionDesigns: optionDesigns,
      versionGroup: p.versionGroup ? groupId[p.versionGroup] : "", versionLabel: p.versionGroup ? (r.versionLabel ?? p.versionLabel) : "",
      // Color price groups (migrations/0064) are saved from colorGroupsCents; the parsed product has them in dollars.
      colorGroupsCents: (p.colorGroups || []).map(g => ({ key: g.key, label: g.label, colors: g.colors || [],
        ...(g.flatPrice != null ? { flatPriceCents: toCents(g.flatPrice) } : { sizePricingCents: mapValues_(g.sizePricing || {}, toCents) }) })) }));
    const blocked = (p.blockedGraphicColors || []).filter(b => graphicMap[Number(b.graphicId)]).map(b => ({ graphicId: graphicMap[Number(b.graphicId)], color: b.color }));
    if (blocked.length) await db.prepare("UPDATE products SET blockedGraphicColorsJson=? WHERE orgId=? AND productId=?").bind(JSON.stringify(blocked), toOrg, r.productId).run();
    const designs = (await listProductDesigns(db, fromOrg, p.productId))
      .map(d => ({ designId: mapDesign(d.designId, notes, "Design"), placement: d.placement, isMain: d.isMain })).filter(d => d.designId);
    if (designs.length) await setProductDesigns(db, toOrg, r.productId, designs);
    const links = blankLinks.filter(l => l.productId === p.productId);
    if (links.length) await db.batch(links.map(l => db.prepare(
      "INSERT INTO product_blank_links (orgId, productId, productColor, productSize, blankId, blankColor, blankSize) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(toOrg, r.productId, l.productColor, l.productSize, l.blankId, l.blankColor, l.blankSize)));
    copied.push({ productId: r.productId, fromProductId: p.productId, name: r.name, blankLinks: links.length, images: copyImages ? (p.images || []).length : 0, notes: [...new Set(notes)] });
  }
  return copied;
}


// migrations/0057 — a product made with no blank at all (a patch: twill and thread are shop
// supplies). Written only when the caller sends it, so an importer or script that doesn't know the
// field can't clear it.
// Versions of a product (migrations/0059): `group` links it to its other versions ('' = none), `label`
// names this one ("Long sleeve"). Each is written only when given (undefined = leave it), so callers
// that don't know about versions can't unlink one. Before the migration it's a no-op.
export async function setProductVersion(db, orgId, productId, { group, label } = {}) {
  const sets = [], binds = [];
  if (group !== undefined) { sets.push("versionGroup=?"); binds.push(String(group || "").slice(0, 80)); }
  if (label !== undefined) { sets.push("versionLabel=?"); binds.push(String(label || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 40)); }
  if (!sets.length) return;
  await db.prepare(`UPDATE products SET ${sets.join(", ")} WHERE orgId=? AND productId=?`).bind(...binds, orgId, productId).run()
    .catch((e) => { if (!/no such column/i.test(String(e && e.message))) throw e; });
}
// The other versions of a product (same shop, same non-empty versionGroup), in sort order.
export async function getProductVersions(db, orgId, productId) {
  try {
    const me = await db.prepare("SELECT versionGroup FROM products WHERE orgId=? AND productId=?").bind(orgId, productId).first();
    if (!me || !me.versionGroup) return [];
    const { results } = await db.prepare("SELECT productId, name, versionLabel, visible, type FROM products WHERE orgId=? AND versionGroup=? AND productId<>? ORDER BY sortOrder, productId")
      .bind(orgId, me.versionGroup, productId).all();
    return (results || []).map(r => ({ productId: r.productId, name: r.name || r.productId, label: r.versionLabel || "", visible: !!Number(r.visible), type: r.type || "" }));
  } catch (e) { if (/no such column/i.test(String(e && e.message))) return []; throw e; }
}
// The name an order line gets: the product's, plus its version's label when it is one of a pair —
// "Club Tee (Long sleeve)" — so every screen that shows a line (receipts, packing, Run Order) says which.
export function productLineName(row, productId) {
  const name = (row && row.name) || productId || "";
  return row && row.versionGroup && row.versionLabel ? `${name} (${row.versionLabel})` : name;
}
async function setProductNoBlankNeeded_(db, orgId, productId, on) {
  await db.prepare("UPDATE products SET noBlankNeeded=? WHERE orgId=? AND productId=?").bind(on ? 1 : 0, orgId, productId).run()
    .catch((e) => { if (!/no such column/i.test(String(e && e.message))) throw e; });
}
// True for an order line (row alias `alias`) whose product is marked "No blank needed". A custom
// line with no product still counts as needing a blank, as before.
const noBlankLineSql_ = (alias) => `EXISTS (SELECT 1 FROM products nb WHERE nb.orgId = ${alias}.orgId AND nb.productId = ${alias}.productId AND nb.noBlankNeeded = 1)`;
// The SQL builder to use against THIS database: the real test, or a constant "no" on a database
// that doesn't have the column yet — so the order loaders and queues keep working if the code is
// deployed a moment before the migration. Only a "yes" is remembered (a "no" is re-checked, so the
// column is picked up as soon as it exists).
//
// A line filled from the shop's finished stock (order_items.fromStock, migrations/0060) skips the blank
// steps too — its blanks were used when the stock was made — so it counts here as well: nothing to buy,
// set aside or receive for it. (Run Order and the transfer queue leave it out on top: fromStockLine_.)
const _hasNoBlankColumn = new WeakSet();
async function noBlankLine_(db) {
  if (!_hasNoBlankColumn.has(db)) {
    try { await db.prepare("SELECT noBlankNeeded FROM products LIMIT 0").all(); _hasNoBlankColumn.add(db); }
    catch (e) { if (!/no such (column|table)/i.test(String(e && e.message))) throw e; return () => "0"; }
  }
  if (!(await hasFromStockColumn_(db))) return noBlankLineSql_;
  return (alias) => `(${noBlankLineSql_(alias)} OR COALESCE(${alias}.fromStock, 0) = 1)`;
}
// order_items.fromStock (migrations/0060) — only a "yes" is remembered, like the check above.
const _hasFromStockColumn = new WeakSet();
async function hasFromStockColumn_(db) {
  if (_hasFromStockColumn.has(db)) return true;
  try { await db.prepare("SELECT fromStock FROM order_items LIMIT 0").all(); _hasFromStockColumn.add(db); return true; }
  catch (e) { if (!/no such (column|table)/i.test(String(e && e.message))) throw e; return false; }
}
// SQL for "this line (alias) is filled from finished stock", or a constant "no" before the migration.
async function fromStockLine_(db) {
  return (await hasFromStockColumn_(db)) ? (alias) => `COALESCE(${alias}.fromStock, 0) = 1` : () => "0";
}

// migrations/0034 — a product that never needs an embroidery design (DTF, …).
async function setProductNoDesignNeeded_(db, orgId, productId, on) {
  await db.prepare("UPDATE products SET noDesignNeeded=? WHERE orgId=? AND productId=?").bind(on ? 1 : 0, orgId, productId).run()
    .catch((e) => { if (!/no such column/i.test(String(e && e.message))) throw e; });
}

// migrations/0054 — the customer may upload their own design: kind '' (off) | 'embroidery' |
// 'transfer', and the add-on per piece in dollars (null = free). Only written when the caller sends
// `customDesign`; safe on a pre-0054 database.
export const CUSTOM_DESIGN_KINDS = ["", "embroidery", "transfer"];
// Is the customer's upload REQUIRED to order this product? Yes when it's an ordinary product with
// no design of its own (no main design, none in product_designs, and not marked "No embroidery
// design needed"): the upload is then the only thing the line is made from. Otherwise it's an
// optional upload that replaces the product's own design on that line. A configurable product
// offers it as one more choice at each location, so it's never required there.
export function customDesignRequired(p) {
  if (!p || !p.customDesign || Number(p.configurable)) return false;
  const designCount = Array.isArray(p.designs) ? p.designs.length : Number(p.designCount) || 0;
  return p.designId == null && !designCount && !Number(p.noDesignNeeded);
}

async function setProductCustomDesign_(db, orgId, productId, kind, price) {
  const k = CUSTOM_DESIGN_KINDS.includes(kind) ? kind : "";
  await db.prepare("UPDATE products SET customDesign=?, customDesignPriceCents=? WHERE orgId=? AND productId=?")
    .bind(k, k ? toCentsOrNull(price) : null, orgId, productId).run()
    .catch((e) => { if (!/no such column/i.test(String(e && e.message))) throw e; });
}

// migrations/0036 — configurable-product fields (only the ones provided are written; safe on a
// pre-0036 DB). `reorderQr` is 'default' | 'none' | 't<transferId>' (migrations/0047; a bare number is
// the old way — a graphic id — and still works).
async function setProductConfig_(db, orgId, p) {
  const sets = [], binds = [];
  if (p.configurable !== undefined)   { sets.push("configurable=?");       binds.push(p.configurable ? 1 : 0); }
  if (p.garmentColors !== undefined)  { sets.push("garmentColorsJson=?");  binds.push(JSON.stringify(Array.isArray(p.garmentColors) ? p.garmentColors : [])); }
  if (p.locations !== undefined)      { sets.push("locationsJson=?");      binds.push(JSON.stringify(Array.isArray(p.locations) ? p.locations : [])); }
  if (p.reorderQr !== undefined)      { sets.push("reorderQr=?");          binds.push(String(p.reorderQr || "default").slice(0, 40)); }
  // migrations/0068 — printed transfers that are part of the product (orders.js cleanFixedTransfers_ checked them).
  if (p.fixedTransfers !== undefined) { sets.push("fixedTransfersJson=?"); binds.push(JSON.stringify(Array.isArray(p.fixedTransfers) ? p.fixedTransfers : [])); }
  // migrations/0069 — embroidered graphics for mockups only (orders.js checkMockupGraphics_ checked them).
  if (p.mockupGraphics !== undefined) { sets.push("mockupGraphicsJson=?"); binds.push(JSON.stringify(Array.isArray(p.mockupGraphics) ? p.mockupGraphics : [])); }
  if (!sets.length) return;
  await db.prepare(`UPDATE products SET ${sets.join(", ")} WHERE orgId=? AND productId=?`).bind(...binds, orgId, p.productId).run()
    .catch((e) => { if (!/no such column/i.test(String(e && e.message))) throw e; });
}

// The three pricing-awareness numbers (migrations/0067), each only when sent; null / "" clears it. The caller
// (orders.js checkCosting_) has already checked them.
async function setProductCosting_(db, orgId, p) {
  const sets = [], binds = [];
  const num = (v) => v === null || v === "" || v === undefined ? null : Number(v);
  if (p.runMinutes !== undefined)   { sets.push("runMinutes=?");        binds.push(num(p.runMinutes)); }
  if (p.transferCost !== undefined) { sets.push("transferCostCents=?"); binds.push(toCentsOrNull(num(p.transferCost))); }
  if (p.suppliesCost !== undefined) { sets.push("suppliesCostCents=?"); binds.push(toCentsOrNull(num(p.suppliesCost))); }
  if (!sets.length) return;
  await db.prepare(`UPDATE products SET ${sets.join(", ")} WHERE orgId=? AND productId=?`).bind(...binds, orgId, p.productId).run()
    .catch((e) => { if (!/no such column/i.test(String(e && e.message))) throw e; });
}

export async function updateProduct(db, orgId, p) {
  await setProductCosting_(db, orgId, p);
  if (p.colorGroupsCents !== undefined) await setProductColorGroups_(db, orgId, p.productId, p.colorGroupsCents);
  if (p.noDesignNeeded !== undefined) await setProductNoDesignNeeded_(db, orgId, p.productId, !!p.noDesignNeeded);
  if (p.noBlankNeeded !== undefined) await setProductNoBlankNeeded_(db, orgId, p.productId, !!p.noBlankNeeded);
  if (p.versionGroup !== undefined || p.versionLabel !== undefined) await setProductVersion(db, orgId, p.productId, { group: p.versionGroup, label: p.versionLabel });
  if (p.customDesign !== undefined) await setProductCustomDesign_(db, orgId, p.productId, p.customDesign, p.customDesignPrice);
  await setProductConfig_(db, orgId, p);
  if (p.personalizationMode !== undefined || p.personalizationOptionDesigns !== undefined || p.personalizationHoopId !== undefined)
    await setProductPersonalization(db, orgId, p.productId, { mode: p.personalizationMode, hoopId: p.personalizationHoopId, optionDesigns: p.personalizationOptionDesigns });
  const now = new Date().toISOString();
  await db.prepare(`UPDATE products SET
    type=?,name=?,sub=?,weightOz=?,personalizationPriceCents=?,personalizationOptions=?,
    pricingMode=?,flatPriceCents=?,sizePricingCents=?,imagesJson=?,featuresJson=?,
    visible=?,sortOrder=?,updatedAt=?,taxable=COALESCE(?, taxable)
    WHERE orgId=? AND productId=?`)
    .bind(
      p.type, p.name, p.sub || "",
      p.weightOz ?? null, toCentsOrNull(p.personalizationPrice),
      JSON.stringify(p.personalizationOptions || []),
      p.pricingMode, toCentsOrNull(p.flatPrice),
      JSON.stringify(mapValues_(p.sizePricing, toCents)),
      JSON.stringify(p.images || []),
      JSON.stringify(p.features || []),
      p.visible ? 1 : 0, p.sortOrder ?? 0,
      now, p.taxable === undefined ? null : (p.taxable ? 1 : 0), orgId, p.productId
    ).run();
}

export async function setProductVisible(db, orgId, productId, visible) {
  await db.prepare("UPDATE products SET visible=?, updatedAt=? WHERE orgId=? AND productId=?")
    .bind(visible ? 1 : 0, new Date().toISOString(), orgId, productId).run();
}

function parseProduct_(row) {
  return {
    productId: row.productId,
    orgId: row.orgId,
    type: row.type,
    name: row.name,
    sub: row.sub || "",
    weightOz: row.weightOz ?? null,
    personalizationPrice: fromCentsOrNull(row.personalizationPriceCents),
    personalizationOptions: tryParse_(row.personalizationOptions, []),
    pricingMode: row.pricingMode,
    flatPrice: fromCentsOrNull(row.flatPriceCents),
    sizePricing: mapValues_(tryParse_(row.sizePricingCents, {}), fromCents),
    images: tryParse_(row.imagesJson, []),
    features: tryParse_(row.featuresJson, []),
    visible: !!row.visible,
    sortOrder: row.sortOrder ?? 0,
    taxable: row.taxable === undefined ? true : !!row.taxable,
    pricesReviewedAt: row.pricesReviewedAt || "",   // migrations/0062
    // migrations/0064 — color price groups, in dollars: [{key, label, colors, sizePricing | flatPrice}].
    colorGroups: (tryParse_(row.colorGroupsJson, []) || []).map(g => ({ key: g.key, label: g.label, colors: g.colors || [],
      ...(g.flatPriceCents != null ? { flatPrice: fromCents(g.flatPriceCents) } : { sizePricing: mapValues_(g.sizePricingCents || {}, fromCents) }) })),
    designId: row.designId == null ? null : Number(row.designId),
    // migrations/0032 — see setProductPersonalization / setProductDesigns.
    personalizationMode: row.personalizationMode === "separate" ? "separate" : "combined",
    personalizationHoopId: row.personalizationHoopId == null ? null : Number(row.personalizationHoopId),
    personalizationOptionDesigns: tryParse_(row.personalizationOptionDesigns, {}) || {},
    noDesignNeeded: !!Number(row.noDesignNeeded),   // migrations/0034
    noBlankNeeded: !!Number(row.noBlankNeeded),     // migrations/0057
    blockedGraphicColors: tryParse_(row.blockedGraphicColorsJson, []) || [],   // migrations/0050: [{graphicId, color}] not offered
    // migrations/0054 — the customer's own design: '' off | 'embroidery' | 'transfer', and its add-on.
    customDesign: CUSTOM_DESIGN_KINDS.includes(row.customDesign) ? row.customDesign : "",
    customDesignPrice: row.customDesign ? fromCentsOrNull(row.customDesignPriceCents) : null,
    versionGroup: row.versionGroup || "",         // migrations/0059: versions of a product (short / long sleeve)
    versionLabel: row.versionLabel || "",
    // migrations/0036 — configurable products (per-location option menus + reorder QR).
    configurable: !!Number(row.configurable),
    garmentColors: tryParse_(row.garmentColorsJson, []) || [],
    locations: tryParse_(row.locationsJson, []) || [],
    reorderQr: row.reorderQr || "default",
    // migrations/0068 — printed transfers (DTF) at fixed locations, part of the product and its price.
    fixedTransfers: (tryParse_(row.fixedTransfersJson, []) || []).map(f => ({ locationId: f.locationId == null ? null : Number(f.locationId),
      graphicId: Number(f.graphicId), ink: String(f.ink || "") })),
    // migrations/0069 — embroidered graphics shown on mockups only (never on an order line).
    mockupGraphics: (tryParse_(row.mockupGraphicsJson, []) || []).map(f => ({ locationId: f.locationId == null ? null : Number(f.locationId), graphicId: Number(f.graphicId) })),
    // migrations/0067 — pricing awareness: minutes to make one, extra DTF / transfer cost, supplies override.
    runMinutes: row.runMinutes == null ? null : Number(row.runMinutes),
    transferCost: fromCentsOrNull(row.transferCostCents),
    suppliesCost: fromCentsOrNull(row.suppliesCostCents),
  };
}

// ---- Brand rules: brands a supplier restricts (migrations/0075) ----------------------------------
// Some brands may only be resold on the supplier's terms, and the wording here is the supplier's, not any one vendor's:
// what suppliers publish is collected into ONE list, to be verified with whichever supplier the blanks come from.
// Seeded from (2026-10):
//   SanMar's published brand form: The North Face, Nike, Carhartt (jeans / accessories excepted), Cotopaxi, TravisMathew,
//     New Era, Eddie Bauer, Champion, OGIO, Tommy Bahama, Brooks Brothers, Outdoor Research, tentree "only with
//     embellishment"; MiiR and Stanley/Stella also restricted; "large orders need logo pre-approval".
//   S&S's published terms: adidas, Columbia, Oakley and Puma (Golf) "must be sold with embellishment"; DRI DUCK may be
//     resold blank only at its MAP.
// The default large quantity (100) and the logo concerns are a starting point; each shop sets its own.
// The rules are a setting (global_settings.brandRules, Tools → Brand rules): a default "large" quantity — pieces of
// ONE style (a blank) on one customer order or one supplier order — with per-brand overrides; per brand whether it
// must be decorated and whether a large quantity needs the supplier's logo approval. An approval (brand_approvals) is
// per product, since the logo on it is what's reviewed, with the supplier's reply attached.
// seedVersion: brands added to the seed later (`since`) are added to rules saved before them (getBrandRules).
export const BRAND_RULES_SEED_VERSION = 2;
export const DEFAULT_BRAND_RULES = {
  seedVersion: BRAND_RULES_SEED_VERSION,
  largeQty: 100,
  concerns: ["Guns / firearms", "Tobacco", "Alcohol", "Adult entertainment", "Obscene or violent content"],
  brands: [
    { brand: "The North Face" },
    { brand: "Carhartt", note: "Jeans and accessories may be sold undecorated — tick those categories." },
    ...["Nike", "Cotopaxi", "TravisMathew", "New Era", "Eddie Bauer", "Champion", "OGIO", "Tommy Bahama", "Brooks Brothers",
      "Outdoor Research", "tentree", "MiiR", "Stanley/Stella"].map(brand => ({ brand })),
    { brand: "adidas", since: 2, note: "May not be shipped outside the country." },
    { brand: "Columbia", since: 2, note: "No professional or college team marks." },
    { brand: "Oakley", since: 2 },
    { brand: "Puma", since: 2, note: "Puma Golf." },
    { brand: "DRI DUCK", since: 2, mustDecorate: false, largeNeedsApproval: false, note: "May be sold blank, but only at DRI DUCK's minimum advertised price (MAP)." },
  ].map(b => ({ largeQty: null, mustDecorate: true, largeNeedsApproval: true, exceptCategories: [], note: "", since: 1, ...b })),
};
// The first seed's notes, replaced by the general wording when rules saved before it are read. (OpenDecoDesk never
// shipped them: none to replace.)
const BRAND_NOTES_V1_ = {};
// "The North Face®" = "the north face" = "THE-NORTH-FACE".
export const brandKey_ = (s) => String(s == null ? "" : s).toLowerCase().replace(/[®™©]/g, "").replace(/[^a-z0-9]+/g, "");
export function cleanBrandRules_(input) {
  const r = input && typeof input === "object" ? input : {};
  const int = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
  const largeQty = int(r.largeQty, 1, 100000);
  if (largeQty == null) throw pricingError_("The default large quantity must be a whole number from 1 to 100,000.");
  const concerns = (Array.isArray(r.concerns) ? r.concerns : []).map(c => String(c || "").trim().slice(0, 80)).filter(Boolean).slice(0, 20);
  const brands = [], seen = new Set();
  for (const b of (Array.isArray(r.brands) ? r.brands : []).slice(0, 80)) {
    const brand = String((b && b.brand) || "").trim().slice(0, 60), k = brandKey_(brand);
    if (!k) continue;
    if (seen.has(k)) throw pricingError_(`“${brand}” is listed twice.`);
    seen.add(k);
    let q = null;
    if (b.largeQty !== null && b.largeQty !== undefined && b.largeQty !== "") { q = int(b.largeQty, 1, 100000); if (q == null) throw pricingError_(`${brand}: the large quantity must be a whole number from 1 to 100,000 (or blank for the default).`); }
    brands.push({ brand, largeQty: q, mustDecorate: b.mustDecorate !== false, largeNeedsApproval: b.largeNeedsApproval !== false,
      exceptCategories: (Array.isArray(b.exceptCategories) ? b.exceptCategories : []).map(c => String(c || "").trim().slice(0, 40)).filter(Boolean).slice(0, 20),
      note: String(b.note || "").trim().slice(0, 300) });
  }
  // The price rule: charge at least MAP + $X or + X% — a general one and per brand (Brand rules page). A guide, not a
  // hard rule like MAP itself: a price under it is a warning.
  const priceRule = cleanPriceRule_(r.priceRule, "The general price rule");
  const brandPrices = [], seenP = new Set();
  for (const b of (Array.isArray(r.brandPrices) ? r.brandPrices : []).slice(0, 200)) {
    const brand = String((b && b.brand) || "").trim().slice(0, 60), k = brandKey_(brand);
    if (!k) continue;
    if (seenP.has(k)) throw pricingError_(`“${brand}” has two price rules.`);
    seenP.add(k);
    const rule = cleanPriceRule_(b, brand);
    if (rule) brandPrices.push({ brand, ...rule });
  }
  return { seedVersion: BRAND_RULES_SEED_VERSION, largeQty, concerns, brands, priceRule, brandPrices };
}
// {add, unit: "amount" | "pct"} or null (blank = no rule).
function cleanPriceRule_(x, who) {
  if (!x || x.add === null || x.add === undefined || x.add === "") return null;
  const unit = x.unit === "pct" ? "pct" : "amount", add = Number(x.add);
  if (!Number.isFinite(add) || add < 0 || add > (unit === "pct" ? 1000 : 10000)) throw pricingError_(`${who}: the amount over MAP must be a number from 0 to ${unit === "pct" ? "1,000%" : "$10,000"}.`);
  return { add: Math.round(add * 100) / 100, unit };
}
// The price rule for a blank's brand: its own, else the general one, else null. {add, unit, brand ("" = general)}.
export function priceRuleFor_(rules, brand) {
  if (!rules) return null;
  const k = brandKey_(brand);
  const b = k ? (rules.brandPrices || []).find(x => brandKey_(x.brand) === k) : null;
  if (b) return { add: b.add, unit: b.unit, brand: b.brand };
  return rules.priceRule ? { add: rules.priceRule.add, unit: rules.priceRule.unit, brand: "" } : null;
}
// The least a price should be under the rule, in cents, for a MAP in cents.
export const priceRuleMinCents_ = (mapCents, rule) => rule.unit === "pct" ? Math.round(mapCents * (1 + rule.add / 100)) : mapCents + Math.round(rule.add * 100);
export const priceRuleText_ = (rule) => rule.unit === "pct" ? `MAP + ${rule.add}%` : `MAP + $${Number(rule.add).toFixed(2)}`;
const defaultBrandRules_ = () => cleanBrandRules_(DEFAULT_BRAND_RULES);
export async function getBrandRules(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='brandRules'").first().catch(() => null);
  const saved = row ? tryParse_(row.value, null) : null;
  if (!saved) return defaultBrandRules_();
  // Saved before a newer seed: add the brands seeded since (a brand removed by hand stays removed — it was in the
  // older seed), and replace the first seed's notes with the general wording.
  const from = Number(saved.seedVersion) || 1;
  if (from < BRAND_RULES_SEED_VERSION && Array.isArray(saved.brands)) {
    const have = new Set(saved.brands.map(b => brandKey_(b && b.brand)));
    for (const b of saved.brands) if (b && BRAND_NOTES_V1_[brandKey_(b.brand)] === b.note) b.note = DEFAULT_BRAND_RULES.brands.find(d => brandKey_(d.brand) === brandKey_(b.brand)).note;
    for (const d of DEFAULT_BRAND_RULES.brands) if (d.since > from && !have.has(brandKey_(d.brand))) saved.brands.push(d);
  }
  try { return cleanBrandRules_(saved); } catch (e) { return defaultBrandRules_(); }
}
export async function setBrandRules(db, input) {
  const clean = cleanBrandRules_(input);
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('brandRules', ?)").bind(JSON.stringify(clean)).run();
  return clean;
}
// The rule for a blank's brand (with `threshold` = its own large quantity or the default), or null.
export function brandRuleFor_(rules, brand) {
  const k = brandKey_(brand);
  if (!k || !rules) return null;
  const b = (rules.brands || []).find(x => brandKey_(x.brand) === k);
  return b ? { ...b, threshold: b.largeQty || rules.largeQty || 100, concerns: rules.concerns || [] } : null;
}
// Active approvals: "<orgId>|<productId>|<brandKey>" → the best one (no limit beats any limit, else the highest).
export async function activeBrandApprovals_(db) {
  const { results } = await db.prepare("SELECT * FROM brand_approvals WHERE revokedAt IS NULL").all().catch(() => ({ results: [] }));
  const out = new Map();
  for (const a of results) {
    const k = a.orgId + "|" + a.productId + "|" + brandKey_(a.brand), prev = out.get(k);
    const better = !prev || (prev.maxQty != null && (a.maxQty == null || Number(a.maxQty) > Number(prev.maxQty)));
    if (better) out.set(k, { id: Number(a.id), maxQty: a.maxQty == null ? null : Number(a.maxQty), approvedOn: a.approvedOn || "" });
  }
  return out;
}
export function brandApprovalCovers_(approvals, orgId, productId, brand, pieces) {
  const a = approvals && approvals.get(orgId + "|" + productId + "|" + brandKey_(brand));
  return !!a && (a.maxQty == null || Number(pieces) <= a.maxQty);
}
// What the checks need, read once: the rules, approvals, every blank link and the blanks' brand / style.
export async function brandContext_(db) {
  const [rules, approvals, links, blanks] = await Promise.all([
    getBrandRules(db), activeBrandApprovals_(db),
    db.prepare("SELECT orgId, productId, productColor, productSize, blankId FROM product_blank_links").all().then(r => r.results).catch(() => []),
    db.prepare("SELECT id, name, brand, sku FROM blanks").all().then(r => r.results).catch(() => []),
  ]);
  const linkAt = new Map(links.map(l => [[l.orgId, l.productId, l.productColor || "", l.productSize || ""].join("\u0001"), Number(l.blankId)]));
  const blankAt = new Map(blanks.map(b => [Number(b.id), b]));
  return { rules, approvals, linkAt, blankAt };
}
// For each order: the ruled-brand styles (blanks) it has a LARGE number of — [{brand, style, blank, blankId, pieces,
// threshold, approved, products: [productId]}] — from its active lines (qty), matched to blanks the same way
// Blanks to Order matches them (shop + product + garment color + size). Approved = every product it's on has an
// approval for the brand that covers the pieces. `lines` = raw order_items rows (orderId, orgId, productId, size,
// configJson, qty, cancelDate).
export function brandReviewsForLines_(ctx, lines) {
  const byOrder = new Map();
  for (const ln of lines || []) {
    if (ln.cancelDate || !ln.productId) continue;
    const blankId = ctx.linkAt.get([ln.orgId, ln.productId, itemColor_(ln), ln.size || ""].join("\u0001"));
    const b = blankId ? ctx.blankAt.get(blankId) : null;
    const rule = b ? brandRuleFor_(ctx.rules, b.brand) : null;
    if (!rule || !rule.largeNeedsApproval) continue;
    const m = byOrder.get(ln.orderId) || byOrder.set(ln.orderId, new Map()).get(ln.orderId);
    const e = m.get(blankId) || m.set(blankId, { brand: rule.brand, style: b.sku || b.name || "", blank: b.name || "", blankId, pieces: 0, threshold: rule.threshold, orgId: ln.orgId, products: new Set() }).get(blankId);
    e.pieces += Number(ln.qty) || 0;
    e.products.add(ln.productId);
  }
  const out = new Map();
  for (const [orderId, m] of byOrder) {
    const list = [];
    for (const e of m.values()) {
      if (e.pieces < e.threshold) continue;
      const products = [...e.products];
      list.push({ brand: e.brand, style: e.style, blank: e.blank, blankId: e.blankId, pieces: e.pieces, threshold: e.threshold, products,
        approved: products.every(pid => brandApprovalCovers_(ctx.approvals, e.orgId, pid, e.brand, e.pieces)) });
    }
    if (list.length) out.set(orderId, list);
  }
  return out;
}

// ---- Brand approvals (migrations/0075) ----
const parseBrandApproval_ = (r) => ({ id: Number(r.id), orgId: r.orgId, productId: r.productId, brand: r.brand, approvedOn: r.approvedOn || "",
  maxQty: r.maxQty == null ? null : Number(r.maxQty), note: r.note || "", fileKey: r.fileKey || "", fileName: r.fileName || "",
  createdBy: r.createdBy || "", createdAt: r.createdAt, revokedAt: r.revokedAt || "", revokeNote: r.revokeNote || "" });
export async function listBrandApprovals(db, { orgId = null, productId = null } = {}) {
  const where = [], b = [];
  if (orgId) { where.push("orgId=?"); b.push(orgId); }
  if (productId) { where.push("productId=?"); b.push(productId); }
  const { results } = await db.prepare(`SELECT * FROM brand_approvals${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY createdAt DESC, id DESC`).bind(...b).all();
  return results.map(parseBrandApproval_);
}
// One approval, for one or more products of a shop (same file). Returns the new rows' ids.
export async function addBrandApproval(db, { orgId, productIds, brand, approvedOn, maxQty = null, note = "", fileKey, fileName = "", createdBy = "" }) {
  const now = new Date().toISOString();
  const ids = [];
  for (const pid of [...new Set(productIds || [])]) {
    const r = await db.prepare(`INSERT INTO brand_approvals (orgId, productId, brand, approvedOn, maxQty, note, fileKey, fileName, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(orgId, pid, String(brand).slice(0, 60), approvedOn, maxQty == null ? null : Number(maxQty), String(note || "").slice(0, 500), fileKey, String(fileName || "").slice(0, 200), String(createdBy || "").slice(0, 200), now).run();
    ids.push(Number(r.meta.last_row_id));
  }
  return ids;
}
export async function revokeBrandApproval(db, id, note) {
  const r = await db.prepare("UPDATE brand_approvals SET revokedAt=?, revokeNote=? WHERE id=? AND revokedAt IS NULL").bind(new Date().toISOString(), String(note || "").slice(0, 300), Number(id)).run();
  return !!(r.meta && r.meta.changes);
}
export async function getBrandApproval(db, id) {
  const r = await db.prepare("SELECT * FROM brand_approvals WHERE id=?").bind(Number(id)).first();
  return r ? parseBrandApproval_(r) : null;
}

// ---- Catalog health check ---------------------------------------------------------------------
// What's missing in the catalog that will bite later — for the ⚠ markers on Manage catalog (next to
// each shop's Products / Designs buttons), on each product and each design. Each issue is
// {code, text, level}: "error" = Run Order / ordering can't work right; "warn" = worth fixing
// (e.g. sizes not linked to a blank, so stock and COGS aren't tracked). Products are checked when
// visible, or hidden but still on an open order. Returns
// {orgs: {orgId: {products: {productId: [issues]}, designs: {designId: [issues]}, productCount,
//  designCount}}, globalDesigns: {designId: [issues]}} — only things WITH issues are listed.
export async function getCatalogIssues(db, orgId = null) {
  const q = async (sql, ...b) => { try { return (await db.prepare(sql).bind(...b).all()).results; } catch (e) { if (/no such (table|column)/i.test(String(e && e.message))) return []; throw e; } };
  const orgFilter = orgId ? " WHERE orgId = ?" : "";
  const ob = orgId ? [orgId] : [];
  // Features that are off aren't nagged about: no design / hoop / stitch-file issues without
  // Production, no "no weight" without Shipping.
  const features = await getFeatures(db);
  const orgs = await q("SELECT orgId, shippingEnabled FROM orgs" + orgFilter, ...ob);
  const products = await q("SELECT * FROM products" + orgFilter, ...ob);
  const designs = await q("SELECT d.*, (SELECT id FROM design_versions v WHERE v.designId = d.id AND v.machineFileKey <> '' ORDER BY uploadedAt DESC, id DESC LIMIT 1) AS stitchVersionId FROM designs d" +
    (orgId ? " WHERE d.orgId = ? OR d.isGlobal = 1" : ""), ...ob);
  const versions = await q(`SELECT v.designId, v.threadColorsJson FROM design_versions v
    WHERE v.id = (SELECT id FROM design_versions w WHERE w.designId = v.designId ORDER BY uploadedAt DESC, id DESC LIMIT 1)`);
  const hoops = await q("SELECT designId, count(*) n FROM design_hoops GROUP BY designId");
  const pds = await q("SELECT orgId, productId, designId FROM product_designs" + orgFilter, ...ob);
  const links = await q("SELECT orgId, productId, productSize FROM product_blank_links" + orgFilter, ...ob);
  // Linked blanks filed under another type than the product (a blank re-typed after it was linked — the product form
  // used to hide it then, so a newly offered color couldn't be linked).
  const linkedTypes = await q("SELECT DISTINCT l.orgId, l.productId, b.name AS blankName, b.productType, b.brand FROM product_blank_links l JOIN blanks b ON b.id = l.blankId" + (orgId ? " WHERE l.orgId = ?" : ""), ...ob);
  // Brand rules (migrations/0075): restricted brands on a product — decorated only, and the supplier's logo approval.
  const brandRules = await getBrandRules(db).catch(() => null);
  const brandApprovals = await activeBrandApprovals_(db);
  // Every graphic: a product may use another shop's global one (migrations/0078); graphicUsableBy_ decides.
  const graphicRows = await q("SELECT * FROM graphics");   // printed transfers (0067)
  const graphicById = {}; for (const g of graphicRows) graphicById[Number(g.id)] = g;
  const open = await q(`SELECT oi.orgId, oi.productId, count(*) n FROM order_items oi JOIN orders o ON o.orderId = oi.orderId
    WHERE oi.cancelDate IS NULL AND o.manufacturedAt IS NULL AND o.completedAt IS NULL AND o.voidedAt IS NULL AND o.isTest = 0
    GROUP BY oi.orgId, oi.productId`);
  // Blanks whose vendor price changed since the product's prices were set (migrations/0062).
  const priceChanged = {};
  for (const c of await getProductPriceChanges(db, { orgId }).catch(() => [])) priceChanged[c.orgId + "|" + c.productId] = c.changes;
  // Items below the pricing targets (Global settings → Pricing, migrations/0067) — re-checked on every read, so a
  // change to a blank's cost, a fee, the tax rate or a target shows up here at once.
  const belowTarget = {}, belowMap = {}, belowRule = {};
  for (const a of (await analyzePricing(db, { orgId }).catch(() => ({ products: [] }))).products) {
    if (a.belowTarget) belowTarget[a.orgId + "|" + a.productId] = a.problems;
    if (a.belowMap) belowMap[a.orgId + "|" + a.productId] = a.mapProblems;   // below a blank's MAP (migrations/0070)
    if (a.belowPriceRule) belowRule[a.orgId + "|" + a.productId] = a.ruleProblems;   // under the Brand rules price rule
  }
  const hoopCount = {}; for (const h of hoops) hoopCount[h.designId] = Number(h.n);
  const latest = {}; for (const v of versions) latest[v.designId] = tryParse_(v.threadColorsJson, []) || [];
  // Designs.
  const designIssues = {}, designById = {};
  for (const d of designs) {
    designById[d.id] = d;
    const list = [];
    if (!d.stitchVersionId) list.push({ code: "noStitchFile", level: "error", text: "No stitch (machine) file uploaded" });
    if (!hoopCount[d.id] && d.hoopId == null) list.push({ code: "noHoops", level: "error", text: "No hoops picked" });
    if (d.stitchVersionId && !(latest[d.id] || []).length) list.push({ code: "noThreads", level: "warn", text: "Current version has no thread colors" });
    if (list.length && features.production) designIssues[d.id] = list;
  }
  const out = { orgs: {}, globalDesigns: {} };
  const orgOf = (id) => (out.orgs[id] = out.orgs[id] || { products: {}, designs: {}, productCount: 0, designCount: 0 });
  for (const o of orgs) orgOf(o.orgId);
  for (const d of designs) {
    if (!designIssues[d.id]) continue;
    if (Number(d.isGlobal)) out.globalDesigns[d.id] = designIssues[d.id];
    if (!orgId || d.orgId === orgId) { orgOf(d.orgId).designs[d.id] = designIssues[d.id]; }
  }
  // Products.
  const shipping = {}; for (const o of orgs) shipping[o.orgId] = !!Number(o.shippingEnabled);
  const blankWeights = await getBlankWeights(db, null);
  const pdBy = {}; for (const r of pds) (pdBy[r.orgId + "|" + r.productId] = pdBy[r.orgId + "|" + r.productId] || []).push(Number(r.designId));
  const linked = {}; for (const r of links) linked[r.orgId + "|" + r.productId + "|" + r.productSize] = true;
  const openBy = {}; for (const r of open) openBy[r.orgId + "|" + r.productId] = Number(r.n);
  const designName = (id) => (designById[id] && designById[id].name) || ("#" + id);
  for (const p of products) {
    const key = p.orgId + "|" + p.productId;
    // A hidden product is checked too (a copy or an import usually starts hidden), but its problems are only
    // warnings until it's shown — unless it's on an open order.
    const hiddenOnly = !Number(p.visible) && !openBy[key];
    const list = [];
    const used = pdBy[key] || (p.designId != null ? [Number(p.designId)] : []);
    // A product the customer supplies the design for (migrations/0054) is made from their upload.
    // A configurable product whose designs are the options offered at its spots (graphics) needs no design of its own.
    const offersOptions = Number(p.configurable) && (tryParse_(p.locationsJson, []) || []).some(l => l && Array.isArray(l.graphicIds) && l.graphicIds.length);
    if (features.production && !used.length && !Number(p.noDesignNeeded) && !p.customDesign && !offersOptions)
      list.push({ code: "noDesign", level: "warn", text: "No stitch file (design) linked yet — needed to make it on Run Order, not to sell it (tick “No embroidery design needed” if it's DTF)" });
    // An embroidery graphic offered as an option with no stitch file linked: fine to sell, but it can't be made until linked.
    // (Only with the Production feature on, like noDesign.)
    if (features.production && Number(p.configurable)) {
      const bare = [...new Set((tryParse_(p.locationsJson, []) || []).flatMap(l => (l && l.graphicIds) || []).map(Number))]
        .map(id => graphicById[id]).filter(g => g && g.kind === "embroidery" && !g.designId);
      if (bare.length) list.push({ code: "graphicNoDesign", level: "warn", text: `No stitch file (design) linked to ${bare.map(g => `“${g.name}”`).join(", ")} yet — link one on the Graphics screen before orders for it can be made` });
    }
    const options = tryParse_(p.personalizationOptions, []) || [];
    const map = tryParse_(p.personalizationOptionDesigns, {}) || {};
    const unmapped = options.filter(o => !Number(map[o]) || !designById[Number(map[o])]);
    if (features.production && unmapped.length) list.push({ code: "pickUnmapped", level: "error", text: "Pick-list option" + (unmapped.length === 1 ? "" : "s") + " with no design: " + unmapped.join(", ") });
    const designIdsUsed = new Set(used.concat(options.map(o => Number(map[o])).filter(Boolean)));
    for (const id of designIdsUsed) if (designIssues[id]) list.push({ code: "designIssue", level: "error", text: `Design “${designName(id)}”: ${designIssues[id].map(x => x.text.toLowerCase()).join("; ")}` });
    if (features.production && !options.length && p.personalizationPriceCents != null && p.personalizationMode === "separate" && p.personalizationHoopId == null)
      list.push({ code: "persHoop", level: "error", text: "Typed-in personalization is its own hooping but has no hoop" });
    const sizes = p.pricingMode === "flat" ? ["OSFA"] : Object.keys(tryParse_(p.sizePricingCents, {}) || {});
    if (p.pricingMode === "flat" ? p.flatPriceCents == null : !sizes.length) list.push({ code: "noPrice", level: "error", text: "No price set" });
    if (features.shipping && shipping[p.orgId] && p.weightOz == null && !blankWeights[key]) list.push({ code: "noWeight", level: "error", text: "No weight — the shop ships, so shipping can't be quoted. Enter the weight on its blank (Inventory → Blanks → Edit), or on the product" });
    const noBlank = sizes.filter(sz => !linked[key + "|" + sz]);
    // Blank links matter whether or not the product is embroidered — a DTF tee is still a blank whose
    // stock and cost of goods should be tracked — so "No embroidery design needed" doesn't skip this.
    // …but a product made with no blank at all (migrations/0057) has nothing to link.
    if (noBlank.length && sizes.length && !Number(p.noBlankNeeded))
      list.push({ code: "noBlankLink", level: "warn", text: (noBlank.length === sizes.length ? "Not linked to a blank" : "Sizes not linked to a blank: " + noBlank.join(", ")) + " — stock and cost of goods aren't tracked (tick “No blank needed” if it's made without one)" });
    if (priceChanged[key]) {
      const money = (v) => v == null ? "not entered" : "$" + Number(v).toFixed(2);
      const groupOf = (color) => { const g = (tryParse_(p.colorGroupsJson, []) || []).find(x => (x.colors || []).includes(color)); return g ? g.label : (tryParse_(p.colorGroupsJson, []) || []).length ? "Standard" : ""; };
      const parts = priceChanged[key].map(c => `${c.blankName}${c.color ? " " + c.color : ""}${c.size ? " " + c.size : ""} ${money(c.from)} → ${money(c.to)}${c.productColor && groupOf(c.productColor) ? ` (${groupOf(c.productColor)} price)` : ""}`);
      list.push({ code: "blankPriceChanged", level: "warn", changes: priceChanged[key],
        text: "Blank vendor price changed since this product's prices were set: " + parts.slice(0, 6).join("; ") + (parts.length > 6 ? `; +${parts.length - 6} more` : "") +
          " — update its prices, or confirm they're still right (“Prices still OK” on the product)" });
    }
    // Printed transfers (migrations/0068): each needs a transfer graphic of this shop, linked to transfer stock.
    for (const f of tryParse_(p.fixedTransfersJson, []) || []) {
      const g = graphicById[Number(f.graphicId)];
      if (!graphicUsableBy_(g, p.orgId) || g.kind !== "transfer")
        list.push({ code: "fixedTransferMissing", level: "error", text: "A printed transfer's graphic is gone or isn't a transfer any more — orders won't carry it; pick another on the product" });
      else if (g.transferId == null)
        list.push({ code: "fixedTransferUnlinked", level: "warn", text: `Printed transfer “${g.name}” isn't linked to a transfer on the Graphics screen — its stock and cost aren't tracked` });
    }
    for (const f of tryParse_(p.mockupGraphicsJson, []) || []) {   // migrations/0069
      const g = graphicById[Number(f.graphicId)];
      if (!graphicUsableBy_(g, p.orgId)) list.push({ code: "mockupGraphicMissing", level: "warn", text: "An embroidered graphic for its mockups is gone — pick another on the product" });
    }
    const typeOff = linkedTypes.filter(t => t.orgId === p.orgId && t.productId === p.productId && t.productType && p.type && t.productType !== p.type);
    if (typeOff.length) list.push({ code: "blankTypeMismatch", level: "warn", text: `Linked to ${typeOff.map(t => `“${t.blankName}” (filed as ${t.productType})`).join(", ")}, but this product is a ${p.type} — change one of them so they match` });
    // A restricted brand (Tools → Brand rules): what the supplier requires, and whether the logo is approved.
    const ruled = new Map();
    for (const t of linkedTypes) if (t.orgId === p.orgId && t.productId === p.productId) { const r = brandRuleFor_(brandRules, t.brand); if (r) ruled.set(brandKey_(r.brand), r); }
    for (const r of ruled.values()) {
      const appr = brandApprovals.get(p.orgId + "|" + p.productId + "|" + brandKey_(r.brand));
      const approval = !r.largeNeedsApproval ? "" : appr ? `supplier logo approval on file (${appr.approvedOn}${appr.maxQty != null ? `, up to ${appr.maxQty}` : ""})` : `orders of ${r.threshold}+ of one style need the supplier's logo approval — none on file`;
      list.push({ code: "brandRule", level: "warn", brand: r.brand, approved: !!appr, needsApproval: r.largeNeedsApproval,
        text: `${r.brand} (a restricted brand — verify with the supplier): ${[r.mustDecorate ? "must be decorated" : "", approval].filter(Boolean).join(" · ")}${r.concerns.length && r.mustDecorate ? ` · avoid logos with: ${r.concerns.join(", ").toLowerCase()}` : ""}${r.note ? ` · ${r.note}` : ""}` });
      const decorated = used.length || options.length || p.personalizationPriceCents != null || !!p.customDesign
        || (tryParse_(p.fixedTransfersJson, []) || []).length || (Number(p.configurable) && (tryParse_(p.locationsJson, []) || []).length);
      if (r.mustDecorate && !decorated && !(r.exceptCategories || []).includes(p.type))
        list.push({ code: "brandUndecorated", level: "error", brand: r.brand, text: `${r.brand} can only be sold decorated, and nothing decorates this product (no design, printed transfer, graphic options or personalization)` });
    }
    if (belowMap[key]) list.push({ code: "belowMap", level: "error", text: belowMap[key].join("; ") + " — the vendor's minimum advertised price; raise the price (the product can't be saved below it)" });
    if (belowRule[key]) list.push({ code: "belowPriceRule", level: "warn", text: belowRule[key].join("; ") + " — your price rule (Catalog → Brand rules)" });
    if (belowTarget[key]) list.push({ code: "belowTarget", level: "warn", text: belowTarget[key].join("; ") + " — see the Pricing panel on the product (or Price analysis)" });
    // Versions (migrations/0059) share one card on the shop page, which sits in ONE category section.
    if (p.versionGroup) {
      const others = products.filter(x => x.orgId === p.orgId && x.versionGroup === p.versionGroup && x.productId !== p.productId);
      const split = others.filter(x => x.type !== p.type);
      if (split.length) list.push({ code: "versionSplit", level: "warn", text: `Its other version${split.length === 1 ? "" : "s"} (${split.map(x => x.versionLabel || x.productId).join(", ")}) ${split.length === 1 ? "is" : "are"} in a different category, so the shop page can't show them on one card` });
    }
    if (!Number(p.visible)) list.forEach(x => { x.text += hiddenOnly ? " (hidden — fix before showing it)" : " (hidden, but on an open order)"; if (hiddenOnly && x.level === "error") { x.level = "warn"; x.wasError = true; } });
    if (list.length) orgOf(p.orgId).products[p.productId] = list;
  }
  // The shop as a whole: what would make its page look unfinished (no visible products).
  for (const o of orgs) {
    const mine = products.filter(p => p.orgId === o.orgId), shown = mine.filter(p => Number(p.visible));
    const shop = [];
    if (!shown.length) shop.push({ code: "noVisibleProducts", level: "warn", text: mine.length ? "No product is visible — the shop page is empty (tick Visible on the products to show)" : "No products yet" });
    // Products with no picture of their own aren't flagged: most shops show the blank's photos (and name each
    // decoration underneath), so that's normal, not unfinished.
    orgOf(o.orgId).shop = shop;
  }
  for (const o of Object.values(out.orgs)) { o.productCount = Object.keys(o.products).length; o.designCount = Object.keys(o.designs).length; }
  return out;
}

// ---- A product's designs (migrations/0032) --------------------------------------------------
// product_designs lists a product's designs in run order — each its own hooping (e.g. a cap's
// front logo, then a back design). One is MAIN: the design a typed-in name is combined with.
// products.designId mirrors the main design for older readers (and the digitizing rule).
const parseProductDesign_ = (r) => ({ id: Number(r.id), designId: Number(r.designId), placement: r.placement || "",
  isMain: !!r.isMain, sortOrder: Number(r.sortOrder) || 0 });

export async function listProductDesigns(db, orgId, productId) {
  const { results } = await db.prepare(
    "SELECT * FROM product_designs WHERE orgId=? AND productId=? ORDER BY sortOrder, id").bind(orgId, productId).all();
  return results.map(parseProductDesign_);
}

// Replaces the product's design list. list = [{designId, placement, isMain}] in run order; every
// design must belong to the org. Exactly one is main (the first, if none is marked).
export async function setProductDesigns(db, orgId, productId, list) {
  const rows = (Array.isArray(list) ? list : []).filter(x => x && Number(x.designId))
    .map((x, i) => ({ designId: Number(x.designId), placement: String(x.placement || "").trim().slice(0, 60), isMain: !!x.isMain, sortOrder: i }));
  for (const r of rows) {
    const d = await db.prepare("SELECT * FROM designs WHERE id=?").bind(r.designId).first();
    if (!d || (d.orgId !== orgId && !Number(d.isGlobal))) throw new Error("Design " + r.designId + " doesn't belong to this shop");
  }
  if (rows.length && rows.filter(r => r.isMain).length !== 1) { rows.forEach(r => { r.isMain = false; }); rows[0].isMain = true; }
  const main = rows.find(r => r.isMain);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("DELETE FROM product_designs WHERE orgId=? AND productId=?").bind(orgId, productId),
    ...rows.map(r => db.prepare(
      "INSERT INTO product_designs (orgId, productId, designId, placement, isMain, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(orgId, productId, r.designId, r.placement, r.isMain ? 1 : 0, r.sortOrder, now)),
    db.prepare("UPDATE products SET designId=?, updatedAt=? WHERE orgId=? AND productId=?").bind(main ? main.designId : null, now, orgId, productId),
  ]);
}

// The old one-design call (migrations/0024): the product's designs become just this one, as main.
export async function setProductDesign(db, orgId, productId, designId) {
  await setProductDesigns(db, orgId, productId, designId == null || designId === "" ? [] : [{ designId, placement: "Main", isMain: true }]);
}

// How a product's personalization is stitched (migrations/0032): mode 'combined' (a typed-in name
// goes in the same hooping as the main design, on the design's personalization hoops) or
// 'separate' (its own hooping on hoopId); optionDesigns maps each pick-list option to a design.
export async function setProductPersonalization(db, orgId, productId, { mode, hoopId, optionDesigns } = {}) {
  const map = {};
  for (const [k, v] of Object.entries(optionDesigns || {})) if (Number(v)) map[String(k)] = Number(v);
  await db.prepare(`UPDATE products SET personalizationMode=?, personalizationHoopId=?, personalizationOptionDesigns=?, updatedAt=?
    WHERE orgId=? AND productId=?`)
    .bind(mode === "separate" ? "separate" : "combined", hoopId ? Number(hoopId) : null, JSON.stringify(map),
      new Date().toISOString(), orgId, productId).run();
}

// Server-side pricing — never trust client-supplied prices.
// Returns {unitPrice, personalizationFee, name, type} or throws if the product
// isn't found. name/type come from the catalog so order records can't carry
// customer-chosen text in place of the real product.
// The customer's own design (migrations/0054): opts.custom maps a location key ("customdesign" on an
// ordinary product) → the upload {uploadId, fileKey, fileName, fileExt}, or null to keep the entry
// without a file. The caller looks the uploads up; this only prices them and writes them into the
// line's copy. `needsCustomUpload` comes back true when the line needs an upload it doesn't have —
// only the storefront refuses that (a local sale or an Edit items change goes through, and the
// admin attaches the file with Files).
export async function priceItem(db, orgId, productId, size, qty, personalized, config, opts = {}) {
  // The PUBLISHED product (migrations/0076) — what the shopper saw — every column, so this keeps working on a
  // database a migration behind the code. A shop never published since then is priced live, as before.
  const row = await publishedProductRow_(db, orgId, productId);

  if (!row || !row.visible) throw pricingError_(`Product not available: ${productId}`);

  // The size is the customer's word, and it is stored on the line: text, and no longer than a size is.
  if (size != null && (typeof size !== "string" || size.length > 40)) throw pricingError_("That size isn't available.");

  let unitPriceCents;
  if (row.pricingMode === "flat") {
    unitPriceCents = Number(row.flatPriceCents) || 0;
  } else {
    // A size is one this product LISTS — its own entry in the price table, never something every
    // object answers to ("toString", "constructor"), which would read as a price of nothing — and
    // the price listed for it is a real amount, not a blank that would count as $0.
    const sp = tryParse_(row.sizePricingCents, {});
    const listed = sp && typeof sp === "object" && !Array.isArray(sp) && typeof size === "string" && Object.prototype.hasOwnProperty.call(sp, size);
    const cents = listed && (typeof sp[size] === "number" || (typeof sp[size] === "string" && sp[size].trim() !== "")) ? Number(sp[size]) : NaN;
    if (!Number.isFinite(cents) || cents < 0) throw pricingError_(`Size ${String(size).slice(0, 40)} not available for ${productId}`);
    unitPriceCents = cents;
  }
  // Color price groups (migrations/0064): a configurable line's garment color may be in a group with its own
  // price for this size. A color in no group keeps the product's own price (Standard).
  if (row.configurable && Number(row.configurable)) {
    const group = colorGroupBaseCents_(row, String((config || {}).garmentColor || (config || {}).color || ""), size);
    if (group != null) unitPriceCents = group;
  }

  // Configurable products (migrations/0036): base price + Σ tier add-ons for the chosen per-location
  // options. Validates each option server-side and returns a snapshot to store on the line.
  const custom = opts && opts.custom && typeof opts.custom === "object" ? opts.custom : {};
  if (row.configurable && Number(row.configurable)) {
    const built = await priceConfigurable_(db, orgId, row, size, config, custom);
    const cfgPersCents = personalized && row.personalizationPriceCents != null ? Number(row.personalizationPriceCents) : 0;
    return { unitPrice: fromCents(unitPriceCents + built.addOnCents), personalizationFee: fromCents(cfgPersCents),
      name: productLineName(row, productId), type: row.type || "", config: built.snapshot,
      ...(built.needsCustomUpload ? { needsCustomUpload: true } : {}) };
  }

  const personalizationFeeCents = personalized && row.personalizationPriceCents != null
    ? Number(row.personalizationPriceCents)
    : 0;

  // The customer's own design on an ordinary product: one image for the line, in place of the
  // product's own design (or as its only design). Its add-on is part of the unit price.
  const hasCustom = Object.prototype.hasOwnProperty.call(custom, CUSTOM_PLAIN_LOCATION);
  const customEntry = hasCustom ? customDesignEntry_(row, CUSTOM_PLAIN_LOCATION, "Design", custom[CUSTOM_PLAIN_LOCATION]) : null;
  if (customEntry) unitPriceCents += customEntry.addOnCents;
  let needsCustomUpload = false;
  if (!hasCustom && row.customDesign) {
    let designCount = 0;
    try { designCount = Number((await db.prepare("SELECT count(*) AS n FROM product_designs WHERE orgId=? AND productId=?").bind(orgId, productId).first()).n) || 0; }
    catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
    needsCustomUpload = customDesignRequired({ ...row, designCount });
  }

  const out = {
    unitPrice: fromCents(unitPriceCents), personalizationFee: fromCents(personalizationFeeCents),
    name: productLineName(row, productId), type: row.type || "",
    ...(needsCustomUpload ? { needsCustomUpload: true } : {}),
  };
  // A plain product can carry a reorder QR code too (migrations/0048): the line's snapshot then holds
  // just that automatic transfer. `plain: true` says "not a configurable line — nothing here was
  // picked", so screens that edit a configurable line's choices leave it alone.
  const qr = await reorderQrEntry_(db, orgId, row.reorderQr);
  const locs = [customEntry, ...(await fixedTransferEntries_(db, orgId, row)), qr].filter(Boolean);
  if (locs.length) out.config = { garmentColor: "", size: size || "", locations: locs, plain: true };
  return out;
}

// The product's printed transfers (migrations/0068) as order-line snapshot entries: one per location, kind
// 'transfer', `fixed: true`, no add-on — they're part of the product and its price, like the reorder QR, so
// Run Transfer Sheets, transfer stock and COGS treat them like any other transfer. A graphic that's gone, or
// isn't a transfer any more, is left out (the catalog check says so). Hidden graphics still apply: hiding one
// only stops customers picking it.
async function fixedTransferEntries_(db, orgId, row) {
  const list = tryParse_(row && row.fixedTransfersJson, []) || [];
  if (!list.length) return [];
  const names = {};
  try { for (const l of await listLocations(db)) names[Number(l.id)] = l.name; } catch (e) {}
  const out = [];
  for (const f of list) {
    const g = Number(f.graphicId) ? await getGraphic(db, Number(f.graphicId)) : null;
    if (!graphicUsableBy_(g, orgId) || g.kind !== "transfer") continue;
    const label = names[Number(f.locationId)] || "Printed transfer";
    const ink = g.inkColors.includes(String(f.ink || "")) ? String(f.ink) : (g.inkColors[0] || "");
    out.push({ location: "fixed" + (Number(f.locationId) || out.length), label, graphicId: g.id, kind: "transfer",
      designId: null, transferId: g.transferId, graphicName: g.name, ink, tier: null, addOnCents: 0,
      imageUrl: g.imageUrl, thumbUrl: g.thumbUrl, fixed: true });
  }
  return out;
}

// ---- Color price groups (migrations/0064) ----------------------------------------------------------
// The base price (cents) a garment color's group gives this size, or null when the color is in no group (or
// the group doesn't price that size) — then the product's own price applies.
export function colorGroupBaseCents_(row, color, size) {
  if (!color) return null;
  const groups = tryParse_(row.colorGroupsJson, []) || [];
  const g = groups.find(x => Array.isArray(x.colors) && x.colors.includes(color));
  if (!g) return null;
  if (row.pricingMode === "flat") return g.flatPriceCents == null ? null : Number(g.flatPriceCents);
  const v = (g.sizePricingCents || {})[size];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

// Checks color groups sent with a product (dollars) against its pricing mode, sizes and garment colors.
// Returns {groups} in cents (what's stored) or {error}. Each color sits in at most one group, every group
// names at least one of the product's colors and prices every size the product prices (or the flat price).
export function cleanColorGroups_(groups, product) {
  if (!Array.isArray(groups)) return { error: "Color price groups must be a list." };
  if (groups.length > 10) return { error: "Up to 10 color price groups." };
  const colors = Array.isArray(product.garmentColors) ? product.garmentColors.map(String) : [];
  const flat = product.pricingMode === "flat";
  const sizes = flat ? [] : Object.keys(product.sizePricing || {}).filter(z => product.sizePricing[z] !== "" && product.sizePricing[z] != null);
  const used = new Set(), out = [], labels = new Set();
  for (const [i, g] of groups.entries()) {
    const label = String(g && g.label || "").trim().slice(0, 40);
    if (!label) return { error: `Color price group ${i + 1} needs a name.` };
    if (labels.has(label.toLowerCase())) return { error: `Two color price groups are called “${label}”.` };
    labels.add(label.toLowerCase());
    const gColors = [...new Set((Array.isArray(g.colors) ? g.colors : []).map(c => String(c)))];
    if (!gColors.length) return { error: `“${label}” has no colors.` };
    for (const c of gColors) {
      if (colors.length && !colors.includes(c)) return { error: `“${label}”: ${c} isn't one of this product's colors.` };
      if (used.has(c)) return { error: `${c} is in two color price groups.` };
      used.add(c);
    }
    const money = (v) => { if (v === "" || v == null) return null; const n = Number(v); return Number.isFinite(n) && n >= 0 && n < 100000 ? Math.round(n * 100) : NaN; };
    const entry = { key: String(g.key || label.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 40), label, colors: gColors };
    if (flat) {
      const v = money(g.flatPrice);
      if (v == null || Number.isNaN(v)) return { error: `“${label}” needs a price.` };
      entry.flatPriceCents = v;
    } else {
      entry.sizePricingCents = {};
      for (const z of sizes) {
        const v = money((g.sizePricing || {})[z]);
        if (v == null || Number.isNaN(v)) return { error: `“${label}” needs a price for ${z}.` };
        entry.sizePricingCents[z] = v;
      }
    }
    out.push(entry);
  }
  return { groups: out };
}

async function setProductColorGroups_(db, orgId, productId, groupsCents) {
  await db.prepare("UPDATE products SET colorGroupsJson=? WHERE orgId=? AND productId=?").bind(JSON.stringify(groupsCents || []), orgId, productId).run()
    .catch((e) => { if (!/no such column/i.test(String(e && e.message))) throw e; });
}

// Suggested groups from the blank prices behind each color: colors whose linked blank sizes have the same
// vendor prices (else average cost) form a group. The group most colors share is Standard (the product's
// own prices); each other group's suggested price keeps Standard's margin — Standard's price plus the
// difference in blank cost, per size. Returns {standard: {colors, costs}, groups: [{label, colors, costs,
// sizePricing | flatPrice}], unpriced: [colors with no blank price]} (dollars).
export async function suggestColorGroups(db, orgId, productId) {
  const row = await db.prepare("SELECT * FROM products WHERE orgId=? AND productId=?").bind(orgId, productId).first();
  if (!row) return null;
  const p = parseProduct_(row);
  const flat = p.pricingMode === "flat";
  const sizes = flat ? ["OSFA"] : Object.keys(p.sizePricing || {});
  const { results } = await db.prepare(`SELECT l.productColor, l.productSize, bs.vendorPriceCents, bs.purchasePriceCents, bs.mapPriceCents
    FROM product_blank_links l LEFT JOIN blank_sizes bs ON bs.blankId = l.blankId AND bs.color = l.blankColor AND bs.size = l.blankSize
    WHERE l.orgId=? AND l.productId=?`).bind(orgId, productId).all();
  const costOf = {}, mapOf = {};
  for (const r of results) {
    if (r.mapPriceCents != null) (mapOf[r.productColor || ""] = mapOf[r.productColor || ""] || {})[r.productSize || "OSFA"] = Number(r.mapPriceCents);
    const c = r.vendorPriceCents != null ? Number(r.vendorPriceCents) : (Number(r.purchasePriceCents) || null);
    if (c != null) (costOf[r.productColor || ""] = costOf[r.productColor || ""] || {})[r.productSize || "OSFA"] = c;
  }
  const colors = p.garmentColors.length ? p.garmentColors : [""];
  const sig = (c) => sizes.map(z => (costOf[c] || {})[z] ?? "-").join(",");
  const bySig = new Map(), unpriced = [];
  for (const c of colors) {
    if (!costOf[c]) { unpriced.push(c); continue; }
    const k = sig(c);
    (bySig.get(k) || bySig.set(k, []).get(k)).push(c);
  }
  const ranked = [...bySig.entries()].sort((a, b) => b[1].length - a[1].length);
  if (!ranked.length) return { standard: { colors: [], costs: {} }, groups: [], unpriced };
  const costs = (c) => Object.fromEntries(sizes.map(z => [z, (costOf[c] || {})[z] != null ? fromCents(costOf[c][z]) : null]));
  const std = ranked[0][1], stdCost = costOf[std[0]];
  const stdPrice = (z) => flat ? toCents(p.flatPrice) : toCents((p.sizePricing || {})[z]);
  const groups = ranked.slice(1).map(([, cs], i) => {
    const cost = costOf[cs[0]];
    // Never below the group's MAP (migrations/0070): the highest MAP of its colors for that size.
    const groupMap = (z) => Math.max(0, ...cs.map(c => (mapOf[c] || {})[z] || 0));
    const priced = (z) => { const base = stdPrice(z); const d = (cost[z] ?? stdCost[z] ?? 0) - (stdCost[z] ?? cost[z] ?? 0); return fromCents(Math.max(0, base + d, groupMap(z))); };
    const label = cs.length === 1 ? cs[0] : (cs.every(c => /heather/i.test(c)) ? "Heathers" : (Object.values(cost).reduce((a, b) => a + b, 0) > Object.values(stdCost).reduce((a, b) => a + b, 0) ? "Premium colors" : "Value colors") + (i ? " " + (i + 1) : ""));
    return { label, colors: cs, costs: costs(cs[0]), ...(flat ? { flatPrice: priced("OSFA") } : { sizePricing: Object.fromEntries(sizes.map(z => [z, priced(z)])) }) };
  });
  return { standard: { colors: std, costs: costs(std[0]) }, groups, unpriced };
}

// ---- Pricing awareness (2026-10, migrations/0067) ------------------------------------------------------
// What each item of a product costs the shop under its price, and what's left. Per price row (a size, or the
// flat price; per color price group when it has groups):
//   blank     — the linked blank's vendor price, else its average cost (the dearest color of the group, so a
//               row never looks better than its worst color); 0 for a product made with no blank
//   card      — card processing at the Global settings rate (default 2.9% + 30¢), as if paid by card
//   tax       — the sales tax backed out of the (tax-inclusive) price for a taxable product, in-state
//   transfer  — the linked transfers' average cost (the reorder QR) + the product's own DTF / transfer cost
//   supplies  — the product's supplies cost, else the global per-item default
//   income    = price − all of the above;  hourly = income ÷ (runMinutes ÷ 60), only when a run time is typed
// A configurable product's graphic add-ons are listed apart (`addOns`, per location its worst graphic: add-on
// price − card − tax − its transfer's cost). Rows below a target (Global settings → Pricing) are flagged.
const DEFAULT_PRICING_SETTINGS = { cardPctBps: 290, cardFixedCents: 30, suppliesCents: 0, targetHourlyCents: null, targetIncomeCents: null };
export async function getPricingSettings(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='pricing'").first().catch(() => null);
  return { ...DEFAULT_PRICING_SETTINGS, ...((row && tryParse_(row.value, {})) || {}) };
}
// The settings as the admin screens show them: dollars and percent, plus the sales tax rate in use.
export async function getPricingSettingsView(db) {
  const s = await getPricingSettings(db), { rateBps } = await getSalesTaxSettings(db);
  return { ...s, cardPct: s.cardPctBps / 100, cardFixed: fromCents(s.cardFixedCents), supplies: fromCents(s.suppliesCents),
    targetHourly: s.targetHourlyCents == null ? null : fromCents(s.targetHourlyCents), targetIncome: s.targetIncomeCents == null ? null : fromCents(s.targetIncomeCents), taxRateBps: rateBps };
}
// Takes cents / basis points (orders.js converts what the form sends). A blank target turns that alert off.
export async function setPricingSettings(db, s) {
  const n = (v, max, nullable) => {
    if (v === null || v === undefined || v === "") { if (nullable) return null; throw pricingError_("Fill in every fee field (0 is fine)."); }
    const x = Math.round(Number(v));
    if (!Number.isFinite(x) || x < 0 || x > max) throw pricingError_("A pricing setting is out of range.");
    return x;
  };
  const next = { cardPctBps: n(s.cardPctBps, 2000), cardFixedCents: n(s.cardFixedCents, 1000), suppliesCents: n(s.suppliesCents, 100000),
    targetHourlyCents: n(s.targetHourlyCents, 10000000, true), targetIncomeCents: n(s.targetIncomeCents, 10000000, true) };
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('pricing', ?)").bind(JSON.stringify(next)).run();
  return next;
}

// Average minutes to make one piece of each product, from its timed, finished runs (every hooping of a piece
// added up). {productId: {minutes, pieces}} for one shop. Untimed hoopings ("Mark done (no timing)") and pieces
// with any untimed hooping are left out, so a piece is never counted as quicker than it was.
async function avgRunMinutesByProduct_(db, orgId) {
  const { results } = await db.prepare(
    `SELECT oi.productId, pr.id, pr.itemId, pr.pieceNo, pr.startedAt, pr.finishedAt, pr.timed
     FROM production_runs pr JOIN order_items oi ON oi.id = pr.itemId
     WHERE pr.status = 'done' AND oi.orgId = ? AND oi.productId IS NOT NULL AND oi.productId <> ''`).bind(orgId).all().catch(() => ({ results: [] }));
  const pieces = new Map();
  for (const r of results || []) {
    const key = r.productId + "\u0001" + r.itemId + "\u0001" + (r.pieceNo != null ? r.pieceNo : "r" + r.id);
    const ms = new Date(r.finishedAt) - new Date(r.startedAt);
    const cur = pieces.get(key) || { productId: r.productId, ms: 0, bad: false };
    if (!Number(r.timed) || !Number.isFinite(ms) || ms <= 0) cur.bad = true; else cur.ms += ms;
    pieces.set(key, cur);
  }
  const out = {};
  for (const p of pieces.values()) {
    if (p.bad) continue;
    const o = out[p.productId] = out[p.productId] || { totalMs: 0, pieces: 0 };
    o.totalMs += p.ms; o.pieces++;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { minutes: Math.round(v.totalMs / v.pieces / 6000) / 10, pieces: v.pieces }]));
}

// The pricing analysis of a shop's products (orgId), one product (productId), or every shop (no orgId).
// `draft` (one product only) = the product form's unsaved price fields, so the numbers follow what's typed.
// Returns {settings, products: [{orgId, productId, name, visible, runMinutes, avgRunMinutes, avgRunPieces,
// rows: [{group, size, price, blank, blankSource, card, tax, transfer, supplies, costs, income, hourly, flags}],
// addOns: [...], minIncome, maxIncome, minHourly, belowTarget, problems: [text]}]}, money in dollars.
export async function analyzePricing(db, { orgId = null, productId = null, draft = null } = {}) {
  const settings = await getPricingSettings(db);
  const { rateBps, taxMode } = await getSalesTaxSettings(db);
  // Tax added on top (Global settings → Sales tax): the customer pays it over the price, so it isn't a cost —
  // but the card fee is charged on the price plus that tax. Prices that include tax: the tax comes out of them.
  const taxOnTop = taxMode_(taxMode) === "exclusive";
  const where = orgId ? (productId ? "WHERE orgId=? AND productId=?" : "WHERE orgId=?") : "";
  const binds = orgId ? (productId ? [orgId, productId] : [orgId]) : [];
  const { results: prows } = await db.prepare(`SELECT * FROM products ${where} ORDER BY orgId, sortOrder, productId`).bind(...binds).all();
  let products = prows.map(parseProduct_);
  if (draft && products.length === 1) {
    const d = draft, p = products[0];
    for (const k of ["pricingMode", "flatPrice", "sizePricing", "colorGroups", "taxable", "runMinutes", "transferCost", "suppliesCost", "reorderQr", "noBlankNeeded", "fixedTransfers"]) if (d[k] !== undefined) p[k] = d[k];
  }
  const linkSql = (map) => `SELECT l.orgId, l.productId, l.productColor, l.productSize, l.blankColor, l.blankSize, bs.vendorPriceCents, bs.purchasePriceCents${map ? ", bs.mapPriceCents" : ""}, b.name AS blankName, b.brand AS blankBrand
    FROM product_blank_links l LEFT JOIN blank_sizes bs ON bs.blankId = l.blankId AND bs.color = l.blankColor AND bs.size = l.blankSize
    LEFT JOIN blanks b ON b.id = l.blankId` + (orgId ? " WHERE l.orgId = ?" : "");
  // (a database from before migrations/0070 has no MAP column: read the links without it)
  const { results: links } = await db.prepare(linkSql(true)).bind(...(orgId ? [orgId] : [])).all()
    .catch(() => db.prepare(linkSql(false)).bind(...(orgId ? [orgId] : [])).all());
  const linksOf = new Map();
  for (const l of links) { const k = l.orgId + "\u0001" + l.productId; (linksOf.get(k) || linksOf.set(k, []).get(k)).push(l); }
  const { results: trows } = await db.prepare("SELECT id, name, purchasePriceCents, visible FROM transfers").all().catch(() => ({ results: [] }));
  const transferById = new Map((trows || []).map(t => [Number(t.id), t]));
  const { results: grows } = await db.prepare("SELECT id, name, kind, transferId, tier FROM graphics").all().catch(() => ({ results: [] }));
  const graphicById = new Map((grows || []).map(g => [Number(g.id), g]));
  const brandRules = await getBrandRules(db).catch(() => null);
  const tierCache = {}, runCache = {};
  const tiersOf = async (org) => tierCache[org] || (tierCache[org] = await getTierPrices(db, org));
  const runsOf = async (org) => runCache[org] || (runCache[org] = await avgRunMinutesByProduct_(db, org));
  const transferCents = (id) => { const t = transferById.get(Number(id)); return t ? Math.max(0, Number(t.purchasePriceCents) || 0) : 0; };
  const cardOf = (c) => c > 0 ? Math.round(c * settings.cardPctBps / 10000) + settings.cardFixedCents : 0;
  const out = [];
  for (const p of products) {
    const tiers = await tiersOf(p.orgId), runs = await runsOf(p.orgId);
    const plinks = linksOf.get(p.orgId + "\u0001" + p.productId) || [];
    const colorName = (c) => typeof c === "object" && c ? String(c.color || c.name || "") : String(c || "");
    const garment = (p.garmentColors || []).map(colorName).filter(Boolean);
    const grouped = new Set((p.colorGroups || []).flatMap(g => g.colors || []));
    const groups = [{ label: (p.colorGroups || []).length ? "Standard" : "", colors: garment.length ? garment.filter(c => !grouped.has(c)) : [""], sizePricing: p.sizePricing, flatPrice: p.flatPrice }]
      .concat((p.colorGroups || []).map(g => ({ label: g.label, colors: g.colors || [], sizePricing: g.sizePricing, flatPrice: g.flatPrice })));
    // The reorder QR's transfer (a plain product can carry one too) + the product's own DTF / transfer cost.
    const qr = resolveReorderQr_(p.reorderQr, { transferId: tiers.reorderQrTransferId, graphicId: tiers.reorderQrGraphicId });
    let qrCents = 0, qrName = "";
    if (qr && qr.transferId) { const t = transferById.get(Number(qr.transferId)); if (t && Number(t.visible)) { qrCents = transferCents(t.id); qrName = t.name || "Reorder QR"; } }
    else if (qr && qr.graphicId) { const g = graphicById.get(Number(qr.graphicId)); if (g && g.transferId) { qrCents = transferCents(g.transferId); qrName = g.name || "Reorder QR"; } }
    // Its printed transfers (migrations/0068) are in the base price, so their cost is on every row.
    let fixedCents = 0;
    for (const f of Array.isArray(p.fixedTransfers) ? p.fixedTransfers : []) { const g = graphicById.get(Number(f.graphicId)); if (g && g.kind === "transfer" && g.transferId) fixedCents += transferCents(g.transferId); }
    const ownTransfer = toCentsOrNull(p.transferCost) || 0;
    const supplies = p.suppliesCost != null ? toCents(p.suppliesCost) : settings.suppliesCents;
    const blankFor = (colors, size, flat) => {
      if (p.noBlankNeeded) return { cents: 0, source: "none", map: null, mapOf: "", ruleMin: null, ruleOf: "" };
      const want = new Set(colors);
      let cand = plinks.filter(l => (flat || (l.productSize || "") === size) && want.has(l.productColor || ""));
      if (!cand.length) cand = plinks.filter(l => (flat || (l.productSize || "") === size) && !(l.productColor || ""));
      let best = null, src = null, map = null, mapOf = "", mapBlank = "", mapBrand = "", ruleMin = null, ruleOf = "";
      for (const l of cand) {
        // The price rule (Brand rules): MAP + $ / % for the blank's brand, else the general one — the highest wins.
        const rule = l.mapPriceCents != null ? priceRuleFor_(brandRules, l.blankBrand) : null;
        if (rule) { const m = priceRuleMinCents_(Number(l.mapPriceCents), rule); if (ruleMin == null || m > ruleMin) { ruleMin = m; ruleOf = priceRuleText_(rule) + (rule.brand ? ` for ${rule.brand}` : ""); } }
        const v = l.vendorPriceCents != null ? Number(l.vendorPriceCents) : (Number(l.purchasePriceCents) > 0 ? Number(l.purchasePriceCents) : null);
        if (v != null && (best == null || v > best)) { best = v; src = l.vendorPriceCents != null ? "vendor" : "average"; }
        // MAP (migrations/0070): the highest of the linked blank sizes — the price may not be below any of them.
        if (l.mapPriceCents != null && (map == null || Number(l.mapPriceCents) > map)) { map = Number(l.mapPriceCents); mapOf = [l.blankName, l.blankColor, l.blankSize].filter(Boolean).join(" "); mapBlank = l.blankName || ""; mapBrand = l.blankBrand || ""; }
      }
      return { cents: best, source: src, map, mapOf, mapBlank, mapBrand, ruleMin, ruleOf };
    };
    const minutes = p.runMinutes != null && Number(p.runMinutes) > 0 ? Number(p.runMinutes) : null;
    const rows = [];
    const flat = p.pricingMode === "flat";
    for (const g of groups) {
      if (g.label && !g.colors.length) continue;
      const sizes = flat ? [""] : Object.keys(g.sizePricing || {}).filter(z => (g.sizePricing || {})[z] != null && (g.sizePricing || {})[z] !== "");
      for (const size of sizes) {
        const raw = flat ? g.flatPrice : g.sizePricing[size];
        if (raw == null || raw === "") continue;
        const price = toCents(raw);
        const b = blankFor(g.colors, size, flat);
        const taxIn = p.taxable === false ? 0 : taxOnTop ? addTaxExclusive(price, rateBps).taxCents : splitTaxInclusive(price, rateBps).taxCents;
        const card = cardOf(taxOnTop ? price + taxIn : price), tax = taxOnTop ? 0 : taxIn;
        const transfer = qrCents + fixedCents + ownTransfer;
        const costs = (b.cents || 0) + card + tax + transfer + supplies;
        const income = price - costs;
        const hourly = minutes ? Math.round(income * 60 / minutes) : null;
        const flags = [];
        if (b.cents == null) flags.push("noBlankCost");
        if (b.map != null && price < b.map) flags.push("map");
        else if (b.ruleMin != null && price < b.ruleMin) flags.push("mapRule");
        // The targets are an OR: a price is fine when it meets EITHER one that applies (the hourly target only applies
        // with a run time) — a $5 cap that makes $40/hr against $10 / $40/hr targets isn't flagged. It's flagged only
        // when it misses every target that applies; the flags say which.
        const incomeOk = settings.targetIncomeCents != null && income >= settings.targetIncomeCents;
        const hourlyOk = settings.targetHourlyCents != null && hourly != null && hourly >= settings.targetHourlyCents;
        if (!incomeOk && !hourlyOk) {
          if (settings.targetIncomeCents != null) flags.push("income");
          if (settings.targetHourlyCents != null && hourly != null) flags.push("hourly");
        }
        rows.push({ group: g.label, size, price, blank: b.cents, blankSource: b.source, map: b.map, mapOf: b.mapOf, mapBlank: b.mapBlank, mapBrand: b.mapBrand, ruleMin: b.ruleMin, ruleOf: b.ruleOf, card, tax, transfer, supplies, costs, income, hourly, flags });
      }
    }
    // A configurable product's graphic add-ons: per location, the offered graphic that leaves the least.
    const addOns = [];
    if (p.configurable) for (const loc of p.locations || []) {
      let worst = null;
      for (const gid of loc.graphicIds || []) {
        const g = graphicById.get(Number(gid)); if (!g) continue;
        const add = g.tier ? (tiers.tiersCents[g.tier] || 0) : 0;
        const cost = g.kind === "transfer" && g.transferId ? transferCents(g.transferId) : 0;
        const income = add - (add > 0 ? Math.round(add * settings.cardPctBps / 10000) : 0) - (p.taxable === false ? 0 : splitTaxInclusive(add, rateBps).taxCents) - cost;
        if (!worst || income < worst.income) worst = { location: loc.label || loc.key, graphic: g.name || "", kind: g.kind, price: add, transfer: cost, income };
      }
      if (worst) addOns.push(worst);
    }
    const incomes = rows.map(r => r.income), hours = rows.map(r => r.hourly).filter(h => h != null);
    const problems = [];
    const has = (r, k) => r.flags.includes(k);
    const lowBoth = rows.filter(r => has(r, "income") && has(r, "hourly")), lowIncome = rows.filter(r => has(r, "income") && !has(r, "hourly")), lowHourly = rows.filter(r => has(r, "hourly") && !has(r, "income"));
    const label = (r) => [r.group, r.size].filter(Boolean).join(" ") || "the price";
    const incT = () => `$${fromCents(settings.targetIncomeCents).toFixed(2)}`, hrT = () => `$${fromCents(settings.targetHourlyCents).toFixed(2)}/hr`;
    if (lowBoth.length) problems.push(`Below both targets (income under ${incT()}, hourly rate under ${hrT()}) on ${lowBoth.map(label).join(", ")}`);
    if (lowIncome.length) problems.push(`Income below the ${incT()} target on ${lowIncome.map(label).join(", ")}`);
    if (lowHourly.length) problems.push(`Hourly rate below the ${hrT()} target on ${lowHourly.map(label).join(", ")}`);
    // Below the blank's minimum advertised price (migrations/0070) — a hard rule, kept apart from the targets.
    const mapProblems = rows.filter(r => r.flags.includes("map")).map(r => `${label(r) === "the price" ? "The price" : label(r)} $${fromCents(r.price).toFixed(2)} is below the MAP of $${fromCents(r.map).toFixed(2)} (${r.mapOf})`);
    // Under the price rule (Brand rules) but not under MAP — a warning, softer than MAP.
    const ruleProblems = rows.filter(r => r.flags.includes("mapRule")).map(r => `${label(r) === "the price" ? "The price" : label(r)} $${fromCents(r.price).toFixed(2)} is under the price rule of $${fromCents(r.ruleMin).toFixed(2)} (${r.ruleOf})`);
    const run = runs[p.productId] || null;
    const $ = (c) => c == null ? null : fromCents(c);
    out.push({ orgId: p.orgId, productId: p.productId, name: p.name, visible: p.visible, runMinutes: minutes,
      avgRunMinutes: run ? run.minutes : null, avgRunPieces: run ? run.pieces : 0, reorderQr: qrName, transferOwn: $(ownTransfer), transferFixed: $(fixedCents),
      suppliesFromProduct: p.suppliesCost != null,
      belowMap: mapProblems.length > 0, mapProblems, belowPriceRule: ruleProblems.length > 0, ruleProblems,
      rows: rows.map(r => ({ ...r, price: $(r.price), blank: $(r.blank), map: $(r.map), ruleMin: $(r.ruleMin), card: $(r.card), tax: $(r.tax), transfer: $(r.transfer), supplies: $(r.supplies), costs: $(r.costs), income: $(r.income), hourly: $(r.hourly) })),
      addOns: addOns.map(a => ({ ...a, price: $(a.price), transfer: $(a.transfer), income: $(a.income) })),
      minIncome: incomes.length ? $(Math.min(...incomes)) : null, maxIncome: incomes.length ? $(Math.max(...incomes)) : null,
      minHourly: hours.length ? $(Math.min(...hours)) : null, belowTarget: !!(lowBoth.length || lowIncome.length || lowHourly.length), problems });
  }
  return { settings: { ...(await getPricingSettingsView(db)), taxMode: taxOnTop ? "exclusive" : "inclusive" }, taxMode: taxOnTop ? "exclusive" : "inclusive", products: out };
}

// For the 6 AM roll-up: visible products below a pricing target that WEREN'T last time (global_settings key
// 'pricingAlerts' = the keys reported then), so each is mentioned once, when it slips — not every morning. A
// product that recovers and slips again is reported again. `commit()` saves today's set once the email is out.
export async function getNewPricingAlerts(db) {
  const prev = new Set(((tryParse_(await getSettingRaw(db, "pricingAlerts").catch(() => null), {}) || {}).keys) || []);
  const below = (await analyzePricing(db)).products.filter(p => p.visible && (p.belowTarget || p.belowMap));
  const keys = below.map(p => p.orgId + "|" + p.productId);
  return { products: below.filter(p => !prev.has(p.orgId + "|" + p.productId)).map(p => ({ orgId: p.orgId, productId: p.productId, name: p.name, problems: [...p.mapProblems, ...p.problems] })),
    commit: () => setSettingRaw(db, "pricingAlerts", JSON.stringify({ keys, at: new Date().toISOString() })) };
}

// After a blank's cost changes (vendor prices, a receive moving its average, a vendor file / refresh): the products
// using those blanks that are now below a pricing target — [{orgId, productId, name, problems}] (visible ones only).
export async function pricingBelowTargetForBlanks(db, blankIds) {
  const ids = [...new Set((blankIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const { results } = await db.prepare(`SELECT DISTINCT orgId, productId FROM product_blank_links WHERE blankId IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
  const want = new Set(results.map(r => r.orgId + "|" + r.productId));
  const out = [];
  for (const org of [...new Set(results.map(r => r.orgId))]) {
    for (const a of (await analyzePricing(db, { orgId: org })).products) {
      if (a.visible && (a.belowTarget || a.belowMap) && want.has(a.orgId + "|" + a.productId)) out.push({ orgId: a.orgId, productId: a.productId, name: a.name, problems: [...a.mapProblems, ...a.problems], belowMap: a.belowMap, mapProblems: a.mapProblems });
    }
  }
  return out;
}

// The customer's own design as an entry in a line's copy of its options (configJson). `upload` is
// {uploadId, fileKey, fileName, fileExt} or null (no file — the admin attaches one with Files). An
// upload carried over from the line's own copy (Edit items) also brings the `kind` and `addOnCents`
// it was ordered with, so a line stays editable after the product stops offering it.
export const CUSTOM_PLAIN_LOCATION = "customdesign";
// `locCents` is a configurable location's own add-on (its customDesignPriceCents), used in place of the
// product's when it is set.
function customDesignEntry_(row, location, label, upload, locCents) {
  const u = upload && typeof upload === "object" ? upload : null;
  const offered = CUSTOM_DESIGN_KINDS.includes(row.customDesign) && row.customDesign;
  const kind = offered || (u && CUSTOM_DESIGN_KINDS.includes(u.kind) && u.kind) || "";
  if (!kind) throw pricingError_(`${row.name || "This product"} no longer takes your own design — please remove it from your cart and add it again.`);
  const own = locCents != null && locCents !== "" && Number.isFinite(Number(locCents)) ? Number(locCents) : null;
  const addOnCents = offered ? Math.max(0, own != null ? own : Number(row.customDesignPriceCents) || 0) : Math.max(0, Number(u.addOnCents) || 0);
  return { location: String(location), label: String(label || location), custom: true, kind, graphicId: null, designId: null, transferId: null,
    graphicName: "Your own design", ink: "", tier: null, addOnCents,
    uploadId: u && u.uploadId ? String(u.uploadId) : null, fileKey: u ? String(u.fileKey || "") : "",
    fileName: u ? String(u.fileName || "") : "", fileExt: u ? String(u.fileExt || "") : "",
    imageUrl: "", thumbUrl: "" };
}

// The custom entries in a line's saved copy, as the `opts.custom` priceItem takes — how an edit to
// the line keeps the customer's design. Built from the stored copy, never from the request.
export function customFromConfig(config) {
  const out = {};
  for (const l of (config && Array.isArray(config.locations) ? config.locations : [])) {
    if (!l || !l.custom) continue;
    out[String(l.location)] = { uploadId: l.uploadId || null, fileKey: l.fileKey || "", fileName: l.fileName || "", fileExt: l.fileExt || "",
      kind: l.kind, addOnCents: Number(l.addOnCents) || 0 };
  }
  return out;
}

// The automatic, unpriced reorder-QR application for a product, as a snapshot entry — or null when
// the product has none (its own choice, else the shop's default). `orgDefault` can be passed when the
// caller already has the shop's settings.
async function reorderQrEntry_(db, orgId, productReorderQr, orgDefault) {
  if (String(productReorderQr || "default") === "none") return null;
  if (!orgDefault) { const t = await getTierPrices(db, orgId); orgDefault = { transferId: t.reorderQrTransferId, graphicId: t.reorderQrGraphicId }; }
  const qr = resolveReorderQr_(productReorderQr, orgDefault);
  if (qr && qr.transferId) {
    const t = await db.prepare("SELECT id, name, visible FROM transfers WHERE id=?").bind(qr.transferId).first();
    return t && Number(t.visible) ? { location: "reorderqr", label: "Reorder QR", graphicId: null, kind: "transfer",
      designId: null, transferId: Number(t.id), graphicName: t.name || "Reorder QR", ink: "", tier: null, addOnCents: 0,
      imageUrl: "", thumbUrl: "", auto: true } : null;
  }
  if (qr && qr.graphicId) {   // chosen the old way, through a graphic
    const qg = await getGraphic(db, qr.graphicId);
    return qg && qg.visible ? { location: "reorderqr", label: "Reorder QR", graphicId: qg.id, kind: qg.kind,
      designId: qg.designId, transferId: qg.transferId, graphicName: qg.name, ink: "", tier: null, addOnCents: 0,
      imageUrl: qg.imageUrl, thumbUrl: qg.thumbUrl, auto: true } : null;
  }
  return null;
}

// An order line keeps a COPY of its options from when it was placed (configJson), so a later fix to
// the catalog — a graphic switched from a transfer to embroidery, a transfer linked to a graphic, a
// reorder QR turned on — doesn't reach orders that already exist. This re-reads the catalog for an
// open order's lines: each chosen graphic's kind / design / transfer / name / picture, and the reorder
// QR. What the customer chose (graphic, ink, color) and what they paid (price, add-ons) never change.
// Lines that are cancelled or fully made are left alone. `apply` false = preview only.
export async function refreshOrderLinesFromCatalog(db, orderId, apply = true) {
  const order = await db.prepare("SELECT orderId, orgId, voidedAt, completedAt FROM orders WHERE orderId=?").bind(orderId).first();
  if (!order) throw new Error("Order not found");
  if (order.voidedAt) throw new Error("This order is voided");
  if (order.completedAt) throw new Error("This order is completed — reopen it first");
  const { results: items } = await db.prepare(
    `SELECT i.id, i.name, i.size, i.qty, i.productId, i.configJson, i.cancelDate, COALESCE(i.manufacturedQty,0) AS made,
            p.configurable, p.reorderQr, p.fixedTransfersJson, p.productId AS hasProduct
     FROM order_items i LEFT JOIN products p ON p.orgId = i.orgId AND p.productId = i.productId
     WHERE i.orderId = ? ORDER BY i.id`).bind(orderId).all();
  const t = await getTierPrices(db, order.orgId);
  const orgDefault = { transferId: t.reorderQrTransferId, graphicId: t.reorderQrGraphicId };
  const how = (l) => l.kind === "embroidery" ? "embroidery" : "a transfer";
  const lines = [];
  for (const it of items) {
    if (it.cancelDate || !it.hasProduct || Number(it.made) >= (Number(it.qty) || 1)) continue;
    const old = tryParse_(it.configJson, null);
    const oldLocs = old && Array.isArray(old.locations) ? old.locations : [];
    const changes = [], locs = [];
    const picked = Number(it.configurable) && old && !old.plain;
    if (picked) for (const l of oldLocs) {
      if (l.auto || l.fixed) continue;   // re-read below
      const g = l.graphicId ? await getGraphic(db, Number(l.graphicId)) : null;
      if (!g) { locs.push(l); continue; }
      const n = Object.assign({}, l, { kind: g.kind, designId: g.designId, transferId: g.transferId, graphicName: g.name, imageUrl: g.imageUrl, thumbUrl: g.thumbUrl });
      if (l.kind !== n.kind) changes.push(`${n.graphicName}: ${how(l)} → ${how(n)}`);
      else if (n.kind === "transfer" && Number(l.transferId || 0) !== Number(n.transferId || 0)) changes.push(`${n.graphicName}: ${n.transferId ? "transfer linked" : "transfer unlinked"}`);
      else if (n.kind === "embroidery" && Number(l.designId || 0) !== Number(n.designId || 0)) changes.push(`${n.graphicName}: design changed`);
      else if ((l.graphicName || "") !== n.graphicName) changes.push(`"${l.graphicName || ""}" is now "${n.graphicName}"`);
      locs.push(n);
    }
    // The product's printed transfers (migrations/0068), re-read like the QR.
    const fixed = await fixedTransferEntries_(db, order.orgId, it);
    const fkey = (l) => l.location + "|" + (l.transferId || "") + "|" + (l.graphicName || "") + "|" + (l.ink || "");
    const oldFixed = oldLocs.filter(l => l.fixed);
    for (const f of fixed) { const o = oldFixed.find(x => x.location === f.location);
      if (!o) changes.push(`Printed transfer added: ${f.label} — ${f.graphicName}`);
      else if (fkey(o) !== fkey(f)) changes.push(`Printed transfer at ${f.label} is now ${f.graphicName}${f.transferId ? "" : " (no transfer linked)"}`); }
    for (const o of oldFixed) if (!fixed.some(f => f.location === o.location)) changes.push(`Printed transfer removed: ${o.label} — ${o.graphicName}`);
    locs.push(...fixed);
    const oldQr = oldLocs.find(l => l.auto) || null;
    const qr = await reorderQrEntry_(db, order.orgId, it.reorderQr, orgDefault);
    if (qr) locs.push(qr);
    if (qr && !oldQr) changes.push(`Reorder QR added (${qr.graphicName})`);
    else if (!qr && oldQr) changes.push("Reorder QR removed");
    else if (qr && oldQr && Number(qr.transferId || 0) !== Number(oldQr.transferId || 0)) changes.push(`Reorder QR is now ${qr.graphicName}`);
    let next;
    if (picked) next = Object.assign({}, old, { locations: locs });
    else if (old && !old.plain) continue;                      // a snapshot we don't understand: leave it
    else {
      // An ordinary line keeps the customer's own design (migrations/0054); only the QR is re-read.
      const kept = oldLocs.filter(l => l && l.custom).concat(fixed, qr ? [qr] : []);
      next = kept.length ? { garmentColor: "", size: it.size || "", locations: kept, plain: true } : null;
    }
    const nextJson = next ? JSON.stringify(next) : "";
    if (nextJson === (it.configJson || "") || (!next && !old)) continue;
    if (!changes.length) changes.push("Pictures / names refreshed");
    if (apply) await db.prepare("UPDATE order_items SET configJson=? WHERE id=?").bind(nextJson, Number(it.id)).run();
    lines.push({ itemId: Number(it.id), name: it.name || "", size: it.size || "", changes });
  }
  return { lines };
}

// Validates a configurable line's chosen options and returns { addOnCents, snapshot }. The snapshot
// (stored in order_items.configJson) carries the garment color + one entry per chosen location and,
// when enabled, the unpriced reorder-QR application. Throws pricingError_ on anything invalid or an
// all-None line (a blank garment is never sellable).
async function priceConfigurable_(db, orgId, productRow, size, config, custom = {}) {
  const cfg = config || {};
  const garmentColors = tryParse_(productRow.garmentColorsJson, []) || [];
  const productLocations = tryParse_(productRow.locationsJson, []) || [];
  const garmentColor = String(cfg.garmentColor || cfg.color || "");
  // Stored on the line as typed when the product lists no colours, so it is held to a colour's length.
  if (garmentColor.length > 60) throw pricingError_("Pick a garment color.");
  if (garmentColors.length && !garmentColors.includes(garmentColor)) throw pricingError_("Pick a garment color.");

  // Normalize the client's picks to locKey → {graphicId, ink, custom}. `custom` = the customer's own
  // design at that location (migrations/0054).
  const picks = new Map();
  const rawLocs = cfg.locations;
  const isCustom = (l) => l.custom === true || l.graphicId === "custom";
  if (Array.isArray(rawLocs)) for (const l of rawLocs) { if (l && l.location) picks.set(String(l.location), { graphicId: l.graphicId, ink: l.ink, custom: isCustom(l) }); }
  else if (rawLocs && typeof rawLocs === "object") for (const k of Object.keys(rawLocs)) { const l = rawLocs[k] || {}; picks.set(String(k), { graphicId: l.graphicId, ink: l.ink, custom: isCustom(l) }); }

  const { tiersCents, reorderQrGraphicId, reorderQrTransferId } = await getTierPrices(db, orgId);
  // Graphic + color pairs this product doesn't offer (migrations/0050).
  const blocked = tryParse_(productRow.blockedGraphicColorsJson, []) || [];
  let addOnCents = 0, needsCustomUpload = false;
  const snapLocs = [];
  for (const loc of productLocations) {
    const pick = picks.get(String(loc.key)) || {};
    if (pick.custom) {
      const has = Object.prototype.hasOwnProperty.call(custom, String(loc.key));
      const entry = customDesignEntry_(productRow, loc.key, loc.label || loc.key, has ? custom[String(loc.key)] : null, loc.customDesignPriceCents);
      if (!has) needsCustomUpload = true;
      addOnCents += entry.addOnCents;
      snapLocs.push(entry);
      continue;
    }
    const gid = pick.graphicId == null || pick.graphicId === "" ? null : Number(pick.graphicId);
    if (!gid) continue; // "None" at this location
    if (!(loc.graphicIds || []).map(Number).includes(gid)) throw pricingError_(`That option isn't available at ${loc.label || loc.key}.`);
    const g = await getGraphic(db, gid);
    if (!graphicUsableBy_(g, orgId) || !g.visible) throw pricingError_("That option isn't available.");
    if (g.allowedLocations.length && !g.allowedLocations.includes(String(loc.key))) throw pricingError_(`${g.name} can't go on ${loc.label || loc.key}.`);
    if (g.allowedGarmentColors.length && garmentColor && !g.allowedGarmentColors.includes(garmentColor)) throw pricingError_(`${g.name} isn't available on ${garmentColor}.`);
    if (garmentColor && blocked.some(b => Number(b.graphicId) === gid && b.color === garmentColor)) throw pricingError_(`${g.name} isn't available on ${garmentColor}.`);
    let ink = String(pick.ink || "");
    if (g.inkColors.length) { if (!ink) ink = g.inkColors[0]; if (!g.inkColors.includes(ink)) throw pricingError_(`That ink isn't available for ${g.name}.`); }
    else ink = "";
    const add = g.tier ? (tiersCents[g.tier] || 0) : 0;
    addOnCents += add;
    snapLocs.push({ location: String(loc.key), label: loc.label || loc.key, graphicId: gid, kind: g.kind,
      designId: g.designId, transferId: g.transferId, graphicName: g.name, ink, tier: g.tier || null,
      addOnCents: add, imageUrl: g.imageUrl, thumbUrl: g.thumbUrl });
  }
  // The product's own printed transfers (migrations/0068) decorate it too, so with any of them every location
  // may be left at None.
  const fixedLocs = await fixedTransferEntries_(db, orgId, productRow);
  // A product that offers no options at all (only garment colors — its decoration is its own designs, e.g. one made
  // with the New shop setup wizard) needs no pick.
  if (!snapLocs.length && !fixedLocs.length && productLocations.length) throw pricingError_("Pick at least one graphic — a blank garment can't be ordered.");
  snapLocs.push(...fixedLocs);

  // Reorder QR: an automatic, unpriced transfer application (COGS only), appended to the snapshot.
  // It's a TRANSFER linked directly (migrations/0047) — no graphic in between (see reorderQrEntry_).
  const qrEntry = await reorderQrEntry_(db, orgId, productRow.reorderQr, { transferId: reorderQrTransferId, graphicId: reorderQrGraphicId });
  if (qrEntry) snapLocs.push(qrEntry);
  return { addOnCents, needsCustomUpload, snapshot: { garmentColor, size: size || "", locations: snapLocs } };
}

// ---- Global settings ---------------------------------------------------

export async function getGlobalSettings(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='enabledPayments'").first();
  return {
    enabledPayments: row ? tryParse_(row.value, { card: true, venmo: true, zelle: true, check: true }) : { card: true, venmo: true, zelle: true, check: true }
  };
}

export async function setGlobalSettings(db, settings) {
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', ?)")
    .bind(JSON.stringify(settings.enabledPayments || {})).run();
}

// ---- Platform state in global_settings / admin_sessions ---------------------------------------
// catalogVersion: bumped by Publish, keys the edge cache. totpSecret / totpLastCounter: 2FA.
// cacheNs: a random per-database id so two environments sharing a zone never share Cache API keys.

export async function getSettingRaw(db, key) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

export async function setSettingRaw(db, key, value) {
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES (?, ?)").bind(key, String(value)).run();
}

export async function deleteSettingRaw(db, key) {
  await db.prepare("DELETE FROM global_settings WHERE key = ?").bind(key).run();
}

// ---- New shop setup wizard (admin → Manage catalog → New shop setup) ----------------------------------
// Where the wizard is and what was answered, per shop, so the admin can stop at any screen and resume there. It's
// working state, not shop data: the shop and its products are written to their own tables as the wizard goes.
const SHOP_WIZARD_MAX_ = 200000;   // characters of JSON
const shopWizardKey_ = (orgId) => "shopWizard:" + orgId;
export async function getShopWizard(db, orgId) {
  return tryParse_(await getSettingRaw(db, shopWizardKey_(orgId)), null);
}
export async function saveShopWizard(db, orgId, state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw Object.assign(new Error("Nothing to save"), { userFacing: true });
  const json = JSON.stringify(Object.assign({}, state, { updatedAt: new Date().toISOString() }));
  if (json.length > SHOP_WIZARD_MAX_) throw Object.assign(new Error("The setup is too large to save"), { userFacing: true });
  await setSettingRaw(db, shopWizardKey_(orgId), json);
  return JSON.parse(json);
}
export async function deleteShopWizard(db, orgId) { await deleteSettingRaw(db, shopWizardKey_(orgId)); }
// Every shop with a setup in progress: {orgId, step, done, updatedAt}.
export async function listShopWizards(db) {
  const rows = (await db.prepare("SELECT key, value FROM global_settings WHERE key LIKE 'shopWizard:%'").all()).results || [];
  return rows.map(r => { const v = tryParse_(r.value, {}) || {};
    return { orgId: r.key.slice("shopWizard:".length), step: v.step || "", done: !!v.done, updatedAt: v.updatedAt || "" }; });
}

// Links every color × size of a product to ONE blank, replacing the product's links (the wizard's "this product is
// made from that blank"). Names match ignoring case and spaces, as the product form's autoPick does; a product
// without colors (productColors = [""]) takes the blank's unnamed color, else its first; a one-size product
// ("OSFA") takes the blank color's only size. Returns {linked, missing: ["Navy XL", …]}.
export async function setProductLinksFromBlank(db, orgId, productId, blank, productColors, productSizes) {
  const norm = (v) => String(v == null ? "" : v).toLowerCase().replace(/\s+/g, "");
  const colors = (blank.colors || []).map(c => c.color);
  const sizesOf = (color) => (blank.sizes || []).filter(z => norm(z.color) === norm(color)).map(z => z.size);
  const rows = [], missing = [];
  for (const pc of (productColors && productColors.length ? productColors : [""])) {
    const bc = pc ? colors.find(c => norm(c) === norm(pc)) : (colors.includes("") ? "" : colors[0]);
    if (bc === undefined) { missing.push(pc); continue; }
    const have = sizesOf(bc);
    for (const ps of productSizes) {
      const bs = have.find(z => norm(z) === norm(ps)) ?? (ps === "OSFA" && have.length === 1 ? have[0] : undefined);
      if (bs === undefined) { missing.push((pc ? pc + " " : "") + ps); continue; }
      rows.push([orgId, productId, pc, ps, Number(blank.id), bc, bs]);
    }
  }
  const stmts = [db.prepare("DELETE FROM product_blank_links WHERE orgId = ? AND productId = ?").bind(orgId, productId)];
  if (rows.length) stmts.push(...importMultiInsert_(db,
    "INSERT INTO product_blank_links (orgId, productId, productColor, productSize, blankId, blankColor, blankSize)", "(?, ?, ?, ?, ?, ?, ?)",
    "ON CONFLICT (orgId, productId, productColor, productSize) DO UPDATE SET blankId=excluded.blankId, blankColor=excluded.blankColor, blankSize=excluded.blankSize",
    rows, 14));
  await db.batch(stmts);
  return { linked: rows.length, missing };
}

// Atomic increment (one statement), so two Publish clicks can't write the same version.
export async function bumpCatalogVersion(db) {
  await db.prepare(
    "INSERT INTO global_settings (key, value) VALUES ('catalogVersion', '1') " +
    "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)"
  ).run();
  return parseInt(await getSettingRaw(db, "catalogVersion"), 10) || 0;
}

// Reads the catalog version and the cache namespace in one query, creating the namespace on first use.
export async function getCatalogCacheState(db) {
  const read = async () => {
    const { results } = await db.prepare(
      "SELECT key, value FROM global_settings WHERE key IN ('catalogVersion', 'cacheNs')"
    ).all();
    const m = {};
    for (const r of results || []) m[r.key] = r.value;
    return m;
  };
  let m = await read();
  if (!m.cacheNs) {
    const ns = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await db.prepare("INSERT OR IGNORE INTO global_settings (key, value) VALUES ('cacheNs', ?)").bind(ns).run();
    m = await read();
  }
  return { version: m.catalogVersion || "0", ns: m.cacheNs };
}

// Records a TOTP counter as used. Returns false if this counter (or a later one) was already
// accepted — a replay. One conditional UPSERT, so two simultaneous logins can't both pass.
export async function claimTotpCounter(db, counter) {
  const r = await db.prepare(
    "INSERT INTO global_settings (key, value) VALUES ('totpLastCounter', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value " +
    "WHERE CAST(global_settings.value AS INTEGER) < CAST(excluded.value AS INTEGER)"
  ).bind(String(counter)).run();
  return (r.meta && r.meta.changes) > 0;
}

export async function insertAdminSession(db, tokenHash, expiresAt, userId = null, pending = null) {
  // Opportunistic cleanup of expired rows: bounded, and only when someone signs in.
  await db.prepare("DELETE FROM admin_sessions WHERE expiresAt < ?").bind(new Date().toISOString()).run();
  await db.prepare("INSERT INTO admin_sessions (tokenHash, expiresAt, userId, pending) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, expiresAt, userId == null ? null : userId, pending || null).run();
}

// A session with the user it belongs to, or null. A row with no user (made before users existed)
// comes back with user: null and is not accepted by the gate.
export async function getAdminSession(db, tokenHash) {
  const r = await db.prepare(
    "SELECT s.expiresAt, s.userId, s.pending, u.id AS uid, u.email, u.name, u.role, u.status, u.totpSecret " +
    "FROM admin_sessions s LEFT JOIN users u ON u.id = s.userId WHERE s.tokenHash = ?").bind(tokenHash).first();
  if (!r) return null;
  return { expiresAt: r.expiresAt, userId: r.userId, pending: r.pending || null,
    user: r.uid == null ? null : { id: r.uid, email: r.email, name: r.name, role: r.role, status: r.status, has2fa: !!r.totpSecret } };
}

export async function setAdminSessionPending(db, tokenHash, pending) {
  await db.prepare("UPDATE admin_sessions SET pending = ? WHERE tokenHash = ?").bind(pending || null, tokenHash).run();
}

// Signs one user out everywhere (optionally keeping the session that asked for it).
export async function deleteUserSessions(db, userId, exceptTokenHash = "") {
  await db.prepare("DELETE FROM admin_sessions WHERE userId = ? AND tokenHash <> ?").bind(userId, exceptTokenHash || "").run();
}

export async function deleteAllAdminSessions(db) {
  await db.prepare("DELETE FROM admin_sessions").run();
}

// ---- Users (migrations/0053) -------------------------------------------------------------------
// One row per person who can sign in to the admin. Nothing here decides who may do what — that is
// functions/_lib/adminAuth.js. Emails are stored lower-cased; '' is the owner adopted from an
// install that predates users, until they give an address.
const USER_COLUMNS = "id, email, name, role, status, password, mustChangePassword, totpSecret, totpLastCounter, recoveryCodes, createdAt, updatedAt, lastLoginAt";
export const USER_ROLES = ["staff", "manager", "admin"];   // lowest to highest

export async function getUserById(db, id) {
  return (await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first()) || null;
}

export async function getUserByEmail(db, email) {
  return (await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ? ORDER BY id LIMIT 1`).bind(String(email || "").trim().toLowerCase()).first()) || null;
}

export async function listUsers(db) {
  const { results } = await db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY status = 'disabled', role <> 'admin', role <> 'manager', name COLLATE NOCASE, id`).all();
  return results || [];
}

// What the sign-in code needs to decide whether the installer's passphrase still opens the admin:
// how many users there are, and every admin (active first, oldest first).
export async function getBootstrapState(db) {
  const n = await db.prepare("SELECT count(*) AS n FROM users").first();
  const { results } = await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE role = 'admin' ORDER BY status = 'disabled', id`).all();
  return { userCount: (n && n.n) || 0, admins: results || [] };
}

// Creates a user. Returns the new row. A taken email throws (the unique index).
export async function insertUser(db, { email = "", name = "", role = "staff", status = "active", password = null, mustChangePassword = false, totpSecret = null, totpLastCounter = null }) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    "INSERT INTO users (email, name, role, status, password, mustChangePassword, totpSecret, totpLastCounter, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(String(email).trim().toLowerCase(), String(name).trim(), role, status, password, mustChangePassword ? 1 : 0, totpSecret, totpLastCounter, now, now).run();
  return getUserById(db, r.meta.last_row_id);
}

// The first admin of an install: made only while there are no users at all, in one statement, so
// two requests arriving together can't make two. Returns true if this call made it.
export async function insertFirstAdmin(db, { password = null, totpSecret = null, totpLastCounter = null } = {}) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    "INSERT INTO users (email, name, role, status, password, totpSecret, totpLastCounter, createdAt, updatedAt) " +
    "SELECT '', '', 'admin', 'active', ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)"
  ).bind(password, totpSecret, totpLastCounter, now, now).run();
  return (r.meta && r.meta.changes) > 0;
}

// Changes the listed columns of one user (only these may be changed this way).
const USER_PATCHABLE = ["email", "name", "password", "mustChangePassword", "totpSecret", "totpLastCounter", "recoveryCodes", "lastLoginAt"];
export async function updateUser(db, id, patch) {
  const cols = Object.keys(patch || {}).filter(k => USER_PATCHABLE.includes(k));
  if (!cols.length) return;
  const val = (k) => k === "email" ? String(patch[k] || "").trim().toLowerCase() : k === "name" ? String(patch[k] || "").trim() : k === "mustChangePassword" ? (patch[k] ? 1 : 0) : (patch[k] == null ? null : patch[k]);
  await db.prepare(`UPDATE users SET ${cols.map(c => c + " = ?").join(", ")}, updatedAt = ? WHERE id = ?`)
    .bind(...cols.map(val), new Date().toISOString(), id).run();
}

// Role and status change through here ONLY: the statement refuses to leave the install without an
// active admin (it changes nothing, and returns false), and because the check and the change are
// one statement, two admins demoting each other at the same moment can't both succeed.
export async function setUserRoleAndStatus(db, id, { role, status }) {
  const r = await db.prepare(
    "UPDATE users SET role = COALESCE(?1, role), status = COALESCE(?2, status), updatedAt = ?3 WHERE id = ?4 AND (" +
    "  NOT (role = 'admin' AND status = 'active')" +                                     // not an active admin now: nothing to protect
    "  OR (COALESCE(?1, role) = 'admin' AND COALESCE(?2, status) = 'active')" +          // still one afterwards
    "  OR EXISTS (SELECT 1 FROM users o WHERE o.role = 'admin' AND o.status = 'active' AND o.id <> ?4))"   // someone else is
  ).bind(role || null, status || null, new Date().toISOString(), id).run();
  return (r.meta && r.meta.changes) > 0;
}

// Records a user's TOTP counter as used; false if this counter (or a later one) already was.
export async function claimUserTotpCounter(db, userId, counter) {
  const r = await db.prepare("UPDATE users SET totpLastCounter = ?1 WHERE id = ?2 AND (totpLastCounter IS NULL OR totpLastCounter < ?1)").bind(counter, userId).run();
  return (r.meta && r.meta.changes) > 0;
}

// Replaces a user's recovery codes only if they are still what the caller read, so one code can't
// be spent twice by two sign-ins racing each other.
export async function replaceRecoveryCodes(db, userId, before, after) {
  const r = await db.prepare("UPDATE users SET recoveryCodes = ?1 WHERE id = ?2 AND recoveryCodes IS ?3").bind(after, userId, before).run();
  return (r.meta && r.meta.changes) > 0;
}

export async function getAdminSessionExpiry(db, tokenHash) {
  const row = await db.prepare("SELECT expiresAt FROM admin_sessions WHERE tokenHash = ?").bind(tokenHash).first();
  return row ? row.expiresAt : null;
}

export async function deleteAdminSession(db, tokenHash) {
  await db.prepare("DELETE FROM admin_sessions WHERE tokenHash = ?").bind(tokenHash).run();
}

// Machine Files screen options — kept as their own key (admin-only, not part of the storefront
// catalog that getGlobalSettings feeds). Currently just whether the per-file Delete button shows.
// Deleting over the machine protocol is firmware-disabled today (opcode cf24 exists but always
// refuses — see the send-agent's protocol notes), so the button is HIDDEN by default; this lets the
// admin turn it on if a firmware update ever enables delete.
export async function getMachineSettings(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='machineSettings'").first();
  return row ? tryParse_(row.value, { showDeleteButton: false }) : { showDeleteButton: false };
}

export async function setMachineSettings(db, settings) {
  const clean = { showDeleteButton: !!(settings && settings.showDeleteButton) };
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('machineSettings', ?)")
    .bind(JSON.stringify(clean)).run();
}

// The "ship from" address on shipping labels/quotes — admin-editable business
// info (Global Settings screen), NOT a secret, so it lives here in D1 rather
// than as an environment variable: it can be corrected without a deploy or a
// dashboard trip. Only SHIPPO_API_KEY (the credential that authorizes charges
// to the account) belongs in the secret store; the address itself is printed
// on every label anyway.
const SHIP_FROM_DEFAULTS = { name: "", street1: "", city: "", state: "", zip: "", phone: "", email: "" };

// Fallback for an install that set the address as environment variables
// (SHIP_FROM_STREET1 etc.) instead of in Global Settings: quotes keep working
// until the form is filled in, and the form pre-fills from them.
// Precedence per field: a value saved in D1 > the env var > default.
// Callers that don't pass `env` (tests, setters) see D1 + defaults only.
const LEGACY_SHIP_FROM_ENV = { name: "SHIP_FROM_NAME", street1: "SHIP_FROM_STREET1", city: "SHIP_FROM_CITY",
  state: "SHIP_FROM_STATE", zip: "SHIP_FROM_ZIP", phone: "SHIP_FROM_PHONE", email: "SHIP_FROM_EMAIL" };

// ---- Features: optional parts of the site, each behind a switch --------------------------------
// One global_settings value ("features"), edited under Tools → Global settings → Features. Every
// feature is ON unless it was saved as false, so a new install (or a database with nothing saved)
// has everything. Turning one off hides its pages in the admin and makes the server refuse its
// actions (403); no table or row is touched, so turning it back on restores everything.
// "storefront" is different in kind: it has no admin pages of its own. Off, the public side is
// closed (catalog.js serves no shop, orders.js / checkout.js / shipping.js refuse a customer's
// order, card checkout and rate quote) and the whole admin keeps working.
// Blank / transfer stock and cost of goods are NOT a feature: making an order uses them.
export const FEATURES = [
  { key: "storefront", label: "Storefront",
    description: "Customers can browse shops and place orders online. Off: every shop address and the main address show a short “online ordering isn't available” page, and the site is back office only — orders are entered in the admin, and payment links and design proofs you send still work." },
  { key: "production", label: "Production",
    description: "Embroidery production: threads, hoops, designs and their stitch files, machines, Machine Files, Run Order and the Run Times report. Off: orders are still moved through their stages by hand on the Orders page, and no digitizing step or design is asked for." },
  { key: "bookkeeping", label: "Bookkeeping",
    description: "Expenses and receipts, Accounts & money, Reconcile, and Periods & Export (closing months, the accountant export). Off: payments on orders, the Revenue and Sales Tax reports and Stripe fees stay; months closed earlier stay locked." },
  { key: "shipping", label: "Shipping",
    description: "Carrier shipping through Shippo: rate quotes at checkout, buying labels, package sizes, the ship-from address, tracking checks in the morning roll-up and the “your order has shipped” email. Off: shops offer local pickup and their own delivery options only." },
  { key: "designVerification", label: "Design approval",
    description: "Emailing a customer a design proof to approve, and the “Design approved” stage on orders. Off: no order waits for a customer's approval, and links already sent say approval isn't available." },
];
const FEATURE_KEYS_ = FEATURES.map(f => f.key);
// { production: true, … } from whatever was saved: only an explicit false turns a feature off.
export function normalizeFeatures(saved) {
  const out = {};
  for (const k of FEATURE_KEYS_) out[k] = !(saved && saved[k] === false);
  return out;
}
export async function getFeatures(db) {
  if (!db) return normalizeFeatures(null);
  let saved = null;
  try { const row = await db.prepare("SELECT value FROM global_settings WHERE key='features'").first(); saved = row ? tryParse_(row.value, null) : null; }
  catch (e) { /* no table yet — everything on */ }
  return normalizeFeatures(saved);
}
// Saves the switches that are passed (true / false); one left out keeps its value. Unknown keys
// are ignored. Returns the full set.
export async function setFeatures(db, p) {
  const next = await getFeatures(db);
  for (const k of FEATURE_KEYS_) if (p && typeof p[k] === "boolean") next[k] = p[k];
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('features', ?)").bind(JSON.stringify(next)).run();
  return next;
}
// SQL: true unless the feature was saved as false. For rules that live in a query (which orders
// need design approval / digitizing), so they can't disagree with the setting.
const featureOnSql_ = (key) => `(COALESCE((SELECT json_extract(gs.value, '$.${key}') FROM global_settings gs WHERE gs.key = 'features' AND json_valid(gs.value)), 1) <> 0)`;

// ---- Region: time zone and country ------------------------------------------------------------
// One global_settings value ("locale"), edited under Tools → Global settings → Region.
//   timeZone — an IANA name ("Europe/London"). Used wherever a date is shown to a person by the
//              server (emails, the roll-up) and wherever the server needs "today" or the local hour
//              (the roll-up's schedule). Blank = not set here: the TIMEZONE variable is used, then UTC.
//   country  — "US" (the default: 5-digit ZIPs, 2-letter states, the ZIP-vs-state check, carrier
//              rates by ZIP) or "OTHER" (postal code and state / region are free text, no ZIP check,
//              no carrier rate quotes). Not full internationalisation — just not US-only.
// Report month boundaries are NOT affected: months in the reports are UTC months.
export const LOCALE_COUNTRIES = ["US", "OTHER"];
export const DEFAULT_TIME_ZONE = "UTC";
export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz.trim() }); return true; } catch (e) { return false; }
}
const localeCountry_ = (c) => (String(c || "").trim().toUpperCase() === "OTHER" ? "OTHER" : "US");

export async function getLocaleSettings(db) {
  const out = { timeZone: "", country: "US" };
  if (!db) return out;
  let saved = {};
  try { const row = await db.prepare("SELECT value FROM global_settings WHERE key='locale'").first(); saved = row ? (tryParse_(row.value, {}) || {}) : {}; }
  catch (e) { /* no table yet — defaults */ }
  if (isValidTimeZone(saved.timeZone)) out.timeZone = String(saved.timeZone).trim();
  out.country = localeCountry_(saved.country);
  return out;
}

// Saves what's passed (a field left undefined keeps its value). Throws (userFacing) on a time zone
// the runtime doesn't know or a country that isn't offered. A blank time zone clears it.
export async function setLocaleSettings(db, p) {
  const current = await getLocaleSettings(db);
  const next = { ...current };
  const bad = (m) => { const e = new Error(m); e.userFacing = true; return e; };
  if (p && p.timeZone !== undefined) {
    const tz = String(p.timeZone == null ? "" : p.timeZone).trim();
    if (tz && !isValidTimeZone(tz)) throw bad(`"${tz.slice(0, 64)}" isn't a time zone this site knows. Use a name like Europe/London, America/Chicago or Asia/Tokyo.`);
    next.timeZone = tz;
  }
  if (p && p.country !== undefined) {
    const c = String(p.country == null ? "" : p.country).trim().toUpperCase();
    if (!LOCALE_COUNTRIES.includes(c)) throw bad("Country must be US or OTHER.");
    next.country = c;
  }
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('locale', ?)").bind(JSON.stringify(next)).run();
  return next;
}

// THE time zone: the one saved in Region, else the TIMEZONE variable, else UTC. Never throws — a
// database that can't be read just falls through to the next source.
export async function resolveTimeZone(env) {
  let saved = "";
  try { saved = (await getLocaleSettings(env && env.DB)).timeZone; } catch (e) { /* fall through */ }
  if (saved) return saved;
  const fromEnv = env && env.TIMEZONE ? String(env.TIMEZONE).trim() : "";
  return isValidTimeZone(fromEnv) ? fromEnv : DEFAULT_TIME_ZONE;
}

// "YYYY-MM-DD" on the calendar of a time zone (an unknown zone counts as UTC).
export function dateInTimeZone(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date == null ? Date.now() : date);
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t) => parts.find(x => x.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
// Today's date where the business is — what "not in the future" and "overdue" are measured against.
export async function localToday(env, now) {
  return dateInTimeZone(now || new Date(), await resolveTimeZone(env));
}

// ---- Business profile -----------------------------------------------------------------------
// Who runs this install: the name on the storefront, emails and labels, where notifications go, and
// how customers pay by Venmo / Zelle / check. One global_settings value ("business"), edited under
// Tools → Global settings → Business profile. Everything is optional; BUSINESS_NAME_FALLBACK stands
// in for a missing name so nothing ever renders blank.
export const BUSINESS_NAME_FALLBACK = "Our shop";
const BUSINESS_FIELDS = { name: 120, legalName: 160, tagline: 200, supportEmail: 200, ownerEmail: 200, receiptsEmail: 200,
  mailingAddress: 300, venmo: 60, zelle: 200, footer: 300, poPrefix: 10 };
const BUSINESS_EMAIL_FIELDS = ["supportEmail", "ownerEmail", "receiptsEmail"];
// What a visitor's browser may see. ownerEmail / receiptsEmail are internal inboxes and stay private.
const BUSINESS_PUBLIC_FIELDS = ["name", "legalName", "tagline", "supportEmail", "mailingAddress", "venmo", "zelle", "footer"];

export async function getBusinessProfile(db) {
  const out = {};
  for (const k of Object.keys(BUSINESS_FIELDS)) out[k] = "";
  if (!db) return out;
  let saved = {};
  try { const row = await db.prepare("SELECT value FROM global_settings WHERE key='business'").first(); saved = row ? (tryParse_(row.value, {}) || {}) : {}; }
  catch (e) { /* no table yet — defaults */ }
  for (const k of Object.keys(BUSINESS_FIELDS)) if (saved[k]) out[k] = String(saved[k]);
  return out;
}

export function publicBusinessProfile(p) {
  const out = {};
  for (const k of BUSINESS_PUBLIC_FIELDS) out[k] = (p && p[k]) || "";
  return out;
}

// Returns the saved profile. Throws (userFacing) on an invalid email or Venmo name.
export async function setBusinessProfile(db, p) {
  const clean = {};
  for (const k of Object.keys(BUSINESS_FIELDS)) clean[k] = String((p && p[k]) == null ? "" : p[k]).trim().slice(0, BUSINESS_FIELDS[k]);
  clean.venmo = clean.venmo.replace(/^@/, "");
  const bad = (m) => { const e = new Error(m); e.userFacing = true; return e; };
  for (const k of BUSINESS_EMAIL_FIELDS) if (clean[k] && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(clean[k])) throw bad("That doesn't look like a valid email: " + clean[k]);
  if (clean.venmo && !/^[A-Za-z0-9_-]+$/.test(clean.venmo)) throw bad("A Venmo username has only letters, numbers, - and _");
  // Starts the number of each purchase order placed with a supplier (migrations/0072): PO-20261021-1.
  clean.poPrefix = clean.poPrefix.toUpperCase();
  if (clean.poPrefix && !/^[A-Z0-9]+$/.test(clean.poPrefix)) throw bad("A purchase order prefix has only letters and numbers");
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('business', ?)").bind(JSON.stringify(clean)).run();
  return clean;
}

export async function getShipFromAddress(db, env) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='shipFrom'").first();
  const saved = row ? tryParse_(row.value, {}) : {};
  const out = {};
  for (const k of Object.keys(SHIP_FROM_DEFAULTS)) {
    const legacy = env && env[LEGACY_SHIP_FROM_ENV[k]] ? String(env[LEGACY_SHIP_FROM_ENV[k]]).trim() : "";
    out[k] = saved[k] || legacy || SHIP_FROM_DEFAULTS[k];
  }
  return out;
}

// `country` (Region setting): outside the US the state / region is free text, kept as typed.
export async function setShipFromAddress(db, addr, country) {
  const a = addr || {};
  const other = localeCountry_(country) === "OTHER";
  const clean = {
    name: String(a.name || "").trim().slice(0, 100),
    street1: String(a.street1 || "").trim().slice(0, 200),
    city: String(a.city || "").trim().slice(0, 100),
    state: other ? String(a.state || "").trim().slice(0, 50) : String(a.state || "").trim().toUpperCase().slice(0, 2),
    zip: String(a.zip || "").trim().slice(0, 12),
    phone: String(a.phone || "").trim().slice(0, 30),
    email: String(a.email || "").trim().slice(0, 200),
  };
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('shipFrom', ?)")
    .bind(JSON.stringify(clean)).run();
  return clean;
}

export async function getBoxPresets(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='boxPresets'").first();
  return row ? tryParse_(row.value, null) : null;
}

export async function addShippingPaidAmount(db, orderId, amount) {
  await db.prepare("UPDATE orders SET shippingPaidCents = shippingPaidCents + ? WHERE orderId = ?")
    .bind(toCents(amount), orderId).run();
}

export async function setShippingPaidAmount(db, orderId, amount) {
  await db.prepare("UPDATE orders SET shippingPaidCents = ? WHERE orderId = ?")
    .bind(Math.max(0, toCents(amount)), orderId).run();
}

export async function setBoxPresets(db, presets) {
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('boxPresets', ?)")
    .bind(JSON.stringify(presets)).run();
}

// ---- Inventory helpers -------------------------------------------------

function parseInventoryItem_(row) {
  return {
    id:            Number(row.id),
    productType:   row.productType   || "",
    vendor:        row.vendor        || "",
    brand:         row.brand         || "",
    sku:           row.sku           || "",
    color:         row.color         || "",
    size:          row.size          || "",
    purchasePrice: Number(row.purchasePrice) || 0,
    quantity:      Number(row.quantity)      || 0,
    notes:         row.notes         || "",
    createdAt:     row.createdAt     || "",
    updatedAt:     row.updatedAt     || "",
  };
}

export async function getAllInventory(db) {
  const { results } = await db.prepare(
    "SELECT * FROM inventory ORDER BY productType, brand, color, size"
  ).all();
  return results.map(parseInventoryItem_);
}

export async function createInventoryItem(db, fields) {
  const now = new Date().toISOString();
  const result = await db.prepare(
    `INSERT INTO inventory (productType, vendor, brand, sku, color, size, purchasePrice, quantity, notes, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    String(fields.productType   || "").slice(0, 80),
    String(fields.vendor        || "").slice(0, 100),
    String(fields.brand         || "").slice(0, 100),
    String(fields.sku           || "").slice(0, 100),
    String(fields.color         || "").slice(0, 80),
    String(fields.size          || "").slice(0, 40),
    Math.max(0, Number(fields.purchasePrice) || 0),
    Math.max(0, Math.floor(Number(fields.quantity) || 0)),
    String(fields.notes         || "").slice(0, 500),
    now, now
  ).run();
  return { id: Number(result.meta.last_row_id), createdAt: now, updatedAt: now };
}

export async function updateInventoryItem(db, id, fields) {
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE inventory SET productType=?, vendor=?, brand=?, sku=?, color=?, size=?, purchasePrice=?, quantity=?, notes=?, updatedAt=?
     WHERE id=?`
  ).bind(
    String(fields.productType   || "").slice(0, 80),
    String(fields.vendor        || "").slice(0, 100),
    String(fields.brand         || "").slice(0, 100),
    String(fields.sku           || "").slice(0, 100),
    String(fields.color         || "").slice(0, 80),
    String(fields.size          || "").slice(0, 40),
    Math.max(0, Number(fields.purchasePrice) || 0),
    Math.max(0, Math.floor(Number(fields.quantity) || 0)),
    String(fields.notes         || "").slice(0, 500),
    now, Number(id)
  ).run();
}

export async function deleteInventoryItem(db, id) {
  await db.prepare("DELETE FROM inventory WHERE id=?")
    .bind(Number(id)).run();
}

// ---- Payments & discounts ----------------------------------------------

// ---- Ledger vocabulary (migrations/0008) ----------------------------------
export const PAYMENT_METHODS = ["card", "venmo", "zelle", "check", "cash", "other"];
// "Card" / "Venmo" / … as chosen at checkout → ledger method.
export function methodFromPaymentMethod(paymentMethod) {
  const m = String(paymentMethod || "").trim().toLowerCase();
  return PAYMENT_METHODS.includes(m) ? m : "other";
}

// externalRef (e.g. a Stripe PaymentIntent / refund id) is UNIQUE when
// non-empty, so recording the same external movement twice is a no-op.
// opts: { method, reference, feeCents, kind: 'payment'|'refund'|'dispute',
// receivedAt }. Refunds and lost disputes are NEGATIVE amounts.
// Returns the new row id, or 0 when it was already recorded.
// The order's paid flag worked out from the ledger in ONE statement — the same rule as
// refreshPaidStatus below, orderAmounts' "owed" (items + shipping − discount, plus the sales tax when
// it's added on top, migrations/0052; test124 checks the two agree) — so it can ride in the same batch
// as the payment row it depends on. `tm` spells the order's tax mode (its column, or 'inclusive' on a
// database from before 0052). Bind: [now, orderId].
const paidRefreshSql_ = (tm) => {
  const items = "COALESCE((SELECT SUM(lineTotalCents) FROM order_items WHERE orderId = orders.orderId AND cancelDate IS NULL), 0)";
  const itemsTax = "COALESCE((SELECT SUM(taxCents) FROM order_items WHERE orderId = orders.orderId AND cancelDate IS NULL), 0)";
  const taxAdded = `(CASE WHEN ${tm} = 'exclusive' THEN MAX(0, ${itemsTax} - COALESCE(discountTaxCents, 0)) ELSE 0 END)`;
  const owed = `MAX(0, ${items} + (CASE WHEN ${items} > 0 THEN COALESCE(shippingCostCents, 0) ELSE 0 END) - COALESCE(discountCents, 0) + ${taxAdded})`;
  const received = "COALESCE((SELECT SUM(amountCents) FROM order_payments WHERE orderId = orders.orderId AND kind = 'payment' AND voidedAt IS NULL), 0)";
  return `UPDATE orders SET
    paidAt = CASE WHEN ${owed} = 0 THEN paidAt
                  WHEN ${received} >= ${owed} THEN (CASE WHEN paid = 1 THEN paidAt ELSE COALESCE((SELECT MAX(receivedAt) FROM order_payments WHERE orderId = orders.orderId AND kind = 'payment' AND voidedAt IS NULL), ?) END)
                  ELSE (CASE WHEN paid = 1 THEN NULL ELSE paidAt END) END,
    paid = CASE WHEN ${owed} = 0 THEN paid WHEN ${received} >= ${owed} THEN 1 ELSE 0 END
  WHERE orderId = ?`;
};
async function paidRefreshStmt_(db, orderId) {
  if (db.__ordersHaveTaxMode === undefined) {
    try { const { results } = await db.prepare("PRAGMA table_info(orders)").all(); db.__ordersHaveTaxMode = results.some(c => c.name === "taxMode"); }
    catch (e) { db.__ordersHaveTaxMode = false; }
  }
  return db.prepare(paidRefreshSql_(db.__ordersHaveTaxMode ? "taxMode" : "'inclusive'")).bind(new Date().toISOString(), orderId);
}

// Records one ledger row and brings the order's paid flag up to date IN THE SAME TRANSACTION (one
// batch): the row and the flag can't be left disagreeing by a failure between two writes. A repeat
// of a payment already recorded (same externalRef — a webhook retry) inserts nothing but still
// re-checks the flag, so a retry repairs an order instead of just acknowledging. Returns the new
// row's id, or 0 when it was already there.
export async function addOrderPayment(db, orderId, amount, note, externalRef = "", opts = {}) {
  const receivedAt = opts.receivedAt || new Date().toISOString();
  const method = PAYMENT_METHODS.includes(opts.method) ? opts.method : "other";
  const kind = ["payment", "refund", "dispute"].includes(opts.kind) ? opts.kind : "payment";
  // Which account the money moved through: given, or the one the method implies.
  const accountId = opts.accountId ? Number(opts.accountId) : await accountIdForMethod(db, method);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO order_payments (orderId, amountCents, note, receivedAt, externalRef, method, reference, feeCents, kind, accountId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(orderId, toCents(amount), note || "", receivedAt, externalRef || "", method,
    String(opts.reference || "").slice(0, 100), Math.max(0, Math.round(Number(opts.feeCents) || 0)), kind, accountId);
  const stmts = [insert];
  // How much of a refund was shipping (migrations/0035): set on the row just inserted, and only then.
  if (opts.shippingCents > 0) stmts.push(db.prepare("UPDATE order_payments SET shippingCents=? WHERE id = last_insert_rowid() AND changes() > 0").bind(Math.round(opts.shippingCents)));
  stmts.push(await paidRefreshStmt_(db, orderId));
  const results = await db.batch(stmts);
  const meta = (results && results[0] && results[0].meta) || {};
  return meta.changes > 0 ? Number(meta.last_row_id) : 0;
}

// Records a shipping payment AND bumps orders.shippingPaidCents atomically
// (one D1 batch = one transaction). The UPDATE applies only if the INSERT
// actually added a row — SQLite's changes() reports the rows changed by the
// previous statement on this connection — so replaying the same externalRef
// changes nothing. (Matching the new row by its receivedAt timestamp would not
// do: two deliveries in the same millisecond could share it.)
export async function addShippingPayment(db, orderId, amount, note, externalRef, feeCents = 0, receivedAt = new Date().toISOString()) {
  const amt = toCents(amount);
  await db.batch([
    db.prepare(
      "INSERT OR IGNORE INTO order_payments (orderId, amountCents, note, receivedAt, externalRef, method, feeCents, accountId) VALUES (?, ?, ?, ?, ?, 'card', ?, ?)"
    ).bind(orderId, amt, note || "", receivedAt, externalRef || "", Math.max(0, Math.round(Number(feeCents) || 0)), await accountIdForMethod(db, "card")),
    db.prepare(
      "UPDATE orders SET shippingPaidCents = shippingPaidCents + ? WHERE orderId = ? AND changes() > 0"
    ).bind(amt, orderId),
    await paidRefreshStmt_(db, orderId),   // same transaction as the payment row (see addOrderPayment)
  ]);
}

// A Stripe refund on a shipping payment also lowers orders.shippingPaidCents
// (only when that refund row was newly recorded — callers pass its id).
export async function reduceShippingPaidForRefund(db, orderId, paymentIntentId, refundCents) {
  const ship = await db.prepare("SELECT 1 AS x FROM order_payments WHERE orderId = ? AND externalRef = ? AND note LIKE 'Shipping%'")
    .bind(orderId, paymentIntentId || "").first();
  if (!ship) return false;
  await db.prepare("UPDATE orders SET shippingPaidCents = MAX(0, shippingPaidCents - ?) WHERE orderId = ?")
    .bind(Math.max(0, Math.round(Number(refundCents) || 0)), orderId).run();
  return true;
}

// ---- Stripe webhook idempotency ----------------------------------------

export async function hasProcessedStripeEvent(db, eventId) {
  const row = await db.prepare("SELECT 1 AS x FROM stripe_events WHERE eventId=?").bind(eventId).first();
  return !!row;
}

export async function recordStripeEvent(db, eventId, type, orderId) {
  await db.prepare(
    "INSERT OR IGNORE INTO stripe_events (eventId, type, orderId, processedAt) VALUES (?, ?, ?, ?)"
  ).bind(eventId, type || "", orderId || null, new Date().toISOString()).run();
}

export async function getOrderPaymentById(db, id) {
  const row = await db.prepare("SELECT id, orderId, amountCents, note, receivedAt, externalRef, method, reference, feeCents, kind, voidedAt, voidReason, accountId FROM order_payments WHERE id=?")
    .bind(Number(id)).first();
  return row ? { ...parsePayment_(row), externalRef: row.externalRef || "" } : null;
}

export async function deleteOrderPayment(db, id) {
  const row = await db.prepare("SELECT orderId FROM order_payments WHERE id=?").bind(Number(id)).first();
  await db.prepare("DELETE FROM order_payments WHERE id=?").bind(Number(id)).run();
  if (row) await refreshPaidStatus(db, row.orderId);
}

export async function setOrderDiscount(db, orderId, amount, note) {
  // A discount also reduces the tax collected (backed out of it, or not added, per the order's mode).
  const discountCents = Math.max(0, toCents(amount));
  await db.prepare("UPDATE orders SET discountCents=?, discountNote=? WHERE orderId=?").bind(discountCents, note || "", orderId).run();
  await recomputeOrderTax_(db, orderId);
  await refreshPaidStatus(db, orderId);
}

// Recomputes the cached orders.paid / paidAt from the payments ledger.
// Only kind='payment' rows count toward "paid": a later refund or lost
// dispute is money going back out, recorded separately (parseOrder_'s
// refundedAmount / netReceived) — it doesn't turn a settled order into one
// with a balance due.
// Paid = money received covers the effective total (active items, plus
// shipping when any item is active, minus discount). An order that owes $0
// keeps whatever the admin set, since there's nothing for the ledger to show.
// paidAt is the time the ledger first covered the total (the latest payment
// at that moment); it's cleared if the order stops being covered.
export async function refreshPaidStatus(db, orderId) {
  const row = await withTaxMode_((tm) => db.prepare(`
    SELECT o.paid, o.paidAt, ${ORDER_AMOUNT_COLS_.replace("o.taxMode", tm + " AS taxMode")},
      COALESCE((SELECT SUM(amountCents) FROM order_payments WHERE orderId = o.orderId AND kind = 'payment' AND voidedAt IS NULL), 0) AS receivedCents,
      (SELECT MAX(receivedAt) FROM order_payments WHERE orderId = o.orderId AND kind = 'payment' AND voidedAt IS NULL) AS lastPaymentAt
    FROM orders o WHERE o.orderId = ?`).bind(orderId).first());
  if (!row) return null;
  const owed = orderAmountsOfRow_(row).owedCents;
  const received = Number(row.receivedCents) || 0;
  if (owed === 0) return { paid: !!row.paid, owedCents: 0, receivedCents: received };
  const paid = received >= owed ? 1 : 0;
  if (paid !== Number(row.paid)) {
    await db.prepare("UPDATE orders SET paid = ?, paidAt = ? WHERE orderId = ?")
      .bind(paid, paid ? (row.lastPaymentAt || new Date().toISOString()) : null, orderId).run();
  }
  return { paid: !!paid, owedCents: owed, receivedCents: received };
}

// "Mark as paid": records a ledger payment for whatever is still owed (so the
// books show money received, not just a flag), then refreshes the paid cache.
// For an order that owes $0 it just sets the flag. Returns the amount recorded.
export async function settleOrderBalance(db, orderId, note) {
  const state = await refreshPaidStatus(db, orderId);
  if (!state) return 0;
  const balance = state.owedCents - state.receivedCents;
  if (balance > 0) {
    const o = await db.prepare("SELECT paymentMethod FROM orders WHERE orderId=?").bind(orderId).first();
    await addOrderPayment(db, orderId, fromCents(balance), note || "Marked paid", "",
      { method: methodFromPaymentMethod(o && o.paymentMethod) });
    return fromCents(balance);
  }
  if (state.owedCents === 0) {
    await db.prepare("UPDATE orders SET paid = 1, paidAt = COALESCE(paidAt, ?) WHERE orderId = ?")
      .bind(new Date().toISOString(), orderId).run();
  }
  return 0;
}

// ---- Blanks (global blank catalog with per-size stock) -----------------

// A blank's stock is keyed by (blankId, color, size) since migrations/0037. A blank carries a
// `colors[]` dimension — each color { color, images[], sortOrder, sizes[] } — built from the
// blank_colors catalog (authoritative order + images) merged with the color-keyed blank_sizes.
// `sizes` (flat, each carrying its color) and the legacy scalar `color` are kept for transitional
// readers (the Run queue / blankName_ still read blanks.color as a display fallback).
// A blank color image, as either the legacy bare URL string or the new {url, locationId} object
// (migrations/0041 — tagging an image with a garment location). Always returns {url, locationId},
// so every reader gets one shape without a data migration. Drops entries with no url.
function normBlankImage_(x) {
  if (x && typeof x === "object") {
    const url = String(x.url || "").slice(0, 500);
    if (!url) return null;
    const locationId = x.locationId == null || x.locationId === "" ? null : (Number(x.locationId) || null);
    return { url, locationId };
  }
  const url = String(x || "").slice(0, 500);
  return url ? { url, locationId: null } : null;
}

function parseBlank_(row, sizeRows, colorRows, needleTypeNames) {
  const needleTypeId = row.needleTypeId == null ? null : Number(row.needleTypeId);
  const sizes = (sizeRows || []).map(s => ({
    id: Number(s.id), color: s.color || "", size: s.size || "",
    purchasePrice: fromCents(s.purchasePriceCents), quantity: Number(s.quantity) || 0,
    // The vendor's price, entered by hand (migrations/0062) — null = not entered. purchasePrice above
    // is the average cost of what's on hand.
    vendorPrice: s.vendorPriceCents == null ? null : fromCents(s.vendorPriceCents), vendorPriceAt: s.vendorPriceAt || "",
    mapPrice: s.mapPriceCents == null ? null : fromCents(s.mapPriceCents),   // migrations/0070 — minimum advertised price
    reorderPoint: s.reorderPoint == null ? null : Number(s.reorderPoint),     // migrations/0074 — keep at least N free
    weightOz: s.weightOz == null ? null : Number(s.weightOz),                 // migrations/0077 — one piece, ounces
  }));
  const byColor = new Map();
  for (const c of (colorRows || [])) byColor.set(c.color || "", { color: c.color || "", images: (tryParse_(c.imagesJson, []) || []).map(normBlankImage_).filter(Boolean), sortOrder: Number(c.sortOrder) || 0, sizes: [] });
  for (const s of sizes) { if (!byColor.has(s.color)) byColor.set(s.color, { color: s.color, images: [], sortOrder: 0, sizes: [] }); byColor.get(s.color).sizes.push(s); }
  const colors = [...byColor.values()].sort((a, b) => (a.sortOrder - b.sortOrder) || a.color.localeCompare(b.color));
  return {
    id:          Number(row.id),
    name:        row.name        || "",
    productType: row.productType || "",
    vendor:      row.vendor      || "",
    brand:       row.brand       || "",
    sku:         row.sku         || "",
    color:       row.color       || "",
    notes:       row.notes       || "",
    // The needle TYPE this garment wants (migrations/0044) — Run Order pairs it with the size
    // that follows the thread weight. null / "" = not set.
    needleTypeId,
    needleType:  (needleTypeId != null && needleTypeNames && needleTypeNames[needleTypeId]) || "",
    // Bought for testing / shop use (migrations/0060) — still inventory, reported as its own group.
    forTesting:  !!Number(row.forTesting),
    pricesCheckedAt: row.pricesCheckedAt || "",   // migrations/0062 — the 30-day vendor-price reminder
    // migrations/0063 — content from its vendor.
    description: row.description || "",
    features:    tryParse_(row.featuresJson, []) || [],
    source:      tryParse_(row.sourceJson, {}) || {},
    vendorConnectionId: row.vendorConnectionId == null ? null : Number(row.vendorConnectionId),   // migrations/0065
    createdAt:   row.createdAt   || "",
    updatedAt:   row.updatedAt   || "",
    colors,
    sizes,
  };
}

// Normalizes the two accepted shapes into [{color, images[], sizes:[{size,purchasePrice,quantity}]}]:
// the new multi-color form (fields.colors), or the legacy single-color form (fields.color + a sizes
// array), so older callers/tests that pass createBlank(db, {color}, sizes) keep working.
function normalizeBlankColors_(fields, sizesArg) {
  if (Array.isArray(fields.colors)) {
    return fields.colors.map(c => ({
      color: String(c.color || "").slice(0, 80),
      images: Array.isArray(c.images) ? c.images.slice(0, 20).map(normBlankImage_).filter(Boolean) : [],
      sizes: Array.isArray(c.sizes) ? c.sizes : [],
    }));
  }
  return [{ color: String(fields.color || "").slice(0, 80),
            images: Array.isArray(fields.images) ? fields.images.slice(0, 20).map(normBlankImage_).filter(Boolean) : [],
            sizes: Array.isArray(sizesArg) ? sizesArg : (Array.isArray(fields.sizes) ? fields.sizes : []) }];
}

// Blanks → Find duplicate photos: take the photos the admin ticked off a blank's colors. `removals` =
// [{color, items: [{index, url}]}] — by POSITION, and only when the photo there still has that address (the same
// address can be on a color twice, and the first copy must stay). Everything else on the color stays in order. The
// files stay in the image store (Tools → Orphaned images clears them). Returns {removed, colors}.
export async function removeBlankColorImages(db, blankId, removals) {
  const id = Number(blankId);
  let removed = 0, colors = 0;
  const now = new Date().toISOString();
  for (const r of Array.isArray(removals) ? removals : []) {
    const items = (Array.isArray(r && r.items) ? r.items : []).filter(x => x && Number.isInteger(Number(x.index)));
    if (!items.length) continue;
    const row = await db.prepare("SELECT id, imagesJson FROM blank_colors WHERE blankId = ? AND color = ?").bind(id, String(r.color || "")).first();
    if (!row) continue;
    const list = tryParse_(row.imagesJson, []) || [];
    const urlOf = (im) => String(typeof im === "object" && im ? im.url : im);
    const drop = new Set(items.filter(x => list[Number(x.index)] !== undefined && urlOf(list[Number(x.index)]) === String(x.url)).map(x => Number(x.index)));
    if (!drop.size || drop.size >= list.length) continue;   // never empties a color
    const keep = list.filter((im, i) => !drop.has(i));
    await db.prepare("UPDATE blank_colors SET imagesJson = ?, updatedAt = ? WHERE id = ?").bind(JSON.stringify(keep), now, row.id).run();
    removed += drop.size; colors++;
  }
  return { removed, colors };
}

export async function getAllBlanks(db) {
  const { results: blankRows } = await db.prepare(
    "SELECT * FROM blanks ORDER BY productType, brand, name, color"
  ).all();
  if (!blankRows.length) return [];
  const [{ results: sizeRows }, { results: colorRows }, needleTypes] = await Promise.all([
    db.prepare("SELECT * FROM blank_sizes ORDER BY blankId, color, size").all(),
    db.prepare("SELECT * FROM blank_colors ORDER BY blankId, sortOrder, color").all().catch(() => ({ results: [] })),
    listNeedleTypes(db),
  ]);
  const needleTypeNames = {};
  for (const t of needleTypes) needleTypeNames[t.id] = t.name;
  const sizesByBlank = {}, colorsByBlank = {};
  for (const s of sizeRows) (sizesByBlank[s.blankId] = sizesByBlank[s.blankId] || []).push(s);
  for (const c of colorRows) (colorsByBlank[c.blankId] = colorsByBlank[c.blankId] || []).push(c);
  return blankRows.map(r => parseBlank_(r, sizesByBlank[r.id] || [], colorsByBlank[r.id] || [], needleTypeNames));
}

// Upserts a blank's color catalog + color-keyed sizes, recording any starting/edited stock as
// movements so the history always sums to stock. `mode` 'create' records new stock as 'adjust'
// "Initial stock"; 'update' diffs new−old per (color,size) and records the delta.
// Replaces a blank's colors and sizes with `colors`, in ONE transaction: the old rows are deleted and
// the new ones inserted — and the stock movements recorded — together or not at all. (They used to be
// separate steps, so a save that failed halfway left the blank with no sizes and no stock.)
//
// Stock and cost are only changed where the form's user changed them. The form sends, for each size
// it loaded, the numbers it was SHOWING (`baseQuantity`, `basePurchasePrice`). A size whose quantity
// box still holds the shown number keeps whatever the database has NOW — an order made or a delivery
// received while the form sat open is not overwritten — and a changed box applies the DIFFERENCE
// (shown 10, typed 12, now 7 → 9). The same for cost: an untouched box keeps the current average
// cost. A caller that doesn't send the shown numbers (an import, an older page) sets them outright,
// as before.
// Writes the blank's colors and sizes from the form. Per size: quantity (a change is an adjustment
// movement), the average cost (only when the caller changed it from what it showed — the form no longer
// does), and the VENDOR price (migrations/0062; only when sent — undefined keeps it, "" clears it), each
// change kept in blank_vendor_prices. Returns the vendor-price changes [{color, size, from, to}] (cents).
// A weight in ounces: a number 0–1000, two decimals; anything else (blank, junk) = null (not known).
function cleanWeightOz_(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.round(n * 100) / 100 : null;
}

async function writeBlankColors_(db, id, colors, mode, opts = {}) {
  const now = new Date().toISOString();
  // Old stock for diffing (update) / nothing (create).
  const { results: oldRows } = mode === "update"
    ? await db.prepare("SELECT * FROM blank_sizes WHERE blankId=?").bind(Number(id)).all()
    : { results: [] };
  const oldByKey = new Map(oldRows.map(r => [(r.color || "") + "|" + r.size, r]));
  const shown = (v) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v))) ? null : Number(v);
  const stmts = [
    db.prepare("DELETE FROM blank_colors WHERE blankId=?").bind(Number(id)),
    db.prepare("DELETE FROM blank_sizes WHERE blankId=?").bind(Number(id)),
  ];
  const movements = [], priceChanges = [];
  const seen = new Set();
  let sortOrder = 0;
  for (const c of colors) {
    const color = String(c.color || "").slice(0, 80);
    stmts.push(db.prepare("INSERT INTO blank_colors (blankId, color, imagesJson, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(Number(id), color, JSON.stringify(c.images || []), sortOrder++, now, now));
    for (const s of (c.sizes || [])) {
      const size = String(s.size || "").slice(0, 20);
      if (!size || seen.has(color + "|" + size)) continue;
      seen.add(color + "|" + size);
      const old = oldByKey.get(color + "|" + size);
      const oldQty = old ? Number(old.quantity) || 0 : 0;
      const typedQty = Math.max(0, Math.floor(Number(s.quantity) || 0));
      const baseQty = old ? shown(s.baseQuantity) : null;
      const qty = baseQty === null ? typedQty : Math.max(0, oldQty + (typedQty - Math.max(0, Math.floor(baseQty))));
      const typedCost = Math.max(0, toCents(s.purchasePrice));
      const baseCost = old ? shown(s.basePurchasePrice) : null;
      const oldVendor = old && old.vendorPriceCents != null ? Number(old.vendorPriceCents) : null;
      let vendor = oldVendor, vendorAt = old ? old.vendorPriceAt || null : null;
      if (s.vendorPrice !== undefined) {
        const v = shown(s.vendorPrice) === null ? null : Math.max(0, toCents(s.vendorPrice));
        if (v !== oldVendor) { vendor = v; vendorAt = now; priceChanges.push({ color, size, from: oldVendor, to: v }); }
      }
      // MAP (migrations/0070): kept unless sent ("" / null clears it).
      let mapCents = old && old.mapPriceCents != null ? Number(old.mapPriceCents) : null;
      if (s.mapPrice !== undefined) mapCents = shown(s.mapPrice) === null ? null : Math.max(0, toCents(s.mapPrice));
      // Reorder point (migrations/0074): kept unless sent ("" / null clears it).
      let reorderPoint = old && old.reorderPoint != null ? Number(old.reorderPoint) : null;
      if (s.reorderPoint !== undefined) reorderPoint = shown(s.reorderPoint) === null ? null : Math.min(100000, Math.max(0, Math.floor(Number(s.reorderPoint))));
      // Weight in ounces (migrations/0077): kept unless sent ("" / null clears it).
      let weightOz = old && old.weightOz != null ? Number(old.weightOz) : null;
      if (s.weightOz !== undefined) weightOz = cleanWeightOz_(s.weightOz);
      // A size that's new here starts at the cost typed, else its vendor price.
      const costCents = !old ? (typedCost || vendor || 0)
        : (baseCost !== null && typedCost === Math.max(0, toCents(baseCost))) ? Number(old.purchasePriceCents) || 0
        : (s.purchasePrice === undefined ? Number(old.purchasePriceCents) || 0 : typedCost);
      stmts.push(db.prepare("INSERT INTO blank_sizes (blankId, color, size, purchasePriceCents, quantity, vendorPriceCents, vendorPriceAt, mapPriceCents, reorderPoint, weightOz) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(Number(id), color, size, costCents, qty, vendor, vendorAt, mapCents, reorderPoint, weightOz));
      const delta = qty - oldQty;
      if (delta) movements.push({ blankId: Number(id), color, size, qtyDelta: delta, unitCostCents: costCents || (old ? old.purchasePriceCents : 0),
        kind: "adjust", note: mode === "update" ? "Edited in blank form" : "Initial stock" });
      oldByKey.delete(color + "|" + size);
    }
  }
  // Sizes present before but gone now → record the removal as an adjustment to zero.
  for (const [key, old] of oldByKey) {
    const q = Number(old.quantity) || 0;
    if (q) { const k = key.indexOf("|"); movements.push({ blankId: Number(id), color: key.slice(0, k), size: key.slice(k + 1), qtyDelta: -q, unitCostCents: old.purchasePriceCents, kind: "adjust", note: "Edited in blank form" }); }
  }
  if (movements.length) { const blankName = await blankName_(db, Number(id)); for (const m of movements) stmts.push(movementStmt_(db, { ...m, blankName })); }
  for (const c of priceChanges) stmts.push(vendorPriceStmt_(db, Number(id), c, now, opts.actor, opts.note || (mode === "update" ? "Blank form" : "New blank")));
  if (priceChanges.length) stmts.push(db.prepare("UPDATE blanks SET pricesCheckedAt=? WHERE id=?").bind(now, Number(id)));
  await db.batch(stmts);
  return priceChanges;
}

// ---- Vendor prices (migrations/0062) ------------------------------------------------------------
// The vendor's price per blank + color + size, entered by hand — separate from the average cost of
// what's on hand (blank_sizes.purchasePriceCents), which is what cost of goods uses. Every entry is a
// blank_vendor_prices row. Products are priced from these assumptions: a linked size whose vendor
// price changed since the product's prices were set flags the product (getProductPriceChanges).
const VENDOR_PRICE_STALE_DAYS = 30;

function vendorPriceStmt_(db, blankId, c, at, actor, note) {
  return db.prepare("INSERT INTO blank_vendor_prices (blankId, color, size, priceCents, previousCents, enteredAt, actor, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(Number(blankId), String(c.color || ""), String(c.size || ""), c.to == null ? null : Number(c.to), c.from == null ? null : Number(c.from),
      at, String(actor || "").slice(0, 120), String(note || "").slice(0, 200));
}

// "The prices are current" — the vendor's prices were checked and nothing changed.
export async function markBlankPricesChecked(db, blankId) {
  const now = new Date().toISOString();
  const r = await db.prepare("UPDATE blanks SET pricesCheckedAt=? WHERE id=?").bind(now, Number(blankId)).run();
  return Number(r && r.meta && r.meta.changes) ? now : "";
}

export async function getBlankVendorPriceHistory(db, blankId) {
  const { results } = await db.prepare("SELECT * FROM blank_vendor_prices WHERE blankId=? ORDER BY enteredAt DESC, id DESC LIMIT 500").bind(Number(blankId)).all();
  return results.map(r => ({ id: Number(r.id), color: r.color || "", size: r.size || "",
    price: r.priceCents == null ? null : fromCents(r.priceCents), previous: r.previousCents == null ? null : fromCents(r.previousCents),
    enteredAt: r.enteredAt, actor: r.actor || "", note: r.note || "" }));
}

// Products whose prices were set on different blank prices: per linked blank size, the vendor price in
// effect when the product's prices were last set or confirmed (pricesReviewedAt, else when it was
// created) — or, if none was entered yet, the first one entered after — against today's. A size with
// no vendor price at all has nothing to compare. Returns [{orgId, productId, name, visible,
// reviewedAt, changes: [{blankId, blankName, color, size, from, to, changedAt}]}] (dollars).
export async function getProductPriceChanges(db, { orgId = null, visibleOnly = false } = {}) {
  const where = [orgId ? "p.orgId = ?" : "", visibleOnly ? "p.visible = 1" : ""].filter(Boolean).join(" AND ");
  let rows;
  try {
    rows = (await db.prepare(`SELECT DISTINCT p.orgId, p.productId, p.name, p.visible, COALESCE(p.pricesReviewedAt, p.createdAt) AS reviewedAt,
        l.blankId, l.blankColor, l.blankSize, l.productColor, b.name AS blankName, bs.vendorPriceCents AS nowCents
      FROM products p
      JOIN product_blank_links l ON l.orgId = p.orgId AND l.productId = p.productId
      JOIN blanks b ON b.id = l.blankId
      JOIN blank_sizes bs ON bs.blankId = l.blankId AND bs.color = l.blankColor AND bs.size = l.blankSize
      WHERE bs.vendorPriceAt IS NOT NULL${where ? " AND " + where : ""}`).bind(...(orgId ? [orgId] : [])).all()).results;
  } catch (e) { if (/no such (table|column)/i.test(String(e && e.message))) return []; throw e; }
  if (!rows.length) return [];
  const blankIds = [...new Set(rows.map(r => Number(r.blankId)))];
  const hist = {};
  for (let i = 0; i < blankIds.length; i += 50) {
    const ids = blankIds.slice(i, i + 50);
    const { results } = await db.prepare(`SELECT blankId, color, size, priceCents, enteredAt FROM blank_vendor_prices WHERE blankId IN (${ids.map(() => "?").join(",")}) ORDER BY enteredAt, id`).bind(...ids).all();
    for (const h of results) (hist[h.blankId + "|" + (h.color || "") + "|" + (h.size || "")] = hist[h.blankId + "|" + (h.color || "") + "|" + (h.size || "")] || []).push(h);
  }
  const out = new Map();
  for (const r of rows) {
    const list = hist[r.blankId + "|" + (r.blankColor || "") + "|" + (r.blankSize || "")] || [];
    if (!list.length) continue;
    const before = list.filter(h => h.enteredAt <= r.reviewedAt);
    const basis = before.length ? before[before.length - 1] : list[0];
    const nowCents = r.nowCents == null ? null : Number(r.nowCents);
    const basisCents = basis.priceCents == null ? null : Number(basis.priceCents);
    if (basisCents === nowCents || nowCents == null) continue;
    const last = list[list.length - 1];
    const key = r.orgId + "|" + r.productId;
    if (!out.has(key)) out.set(key, { orgId: r.orgId, productId: r.productId, name: r.name, visible: !!Number(r.visible), reviewedAt: r.reviewedAt, changes: [] });
    if (out.get(key).changes.some(x => x.blankId === Number(r.blankId) && x.color === (r.blankColor || "") && x.size === (r.blankSize || ""))) continue;
    out.get(key).changes.push({ blankId: Number(r.blankId), blankName: r.blankName || "", color: r.blankColor || "", size: r.blankSize || "", productColor: r.productColor || "",
      from: basisCents == null ? null : fromCents(basisCents), to: fromCents(nowCents), changedAt: last.enteredAt });
  }
  return [...out.values()];
}

// Price rule → Apply these prices (Brand rules → Show price impact): set chosen prices of one product. Each change is
// {group ("" / "Standard" = the product's own prices, else a color price group's label), size ("" = the flat price),
// price (dollars)}. Only prices the product already has are changed (no size is added). Stamps pricesReviewedAt.
// Returns {changed: [{group, size, from, to}], problems: [text]} — nothing is written when there's a problem.
export async function applyProductPrices(db, orgId, productId, changes) {
  const row = await db.prepare("SELECT * FROM products WHERE orgId=? AND productId=?").bind(orgId, productId).first();
  if (!row) return { changed: [], problems: [`${productId}: no such product`] };
  const flat = row.pricingMode === "flat";
  let sizes = tryParse_(row.sizePricingCents, {}) || {}, flatC = row.flatPriceCents == null ? null : Number(row.flatPriceCents);
  const groups = tryParse_(row.colorGroupsJson, []) || [];
  const changed = [], problems = [];
  for (const c of Array.isArray(changes) ? changes : []) {
    const price = Number(c && c.price), size = String((c && c.size) || ""), label = String((c && c.group) || "");
    const where = `${row.name || productId}${label ? " " + label : ""}${size ? " " + size : ""}`;
    if (!Number.isFinite(price) || price < 0 || price > 10000) { problems.push(`${where}: not a price`); continue; }
    const cents = toCents(price);
    const g = label && label !== "Standard" ? groups.find(x => x.label === label) : null;
    if (label && label !== "Standard" && !g) { problems.push(`${where}: no such color price group`); continue; }
    const target = g || null;
    if (flat || !size) {
      if (!flat || size) { problems.push(`${where}: the product isn't priced that way any more`); continue; }
      const from = target ? target.flatPriceCents : flatC;
      if (from === cents) continue;
      if (target) target.flatPriceCents = cents; else flatC = cents;
      changed.push({ group: label, size: "", from: from == null ? null : fromCents(from), to: price });
    } else {
      const map = target ? (target.sizePricingCents = target.sizePricingCents || {}) : sizes;
      if (map[size] == null) { problems.push(`${where}: the product doesn't sell that size`); continue; }
      if (Number(map[size]) === cents) continue;
      changed.push({ group: label, size, from: fromCents(Number(map[size])), to: price });
      map[size] = cents;
    }
  }
  if (problems.length || !changed.length) return { changed: problems.length ? [] : changed, problems };
  const now = new Date().toISOString();
  await db.prepare("UPDATE products SET sizePricingCents=?, flatPriceCents=?, colorGroupsJson=?, pricesReviewedAt=?, updatedAt=? WHERE orgId=? AND productId=?")
    .bind(JSON.stringify(sizes), flatC, JSON.stringify(groups), now, now, orgId, productId).run();
  return { changed, problems };
}

// The product's prices are still right for its blanks' current vendor prices.
export async function confirmProductPrices(db, orgId, productId) {
  const now = new Date().toISOString();
  const r = await db.prepare("UPDATE products SET pricesReviewedAt=? WHERE orgId=? AND productId=?").bind(now, orgId, productId).run();
  return Number(r && r.meta && r.meta.changes) ? now : "";
}

// Blanks for sale (not for testing) used by a visible product whose vendor prices haven't been checked
// in 30 days (or ever) — what the roll-up's 30-day reminder lists. [{id, name, vendor, checkedAt,
// sizesWithPrice, sizes, products: [{orgId, productId, name}]}]
export async function getBlanksNeedingPriceCheck(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - VENDOR_PRICE_STALE_DAYS * 86400000).toISOString();
  let rows;
  try {
    rows = (await db.prepare(`SELECT DISTINCT b.id, b.name, b.vendor, b.pricesCheckedAt, p.orgId, p.productId, p.name AS productName
      FROM blanks b
      JOIN product_blank_links l ON l.blankId = b.id
      JOIN products p ON p.orgId = l.orgId AND p.productId = l.productId AND p.visible = 1
      WHERE b.forTesting = 0 AND (b.pricesCheckedAt IS NULL OR b.pricesCheckedAt < ?)
      ORDER BY b.name, p.orgId, p.name`).bind(cutoff).all()).results;
  } catch (e) { if (/no such (table|column)/i.test(String(e && e.message))) return []; throw e; }
  const byBlank = new Map();
  for (const r of rows) {
    if (!byBlank.has(r.id)) byBlank.set(r.id, { id: Number(r.id), name: r.name || "", vendor: r.vendor || "", checkedAt: r.pricesCheckedAt || "", products: [] });
    byBlank.get(r.id).products.push({ orgId: r.orgId, productId: r.productId, name: r.productName || r.productId });
  }
  const list = [...byBlank.values()];
  for (let i = 0; i < list.length; i += 50) {
    const ids = list.slice(i, i + 50).map(b => b.id);
    const { results } = await db.prepare(`SELECT blankId, count(*) n, sum(vendorPriceCents IS NOT NULL) priced FROM blank_sizes WHERE blankId IN (${ids.map(() => "?").join(",")}) GROUP BY blankId`).bind(...ids).all();
    for (const r of results) { const b = byBlank.get(Number(r.blankId)); if (b) { b.sizes = Number(r.n) || 0; b.sizesWithPrice = Number(r.priced) || 0; } }
  }
  return list.map(b => ({ sizes: 0, sizesWithPrice: 0, ...b }));
}

// Which products use each blank (through product_blank_links), for the Blanks screen: { blankId: [{orgId,
// orgName, productId, name, visible, sizes: [product sizes linked]}] }, visible products first. A blank
// missing from the map isn't linked to any product.
export async function getBlankProductUses(db) {
  const { results } = await db.prepare(`SELECT l.blankId, l.orgId, o.name AS orgName, p.productId, p.name, p.visible, l.productSize
    FROM product_blank_links l
    JOIN products p ON p.orgId = l.orgId AND p.productId = l.productId
    LEFT JOIN orgs o ON o.orgId = l.orgId
    ORDER BY p.visible DESC, o.name, p.name, l.productSize`).all();
  const out = {};
  for (const r of results) {
    const list = (out[r.blankId] = out[r.blankId] || []);
    let p = list.find(x => x.orgId === r.orgId && x.productId === r.productId);
    if (!p) list.push(p = { orgId: r.orgId, orgName: r.orgName || r.orgId, productId: r.productId, name: r.name || r.productId, visible: !!Number(r.visible), sizes: [] });
    if (r.productSize && !p.sizes.includes(r.productSize)) p.sizes.push(r.productSize);
  }
  return out;
}

// The 30-day vendor-price reminder in the daily roll-up: due once 30 days have passed since it was last
// sent (or it never was). global_settings key "blankPriceReminder" = {"sentAt": ISO}.
export async function getBlankPriceReminder(db, now = new Date()) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='blankPriceReminder'").first().catch(() => null);
  const state = (row && tryParse_(row.value, null)) || {};
  const lastSentAt = state.sentAt || "";
  const due = !lastSentAt || (now.getTime() - Date.parse(lastSentAt)) >= VENDOR_PRICE_STALE_DAYS * 86400000;
  const nextDueAt = lastSentAt ? new Date(Date.parse(lastSentAt) + VENDOR_PRICE_STALE_DAYS * 86400000).toISOString() : "";
  const [blanks, products] = await Promise.all([getBlanksNeedingPriceCheck(db, now), getProductPriceChanges(db, { visibleOnly: true })]);
  return { due, lastSentAt, nextDueAt, blanks, products };
}

// ---- Vendor blanks (2026-10): onboard complete blanks and per-color prices from a vendor ----------------
// Every source — a vendor's product file read in the browser, a long-format CSV, later the PromoStandards
// web services — becomes the same vendor PRODUCT: {vendor, style, name, brand, description, features[],
// category, sourceUrl, colors: [{color, hex, images: [{url, type, fileName}]}], sizes[], prices: {color:
// {size: dollars}}} ("*" = every color). planVendorBlanks says what it would do to each blank (matched on
// vendor + style, strictly); applyVendorBlanks does only what was ticked. Name, brand, category, stock and the
// average cost of an existing blank are never changed.
const vendorColorKey_ = (c) => String(c || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const vendorSizeKey_ = (z) => String(z || "").trim().toUpperCase();
const IMAGE_TYPES_ = ["front", "back", "side", "swatch", "flat", "flatback", "model", "modelback", "other"];

export function cleanVendorProduct_(p) {
  if (!p || typeof p !== "object") return null;
  const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const style = str(p.style, 100);
  if (!style) return null;
  const http = (u) => /^https?:\/\/[^\s"'<>`\\]+$/i.test(String(u || "").trim()) ? String(u).trim().slice(0, 1000) : "";
  const colors = [], seen = new Set();
  for (const c of (Array.isArray(p.colors) ? p.colors : []).slice(0, 300)) {
    const color = str(c && c.color, 80), k = vendorColorKey_(color);
    if (!color || seen.has(k)) continue;
    seen.add(k);
    const hex = /^#?[0-9a-f]{6}$/i.test(String(c.hex || "")) ? "#" + String(c.hex).replace("#", "").toLowerCase() : "";
    const images = (Array.isArray(c.images) ? c.images : []).slice(0, 20).map(im => ({
      url: http(im && im.url), type: IMAGE_TYPES_.includes(String(im && im.type || "").toLowerCase()) ? String(im.type).toLowerCase() : "other",
      fileName: str(im && im.fileName, 200) || String(http(im && im.url)).split(/[?#]/)[0].split("/").pop().slice(0, 200),
    })).filter(im => im.url || im.fileName);
    colors.push({ color, hex, images });
  }
  const prices = {};
  for (const [c, m] of Object.entries(p.prices && typeof p.prices === "object" ? p.prices : {}).slice(0, 301)) {
    const ck = c === "*" ? "*" : vendorColorKey_(c);
    if (!ck) continue;
    for (const [z, v] of Object.entries(m && typeof m === "object" ? m : {}).slice(0, 60)) {
      const n = Number(v);
      if (!vendorSizeKey_(z) || !Number.isFinite(n) || n < 0 || n > 100000) continue;
      (prices[ck] = prices[ck] || {})[vendorSizeKey_(z)] = Math.round(n * 100);
    }
  }
  const sizes = [...new Set([...(Array.isArray(p.sizes) ? p.sizes : []).map(vendorSizeKey_), ...Object.values(prices).flatMap(m => Object.keys(m))].filter(Boolean))].slice(0, 60);
  // MAP (migrations/0070), same shape as prices; null = the file says "no MAP" for that size (S&S's 0.01). `maps` is
  // undefined when the source has no MAP column at all (PromoStandards, a CSV without one) — then MAP is left alone.
  let maps;
  if (p.maps && typeof p.maps === "object") {
    maps = {};
    for (const [c, m] of Object.entries(p.maps).slice(0, 301)) {
      const ck = c === "*" ? "*" : vendorColorKey_(c);
      if (!ck) continue;
      for (const [z, v] of Object.entries(m && typeof m === "object" ? m : {}).slice(0, 60)) {
        if (!vendorSizeKey_(z)) continue;
        const n = Number(v);
        (maps[ck] = maps[ck] || {})[vendorSizeKey_(z)] = v != null && v !== "" && Number.isFinite(n) && n > 0.01 && n <= 100000 ? Math.round(n * 100) : null;
      }
    }
  }
  // Weight per piece in OUNCES (migrations/0077), same shape as prices; undefined when the source has none.
  let weights;
  if (p.weights && typeof p.weights === "object") {
    weights = {};
    for (const [c, m] of Object.entries(p.weights).slice(0, 301)) {
      const ck = c === "*" ? "*" : vendorColorKey_(c);
      if (!ck) continue;
      for (const [z, v] of Object.entries(m && typeof m === "object" ? m : {}).slice(0, 60)) {
        const w = cleanWeightOz_(v);
        if (vendorSizeKey_(z) && w != null && w > 0) (weights[ck] = weights[ck] || {})[vendorSizeKey_(z)] = w;
      }
    }
    if (!Object.keys(weights).length) weights = undefined;
  }
  return { vendor: str(p.vendor, 100), style, name: str(p.name, 200), brand: str(p.brand, 100), description: str(p.description, 4000),
    features: cleanFeatures_(p.features), category: str(p.category, 100), sourceUrl: http(p.sourceUrl), colors, sizes, prices, maps, weights };
}

// The key a vendor product goes by in a plan and its selections: vendor | style | brand (S&S reuses style
// numbers across brands).
const vendorKey_ = (vp) => vp.vendor + "|" + vp.style + (vp.brand ? "|" + vp.brand : "");

// Prices (cents) a vendor product gives one of its colors: its own, else the "every color" row.
const vendorPricesFor_ = (vp, color) => vp.prices[vendorColorKey_(color)] || vp.prices["*"] || {};
// A size's MAP from the file: cents, null (the file says none), or undefined (the file doesn't say).
const vendorMapFor_ = (vp, color, size) => { if (!vp.maps) return undefined; const m = vp.maps[vendorColorKey_(color)] || vp.maps["*"]; return m && Object.prototype.hasOwnProperty.call(m, vendorSizeKey_(size)) ? m[vendorSizeKey_(size)] : undefined; };

// A size's weight from the file, ounces, or undefined (the file doesn't say).
const vendorWeightFor_ = (vp, color, size) => { if (!vp.weights) return undefined; const m = vp.weights[vendorColorKey_(color)] || vp.weights["*"]; const w = m && m[vendorSizeKey_(size)]; return w == null ? undefined : w; };

export async function planVendorBlanks(db, products, opts = {}) {
  const list = (products || []).map(cleanVendorProduct_).filter(Boolean).slice(0, 50);
  const { results: blankRows } = await db.prepare("SELECT id, name, sku, vendor, brand, productType, description, featuresJson, sourceJson FROM blanks").all();
  const categories = await listProductCategories(db);
  const out = [];
  for (const vp of list) {
    const sameStyle = blankRows.filter(b => String(b.sku || "").trim().toLowerCase() === vp.style.toLowerCase());
    // Same vendor, and — when both say — the same brand (a blank with no brand matches any).
    const matches = (vp.vendor ? sameStyle.filter(b => sameVendor_(b.vendor, vp.vendor)) : sameStyle)
      .filter(b => !vp.brand || !b.brand || sameVendor_(b.brand, vp.brand));
    const pick = opts.blankIds && opts.blankIds[vendorKey_(vp)];
    // A blank filed under one of the vendor's ITEM numbers (an S&S invoice's size-specific item #) has no
    // style # to match on: the browser found that item # in the vendor's file and names the blank here.
    const aliasIds = opts.aliases && opts.aliases[vendorKey_(vp)] != null ? [].concat(opts.aliases[vendorKey_(vp)]).map(Number).filter(Boolean) : [];
    const aliasBlanks = matches.length ? [] : aliasIds.map(id => blankRows.find(b => Number(b.id) === id && (!vp.vendor || sameVendor_(b.vendor, vp.vendor)))).filter(Boolean);
    const alias = aliasBlanks[0] || null;
    if (alias) matches.push(alias);
    const blank = (pick && matches.find(b => b.id === Number(pick))) || matches[0] || null;
    const type = importTypeFromCategory(vp.category, categories) || (blank && blank.productType) || "";
    const plan = { key: vendorKey_(vp), vendor: vp.vendor, style: vp.style, name: vp.name || [vp.brand, vp.style].filter(Boolean).join(" "),
      brand: vp.brand, category: type, categoryFromVendor: vp.category, description: vp.description, features: vp.features, sourceUrl: vp.sourceUrl,
      action: blank ? "update" : "create", blankId: blank ? Number(blank.id) : null, blankName: blank ? blank.name || "" : "",
      aliasSku: alias && blank && Number(blank.id) === Number(alias.id) ? String(alias.sku || "") : "",
      alsoFiled: aliasBlanks.slice(1).map(b => ({ id: Number(b.id), name: b.name || "", sku: b.sku || "" })),
      candidates: matches.map(b => ({ id: Number(b.id), name: b.name || "", vendor: b.vendor || "" })),
      otherVendors: sameStyle.filter(b => !matches.includes(b)).map(b => ({ id: Number(b.id), name: b.name || "", vendor: b.vendor || "" })),
      colors: [], priceChanges: 0, newColors: 0, newSizes: 0, repricing: [], currentDescription: "", currentFeatures: [] };
    let sizeRows = [], colorRows = [], have = new Set();
    if (blank) {
      sizeRows = (await db.prepare("SELECT * FROM blank_sizes WHERE blankId=?").bind(blank.id).all()).results;
      colorRows = (await db.prepare("SELECT color, imagesJson FROM blank_colors WHERE blankId=?").bind(blank.id).all()).results;
      have = new Set(((tryParse_(blank.sourceJson, {}) || {}).images || []).map(String));
      plan.currentDescription = blank.description || "";
      plan.currentFeatures = tryParse_(blank.featuresJson, []) || [];
    }
    const blankColorOf = (c) => {
      const k = vendorColorKey_(c);
      return [...new Set([...colorRows.map(r => r.color || ""), ...sizeRows.map(r => r.color || "")])].find(x => vendorColorKey_(x) === k);
    };
    const changed = [];
    for (const c of vp.colors.length ? vp.colors : (vp.prices["*"] ? [] : [])) {
      const onBlank = blank ? blankColorOf(c.color) : undefined;
      const want = vendorPricesFor_(vp, c.color);
      const sizes = Object.keys(want).sort((a, b) => sizeRank_(a) - sizeRank_(b));
      const rows = sizes.map(z => {
        const cur = onBlank !== undefined ? sizeRows.find(r => (r.color || "") === onBlank && vendorSizeKey_(r.size) === z) : null;
        const current = cur && cur.vendorPriceCents != null ? Number(cur.vendorPriceCents) : null;
        const row = { size: cur ? cur.size : z, price: fromCents(want[z]), current: current == null ? null : fromCents(current), onBlank: !!cur,
          change: !!cur && current !== want[z] };
        // MAP from the file (migrations/0070), and what the blank has now.
        const mapNew = vendorMapFor_(vp, c.color, z);
        if (mapNew !== undefined) { row.map = mapNew == null ? null : fromCents(mapNew); row.mapCurrent = cur && cur.mapPriceCents != null ? fromCents(cur.mapPriceCents) : null; row.mapChange = !!cur && (cur.mapPriceCents == null ? null : Number(cur.mapPriceCents)) !== mapNew; }
        // Weight from the file (migrations/0077), ounces, and what the blank has now.
        const wNew = vendorWeightFor_(vp, c.color, z);
        if (wNew !== undefined) { row.weightOz = wNew; row.weightCurrent = cur && cur.weightOz != null ? Number(cur.weightOz) : null; }
        if (row.change) changed.push({ color: onBlank, size: cur.size });
        return row;
      });
      // How many photos the blank's color has now (for "Only colors with no photos yet" / "Replace").
      const colorRow = onBlank !== undefined ? colorRows.find(r => (r.color || "") === onBlank) : null;
      const imagesNow = colorRow ? ((tryParse_(colorRow.imagesJson, []) || []).length) : 0;
      const entry = { color: onBlank !== undefined ? onBlank : c.color, vendorColor: c.color, hex: c.hex, onBlank: onBlank !== undefined, imagesNow,
        images: c.images.map(im => ({ ...im, have: have.has(im.fileName) })), prices: rows, signature: sizes.map(z => z + ":" + want[z]).join(",") };
      plan.colors.push(entry);
      if (!entry.onBlank) plan.newColors++;
      plan.priceChanges += rows.filter(r => r.change).length;
      if (entry.onBlank) plan.newSizes += rows.filter(r => !r.onBlank).length;
    }
    // A long CSV row with no color ("*") prices every color already on the blank.
    if (!vp.colors.length && vp.prices["*"] && blank) {
      for (const color of [...new Set(sizeRows.map(r => r.color || ""))]) {
        const want = vp.prices["*"];
        const rows = sizeRows.filter(r => (r.color || "") === color && want[vendorSizeKey_(r.size)] != null).map(r => {
          const current = r.vendorPriceCents == null ? null : Number(r.vendorPriceCents), price = want[vendorSizeKey_(r.size)];
          if (current !== price) changed.push({ color, size: r.size });
          return { size: r.size, price: fromCents(price), current: current == null ? null : fromCents(current), onBlank: true, change: current !== price };
        });
        plan.colors.push({ color, vendorColor: color, hex: "", onBlank: true, images: [], prices: rows, signature: "" });
        plan.priceChanges += rows.filter(r => r.change).length;
      }
    }
    // Colors priced differently from most of the style: any size whose price isn't that size's usual price
    // (a color that just comes in fewer sizes isn't "different").
    const usual = {};
    for (const c of plan.colors) for (const z of c.prices) { const k = vendorSizeKey_(z.size); (usual[k] = usual[k] || {})[z.price] = ((usual[k] || {})[z.price] || 0) + 1; }
    const modeOf = (k) => Object.entries(usual[k] || {}).sort((a, b) => b[1] - a[1])[0];
    for (const c of plan.colors) { c.differs = c.prices.some(z => { const m = modeOf(vendorSizeKey_(z.size)); return m && Number(m[0]) !== z.price; }); delete c.signature; }
    plan.descriptionDiffers = !!vp.description && vp.description !== plan.currentDescription;
    plan.featuresDiffer = vp.features.length > 0 && JSON.stringify(vp.features) !== JSON.stringify(plan.currentFeatures);
    // Products priced on the prices that change (migrations/0062).
    if (blank && changed.length) {
      const { results } = await db.prepare(`SELECT DISTINCT p.orgId, p.productId, p.name, l.blankColor, l.blankSize FROM product_blank_links l
        JOIN products p ON p.orgId = l.orgId AND p.productId = l.productId WHERE l.blankId = ?`).bind(blank.id).all();
      const hit = new Map();
      for (const r of results) if (changed.some(c => c.color === (r.blankColor || "") && c.size === r.blankSize)) hit.set(r.orgId + "|" + r.productId, { orgId: r.orgId, productId: r.productId, name: r.name });
      plan.repricing = [...hit.values()];
    }
    out.push(plan);
  }
  return out;
}
const sizeRank_ = (z) => { const i = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "6XL", "OSFA"].indexOf(vendorSizeKey_(z)); return i < 0 ? 50 : i; };

// Does what was ticked. `selections` = [{key, blankId?, create?: {name, brand, sku, productType,
// needleTypeId}, prices: bool (existing colors' prices, default true), colors: [vendor colors to add (new
// ones)], newSizes: bool, images: [{color, url, fileName, locationId}] (already uploaded to our bucket),
// replaceImages: bool (a color that gets images has them INSTEAD of its current ones), description: bool,
// features: bool}]. Re-plans first, so only what the vendor product really has is
// written. Returns one result per selection: {key, blankId, created, pricesChanged, colorsAdded,
// sizesAdded, imagesAdded}.
export async function applyVendorBlanks(db, products, selections, opts = {}) {
  const now = new Date().toISOString(), note = String(opts.note || "Vendor import").slice(0, 200);
  const raw = (products || []).slice(0, 50);
  const byKey = new Map(raw.map(cleanVendorProduct_).filter(Boolean).map(vp => [vendorKey_(vp), vp]));
  // Products fetched through a vendor connection (fetchVendorProducts) say which one: the blank is linked to it.
  const connOf = new Map();
  for (const p of raw) { const vp = cleanVendorProduct_(p); const c = p && Number(p.connectionId); if (vp && Number.isInteger(c) && c > 0) connOf.set(vendorKey_(vp), c); }
  const blankIds = {};
  for (const sel of selections || []) if (sel && sel.blankId) blankIds[sel.key] = sel.blankId;
  const plans = await planVendorBlanks(db, raw, { blankIds, aliases: opts.aliases || {} });   // the products as sent — the plan cleans them itself
  const results = [];
  for (const sel of (selections || []).slice(0, 50)) {
    const plan = plans.find(p => p.key === sel.key), vp = byKey.get(sel.key);
    if (!plan || !vp) continue;
    const res = { key: sel.key, blankId: plan.blankId, created: false, pricesChanged: 0, colorsAdded: 0, sizesAdded: 0, imagesAdded: 0 };
    const pickColors = new Set((Array.isArray(sel.colors) ? sel.colors : []).map(vendorColorKey_));
    const imagesFor = (color) => (Array.isArray(sel.images) ? sel.images : []).filter(im => im && vendorColorKey_(im.color) === vendorColorKey_(color) && im.url)
      .slice(0, 20).map(im => ({ url: String(im.url).slice(0, 500), locationId: im.locationId == null || im.locationId === "" ? null : (Number(im.locationId) || null), fileName: String(im.fileName || "").slice(0, 200) }));
    const source = (prev) => {
      const s = prev || {};
      const files = new Set([...(s.images || []), ...(Array.isArray(sel.images) ? sel.images : []).map(im => im && String(im.fileName || "")).filter(Boolean)]);
      return JSON.stringify({ ...s, vendor: vp.vendor, style: vp.style, sourceUrl: vp.sourceUrl || s.sourceUrl || "", images: [...files].slice(0, 2000), syncedAt: now });
    };
    if (plan.action === "create") {
      const c = sel.create || {};
      const colors = plan.colors.filter(x => pickColors.has(vendorColorKey_(x.vendorColor)));
      if (!colors.length) continue;
      const fields = { name: String(c.name || plan.name).slice(0, 200), productType: String(c.productType || plan.category || "other").slice(0, 40), vendor: vp.vendor,
        brand: String(c.brand != null ? c.brand : plan.brand).slice(0, 100), sku: String(c.sku || vp.style).slice(0, 100), notes: "",
        description: vp.description, features: vp.features,
        colors: colors.map(x => ({ color: x.vendorColor, images: imagesFor(x.vendorColor).map(({ url, locationId }) => ({ url, locationId })),
          sizes: x.prices.map(z => ({ size: z.size, quantity: 0, vendorPrice: z.price, ...(z.map !== undefined ? { mapPrice: z.map == null ? "" : z.map } : {}), ...(z.weightOz !== undefined ? { weightOz: z.weightOz } : {}) })) })) };
      if (c.needleTypeId != null && c.needleTypeId !== "") fields.needleTypeId = Number(c.needleTypeId) || null;
      const made = await createBlank(db, fields, undefined, { actor: opts.actor, note });
      await db.prepare("UPDATE blanks SET sourceJson=?, vendorConnectionId=COALESCE(?, vendorConnectionId) WHERE id=?").bind(source({}), connOf.get(sel.key) || null, made.id).run();
      Object.assign(res, { blankId: made.id, created: true, colorsAdded: colors.length, sizesAdded: colors.reduce((n, x) => n + x.prices.length, 0),
        pricesChanged: made.priceChanges.length, imagesAdded: colors.reduce((n, x) => n + imagesFor(x.vendorColor).length, 0) });
      results.push(res);
      continue;
    }
    const id = plan.blankId;
    // 1. New colors and (if ticked) the sizes an existing color is missing — empty, no stock.
    const add = [];
    for (const x of plan.colors) {
      if (!x.onBlank && pickColors.has(vendorColorKey_(x.vendorColor))) { add.push(...x.prices.map(z => ({ color: x.color, size: z.size }))); res.colorsAdded++; }
      else if (x.onBlank && sel.newSizes) add.push(...x.prices.filter(z => !z.onBlank).map(z => ({ color: x.color, size: z.size })));
    }
    if (add.length) res.sizesAdded = await addBlankSizes(db, id, add);
    // 2. Vendor prices, per color and size.
    const { results: rows } = await db.prepare("SELECT color, size, vendorPriceCents, mapPriceCents, weightOz FROM blank_sizes WHERE blankId=?").bind(id).all();
    const stmts = [];
    for (const x of plan.colors) {
      const included = x.onBlank ? sel.prices !== false : pickColors.has(vendorColorKey_(x.vendorColor));
      if (!included) continue;
      for (const z of x.prices) {
        const row = rows.find(r => (r.color || "") === x.color && vendorSizeKey_(r.size) === vendorSizeKey_(z.size));
        if (!row) continue;
        // MAP rides with the vendor prices (migrations/0070): set or cleared as the file says, left alone if it says nothing.
        if (z.map !== undefined) {
          const mapTo = z.map == null ? null : toCents(z.map), mapFrom = row.mapPriceCents == null ? null : Number(row.mapPriceCents);
          if (mapTo !== mapFrom) { stmts.push(db.prepare("UPDATE blank_sizes SET mapPriceCents=? WHERE blankId=? AND color=? AND size=?").bind(mapTo, id, row.color || "", row.size)); res.mapsChanged = (res.mapsChanged || 0) + 1; }
        }
        // Weight (migrations/0077): filled from the file only where the blank has none — a weight typed in stays.
        if (z.weightOz !== undefined && row.weightOz == null) {
          stmts.push(db.prepare("UPDATE blank_sizes SET weightOz=? WHERE blankId=? AND color=? AND size=?").bind(z.weightOz, id, row.color || "", row.size)); res.weightsFilled = (res.weightsFilled || 0) + 1;
        }
        const to = toCents(z.price), from = row.vendorPriceCents == null ? null : Number(row.vendorPriceCents);
        if (from === to) continue;
        stmts.push(db.prepare("UPDATE blank_sizes SET vendorPriceCents=?, vendorPriceAt=? WHERE blankId=? AND color=? AND size=?").bind(to, now, id, row.color || "", row.size));
        stmts.push(vendorPriceStmt_(db, id, { color: row.color || "", size: row.size, from, to }, now, opts.actor, note));
        res.pricesChanged++;
      }
    }
    // 3. Images onto their colors (no duplicates).
    const { results: colorRows } = await db.prepare("SELECT color, imagesJson FROM blank_colors WHERE blankId=?").bind(id).all();
    for (const x of plan.colors) {
      const imgs = imagesFor(x.vendorColor);
      if (!imgs.length) continue;
      const row = colorRows.find(r => (r.color || "") === x.color);
      // "Replace this blank's photos": the color's photos become just the new ones; otherwise they're added.
      const current = sel.replaceImages ? [] : (tryParse_(row && row.imagesJson, []) || []).map(normBlankImage_).filter(Boolean);
      const fresh = imgs.filter((im, i, all) => !current.some(c => c.url === im.url) && all.findIndex(o => o.url === im.url) === i).map(({ url, locationId }) => ({ url, locationId }));
      if (!fresh.length) continue;
      if (sel.replaceImages && row) res.imagesReplaced = (res.imagesReplaced || 0) + (tryParse_(row.imagesJson, []) || []).length;
      stmts.push(row ? db.prepare("UPDATE blank_colors SET imagesJson=?, updatedAt=? WHERE blankId=? AND color=?").bind(JSON.stringify([...current, ...fresh].slice(0, 20)), now, id, x.color)
        : db.prepare("INSERT OR IGNORE INTO blank_colors (blankId, color, imagesJson, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, 999, ?, ?)").bind(id, x.color, JSON.stringify(fresh.slice(0, 20)), now, now));
      res.imagesAdded += fresh.length;
    }
    // 4. Content, only when ticked; where it came from; prices checked.
    const blank = await db.prepare("SELECT sourceJson FROM blanks WHERE id=?").bind(id).first();
    if (sel.description && vp.description) stmts.push(db.prepare("UPDATE blanks SET description=? WHERE id=?").bind(vp.description, id));
    // Filed under an item #: take the style # as its SKU (ticked), so the next import matches it by style.
    if (sel.setSku && plan.aliasSku) { stmts.push(db.prepare("UPDATE blanks SET sku=? WHERE id=?").bind(vp.style.slice(0, 100), id)); res.skuFrom = plan.aliasSku; res.skuTo = vp.style; }
    if (sel.features && vp.features.length) stmts.push(db.prepare("UPDATE blanks SET featuresJson=? WHERE id=?").bind(JSON.stringify(vp.features), id));
    stmts.push(db.prepare("UPDATE blanks SET sourceJson=?, pricesCheckedAt=CASE WHEN ? THEN ? ELSE pricesCheckedAt END, updatedAt=? WHERE id=?")
      .bind(source(tryParse_(blank && blank.sourceJson, {})), sel.prices !== false ? 1 : 0, now, now, id));
    // Updated through a vendor connection: linked to it if it wasn't linked to any (one linked elsewhere stays put).
    if (connOf.get(sel.key)) stmts.push(db.prepare("UPDATE blanks SET vendorConnectionId=? WHERE id=? AND vendorConnectionId IS NULL").bind(connOf.get(sel.key), id));
    await db.batch(stmts);
    results.push(res);
  }
  return results;
}

// ---- Vendor connections (migrations/0065): PromoStandards suppliers ----------------------------------------
// The id + password are encrypted (functions/_lib/vendorCredentials.js) before they reach here and never
// leave the server: parseVendorConnection_ says only whether they're set.
const parseVendorConnection_ = (r) => ({ id: Number(r.id), companyCode: r.companyCode, name: r.name,
  endpoints: tryParse_(r.endpointsJson, {}) || {}, overrides: tryParse_(r.overridesJson, {}) || {}, hasCredentials: !!r.credentialsEnc,
  status: r.status || "new", lastTestedAt: r.lastTestedAt || "", lastRefreshAt: r.lastRefreshAt || "", lastError: r.lastError || "",
  blankCount: Number(r.blankCount) || 0, createdAt: r.createdAt, updatedAt: r.updatedAt });

export async function listVendorConnections(db) {
  try {
    const { results } = await db.prepare(`SELECT c.*, (SELECT count(*) FROM blanks b WHERE b.vendorConnectionId = c.id) AS blankCount
      FROM vendor_connections c ORDER BY c.name`).all();
    return results.map(parseVendorConnection_);
  } catch (e) { if (/no such (table|column)/i.test(String(e && e.message))) return []; throw e; }
}
// The raw row (with credentialsEnc) — server use only.
export async function getVendorConnectionRow(db, id) {
  return db.prepare("SELECT * FROM vendor_connections WHERE id=?").bind(Number(id)).first();
}
// Creates or updates. credentialsEnc: undefined keeps what's stored, "" clears it.
export async function saveVendorConnection(db, c) {
  const now = new Date().toISOString();
  const endpoints = JSON.stringify(c.endpoints || {}), overrides = JSON.stringify(c.overrides || {});
  if (c.id) {
    await db.prepare(`UPDATE vendor_connections SET name=?, endpointsJson=?, overridesJson=?, credentialsEnc=COALESCE(?, credentialsEnc), status=CASE WHEN ? THEN 'new' ELSE status END, updatedAt=? WHERE id=?`)
      .bind(String(c.name).slice(0, 100), endpoints, overrides, c.credentialsEnc === undefined ? null : c.credentialsEnc, c.credentialsEnc !== undefined ? 1 : 0, now, Number(c.id)).run();
    return Number(c.id);
  }
  const r = await db.prepare(`INSERT INTO vendor_connections (companyCode, name, endpointsJson, overridesJson, credentialsEnc, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(String(c.companyCode).slice(0, 60), String(c.name).slice(0, 100), endpoints, overrides, c.credentialsEnc || "", now, now).run();
  return Number(r.meta.last_row_id);
}
export async function setVendorConnectionStatus(db, id, { ok, error = "", tested = false, refreshed = false }) {
  const now = new Date().toISOString();
  await db.prepare(`UPDATE vendor_connections SET status=?, lastError=?, lastTestedAt=CASE WHEN ? THEN ? ELSE lastTestedAt END,
    lastRefreshAt=CASE WHEN ? THEN ? ELSE lastRefreshAt END, updatedAt=? WHERE id=?`)
    .bind(ok ? "ok" : "error", String(error || "").slice(0, 500), tested ? 1 : 0, now, refreshed ? 1 : 0, now, now, Number(id)).run();
}
export async function deleteVendorConnection(db, id) {
  await db.batch([db.prepare("UPDATE blanks SET vendorConnectionId=NULL WHERE vendorConnectionId=?").bind(Number(id)),
    db.prepare("DELETE FROM vendor_connections WHERE id=?").bind(Number(id))]);
}
// Which blanks get their prices and content from this connection: exactly `blankIds` (others are unlinked).
export async function linkBlanksToVendorConnection(db, id, blankIds) {
  const ids = [...new Set((blankIds || []).map(Number).filter(Boolean))].slice(0, 2000);
  const stmts = [db.prepare("UPDATE blanks SET vendorConnectionId=NULL WHERE vendorConnectionId=?").bind(Number(id))];
  for (let i = 0; i < ids.length; i += 90) stmts.push(db.prepare(`UPDATE blanks SET vendorConnectionId=? WHERE id IN (${ids.slice(i, i + 90).map(() => "?").join(",")})`).bind(Number(id), ...ids.slice(i, i + 90)));
  await db.batch(stmts);
  return ids.length;
}

// ---- Orders placed with a supplier (migrations/0072) ----------------------------------------------------
// The blanks and sizes an order to a supplier is for: {blank: {…}, sizes: Map("color|size" → row)} per blankId.
export async function getBlanksForSupplierOrder(db, blankIds) {
  const ids = [...new Set((blankIds || []).map(Number).filter(Boolean))].slice(0, 200);
  const out = new Map();
  if (!ids.length) return out;
  const ph = ids.map(() => "?").join(",");
  const [{ results: blanks }, { results: sizes }] = await Promise.all([
    db.prepare(`SELECT * FROM blanks WHERE id IN (${ph})`).bind(...ids).all(),
    db.prepare(`SELECT * FROM blank_sizes WHERE blankId IN (${ph})`).bind(...ids).all(),
  ]);
  for (const b of blanks) out.set(Number(b.id), { blank: b, sizes: new Map() });
  for (const z of sizes) { const e = out.get(Number(z.blankId)); if (e) e.sizes.set((z.color || "") + "\u0001" + (z.size || ""), z); }
  return out;
}
// A PO number nobody has used: <prefix>-YYYYMMDD-N (≤ 28 characters, letters, digits and dashes).
export async function nextSupplierPoNumber(db, prefix = "PO", now = new Date()) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const base = `${String(prefix || "PO").replace(/[^A-Za-z0-9]/g, "").slice(0, 10) || "PO"}-${day}-`;
  const { results } = await db.prepare("SELECT poNumber FROM supplier_orders WHERE poNumber LIKE ?").bind(base + "%").all();
  let n = 1;
  for (const r of results) { const k = Number(String(r.poNumber).slice(base.length)); if (Number.isInteger(k) && k >= n) n = k + 1; }
  return base + n;
}
function parseSupplierOrder_(r) {
  if (!r) return null;
  return { id: Number(r.id), connectionId: Number(r.connectionId), vendor: r.vendor || "", environment: r.environment, poNumber: r.poNumber, status: r.status,
    transactionId: r.transactionId || "", error: r.error || "", carrier: r.carrier || "", service: r.service || "",
    shipTo: tryParse_(r.shipToJson, {}), total: fromCents(r.totalCents), lines: tryParse_(r.linesJson, []), itemIds: tryParse_(r.itemIdsJson, []),
    createdAt: r.createdAt, createdBy: r.createdBy || "", placedAt: r.placedAt || "", lastShipmentCheckAt: r.lastShipmentCheckAt || "",
    cancelledAt: r.cancelledAt || "", cancelNote: r.cancelNote || "" };
}
// Writes the row as 'sending' BEFORE the supplier is called; the UNIQUE poNumber makes a second click (or a
// second tab) fail here instead of ordering twice. Returns the new id, or null if the PO number is taken.
export async function insertSupplierOrder(db, o) {
  const now = new Date().toISOString();
  try {
    const r = await db.prepare(`INSERT INTO supplier_orders (connectionId, vendor, environment, poNumber, status, carrier, service, shipToJson, totalCents, linesJson, itemIdsJson, createdAt, createdBy)
      VALUES (?, ?, ?, ?, 'sending', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(Number(o.connectionId), String(o.vendor || "").slice(0, 100), o.environment === "test" ? "test" : "production", String(o.poNumber), String(o.carrier || ""), String(o.service || ""),
        JSON.stringify(o.shipTo || {}), Math.max(0, Math.round(Number(o.totalCents) || 0)), JSON.stringify(o.lines || []), JSON.stringify(o.itemIds || []), now, String(o.createdBy || "").slice(0, 200)).run();
    return Number(r.meta.last_row_id);
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return null;
    throw e;
  }
}
// A retry of an order whose answer never came ('unknown') or that the supplier refused ('failed'): back to
// 'sending' only if it's still in that state — so two retries can't both send.
export async function claimSupplierOrderRetry(db, id) {
  const r = await db.prepare("UPDATE supplier_orders SET status='sending', error='' WHERE id=? AND status IN ('unknown', 'failed')").bind(Number(id)).run();
  return !!(r.meta && r.meta.changes);
}
export async function setSupplierOrderResult(db, id, { status, transactionId = "", error = "" }) {
  const placed = status === "placed";
  await db.prepare("UPDATE supplier_orders SET status=?, transactionId=?, error=?, placedAt=CASE WHEN ? THEN ? ELSE placedAt END WHERE id=?")
    .bind(status, String(transactionId || "").slice(0, 200), String(error || "").slice(0, 500), placed ? 1 : 0, new Date().toISOString(), Number(id)).run();
}
export async function getSupplierOrder(db, id) {
  return parseSupplierOrder_(await db.prepare("SELECT * FROM supplier_orders WHERE id=?").bind(Number(id)).first());
}
export async function getSupplierOrderByPo(db, poNumber) {
  return parseSupplierOrder_(await db.prepare("SELECT * FROM supplier_orders WHERE poNumber=?").bind(String(poNumber || "")).first());
}
// Newest first, each with the blank shipments found for it so far (by PO number, see recordSupplierShipments).
export async function listSupplierOrders(db, { limit = 30 } = {}) {
  const { results } = await db.prepare("SELECT * FROM supplier_orders ORDER BY createdAt DESC, id DESC LIMIT ?").bind(Math.min(200, Math.max(1, Number(limit) || 30))).all();
  const orders = results.map(parseSupplierOrder_);
  if (!orders.length) return orders;
  const { results: ships } = await db.prepare(`SELECT id, carrier, trackingNumber, shippedAt, status, deliveredAt, supplierPoNumber FROM blank_shipments
    WHERE supplierPoNumber IN (${orders.map(() => "?").join(",")})`).bind(...orders.map(o => o.poNumber)).all().catch(() => ({ results: [] }));
  for (const o of orders) o.shipments = ships.filter(s => s.supplierPoNumber === o.poNumber)
    .map(s => ({ id: Number(s.id), carrier: s.carrier || "", trackingNumber: s.trackingNumber || "", shippedAt: s.shippedAt || "", status: s.status || "", deliveredAt: s.deliveredAt || "" }));
  return orders;
}
// Placed orders still worth asking the supplier about: placed in the last `days`, least recently checked first.
export async function supplierOrdersAwaitingShipment(db, { days = 30, limit = 10 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { results } = await db.prepare(`SELECT * FROM supplier_orders WHERE status='placed' AND cancelledAt IS NULL AND placedAt >= ?
    ORDER BY COALESCE(lastShipmentCheckAt, '') ASC, placedAt ASC LIMIT ?`).bind(since, Math.max(1, Number(limit) || 10)).all();
  return results.map(parseSupplierOrder_);
}
// Records the tracking numbers the supplier reported for one of its orders: each one not seen before becomes a
// blank shipment covering the order's lines (addBlankShipment — which stamps them shipped, and the daily Shippo
// check takes over from there). Returns how many were new.
export async function recordSupplierShipments(db, order, shipments) {
  let added = 0;
  for (const s of shipments || []) {
    const tn = String(s.trackingNumber || "").trim();
    if (!tn) continue;
    const seen = await db.prepare("SELECT id FROM blank_shipments WHERE trackingNumber=?").bind(tn).first();
    if (seen) continue;
    let id;
    try {
      id = await addBlankShipment(db, { carrier: s.carrier || order.carrier || "", trackingNumber: tn, vendor: order.vendor, shippedAt: s.shipDate, itemIds: order.itemIds });
    } catch (e) { continue; }   // none of its lines are still active (cancelled since): nothing to attach it to
    await db.prepare("UPDATE blank_shipments SET supplierPoNumber=? WHERE id=?").bind(order.poNumber, id).run();
    added++;
  }
  await db.prepare("UPDATE supplier_orders SET lastShipmentCheckAt=? WHERE id=?").bind(new Date().toISOString(), Number(order.id)).run();
  return added;
}
// The order was cancelled with the supplier (migrations/0073): recorded with when and why, its PO number taken off
// the order lines still carrying it that haven't shipped or arrived (they're back on Blanks to Order), and the
// shipment checks stop. Placed or no-answer orders only. Returns {order, unmarked} or {error}.
export async function cancelSupplierOrder(db, id, { note = "" } = {}) {
  const o = await getSupplierOrder(db, id);
  if (!o) return { error: "That supplier order wasn't found", code: 404 };
  if (o.cancelledAt) return { error: `Order ${o.poNumber} is already marked cancelled.`, code: 409 };
  if (!["placed", "unknown"].includes(o.status)) return { error: `Order ${o.poNumber} was never placed, so there's nothing to cancel.`, code: 409 };
  const now = new Date().toISOString();
  const r = await db.prepare("UPDATE supplier_orders SET cancelledAt=?, cancelNote=? WHERE id=? AND cancelledAt IS NULL").bind(now, String(note || "").slice(0, 300), o.id).run();
  if (!(r.meta && r.meta.changes)) return { error: `Order ${o.poNumber} is already marked cancelled.`, code: 409 };
  const ids = [...new Set((o.itemIds || []).map(Number).filter(Boolean))];
  const unmarked = [], orders = new Set();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db.prepare(`SELECT id, orderId FROM order_items WHERE id IN (${chunk.map(() => "?").join(",")})
      AND blankVendorOrderId=? AND blankShippedAt IS NULL AND blankReceivedAt IS NULL`).bind(...chunk, o.poNumber).all();
    if (!results.length) continue;
    await db.batch(results.map(x => db.prepare(`UPDATE order_items SET blankOrderedAt=NULL, blankVendor='', blankVendorOrderId='', blankEstDelivery=NULL
      WHERE id=? AND blankVendorOrderId=? AND blankShippedAt IS NULL AND blankReceivedAt IS NULL`).bind(Number(x.id), o.poNumber)));
    for (const x of results) { unmarked.push(Number(x.id)); orders.add(x.orderId); }
  }
  for (const orderId of orders) await recomputeOrderBlankStatus_(db, orderId);
  return { order: await getSupplierOrder(db, o.id), unmarked };
}

// Marks the order lines a supplier order was placed for as "blanks ordered" with its PO number. Only lines not
// yet ordered or received are touched (one already on another order keeps its vendor and number). Returns the
// line ids marked. Like the other automatic paths that record what really happened, it doesn't apply the
// stage-order check (an unpaid order's blanks can be bought on purpose with "Include unpaid orders").
export async function markItemsBlankOrdered(db, itemIds, { vendor = "", vendorOrderId = "" } = {}) {
  const ids = [...new Set((itemIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const nb = await noBlankLine_(db);
  const marked = [], orders = new Set();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db.prepare(`SELECT oi.id, oi.orderId FROM order_items oi WHERE oi.id IN (${chunk.map(() => "?").join(",")})
      AND oi.cancelDate IS NULL AND oi.blankOrderedAt IS NULL AND oi.blankReceivedAt IS NULL AND NOT ${nb("oi")}`).bind(...chunk).all();
    if (!results.length) continue;
    const now = new Date().toISOString();
    await db.batch(results.map(r => db.prepare(`UPDATE order_items SET blankOrderedAt=?, blankVendor=?, blankVendorOrderId=? WHERE id=? AND blankOrderedAt IS NULL AND blankReceivedAt IS NULL`)
      .bind(now, String(vendor).slice(0, 100), String(vendorOrderId).slice(0, 100), Number(r.id))));
    for (const r of results) { marked.push(Number(r.id)); orders.add(r.orderId); }
  }
  for (const o of orders) await recomputeOrderBlankStatus_(db, o);
  return marked;
}

export async function setBlankPriceReminderSent(db, at = new Date().toISOString()) {
  await db.prepare("INSERT INTO global_settings (key, value) VALUES ('blankPriceReminder', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify({ sentAt: at })).run();
}

export async function createBlank(db, fields, sizes, opts = {}) {
  const now = new Date().toISOString();
  const colors = normalizeBlankColors_(fields, sizes);
  const legacyColor = String((fields.color != null ? fields.color : (colors[0] && colors[0].color)) || "").slice(0, 80);
  const result = await db.prepare(
    `INSERT INTO blanks (name, productType, vendor, brand, sku, color, notes, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    String(fields.name        || "").slice(0, 200),
    String(fields.productType || "").slice(0, 40),
    String(fields.vendor      || "").slice(0, 100),
    String(fields.brand       || "").slice(0, 100),
    String(fields.sku         || "").slice(0, 100),
    legacyColor,
    String(fields.notes       || "").slice(0, 500),
    now, now
  ).run();
  const id = Number(result.meta.last_row_id);
  await setBlankNeedleType_(db, id, fields);
  await setBlankForTesting_(db, id, fields);
  await setBlankContent_(db, id, fields);
  const priceChanges = await writeBlankColors_(db, id, colors, "create", opts);
  return { id, createdAt: now, priceChanges };
}

export async function updateBlank(db, id, fields, sizes, opts = {}) {
  const now = new Date().toISOString();
  const hasColors = Array.isArray(fields.colors) || Array.isArray(sizes) || Array.isArray(fields.sizes);
  const colors = normalizeBlankColors_(fields, sizes);
  const legacyColor = String((fields.color != null ? fields.color : (colors[0] && colors[0].color)) || "").slice(0, 80);
  await db.prepare(
    `UPDATE blanks SET name=?, productType=?, vendor=?, brand=?, sku=?, color=?, notes=?, updatedAt=? WHERE id=?`
  ).bind(
    String(fields.name        || "").slice(0, 200),
    String(fields.productType || "").slice(0, 40),
    String(fields.vendor      || "").slice(0, 100),
    String(fields.brand       || "").slice(0, 100),
    String(fields.sku         || "").slice(0, 100),
    legacyColor,
    String(fields.notes       || "").slice(0, 500),
    now, Number(id)
  ).run();
  await setBlankNeedleType_(db, Number(id), fields);
  await setBlankForTesting_(db, Number(id), fields);
  await setBlankContent_(db, Number(id), fields);
  // Stock movements carry the blank's name (for History, receipts and reports): a rename renames them too.
  const name = await blankName_(db, Number(id));
  if (name) await db.prepare("UPDATE inventory_movements SET blankName=? WHERE blankId=? AND blankName <> ?").bind(name, Number(id), name).run();
  return hasColors ? await writeBlankColors_(db, Number(id), colors, "update", opts) : [];
}

// Adds colors / sizes a blank doesn't have yet, with nothing in stock and no cost — so an invoice line for
// a color or size not on file (Import from PDF → Receive order) can be received instead of left out.
// Existing colors and sizes are untouched. `list` = [{color, size}]; returns how many sizes were added.
export async function addBlankSizes(db, blankId, list) {
  const now = new Date().toISOString(), id = Number(blankId);
  const want = [];
  for (const x of (Array.isArray(list) ? list : []).slice(0, 100)) {
    const color = String(x && x.color || "").trim().slice(0, 80), size = String(x && x.size || "").trim().slice(0, 20);
    if (size && !want.some(w => w.color === color && w.size === size)) want.push({ color, size });
  }
  if (!want.length) return 0;
  const { results: colors } = await db.prepare("SELECT color, sortOrder FROM blank_colors WHERE blankId = ?").bind(id).all().catch(() => ({ results: [] }));
  let nextOrder = colors.reduce((n, c) => Math.max(n, Number(c.sortOrder) || 0), 0);
  const stmts = [];
  for (const c of [...new Set(want.map(w => w.color))]) {
    if (colors.some(x => (x.color || "") === c)) continue;
    stmts.push(db.prepare("INSERT OR IGNORE INTO blank_colors (blankId, color, imagesJson, sortOrder, createdAt, updatedAt) VALUES (?, ?, '[]', ?, ?, ?)").bind(id, c, ++nextOrder, now, now));
  }
  for (const w of want) stmts.push(db.prepare("INSERT OR IGNORE INTO blank_sizes (blankId, color, size, purchasePriceCents, quantity) VALUES (?, ?, ?, 0, 0)").bind(id, w.color, w.size));
  const res = await db.batch(stmts);
  return res.slice(-want.length).reduce((n, r) => n + (Number(r && r.meta && r.meta.changes) || 0), 0);
}


// For testing / shop use (migrations/0060). Written only when the caller sends it, like the needle type.
async function setBlankForTesting_(db, id, fields) {
  if (!fields || fields.forTesting === undefined) return;
  await db.prepare("UPDATE blanks SET forTesting=? WHERE id=?").bind(fields.forTesting ? 1 : 0, Number(id)).run()
    .catch((e) => { if (!/no such column/i.test(String(e && e.message))) throw e; });
}

// Description and bullet-point features (migrations/0063). Each written only when the caller sends it.
async function setBlankContent_(db, id, fields) {
  if (!fields) return;
  if (fields.description !== undefined) await db.prepare("UPDATE blanks SET description=? WHERE id=?").bind(String(fields.description || "").slice(0, 4000), Number(id)).run();
  if (fields.features !== undefined) await db.prepare("UPDATE blanks SET featuresJson=? WHERE id=?").bind(JSON.stringify(cleanFeatures_(fields.features)), Number(id)).run();
}
const cleanFeatures_ = (list) => (Array.isArray(list) ? list : String(list || "").split(/\n/)).map(x => String(x || "").trim().slice(0, 300)).filter(Boolean).slice(0, 30);

// The blank's needle type (migrations/0044). Written only when the caller sends the field, so a
// caller that doesn't know about it (the PDF importer, merges, older scripts) can't clear it.
async function setBlankNeedleType_(db, id, fields) {
  if (!fields || fields.needleTypeId === undefined) return;
  const v = fields.needleTypeId == null || fields.needleTypeId === "" ? null : (Number(fields.needleTypeId) || null);
  await db.prepare("UPDATE blanks SET needleTypeId=? WHERE id=?").bind(v, Number(id)).run();
}

export async function deleteBlank(db, id) {
  await db.batch([
    db.prepare("DELETE FROM product_blank_links WHERE blankId=?").bind(Number(id)),
    db.prepare("DELETE FROM blank_sizes WHERE blankId=?").bind(Number(id)),
    db.prepare("DELETE FROM blank_colors WHERE blankId=?").bind(Number(id)),
    db.prepare("DELETE FROM blanks WHERE id=?").bind(Number(id)),
  ]);
}

// Folds several single-color (or multi-color) blanks into one (migrations/0037): separate
// "one blank per color" rows become the colors of a single style. Each source's movement history is
// re-pointed to the target (keeping color + size), its color catalog + links move over, and the
// target's stock/cost is recomputed from the combined history per (color, size) — so costs stay
// correct even when a color name appears on both. Sources are then deleted. Audited by the caller.
export async function mergeBlanks(db, { targetId, sourceIds }) {
  const target = Number(targetId);
  const sources = [...new Set((sourceIds || []).map(Number))].filter(id => id && id !== target);
  if (!target || !sources.length) return { merged: 0, targetId: target };
  const tname = await blankName_(db, target);
  for (const src of sources) {
    await db.prepare("UPDATE inventory_movements SET blankId=?, blankName=? WHERE blankId=?").bind(target, tname, src).run();
    await db.prepare("UPDATE blank_vendor_prices SET blankId=? WHERE blankId=?").bind(target, src).run().catch(() => {});
    const { results: tColors } = await db.prepare("SELECT color FROM blank_colors WHERE blankId=?").bind(target).all();
    const have = new Set(tColors.map(r => r.color || ""));
    let order = have.size;
    const { results: sColors } = await db.prepare("SELECT color, imagesJson FROM blank_colors WHERE blankId=?").bind(src).all();
    for (const c of sColors) {
      if (have.has(c.color || "")) continue;
      const now = new Date().toISOString();
      await db.prepare("INSERT INTO blank_colors (blankId, color, imagesJson, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(target, c.color || "", c.imagesJson || "[]", order++, now, now).run();
      have.add(c.color || "");
    }
    await db.prepare("UPDATE OR IGNORE product_blank_links SET blankId=? WHERE blankId=?").bind(target, src).run();
    // Reorder points (migrations/0074) move to the target's same color + size — the larger one wins.
    await db.prepare(`INSERT INTO blank_sizes (blankId, color, size, purchasePriceCents, quantity, reorderPoint)
      SELECT ?, color, size, 0, 0, reorderPoint FROM blank_sizes WHERE blankId=? AND reorderPoint IS NOT NULL
      ON CONFLICT(blankId, color, size) DO UPDATE SET reorderPoint = MAX(COALESCE(blank_sizes.reorderPoint, 0), excluded.reorderPoint)`).bind(target, src).run();
    await db.batch([
      db.prepare("DELETE FROM product_blank_links WHERE blankId=?").bind(src),
      db.prepare("DELETE FROM blank_sizes WHERE blankId=?").bind(src),
      db.prepare("DELETE FROM blank_colors WHERE blankId=?").bind(src),
      db.prepare("DELETE FROM blanks WHERE id=?").bind(src),
    ]);
  }
  const { results: keys } = await db.prepare("SELECT DISTINCT color, size FROM inventory_movements WHERE blankId=? AND voidedAt IS NULL").bind(target).all();
  for (const k of keys) await recomputeBlankSizeFromHistory_(db, target, k.color || "", k.size);
  return { merged: sources.length, targetId: target };
}

// ---- Thread catalog (migrations/0021) — global, shared across every shop --------
const parseThread_ = (r) => ({ id: Number(r.id), brand: r.brand || "", type: r.type || "", weight: r.weight || "",
  code: r.code || "", name: r.name || "", colorHex: r.colorHex || "", sourceFlag: r.sourceFlag || "", notes: r.notes || "",
  inventory: [] });

export async function listThreads(db) {
  const { results } = await db.prepare("SELECT * FROM threads ORDER BY brand, type, weight, code").all();
  const threads = results.map(parseThread_);
  // Attach each thread's inventory (spool size + quantity) in one grouped query. Wrapped so a
  // pre-migration DB (thread_inventory not yet created) just yields empty inventory rather than
  // breaking the whole catalog — same safe-no-op spirit as deleteThread's reference checks.
  let inv = [];
  try {
    inv = (await db.prepare(
      `SELECT ti.id, ti.threadId, ti.spoolSizeId, ti.quantity, ss.description AS spoolDescription, ss.meters AS spoolMeters
       FROM thread_inventory ti LEFT JOIN spool_sizes ss ON ss.id = ti.spoolSizeId ORDER BY ss.meters, ti.id`
    ).all()).results;
  } catch (e) { inv = []; }
  const byThread = new Map();
  for (const r of inv) {
    const tid = Number(r.threadId);
    if (!byThread.has(tid)) byThread.set(tid, []);
    byThread.get(tid).push({ id: Number(r.id), spoolSizeId: r.spoolSizeId == null ? null : Number(r.spoolSizeId),
      quantity: Number(r.quantity) || 0, spoolDescription: r.spoolDescription || "",
      meters: r.spoolMeters == null ? null : Number(r.spoolMeters) });
  }
  for (const t of threads) t.inventory = byThread.get(t.id) || [];
  return threads;
}

// ---- Spool-size catalog + per-thread inventory (migrations/0028) -----------------
// spool_sizes is a small shared catalog (description + length in whole metres); thread_inventory
// is per-thread stock, each row a spool size and how many are on hand. Both global, like threads.
const parseSpoolSize_ = (r) => ({ id: Number(r.id), description: r.description || "", meters: Number(r.meters) || 0 });

export async function listSpoolSizes(db) {
  const { results } = await db.prepare("SELECT * FROM spool_sizes ORDER BY meters, description").all();
  return results.map(parseSpoolSize_);
}

export async function saveSpoolSize(db, fields) {
  const now = new Date().toISOString();
  const description = String(fields.description || "").slice(0, 100);
  const meters = Math.max(0, Math.floor(Number(fields.meters) || 0));
  if (fields.id) {
    await db.prepare("UPDATE spool_sizes SET description=?, meters=?, updatedAt=? WHERE id=?").bind(description, meters, now, Number(fields.id)).run();
    return Number(fields.id);
  }
  const r = await db.prepare("INSERT INTO spool_sizes (description, meters, createdAt, updatedAt) VALUES (?, ?, ?, ?)").bind(description, meters, now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

// Refused while any thread-inventory item still references this spool size — same
// reference-check pattern as deleteThread.
export async function deleteSpoolSize(db, id) {
  const n = Number(id);
  const used = await db.prepare("SELECT count(*) n FROM thread_inventory WHERE spoolSizeId=?").bind(n).first().catch(() => null);
  if (used && Number(used.n) > 0) throw new Error("This spool size is used by thread inventory — remove those items first");
  await db.prepare("DELETE FROM spool_sizes WHERE id=?").bind(n).run();
}

export async function saveThreadInventory(db, fields) {
  const now = new Date().toISOString();
  const spoolSizeId = fields.spoolSizeId != null && fields.spoolSizeId !== "" ? Number(fields.spoolSizeId) : null;
  const quantity = Math.max(0, Math.floor(Number(fields.quantity) || 0));
  if (fields.id) {
    await db.prepare("UPDATE thread_inventory SET spoolSizeId=?, quantity=?, updatedAt=? WHERE id=?").bind(spoolSizeId, quantity, now, Number(fields.id)).run();
    return Number(fields.id);
  }
  const threadId = Number(fields.threadId);
  const r = await db.prepare("INSERT INTO thread_inventory (threadId, spoolSizeId, quantity, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)").bind(threadId, spoolSizeId, quantity, now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

export async function deleteThreadInventory(db, id) {
  await db.prepare("DELETE FROM thread_inventory WHERE id=?").bind(Number(id)).run();
}

// ---- Needle settings (migrations/0044) — global ----------------------------------
// The needle Run Order recommends has two halves: its SIZE follows the thread (needle_sizes maps a
// thread weight to a needle size, e.g. 40 -> 75/11) and its TYPE follows the garment (needle_types,
// picked per blank as blanks.needleTypeId). Both lists are edited from Threads -> Needle settings.
// The two list readers return [] on a database that doesn't have the tables yet, so Run Order and
// Blanks keep working if the code is deployed a moment before the migration.
const missingNeedleTables_ = (e) => /no such (table|column)/i.test(String(e && e.message));

// One spelling per weight, so "40", "40wt" and "40 WT" are the same row and match threads.weight.
export function normThreadWeight(w) {
  return String(w == null ? "" : w).trim().toLowerCase().replace(/\s*(wt|weight)\.?$/, "").trim().slice(0, 20);
}

export async function listNeedleSizes(db) {
  let rows;
  try { rows = (await db.prepare("SELECT weight, needleSize FROM needle_sizes").all()).results; }
  catch (e) { if (missingNeedleTables_(e)) return []; throw e; }
  // Numeric weights in order (40 before 60 before 120), anything else after, alphabetically.
  const num = (w) => (/^\d+(\.\d+)?$/.test(w) ? Number(w) : Infinity);
  return rows.map(r => ({ weight: r.weight || "", needleSize: r.needleSize || "" }))
    .sort((a, b) => (num(a.weight) - num(b.weight)) || a.weight.localeCompare(b.weight));
}

// Upsert by weight: saving a weight that already has a size just changes the size.
export async function saveNeedleSize(db, fields) {
  const weight = normThreadWeight(fields && fields.weight);
  const needleSize = String((fields && fields.needleSize) || "").trim().slice(0, 20);
  if (!weight) throw new Error("Thread weight is required");
  if (!needleSize) throw new Error("Needle size is required");
  const now = new Date().toISOString();
  await db.prepare(
    "INSERT INTO needle_sizes (weight, needleSize, createdAt, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(weight) DO UPDATE SET needleSize=excluded.needleSize, updatedAt=excluded.updatedAt"
  ).bind(weight, needleSize, now, now).run();
  return weight;
}

export async function deleteNeedleSize(db, weight) {
  await db.prepare("DELETE FROM needle_sizes WHERE weight=?").bind(normThreadWeight(weight)).run();
}

// Each type carries how many blanks use it, so the settings window can say why one can't be deleted.
export async function listNeedleTypes(db) {
  try {
    const { results } = await db.prepare(
      `SELECT t.id, t.name, t.sortOrder, (SELECT count(*) FROM blanks b WHERE b.needleTypeId = t.id) AS blankCount
       FROM needle_types t ORDER BY t.sortOrder, t.name`).all();
    return results.map(r => ({ id: Number(r.id), name: r.name || "", sortOrder: Number(r.sortOrder) || 0, blankCount: Number(r.blankCount) || 0 }));
  } catch (e) { if (missingNeedleTables_(e)) return []; throw e; }
}

export async function saveNeedleType(db, fields) {
  const name = String((fields && fields.name) || "").trim().slice(0, 60);
  if (!name) throw new Error("Needle type name is required");
  const now = new Date().toISOString();
  try {
    if (fields.id) {
      await db.prepare("UPDATE needle_types SET name=?, updatedAt=? WHERE id=?").bind(name, now, Number(fields.id)).run();
      return Number(fields.id);
    }
    const next = await db.prepare("SELECT COALESCE(MAX(sortOrder), 0) + 1 AS n FROM needle_types").first();
    const r = await db.prepare("INSERT INTO needle_types (name, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
      .bind(name, Number(next && next.n) || 1, now, now).run();
    return Number(r.meta && r.meta.last_row_id) || 0;
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) throw new Error(`There is already a needle type called "${name}"`);
    throw e;
  }
}

// Refused while any blank still uses the type — same reference-check pattern as deleteSpoolSize.
export async function deleteNeedleType(db, id) {
  const n = Number(id);
  const used = await db.prepare("SELECT count(*) n FROM blanks WHERE needleTypeId=?").bind(n).first();
  const count = Number(used && used.n) || 0;
  if (count > 0) throw new Error(`This needle type is set on ${count} blank${count === 1 ? "" : "s"} — change ${count === 1 ? "it" : "them"} first`);
  await db.prepare("DELETE FROM needle_types WHERE id=?").bind(n).run();
}

export async function needleTypeExists(db, id) {
  const row = await db.prepare("SELECT 1 AS ok FROM needle_types WHERE id=?").bind(Number(id)).first();
  return !!row;
}

export async function createThread(db, fields) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    `INSERT INTO threads (brand, type, weight, code, name, colorHex, sourceFlag, notes, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(String(fields.brand || "").slice(0, 100), String(fields.type || "").slice(0, 100), String(fields.weight || "").slice(0, 20),
    String(fields.code || "").slice(0, 40), String(fields.name || "").slice(0, 200), String(fields.colorHex || "").slice(0, 6).toLowerCase(),
    String(fields.sourceFlag || "").slice(0, 20), String(fields.notes || "").slice(0, 500), now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

export async function updateThread(db, id, fields) {
  await db.prepare(
    `UPDATE threads SET brand=?, type=?, weight=?, code=?, name=?, colorHex=?, sourceFlag=?, notes=?, updatedAt=? WHERE id=?`
  ).bind(String(fields.brand || "").slice(0, 100), String(fields.type || "").slice(0, 100), String(fields.weight || "").slice(0, 20),
    String(fields.code || "").slice(0, 40), String(fields.name || "").slice(0, 200), String(fields.colorHex || "").slice(0, 6).toLowerCase(),
    String(fields.sourceFlag || "").slice(0, 20), String(fields.notes || "").slice(0, 500), new Date().toISOString(), Number(id)).run();
}

// Refused while any design version's thread-color map, or any machine needle, still points at
// this thread — same reference-check pattern as deleteExpenseCategory. Both referencing tables
// exist since migrations/0024 (design_versions) and 0025 (machine_needles).
export async function deleteThread(db, id) {
  const n = Number(id);
  const usedByDesign = await db.prepare(
    "SELECT count(*) n FROM design_versions dv, json_each(dv.threadColorsJson) je WHERE json_extract(je.value, '$.threadId') = ?"
  ).bind(n).first().catch(() => null);
  if (usedByDesign && Number(usedByDesign.n) > 0) throw new Error("This thread is used in a design's color map — remove it there first");
  const usedByMachine = await db.prepare("SELECT count(*) n FROM machine_needles WHERE threadId=?").bind(n).first().catch(() => null);
  if (usedByMachine && Number(usedByMachine.n) > 0) throw new Error("This thread is currently loaded on a machine — clear that needle first");
  await db.prepare("DELETE FROM threads WHERE id=?").bind(n).run();
}

// Imports already-parsed chart rows (see parseHatchChart_ in admin.js), upserting on
// (brand, type, weight, code) so re-importing the same chart just refreshes names/colors rather
// than duplicating rows -- a code alone isn't unique across a brand's different lines (e.g.
// Madeira PolyNeon 40 code 1538 vs. Madeira Rayon 40 code 1538 are different threads).
export async function importThreadChart(db, rows) {
  const now = new Date().toISOString();
  let created = 0, updated = 0;
  for (const row of rows) {
    const brand = String(row.brand || "").slice(0, 100), code = String(row.code || "").slice(0, 40);
    const type = String(row.type || "").slice(0, 100), weight = String(row.weight || "").slice(0, 20);
    if (!brand || !code) continue;
    const existing = await db.prepare("SELECT id FROM threads WHERE brand=? AND type=? AND weight=? AND code=?").bind(brand, type, weight, code).first();
    const fields = { brand, type: row.type, weight: row.weight, code, name: row.name, colorHex: row.colorHex, sourceFlag: row.sourceFlag, notes: "" };
    if (existing) { await updateThread(db, existing.id, fields); updated++; }
    else { await createThread(db, fields); created++; }
  }
  return { created, updated };
}

// ---- Hoop catalog (migrations/0022) — global, shared across every shop ----------
const parseHoop_ = (r) => ({ id: Number(r.id), name: r.name || "", widthMm: r.widthMm == null ? null : Number(r.widthMm),
  heightMm: r.heightMm == null ? null : Number(r.heightMm), isCapFrame: !!r.isCapFrame, notes: r.notes || "", sortOrder: Number(r.sortOrder) || 0 });

export async function listHoops(db) {
  const { results } = await db.prepare("SELECT * FROM hoops ORDER BY sortOrder, name").all();
  return results.map(parseHoop_);
}

export async function createHoop(db, fields) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    `INSERT INTO hoops (name, widthMm, heightMm, isCapFrame, notes, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(String(fields.name || "").slice(0, 100), fields.widthMm != null && fields.widthMm !== "" ? Number(fields.widthMm) : null,
    fields.heightMm != null && fields.heightMm !== "" ? Number(fields.heightMm) : null, fields.isCapFrame ? 1 : 0,
    String(fields.notes || "").slice(0, 500), Number(fields.sortOrder) || 0, now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

export async function updateHoop(db, id, fields) {
  await db.prepare(
    `UPDATE hoops SET name=?, widthMm=?, heightMm=?, isCapFrame=?, notes=?, sortOrder=?, updatedAt=? WHERE id=?`
  ).bind(String(fields.name || "").slice(0, 100), fields.widthMm != null && fields.widthMm !== "" ? Number(fields.widthMm) : null,
    fields.heightMm != null && fields.heightMm !== "" ? Number(fields.heightMm) : null, fields.isCapFrame ? 1 : 0,
    String(fields.notes || "").slice(0, 500), Number(fields.sortOrder) || 0, new Date().toISOString(), Number(id)).run();
}

// Refused while any design or machine still references this hoop — same reference-check
// pattern as deleteThread. Both referencing tables exist since migrations/0024 (designs) and
// 0025 (machine_hoops).
export async function deleteHoop(db, id) {
  const n = Number(id);
  const usedByDesign = await db.prepare("SELECT count(*) n FROM designs WHERE hoopId=?").bind(n).first().catch(() => null);
  if (usedByDesign && Number(usedByDesign.n) > 0) throw new Error("This hoop is required by a design — change that design's hoop first");
  const usedByDesignHoops = await db.prepare(
    "SELECT (SELECT count(*) FROM design_hoops WHERE hoopId=?1) + (SELECT count(*) FROM products WHERE personalizationHoopId=?1) AS n"
  ).bind(n).first().catch(() => null);
  if (usedByDesignHoops && Number(usedByDesignHoops.n) > 0) throw new Error("This hoop is one of a design's hoops (or a product's personalization hoop) — change that first");
  const usedByMachine = await db.prepare("SELECT count(*) n FROM machine_hoops WHERE hoopId=?").bind(n).first().catch(() => null);
  if (usedByMachine && Number(usedByMachine.n) > 0) throw new Error("This hoop is set up on a machine — remove it there first");
  const isCurrentOnMachine = await db.prepare("SELECT count(*) n FROM machines WHERE currentHoopId=?").bind(n).first().catch(() => null);
  if (isCurrentOnMachine && Number(isCurrentOnMachine.n) > 0) throw new Error("A machine currently has this hoop mounted — change that first");
  await db.prepare("DELETE FROM hoops WHERE id=?").bind(n).run();
}

// ---- Locations (migrations/0041) — global garment-location lookup -----------------
// A shared list (Front/Back/Left Chest/Right Chest, admin-editable) that configurable products'
// design-option locations and blank color-image tags reference by id. Global, like hoops/threads.
const parseLocation_ = (r) => ({ id: Number(r.id), name: r.name || "", notes: r.notes || "", sortOrder: Number(r.sortOrder) || 0 });

export async function listLocations(db) {
  const { results } = await db.prepare("SELECT * FROM locations ORDER BY sortOrder, name").all();
  return results.map(parseLocation_);
}

// One upsert (create when no id, else update) — matches the saveSpoolSize style.
export async function saveLocation(db, fields) {
  const now = new Date().toISOString();
  const name = String(fields.name || "").slice(0, 100);
  const notes = String(fields.notes || "").slice(0, 500);
  const sortOrder = Number(fields.sortOrder) || 0;
  if (fields.id) {
    await db.prepare("UPDATE locations SET name=?, notes=?, sortOrder=?, updatedAt=? WHERE id=?")
      .bind(name, notes, sortOrder, now, Number(fields.id)).run();
    return Number(fields.id);
  }
  const r = await db.prepare("INSERT INTO locations (name, notes, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)")
    .bind(name, notes, sortOrder, now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

// Refused while any configurable product's locationsJson, or any blank color image, references it —
// the json_each/json_extract reference-check pattern from deleteThread. Each probe .catch()es a
// pre-migration DB (table absent) to null, i.e. a safe no-op.
export async function deleteLocation(db, id) {
  const n = Number(id);
  const usedByProduct = await db.prepare(
    "SELECT count(*) n FROM products p, json_each(p.locationsJson) je WHERE json_extract(je.value, '$.locationId') = ?"
  ).bind(n).first().catch(() => null);
  if (usedByProduct && Number(usedByProduct.n) > 0) throw new Error("This location is used by a product's design options — change that product first");
  const usedByFixed = await db.prepare(
    "SELECT count(*) n FROM products p, json_each(p.fixedTransfersJson) je WHERE json_extract(je.value, '$.locationId') = ?"
  ).bind(n).first().catch(() => null);   // migrations/0068
  if (usedByFixed && Number(usedByFixed.n) > 0) throw new Error("This location is used by a product's printed transfers — change that product first");
  const usedByMockup = await db.prepare(
    "SELECT count(*) n FROM products p, json_each(p.mockupGraphicsJson) je WHERE json_extract(je.value, '$.locationId') = ?"
  ).bind(n).first().catch(() => null);   // migrations/0069
  if (usedByMockup && Number(usedByMockup.n) > 0) throw new Error("This location is used by a product's embroidered graphics (for mockups) — change that product first");
  const usedByBlankImage = await db.prepare(
    "SELECT count(*) n FROM blank_colors bc, json_each(bc.imagesJson) je WHERE json_extract(je.value, '$.locationId') = ?"
  ).bind(n).first().catch(() => null);
  if (usedByBlankImage && Number(usedByBlankImage.n) > 0) throw new Error("This location tags a blank color image — remove that tag first");
  await db.prepare("DELETE FROM locations WHERE id=?").bind(n).run();
}

// ---- Product categories (migrations/0056) — global ---------------------------------
// The managed list a product's `type` (and a blank's `productType`) is picked from. `key` is the
// value stored in those columns and copied onto each order line; `name` is what the admin sees,
// `plural` the storefront's section heading, and `packAs` which package-size limit the category
// counts against when a box is chosen for shipping. Whether a product has sizes is NOT a property
// of its category — that follows the product's own pricing (by size / one flat price).
// The built-in list is what a database without the table behaves as (the three original
// categories), so every reader works before the migration is applied.
export const BUILT_IN_CATEGORIES = [
  { key: "shirt", name: "Shirt", plural: "Shirts", packAs: "shirt", sortOrder: 1 },
  { key: "sweatshirt", name: "Sweatshirt", plural: "Sweatshirts", packAs: "sweatshirt", sortOrder: 2 },
  { key: "cap", name: "Cap", plural: "Caps", packAs: "cap", sortOrder: 3 },
  { key: "other", name: "Other", plural: "Other", packAs: "other", sortOrder: 4 },
];
const PACK_AS = ["shirt", "sweatshirt", "cap", "other"];
const CATEGORY_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
// "T Shirt" → "t-shirt": the key a new category gets from its name.
export function categoryKeyFromName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export async function listProductCategories(db, { withCounts = false } = {}) {
  let rows;
  try { rows = (await db.prepare("SELECT key, name, plural, packAs, sortOrder FROM product_categories ORDER BY sortOrder, name").all()).results; }
  catch (e) { if (/no such table/i.test(String(e && e.message))) return BUILT_IN_CATEGORIES.map(c => ({ ...c, productCount: 0, blankCount: 0 })); throw e; }
  const cats = rows.map(r => ({ key: r.key, name: r.name || r.key, plural: r.plural || r.name || r.key,
    packAs: PACK_AS.includes(r.packAs) ? r.packAs : "other", sortOrder: Number(r.sortOrder) || 0, productCount: 0, blankCount: 0 }));
  if (withCounts) {
    const [{ results: pc }, { results: bc }] = await Promise.all([
      db.prepare("SELECT type k, count(*) n FROM products GROUP BY type").all(),
      db.prepare("SELECT productType k, count(*) n FROM blanks GROUP BY productType").all(),
    ]);
    const byKey = Object.fromEntries(cats.map(c => [c.key, c]));
    for (const r of pc) if (byKey[r.k]) byKey[r.k].productCount = Number(r.n) || 0;
    for (const r of bc) if (byKey[r.k]) byKey[r.k].blankCount = Number(r.n) || 0;
  }
  return cats;
}

// { key: packAs } for the box chooser (functions/_lib/boxSize.js).
export async function getCategoryPackMap(db) {
  return Object.fromEntries((await listProductCategories(db)).map(c => [c.key, c.packAs]));
}

// Create (no `key`: it's made from the name) or update (by `key`, which never changes — products,
// blanks and past order lines all hold it).
export async function saveProductCategory(db, fields) {
  const name = String((fields && fields.name) || "").trim().slice(0, 60);
  if (!name) throw new Error("A category needs a name");
  const plural = String((fields && fields.plural) || "").trim().slice(0, 60) || name;
  const packAs = PACK_AS.includes(fields.packAs) ? fields.packAs : "other";
  const sortOrder = Math.round(Number(fields.sortOrder) || 0);
  const now = new Date().toISOString();
  try {
    if (fields.key) {
      const key = String(fields.key);
      const r = await db.prepare("UPDATE product_categories SET name=?, plural=?, packAs=?, sortOrder=?, updatedAt=? WHERE key=?")
        .bind(name, plural, packAs, sortOrder, now, key).run();
      if (!(r.meta && r.meta.changes)) throw new Error("That category no longer exists");
      return key;
    }
    const key = categoryKeyFromName(name);
    if (!CATEGORY_KEY_RE.test(key)) throw new Error("Use letters or numbers in the category's name");
    if (await db.prepare("SELECT 1 ok FROM product_categories WHERE key=?").bind(key).first()) throw new Error(`There is already a category called "${name}"`);
    const next = await db.prepare("SELECT COALESCE(MAX(sortOrder), 0) + 1 AS n FROM product_categories").first();
    await db.prepare("INSERT INTO product_categories (key, name, plural, packAs, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(key, name, plural, packAs, fields.sortOrder != null && fields.sortOrder !== "" ? sortOrder : (Number(next && next.n) || 1), now, now).run();
    return key;
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) throw new Error(`There is already a category called "${name}"`);
    throw e;
  }
}

// Refused while any product or blank is filed under it (past order lines keep their copy either way).
export async function deleteProductCategory(db, key) {
  const k = String(key || "");
  const p = Number((await db.prepare("SELECT count(*) n FROM products WHERE type=?").bind(k).first()).n) || 0;
  const b = Number((await db.prepare("SELECT count(*) n FROM blanks WHERE productType=?").bind(k).first()).n) || 0;
  if (p || b) {
    const parts = [p ? `${p} product${p === 1 ? "" : "s"}` : "", b ? `${b} blank${b === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
    throw new Error(`This category is used by ${parts} — move ${p + b === 1 ? "it" : "them"} to another category first`);
  }
  const left = Number((await db.prepare("SELECT count(*) n FROM product_categories WHERE key<>?").bind(k).first()).n) || 0;
  if (!left) throw new Error("Keep at least one category");
  await db.prepare("DELETE FROM product_categories WHERE key=?").bind(k).run();
}

// ---- Designs (migrations/0024) — per-org, one design per product ----------------
// designs = the product-facing record (name/notes/stabilizer/required hoop);
// design_versions = an append-only file history, the "current" version being just the newest row.
// hoopIds = the hoops the design runs in on its own; personalizationHoopIds = the hoops for the
// design WITH a typed-in name in the same hooping (migrations/0032, design_hoops). hoopId (the
// first design hoop) is kept for older readers.
const parseDesign_ = (r, hoops) => ({ id: Number(r.id), orgId: r.orgId, isGlobal: !!Number(r.isGlobal), name: r.name || "", notes: r.notes || "",
  stabilizer: r.stabilizer || "", hoopId: r.hoopId == null ? null : Number(r.hoopId),
  hoopIds: (hoops && hoops.design) || (r.hoopId == null ? [] : [Number(r.hoopId)]),
  personalizationHoopIds: (hoops && hoops.personalization) || [] });

// {designId: {design: [hoopId…], personalization: [hoopId…]}} for the designs matched by `where`.
async function designHoopsBy_(db, where, binds) {
  const out = {};
  try {
    const { results } = await db.prepare(
      `SELECT designId, hoopId, purpose FROM design_hoops WHERE designId IN (SELECT id FROM designs WHERE ${where}) ORDER BY sortOrder, hoopId`
    ).bind(...binds).all();
    for (const r of results) {
      const o = out[r.designId] = out[r.designId] || { design: [], personalization: [] };
      o[r.purpose === "personalization" ? "personalization" : "design"].push(Number(r.hoopId));
    }
  } catch (e) { /* pre-0032 database: fall back to designs.hoopId */ }
  return out;
}

// A shop's designs plus every GLOBAL design (migrations/0033 — usable by all shops, e.g. shared
// closure designs), the shop's own first.
export async function listDesigns(db, orgId) {
  let results, where = "orgId=? OR isGlobal=1";
  try { ({ results } = await db.prepare(`SELECT * FROM designs WHERE ${where} ORDER BY isGlobal, name`).bind(orgId).all()); }
  catch (e) {
    if (!/no such column/i.test(String(e && e.message))) throw e;
    where = "orgId=?"; ({ results } = await db.prepare("SELECT * FROM designs WHERE orgId=? ORDER BY name").bind(orgId).all());
  }
  const hoops = await designHoopsBy_(db, where, [orgId]);
  return results.map(r => parseDesign_(r, hoops[r.id]));
}

// Shops other than the design's home whose products use it (as one of their designs, their main
// design, or a pick-list option) — a global design can't be made shop-only while any do.
async function designUsedByOtherShops_(db, id, homeOrgId) {
  const r = await db.prepare(
    `SELECT (SELECT count(*) FROM product_designs WHERE designId=?1 AND orgId<>?2) +
            (SELECT count(*) FROM products WHERE designId=?1 AND orgId<>?2) +
            (SELECT count(*) FROM products p, json_each(CASE WHEN json_valid(p.personalizationOptionDesigns) THEN p.personalizationOptionDesigns ELSE '{}' END) j
              WHERE j.value = ?1 AND p.orgId<>?2) AS n`).bind(Number(id), homeOrgId).first();
  return Number(r && r.n) || 0;
}

export async function getDesign(db, id) {
  const row = await db.prepare("SELECT * FROM designs WHERE id=?").bind(Number(id)).first();
  if (!row) return null;
  const hoops = await designHoopsBy_(db, "id=?", [Number(id)]);
  return parseDesign_(row, hoops[row.id]);
}

export async function saveDesign(db, orgId, fields) {
  const now = new Date().toISOString();
  const name = String(fields.name || "").slice(0, 200), notes = String(fields.notes || "").slice(0, 2000);
  const stabilizer = String(fields.stabilizer || "").slice(0, 200);
  // hoopIds / personalizationHoopIds (migrations/0032); a lone legacy hoopId means [hoopId].
  const ids = (a) => [...new Set((Array.isArray(a) ? a : []).map(Number).filter(Boolean))];
  const hoopIds = Array.isArray(fields.hoopIds) ? ids(fields.hoopIds)
    : (fields.hoopId != null && fields.hoopId !== "" ? [Number(fields.hoopId)] : []);
  const persHoopIds = Array.isArray(fields.personalizationHoopIds) ? ids(fields.personalizationHoopIds) : null;
  const hoopId = hoopIds[0] || null;
  let id;
  if (fields.id) {
    // A shop can edit its own designs and any GLOBAL design (one edit updates it for every shop).
    const cur = await db.prepare("SELECT * FROM designs WHERE id=?").bind(Number(fields.id)).first();
    if (!cur || (cur.orgId !== orgId && !Number(cur.isGlobal))) throw new Error("Design not found");
    let isGlobal = Number(cur.isGlobal) ? 1 : 0;
    if (fields.isGlobal !== undefined && cur.isGlobal !== undefined) {
      isGlobal = fields.isGlobal ? 1 : 0;
      if (!isGlobal && Number(cur.isGlobal) && await designUsedByOtherShops_(db, cur.id, cur.orgId))
        throw new Error("Other shops' products use this global design — remove it there before making it shop-only");
      if (!isGlobal && Number(cur.isGlobal)) {   // a global graphic may only use a global design (migrations/0078)
        const g = await db.prepare("SELECT name FROM graphics WHERE designId=? AND isGlobal=1 LIMIT 1").bind(cur.id).first().catch(() => null);
        if (g) throw new Error(`The global graphic “${g.name}” uses this design — unlink it there (or make that graphic shop-only) before making the design shop-only`);
      }
    }
    await db.prepare(`UPDATE designs SET name=?, notes=?, stabilizer=?, hoopId=?, updatedAt=?${cur.isGlobal !== undefined ? ", isGlobal=?" : ""} WHERE id=?`)
      .bind(...[name, notes, stabilizer, hoopId, now].concat(cur.isGlobal !== undefined ? [isGlobal] : []), Number(fields.id)).run();
    id = Number(fields.id);
  } else {
    const r = await db.prepare("INSERT INTO designs (orgId, name, notes, stabilizer, hoopId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(orgId, name, notes, stabilizer, hoopId, now, now).run();
    id = Number(r.meta && r.meta.last_row_id) || 0;
    if (fields.isGlobal) await db.prepare("UPDATE designs SET isGlobal=1 WHERE id=?").bind(id).run().catch(() => {});
  }
  try {
    const keepPers = persHoopIds === null
      ? (await designHoopsBy_(db, "id=?", [id]))[id]?.personalization || [] : persHoopIds;
    await db.batch([
      db.prepare("DELETE FROM design_hoops WHERE designId=?").bind(id),
      ...hoopIds.map((h, i) => db.prepare("INSERT INTO design_hoops (designId, hoopId, purpose, sortOrder) VALUES (?, ?, 'design', ?)").bind(id, h, i)),
      ...keepPers.map((h, i) => db.prepare("INSERT INTO design_hoops (designId, hoopId, purpose, sortOrder) VALUES (?, ?, 'personalization', ?)").bind(id, h, i)),
    ]);
  } catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
  return id;
}

// Refused while any product still links to this design — never a hard delete of production
// history, same spirit as blank/thread/hoop deletion refusing while referenced.
export async function deleteDesign(db, id) {
  const n = Number(id);
  const used = await db.prepare("SELECT count(*) n FROM products WHERE designId=?").bind(n).first();
  if (used && Number(used.n) > 0) throw new Error("A product is still linked to this design — unlink it first");
  const usedAgain = await db.prepare(
    `SELECT (SELECT count(*) FROM product_designs WHERE designId=?1) +
            (SELECT count(*) FROM products p, json_each(CASE WHEN json_valid(p.personalizationOptionDesigns) THEN p.personalizationOptionDesigns ELSE '{}' END) j WHERE j.value = ?1) AS n`
  ).bind(n).first().catch(() => null);
  if (usedAgain && Number(usedAgain.n) > 0) throw new Error("A product still uses this design (as one of its designs or for a pick-list option) — remove it there first");
  await db.prepare("DELETE FROM designs WHERE id=?").bind(n).run();
}

// Two required files per version (migrations/0026): designFile (native, editable — .emb/.jdx/
// etc) and machineFile (the actual stitch file a machine runs — .dst/.exp/etc; what "Send design
// to machine" hands to the local send-agent).
const parseDesignVersion_ = (r) => ({ id: Number(r.id), designId: Number(r.designId),
  designFileKey: r.designFileKey || "", designFileName: r.designFileName || "", designFileExt: r.designFileExt || "",
  machineFileKey: r.machineFileKey || "", machineFileName: r.machineFileName || "", machineFileExt: r.machineFileExt || "",
  threadColors: tryParse_(r.threadColorsJson, []), notes: r.notes || "", uploadedAt: r.uploadedAt,
  stitchCount: r.stitchCount == null ? null : Number(r.stitchCount) });

export async function listDesignVersions(db, designId) {
  const { results } = await db.prepare("SELECT * FROM design_versions WHERE designId=? ORDER BY uploadedAt DESC, id DESC").bind(Number(designId)).all();
  return results.map(parseDesignVersion_);
}

export async function addDesignVersion(db, designId, fields) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    `INSERT INTO design_versions (designId, designFileKey, designFileName, designFileExt, machineFileKey, machineFileName, machineFileExt, threadColorsJson, notes, uploadedAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(Number(designId), String(fields.designFileKey || ""), String(fields.designFileName || "").slice(0, 200),
    String(fields.designFileExt || "").slice(0, 10), String(fields.machineFileKey || ""), String(fields.machineFileName || "").slice(0, 200),
    String(fields.machineFileExt || "").slice(0, 10), JSON.stringify(fields.threadColors || []),
    String(fields.notes || "").slice(0, 2000), fields.uploadedAt || now, now).run();
  const id = Number(r.meta && r.meta.last_row_id) || 0;
  await setStitchCount_(db, "design_versions", id, fields.stitchCount);
  return id;
}

// Update ONLY the thread-color map of an existing version (colors can be corrected on any
// version; the files and everything else stay untouched).
export async function updateDesignVersionThreads(db, versionId, threadColors) {
  await db.prepare("UPDATE design_versions SET threadColorsJson=? WHERE id=?")
    .bind(JSON.stringify(threadColors || []), Number(versionId)).run();
}

function parseOrderItemFile_(r) {
  return { id: Number(r.id), itemId: Number(r.itemId), fileKey: r.fileKey || "", fileName: r.fileName || "",
    fileExt: r.fileExt || "", uploadedBy: r.uploadedBy || "admin", createdAt: r.createdAt };
}

export async function getOrderItemFiles(db, itemId) {
  const { results } = await db.prepare("SELECT * FROM order_item_files WHERE itemId=? ORDER BY createdAt").bind(Number(itemId)).all();
  return results.map(parseOrderItemFile_);
}

export async function addOrderItemFile(db, itemId, fields) {
  const r = await db.prepare(
    `INSERT INTO order_item_files (itemId, fileKey, fileName, fileExt, uploadedBy, createdAt) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(Number(itemId), String(fields.fileKey || ""), String(fields.fileName || "").slice(0, 200),
    String(fields.fileExt || "").slice(0, 10), fields.uploadedBy === "customer" ? "customer" : "admin", new Date().toISOString()).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

export async function deleteOrderItemFile(db, id) {
  await db.prepare("DELETE FROM order_item_files WHERE id=?").bind(Number(id)).run();
}

// ---- Order-specific designs (migrations/0032) ----------------------------------------------
// A line with typed-in personalization needs its own digitized design (the name alone, or the main
// design + the name) — stitch file + optional native file + thread map, newest upload wins.
const parseOrderItemDesign_ = (r) => ({ id: Number(r.id), itemId: Number(r.itemId),
  designFileKey: r.designFileKey || "", designFileName: r.designFileName || "", designFileExt: r.designFileExt || "",
  machineFileKey: r.machineFileKey || "", machineFileName: r.machineFileName || "", machineFileExt: r.machineFileExt || "",
  threadColors: tryParse_(r.threadColorsJson, []), notes: r.notes || "", uploadedAt: r.uploadedAt, location: r.location || "",
  stitchCount: r.stitchCount == null ? null : Number(r.stitchCount) });

export async function listOrderItemDesigns(db, itemId) {
  const { results } = await db.prepare("SELECT * FROM order_item_designs WHERE itemId=? ORDER BY uploadedAt DESC, id DESC").bind(Number(itemId)).all();
  return results.map(parseOrderItemDesign_);
}

// `fields.location` (migrations/0055): which location of the line it's for — '' (the default) is the
// line's one design.
export async function addOrderItemDesign(db, itemId, fields) {
  const now = new Date().toISOString();
  const location = String(fields.location || "").slice(0, 60);
  const r = await db.prepare(
    `INSERT INTO order_item_designs (itemId, designFileKey, designFileName, designFileExt, machineFileKey, machineFileName, machineFileExt, threadColorsJson, notes, uploadedAt, createdAt${location ? ", location" : ""})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${location ? ", ?" : ""})`
  ).bind(Number(itemId), String(fields.designFileKey || ""), String(fields.designFileName || "").slice(0, 200),
    String(fields.designFileExt || "").slice(0, 10), String(fields.machineFileKey || ""), String(fields.machineFileName || "").slice(0, 200),
    String(fields.machineFileExt || "").slice(0, 10), JSON.stringify(fields.threadColors || []),
    String(fields.notes || "").slice(0, 2000), now, now, ...(location ? [location] : [])).run();
  const id = Number(r.meta && r.meta.last_row_id) || 0;
  await setStitchCount_(db, "order_item_designs", id, fields.stitchCount);
  return id;
}

// Does order_item_designs have its `location` column (migrations/0055)? Cached per database.
async function orderItemDesignsHasLocation_(db) {
  if (db.__oidHasLocation === undefined) {
    try { const { results } = await db.prepare("PRAGMA table_info(order_item_designs)").all(); db.__oidHasLocation = results.some(c => c.name === "location"); }
    catch (e) { db.__oidHasLocation = false; }
  }
  return db.__oidHasLocation;
}

// The order designs a line still needs and doesn't have (stagePrereqError, the order lists): one for
// each location carrying the customer's own stitched design, and one ('') for typed-in text — unless
// the line is an ordinary product made from the customer's design, whose one design has the name in
// it too. `have` = the locations it has designs for. A line from before migrations/0055 with a single
// custom spot counts its '' design for it.
function orderDesignsMissingOnLine_(line, have) {
  const cfg = tryParse_(line.configJson, null);
  const customs = (cfg && Array.isArray(cfg.locations) ? cfg.locations : []).filter(l => l && l.custom && l.kind === "embroidery");
  const options = tryParse_(line.personalizationOptions, []) || [];
  const freeText = Number(line.personalized) === 1 && !options.includes(line.persName);
  let n = 0;
  for (const l of customs) if (!have.has(String(l.location)) && !(customs.length === 1 && have.has(""))) n++;
  if (freeText && !(cfg && cfg.plain && customs.length) && !have.has("")) n++;
  return n;
}

// ---- Machines (migrations/0025) — global catalog + each machine's LIVE state --------
// machines = the catalog row (name, needle count, IP/EMB dir for the local send-agent, current
// hoop); machine_hoops = which hoops it supports; machine_needles = what thread is physically
// loaded on each needle RIGHT NOW — kept up to date by hand on the Machines screen.
function parseMachine_(row, hoopIds, needles) {
  return { id: Number(row.id), name: row.name || "", needleCount: Number(row.needleCount) || 1,
    ipAddress: row.ipAddress || "", embDir: row.embDir || "/EMB",
    macAddress: row.macAddress || "", verifiedAt: row.verifiedAt || "",
    currentHoopId: row.currentHoopId == null ? null : Number(row.currentHoopId),
    notes: row.notes || "", hoopIds: hoopIds || [], needles: needles || {},
    stitchCount: Number(row.stitchCount) || 0, runSeconds: Number(row.runSeconds) || 0, counterUpdatedAt: row.counterUpdatedAt || "" };
}

// The MAC is the machine's stable identity; normalize for comparison (lowercase, no separators)
// so "AA:BB:CC:00:11:22", "aa-bb-cc-00-11-22" and "aabbcc001122" all match.
export function normalizeMac_(mac) {
  return String(mac || "").toLowerCase().replace(/[^0-9a-f]/g, "");
}

async function machineHoopsAndNeedles_(db, machineId) {
  const [{ results: hoopRows }, { results: needleRows }] = await Promise.all([
    db.prepare("SELECT hoopId FROM machine_hoops WHERE machineId=?").bind(machineId).all(),
    db.prepare("SELECT needle, threadId FROM machine_needles WHERE machineId=? ORDER BY needle").bind(machineId).all(),
  ]);
  const needles = {};
  for (const r of needleRows) needles[Number(r.needle)] = r.threadId == null ? null : Number(r.threadId);
  return { hoopIds: hoopRows.map(r => Number(r.hoopId)), needles };
}

// Each machine carries its maintenance tasks with their status (migrations/0071) and `maintenanceDue` — the tasks
// due or due soon, for the Run Order warning.
export async function listMachines(db) {
  const { results } = await db.prepare("SELECT * FROM machines ORDER BY name").all();
  let tasks = [];
  try { tasks = await listMaintenanceTasks(db); } catch (e) { /* a database before 0070 */ }
  return Promise.all(results.map(async (row) => {
    const { hoopIds, needles } = await machineHoopsAndNeedles_(db, row.id);
    const m = parseMachine_(row, hoopIds, needles);
    m.maintenance = tasks.filter(t => t.machineId === m.id);
    m.maintenanceDue = m.maintenance.filter(t => t.status === "due" || t.status === "soon")
      .map(t => ({ id: t.id, name: t.name, status: t.status, pct: t.pct }));
    return m;
  }));
}

export async function getMachine(db, id) {
  const row = await db.prepare("SELECT * FROM machines WHERE id=?").bind(Number(id)).first();
  if (!row) return null;
  const { hoopIds, needles } = await machineHoopsAndNeedles_(db, row.id);
  return parseMachine_(row, hoopIds, needles);
}

// hoopIds (if an array) fully replaces the machine's supported-hoop set — same
// replace-on-save pattern updateBlank uses for sizes.
export async function saveMachine(db, fields) {
  const now = new Date().toISOString();
  const name = String(fields.name || "").slice(0, 200), ipAddress = String(fields.ipAddress || "").slice(0, 100);
  const embDir = String(fields.embDir || "/EMB").slice(0, 200), notes = String(fields.notes || "").slice(0, 500);
  const macAddress = String(fields.macAddress || "").slice(0, 100);
  const needleCount = Math.max(1, Math.floor(Number(fields.needleCount) || 1));
  const currentHoopId = fields.currentHoopId != null && fields.currentHoopId !== "" ? Number(fields.currentHoopId) : null;
  let id;
  if (fields.id) {
    id = Number(fields.id);
    await db.prepare("UPDATE machines SET name=?, needleCount=?, ipAddress=?, embDir=?, macAddress=?, currentHoopId=?, notes=?, updatedAt=? WHERE id=?")
      .bind(name, needleCount, ipAddress, embDir, macAddress, currentHoopId, notes, now, id).run();
  } else {
    const r = await db.prepare("INSERT INTO machines (name, needleCount, ipAddress, embDir, macAddress, currentHoopId, notes, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(name, needleCount, ipAddress, embDir, macAddress, currentHoopId, notes, now, now).run();
    id = Number(r.meta && r.meta.last_row_id) || 0;
  }
  if (Array.isArray(fields.hoopIds)) {
    await db.prepare("DELETE FROM machine_hoops WHERE machineId=?").bind(id).run();
    const hoopIds = [...new Set(fields.hoopIds.map(Number).filter(Boolean))];
    if (hoopIds.length) await db.batch(hoopIds.map(hoopId => db.prepare("INSERT INTO machine_hoops (machineId, hoopId) VALUES (?, ?)").bind(id, hoopId)));
  }
  return id;
}

export async function deleteMachine(db, id) {
  await db.prepare("DELETE FROM machines WHERE id=?").bind(Number(id)).run();
}

// Records a discovery sweep's results against the stored machines: for every discovered
// {mac, ip}, the machine whose macAddress matches (by normalized MAC) gets its ipAddress
// refreshed and verifiedAt stamped to now — so the scanner, not a human, keeps each machine's IP
// current, and freshness (>1h since verifiedAt) drives auto-rediscovery before a list/upload.
// Returns { updated: [ids...] } so the caller knows which records changed.
export async function recordMachineDiscovery(db, discovered) {
  const now = new Date().toISOString();
  const list = Array.isArray(discovered) ? discovered : [];
  const { results } = await db.prepare("SELECT id, macAddress FROM machines").all();
  const byMac = new Map();
  for (const row of results) { const key = normalizeMac_(row.macAddress); if (key) byMac.set(key, Number(row.id)); }
  const updated = [];
  for (const d of list) {
    const key = normalizeMac_(d && d.mac);
    const ip = String((d && d.ip) || "").slice(0, 100);
    if (!key || !ip || !byMac.has(key)) continue;
    const id = byMac.get(key);
    await db.prepare("UPDATE machines SET ipAddress=?, verifiedAt=?, updatedAt=? WHERE id=?").bind(ip, now, now, id).run();
    updated.push(id);
  }
  return { updated };
}

// Just updates currentHoopId — the "cost" of a hoop change is computed client-side,
// not stored.
export async function setMachineHoop(db, machineId, hoopId) {
  await db.prepare("UPDATE machines SET currentHoopId=?, updatedAt=? WHERE id=?")
    .bind(hoopId == null || hoopId === "" ? null : Number(hoopId), new Date().toISOString(), Number(machineId)).run();
}

// Bulk-sets every needle from `assignments` ([{needle, threadId}, ...] — e.g. a design's
// threadColorsJson), replacing whatever was there needle-by-needle. A needle not present in
// `assignments` is left alone (this sets what a design NEEDS, not necessarily every needle on
// the machine — a wider machine can have needles beyond what one design uses).
export async function setMachineNeedles(db, machineId, assignments) {
  const now = new Date().toISOString();
  const id = Number(machineId);
  const rows = (assignments || []).filter(a => a && a.needle);
  if (!rows.length) return;
  await db.batch(rows.map(a => db.prepare(
    "INSERT INTO machine_needles (machineId, needle, threadId, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(machineId, needle) DO UPDATE SET threadId=excluded.threadId, updatedAt=excluded.updatedAt"
  ).bind(id, Number(a.needle), a.threadId == null || a.threadId === "" ? null : Number(a.threadId), now)));
}

// A single needle's thread, corrected by hand (e.g. after a manual re-thread outside a run).
export async function setMachineNeedle(db, machineId, needle, threadId) {
  await setMachineNeedles(db, machineId, [{ needle, threadId }]);
}

// ---- Production queue — cross-org, no orgId filter ----------------------
// Every active line item whose order is exactly one manufacture away: paid, real, blanks
// received, design approved, not yet manufactured — the same prerequisite the "manufactured"
// fulfillment-stage button already enforces (FULFILLMENT_STAGES in admin.js), just evaluated
// across every org at once instead of one order at a time.
function parseQueueRow_(r) {
  return {
    itemId: Number(r.itemId), orderId: r.orderId, orgId: r.orgId, orgName: r.orgName || r.orgId,
    customerName: r.customerName, qty: Number(r.qty) || 1,
    manufacturedQty: Math.max(0, Number(r.manufacturedQty) || 0),
    remaining: Math.max(0, (Number(r.qty) || 1) - Math.max(0, Number(r.manufacturedQty) || 0)),
    productId: r.productId,
    itemName: r.itemName, itemSize: r.itemSize || "", activeItemCount: Number(r.activeItemCount) || 1,
    placedAt: r.placedAt, dueDate: r.dueDate || "",
    noBlankNeeded: !!Number(r.noBlankNeeded),   // migrations/0057: made from shop supplies, no blank
    blank: r.blankId == null ? null : { id: Number(r.blankId), name: r.blankName || "", brand: r.blankBrand || "",
      color: r.blankColor || "", productType: r.blankProductType || "", size: r.blankSize || "" },
    design: r.designId == null ? null : { id: Number(r.designId), name: r.designName || "", stabilizer: r.stabilizer || "",
      hoopId: r.hoopId == null ? null : Number(r.hoopId), hoopName: r.hoopName || "",
      threadColors: tryParse_(r.threadColorsJson, []),
      machineFileKey: r.machineFileKey || "", machineFileName: r.machineFileName || "" },
  };
}

// An order needs the customer to approve its design only when an active line carries FREE-FORM
// personalization text — a name the customer typed. Nothing personalized, or text that is one of
// the product's preset personalization options (the storefront stores the chosen option verbatim),
// skips approval: for those orders Mark manufactured needs digitizing done instead. A personalized
// line with no matching product (a custom local-sale line) counts as free-form. One SQL expression
// over an order row aliased `o`, shared by the order loaders (→ order.needsDesignApproval), the
// server's stage checks (stagePrereqError) and the Run Order queue.
const FREE_FORM_TEXT_SQL_ = `EXISTS (SELECT 1 FROM order_items ax
    LEFT JOIN products px ON px.orgId = ax.orgId AND px.productId = ax.productId
    WHERE ax.orderId = o.orderId AND ax.cancelDate IS NULL AND ax.personalized = 1
      AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(px.personalizationOptions) THEN px.personalizationOptions ELSE '[]' END) jx
                      WHERE jx.value = ax.persName))`;
// With the Design approval feature off (FEATURES), no order needs approval.
const NEEDS_DESIGN_APPROVAL_SQL_ = `(${featureOnSql_("designVerification")} AND ${FREE_FORM_TEXT_SQL_})`;

// Digitizing is needed when the order has free-form personalization text (the typed name has to be
// digitized), or some active line's product has no design linked (products.designId), or a line has
// no product at all (a custom local-sale line). Only when every product already has a design AND
// nothing is typed in is the "digitizing complete" step skipped. Feeds order.needsDigitizing,
// stagePrereqError and getProductionQueue.
// With the Production feature off there are no designs to link, so the step isn't asked for at all.
const NEEDS_DIGITIZING_SQL_ = `(${featureOnSql_("production")} AND (${FREE_FORM_TEXT_SQL_} OR EXISTS (SELECT 1 FROM order_items dx
    LEFT JOIN products pdx ON pdx.orgId = dx.orgId AND pdx.productId = dx.productId
    WHERE dx.orderId = o.orderId AND dx.cancelDate IS NULL AND pdx.designId IS NULL)))`;

// The customer's own design, stitched (migrations/0054): a line whose copy of its options has a custom
// EMBROIDERY entry. The shop digitizes the customer's image into the line's order design
// (order_item_designs), so the order needs digitizing and the customer approves the proof — the same
// path as a typed-in name. (A custom transfer is printed as uploaded: no approval in this version.)
// `a` is the order_items alias.
const customEmbroideryLineSql_ = (a) => `(${a}.configJson LIKE '%"custom":true%' AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${a}.configJson) THEN ${a}.configJson ELSE '{}' END, '$.locations') cj
    WHERE json_extract(cj.value, '$.custom') = 1 AND json_extract(cj.value, '$.kind') = 'embroidery'))`;
const CUSTOM_EMBROIDERY_SQL_ = `EXISTS (SELECT 1 FROM order_items cx WHERE cx.orderId = o.orderId AND cx.cancelDate IS NULL AND ${customEmbroideryLineSql_("cx")})`;

// The approval and digitizing expressions for THIS database. A line's copy of its options
// (order_items.configJson) arrived in migrations/0036; an older database gets the expressions without
// the custom-design part. Checked once per database (orderItemsHasConfigCol_).
async function stageSql_(db) {
  // A line filled from finished stock (migrations/0060) is already made: it needs no digitizing or approval.
  const fs = await hasFromStockColumn_(db);
  const skipStock = (sql) => fs ? sql.replace(/ax\.cancelDate IS NULL/g, "ax.cancelDate IS NULL AND COALESCE(ax.fromStock, 0) = 0")
    .replace(/dx\.cancelDate IS NULL/g, "dx.cancelDate IS NULL AND COALESCE(dx.fromStock, 0) = 0") : sql;
  if (!(await orderItemsHasConfigCol_(db))) return { approval: skipStock(NEEDS_DESIGN_APPROVAL_SQL_), digitizing: skipStock(NEEDS_DIGITIZING_SQL_) };
  return {
    approval: `(${featureOnSql_("designVerification")} AND (${skipStock(FREE_FORM_TEXT_SQL_)} OR ${CUSTOM_EMBROIDERY_SQL_}))`,
    digitizing: `(${skipStock(NEEDS_DIGITIZING_SQL_)} OR (${featureOnSql_("production")} AND ${CUSTOM_EMBROIDERY_SQL_}))`,
  };
}

export async function getProductionQueue(db) {
  const stage = await stageSql_(db);
  const nb = await noBlankLine_(db), fs = await fromStockLine_(db);
  const { results } = await db.prepare(`
    SELECT oi.id AS itemId, oi.orderId, oi.orgId, o.customerName, o.placedAt, o.dueDate, oi.qty,
           COALESCE(oi.manufacturedQty,0) AS manufacturedQty, oi.productId,
           oi.name AS itemName, oi.size AS itemSize, oi.transfersAppliedAt,
           org.name AS orgName,
           pbl.blankId, pbl.blankColor, pbl.blankSize,
           b.name AS blankName, b.brand AS blankBrand, b.productType AS blankProductType,
           p.designId, d.name AS designName, d.stabilizer, d.hoopId, h.name AS hoopName,
           dv.threadColorsJson, dv.machineFileKey, dv.machineFileName,
           ${nb("oi")} AS noBlankNeeded,
           (SELECT count(*) FROM order_items oi2 WHERE oi2.orderId = oi.orderId AND oi2.cancelDate IS NULL) AS activeItemCount
    FROM order_items oi
    JOIN orders o ON o.orderId = oi.orderId
    JOIN orgs org ON org.orgId = oi.orgId
    LEFT JOIN product_blank_links pbl ON pbl.orgId = oi.orgId AND pbl.productId = oi.productId
           AND pbl.productColor = (CASE WHEN oi.configJson LIKE '{%' THEN COALESCE(json_extract(oi.configJson,'$.garmentColor'),'') ELSE '' END)
           AND pbl.productSize = oi.size
    LEFT JOIN blanks b ON b.id = pbl.blankId
    LEFT JOIN products p ON p.orgId = oi.orgId AND p.productId = oi.productId
    LEFT JOIN designs d ON d.id = p.designId
    LEFT JOIN hoops h ON h.id = d.hoopId
    LEFT JOIN design_versions dv ON dv.id = (
      SELECT id FROM design_versions WHERE designId = d.id ORDER BY uploadedAt DESC, id DESC LIMIT 1
    )
    WHERE oi.cancelDate IS NULL
      AND o.paid = 1 AND o.isTest = 0 AND o.voidedAt IS NULL
      AND (COALESCE(oi.blankReceivedAt, o.blankReceivedAt) IS NOT NULL OR ${nb("oi")})   -- no blank to wait for (0057)
      AND o.manufacturedAt IS NULL
      AND o.completedAt IS NULL AND o.shippedAt IS NULL AND o.deliveredAt IS NULL   -- shipped / delivered / completed: nothing left to make
      AND (o.designApprovedAt IS NOT NULL OR (NOT ${stage.approval}
           AND (o.digitizingCompleteAt IS NOT NULL OR NOT ${stage.digitizing})))
      AND COALESCE(oi.manufacturedQty,0) < oi.qty
      AND NOT ${fs("oi")}   -- filled from finished stock (0060): nothing to run
    ORDER BY (o.dueDate IS NULL), o.dueDate, blankProductType, blankName, oi.size, o.placedAt
  `).all();
  const jobs = results.map(parseQueueRow_);
  if (!jobs.length) return jobs;
  const appliedAt = {}; for (const r of results) appliedAt[Number(r.itemId)] = r.transfersAppliedAt || "";
  // The needle TYPE each linked blank wants (migrations/0044); "" = not set on the blank. A
  // separate, tolerant read so the queue still loads on a database without the needle tables.
  try {
    const blankIds = [...new Set(jobs.map(j => j.blank && j.blank.id).filter(Boolean))];
    const { results: nt } = blankIds.length ? await db.prepare(
      `SELECT b.id, t.name FROM blanks b JOIN needle_types t ON t.id = b.needleTypeId
       WHERE b.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(blankIds)).all() : { results: [] };
    const typeByBlank = {};
    for (const r of nt) typeByBlank[r.id] = r.name || "";
    for (const j of jobs) if (j.blank) j.blank.needleType = typeByBlank[j.blank.id] || "";
  } catch (e) { if (!missingNeedleTables_(e)) throw e; }
  // Each line's hoopings (migrations/0032) and where each of its pieces is in them.
  let ctx = null, runs = [];
  try {
    ctx = await hoopingContext_(db, jobs.map(j => j.itemId));
    ({ results: runs } = await db.prepare(
      `SELECT id, itemId, pieceNo, stepNo, status, machineId, machineName, startedAt, hoopId FROM production_runs
       WHERE status IN ('running','done') AND itemId IN (SELECT value FROM json_each(?))`
    ).bind(JSON.stringify(jobs.map(j => j.itemId))).all());
  } catch (e) { if (!/no such (table|column)/i.test(String(e && e.message))) throw e; }
  const kept = [];
  for (const job of jobs) {
    const cfgItem = ctx && ctx.items[job.itemId];
    const steps = ctx ? planHoopings_(ctx, cfgItem) : [legacyStep_(job.design)];
    // A configurable line with no embroidery hoopings is transfer-only — it belongs on Run Transfer
    // Sheets, not the embroidery Run Order queue, so drop it here.
    if (cfgItem && cfgItem.configurable && cfgItem.config && !steps.length) continue;
    // The same for a plain product that needs no embroidery but has a transfer (its reorder QR).
    if (cfgItem && lineTransfers_(cfgItem).length && !lineIsEmbroidered_(cfgItem, steps)) continue;
    job.steps = steps;
    // Transfers this line ALSO needs pressed (a reorder QR, or a transfer option on a configurable
    // product) — done on Run Transfer Sheets, tracked apart from the embroidery (migrations/0048).
    job.transfers = lineTransfers_(cfgItem).map(l => ({ graphicName: l.graphicName || "", auto: !!l.auto }));
    job.transfersApplied = !!appliedAt[job.itemId];
    // Old shape, for readers that only know one design: the first hooping.
    const s1 = steps[0];
    if (s1 && s1.designId != null) job.design = { id: s1.designId, name: s1.designName, stabilizer: s1.stabilizer,
      hoopId: s1.hoopIds[0] || null, hoopName: s1.hoopNames[0] || "", threadColors: s1.threadColors,
      machineFileKey: s1.machineFileKey, machineFileName: s1.machineFileName };
    const st = pieceStates_(runs.filter(r => Number(r.itemId) === job.itemId), steps.length);
    job.pieces = st.pieces;
    job.idlePieces = Math.max(0, job.remaining - st.pieces.length);
    kept.push(job);
  }
  return kept;
}

// ---- Hoopings (migrations/0032) -------------------------------------------------------------
// One physical piece of a line item is made in one or more HOOPINGS, in order:
//   1. each of the product's designs (product_designs, run order) on the design's own hoops —
//      except the MAIN design when the line has typed-in personalization and the product combines
//      it: then that hooping runs the ORDER-SPECIFIC design (order_item_designs) on the design's
//      personalization hoops;
//   2. typed-in personalization the product stitches SEPARATELY: its own hooping, order-specific
//      design, on products.personalizationHoopId;
//   3. a pick-list option: its own hooping, the option's mapped design on that design's hoops.
// A hooping that can't run yet carries `blocked` (no order-specific design uploaded, an unmapped
// option). A line whose product has no designs is one hooping with no design (as before 0032).

// Loads everything planHoopings_ needs for these line items in a fixed number of queries.
async function hoopingContext_(db, itemIds) {
  const ids = JSON.stringify(itemIds.map(Number));
  const { results: items } = await db.prepare(
    `SELECT oi.id, oi.orgId, oi.productId, oi.personalized, oi.persName, oi.configJson,
            p.designId AS productDesignId, p.configurable, p.noDesignNeeded, p.personalizationOptions, p.personalizationMode, p.personalizationHoopId, p.personalizationOptionDesigns
     FROM order_items oi LEFT JOIN products p ON p.orgId = oi.orgId AND p.productId = oi.productId
     WHERE oi.id IN (SELECT value FROM json_each(?))`).bind(ids).all();
  const { results: pds } = await db.prepare(
    `SELECT pd.* FROM product_designs pd WHERE EXISTS (SELECT 1 FROM order_items oi WHERE oi.id IN (SELECT value FROM json_each(?))
       AND oi.orgId = pd.orgId AND oi.productId = pd.productId) ORDER BY pd.sortOrder, pd.id`).bind(ids).all();
  const designIds = new Set(pds.map(r => Number(r.designId)));
  for (const it of items) {
    if (it.productDesignId != null) designIds.add(Number(it.productDesignId));
    for (const v of Object.values(tryParse_(it.personalizationOptionDesigns, {}) || {})) if (Number(v)) designIds.add(Number(v));
    // Configurable lines (migrations/0036): each embroidery option's design is its own hooping.
    if (Number(it.configurable)) { const cfg = tryParse_(it.configJson, null);
      if (cfg) for (const l of (cfg.locations || [])) if (l.kind === "embroidery" && Number(l.designId)) designIds.add(Number(l.designId)); }
  }
  const dIds = JSON.stringify([...designIds]);
  const { results: designs } = await db.prepare(
    `SELECT d.id, d.name, d.stabilizer, d.hoopId, dv.id AS versionId, dv.threadColorsJson, dv.machineFileKey, dv.machineFileName
     FROM designs d LEFT JOIN design_versions dv ON dv.id = (SELECT id FROM design_versions WHERE designId = d.id ORDER BY uploadedAt DESC, id DESC LIMIT 1)
     WHERE d.id IN (SELECT value FROM json_each(?))`).bind(dIds).all();
  const { results: dh } = await db.prepare(
    "SELECT designId, hoopId, purpose FROM design_hoops WHERE designId IN (SELECT value FROM json_each(?)) ORDER BY sortOrder, hoopId").bind(dIds).all();
  // The newest order design per line — and, since migrations/0055, per location of the line.
  const sameLoc = (await orderItemDesignsHasLocation_(db)) ? " AND y.location = x.location" : "";
  const { results: ids2 } = await db.prepare(
    `SELECT x.* FROM order_item_designs x WHERE x.itemId IN (SELECT value FROM json_each(?))
       AND x.id = (SELECT id FROM order_item_designs y WHERE y.itemId = x.itemId${sameLoc} ORDER BY uploadedAt DESC, id DESC LIMIT 1)`).bind(ids).all();
  const { results: hoops } = await db.prepare("SELECT id, name FROM hoops").all();
  const ctx = { items: {}, productDesigns: {}, designs: {}, itemDesigns: {}, itemDesignsAt: {}, hoopNames: {} };
  for (const h of hoops) ctx.hoopNames[h.id] = h.name || "";
  for (const d of designs) ctx.designs[d.id] = { id: Number(d.id), name: d.name || "", stabilizer: d.stabilizer || "",
    hoopIds: [], personalizationHoopIds: [], legacyHoopId: d.hoopId == null ? null : Number(d.hoopId),
    versionId: d.versionId == null ? null : Number(d.versionId), threadColors: tryParse_(d.threadColorsJson, []),
    machineFileKey: d.machineFileKey || "", machineFileName: d.machineFileName || "" };
  for (const r of dh) { const d = ctx.designs[r.designId]; if (d) (r.purpose === "personalization" ? d.personalizationHoopIds : d.hoopIds).push(Number(r.hoopId)); }
  for (const d of Object.values(ctx.designs)) if (!d.hoopIds.length && d.legacyHoopId) d.hoopIds.push(d.legacyHoopId);
  for (const r of pds) (ctx.productDesigns[r.orgId + "|" + r.productId] = ctx.productDesigns[r.orgId + "|" + r.productId] || []).push(parseProductDesign_(r));
  for (const r of ids2) {
    const d = parseOrderItemDesign_(r);
    (ctx.itemDesignsAt[r.itemId] = ctx.itemDesignsAt[r.itemId] || {})[d.location] = d;
    if (!d.location) ctx.itemDesigns[r.itemId] = d;   // the line's one design ('')
  }
  for (const it of items) ctx.items[it.id] = {
    itemId: Number(it.id), orgId: it.orgId, productId: it.productId || "", personalized: !!it.personalized, persName: it.persName || "",
    productDesignId: it.productDesignId == null ? null : Number(it.productDesignId),
    options: tryParse_(it.personalizationOptions, []) || [], mode: it.personalizationMode === "separate" ? "separate" : "combined",
    persHoopId: it.personalizationHoopId == null ? null : Number(it.personalizationHoopId),
    optionDesigns: tryParse_(it.personalizationOptionDesigns, {}) || {},
    configurable: !!Number(it.configurable), noDesignNeeded: !!Number(it.noDesignNeeded), config: tryParse_(it.configJson, null) };
  return ctx;
}

// Is there embroidery to run on this line? A configurable line: only when it has embroidery picks.
// A plain line: yes, unless its product is marked "No embroidery design needed" and nothing gave it
// a real hooping — such a line with a transfer (a reorder QR) is transfer-only.
function lineIsEmbroidered_(it, steps) {
  if (!it) return true;
  if (it.configurable && it.config && !it.config.plain && (it.config.locations || []).some(l => l && !l.auto && !l.fixed && l.location !== "reorderqr")) return steps.length > 0;
  // An ordinary line made from the customer's own design (migrations/0054): only what its plan holds.
  if (plainCustom_(it)) return steps.length > 0;
  return steps.some(st => st.designId != null || st.kind === "itemDesign" || st.blocked) || !it.noDesignNeeded;
}
const lineTransfers_ = (it) => it && it.config ? (it.config.locations || []).filter(l => l.kind === "transfer") : [];
// The customer's own design on an ordinary (not configurable-picked) line, or null.
const plainCustom_ = (it) => it && it.config && (it.config.plain || !it.configurable)
  ? (it.config.locations || []).find(l => l && l.custom) || null : null;

const legacyStep_ = (design) => ({ stepNo: 1, label: design ? design.name : "", kind: "design",
  designId: design ? design.id : null, designName: design ? design.name : "", versionId: null, itemDesignId: null,
  stabilizer: design ? design.stabilizer : "", hoopIds: design && design.hoopId ? [design.hoopId] : [],
  hoopNames: design && design.hoopName ? [design.hoopName] : [], threadColors: design ? design.threadColors : [],
  machineFileKey: design ? design.machineFileKey : "", machineFileName: design ? design.machineFileName : "", blocked: "" });

// The ordered hoopings for one line item (see the comment above hoopingContext_).
function planHoopings_(ctx, it) {
  if (!it) return [legacyStep_(null)];
  const steps = [];
  const names = (hoopIds) => hoopIds.map(h => ctx.hoopNames[h] || "");
  const fromDesign = (d, label, kind, hoopIds) => ({ label, kind, designId: d.id, designName: d.name, versionId: d.versionId, itemDesignId: null,
    stabilizer: d.stabilizer, hoopIds, hoopNames: names(hoopIds), threadColors: d.threadColors,
    machineFileKey: d.machineFileKey, machineFileName: d.machineFileName,
    blocked: d.machineFileKey ? "" : `"${d.name}" has no machine file uploaded yet` });
  // Configurable products (migrations/0036): hoopings come from the line's chosen EMBROIDERY options
  // (location order); transfer options go to Run Transfer Sheets, not here. Returns [] when the line
  // has no embroidery picks (a transfer-only line — kept out of the embroidery Run Order queue).
  const itemDesign = ctx.itemDesigns[it.itemId] || null;
  // The customer's own design, stitched (migrations/0054): the shop digitizes each location's image into
  // its own order design (order_item_designs at that location, migrations/0055), so each of those
  // hoopings waits for its upload. A line with one custom spot from before 0055 uses its '' design.
  const at = (ctx.itemDesignsAt || {})[it.itemId] || {};
  const customCount = it.config ? (it.config.locations || []).filter(l => l && l.custom && l.kind === "embroidery").length : 0;
  const customStep = (label, hoopIds, loc, where) => {
    const d = at[loc] || (customCount === 1 ? at[""] : null) || null;
    return { label, kind: "itemDesign", designId: null, designName: "Customer design", versionId: null, itemDesignLocation: loc,
      itemDesignId: d ? d.id : null, stabilizer: "", hoopIds, hoopNames: names(hoopIds),
      threadColors: d ? d.threadColors : [], machineFileKey: d ? d.machineFileKey : "", machineFileName: d ? d.machineFileName : "",
      blocked: d ? "" : `Upload the digitized stitch file for the customer's design${where ? " at " + where : ""} first (Edit items → Files → Order design)` };
  };
  // A configurable line with no options picked at all (a product offering colors only, decorated by its own designs)
  // is planned from the product's designs below, like an ordinary line.
  const picked = it.config && (it.config.locations || []).some(l => l && !l.auto && !l.fixed && l.location !== "reorderqr");
  if (it.configurable && it.config && !it.config.plain && picked) {
    for (const l of (it.config.locations || [])) {
      if (l.custom && l.kind === "embroidery") { steps.push(customStep("Customer design: " + (l.label || l.location), [], String(l.location), l.label || l.location)); continue; }
      if (l.kind !== "embroidery") continue;
      // A graphic can be sold before its stitch file exists; the piece just can't be run until one is linked.
      if (!Number(l.designId)) { steps.push({ label: l.label || l.location, kind: "design", designId: null, designName: l.graphicName || "", versionId: null,
        itemDesignId: null, stabilizer: "", hoopIds: [], hoopNames: [], threadColors: [], machineFileKey: "", machineFileName: "",
        blocked: `No stitch file linked to “${l.graphicName || l.label || "this graphic"}” yet — link a design to the graphic (Graphics screen), then Update from catalog on the order` }); continue; }
      const d = ctx.designs[Number(l.designId)];
      if (d) steps.push(fromDesign(d, l.label || l.location, "design", d.hoopIds));
      else steps.push({ label: l.label || l.location, kind: "design", designId: Number(l.designId), designName: l.graphicName || "", versionId: null,
        itemDesignId: null, stabilizer: "", hoopIds: [], hoopNames: [], threadColors: [], machineFileKey: "", machineFileName: "",
        blocked: `Design for "${l.graphicName || l.label}" is unavailable` });
    }
    return steps.map((st, i) => Object.assign(st, { stepNo: i + 1 }));
  }
  const fromItemDesign = (label, hoopIds, base) => ({ label, kind: "itemDesign", itemDesignLocation: "", designId: base ? base.id : null,
    designName: base ? base.name + " + personalization" : "Personalization", versionId: null, itemDesignId: itemDesign ? itemDesign.id : null,
    stabilizer: base ? base.stabilizer : "", hoopIds, hoopNames: names(hoopIds),
    threadColors: itemDesign ? itemDesign.threadColors : [], machineFileKey: itemDesign ? itemDesign.machineFileKey : "",
    machineFileName: itemDesign ? itemDesign.machineFileName : "",
    blocked: itemDesign ? "" : `Upload the order-specific design for "${it.persName || "the personalization"}" first` });
  const isOption = it.personalized && it.options.includes(it.persName);
  const freeText = it.personalized && !isOption;
  let pds = ctx.productDesigns[it.orgId + "|" + it.productId] || [];
  if (!pds.length && it.productDesignId != null) pds = [{ designId: it.productDesignId, placement: "", isMain: true }];
  // The customer's own design on an ordinary line replaces the product's designs. Stitched: one
  // "Customer design" hooping on the main design's hoops (any hoop when there's none) — a typed-in
  // name is digitized into that same order design. Printed as a transfer: no hooping for it at all
  // (the line goes to Run Transfer Sheets); typed-in personalization is still its own hooping.
  const custom = plainCustom_(it);
  if (custom) {
    if (custom.kind === "embroidery") {
      const main = pds.find(pd => pd.isMain) || pds[0];
      const d = main ? ctx.designs[main.designId] : null;
      steps.push(customStep("Customer design", d ? d.hoopIds : [], String(custom.location), ""));
    } else if (freeText) steps.push(fromItemDesign("Personalization", it.persHoopId ? [it.persHoopId] : [], null));
    pds = [];
  }
  let combined = false;
  for (const pd of pds) {
    const d = ctx.designs[pd.designId];
    if (!d) continue;
    const label = pd.placement || d.name;
    if (pd.isMain && freeText && it.mode === "combined") {
      combined = true;
      steps.push(fromItemDesign(label + " + personalization", d.personalizationHoopIds.length ? d.personalizationHoopIds : d.hoopIds, d));
    } else steps.push(fromDesign(d, label, "design", d.hoopIds));
  }
  if (freeText && !combined && !custom) steps.push(fromItemDesign("Personalization", it.persHoopId ? [it.persHoopId] : [], null));
  if (isOption) {
    const d = ctx.designs[Number(it.optionDesigns[it.persName])];
    if (d) steps.push(fromDesign(d, "Personalization: " + it.persName, "option", d.hoopIds));
    else steps.push({ label: "Personalization: " + it.persName, kind: "option", designId: null, designName: it.persName, versionId: null,
      itemDesignId: null, stabilizer: "", hoopIds: [], hoopNames: [], threadColors: [], machineFileKey: "", machineFileName: "",
      blocked: `No design is mapped to the pick-list option "${it.persName}" — map it on the product` });
  }
  if (!steps.length && !custom) steps.push(legacyStep_(null));
  return steps.map((st, i) => Object.assign(st, { stepNo: i + 1 }));
}

// Where a line's pieces are: [{pieceNo, done:[stepNo…], running:{runId,stepNo,…}|null, nextStepNo}]
// for every piece started but not finished. A piece whose every hooping is done has already
// been counted into manufacturedQty, so it's left out. Old runs (pieceNo NULL) are one-hooping
// pieces: only a running one is still in progress.
function pieceStates_(runs, stepCount) {
  const by = new Map(), pieces = [];
  for (const r of runs) {
    if (r.pieceNo == null) {
      if (r.status === "running") pieces.push({ pieceNo: null, done: [], nextStepNo: 1, running: runInfo_(r) });
      continue;
    }
    const k = Number(r.pieceNo);
    const p = by.get(k) || { pieceNo: k, done: [], running: null };
    if (r.status === "done") p.done.push(Number(r.stepNo)); else p.running = runInfo_(r);
    by.set(k, p);
  }
  for (const p of [...by.values()].sort((a, b) => a.pieceNo - b.pieceNo)) {
    if (new Set(p.done).size >= stepCount && !p.running) continue;
    p.done.sort((a, b) => a - b);
    let next = 1; while (p.done.includes(next)) next++;
    p.nextStepNo = p.running ? Number(p.running.stepNo) : next;
    pieces.push(p);
  }
  return { pieces };
}
const runInfo_ = (r) => ({ runId: Number(r.id), stepNo: r.stepNo == null ? 1 : Number(r.stepNo),
  machineId: r.machineId == null ? null : Number(r.machineId), machineName: r.machineName || "", startedAt: r.startedAt,
  hoopId: r.hoopId == null ? null : Number(r.hoopId) });

// The hoopings for ONE line item (start/complete use this; same plan the queue shows).
async function itemHoopings_(db, itemId) {
  try { const ctx = await hoopingContext_(db, [itemId]); return planHoopings_(ctx, ctx.items[itemId]); }
  catch (e) { if (/no such (table|column)/i.test(String(e && e.message))) return null; throw e; }
}

// Run Order's "Waiting on blanks": real orders whose blanks were ordered but haven't arrived yet
// (not manufactured, completed, voided or fully cancelled), oldest blank order first.
// Orders with at least one active line whose blank is ordered but not yet received (migrations/0039
// made this per-item). Each returned order carries only its still-awaiting lines + its shipments.
export async function getOrdersAwaitingBlanks(db) {
  const orders = await loadOrders_(db,
    `o.manufacturedAt IS NULL AND o.completedAt IS NULL AND o.voidedAt IS NULL AND o.isTest = 0
     AND EXISTS (SELECT 1 FROM order_items ai WHERE ai.orderId = o.orderId AND ai.cancelDate IS NULL
                   AND ai.blankOrderedAt IS NOT NULL AND ai.blankReceivedAt IS NULL)`,
    [], "(SELECT MIN(ai.blankOrderedAt) FROM order_items ai WHERE ai.orderId = o.orderId AND ai.cancelDate IS NULL AND ai.blankReceivedAt IS NULL) ASC, placedAt ASC");
  if (!orders.length) return [];
  return orders.map(o => {
    const waiting = o.items.filter(it => !it.cancelDate && it.blankOrderedAt && !it.blankReceivedAt);
    const first = waiting.find(it => it.blankVendor) || waiting[0] || {};
    const ests = waiting.map(it => it.blankEstDelivery).filter(Boolean).sort();
    return {
      orderId: o.orderId, orgId: o.orgId, customerName: o.customerName, placedAt: o.placedAt, dueDate: o.dueDate || "",
      blankOrderedAt: waiting.map(it => it.blankOrderedAt).filter(Boolean).sort()[0] || o.blankOrderedAt,
      blankVendor: first.blankVendor || "", blankVendorOrderId: first.blankVendorOrderId || "",
      blankEstDelivery: ests.slice(-1)[0] || "",
      items: waiting.map(it => ({ itemId: it.id, name: it.name, type: it.type, size: it.size, qty: it.qty,
        shipped: !!it.blankShippedAt })),
      shipments: o.blankShipments || [],   // attached by loadOrders_ — don't re-query (param-cap safe)
    };
  });
}

// Create a blank shipment (one tracking number) covering the given line items (migrations/0039):
// inserts blank_shipments + blank_shipment_items, stamps each item's blankShippedAt, and recomputes
// every affected order's summary. itemIds may span orders. Returns the new shipment id.
export async function addBlankShipment(db, { carrier, trackingNumber, vendor, shippedAt, itemIds }) {
  const ids = [...new Set((itemIds || []).map(Number).filter(Boolean))];
  if (!ids.length) throw pricingError_("Pick at least one item for the shipment.");
  const now = new Date().toISOString();
  const shippedIso = shippedAt && /^\d{4}-\d{2}-\d{2}/.test(String(shippedAt)) ? String(shippedAt).slice(0, 10) : now.slice(0, 10);
  // Resolve the real, active lines FIRST (ignore bogus/cancelled ids). Refuse if none resolve, so a
  // shipment row is never created without at least one covered line (which would orphan it — no
  // order view shows it, but the daily Shippo poller still processes it).
  const placeholders = ids.map(() => "?").join(",");
  const { results: rows } = await db.prepare(
    `SELECT id, orderId FROM order_items WHERE id IN (${placeholders}) AND cancelDate IS NULL`).bind(...ids).all();
  if (!rows.length) throw pricingError_("None of the selected items are valid order lines.");
  const res = await db.prepare(
    `INSERT INTO blank_shipments (carrier, trackingNumber, vendor, shippedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(String(carrier || "").slice(0, 40), String(trackingNumber || "").slice(0, 100), String(vendor || "").slice(0, 100), shippedIso, now, now).run();
  const shipmentId = Number(res.meta.last_row_id);
  const stmts = [];
  for (const r of rows) {
    stmts.push(db.prepare("INSERT OR IGNORE INTO blank_shipment_items (shipmentId, itemId) VALUES (?, ?)").bind(shipmentId, Number(r.id)));
    stmts.push(db.prepare("UPDATE order_items SET blankShippedAt = COALESCE(blankShippedAt, ?) WHERE id = ?").bind(shippedIso, Number(r.id)));
  }
  await db.batch(stmts);   // rows.length >= 1, so this is never empty
  for (const orderId of [...new Set(rows.map(r => r.orderId))]) await recomputeOrderBlankStatus_(db, orderId);
  return shipmentId;
}

export async function deleteBlankShipment(db, id) {
  const sid = Number(id);
  // Remember the lines this shipment covered + their orders, so we can clear a line's blankShippedAt
  // when no OTHER shipment still covers it, and roll the order summaries back up.
  const { results: covered } = await db.prepare(
    "SELECT si.itemId, oi.orderId FROM blank_shipment_items si JOIN order_items oi ON oi.id = si.itemId WHERE si.shipmentId=?").bind(sid).all();
  await db.prepare("DELETE FROM blank_tracking_events WHERE shipmentId=?").bind(sid).run();
  await db.prepare("DELETE FROM blank_shipment_items WHERE shipmentId=?").bind(sid).run();
  await db.prepare("DELETE FROM blank_shipments WHERE id=?").bind(sid).run();
  for (const r of covered) {
    const still = await db.prepare("SELECT 1 FROM blank_shipment_items WHERE itemId=? LIMIT 1").bind(Number(r.itemId)).first();
    if (!still) await db.prepare("UPDATE order_items SET blankShippedAt=NULL WHERE id=?").bind(Number(r.itemId)).run();
  }
  for (const orderId of [...new Set(covered.map(r => r.orderId))]) await recomputeOrderBlankStatus_(db, orderId);
}

// Edit an existing shipment (migrations/0039): correct its carrier/tracking/ship date and which line
// items it covers, keeping its id (and scan history, unless the tracking number itself changes — then
// the old events/status are cleared so the next poll refetches for the new number).
export async function updateBlankShipment(db, id, { carrier, trackingNumber, shippedAt, itemIds }) {
  const sid = Number(id);
  const ids = [...new Set((itemIds || []).map(Number).filter(Boolean))];
  if (!ids.length) throw pricingError_("Pick at least one item for the shipment.");
  const before = await db.prepare("SELECT trackingNumber FROM blank_shipments WHERE id=?").bind(sid).first();
  if (!before) throw pricingError_("That shipment no longer exists.");
  // Resolve the real active lines BEFORE touching anything, and refuse if none resolve — otherwise
  // the item-set replacement below would leave the shipment covering zero lines (an orphan).
  const placeholders = ids.map(() => "?").join(",");
  const { results: rows } = await db.prepare(
    `SELECT id, orderId FROM order_items WHERE id IN (${placeholders}) AND cancelDate IS NULL`).bind(...ids).all();
  if (!rows.length) throw pricingError_("None of the selected items are valid order lines.");
  const now = new Date().toISOString();
  const newTrack = String(trackingNumber || "").slice(0, 100);
  const shippedIso = shippedAt && /^\d{4}-\d{2}-\d{2}/.test(String(shippedAt)) ? String(shippedAt).slice(0, 10) : null;
  const trackChanged = newTrack !== (before.trackingNumber || "");
  await db.prepare(
    `UPDATE blank_shipments SET carrier=?, trackingNumber=?, shippedAt=COALESCE(?, shippedAt), updatedAt=?${trackChanged ? ", status='', statusDetail='', statusDate=NULL, deliveredAt=NULL, lastCheckedAt=NULL" : ""} WHERE id=?`
  ).bind(String(carrier || "").slice(0, 40), newTrack, shippedIso, now, sid).run();
  if (trackChanged) await db.prepare("DELETE FROM blank_tracking_events WHERE shipmentId=?").bind(sid).run();
  // Replace the covered-items set.
  const prev = (await db.prepare("SELECT itemId, (SELECT orderId FROM order_items WHERE id=blank_shipment_items.itemId) AS orderId FROM blank_shipment_items WHERE shipmentId=?").bind(sid).all()).results || [];
  await db.prepare("DELETE FROM blank_shipment_items WHERE shipmentId=?").bind(sid).run();
  const stmts = [];
  const shipDate = shippedIso || now.slice(0, 10);
  for (const r of rows) {
    stmts.push(db.prepare("INSERT OR IGNORE INTO blank_shipment_items (shipmentId, itemId) VALUES (?, ?)").bind(sid, Number(r.id)));
    stmts.push(db.prepare("UPDATE order_items SET blankShippedAt = COALESCE(blankShippedAt, ?) WHERE id = ?").bind(shipDate, Number(r.id)));
  }
  if (stmts.length) await db.batch(stmts);
  // A line dropped from this shipment and covered by no other loses its shipped stamp.
  for (const p of prev) {
    if (rows.some(r => Number(r.id) === Number(p.itemId))) continue;
    const still = await db.prepare("SELECT 1 FROM blank_shipment_items WHERE itemId=? LIMIT 1").bind(Number(p.itemId)).first();
    if (!still) await db.prepare("UPDATE order_items SET blankShippedAt=NULL WHERE id=?").bind(Number(p.itemId)).run();
  }
  const orderIds = [...new Set([...rows.map(r => r.orderId), ...prev.map(p => p.orderId)].filter(Boolean))];
  for (const orderId of orderIds) await recomputeOrderBlankStatus_(db, orderId);
}

// Active blank shipments to poll (not delivered, has a tracking number), oldest-checked first, with
// a representative order/org/customer (the first covered active line) for notices + the roll-up.
export async function listActiveBlankShipments(db, limit = 40) {
  const { results } = await db.prepare(
    `SELECT s.id, s.carrier, s.trackingNumber, s.status,
            (SELECT oi.orderId FROM blank_shipment_items si JOIN order_items oi ON oi.id = si.itemId WHERE si.shipmentId = s.id LIMIT 1) AS orderId,
            (SELECT oi.orgId   FROM blank_shipment_items si JOIN order_items oi ON oi.id = si.itemId WHERE si.shipmentId = s.id LIMIT 1) AS orgId,
            (SELECT o.customerName FROM blank_shipment_items si JOIN order_items oi ON oi.id = si.itemId JOIN orders o ON o.orderId = oi.orderId WHERE si.shipmentId = s.id LIMIT 1) AS customerName
     FROM blank_shipments s
     WHERE s.deliveredAt IS NULL AND s.trackingNumber <> ''
       AND EXISTS (SELECT 1 FROM blank_shipment_items si JOIN order_items oi ON oi.id = si.itemId WHERE si.shipmentId = s.id)
     ORDER BY (s.lastCheckedAt IS NOT NULL), s.lastCheckedAt, s.id
     LIMIT ?`).bind(Math.max(1, Math.min(200, Number(limit) || 40))).all();
  return results.map(r => ({ id: Number(r.id), carrier: r.carrier || "", trackingNumber: r.trackingNumber || "",
    status: r.status || "", orderId: r.orderId || "", orgId: r.orgId || "", customerName: r.customerName || "" }));
}

export async function recordBlankTrackingEvents(db, shipmentId, events) {
  const list = (events || []).filter(e => e && (e.status || e.occurredAt));
  if (!list.length) return 0;
  const now = new Date().toISOString();
  // Each poll re-reports the carrier's FULL history, so read the scans already stored and only insert
  // genuinely-new ones — the batch holds just the new rows instead of mostly-ignored inserts, and the
  // return value is the real new-event count. UNIQUE(shipmentId,status,occurredAt) remains the backstop
  // for a concurrent double-insert. (Two same-status scans that both lack a carrier timestamp still
  // collapse to one row — vanishingly rare, and widening the key would need a table rebuild.)
  const seen = new Set();
  try {
    const { results } = await db.prepare("SELECT status, occurredAt FROM blank_tracking_events WHERE shipmentId=?").bind(Number(shipmentId)).all();
    for (const r of results) seen.add((r.status || "") + "|" + (r.occurredAt || ""));
  } catch (e) { /* table missing or read failed — fall back to insert-or-ignore for all */ }
  const stmts = [];
  for (const e of list) {
    const key = String(e.status || "") + "|" + String(e.occurredAt || "");
    if (seen.has(key)) continue;
    seen.add(key);   // also de-dup within this batch
    stmts.push(db.prepare("INSERT OR IGNORE INTO blank_tracking_events (shipmentId, status, statusDetail, location, occurredAt, recordedAt) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(Number(shipmentId), String(e.status || ""), String(e.statusDetail || ""), String(e.location || ""), String(e.occurredAt || ""), now));
  }
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

export async function setBlankShipmentStatus(db, shipmentId, { status, statusDetail, statusDate, deliveredAt }) {
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE blank_shipments SET status=?, statusDetail=?, statusDate=?, deliveredAt=COALESCE(deliveredAt, ?), lastCheckedAt=?, updatedAt=? WHERE id=?`
  ).bind(String(status || ""), String(statusDetail || ""), statusDate || null, deliveredAt || null, now, now, Number(shipmentId)).run();
}

// A blank shipment's full detail: latest status + covered item ids + the per-scan event history.
export async function getBlankShipmentsForOrder(db, orderId) {
  const map = await blankShipmentsByOrder_(db, [orderId]);  // already carries each shipment's events
  return map[orderId] || [];
}

// Shipments (with latest status + covered item ids) grouped by order.
// `scope` is EITHER a small array of order ids, OR { sub, binds } where `sub` is a SELECT that
// returns the order ids and `binds` its parameters — the subquery form avoids D1's ~100-bound-
// parameter cap on a large Orders page (the same trick loadOrders_ uses for its other child joins;
// an expanded `?,?,?…` id list silently threw past ~100 orders, dropping all shipment data).
async function blankShipmentsByOrder_(db, scope) {
  const out = byId_();
  const isSub = scope && !Array.isArray(scope) && typeof scope.sub === "string";
  const orderIds = isSub ? null : (scope || []);
  if (!isSub && !orderIds.length) return out;
  const inClause = isSub ? scope.sub : orderIds.map(() => "?").join(",");
  const whereBinds = isSub ? (scope.binds || []) : orderIds;
  let rows = [];
  try {
    const r = await db.prepare(
      `SELECT DISTINCT s.id, s.carrier, s.trackingNumber, s.vendor, s.shippedAt, s.status, s.statusDetail,
              s.statusDate, s.deliveredAt, s.lastCheckedAt, oi.orderId, si.itemId
       FROM blank_shipments s
       JOIN blank_shipment_items si ON si.shipmentId = s.id
       JOIN order_items oi ON oi.id = si.itemId
       WHERE oi.orderId IN (${inClause})
       ORDER BY s.createdAt`).bind(...whereBinds).all();
    rows = r.results || [];
  } catch (e) {
    // A pre-migration DB has no blank_shipment tables — return empty. Any OTHER error is real
    // (don't let it masquerade as "no shipments" the way a blanket catch would).
    if (/no such (table|column)/i.test(String(e && e.message))) return out;
    throw e;
  }
  const byId = {}, byShipId = {};
  for (const r of rows) {
    const key = r.orderId + "|" + r.id;
    if (!byId[key]) { byId[key] = { id: Number(r.id), carrier: r.carrier || "", trackingNumber: r.trackingNumber || "",
      vendor: r.vendor || "", shippedAt: r.shippedAt || "", status: r.status || "", statusDetail: r.statusDetail || "",
      statusDate: r.statusDate || "", deliveredAt: r.deliveredAt || "", lastCheckedAt: r.lastCheckedAt || "", itemIds: [], events: [] };
      (out[r.orderId] = out[r.orderId] || []).push(byId[key]);
      (byShipId[r.id] = byShipId[r.id] || []).push(byId[key]); }   // a shipment can appear under several orders
    byId[key].itemIds.push(Number(r.itemId));
  }
  // Attach each shipment's full per-scan carrier history (newest first) in one query, scoped through
  // the SAME order filter (not an expanded shipment-id list — that would re-introduce the param cap).
  if (Object.keys(byShipId).length) {
    try {
      const ev = await db.prepare(
        `SELECT shipmentId, status, statusDetail, location, occurredAt FROM blank_tracking_events
         WHERE shipmentId IN (
           SELECT DISTINCT si.shipmentId FROM blank_shipment_items si
           JOIN order_items oi ON oi.id = si.itemId WHERE oi.orderId IN (${inClause}))
         ORDER BY occurredAt DESC, id DESC`).bind(...whereBinds).all();
      for (const e of (ev.results || [])) for (const s of (byShipId[e.shipmentId] || []))
        s.events.push({ status: e.status || "", statusDetail: e.statusDetail || "", location: e.location || "", occurredAt: e.occurredAt || "" });
    } catch (e) { if (!/no such (table|column)/i.test(String(e && e.message))) throw e; /* pre-migration DB */ }
  }
  return out;
}

// Every paid order not yet run (migrations/0038) — the run pages' due-date-ordered backlog. Paid,
// real, not voided/completed, not yet manufactured, with at least one active line. Soonest-due
// first, undated after all dated, then oldest-placed. blankReceived lets the UI flag what's ready.
export async function getPaidUnrunOrders(db) {
  const orders = await loadOrders_(db,
    `o.paid = 1 AND o.isTest = 0 AND o.voidedAt IS NULL AND o.manufacturedAt IS NULL AND o.completedAt IS NULL AND o.shippedAt IS NULL AND o.deliveredAt IS NULL
     AND EXISTS (SELECT 1 FROM order_items ai WHERE ai.orderId = o.orderId AND ai.cancelDate IS NULL)`,
    [], "(o.dueDate IS NULL) ASC, o.dueDate ASC, placedAt ASC");
  const orgNames = {};
  for (const org of await getAllOrgs(db)) orgNames[org.orgId] = org.name || org.orgId;
  // Whose waiting blanks the stock on hand covers — soonest due first, the same order as the list.
  const stock = await getBlankStockCoverage(db, orders.filter(o => !o.blankOrderedAt).map(o => o.orderId));
  return orders.map(o => ({
    orderId: o.orderId, orgId: o.orgId, orgName: orgNames[o.orgId] || o.orgId,
    customerName: o.customerName, placedAt: o.placedAt, dueDate: o.dueDate || "",
    blankReceived: !!o.blankReceivedAt, blankOrdered: !!o.blankOrderedAt,
    blanksInStock: !o.blankOrderedAt && !!(stock[o.orderId] && stock[o.orderId].covered),
    needsBlanks: o.needsBlanks !== false,   // false: nothing on it uses a blank (migrations/0057)
    allFromStock: !!o.allFromStock,         // every line comes from finished stock (migrations/0060)
    items: o.items.filter(it => !it.cancelDate).map(it => ({ name: it.name, size: it.size, qty: it.qty })),
  }));
}

// ---- Inventory movements & COGS (migrations/0009) -------------------------
// Every stock change is a movement; blank_sizes.quantity is a cache of their
// sum and blank_sizes.purchasePriceCents the running weighted-average cost.

async function blankName_(db, blankId) {
  const b = await db.prepare("SELECT name, brand, color FROM blanks WHERE id=?").bind(Number(blankId)).first();
  return b ? (b.name || [b.brand, b.color].filter(Boolean).join(" ")) : "";
}

// The blank's legacy scalar color, used as the default color dimension when a caller omits one
// (migrations/0037 backfilled a single-color blank's stock + links to this value). An explicit ''
// still means the empty color; only an omitted (null/undefined) color falls back here.
async function blankScalarColor_(db, blankId) {
  const b = await db.prepare("SELECT color FROM blanks WHERE id=?").bind(Number(blankId)).first();
  return b ? (b.color || "") : "";
}

// The INSERT for one movement as a prepared statement (not run), so callers can put it in a
// db.batch() with the stock update it belongs to — one transaction, never half-applied.
// m.blankName must already be resolved (blankName_).
// m.reason (migrations/0060): a write-off's reason (WRITEOFF_REASONS), or 'finished' on a consume
// that moved the blank into finished stock. Only written when given.
function movementStmt_(db, m) {
  const now = new Date().toISOString();
  const withReason = !!m.reason;
  return db.prepare(
    `INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, orderId, itemId, vendor, vendorRef, note, occurredAt, createdAt, vendorChargedTax, accountId, paidPersonally, receiptKey, receiptName, receiptGroup${withReason ? ", reason" : ""})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${withReason ? ", ?" : ""})`
  ).bind(Number(m.blankId), m.blankName || "", m.color || "", m.size || "", Math.trunc(m.qtyDelta),
    Math.max(0, Math.round(Number(m.unitCostCents) || 0)), m.kind, m.orderId || null, m.itemId || null,
    String(m.vendor || "").slice(0, 100), String(m.vendorRef || "").slice(0, 100), String(m.note || "").slice(0, 300),
    m.occurredAt || now, now, m.vendorChargedTax ? 1 : 0, m.accountId ? Number(m.accountId) : null, m.paidPersonally ? 1 : 0,
    String(m.receiptKey || "").slice(0, 300), String(m.receiptName || "").slice(0, 200), m.receiptGroup ? String(m.receiptGroup).slice(0, 64) : null,
    ...(withReason ? [String(m.reason).slice(0, 20)] : []));
}

async function insertMovement_(db, m) {
  const r = await movementStmt_(db, { ...m, blankName: m.blankName || await blankName_(db, m.blankId) }).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

// Blanks received from a vendor: lines = [{ size, qty, unitCost }] (dollars).
// Updates each size's weighted-average cost and stock.
// Landed cost: spreads shipping/other costs (extraCents) over the sizes in
// proportion to each size's cost (by quantity if every size cost $0), with
// largest-remainder rounding so the cents add up exactly, then turns each
// size's landed total into whole-cent unit costs — a total that doesn't
// divide evenly becomes two unit costs a cent apart (4 for $24.50 →
// 2 × $6.12 + 2 × $6.13). in: [{size, qty, cents}] → [{size, qty, unitCost}].
// Splits extraCents over parts in proportion to their weights, whole cents
// that always add back up exactly (largest remainder). All-zero weights → all 0.
export function spreadCents(weights, extraCents) {
  const extra = Math.max(0, Math.round(Number(extraCents) || 0));
  const w = weights.map(x => Math.max(0, Number(x) || 0)), totalW = w.reduce((a, x) => a + x, 0);
  const shares = w.map(x => totalW ? extra * x / totalW : 0);
  const alloc = shares.map(Math.floor);
  let left = totalW ? extra - alloc.reduce((a, c) => a + c, 0) : 0;
  shares.map((sh, i) => [sh - Math.floor(sh), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { alloc[i]++; left--; } });
  return alloc;
}

export function landedCostLines(sizes, extraCents = 0) {
  const rows = sizes.filter(x => Number(x.qty) > 0).map(x => ({ color: x.color || "", size: x.size, qty: Math.floor(Number(x.qty)), cents: Math.max(0, Math.round(Number(x.cents) || 0)) }));
  const byValue = rows.some(r => r.cents > 0);
  const alloc = spreadCents(rows.map(r => byValue ? r.cents : r.qty), extraCents);
  const out = [];
  rows.forEach((r, i) => {
    const cents = r.cents + alloc[i], base = Math.floor(cents / r.qty), up = cents - base * r.qty;
    if (r.qty - up > 0) out.push({ color: r.color, size: r.size, qty: r.qty - up, unitCost: base / 100 });
    if (up > 0) out.push({ color: r.color, size: r.size, qty: up, unitCost: (base + 1) / 100 });
  });
  return out;
}

// Returns the new purchase movements' ids (one per size received).
export async function receiveBlanks(db, { blankId, lines, vendor, vendorRef, receivedAt, vendorChargedTax, accountId, paidPersonally, note, receiptKey, receiptName, receiptGroup }) {
  const name = await blankName_(db, blankId);
  const defColor = await blankScalarColor_(db, blankId);
  const ids = [];
  for (const l of lines) {
    const color = (l.color == null ? defColor : String(l.color)).slice(0, 80);
    const size = String(l.size || "").slice(0, 20);
    const qty = Math.floor(Number(l.qty) || 0);
    const costCents = Math.max(0, toCents(l.unitCost));
    if (qty <= 0) continue;
    // The movement and the stock/average-cost update commit together (one batch = one
    // transaction), and the new weighted average is computed INSIDE the upsert from the row's
    // current values — two receives of the same color+size can't both start from a stale average.
    // Same formula as before: round((onHand × avg + qty × cost) / (onHand + qty)), onHand ≥ 0.
    const res = await db.batch([
      movementStmt_(db, { blankId, blankName: name, color, size, qtyDelta: qty, unitCostCents: costCents, kind: "purchase",
        vendor, vendorRef, note: note || "Received", occurredAt: receivedAt, vendorChargedTax: !!vendorChargedTax,
        accountId: paidPersonally ? null : (accountId || null), paidPersonally: !!paidPersonally, receiptKey, receiptName, receiptGroup }),
      db.prepare(
        `INSERT INTO blank_sizes (blankId, color, size, purchasePriceCents, quantity) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(blankId, color, size) DO UPDATE SET
           purchasePriceCents = CAST(ROUND((MAX(blank_sizes.quantity, 0) * blank_sizes.purchasePriceCents + ? * ?) * 1.0
                                           / (MAX(blank_sizes.quantity, 0) + ?)) AS INTEGER),
           quantity = blank_sizes.quantity + ?`
      ).bind(Number(blankId), color, size, costCents, qty, qty, costCents, qty, qty),
    ]);
    ids.push(Number(res[0] && res[0].meta && res[0].meta.last_row_id) || 0);
  }
  return ids;
}

// Blanks removed from stock without a sale — damaged, lost/miscounted, or used for
// testing/samples/shop scrap (qty > 0 = units removed), at the blank's current average
// cost. Reduces ending inventory the same way any write-off does (Schedule C Part III).
// `reason` (migrations/0060, WRITEOFF_REASONS) lets the Inventory & COGS report show testing use
// apart from damage and loss; `note` keeps the wording.
export const WRITEOFF_REASONS = ["testing", "damaged", "lost", "other"];
export async function writeOffBlanks(db, { blankId, color, size, qty, note, occurredAt, reason }) {
  const q = Math.floor(Number(qty) || 0);
  if (q <= 0) return;
  const clr = color == null ? await blankScalarColor_(db, blankId) : String(color);
  const cur = await db.prepare("SELECT purchasePriceCents FROM blank_sizes WHERE blankId=? AND color=? AND size=?").bind(Number(blankId), clr, size).first();
  await db.batch([
    movementStmt_(db, { blankId, blankName: await blankName_(db, blankId), color: clr, size, qtyDelta: -q, unitCostCents: cur ? cur.purchasePriceCents : 0,
      kind: "writeoff", note: note || "Write-off", occurredAt, reason: WRITEOFF_REASONS.includes(reason) ? reason : "other" }),
    db.prepare("UPDATE blank_sizes SET quantity = quantity - ? WHERE blankId=? AND color=? AND size=?").bind(q, Number(blankId), clr, size),
  ]);
}

// Called when an order is marked "manufactured": each active line whose
// product is linked to a blank consumes qty blanks at the current average
// cost, and that becomes the line's COGS. Idempotent (skips lines that
// already have a cost). Unlinked lines are left without a cost — the
// Inventory & COGS report lists them so the link can be added.
//
// makeItemPieces_ is the single consume primitive — the whole-order path and the per-piece Run
// Order path both go through it, so cost/stock are computed identically however the line is made.
// It moves ONE line's manufacturedQty from `fromQty` to `toQty`, consuming (toQty − fromQty)
// blanks at the current weighted-average cost: a dated `consume` movement, lower stock, and the
// line's COGS ACCUMULATED (a migration-era 'estimate' cost is overwritten on the first real piece).
//
// ATOMIC + RACE-SAFE: everything is one db.batch() (one transaction), and every statement in it is
// conditioned on the line's manufacturedQty still being `fromQty` — the value the caller read. The
// claim (manufacturedQty = toQty) runs LAST. Batches run one at a time, so if two requests (a
// double-click, two tabs, Run Order + Orders) read the same fromQty, the second batch finds the
// count already moved and every statement in it matches nothing: no second consume, no stock or
// COGS change. Returns { claimed, consumed }: claimed=false means someone else got there first.
async function makeItemPieces_(db, item, fromQty, toQty) {
  const pieces = toQty - fromQty;
  if (pieces <= 0) return { claimed: false, consumed: false };
  const id = Number(item.id);
  const productColor = String(item.color || "");
  const stillAt = "(SELECT COALESCE(manufacturedQty,0) FROM order_items WHERE id = ? AND cancelDate IS NULL) = ?";
  const link = await db.prepare(
    "SELECT blankId, blankColor, blankSize FROM product_blank_links WHERE orgId = ? AND productId = ? AND productColor = ? AND productSize = ?"
  ).bind(item.orgId, item.productId, productColor, item.size).first();
  const stmts = [];
  // A line filled from finished stock (migrations/0060) is PULLED instead: the pieces leave finished stock
  // at its average cost — that's the line's cost of goods — and no blank is used.
  if (item.fromStock && Number(item.fromStock)) {
    const p = await db.prepare("SELECT name, pricingMode FROM products WHERE orgId = ? AND productId = ?").bind(item.orgId, item.productId).first();
    const sz = stockSize_(p && p.pricingMode, item.size), now = new Date().toISOString();
    const avgSql = "MAX(0, COALESCE((SELECT avgCostCents FROM ready_to_ship WHERE orgId = ? AND productId = ? AND size = ?), 0))", ab = [item.orgId, item.productId, sz];
    stmts.push(db.prepare(
      `INSERT INTO finished_goods_movements (orgId, productId, productName, color, size, qtyDelta, unitCostCents, kind, orderId, itemId, note, occurredAt, createdAt)
       SELECT ?, ?, ?, '', ?, ?, ${avgSql}, 'sell', ?, ?, ?, ?, ? WHERE ${stillAt}`
    ).bind(item.orgId, item.productId, (p && p.name) || item.productId, sz, -pieces, ...ab, item.orderId, id, ("Pulled for order " + item.orderId).slice(0, 300), now, now, id, fromQty));
    stmts.push(db.prepare(
      `UPDATE order_items SET cogsCents = (CASE WHEN cogsSource='consumed' THEN COALESCE(cogsCents,0) ELSE 0 END) + ? * ${avgSql}, cogsSource = 'consumed'
       WHERE id = ? AND cancelDate IS NULL AND COALESCE(manufacturedQty,0) = ?`).bind(pieces, ...ab, id, fromQty));
    stmts.push(db.prepare(`UPDATE ready_to_ship SET quantity = quantity - ?, updatedAt = ? WHERE orgId = ? AND productId = ? AND size = ? AND ${stillAt}`)
      .bind(pieces, now, ...ab, id, fromQty));
    stmts.push(db.prepare("UPDATE order_items SET manufacturedQty = ? WHERE id = ? AND cancelDate IS NULL AND COALESCE(manufacturedQty,0) = ?").bind(toQty, id, fromQty));
    const res = await db.batch(stmts);
    const claimed = Number(res.at(-1) && res.at(-1).meta && res.at(-1).meta.changes) === 1;
    return { claimed, consumed: claimed };
  }
  const linked = !!(link && link.blankId != null);
  if (linked) {
    const blankId = Number(link.blankId), color = link.blankColor || "", size = link.blankSize || "";
    const avgSql = "COALESCE((SELECT purchasePriceCents FROM blank_sizes WHERE blankId = ? AND color = ? AND size = ?), 0)";
    const now = new Date().toISOString();
    stmts.push(db.prepare(
      `INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, orderId, itemId, vendor, vendorRef, note, occurredAt, createdAt, vendorChargedTax, accountId, paidPersonally, receiptKey, receiptName)
       SELECT ?, ?, ?, ?, ?, MAX(0, ${avgSql}), 'consume', ?, ?, '', '', ?, ?, ?, 0, NULL, 0, '', '' WHERE ${stillAt}`
    ).bind(blankId, await blankName_(db, blankId), color, size, -pieces, blankId, color, size, item.orderId, id,
      ("Used for order " + item.orderId).slice(0, 300), now, now, id, fromQty));
    stmts.push(db.prepare(
      `UPDATE order_items SET cogsCents = (CASE WHEN cogsSource='consumed' THEN COALESCE(cogsCents,0) ELSE 0 END) + ? * MAX(0, ${avgSql}),
         cogsSource = 'consumed'
       WHERE id = ? AND cancelDate IS NULL AND COALESCE(manufacturedQty,0) = ?`
    ).bind(pieces, blankId, color, size, id, fromQty));
    stmts.push(db.prepare(`UPDATE blank_sizes SET quantity = quantity - ? WHERE blankId = ? AND color = ? AND size = ? AND ${stillAt}`)
      .bind(pieces, blankId, color, size, id, fromQty));
  }
  stmts.push(db.prepare("UPDATE order_items SET manufacturedQty = ? WHERE id = ? AND cancelDate IS NULL AND COALESCE(manufacturedQty,0) = ?")
    .bind(toQty, id, fromQty));
  const res = await db.batch(stmts);
  const claimed = Number(res.at(-1) && res.at(-1).meta && res.at(-1).meta.changes) === 1;
  return { claimed, consumed: claimed && linked };
}

// Making the WHOLE order: consume whatever pieces each active line still has left (so calling this
// after some pieces were already made per-piece never double-consumes), and mark every active line
// fully made. Idempotent — a line with nothing remaining is skipped, and a line another request is
// finishing at the same moment is consumed by exactly one of them.
// The garment color an order line consumes stock in: a configurable line's chosen
// config.garmentColor, else '' (a classic single-color product). Used to resolve the color-aware
// product_blank_links row (migrations/0037).
export const itemColorOf_ = (row) => itemColor_(row);   // for supplierOrders.js
function itemColor_(row) {
  const cfg = tryParse_(row.configJson, null);
  return cfg && cfg.garmentColor ? String(cfg.garmentColor) : "";
}

export async function consumeBlanksForOrder(db, orderId) {
  const fs = await hasFromStockColumn_(db);
  const { results: items } = await db.prepare(
    `SELECT id, orderId, orgId, productId, size, qty, configJson, COALESCE(manufacturedQty,0) AS manufacturedQty${fs ? ", fromStock" : ""}
     FROM order_items WHERE orderId = ? AND cancelDate IS NULL`
  ).bind(orderId).all();
  let consumed = 0;
  for (const it of items) {
    const qty = Math.max(1, Number(it.qty) || 1);
    const made = Math.max(0, Number(it.manufacturedQty) || 0);
    if (made >= qty) continue;
    if ((await makeItemPieces_(db, { ...it, color: itemColor_(it) }, made, qty)).consumed) consumed++;
  }
  return consumed;
}

// Mark ONE physical piece of a line item manufactured: consume one blank for it and bump its
// manufacturedQty. When every active line of the order has reached its qty, stamp the order-level
// orders.manufacturedAt (the "fully made" signal the rest of the app keys off). Per-piece is how
// the Run Order screen lets qty>1 lines be split across machines and finished independently.
// If a concurrent request claims the same piece first, this re-reads and makes the NEXT piece
// (both clicks meant "one more piece done"), or reports the line complete if none are left.
export async function markItemPieceManufactured(db, orderId, itemId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const item = await db.prepare(
      `SELECT id, orderId, orgId, productId, size, qty, configJson, COALESCE(manufacturedQty,0) AS manufacturedQty, cancelDate${(await hasFromStockColumn_(db)) ? ", fromStock" : ""}
       FROM order_items WHERE id = ? AND orderId = ?`
    ).bind(Number(itemId), orderId).first();
    if (!item) throw new Error("Line item not found");
    if (item.cancelDate) throw new Error("That line item is cancelled");
    item.color = itemColor_(item);
    const qty = Math.max(1, Number(item.qty) || 1);
    const made = Math.max(0, Number(item.manufacturedQty) || 0);
    if (made >= qty) {
      return { alreadyComplete: true, orderComplete: await maybeCompleteManufacture_(db, orderId) };
    }
    if ((await makeItemPieces_(db, item, made, made + 1)).claimed) {
      // When the last piece lands, consume the line's transfer applications once (migrations/0036).
      if (made + 1 >= qty) await consumeLineTransfersOnce_(db, orderId, Number(itemId));
      return { pieceMarked: true, orderComplete: await maybeCompleteManufacture_(db, orderId) };
    }
  }
  throw new Error("This line is being updated by another request — refresh and try again");
}

// A local sale is handed over on the spot (migrations/0060): its lines filled from finished stock are
// pulled at once (their cost of goods recorded), without making anything else on the order. When every
// active line is from stock, the order is made too. Returns the number of lines pulled.
export async function pullStockLines(db, orderId) {
  if (!(await hasFromStockColumn_(db))) return 0;
  const { results: items } = await db.prepare(
    `SELECT id, orderId, orgId, productId, size, qty, configJson, COALESCE(manufacturedQty,0) AS manufacturedQty, fromStock
     FROM order_items WHERE orderId = ? AND cancelDate IS NULL AND fromStock = 1`).bind(orderId).all();
  let n = 0;
  for (const it of items) {
    const qty = Math.max(1, Number(it.qty) || 1), made = Math.max(0, Number(it.manufacturedQty) || 0);
    if (made < qty && (await makeItemPieces_(db, { ...it, color: "" }, made, qty)).claimed) n++;
  }
  if (n) await maybeCompleteManufacture_(db, orderId);
  return n;
}

// Stamp orders.manufacturedAt once every active line is fully made; no-op (and returns false)
// while any active line still has pieces left. Idempotent — never moves an existing timestamp.
async function maybeCompleteManufacture_(db, orderId) {
  // Lines filled from finished stock (migrations/0060) aren't run: once every MADE line is done, they're
  // pulled from stock here, so an order mixing both completes when its last piece is made on Run Order.
  const fs = await hasFromStockColumn_(db);
  const row = await db.prepare(
    `SELECT COUNT(*) AS remaining FROM order_items
     WHERE orderId = ? AND cancelDate IS NULL AND COALESCE(manufacturedQty,0) < qty${fs ? " AND COALESCE(fromStock,0) = 0" : ""}`
  ).bind(orderId).first();
  if (Number(row && row.remaining) > 0) return false;
  if (fs) await consumeBlanksForOrder(db, orderId);   // pulls whatever stock lines are left (the made ones are skipped)
  await db.prepare("UPDATE orders SET manufacturedAt = COALESCE(manufacturedAt, ?) WHERE orderId = ?")
    .bind(new Date().toISOString(), orderId).run();
  return true;
}

// ---- Run tracking (migrations/0030) ------------------------------------------
// A production_runs row is one physical piece actually run on a machine, with start/finish times.
// A running row (status='running') is the sole source of truth for "piece in progress" AND
// "machine busy". machineName/designName/abortReasonLabel are snapshotted so the report survives a
// later rename/delete. Abort reasons are a tiny managed list, same shape as hoops.

function parseAbortReason_(r) {
  return { id: Number(r.id), label: r.label || "", sortOrder: Number(r.sortOrder) || 0 };
}

export async function listAbortReasons(db) {
  const { results } = await db.prepare("SELECT * FROM run_abort_reasons ORDER BY sortOrder, label").all();
  return results.map(parseAbortReason_);
}

export async function createAbortReason(db, fields) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    "INSERT INTO run_abort_reasons (label, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?)"
  ).bind(String(fields.label || "").slice(0, 100), Number(fields.sortOrder) || 0, now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

export async function updateAbortReason(db, id, fields) {
  await db.prepare("UPDATE run_abort_reasons SET label=?, sortOrder=?, updatedAt=? WHERE id=?")
    .bind(String(fields.label || "").slice(0, 100), Number(fields.sortOrder) || 0, new Date().toISOString(), Number(id)).run();
}

// Always safe to delete — runs snapshot abortReasonLabel, so no row depends on the id surviving.
export async function deleteAbortReason(db, id) {
  await db.prepare("DELETE FROM run_abort_reasons WHERE id=?").bind(Number(id)).run();
}

// The running runs right now, for the Run Order screen: which piece is in progress and which
// machines are therefore busy. Newest first.
export async function listActiveRuns(db) {
  const { results } = await db.prepare(
    `SELECT * FROM production_runs WHERE status='running' ORDER BY startedAt DESC, id DESC`
  ).all();
  return results.map(r => ({
    runId: Number(r.id), orgId: r.orgId, orderId: r.orderId, itemId: Number(r.itemId),
    machineId: r.machineId == null ? null : Number(r.machineId), machineName: r.machineName || "",
    designId: r.designId == null ? null : Number(r.designId), designName: r.designName || "", startedAt: r.startedAt,
    pieceNo: r.pieceNo == null ? null : Number(r.pieceNo), stepNo: r.stepNo == null ? null : Number(r.stepNo),
    stepCount: r.stepCount == null ? null : Number(r.stepCount), stepLabel: r.stepLabel || "",
    hoopId: r.hoopId == null ? null : Number(r.hoopId),
  }));
}

// Snapshots the machine + current design (same joins getProductionQueue uses) and opens a running
// run. Refuses if the machine is already running a job, or if the line has no piece left to start
// (every piece is already made or in progress).
// Starts one HOOPING of one piece (migrations/0032). pieceNo omitted = a new piece (its first
// hooping); otherwise the piece's next undone hooping (stepNo, if given, must be that one). With
// untimed = true the hooping is recorded as already done ("Mark done (no timing)") and kept out of
// the timing report. Snapshots the machine, the hooping's design (or order-specific design) and
// hoop; the machine's mounted hoop is updated to the one used. Returns {runId, pieceNo, stepNo}.
export async function startHooping(db, { orgId, orderId, itemId, machineId, pieceNo, stepNo, hoopId, untimed = false }) {
  const item = await db.prepare(
    `SELECT id, orgId, orderId, productId, qty, COALESCE(manufacturedQty,0) AS manufacturedQty, cancelDate
     FROM order_items WHERE id=? AND orderId=?`
  ).bind(Number(itemId), orderId).first();
  if (!item) throw new Error("Line item not found");
  if (item.cancelDate) throw new Error("That line item is cancelled");
  machineId = machineId == null || machineId === "" ? null : Number(machineId);
  if (machineId && !untimed) {
    const busy = await db.prepare("SELECT COUNT(*) n FROM production_runs WHERE machineId=? AND status='running'").bind(machineId).first();
    if (Number(busy && busy.n) > 0) throw new Error("That machine is already running a job");
  }
  const steps = await itemHoopings_(db, Number(itemId));
  if (!steps) return legacyStartRun_(db, { orgId, orderId, itemId, machineId }); // pre-0032 database
  const { results: runs } = await db.prepare(
    "SELECT id, pieceNo, stepNo, status FROM production_runs WHERE itemId=? AND status IN ('running','done')").bind(Number(itemId)).all();
  const qty = Math.max(1, Number(item.qty) || 1), made = Math.max(0, Number(item.manufacturedQty) || 0);
  const { pieces } = pieceStates_(runs, steps.length);
  if (pieceNo == null || pieceNo === "") {
    if (made + pieces.length >= qty) throw new Error("Every piece of this line is already started or made");
    const maxNo = runs.reduce((m, r) => Math.max(m, Number(r.pieceNo) || 0), made);
    pieceNo = maxNo + 1;
    if (stepNo != null && Number(stepNo) !== 1) throw new Error("A new piece starts with hooping 1");
    stepNo = 1;
  } else {
    pieceNo = Number(pieceNo);
    const p = pieces.find(x => x.pieceNo === pieceNo);
    if (!p) throw new Error("That piece is already finished");
    if (p.running) throw new Error("That piece is already running a hooping");
    if (stepNo != null && Number(stepNo) !== p.nextStepNo) throw new Error(`Hooping ${p.nextStepNo} of this piece is next`);
    stepNo = p.nextStepNo;
  }
  const step = steps[stepNo - 1];
  if (!step) throw new Error("No such hooping");
  if (step.blocked) throw new Error(step.blocked);
  // The hoop: one of the hooping's hoops — the requested one, else what's mounted, else the first
  // the machine supports.
  let machine = null;
  if (machineId) machine = await db.prepare("SELECT id, name, currentHoopId FROM machines WHERE id=?").bind(machineId).first();
  hoopId = hoopId == null || hoopId === "" ? null : Number(hoopId);
  if (hoopId && step.hoopIds.length && !step.hoopIds.includes(hoopId)) throw new Error("That hoop isn't one of this hooping's hoops");
  if (!hoopId && step.hoopIds.length) {
    const supported = machineId ? (await db.prepare("SELECT hoopId FROM machine_hoops WHERE machineId=?").bind(machineId).all()).results.map(r => Number(r.hoopId)) : [];
    hoopId = (machine && step.hoopIds.includes(Number(machine.currentHoopId)) ? Number(machine.currentHoopId) : null)
      || step.hoopIds.find(h => supported.includes(h)) || step.hoopIds[0];
  }
  const now = new Date().toISOString();
  let r;
  try {
    r = await db.prepare(
      `INSERT INTO production_runs (orgId, orderId, itemId, machineId, machineName, designId, designVersionId, designName, startedAt, finishedAt, status, createdAt,
         pieceNo, stepNo, stepCount, stepLabel, hoopId, itemDesignId, timed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(item.orgId, orderId, Number(itemId), machineId, (machine && machine.name) || "", step.designId, step.versionId,
      step.designName || "", now, untimed ? now : null, untimed ? "done" : "running", now,
      pieceNo, stepNo, steps.length, step.label || "", hoopId, step.itemDesignId, untimed ? 0 : 1).run();
  } catch (e) {
    // Two Starts at the same moment can both pass the checks above; the unique indexes reject the
    // second (one running job per machine, 0031; one running/done row per piece hooping, 0032).
    if (!/UNIQUE constraint failed/i.test(String(e && e.message))) throw e;
    if (machineId && !untimed) {
      const busy = await db.prepare("SELECT COUNT(*) n FROM production_runs WHERE machineId=? AND status='running'").bind(machineId).first();
      if (Number(busy && busy.n) > 0) throw new Error("That machine is already running a job");
    }
    throw new Error("That hooping was just started or finished — refresh");
  }
  if (machineId && hoopId) await db.prepare("UPDATE machines SET currentHoopId=?, updatedAt=? WHERE id=?").bind(hoopId, now, machineId).run().catch(() => {});
  return { runId: Number(r.meta && r.meta.last_row_id) || 0, pieceNo, stepNo, stepCount: steps.length };
}

// Kept for callers that start "the next piece" without knowing about hoopings: returns the runId.
export async function startProductionRun(db, args) {
  const r = await startHooping(db, args);
  return typeof r === "number" ? r : r.runId;
}

async function legacyStartRun_(db, { orgId, orderId, itemId, machineId }) {
  const item = await db.prepare("SELECT orgId, qty, COALESCE(manufacturedQty,0) AS manufacturedQty FROM order_items WHERE id=?").bind(Number(itemId)).first();
  const running = await db.prepare("SELECT COUNT(*) n FROM production_runs WHERE itemId=? AND status='running'").bind(Number(itemId)).first();
  if (Number(item.manufacturedQty) + Number(running && running.n || 0) >= Math.max(1, Number(item.qty) || 1)) throw new Error("Every piece of this line is already started or made");
  const now = new Date().toISOString();
  const r = await db.prepare(
    "INSERT INTO production_runs (orgId, orderId, itemId, machineId, machineName, designName, startedAt, status, createdAt) VALUES (?, ?, ?, ?, '', '', ?, 'running', ?)"
  ).bind(item.orgId, orderId, Number(itemId), machineId, now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

// After a hooping is recorded done: when it was the piece's last, the piece is made (consumes its
// blank, may finish the order). Returns {pieceComplete, orderComplete, nextStepNo}.
async function afterHoopingDone_(db, run) {
  if (run.pieceNo == null) {
    const res = await markItemPieceManufactured(db, run.orderId, Number(run.itemId));
    return { pieceComplete: true, orderComplete: !!res.orderComplete, nextStepNo: null };
  }
  const { results } = await db.prepare(
    "SELECT DISTINCT stepNo FROM production_runs WHERE itemId=? AND pieceNo=? AND status='done'").bind(Number(run.itemId), Number(run.pieceNo)).all();
  const done = results.map(r => Number(r.stepNo));
  const total = Math.max(1, Number(run.stepCount) || 1);
  if (done.length >= total) {
    const res = await markItemPieceManufactured(db, run.orderId, Number(run.itemId));
    return { pieceComplete: true, orderComplete: !!res.orderComplete, nextStepNo: null };
  }
  let next = 1; while (done.includes(next)) next++;
  return { pieceComplete: false, orderComplete: false, nextStepNo: next, stepCount: total };
}

// "Mark done (no timing)" for one hooping: recorded done at once (timed = 0), then as above.
// Its design's stitches still go on the machine's counter, with run time estimated from the design's timed runs
// (migrations/0071) — `args.readStitches` / `args.actor` as for completeProductionRun.
export async function markHoopingDone(db, args) {
  const started = await startHooping(db, Object.assign({}, args, { untimed: true }));
  const counted = started && started.runId ? await countRunOnMachine_(db, started.runId, { kind: "run", readStitches: args.readStitches, actor: args.actor }) : null;
  return Object.assign({ pieceNo: started.pieceNo, stepNo: started.stepNo, counted },
    await afterHoopingDone_(db, { orderId: args.orderId, itemId: args.itemId, pieceNo: started.pieceNo, stepCount: started.stepCount }));
}

// ---- Issues noted when a timed run is finished (migrations/0046) --------------------------------
// The fixed list the Run Order prompt offers, in the order shown. Each can happen more than once in
// a run, so each carries a count. "other" comes with a free-text note.
export const RUN_ISSUE_KINDS = [
  { key: "threadBreak", label: "Thread break" },
  { key: "bobbinOut", label: "Bobbin ran out" },
  { key: "birdsNest", label: "Bird's nest" },
  { key: "needleBreak", label: "Needle break" },
  { key: "needleReplaced", label: "Needle replaced" },
  { key: "other", label: "Other" },
];
const RUN_ISSUE_MAX_ = 99;
// Tidies what the prompt sends → { issues: {key: count ≥ 1}, note }. Unknown kinds and counts
// below 1 are dropped; a note typed without ticking Other still counts as one "other".
export function cleanRunIssues(raw, rawNote) {
  const issues = {};
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  for (const k of RUN_ISSUE_KINDS) {
    const n = Math.floor(Number(src[k.key]));
    if (Number.isFinite(n) && n >= 1) issues[k.key] = Math.min(RUN_ISSUE_MAX_, n);
  }
  const note = String(rawNote == null ? "" : rawNote).replace(/\s+/g, " ").trim().slice(0, 500);
  if (note && !issues.other) issues.other = 1;
  return { issues, note };
}
// "Thread break ×3, Bobbin ran out" — for the audit log and anywhere a one-line summary is wanted.
export function runIssuesText(issues) {
  return RUN_ISSUE_KINDS.filter(k => issues && issues[k.key]).map(k => k.label + (issues[k.key] > 1 ? " ×" + issues[k.key] : "")).join(", ");
}
const avgRun_ = (rows) => { const ms = rows.map(r => Math.max(0, Date.parse(r.finishedAt) - Date.parse(r.startedAt))).filter(Number.isFinite);
  return { runs: ms.length, avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0 }; };
// What the finish prompt shows at the top: when this run started, and how long this design usually
// takes — on the machine it's running on, and on any machine (timed, finished runs only).
export async function getRunStats(db, runId) {
  const run = await db.prepare("SELECT * FROM production_runs WHERE id=?").bind(Number(runId)).first();
  if (!run) throw new Error("Run not found");
  let stitchCount = null;
  try { stitchCount = await runDesignStitches_(db, run); } catch (e) { /* a database before 0070 */ }
  let rows = [];
  if (run.designId != null) {
    rows = (await db.prepare(
      `SELECT machineId, startedAt, finishedAt FROM production_runs
       WHERE designId = ? AND status = 'done' AND finishedAt IS NOT NULL AND COALESCE(timed, 1) = 1 AND id <> ?`).bind(Number(run.designId), Number(run.id)).all()).results || [];
  }
  return {
    runId: Number(run.id), status: run.status, startedAt: run.startedAt, designName: run.designName || "", machineName: run.machineName || "", stepLabel: run.stepLabel || "", stitchCount,
    onMachine: avgRun_(rows.filter(r => run.machineId != null && Number(r.machineId) === Number(run.machineId))),
    allMachines: avgRun_(rows),
  };
}

// `opts` (all optional): issues + issueNote = what the operator ticked in the finish prompt
// (cleanRunIssues); finishedAt = when they pressed Mark done — the prompt takes a few seconds to
// fill in, and that time isn't run time. It's only trusted between the run's start and now.
export async function completeProductionRun(db, runId, opts = {}) {
  const run = await db.prepare("SELECT id, orderId, itemId, status, pieceNo, stepNo, stepCount, startedAt FROM production_runs WHERE id=?").bind(Number(runId)).first();
  if (!run) throw new Error("Run not found");
  if (run.status !== "running") throw new Error("That job is not running");
  const { issues, note } = cleanRunIssues(opts.issues, opts.issueNote);
  const now = Date.now(), asked = Date.parse(opts.finishedAt || ""), started = Date.parse(run.startedAt);
  const finishedAt = new Date(Number.isFinite(asked) && asked <= now + 5000 && (!Number.isFinite(started) || asked >= started) ? Math.min(asked, now) : now).toISOString();
  // Guarded: only the request that actually flips running → done goes on, so a double-clicked
  // "Mark done" (or two tabs) can't count one hooping — or one piece — twice.
  const flip = await db.prepare("UPDATE production_runs SET finishedAt=?, status='done', issuesJson=?, issueNote=? WHERE id=? AND status='running'")
    .bind(finishedAt, JSON.stringify(issues), note, Number(runId)).run();
  if (Number(flip && flip.meta && flip.meta.changes) !== 1) throw new Error("That job is not running");
  // The run's stitches and time go on its machine's counters (migrations/0071) — only after the flip, so once.
  const counted = await countRunOnMachine_(db, run.id, { kind: "run", readStitches: opts.readStitches, actor: opts.actor });
  return Object.assign({ pieceNo: run.pieceNo == null ? null : Number(run.pieceNo), stepNo: run.stepNo == null ? null : Number(run.stepNo), issues, issueNote: note, finishedAt, counted },
    await afterHoopingDone_(db, run));
}

// `stitchesRun` (optional, migrations/0071): how many stitches it got through, if the operator read it off the
// machine — added to the machine's counter with the time it ran.
export async function abortProductionRun(db, runId, { abortReasonId, abortNote, stitchesRun, actor } = {}) {
  const run = await db.prepare("SELECT id, status FROM production_runs WHERE id=?").bind(Number(runId)).first();
  if (!run) throw new Error("Run not found");
  if (run.status !== "running") throw new Error("That job is not running");
  let label = "";
  if (abortReasonId != null && abortReasonId !== "") {
    const rr = await db.prepare("SELECT label FROM run_abort_reasons WHERE id=?").bind(Number(abortReasonId)).first();
    label = (rr && rr.label) || "";
  }
  const flip = await db.prepare("UPDATE production_runs SET finishedAt=?, status='aborted', abortReasonId=?, abortReasonLabel=?, abortNote=? WHERE id=? AND status='running'")
    .bind(new Date().toISOString(), abortReasonId != null && abortReasonId !== "" ? Number(abortReasonId) : null,
      label, String(abortNote || "").slice(0, 500), Number(runId)).run();
  if (Number(flip && flip.meta && flip.meta.changes) !== 1) throw new Error("That job is not running");
  return { counted: await countRunOnMachine_(db, Number(runId), { kind: "abort", stitches: cleanStitchCount(stitchesRun) || 0, actor }) };
}

// ---- Machine counters & maintenance (migrations/0071) -------------------------------------------
// A machine keeps two counters: its stitch counter (kept in step with the number on the machine's display by readings
// typed on the Machines page) and its run time. Every finished run adds its design's stitches and its time; an untimed
// "Mark done" adds the stitches and an ESTIMATE of the time (the design's average timed run on that machine, else on
// any machine — none if it was never timed); an aborted run adds the time it ran and the stitches the operator read
// off the machine, if any. Each change is a machine_counter_events row; machines.stitchCount / runSeconds are its cache.
// Maintenance tasks are due every N run hours and/or every N stitches since they were last done, whichever comes first.

const STITCH_COUNT_MAX_ = 1e10;
// A whole number of stitches ≥ 0, or null (blank / not a number / too big).
export function cleanStitchCount(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > STITCH_COUNT_MAX_ || Math.floor(n) !== n) return null;
  return n;
}
async function setStitchCount_(db, table, id, value) {
  const n = cleanStitchCount(value);
  if (n == null || !id) return;
  try { await db.prepare(`UPDATE ${table === "order_item_designs" ? "order_item_designs" : "design_versions"} SET stitchCount=? WHERE id=?`).bind(n, Number(id)).run(); }
  catch (e) { /* a database before 0070 */ }
}

// The stitches of the design a run ran: its order-specific design, else its design version. When the count isn't
// known yet, `readStitches({machineFileKey, machineFileExt, machineFileName})` (the API passes one that reads the
// DESIGNS bucket) may read it, and it's kept on the design row for next time. null = unknown.
async function runDesignStitches_(db, run, readStitches) {
  const from = run.itemDesignId != null ? { table: "order_item_designs", id: Number(run.itemDesignId) }
    : run.designVersionId != null ? { table: "design_versions", id: Number(run.designVersionId) } : null;
  if (!from) return null;
  const row = await db.prepare(`SELECT id, stitchCount, machineFileKey, machineFileName, machineFileExt FROM ${from.table} WHERE id=?`).bind(from.id).first();
  if (!row) return null;
  if (row.stitchCount != null) return Number(row.stitchCount);
  if (typeof readStitches !== "function" || !row.machineFileKey) return null;
  let n = null;
  try { n = cleanStitchCount(await readStitches({ machineFileKey: row.machineFileKey, machineFileName: row.machineFileName || "", machineFileExt: row.machineFileExt || "" })); }
  catch (e) { console.error("Reading a stitch count failed:", e && e.message); }
  if (n != null) await setStitchCount_(db, from.table, from.id, n);
  return n;
}

// How long a design usually runs on a machine (else on any machine), from its timed, finished runs. 0 = never timed.
async function designAvgSeconds_(db, designId, machineId, exceptRunId) {
  if (designId == null) return 0;
  const { results } = await db.prepare(
    `SELECT machineId, startedAt, finishedAt FROM production_runs
     WHERE designId=? AND status='done' AND finishedAt IS NOT NULL AND COALESCE(timed, 1) = 1 AND id <> ?`).bind(Number(designId), Number(exceptRunId) || 0).all();
  const on = avgRun_((results || []).filter(r => machineId != null && Number(r.machineId) === Number(machineId)));
  const all = on.runs ? on : avgRun_(results || []);
  return all.runs ? Math.round(all.avgMs / 1000) : 0;
}

// Adds one finished / aborted run to its machine's counters, once (a unique index on the event's runId). Never throws:
// counting is bookkeeping and must not undo finishing a run. Returns {stitches, seconds, estimated, unknownStitches}
// or null (no machine, already counted, or a database before 0070).
async function countRunOnMachine_(db, runId, { kind = "run", stitches: givenStitches, readStitches, actor } = {}) {
  try {
    const run = await db.prepare(
      `SELECT id, machineId, designId, designVersionId, itemDesignId, startedAt, finishedAt, status, COALESCE(timed, 1) AS timed
       FROM production_runs WHERE id=?`).bind(Number(runId)).first();
    if (!run) return null;
    const design = await runDesignStitches_(db, run, readStitches);
    if (run.machineId == null) {
      await db.prepare("UPDATE production_runs SET stitchCount=? WHERE id=?").bind(design, run.id).run();
      return null;
    }
    let stitches, seconds, estimated = 0;
    const elapsed = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000)) || 0;
    if (kind === "abort") { stitches = Math.max(0, Number(givenStitches) || 0); seconds = elapsed; }
    else {
      stitches = design == null ? 0 : design;
      if (Number(run.timed) === 1) seconds = elapsed;
      else { seconds = await designAvgSeconds_(db, run.designId, run.machineId, run.id); estimated = 1; }
    }
    const now = new Date().toISOString(), mid = Number(run.machineId);
    try {
      await db.batch([
        db.prepare(`INSERT INTO machine_counter_events (machineId, kind, runId, stitchesDelta, secondsDelta, stitchTotalAfter, secondsTotalAfter, estimated, note, actor, at)
                    SELECT id, ?, ?, ?, ?, stitchCount + ?, runSeconds + ?, ?, ?, ?, ? FROM machines WHERE id=?`)
          .bind(kind === "abort" ? "abort" : "run", run.id, stitches, seconds, stitches, seconds, estimated,
            kind !== "abort" && design == null ? "Design stitch count not known" : "", String(actor || "").slice(0, 200), now, mid),
        db.prepare("UPDATE machines SET stitchCount = stitchCount + ?, runSeconds = runSeconds + ?, counterUpdatedAt=? WHERE id=?").bind(stitches, seconds, now, mid),
        db.prepare("UPDATE production_runs SET stitchCount=?, stitchesCounted=?, secondsCounted=?, estimated=? WHERE id=?").bind(design, stitches, seconds, estimated, run.id),
      ]);
    } catch (e) {
      if (/UNIQUE constraint failed/i.test(String(e && e.message))) return null;   // already counted
      throw e;
    }
    return { stitches, seconds, estimated: !!estimated, unknownStitches: kind !== "abort" && design == null };
  } catch (e) {
    console.error("Counting a run on its machine failed:", e && e.message);
    return null;
  }
}

// A reading typed from the machine's display: the counter becomes `reading` (the difference is the event — negative
// when the machine was reset or the estimates ran ahead). `runHours` (optional) sets the run time the same way. A task
// last done above the new reading is brought down to it, so "since last done" never goes negative after a reset.
export async function setMachineStitchCount(db, machineId, { reading, runHours, note, actor } = {}) {
  const m = await db.prepare("SELECT id, stitchCount, runSeconds FROM machines WHERE id=?").bind(Number(machineId)).first();
  if (!m) throw new Error("Machine not found");
  const stitches = cleanStitchCount(reading);
  if (stitches == null) throw new Error("Type the stitch count shown on the machine (a whole number)");
  let seconds = Number(m.runSeconds) || 0;
  if (runHours !== undefined && runHours !== null && runHours !== "") {
    const h = Number(runHours);
    if (!Number.isFinite(h) || h < 0 || h > 1e6) throw new Error("Run hours must be a number of hours");
    seconds = Math.round(h * 3600);
  }
  const ds = stitches - (Number(m.stitchCount) || 0), dsec = seconds - (Number(m.runSeconds) || 0), now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO machine_counter_events (machineId, kind, runId, stitchesDelta, secondsDelta, stitchTotalAfter, secondsTotalAfter, estimated, note, actor, at)
                VALUES (?, 'reading', NULL, ?, ?, ?, ?, 0, ?, ?, ?)`)
      .bind(m.id, ds, dsec, stitches, seconds, String(note || "Reading entered").slice(0, 300), String(actor || "").slice(0, 200), now),
    db.prepare("UPDATE machines SET stitchCount=?, runSeconds=?, counterUpdatedAt=? WHERE id=?").bind(stitches, seconds, now, m.id),
    db.prepare("UPDATE machine_maintenance_tasks SET lastDoneStitches = MIN(lastDoneStitches, ?), lastDoneSeconds = MIN(lastDoneSeconds, ?) WHERE machineId=?").bind(stitches, seconds, m.id),
  ]);
  return { stitchCount: stitches, runSeconds: seconds, stitchesDelta: ds, secondsDelta: dsec, before: { stitchCount: Number(m.stitchCount) || 0, runSeconds: Number(m.runSeconds) || 0 } };
}

const MAINT_SOON_ = 0.9;
// Where a task stands on a machine: how much run time / how many stitches since it was last done, and the larger share
// of its thresholds used. status: 'off' (inactive) | 'ok' | 'soon' (≥ 90%) | 'due' (≥ 100%).
export function maintenanceStatus(task, machine) {
  const usedSeconds = Math.max(0, (Number(machine && machine.runSeconds) || 0) - (Number(task.lastDoneSeconds) || 0));
  const usedStitches = Math.max(0, (Number(machine && machine.stitchCount) || 0) - (Number(task.lastDoneStitches) || 0));
  const parts = [];
  if (task.everySeconds) parts.push(usedSeconds / Number(task.everySeconds));
  if (task.everyStitches) parts.push(usedStitches / Number(task.everyStitches));
  const pct = parts.length ? Math.max(...parts) : 0;
  const status = !task.active ? "off" : pct >= 1 ? "due" : pct >= MAINT_SOON_ ? "soon" : "ok";
  return { usedSeconds, usedStitches, pct: Math.round(pct * 1000) / 1000, status };
}
const parseMaintTask_ = (r) => ({ id: Number(r.id), machineId: Number(r.machineId), name: r.name || "",
  everySeconds: r.everySeconds == null ? null : Number(r.everySeconds), everyStitches: r.everyStitches == null ? null : Number(r.everyStitches),
  notes: r.notes || "", active: Number(r.active) === 1, sortOrder: Number(r.sortOrder) || 0, lastDoneAt: r.lastDoneAt || "",
  lastDoneStitches: Number(r.lastDoneStitches) || 0, lastDoneSeconds: Number(r.lastDoneSeconds) || 0 });

// Every task (or one machine's), each with its status against its machine's counters now.
export async function listMaintenanceTasks(db, machineId) {
  const where = machineId ? " WHERE t.machineId=?" : "";
  const st = db.prepare(`SELECT t.*, m.stitchCount AS mStitches, m.runSeconds AS mSeconds, m.name AS machineName FROM machine_maintenance_tasks t
                         JOIN machines m ON m.id = t.machineId${where} ORDER BY t.machineId, t.sortOrder, t.id`);
  const { results } = await (machineId ? st.bind(Number(machineId)) : st).all();
  return (results || []).map(r => { const t = parseMaintTask_(r); t.machineName = r.machineName || "";
    return Object.assign(t, maintenanceStatus(t, { stitchCount: r.mStitches, runSeconds: r.mSeconds })); });
}

// Validates and saves one task. A new task starts counting from the machine's counters now.
export async function saveMaintenanceTask(db, fields) {
  const f = fields || {};
  const name = String(f.name || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!name) throw new Error("Give the task a name");
  const hours = f.everyHours === "" || f.everyHours == null ? null : Number(f.everyHours);
  if (hours != null && (!Number.isFinite(hours) || hours <= 0 || hours > 100000)) throw new Error("Run hours must be a number above 0");
  const everySeconds = hours == null ? null : Math.max(1, Math.round(hours * 3600));
  const everyStitches = f.everyStitches === "" || f.everyStitches == null ? null : cleanStitchCount(f.everyStitches);
  if (f.everyStitches !== "" && f.everyStitches != null && !everyStitches) throw new Error("Stitches must be a whole number above 0");
  if (!everySeconds && !everyStitches) throw new Error("Set run hours, stitches, or both");
  const notes = String(f.notes || "").slice(0, 500), active = f.active === false || f.active === 0 ? 0 : 1;
  const sortOrder = Math.floor(Number(f.sortOrder) || 0), now = new Date().toISOString();
  if (f.id) {
    const cur = await db.prepare("SELECT id FROM machine_maintenance_tasks WHERE id=?").bind(Number(f.id)).first();
    if (!cur) throw new Error("Task not found");
    await db.prepare("UPDATE machine_maintenance_tasks SET name=?, everySeconds=?, everyStitches=?, notes=?, active=?, sortOrder=?, updatedAt=? WHERE id=?")
      .bind(name, everySeconds, everyStitches, notes, active, sortOrder, now, Number(f.id)).run();
    return Number(f.id);
  }
  const m = await db.prepare("SELECT id, stitchCount, runSeconds FROM machines WHERE id=?").bind(Number(f.machineId)).first();
  if (!m) throw new Error("Machine not found");
  const r = await db.prepare(`INSERT INTO machine_maintenance_tasks (machineId, name, everySeconds, everyStitches, notes, active, sortOrder, lastDoneAt, lastDoneStitches, lastDoneSeconds, createdAt, updatedAt)
                              VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
    .bind(m.id, name, everySeconds, everyStitches, notes, active, sortOrder, Number(m.stitchCount) || 0, Number(m.runSeconds) || 0, now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

export async function deleteMaintenanceTask(db, id) {
  const t = await db.prepare("SELECT * FROM machine_maintenance_tasks WHERE id=?").bind(Number(id)).first();
  if (!t) throw new Error("Task not found");
  await db.prepare("DELETE FROM machine_maintenance_tasks WHERE id=?").bind(Number(id)).run();
  return parseMaintTask_(t);
}

// Records maintenance done: a log row with the machine's counters at that moment, and — for a listed task — the
// task starts counting again from them. `taskId` empty + a `name` = other work (e.g. "Replaced the hook").
export async function recordMaintenance(db, { machineId, taskId, name, note, doneAt, actor } = {}) {
  const m = await db.prepare("SELECT id, name, stitchCount, runSeconds FROM machines WHERE id=?").bind(Number(machineId)).first();
  if (!m) throw new Error("Machine not found");
  let task = null;
  if (taskId) {
    task = await db.prepare("SELECT * FROM machine_maintenance_tasks WHERE id=? AND machineId=?").bind(Number(taskId), m.id).first();
    if (!task) throw new Error("That task isn't on this machine");
  }
  const taskName = task ? task.name : String(name || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!taskName) throw new Error("Say what was done");
  const now = new Date();
  let when = now.toISOString();
  if (doneAt) {
    const t = Date.parse(doneAt);
    if (!Number.isFinite(t)) throw new Error("That date isn't valid");
    if (t > now.getTime() + 60000) throw new Error("The date can't be in the future");
    when = new Date(t).toISOString();
  }
  const stmts = [db.prepare(`INSERT INTO machine_maintenance_log (machineId, machineName, taskId, taskName, doneAt, stitchCountAt, runSecondsAt, note, actor, createdAt)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(m.id, m.name || "", task ? Number(task.id) : null, taskName, when, Number(m.stitchCount) || 0, Number(m.runSeconds) || 0,
      String(note || "").slice(0, 1000), String(actor || "").slice(0, 200), now.toISOString())];
  if (task) stmts.push(db.prepare("UPDATE machine_maintenance_tasks SET lastDoneAt=?, lastDoneStitches=?, lastDoneSeconds=?, updatedAt=? WHERE id=?")
    .bind(when, Number(m.stitchCount) || 0, Number(m.runSeconds) || 0, now.toISOString(), Number(task.id)));
  const res = await db.batch(stmts);
  return { id: Number(res && res[0] && res[0].meta && res[0].meta.last_row_id) || 0, taskName, doneAt: when, stitchCountAt: Number(m.stitchCount) || 0, runSecondsAt: Number(m.runSeconds) || 0 };
}

// The maintenance log (newest first) and the counter changes, optionally for one machine and a date range.
// `from` / `to` are exact ISO times (the admin sends its own day's bounds) or plain YYYY-MM-DD days (UTC).
export async function getMaintenanceLog(db, { machineId, from, to } = {}) {
  const lo = from ? String(from) : "0000", hi = to ? (String(to).includes("T") ? String(to) : String(to) + "T23:59:59.999Z") : "9999";
  const mid = machineId ? Number(machineId) : null;
  const { results: log } = await db.prepare(
    `SELECT * FROM machine_maintenance_log WHERE doneAt >= ? AND doneAt <= ?${mid ? " AND machineId=?" : ""} ORDER BY doneAt DESC, id DESC LIMIT 1000`)
    .bind(...[lo, hi, ...(mid ? [mid] : [])]).all();
  const { results: ev } = await db.prepare(
    `SELECT e.*, m.name AS machineName FROM machine_counter_events e LEFT JOIN machines m ON m.id = e.machineId
     WHERE e.at >= ? AND e.at <= ?${mid ? " AND e.machineId=?" : ""} ORDER BY e.at DESC, e.id DESC LIMIT 5000`)
    .bind(...[lo, hi, ...(mid ? [mid] : [])]).all();
  return {
    log: (log || []).map(r => ({ id: Number(r.id), machineId: Number(r.machineId), machineName: r.machineName || "", taskId: r.taskId == null ? null : Number(r.taskId),
      taskName: r.taskName || "", doneAt: r.doneAt, stitchCountAt: Number(r.stitchCountAt) || 0, runSecondsAt: Number(r.runSecondsAt) || 0, note: r.note || "", actor: r.actor || "" })),
    events: (ev || []).map(r => ({ id: Number(r.id), machineId: Number(r.machineId), machineName: r.machineName || "", kind: r.kind, runId: r.runId == null ? null : Number(r.runId),
      stitchesDelta: Number(r.stitchesDelta) || 0, secondsDelta: Number(r.secondsDelta) || 0, stitchTotalAfter: Number(r.stitchTotalAfter) || 0,
      secondsTotalAfter: Number(r.secondsTotalAfter) || 0, estimated: Number(r.estimated) === 1, note: r.note || "", actor: r.actor || "", at: r.at })),
  };
}

// Design versions and order designs with a machine file but no stitch count yet (for the bulk read).
export async function listDesignsMissingStitches(db, limit = 50) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const { results: v } = await db.prepare("SELECT id, machineFileKey, machineFileName, machineFileExt FROM design_versions WHERE stitchCount IS NULL AND machineFileKey <> '' AND lower(machineFileExt) IN ('dst', 'dsb') ORDER BY id DESC LIMIT ?").bind(n).all();
  const { results: o } = await db.prepare("SELECT id, machineFileKey, machineFileName, machineFileExt FROM order_item_designs WHERE stitchCount IS NULL AND machineFileKey <> '' AND lower(machineFileExt) IN ('dst', 'dsb') ORDER BY id DESC LIMIT ?").bind(n).all();
  return [...(v || []).map(r => ({ table: "design_versions", ...r })), ...(o || []).map(r => ({ table: "order_item_designs", ...r }))];
}
export async function setDesignStitchCount(db, table, id, value) {
  const n = cleanStitchCount(value);
  if (n == null) throw new Error("Stitches must be a whole number");
  const t = table === "order_item_designs" ? "order_item_designs" : "design_versions";
  const row = await db.prepare(`SELECT id, stitchCount FROM ${t} WHERE id=?`).bind(Number(id)).first();
  if (!row) throw new Error("Design version not found");
  await db.prepare(`UPDATE ${t} SET stitchCount=? WHERE id=?`).bind(n, Number(id)).run();
  return { from: row.stitchCount == null ? null : Number(row.stitchCount), to: n };
}

// Run-time report grouped by design (with a per-machine breakdown), over DONE runs in the range,
// plus a detailed log of every run (done + aborted) in range. Durations in ms.
// Issues (migrations/0046): each design and each of its machines carries `issues` — the total count
// of every kind noted on its runs — and `runsWithIssues`; `issueTotals` is the same across the whole
// range; each log row has its own `issues` / `issueNote`; `otherNotes` lists the free-text details.
export async function getRunReportByDesign(db, { from, to } = {}) {
  const lo = from ? String(from) : "0000";
  const hi = to ? String(to) + "T23:59:59.999Z" : "9999";
  const { results: done } = await db.prepare(
    `SELECT designId, designName, orgId, machineName, startedAt, finishedAt, issuesJson, stitchCount
     FROM production_runs WHERE status='done' AND finishedAt IS NOT NULL AND startedAt >= ? AND startedAt <= ?
       AND COALESCE(timed, 1) = 1`
  ).bind(lo, hi).all();
  const { results: aborted } = await db.prepare(
    "SELECT designId, designName FROM production_runs WHERE status='aborted' AND startedAt >= ? AND startedAt <= ?"
  ).bind(lo, hi).all();
  const dur = (a, b) => Math.max(0, Date.parse(b) - Date.parse(a));
  const byDesign = new Map();
  const keyOf = (r) => (r.designId == null ? "none" : String(r.designId));
  const ensure = (r) => {
    const k = keyOf(r);
    if (!byDesign.has(k)) byDesign.set(k, { designId: r.designId == null ? null : Number(r.designId),
      designName: r.designName || "(no design)", runs: 0, totalMs: 0, abortedCount: 0, issues: {}, runsWithIssues: 0, _byMachine: new Map(), ...stitchAcc_() });
    return byDesign.get(k);
  };
  const issuesOf = (r) => cleanRunIssues(tryParse_(r.issuesJson, {}), "").issues;
  const addIssues = (into, issues) => { for (const k of Object.keys(issues)) into[k] = (into[k] || 0) + issues[k]; };
  const issueTotals = {};
  let runsWithIssues = 0;
  // Stitches (migrations/0071): over the timed runs whose design's stitch count is known — total, per run, per minute.
  const stitchAcc_ = () => ({ stitches: 0, stitchRuns: 0, stitchMs: 0 });
  const addStitches_ = (into, n, ms) => { if (n == null) return; into.stitches += Number(n) || 0; into.stitchRuns++; into.stitchMs += ms; };
  const stitchOut_ = (a) => ({ stitches: a.stitches, avgStitches: a.stitchRuns ? Math.round(a.stitches / a.stitchRuns) : 0,
    stitchesPerMin: a.stitchMs > 0 ? Math.round(a.stitches / (a.stitchMs / 60000)) : 0 });
  const allStitches = stitchAcc_();
  for (const r of done) {
    const g = ensure(r); const ms = dur(r.startedAt, r.finishedAt);
    g.runs++; g.totalMs += ms;
    const mk = r.machineName || "(unassigned)";
    const mm = g._byMachine.get(mk) || { machineName: mk, runs: 0, totalMs: 0, issues: {}, runsWithIssues: 0, ...stitchAcc_() };
    mm.runs++; mm.totalMs += ms; g._byMachine.set(mk, mm);
    addStitches_(g, r.stitchCount, ms); addStitches_(mm, r.stitchCount, ms); addStitches_(allStitches, r.stitchCount, ms);
    const issues = issuesOf(r);
    if (Object.keys(issues).length) {
      addIssues(g.issues, issues); addIssues(mm.issues, issues); addIssues(issueTotals, issues);
      g.runsWithIssues++; mm.runsWithIssues++; runsWithIssues++;
    }
  }
  for (const r of aborted) ensure(r).abortedCount++;
  const designs = [...byDesign.values()].map(g => ({
    designId: g.designId, designName: g.designName, runs: g.runs, totalMs: g.totalMs,
    avgMs: g.runs ? Math.round(g.totalMs / g.runs) : 0, abortedCount: g.abortedCount,
    issues: g.issues, runsWithIssues: g.runsWithIssues, ...stitchOut_(g), runsNoStitches: g.runs - g.stitchRuns,
    byMachine: [...g._byMachine.values()].map(m => ({ machineName: m.machineName, runs: m.runs,
      totalMs: m.totalMs, avgMs: m.runs ? Math.round(m.totalMs / m.runs) : 0, issues: m.issues, runsWithIssues: m.runsWithIssues,
      ...stitchOut_(m), runsNoStitches: m.runs - m.stitchRuns }))
      .sort((a, b) => b.runs - a.runs),
  })).sort((a, b) => b.runs - a.runs);
  const { results: detailRows } = await db.prepare(
    `SELECT pr.id AS runId, pr.designName, pr.machineName, pr.orgId, org.name AS orgName, pr.orderId,
            pr.startedAt, pr.finishedAt, pr.status, pr.abortReasonLabel, pr.abortNote, pr.stepLabel, pr.issuesJson, pr.issueNote,
            pr.stitchCount, pr.stitchesCounted
     FROM production_runs pr LEFT JOIN orgs org ON org.orgId = pr.orgId
     WHERE pr.startedAt >= ? AND pr.startedAt <= ? AND COALESCE(pr.timed, 1) = 1 ORDER BY pr.startedAt DESC, pr.id DESC`
  ).bind(lo, hi).all();
  const detail = detailRows.map(r => ({
    runId: Number(r.runId), designName: r.designName || "(no design)", machineName: r.machineName || "(unassigned)",
    orgName: r.orgName || r.orgId, orderId: r.orderId, startedAt: r.startedAt, finishedAt: r.finishedAt || "",
    status: r.status, durationMs: r.finishedAt ? dur(r.startedAt, r.finishedAt) : null,
    abortReasonLabel: r.abortReasonLabel || "", abortNote: r.abortNote || "", stepLabel: r.stepLabel || "",
    issues: r.status === "done" ? issuesOf(r) : {}, issueNote: r.status === "done" ? (r.issueNote || "") : "",
    stitchCount: r.stitchCount == null ? null : Number(r.stitchCount), stitchesCounted: r.stitchesCounted == null ? null : Number(r.stitchesCounted),
  }));
  // The free-text "other" details, newest first — the list at the bottom of the report.
  const otherNotes = detail.filter(x => x.issueNote).map(x => ({ runId: x.runId, startedAt: x.startedAt, designName: x.designName, machineName: x.machineName,
    orgName: x.orgName, orderId: x.orderId, stepLabel: x.stepLabel, count: x.issues.other || 1, note: x.issueNote }));
  // Untimed hoopings ("Mark done (no timing)") aren't in the timings, but their stitches still ran.
  const untimed = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(stitchCount), 0) AS stitches FROM production_runs
     WHERE status='done' AND COALESCE(timed, 1) = 0 AND startedAt >= ? AND startedAt <= ?`).bind(lo, hi).first();
  const stitchSummary = Object.assign(stitchOut_(allStitches), { runsNoStitches: done.length - allStitches.stitchRuns,
    untimedRuns: Number(untimed && untimed.n) || 0, untimedStitches: Number(untimed && untimed.stitches) || 0 });
  return { designs, detail, issueKinds: RUN_ISSUE_KINDS, issueTotals, runsWithIssues, doneRuns: done.length, otherNotes, stitchSummary };
}

// ---- Catch-up: use blanks for orders that were made before stock was tracked ----
// An order line qualifies when its product/size is linked to a blank, the order is real and
// already made (manufactured, shipped or delivered) and the line has no real cost yet
// (none at all, or only the estimate the tracking migration gave it). Each is dated when the order
// was made and priced at the weighted-average cost the blank had THEN, by replaying the movement
// history in date order — so backdated receipts count. The plan is computed the same way for the
// preview and for the apply, so what you approve is what gets written.
export async function planBlankCatchUp(db) {
  const fs = await fromStockLine_(db);   // a line filled from finished stock used no blank of its own (0060)
  // The link is resolved by the item's color too (migrations/0037): a configurable line's
  // config.garmentColor, else '' for a classic product.
  const ITEM_COLOR_SQL = "(CASE WHEN i.configJson LIKE '{%' THEN COALESCE(json_extract(i.configJson,'$.garmentColor'),'') ELSE '' END)";
  const { results: cands } = await db.prepare(
    `SELECT i.id AS itemId, i.orderId, i.orgId, i.name, i.size, i.qty, i.cogsCents, i.cogsSource,
            l.blankId, l.blankColor, l.blankSize, o.customerName,
            COALESCE(o.manufacturedAt, o.shippedAt, o.deliveredAt) AS useDate
     FROM order_items i
     JOIN orders o ON o.orderId = i.orderId
     JOIN product_blank_links l ON l.orgId = i.orgId AND l.productId = i.productId
            AND l.productColor = ${ITEM_COLOR_SQL} AND l.productSize = i.size
     WHERE i.cancelDate IS NULL AND o.voidedAt IS NULL AND o.isTest = 0
       AND COALESCE(o.manufacturedAt, o.shippedAt, o.deliveredAt) IS NOT NULL
       AND (i.cogsCents IS NULL OR i.cogsSource = 'estimate') AND NOT ${fs("i")}
     ORDER BY useDate, i.id`).all();
  if (!cands.length) return { lines: [], totalUnits: 0, totalCents: 0, replacedEstimateCents: 0, shortLines: 0 };
  const { results: mv } = await db.prepare(
    "SELECT id, blankId, color, size, qtyDelta, unitCostCents, kind, occurredAt FROM inventory_movements WHERE voidedAt IS NULL ORDER BY occurredAt, id").all();
  const { results: cur } = await db.prepare("SELECT blankId, color, size, purchasePriceCents FROM blank_sizes").all();
  const curAvg = new Map(cur.map(r => [r.blankId + "|" + (r.color || "") + "|" + r.size, Number(r.purchasePriceCents) || 0]));
  const { results: names } = await db.prepare("SELECT id, name FROM blanks").all();
  const blankNames = new Map(names.map(r => [Number(r.id), r.name]));

  const byKey = new Map();
  const bucket = (k) => { if (!byKey.has(k)) byKey.set(k, []); return byKey.get(k); };
  for (const m of mv) bucket(m.blankId + "|" + (m.color || "") + "|" + m.size).push({ at: m.occurredAt, order: 0, id: Number(m.id), d: Number(m.qtyDelta), cost: Number(m.unitCostCents), kind: m.kind });
  for (const c of cands) bucket(c.blankId + "|" + (c.blankColor || "") + "|" + (c.blankSize || "")).push({ at: c.useDate, order: 1, id: Number(c.itemId), cand: c });

  const lines = [];
  for (const [key, seq] of byKey) {
    seq.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.id - b.id);
    let qty = 0, avg = 0;
    for (const e of seq) {
      if (!e.cand) {
        if (e.d > 0 && (e.kind === "purchase" || e.kind === "adjust")) { const on = Math.max(0, qty); avg = Math.round((on * avg + e.d * e.cost) / (on + e.d)); }
        qty += e.d;
        continue;
      }
      const c = e.cand, q = Math.max(1, Number(c.qty) || 1);
      let unit = avg, costNote = "";
      if (!unit) { unit = curAvg.get(key) || 0; costNote = unit ? "no purchase yet on that date — used the blank's current cost" : "no cost known for this blank size"; }
      const before = qty; qty -= q;
      lines.push({ itemId: Number(c.itemId), orderId: c.orderId, orgId: c.orgId, customerName: c.customerName, name: c.name, size: c.size || "", qty: q,
        blankId: Number(c.blankId), blankColor: c.blankColor || "", blankSize: c.blankSize || "", blankName: blankNames.get(Number(c.blankId)) || "", useDate: c.useDate,
        unitCostCents: unit, costCents: unit * q, costNote,
        shortBy: Math.max(0, Math.min(q, q - Math.max(0, before))), oldCostCents: c.cogsCents == null ? null : Number(c.cogsCents), oldSource: c.cogsSource || "" });
    }
  }
  lines.sort((a, b) => a.useDate < b.useDate ? -1 : a.useDate > b.useDate ? 1 : a.itemId - b.itemId);
  return { lines, totalUnits: lines.reduce((t, l) => t + l.qty, 0), totalCents: lines.reduce((t, l) => t + l.costCents, 0),
    replacedEstimateCents: lines.reduce((t, l) => t + (l.oldCostCents || 0), 0), shortLines: lines.filter(l => l.shortBy > 0).length };
}

// Writes the planned lines for the chosen items: a dated "consume" movement, stock down, real cost on the line.
// Re-planned here (not trusted from the browser); already-done lines no longer qualify, so it's idempotent.
export async function applyBlankCatchUp(db, itemIds) {
  const want = new Set((itemIds || []).map(Number));
  const plan = await planBlankCatchUp(db);
  const chosen = plan.lines.filter(l => want.has(l.itemId));
  for (const l of chosen) {
    await insertMovement_(db, { blankId: l.blankId, blankName: l.blankName, color: l.blankColor, size: l.blankSize, qtyDelta: -l.qty, unitCostCents: l.unitCostCents,
      kind: "consume", orderId: l.orderId, itemId: l.itemId, note: "Used for order " + l.orderId + " (catch-up)", occurredAt: l.useDate });
    await db.prepare("UPDATE blank_sizes SET quantity = quantity - ? WHERE blankId=? AND color=? AND size=?").bind(l.qty, l.blankId, l.blankColor || "", l.blankSize).run();
    await db.prepare("UPDATE order_items SET cogsCents = ?, cogsSource = 'consumed' WHERE id = ? AND (cogsCents IS NULL OR cogsSource = 'estimate')")
      .bind(l.costCents, l.itemId).run();
  }
  return { applied: chosen, totalUnits: chosen.reduce((t, l) => t + l.qty, 0), totalCents: chosen.reduce((t, l) => t + l.costCents, 0) };
}

export async function getBlankMovements(db, blankId) {
  const { results } = await db.prepare(
    "SELECT * FROM inventory_movements WHERE blankId=? ORDER BY occurredAt DESC, id DESC LIMIT 500"
  ).bind(Number(blankId)).all();
  return results.map(r => ({ id: Number(r.id), color: r.color || "", size: r.size, qtyDelta: Number(r.qtyDelta), unitCost: fromCents(r.unitCostCents),
    kind: r.kind, orderId: r.orderId || "", vendor: r.vendor || "", vendorRef: r.vendorRef || "", note: r.note || "", occurredAt: r.occurredAt,
    receiptKey: r.receiptKey || "", receiptName: r.receiptName || "", voidedAt: r.voidedAt || "", voidReason: r.voidReason || "" }));
}

// Recomputes blank_sizes.quantity/purchasePriceCents for one blank+size from its
// non-voided movement history (same weighted-average algorithm as
// getInventoryValuation) — the only correct way to reflect a void, since a movement
// in the middle of the history can change every average after it.
async function recomputeBlankSizeFromHistory_(db, blankId, color, size) {
  const { results } = await db.prepare(
    "SELECT qtyDelta, unitCostCents, kind FROM inventory_movements WHERE blankId=? AND color=? AND size=? AND voidedAt IS NULL ORDER BY occurredAt, id"
  ).bind(Number(blankId), String(color || ""), size).all();
  let qty = 0, avg = 0;
  for (const m of results) {
    const d = Number(m.qtyDelta);
    if (d > 0 && (m.kind === "purchase" || m.kind === "adjust")) {
      const onHand = Math.max(0, qty);
      avg = Math.round((onHand * avg + d * Number(m.unitCostCents)) / (onHand + d));
    }
    qty += d;
  }
  await db.prepare(
    `INSERT INTO blank_sizes (blankId, color, size, purchasePriceCents, quantity) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(blankId, color, size) DO UPDATE SET purchasePriceCents = excluded.purchasePriceCents, quantity = excluded.quantity`
  ).bind(Number(blankId), String(color || ""), size, avg, qty).run();
}

// Re-works every size's average cost from its stock history (the same algorithm as above) and stores
// it where it differs — for a stored figure that drifted (one typed into the old blank form). The
// on-hand count is left alone. Returns [{color, size, from, to}] in dollars.
export async function recomputeBlankAverageCosts(db, blankId) {
  const id = Number(blankId);
  const [{ results: sizes }, { results: moves }] = await Promise.all([
    db.prepare("SELECT color, size, purchasePriceCents FROM blank_sizes WHERE blankId=?").bind(id).all(),
    db.prepare("SELECT color, size, qtyDelta, unitCostCents, kind FROM inventory_movements WHERE blankId=? AND voidedAt IS NULL ORDER BY occurredAt, id").bind(id).all(),
  ]);
  const state = new Map();
  for (const m of moves) {
    const k = (m.color || "") + "|" + m.size;
    const st = state.get(k) || { qty: 0, avg: 0 };
    const d = Number(m.qtyDelta);
    if (d > 0 && (m.kind === "purchase" || m.kind === "adjust")) {
      const onHand = Math.max(0, st.qty);
      st.avg = Math.round((onHand * st.avg + d * Number(m.unitCostCents)) / (onHand + d));
    }
    st.qty += d;
    state.set(k, st);
  }
  const changed = [], stmts = [];
  for (const r of sizes) {
    const st = state.get((r.color || "") + "|" + r.size);
    if (!st || st.avg === Number(r.purchasePriceCents)) continue;
    changed.push({ color: r.color || "", size: r.size, from: fromCents(r.purchasePriceCents), to: fromCents(st.avg) });
    stmts.push(db.prepare("UPDATE blank_sizes SET purchasePriceCents=? WHERE blankId=? AND color=? AND size=?").bind(st.avg, id, r.color || "", r.size));
  }
  if (stmts.length) await db.batch(stmts);
  return changed;
}

export async function getInventoryMovementById(db, id) {
  const r = await db.prepare("SELECT * FROM inventory_movements WHERE id=?").bind(Number(id)).first();
  if (!r) return null;
  return { id: Number(r.id), blankId: Number(r.blankId), blankName: r.blankName, color: r.color || "", size: r.size, qtyDelta: Number(r.qtyDelta),
    unitCost: fromCents(r.unitCostCents), kind: r.kind, orderId: r.orderId || "", vendor: r.vendor || "", vendorRef: r.vendorRef || "",
    note: r.note || "", occurredAt: r.occurredAt, voidedAt: r.voidedAt || "", voidReason: r.voidReason || "" };
}

// Voids a mistaken inventory movement (a duplicate receive, a wrong cost/date/vendor) —
// stays in history, struck through, excluded from stock and every report, same pattern
// as voidOrder/voidPayment. Only purchase/adjust/writeoff rows can be voided here — a
// 'consume' row is system-generated from an order's own fulfillment and is corrected by
// editing that order instead. Recomputes the blank+size's stock/average cost from what's
// left. Returns the movement (pre-void) for the caller to audit, or null if not found/
// already voided/wrong kind.
export async function voidInventoryMovement(db, id, reason) {
  const row = await db.prepare("SELECT * FROM inventory_movements WHERE id=?").bind(Number(id)).first();
  if (!row || row.voidedAt || !["purchase", "adjust", "writeoff"].includes(row.kind)) return null;
  await db.prepare("UPDATE inventory_movements SET voidedAt=?, voidReason=? WHERE id=? AND voidedAt IS NULL")
    .bind(new Date().toISOString(), String(reason || "").slice(0, 300), Number(id)).run();
  await recomputeBlankSizeFromHistory_(db, row.blankId, row.color || "", row.size);
  return row;
}

// Why a voided entry can't be restored right now, or "" if it can. Only purchase/adjust/writeoff rows
// can be voided, so only those can be restored. A restored entry that TAKES stock out (a write-off, a
// downward adjustment) is refused when that would leave less than zero on hand — the stock was
// probably counted again while it was voided, and restoring would take the same pieces out twice.
export async function getInventoryRestoreBlocker(db, row) {
  if (!row) return "Entry not found";
  if (!row.voidedAt) return "That entry isn't voided";
  if (!["purchase", "adjust", "writeoff"].includes(row.kind)) return "This entry was generated automatically (from an order) and was never voidable.";
  const delta = Number(row.qtyDelta);
  if (delta < 0) {
    const cur = await db.prepare("SELECT quantity FROM blank_sizes WHERE blankId=? AND color=? AND size=?")
      .bind(Number(row.blankId), String(row.color || ""), row.size).first();
    const onHand = cur ? Number(cur.quantity) : 0;
    if (onHand + delta < 0) {
      return `Restoring this would take ${-delta} out of stock but only ${onHand} ${onHand === 1 ? "is" : "are"} on hand now (it would go below zero).`;
    }
  }
  return "";
}

// Undoes a void: the entry counts toward stock, average cost and every report again, and the
// blank+size is recomputed from the full history (a movement in the middle changes every average
// cost after it, so this is the same recompute a void does). Returns the entry (as it was while
// voided) for the caller to audit, or null if it can't be restored (see getInventoryRestoreBlocker).
export async function restoreInventoryMovement(db, id) {
  const row = await db.prepare("SELECT * FROM inventory_movements WHERE id=?").bind(Number(id)).first();
  if (await getInventoryRestoreBlocker(db, row)) return null;
  const r = await db.prepare("UPDATE inventory_movements SET voidedAt=NULL, voidReason='' WHERE id=? AND voidedAt IS NOT NULL")
    .bind(Number(id)).run();
  if (!((r.meta && r.meta.changes) > 0)) return null; // someone else restored it first
  await recomputeBlankSizeFromHistory_(db, row.blankId, row.color || "", row.size);
  return row;
}

// Inventory on hand and its value at the END of a given moment (ISO), from
// the movement history, using a running weighted-average cost per blank/size.
// (Schedule C Part III: beginning and ending inventory.)
// Each row says whether its blank is for testing / shop use (migrations/0060), and `groups` totals the two
// blank groups — blanks for sale and blanks for testing — by today's flag on the blank.
export async function getInventoryValuation(db, asOf) {
  const { results } = await db.prepare(
    "SELECT blankId, blankName, color, size, qtyDelta, unitCostCents, kind FROM inventory_movements WHERE occurredAt <= ? AND voidedAt IS NULL ORDER BY occurredAt, id"
  ).bind(asOf).all();
  let testingIds = new Set();
  try { testingIds = new Set((await db.prepare("SELECT id FROM blanks WHERE forTesting = 1").all()).results.map(r => Number(r.id))); }
  catch (e) { if (!/no such column/i.test(String(e && e.message))) throw e; }
  // Each blank by its CURRENT name; the name saved on its movements only for a blank since deleted.
  const current = await currentBlankNames_(db);
  const state = new Map();
  for (const m of results) {
    const key = m.blankId + "|" + (m.color || "") + "|" + m.size;
    const st = state.get(key) || { blankId: Number(m.blankId), name: m.blankName, color: m.color || "", size: m.size, qty: 0, avg: 0 };
    const d = Number(m.qtyDelta);
    if (d > 0 && (m.kind === "purchase" || m.kind === "adjust")) {
      const onHand = Math.max(0, st.qty);
      st.avg = Math.round((onHand * st.avg + d * Number(m.unitCostCents)) / (onHand + d));
    }
    st.qty += d;
    st.name = current.get(Number(m.blankId)) || m.blankName || st.name;
    state.set(key, st);
  }
  const rows = [...state.values()].filter(r => r.qty !== 0)
    .map(r => ({ blankId: r.blankId, name: r.name, color: r.color, size: r.size, qty: r.qty, avgCost: fromCents(r.avg), value: fromCents(Math.max(0, r.qty) * r.avg),
      forTesting: testingIds.has(r.blankId) }))
    .sort((a, b) => (a.name + a.color + a.size).localeCompare(b.name + b.color + b.size));
  const group = (list) => ({ units: list.reduce((s, r) => s + r.qty, 0), value: fromCents(list.reduce((s, r) => s + toCents(r.value), 0)) });
  return { asOf, rows, units: rows.reduce((s, r) => s + r.qty, 0),
    value: fromCents(rows.reduce((s, r) => s + toCents(r.value), 0)),
    groups: { forSale: group(rows.filter(r => !r.forTesting)), testing: group(rows.filter(r => r.forTesting)) } };
}

// COGS for a period by month: blanks consumed (at average cost, by the
// month consumed) + estimated costs of lines manufactured before movement
// tracking (by the month manufactured), plus purchases and write-offs.
// Blanks bought for resale that the vendor charged sales tax on anyway — they
// should be bought exempt (with a resale certificate), so the tax
// is an avoidable cost / possibly refundable from the vendor.
export async function getTaxedResalePurchases(db, dateFrom, dateTo) {
  const { results } = await db.prepare(
    `SELECT occurredAt, blankId, blankName, color, size, qtyDelta, unitCostCents, vendor, vendorRef FROM inventory_movements
     WHERE kind = 'purchase' AND vendorChargedTax = 1 AND voidedAt IS NULL AND occurredAt >= ? AND occurredAt <= ? ORDER BY occurredAt`
  ).bind(dateFrom, dateTo).all();
  const current = await currentBlankNames_(db);
  return results.map(r => ({ date: r.occurredAt, blank: current.get(Number(r.blankId)) || r.blankName, color: r.color || "", size: r.size, qty: Number(r.qtyDelta),
    cost: fromCents(Number(r.qtyDelta) * Number(r.unitCostCents)), vendor: r.vendor || "", invoice: r.vendorRef || "" }));
}

// blankId → the name a blank goes by today (the same rule as blankName_).
async function currentBlankNames_(db) {
  const { results } = await db.prepare("SELECT id, name, brand, color FROM blanks").all();
  return new Map(results.map(b => [Number(b.id), b.name || [b.brand, b.color].filter(Boolean).join(" ")]));
}

export async function getCogsReport(db, dateFrom, dateTo) {
  const nb = await noBlankLine_(db);
  // By month, kind and reason (migrations/0060): a consume with reason 'finished' moved the blank into
  // finished stock (not COGS); a write-off's reason splits testing use from damage / loss.
  let mv;
  try {
    ({ results: mv } = await db.prepare(
      `SELECT substr(occurredAt, 1, 7) AS month, kind, COALESCE(reason, '') AS reason, SUM(-qtyDelta * unitCostCents) AS outCents,
              SUM(qtyDelta * unitCostCents) AS inCents, SUM(qtyDelta) AS units
       FROM inventory_movements WHERE occurredAt >= ? AND occurredAt <= ? AND kind IN ('consume', 'purchase', 'writeoff', 'adjust') AND voidedAt IS NULL
       GROUP BY month, kind, reason`
    ).bind(dateFrom, dateTo).all());
  } catch (e) {
    if (!/no such column/i.test(String(e && e.message))) throw e;
    ({ results: mv } = await db.prepare(
      `SELECT substr(occurredAt, 1, 7) AS month, kind, '' AS reason, SUM(-qtyDelta * unitCostCents) AS outCents,
              SUM(qtyDelta * unitCostCents) AS inCents, SUM(qtyDelta) AS units
       FROM inventory_movements WHERE occurredAt >= ? AND occurredAt <= ? AND kind IN ('consume', 'purchase', 'writeoff', 'adjust') AND voidedAt IS NULL
       GROUP BY month, kind`
    ).bind(dateFrom, dateTo).all());
  }
  let fg = [];
  try {
    ({ results: fg } = await db.prepare(
      `SELECT substr(occurredAt, 1, 7) AS month, kind, SUM(qtyDelta * unitCostCents) AS inCents, SUM(qtyDelta) AS units
       FROM finished_goods_movements WHERE occurredAt >= ? AND occurredAt <= ? AND voidedAt IS NULL GROUP BY month, kind`
    ).bind(dateFrom, dateTo).all());
  } catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
  const { results: est } = await db.prepare(
    `SELECT substr(o.manufacturedAt, 1, 7) AS month, SUM(i.cogsCents) AS cents, SUM(i.qty) AS units
     FROM order_items i JOIN orders o ON o.orderId = i.orderId
     WHERE i.cogsSource = 'estimate' AND o.manufacturedAt >= ? AND o.manufacturedAt <= ? AND o.isTest = 0
     GROUP BY month`
  ).bind(dateFrom, dateTo).all();
  const { results: missing } = await db.prepare(
    `SELECT i.orderId, i.name, i.size, i.qty, i.productId, o.orgId,
            EXISTS (SELECT 1 FROM product_blank_links l WHERE l.orgId = i.orgId AND l.productId = i.productId
                      AND l.productColor = (CASE WHEN i.configJson LIKE '{%' THEN COALESCE(json_extract(i.configJson,'$.garmentColor'),'') ELSE '' END)
                      AND l.productSize = i.size) AS linkedNow
     FROM order_items i JOIN orders o ON o.orderId = i.orderId
     WHERE o.manufacturedAt >= ? AND o.manufacturedAt <= ? AND i.cancelDate IS NULL AND i.cogsCents IS NULL
       AND o.isTest = 0 AND o.voidedAt IS NULL AND NOT ${nb("i")} ORDER BY o.manufacturedAt`
  ).bind(dateFrom, dateTo).all();
  const months = {};
  const at = (m) => (months[m] = months[m] || { month: m, cogsBlanks: 0, cogsFinished: 0, estimated: 0, unitsUsed: 0, purchases: 0,
    toFinished: 0, writeoffsTesting: 0, writeoffsDamagedLost: 0, writeoffsOther: 0, corrections: 0 });
  for (const r of mv) {
    const m = at(r.month);
    if (r.kind === "consume" && r.reason === "finished") m.toFinished += Number(r.outCents);
    else if (r.kind === "consume") { m.cogsBlanks += Number(r.outCents); m.unitsUsed += -Number(r.units); }
    if (r.kind === "purchase") m.purchases += Number(r.inCents);
    if (r.kind === "adjust") m.corrections += Number(r.inCents);
    if (r.kind === "writeoff") {
      if (r.reason === "testing") m.writeoffsTesting += Number(r.outCents);
      else if (r.reason === "damaged" || r.reason === "lost") m.writeoffsDamagedLost += Number(r.outCents);
      else m.writeoffsOther += Number(r.outCents);
    }
  }
  // Finished stock: `make` arrives from blanks (the same amount as toFinished above — it nets to $0),
  // `sell` − `return` is cost of goods, `opening` / `adjust` are corrections.
  for (const r of fg) {
    const m = at(r.month);
    if (r.kind === "sell" || r.kind === "return") { m.cogsFinished += -Number(r.inCents); m.unitsUsed += -Number(r.units); }
    if (r.kind === "opening" || r.kind === "adjust") m.corrections += Number(r.inCents);
  }
  for (const r of est) { const m = at(r.month); m.estimated += Number(r.cents); m.unitsUsed += Number(r.units); }
  const rows = Object.values(months).sort((a, b) => a.month.localeCompare(b.month)).map(m => {
    const writeoffs = m.writeoffsTesting + m.writeoffsDamagedLost + m.writeoffsOther;
    return {
      month: m.month, cogs: fromCents(m.cogsBlanks + m.cogsFinished + m.estimated), estimatedPart: fromCents(m.estimated),
      cogsBlanks: fromCents(m.cogsBlanks), cogsFinished: fromCents(m.cogsFinished),
      unitsUsed: m.unitsUsed, purchases: fromCents(m.purchases), writeoffs: fromCents(writeoffs),
      writeoffsTesting: fromCents(m.writeoffsTesting), writeoffsDamagedLost: fromCents(m.writeoffsDamagedLost), writeoffsOther: fromCents(m.writeoffsOther),
      toFinished: fromCents(m.toFinished), corrections: fromCents(m.corrections) };
  });
  // Why each made line has no cost: `reason` "linkedNow" (its size IS linked now — it was made before
  // the link existed; "Use blanks for past orders" fixes it), "notLinked" (link the size first) or
  // "custom" (a custom line with no product — it can't be linked to a blank).
  return { rows, missingCost: missing.map(r => ({ orderId: r.orderId, orgId: r.orgId, name: r.name, size: r.size, qty: Number(r.qty),
    reason: !r.productId || r.productId === "__custom__" ? "custom" : Number(r.linkedNow) ? "linkedNow" : "notLinked" })) };
}

// ---- Transfer-sheet inventory & COGS (migrations/0036) --------------------
// Mirrors blanks: transfers.quantity caches the transfer_movements sum (applications on hand),
// purchasePriceCents is the running weighted-average cost per application. A graphic (kind
// 'transfer') links to a transfer item; using that graphic on a made order consumes one
// application per garment at the average cost → the line's COGS (blank + transfers).

function parseTransfer_(r) {
  return { id: Number(r.id), name: r.name || "", description: r.description || "",
    orgIds: tryParse_(r.orgIdsJson, []) || [], quantity: Number(r.quantity) || 0,
    purchasePrice: fromCents(r.purchasePriceCents), visible: !!r.visible, sortOrder: Number(r.sortOrder) || 0 };
}

// All transfer items, or (with orgId) those available to that org (no org list = all orgs).
export async function listTransfers(db, orgId) {
  const { results } = await db.prepare("SELECT * FROM transfers ORDER BY sortOrder, name").all();
  let rows = results.map(parseTransfer_);
  if (orgId) rows = rows.filter(t => !t.orgIds.length || t.orgIds.includes(orgId));
  return rows;
}

export async function createTransfer(db, f) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    `INSERT INTO transfers (name, description, orgIdsJson, quantity, purchasePriceCents, visible, sortOrder, createdAt, updatedAt)
     VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?)`
  ).bind(String(f.name || "").slice(0, 120), String(f.description || "").slice(0, 500),
    JSON.stringify(Array.isArray(f.orgIds) ? f.orgIds : []), f.visible === false ? 0 : 1, Number(f.sortOrder) || 0, now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

export async function updateTransfer(db, id, f) {
  await db.prepare("UPDATE transfers SET name=?, description=?, orgIdsJson=?, visible=?, sortOrder=?, updatedAt=? WHERE id=?")
    .bind(String(f.name || "").slice(0, 120), String(f.description || "").slice(0, 500),
      JSON.stringify(Array.isArray(f.orgIds) ? f.orgIds : []), f.visible === false ? 0 : 1, Number(f.sortOrder) || 0, new Date().toISOString(), Number(id)).run();
}

// Refused while any graphic links to it (same reference-check pattern as deleteBlank/deleteHoop).
export async function deleteTransfer(db, id) {
  const used = await db.prepare("SELECT COUNT(*) n FROM graphics WHERE transferId=?").bind(Number(id)).first().catch(() => null);
  if (used && Number(used.n) > 0) throw new Error("A graphic uses this transfer — change that first");
  // A reorder QR code points straight at its transfer (migrations/0047).
  const qrOrg = await db.prepare("SELECT COUNT(*) n FROM orgs WHERE reorderQrTransferId=?").bind(Number(id)).first().catch(() => null);
  if (qrOrg && Number(qrOrg.n) > 0) throw new Error("A shop uses this transfer as its reorder QR code — change that first (Manage catalog → the shop → Edit)");
  const qrProd = await db.prepare("SELECT COUNT(*) n FROM products WHERE reorderQr=?").bind("t" + Number(id)).first().catch(() => null);
  if (qrProd && Number(qrProd.n) > 0) throw new Error("A product uses this transfer as its reorder QR code — change that on the product first");
  await db.prepare("DELETE FROM transfers WHERE id=?").bind(Number(id)).run();
}

async function transferName_(db, id) {
  const t = await db.prepare("SELECT name FROM transfers WHERE id=?").bind(Number(id)).first();
  return t ? (t.name || "") : "";
}

function transferMovementStmt_(db, m) {
  const now = new Date().toISOString();
  return db.prepare(
    `INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, orderId, itemId, vendor, vendorRef, note, pctOfSheet, occurredAt, createdAt, accountId, paidPersonally, receiptKey, receiptName, receiptGroup)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(Number(m.transferId), m.transferName || "", Math.trunc(m.qtyDelta), Math.max(0, Math.round(Number(m.unitCostCents) || 0)),
    m.kind, m.orderId || null, m.itemId || null, String(m.vendor || "").slice(0, 100), String(m.vendorRef || "").slice(0, 100),
    String(m.note || "").slice(0, 300), m.pctOfSheet == null ? null : Number(m.pctOfSheet), m.occurredAt || now, now,
    m.accountId ? Number(m.accountId) : null, m.paidPersonally ? 1 : 0, String(m.receiptKey || "").slice(0, 300), String(m.receiptName || "").slice(0, 200),
    m.receiptGroup ? String(m.receiptGroup).slice(0, 64) : null);
}

// How a transfer sheet's cost divides: each row gets its own percentage of the sheet, and the two parts
// that never become inventory — written off (an expense) and personal use (an owner draw) — get theirs.
// Whole cents that always add back up to the total exactly (largest remainder). receiveTransferSheet and
// the admin API both use this, so the cost recorded on the movements and the cost recorded for the
// other two parts can't disagree.
export const SHEET_PCT_TOLERANCE = 0.05; // percentage points of slack for typed values like 33.3 + 33.3 + 33.4
export function transferSheetShares(pcts, writeoffPct, personalPct, totalCents) {
  const wo = Math.max(0, Number(writeoffPct) || 0), pe = Math.max(0, Number(personalPct) || 0);
  const shares = spreadCents([...pcts, wo, pe], totalCents);
  return { rowCents: shares.slice(0, pcts.length), writeoffCents: shares[pcts.length], personalCents: shares[pcts.length + 1] };
}

// One transfer-sheet receipt (totalCents) split across rows by each row's percentage of the sheet;
// each row's $ is then divided across its `count` applications into whole-cent unit costs (a total
// that doesn't divide evenly becomes two unit costs a cent apart — same trick as landedCostLines).
// Each part writes a `purchase` movement and updates the item's weighted-average cost + quantity in
// one batch (atomic, race-safe), exactly like receiveBlanks. rows: [{transferId, count, pctOfSheet}].
export async function receiveTransferSheet(db, { rows, totalCents, vendor, vendorRef, receivedAt, accountId, paidPersonally, note, receiptKey, receiptName, receiptGroup, writeoffPct = 0, personalPct = 0 }) {
  const clean = (rows || []).map(r => ({ transferId: Number(r.transferId), count: Math.floor(Number(r.count) || 0), pct: Math.max(0, Number(r.pctOfSheet) || 0) }))
    .filter(r => r.transferId && r.count > 0);
  if (!clean.length) return [];
  const total = Math.max(0, Math.round(Number(totalCents) || 0));
  // $ per row by its share of the sheet. writeoffPct / personalPct are the parts NOT put into inventory (recorded
  // by the caller as an expense / owner draw); with neither, the rows split the whole total.
  const { rowCents } = transferSheetShares(clean.map(r => r.pct), writeoffPct, personalPct, total);
  const ids = [];
  for (let i = 0; i < clean.length; i++) {
    const r = clean[i], cents = rowCents[i], base = Math.floor(cents / r.count), up = cents - base * r.count;
    const name = await transferName_(db, r.transferId);
    const parts = [];
    if (r.count - up > 0) parts.push({ qty: r.count - up, unit: base });
    if (up > 0) parts.push({ qty: up, unit: base + 1 });
    for (const p of parts) {
      const res = await db.batch([
        transferMovementStmt_(db, { transferId: r.transferId, transferName: name, qtyDelta: p.qty, unitCostCents: p.unit, kind: "purchase",
          vendor, vendorRef, note: note || "Received", pctOfSheet: r.pct, occurredAt: receivedAt,
          accountId: paidPersonally ? null : (accountId || null), paidPersonally: !!paidPersonally, receiptKey, receiptName, receiptGroup }),
        db.prepare(
          `UPDATE transfers SET
             purchasePriceCents = CAST(ROUND((MAX(quantity, 0) * purchasePriceCents + ? * ?) * 1.0 / (MAX(quantity, 0) + ?)) AS INTEGER),
             quantity = quantity + ?, updatedAt = ? WHERE id = ?`
        ).bind(p.unit, p.qty, p.qty, p.qty, new Date().toISOString(), r.transferId),
      ]);
      ids.push(Number(res[0] && res[0].meta && res[0].meta.last_row_id) || 0);
    }
  }
  return ids;
}

export async function writeOffTransfers(db, { transferId, qty, note, occurredAt }) {
  const q = Math.floor(Number(qty) || 0);
  if (q <= 0) return;
  const cur = await db.prepare("SELECT purchasePriceCents FROM transfers WHERE id=?").bind(Number(transferId)).first();
  await db.batch([
    transferMovementStmt_(db, { transferId, transferName: await transferName_(db, transferId), qtyDelta: -q, unitCostCents: cur ? cur.purchasePriceCents : 0,
      kind: "writeoff", note: note || "Write-off", occurredAt }),
    db.prepare("UPDATE transfers SET quantity = quantity - ?, updatedAt=? WHERE id=?").bind(q, new Date().toISOString(), Number(transferId)),
  ]);
}

// Consume one application per garment of each given transfer for one line (customer-chosen options +
// the reorder QR), at the current average cost, adding to the line's COGS (blank + transfers).
// Called when a transfer application is marked made. Returns total cents added.
async function consumeTransfersForItem_(db, item, transferIds) {
  const qty = Math.max(1, Number(item.qty) || 1);
  let added = 0;
  for (const tid of (transferIds || [])) {
    if (!tid) continue;
    const t = await db.prepare("SELECT name, purchasePriceCents FROM transfers WHERE id=?").bind(Number(tid)).first();
    if (!t) continue;
    const cost = Number(t.purchasePriceCents) || 0;
    await db.batch([
      transferMovementStmt_(db, { transferId: Number(tid), transferName: t.name || "", qtyDelta: -qty, unitCostCents: cost, kind: "consume",
        orderId: item.orderId, itemId: item.id, note: "Used for order " + item.orderId, occurredAt: new Date().toISOString() }),
      db.prepare("UPDATE transfers SET quantity = quantity - ?, updatedAt=? WHERE id=?").bind(qty, new Date().toISOString(), Number(tid)),
    ]);
    added += cost * qty;
  }
  if (added > 0) await db.prepare("UPDATE order_items SET cogsCents = COALESCE(cogsCents,0) + ?, cogsSource='consumed' WHERE id=?").bind(added, Number(item.id)).run();
  return added;
}

// Consume a fully-made configurable line's transfer applications (customer options + reorder QR)
// exactly once — whichever screen completed it (embroidery Run Order hoopings OR Run Transfer
// Sheets). Idempotent (a prior consume movement for this line = already done) and a no-op on a
// pre-0036 schema. Called when a line reaches its full manufacturedQty.
async function consumeLineTransfersOnce_(db, orderId, itemId) {
  try {
    const item = await db.prepare("SELECT * FROM order_items WHERE id=?").bind(Number(itemId)).first();
    const cfg = item && !Number(item.fromStock) && tryParse_(item.configJson, null);   // a stock line used no transfers (0060)
    if (!cfg) return;
    const transferIds = (cfg.locations || []).filter(l => l.kind === "transfer" && Number(l.transferId)).map(l => Number(l.transferId));
    if (!transferIds.length) return;
    const already = await db.prepare("SELECT COUNT(*) n FROM transfer_movements WHERE itemId=? AND kind='consume'").bind(Number(itemId)).first();
    if (already && Number(already.n) > 0) return;
    await consumeTransfersForItem_(db, { id: item.id, orderId: item.orderId, qty: Math.max(1, Number(item.qty) || 1) }, transferIds);
  } catch (e) { if (!/no such (table|column)/i.test(String(e && e.message))) throw e; }
}

export async function getTransferMovements(db, transferId) {
  const { results } = await db.prepare(
    "SELECT * FROM transfer_movements WHERE transferId=? ORDER BY occurredAt DESC, id DESC LIMIT 500"
  ).bind(Number(transferId)).all();
  return results.map(r => ({ id: Number(r.id), qtyDelta: Number(r.qtyDelta), unitCost: fromCents(r.unitCostCents), kind: r.kind,
    orderId: r.orderId || "", vendor: r.vendor || "", vendorRef: r.vendorRef || "", note: r.note || "", pctOfSheet: r.pctOfSheet == null ? null : Number(r.pctOfSheet),
    occurredAt: r.occurredAt, receiptKey: r.receiptKey || "", receiptName: r.receiptName || "", voidedAt: r.voidedAt || "", voidReason: r.voidReason || "" }));
}

async function recomputeTransferFromHistory_(db, transferId) {
  const { results } = await db.prepare(
    "SELECT qtyDelta, unitCostCents, kind FROM transfer_movements WHERE transferId=? AND voidedAt IS NULL ORDER BY occurredAt, id"
  ).bind(Number(transferId)).all();
  let qty = 0, avg = 0;
  for (const m of results) {
    const d = Number(m.qtyDelta);
    if (d > 0 && (m.kind === "purchase" || m.kind === "adjust")) {
      const onHand = Math.max(0, qty);
      avg = Math.round((onHand * avg + d * Number(m.unitCostCents)) / (onHand + d));
    }
    qty += d;
  }
  await db.prepare("UPDATE transfers SET quantity=?, purchasePriceCents=?, updatedAt=? WHERE id=?")
    .bind(qty, avg, new Date().toISOString(), Number(transferId)).run();
}

// Void a mistaken transfer movement (purchase/adjust/writeoff only); recompute from what's left.
export async function voidTransferMovement(db, id, reason) {
  const row = await db.prepare("SELECT * FROM transfer_movements WHERE id=?").bind(Number(id)).first();
  if (!row || row.voidedAt || !["purchase", "adjust", "writeoff"].includes(row.kind)) return null;
  await db.prepare("UPDATE transfer_movements SET voidedAt=?, voidReason=? WHERE id=? AND voidedAt IS NULL")
    .bind(new Date().toISOString(), String(reason || "").slice(0, 300), Number(id)).run();
  await recomputeTransferFromHistory_(db, row.transferId);
  return row;
}

export async function getTransferMovementById(db, id) {
  const r = await db.prepare("SELECT * FROM transfer_movements WHERE id=?").bind(Number(id)).first();
  if (!r) return null;
  return { id: Number(r.id), transferId: Number(r.transferId), transferName: r.transferName || "", qtyDelta: Number(r.qtyDelta),
    unitCost: fromCents(r.unitCostCents), kind: r.kind, orderId: r.orderId || "", vendor: r.vendor || "", vendorRef: r.vendorRef || "",
    note: r.note || "", occurredAt: r.occurredAt, voidedAt: r.voidedAt || "", voidReason: r.voidReason || "" };
}

export async function transferMovementMonth(db, id) {
  const r = await db.prepare("SELECT occurredAt FROM transfer_movements WHERE id=?").bind(Number(id)).first();
  return r ? monthOf(r.occurredAt) : "";
}

// Why a voided transfer movement can't be restored right now, or "" if it can. Same rules as blanks
// (getInventoryRestoreBlocker): only purchase/adjust/writeoff rows are voidable, so only they are
// restorable, and a restore that TAKES applications out of stock is refused when fewer are on hand.
export async function getTransferRestoreBlocker(db, row) {
  if (!row) return "Entry not found";
  if (!row.voidedAt) return "That entry isn't voided";
  if (!["purchase", "adjust", "writeoff"].includes(row.kind)) return "This entry was generated automatically (from an order) and was never voidable.";
  const delta = Number(row.qtyDelta);
  if (delta < 0) {
    const cur = await db.prepare("SELECT quantity FROM transfers WHERE id=?").bind(Number(row.transferId)).first();
    const onHand = cur ? Number(cur.quantity) : 0;
    if (onHand + delta < 0) {
      return `Restoring this would take ${-delta} out of stock but only ${onHand} ${onHand === 1 ? "is" : "are"} on hand now (it would go below zero).`;
    }
  }
  return "";
}

// Undo a transfer void: counts toward stock, average cost, valuation and COGS again (recomputed from
// the whole history, like the void). Returns the row, or null if it can't be restored.
export async function restoreTransferMovement(db, id) {
  const row = await db.prepare("SELECT * FROM transfer_movements WHERE id=?").bind(Number(id)).first();
  if (await getTransferRestoreBlocker(db, row)) return null;
  const r = await db.prepare("UPDATE transfer_movements SET voidedAt=NULL, voidReason='' WHERE id=? AND voidedAt IS NOT NULL")
    .bind(Number(id)).run();
  if (!((r.meta && r.meta.changes) > 0)) return null;
  await recomputeTransferFromHistory_(db, row.transferId);
  return row;
}

// Transfer inventory on hand + value at the end of a moment, and COGS by month — same shape as the
// blank valuation/COGS, so the Inventory & COGS report can show a Transfers section beside blanks.
export async function getTransferValuation(db, asOf) {
  const { results } = await db.prepare(
    "SELECT transferId, transferName, qtyDelta, unitCostCents, kind FROM transfer_movements WHERE occurredAt <= ? AND voidedAt IS NULL ORDER BY occurredAt, id"
  ).bind(asOf).all();
  const state = new Map();
  for (const m of results) {
    const key = String(m.transferId);
    const st = state.get(key) || { transferId: Number(m.transferId), name: m.transferName, qty: 0, avg: 0 };
    const d = Number(m.qtyDelta);
    if (d > 0 && (m.kind === "purchase" || m.kind === "adjust")) {
      const onHand = Math.max(0, st.qty);
      st.avg = Math.round((onHand * st.avg + d * Number(m.unitCostCents)) / (onHand + d));
    }
    st.qty += d; st.name = m.transferName || st.name;
    state.set(key, st);
  }
  const rows = [...state.values()].filter(r => r.qty !== 0)
    .map(r => ({ transferId: r.transferId, name: r.name, qty: r.qty, avgCost: fromCents(r.avg), value: fromCents(Math.max(0, r.qty) * r.avg) }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return { asOf, rows, units: rows.reduce((s, r) => s + r.qty, 0), value: fromCents(rows.reduce((s, r) => s + toCents(r.value), 0)) };
}

export async function getTransferCogs(db, dateFrom, dateTo) {
  const { results: mv } = await db.prepare(
    `SELECT substr(occurredAt, 1, 7) AS month, kind, SUM(-qtyDelta * unitCostCents) AS outCents, SUM(qtyDelta * unitCostCents) AS inCents
     FROM transfer_movements WHERE occurredAt >= ? AND occurredAt <= ? AND kind IN ('consume', 'purchase', 'writeoff') AND voidedAt IS NULL
     GROUP BY month, kind`
  ).bind(dateFrom, dateTo).all();
  const months = {};
  const at = (m) => (months[m] = months[m] || { month: m, cogs: 0, purchases: 0, writeoffs: 0 });
  for (const r of mv) {
    const m = at(r.month);
    if (r.kind === "consume") m.cogs += Number(r.outCents);
    if (r.kind === "purchase") m.purchases += Number(r.inCents);
    if (r.kind === "writeoff") m.writeoffs += Number(r.outCents);
  }
  return Object.values(months).sort((a, b) => a.month.localeCompare(b.month))
    .map(m => ({ month: m.month, cogs: fromCents(m.cogs), purchases: fromCents(m.purchases), writeoffs: fromCents(m.writeoffs) }));
}

// ---- Graphics / selectable options catalog + tier prices (migrations/0036) ----
// A graphic is a customer-selectable option in a configurable product's per-location menu — either
// an embroidery design (→ designs, feeds the Run Order hooping flow) or a transfer-sheet graphic
// (→ a transfer inventory item, feeds Run Transfer Sheets). Its tier sets the add-on price from the
// org's per-org tier prices (NULL tier = $0/included).

function parseGraphic_(r) {
  return { id: Number(r.id), orgId: r.orgId, name: r.name || "", kind: r.kind === "embroidery" ? "embroidery" : "transfer",
    designId: r.designId == null ? null : Number(r.designId), transferId: r.transferId == null ? null : Number(r.transferId),
    tier: r.tier || null, inkColors: tryParse_(r.inkColorsJson, []) || [], imageUrl: r.imageUrl || "", thumbUrl: r.thumbUrl || "",
    allowedLocations: tryParse_(r.allowedLocationsJson, []) || [], allowedGarmentColors: tryParse_(r.allowedGarmentColorsJson, []) || [],
    visible: !!r.visible, sortOrder: Number(r.sortOrder) || 0, isGlobal: !!Number(r.isGlobal) };
}
// A shop may use its own graphics and every global one (migrations/0078).
const graphicUsableBy_ = (g, orgId) => !!g && (g.orgId === orgId || !!Number(g.isGlobal));

// The shop's own graphics, then every global graphic (migrations/0078). A database before 0077 lists the shop's own.
export async function listGraphics(db, orgId) {
  let results;
  try { ({ results } = await db.prepare("SELECT * FROM graphics WHERE orgId=? OR isGlobal=1 ORDER BY isGlobal, sortOrder, name").bind(orgId).all()); }
  catch (e) {
    if (!/no such column/i.test(String(e && e.message))) throw e;
    ({ results } = await db.prepare("SELECT * FROM graphics WHERE orgId=? ORDER BY sortOrder, name").bind(orgId).all());
  }
  return results.map(parseGraphic_);
}

// Other shops' products using a graphic — a global graphic can't be made shop-only while any do.
async function graphicUsedByOtherShops_(db, id, homeOrgId) {
  const gid = Number(id);
  const { results } = await db.prepare("SELECT locationsJson, fixedTransfersJson, mockupGraphicsJson FROM products WHERE orgId<>?").bind(homeOrgId).all().catch(() => ({ results: [] }));
  return results.filter(p => (tryParse_(p.locationsJson, []) || []).some(l => ((l && l.graphicIds) || []).map(Number).includes(gid))
    || (tryParse_(p.fixedTransfersJson, []) || []).some(f => Number(f && f.graphicId) === gid)
    || (tryParse_(p.mockupGraphicsJson, []) || []).some(f => Number(f && f.graphicId) === gid)).length;
}
// Why a graphic can't be global / saved as asked, or "": a global graphic may only use a global design and a transfer
// open to every shop; a global one can't be made shop-only while other shops' products use it.
export async function graphicGlobalProblem(db, cur, g) {
  const isGlobal = g.isGlobal !== undefined ? !!g.isGlobal : !!(cur && cur.isGlobal);
  if (isGlobal) {
    if (g.kind === "embroidery" && g.designId != null && g.designId !== "") {
      const d = await db.prepare("SELECT isGlobal FROM designs WHERE id=?").bind(Number(g.designId)).first().catch(() => null);
      if (!d || !Number(d.isGlobal)) return "A global graphic can only use a global design — make the design global first, or leave it unlinked.";
    }
    if (g.kind !== "embroidery" && g.transferId != null && g.transferId !== "") {
      const t = await db.prepare("SELECT orgIdsJson FROM transfers WHERE id=?").bind(Number(g.transferId)).first().catch(() => null);
      if (!t || (tryParse_(t.orgIdsJson, []) || []).length) return "A global graphic can only use a transfer every shop can use — open the transfer to every shop first, or leave it unlinked.";
    }
  }
  if (!isGlobal && cur && cur.isGlobal && await graphicUsedByOtherShops_(db, cur.id, cur.orgId))
    return "Other shops' products use this global graphic — remove it there before making it shop-only.";
  return "";
}

export async function getGraphic(db, id) {
  const r = await db.prepare("SELECT * FROM graphics WHERE id=?").bind(Number(id)).first();
  return r ? parseGraphic_(r) : null;
}

function graphicBinds_(g) {
  return [String(g.name || "").slice(0, 120), g.kind === "embroidery" ? "embroidery" : "transfer",
    g.designId == null || g.designId === "" ? null : Number(g.designId),
    g.transferId == null || g.transferId === "" ? null : Number(g.transferId),
    g.tier && ["small", "medium", "large"].includes(g.tier) ? g.tier : null,
    JSON.stringify(Array.isArray(g.inkColors) ? g.inkColors : []),
    String(g.imageUrl || "").slice(0, 600), String(g.thumbUrl || "").slice(0, 600),
    JSON.stringify(Array.isArray(g.allowedLocations) ? g.allowedLocations : []),
    JSON.stringify(Array.isArray(g.allowedGarmentColors) ? g.allowedGarmentColors : []),
    g.visible === false ? 0 : 1, Number(g.sortOrder) || 0];
}

export async function createGraphic(db, orgId, g) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    `INSERT INTO graphics (orgId, name, kind, designId, transferId, tier, inkColorsJson, imageUrl, thumbUrl,
       allowedLocationsJson, allowedGarmentColorsJson, visible, sortOrder, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(orgId, ...graphicBinds_(g), now, now).run();
  const id = Number(r.meta && r.meta.last_row_id) || 0;
  if (g.isGlobal && id) await db.prepare("UPDATE graphics SET isGlobal=1 WHERE id=?").bind(id).run();
  return id;
}

export async function updateGraphic(db, id, g) {
  await db.prepare(
    `UPDATE graphics SET name=?, kind=?, designId=?, transferId=?, tier=?, inkColorsJson=?, imageUrl=?, thumbUrl=?,
       allowedLocationsJson=?, allowedGarmentColorsJson=?, visible=?, sortOrder=?, updatedAt=? WHERE id=?`
  ).bind(...graphicBinds_(g), new Date().toISOString(), Number(id)).run();
  if (g.isGlobal !== undefined) await db.prepare("UPDATE graphics SET isGlobal=? WHERE id=?").bind(g.isGlobal ? 1 : 0, Number(id)).run();
}

// Switch a graphic off (or back on) for ONE color of ONE product — the mockup table's "don't offer
// this combination" (migrations/0050). Per product because a color name is the blank vendor's label.
// Kept apart from updateProduct so a caller that doesn't know the list can't clear it.
export async function setProductGraphicColorBlocked(db, orgId, productId, graphicId, color, blocked) {
  const row = await db.prepare("SELECT blockedGraphicColorsJson FROM products WHERE orgId=? AND productId=?").bind(orgId, productId).first();
  if (!row) throw new Error("Product not found");
  const gid = Number(graphicId), c = String(color || "").trim().slice(0, 120);
  if (!gid || !c) throw new Error("A graphic and a color are required");
  const list = (tryParse_(row.blockedGraphicColorsJson, []) || []).filter(b => !(Number(b.graphicId) === gid && b.color === c));
  if (blocked) list.push({ graphicId: gid, color: c });
  await db.prepare("UPDATE products SET blockedGraphicColorsJson=?, updatedAt=? WHERE orgId=? AND productId=?").bind(JSON.stringify(list), new Date().toISOString(), orgId, productId).run();
  return list;
}

// Refused while a product's location menu or an org's reorder-QR default references it.
export async function deleteGraphic(db, id) {
  const gid = Number(id);
  const g = await db.prepare("SELECT orgId FROM graphics WHERE id=?").bind(gid).first();
  if (!g) return;
  // Every shop's products: a global graphic (migrations/0078) can be on any of them.
  const { results: prods } = await db.prepare("SELECT locationsJson FROM products WHERE configurable=1").all().catch(() => ({ results: [] }));
  for (const p of prods) {
    for (const loc of (tryParse_(p.locationsJson, []) || [])) {
      if ((loc.graphicIds || []).map(Number).includes(gid)) throw new Error("A product's option menu uses this graphic — remove it there first");
    }
  }
  const org = await db.prepare("SELECT COUNT(*) n FROM orgs WHERE reorderQrGraphicId=?").bind(gid).first().catch(() => null);
  if (org && Number(org.n) > 0) throw new Error("An org's Reorder QR default uses this graphic — change that first");
  const fixed = await db.prepare("SELECT COUNT(*) n FROM products p, json_each(p.fixedTransfersJson) je WHERE json_extract(je.value, '$.graphicId') = ?")
    .bind(gid).first().catch(() => null);   // migrations/0068
  if (fixed && Number(fixed.n) > 0) throw new Error("A product's printed transfers use this graphic — remove it there first");
  const mock = await db.prepare("SELECT COUNT(*) n FROM products p, json_each(p.mockupGraphicsJson) je WHERE json_extract(je.value, '$.graphicId') = ?")
    .bind(gid).first().catch(() => null);   // migrations/0069
  if (mock && Number(mock.n) > 0) throw new Error("A product's embroidered graphics (for mockups) use this graphic — remove it there first");
  await db.prepare("DELETE FROM graphics WHERE id=?").bind(gid).run();
}

// Per-org tier prices (cents) + the org's default reorder QR code: a transfer (reorderQrTransferId,
// migrations/0047), or — the old way — a graphic (reorderQrGraphicId).
export async function getTierPrices(db, orgId) {
  // SELECT * so a database from before 0047 (no reorderQrTransferId column) still answers.
  const r = await db.prepare("SELECT * FROM orgs WHERE orgId=?").bind(orgId).first().catch(() => null);
  const t = tryParse_(r && r.tierPricesJson, null) || { small: 100, medium: 200, large: 400 };
  return { tiersCents: { small: Number(t.small) || 0, medium: Number(t.medium) || 0, large: Number(t.large) || 0 },
    reorderQrGraphicId: r && r.reorderQrGraphicId != null ? Number(r.reorderQrGraphicId) : null,
    reorderQrTransferId: r && r.reorderQrTransferId != null ? Number(r.reorderQrTransferId) : null };
}

export async function setTierPrices(db, orgId, tiersDollars) {
  const toC = (v) => Math.max(0, Math.round((Number(v) || 0) * 100));
  const json = JSON.stringify({ small: toC(tiersDollars.small), medium: toC(tiersDollars.medium), large: toC(tiersDollars.large) });
  await db.prepare("UPDATE orgs SET tierPricesJson=?, updatedAt=? WHERE orgId=?").bind(json, new Date().toISOString(), orgId).run();
}

export async function setOrgReorderQr(db, orgId, graphicId) {
  await db.prepare("UPDATE orgs SET reorderQrGraphicId=?, updatedAt=? WHERE orgId=?")
    .bind(graphicId == null || graphicId === "" ? null : Number(graphicId), new Date().toISOString(), orgId).run();
}

// The shop's default reorder QR code as a transfer (migrations/0047). Setting it clears the old
// graphic pointer, so there's one answer and that graphic can be deleted.
export async function setOrgReorderQrTransfer(db, orgId, transferId) {
  await db.prepare("UPDATE orgs SET reorderQrTransferId=?, reorderQrGraphicId=NULL, updatedAt=? WHERE orgId=?")
    .bind(transferId == null || transferId === "" ? null : Number(transferId), new Date().toISOString(), orgId).run();
}

// A product's effective reorder QR code → {transferId} | {graphicId} | null.
// 'none' → null; 'default' → the shop's (its transfer, else its old-style graphic); 't<id>' → that
// transfer; a bare number → that graphic (the old way).
function resolveReorderQr_(productReorderQr, orgDefault) {
  const v = String(productReorderQr || "default");
  if (v === "none") return null;
  if (v === "default") return orgDefault && orgDefault.transferId ? { transferId: Number(orgDefault.transferId) }
    : orgDefault && orgDefault.graphicId ? { graphicId: Number(orgDefault.graphicId) } : null;
  const t = v.match(/^t(\d+)$/);
  if (t) return Number(t[1]) > 0 ? { transferId: Number(t[1]) } : null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? { graphicId: n } : null;
}

// ---- Run Transfer Sheets queue / gang sheet (migrations/0036) -------------
// Lines carrying a transfer application (a customer's transfer option, or the reorder QR — which a
// plain product can carry too, migrations/0048), on real/paid/active orders.
// "ready" = blank received AND transfers in hand (transfersInHand_: used, marked, or covered by stock);
// "waiting" = missing either.
// Two kinds of line (`hasEmbroidery`, from the same hooping plan Run Order uses):
//   * transfer-only — listed until it's made; "Mark made" here makes the line.
//   * also embroidered — it's on Run Order too. Finishing the embroidery there makes the piece; it
//     stays listed HERE until its transfers are marked applied (transfersAppliedAt), even after the
//     embroidery is done, until the order ships. `embroideryDone` says where the other half is.
export async function getTransferQueue(db) {
  const nb = await noBlankLine_(db), fs = await fromStockLine_(db);
  const { results } = await db.prepare(
    `SELECT i.id AS itemId, i.orderId, i.orgId, i.name AS itemName, i.size AS itemSize, i.qty, i.configJson,
            COALESCE(i.manufacturedQty,0) AS manufacturedQty, i.transfersAppliedAt, o.manufacturedAt AS orderMadeAt,
            i.transferReceivedAt, COALESCE(i.blankReceivedAt, o.blankReceivedAt) AS blankReceivedAt, ${nb("i")} AS noBlank,
            org.name AS orgName, o.customerName, o.dueDate,
            l.blankId, l.blankSize, b.name AS blankName, COALESCE(NULLIF(l.blankColor, ''), b.color) AS blankColor
     FROM order_items i
     JOIN orders o ON o.orderId = i.orderId
     JOIN orgs org ON org.orgId = i.orgId
     -- The link for THIS line's garment color (migrations/0037). Without the color a product linked
     -- per color matched one row per color, so each line was listed once for every color it comes in.
     LEFT JOIN product_blank_links l ON l.orgId = i.orgId AND l.productId = i.productId AND l.productSize = i.size
            AND l.productColor = (CASE WHEN i.configJson LIKE '{%' THEN COALESCE(json_extract(i.configJson,'$.garmentColor'),'') ELSE '' END)
     LEFT JOIN blanks b ON b.id = l.blankId
     WHERE i.cancelDate IS NULL AND o.paid = 1 AND o.isTest = 0 AND o.voidedAt IS NULL AND i.configJson <> '' AND NOT ${fs("i")}
       -- An order that has shipped, been delivered or been completed has nothing left to press, even if it
       -- was never marked made (production had a delivered + completed order listed with 30 pieces).
       AND o.completedAt IS NULL AND o.shippedAt IS NULL AND o.deliveredAt IS NULL
       AND ((o.manufacturedAt IS NULL AND COALESCE(i.manufacturedQty,0) < i.qty) OR i.transfersAppliedAt IS NULL)
     ORDER BY (o.dueDate IS NULL), o.dueDate, o.placedAt`
  ).all();
  const rows = [];
  for (const r of results) {
    const cfg = tryParse_(r.configJson, null);
    const transfers = cfg ? (cfg.locations || []).filter(l => l.kind === "transfer") : [];
    if (transfers.length) rows.push({ r, cfg, transfers });   // embroidery-only lines belong to Run Order alone
  }
  const embroidered = await linesWithEmbroidery_(db, rows.map(x => Number(x.r.itemId)));
  const live = rows.filter(({ r }) => {
    const made = !!r.orderMadeAt || Number(r.manufacturedQty) >= (Number(r.qty) || 1);
    return embroidered.has(Number(r.itemId)) ? !r.transfersAppliedAt : !made;
  });
  const have = await transfersInHand_(db, live);
  const ready = [], waiting = [];
  for (const { r, cfg, transfers } of live) {
    const hasEmbroidery = embroidered.has(Number(r.itemId));
    const made = !!r.orderMadeAt || Number(r.manufacturedQty) >= (Number(r.qty) || 1);
    const h = have.get(Number(r.itemId));
    const card = {
      itemId: Number(r.itemId), orderId: r.orderId, orgId: r.orgId, orgName: r.orgName || r.orgId,
      customerName: r.customerName, itemName: r.itemName, itemSize: r.itemSize || "", qty: Number(r.qty) || 1,
      dueDate: r.dueDate || "", garmentColor: cfg.garmentColor || "",
      blank: r.blankId == null ? null : { id: Number(r.blankId), name: r.blankName || "", color: r.blankColor || "", size: r.blankSize || "" },
      transfers: transfers.map((t, i) => ({ location: t.label || t.location, graphicName: t.graphicName, ink: t.ink || "",
        imageUrl: t.imageUrl || "", thumbUrl: t.thumbUrl || "", auto: !!t.auto,
        transferId: Number(t.transferId) || null, inStock: !!h.inStock[i],
        // The customer's own image (migrations/0054), in the private bucket — the page asks for a signed link.
        ...(t.custom ? { custom: true, fileKey: t.fileKey || "", fileName: t.fileName || "" } : {}) })),
      blankReceived: !!r.blankReceivedAt || !!Number(r.noBlank),
      // In hand when its transfers were already used (the line was made), it was marked received by hand,
      // or transfer stock covers every application on it (see transfersInHand_).
      transferReceived: !!h.source, transferSource: h.source, transferShort: h.short,
      hasEmbroidery, embroideryDone: hasEmbroidery && made,
    };
    (card.blankReceived && card.transferReceived ? ready : waiting).push(card);
  }
  return { ready, waiting };
}

// Whether each queued line has its transfers in hand, worked out from transfer stock rather than only the
// "Mark transfer received" flag (which receiving a sheet never set, so lines filled from stock sat under
// "Waiting" forever). Per line: `source` = "used" (a consume movement exists — the line was made and its
// transfers came out of stock), "marked" (the flag), "stock" (stock covers every application) or "" (not in
// hand); `inStock[i]` per transfer entry; `short` = what's missing. Stock is shared out like blanks' Use from
// stock: lines marked received hold theirs first (that sheet was bought for them), then the rest in queue
// order (soonest due first), so two lines are never promised the same transfers. A customer's own image, or
// an entry with no transfer linked, has no stock to draw on — only the flag covers it.
async function transfersInHand_(db, rows) {
  const out = new Map();
  const ids = rows.map(x => Number(x.r.itemId));
  const used = new Set(), stock = new Map();
  try {
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const { results } = await db.prepare(`SELECT DISTINCT itemId FROM transfer_movements WHERE kind='consume' AND itemId IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
      for (const m of results) used.add(Number(m.itemId));
    }
    const { results } = await db.prepare("SELECT id, name, quantity FROM transfers").all();
    for (const t of results) stock.set(Number(t.id), { name: t.name || "", free: Number(t.quantity) || 0 });
  } catch (e) { if (!/no such (table|column)/i.test(String(e && e.message))) throw e; }
  const need = (x) => Math.max(1, Number(x.r.qty) || 1);
  const take = (x, i) => {   // one transfer entry's applications for this line, from what's still free
    const t = x.transfers[i], s = t.custom ? null : stock.get(Number(t.transferId));
    if (!s || s.free < need(x)) return false;
    s.free -= need(x);
    return true;
  };
  for (const x of rows) {
    const id = Number(x.r.itemId);
    if (used.has(id)) out.set(id, { source: "used", inStock: x.transfers.map(() => false), short: [] });
  }
  for (const x of rows) {   // marked received: holds its transfers first
    const id = Number(x.r.itemId);
    if (out.has(id) || !x.r.transferReceivedAt) continue;
    out.set(id, { source: "marked", inStock: x.transfers.map((t, i) => take(x, i)), short: [] });
  }
  for (const x of rows) {   // the rest, soonest due first (the query's order)
    const id = Number(x.r.itemId);
    if (out.has(id)) continue;
    const inStock = x.transfers.map((t, i) => take(x, i));
    const short = [];
    x.transfers.forEach((t, i) => {
      if (inStock[i]) return;
      const s = t.custom ? null : stock.get(Number(t.transferId));
      short.push(t.custom ? { name: "Customer design", custom: true } : !s ? { name: t.graphicName || "Transfer", unlinked: true }
        : { name: s.name, free: Math.max(0, s.free), needed: need(x) });
    });
    out.set(id, { source: short.length ? "" : "stock", inStock, short });
  }
  return out;
}

// Which of these line items have embroidery to run (at least one hooping in Run Order's plan).
async function linesWithEmbroidery_(db, itemIds) {
  const out = new Set();
  if (!itemIds.length) return out;
  let ctx = null;
  try { ctx = await hoopingContext_(db, itemIds); }
  catch (e) { if (!/no such (table|column)/i.test(String(e && e.message))) throw e; return out; }
  for (const id of itemIds) { const it = ctx.items[id]; if (it && lineIsEmbroidered_(it, planHoopings_(ctx, it))) out.add(id); }
  return out;
}

export async function setTransferReceived(db, itemId, on) {
  await db.prepare("UPDATE order_items SET transferReceivedAt=? WHERE id=?")
    .bind(on ? new Date().toISOString() : null, Number(itemId)).run();
}

// A line that is also embroidered: record that its transfers were pressed (it then leaves Run
// Transfer Sheets). Doesn't make the piece — finishing the embroidery on Run Order does that, and
// that's also when the transfers' stock is used (consumeLineTransfersOnce_). `on` false undoes it.
export async function setTransfersApplied(db, orderId, itemId, on = true) {
  const item = await db.prepare("SELECT id, cancelDate FROM order_items WHERE id=? AND orderId=?").bind(Number(itemId), orderId).first();
  if (!item) throw new Error("Line item not found");
  if (item.cancelDate) throw new Error("That line item is cancelled");
  await db.prepare("UPDATE order_items SET transfersAppliedAt=? WHERE id=?").bind(on ? new Date().toISOString() : null, Number(itemId)).run();
}
export async function lineHasEmbroidery(db, itemId) {
  return (await linesWithEmbroidery_(db, [Number(itemId)])).has(Number(itemId));
}

// Totals transfer applications (customer options + reorder QR) by graphic × ink × garment size over
// every line still on Run Transfer Sheets — for building gang sheets. Only what still has to be printed:
// a line whose transfers are in hand (used, marked received, or covered by stock) is left out, and on a
// line that's partly covered only the entries stock doesn't cover count.
export async function getGangSheet(db) {
  const q = await getTransferQueue(db);
  const map = new Map();
  for (const c of q.ready.concat(q.waiting)) {
    if (c.transferReceived) continue;
    for (const t of c.transfers) {
      if (t.inStock) continue;
      // A customer's own image is its own art: keyed by its file, so two customers' designs never add up.
      const key = [t.custom ? "custom:" + (t.fileKey || c.itemId) : t.graphicName, t.ink || "", c.itemSize || ""].join("|");
      const row = map.get(key) || { graphic: t.custom ? "Customer design — " + c.customerName + " (" + c.orderId + ")" : t.graphicName,
        ink: t.ink || "", size: c.itemSize || "", count: 0, ...(t.custom ? { custom: true, fileKey: t.fileKey || "", fileName: t.fileName || "" } : {}) };
      row.count += c.qty;
      map.set(key, row);
    }
  }
  return [...map.values()].sort((a, b) => (a.graphic + a.ink + a.size).localeCompare(b.graphic + b.ink + b.size));
}

// Run Transfer Sheets "Mark made": mark the whole line manufactured — which consumes the linked
// blank per piece AND the line's transfer applications once (consumeLineTransfersOnce_ fires from
// markItemPieceManufactured when the last piece lands, so embroidery Run Order and Run Transfer
// Sheets both consume transfers exactly once). Idempotent once the line is fully made.
export async function makeTransferLine(db, orderId, itemId) {
  const item = await db.prepare(
    "SELECT id, orderId, orgId, productId, size, qty, COALESCE(manufacturedQty,0) AS manufacturedQty, configJson, cancelDate FROM order_items WHERE id=? AND orderId=?"
  ).bind(Number(itemId), orderId).first();
  if (!item) throw new Error("Line item not found");
  if (item.cancelDate) throw new Error("That line item is cancelled");
  const qty = Math.max(1, Number(item.qty) || 1);
  if (Number(item.manufacturedQty) >= qty) return { alreadyDone: true, orderComplete: false };
  let res = { orderComplete: false };
  for (let made = Number(item.manufacturedQty); made < qty; made++) res = await markItemPieceManufactured(db, orderId, Number(itemId));
  return { orderComplete: !!res.orderComplete };
}

// ---- Product → blank links ---------------------------------------------

export async function getBlankLinks(db, orgId) {
  const { results } = await db.prepare(
    "SELECT * FROM product_blank_links WHERE orgId=? ORDER BY productId, productColor, productSize"
  ).bind(orgId).all();
  return results.map(r => ({
    id:           Number(r.id),
    orgId:        r.orgId,
    productId:    r.productId,
    productColor: r.productColor || "",
    productSize:  r.productSize  || "",
    blankId:      Number(r.blankId),
    blankColor:   r.blankColor   || "",
    blankSize:    r.blankSize    || "",
  }));
}

// A product's color+size → a blank's color+size (migrations/0037). Accepts the new 8-arg form
// (orgId, productId, productColor, productSize, blankId, blankColor, blankSize) and, for older
// callers/tests, the legacy 6-arg form (orgId, productId, productSize, blankId, blankSize) which
// maps productColor/blankColor to '' (a single-color blank's stock lives under color '').
export async function setBlankLink(db, orgId, productId, a, b, c, d, e) {
  let productColor, productSize, blankId, blankColor, blankSize;
  if (arguments.length >= 8) { productColor = a; productSize = b; blankId = c; blankColor = d; blankSize = e; }
  else { productColor = ""; productSize = a; blankId = b; blankColor = null; blankSize = c; }
  // An omitted blankColor targets the blank's legacy scalar color (single-color blanks), matching
  // receiveBlanks' default, so a legacy link resolves to where that blank's stock actually lives.
  if (blankColor == null) blankColor = await blankScalarColor_(db, Number(blankId));
  await db.prepare(
    `INSERT INTO product_blank_links (orgId, productId, productColor, productSize, blankId, blankColor, blankSize)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (orgId, productId, productColor, productSize) DO UPDATE SET blankId=excluded.blankId, blankColor=excluded.blankColor, blankSize=excluded.blankSize`
  ).bind(orgId, productId, String(productColor || ""), productSize || "", Number(blankId), String(blankColor || ""), blankSize || "").run();
}

export async function deleteBlankLink(db, orgId, productId, a, b) {
  // New: (orgId, productId, productColor, productSize); legacy: (orgId, productId, productSize).
  const productColor = arguments.length >= 5 ? String(a || "") : "";
  const productSize = arguments.length >= 5 ? (b || "") : (a || "");
  await db.prepare(
    "DELETE FROM product_blank_links WHERE orgId=? AND productId=? AND productColor=? AND productSize=?"
  ).bind(orgId, productId, productColor, productSize).run();
}

// ---- Blanks to order (admin → Inventory → Blanks to Order) --------------------------------------
// What to buy from each supplier to make every open order: each order line that still has pieces
// to make is resolved to its blank (the same product_blank_links row that marking it manufactured
// uses — org + product + the line's garment color + size) and added up per blank / color / size.
// A line is one of:
//   need     — its blanks haven't been ordered yet → this is the shopping list
//   onOrder  — its blanks are ordered but not received → already on a supplier order, left out
//   received — its blanks are in → its pieces are spoken for out of the stock on hand (`reserved`),
//              so that stock isn't offered to another order
// Returns the raw counts per row (needed / reserved / onHand / price); the screen turns them into
// "to order" and cost, because it lets the owner choose whether to use stock on hand first. Unpaid
// orders are left out unless `includeUnpaid` (don't order blanks until payment is confirmed — the
// same rule as the per-shop breakdown on Orders), and counted so the screen can say how many.
// Lines with no blank link are returned separately rather than silently dropped. Read-only.
export async function getBlanksToOrder(db, { includeUnpaid = false } = {}) {
  const nb = await noBlankLine_(db);
  const [{ results: lines }, { results: links }, { results: blanks }, { results: sizes }] = await Promise.all([
    db.prepare(
      `SELECT oi.id, oi.orderId, oi.orgId, oi.productId, oi.name, oi.size, oi.qty, COALESCE(oi.manufacturedQty, 0) AS made, oi.configJson,
              COALESCE(oi.blankOrderedAt, o.blankOrderedAt) AS orderedAt, COALESCE(oi.blankReceivedAt, o.blankReceivedAt) AS receivedAt,
              o.paid, o.customerName
       FROM order_items oi JOIN orders o ON o.orderId = oi.orderId
       WHERE oi.cancelDate IS NULL AND o.voidedAt IS NULL AND o.isTest = 0 AND o.completedAt IS NULL AND o.shippedAt IS NULL AND o.deliveredAt IS NULL AND o.manufacturedAt IS NULL
         AND NOT ${nb("oi")}   -- made with no blank (migrations/0057): nothing to buy
       ORDER BY o.placedAt, oi.id`).all(),
    db.prepare("SELECT orgId, productId, productColor, productSize, blankId, blankColor, blankSize FROM product_blank_links").all(),
    // SELECT * so a database without the later columns (vendorConnectionId 0064, vendorPriceCents 0061) still works.
    db.prepare("SELECT * FROM blanks").all(),
    db.prepare("SELECT * FROM blank_sizes").all(),
  ]);
  const linkAt = new Map(links.map(l => [[l.orgId, l.productId, l.productColor || "", l.productSize || ""].join("\u0001"), l]));
  const blankAt = new Map(blanks.map(b => [Number(b.id), b]));
  const sizeAt = new Map(sizes.map(s => [[s.blankId, s.color || "", s.size || ""].join("\u0001"), s]));
  const rows = new Map(), unlinked = [];
  let onOrderPieces = 0, unpaidPieces = 0, unpaidOrders = new Set();
  for (const ln of lines) {
    const left = (Number(ln.qty) || 0) - (Number(ln.made) || 0);
    if (left <= 0) continue;
    const state = ln.receivedAt ? "received" : ln.orderedAt ? "onOrder" : "need";
    if (state === "onOrder") { onOrderPieces += left; continue; }
    if (state === "need" && !ln.paid && !includeUnpaid) { unpaidPieces += left; unpaidOrders.add(ln.orderId); continue; }
    const color = itemColor_(ln);
    const link = ln.productId ? linkAt.get([ln.orgId, ln.productId, color, ln.size || ""].join("\u0001")) : null;
    const blank = link ? blankAt.get(Number(link.blankId)) : null;
    if (!blank) {
      if (state === "need") unlinked.push({ orderId: ln.orderId, orgId: ln.orgId, customerName: ln.customerName || "", name: ln.name || "", color, size: ln.size || "", qty: left,
        reason: ln.productId ? "notLinked" : "custom" });
      continue;
    }
    const key = [blank.id, link.blankColor || "", link.blankSize || ""].join("\u0001");
    let row = rows.get(key);
    if (!row) {
      const sz = sizeAt.get(key);
      row = { blankId: Number(blank.id), vendor: blank.vendor || "", blank: blank.name || "", brand: blank.brand || "", sku: blank.sku || "", productType: blank.productType || "",
        color: link.blankColor || "", size: link.blankSize || "", needed: 0, reserved: 0,
        onHand: sz ? Number(sz.quantity) || 0 : 0, price: sz ? fromCents(sz.purchasePriceCents) : 0,
        vendorPrice: sz && sz.vendorPriceCents != null ? fromCents(sz.vendorPriceCents) : null,
        vendorConnectionId: blank.vendorConnectionId != null ? Number(blank.vendorConnectionId) : null, orders: [], items: [] };
      rows.set(key, row);
    }
    if (state === "received") row.reserved += left;
    else { row.needed += left; if (!row.orders.includes(ln.orderId)) row.orders.push(ln.orderId); row.items.push(Number(ln.id)); (row.productKeys = row.productKeys || new Set()).add(ln.orgId + "|" + ln.productId); }
  }
  // Reorder points (migrations/0074): a size below its "keep at least N" is listed even with no order waiting on it.
  // `restockOnOrder` is restock already ordered and not yet in (restockOnOrder_). The screen works out the restock to
  // add (blanksToOrderRow_ — it depends on "use stock on hand first"); a row is sent when it could need some.
  const inbound = await restockOnOrder_(db);
  for (const sz of sizes) {
    if (sz.reorderPoint == null) continue;
    const key = [sz.blankId, sz.color || "", sz.size || ""].join("\u0001");
    const blank = blankAt.get(Number(sz.blankId));
    if (!blank) continue;
    let row = rows.get(key);
    if (!row) {
      row = { blankId: Number(blank.id), vendor: blank.vendor || "", blank: blank.name || "", brand: blank.brand || "", sku: blank.sku || "", productType: blank.productType || "",
        color: sz.color || "", size: sz.size || "", needed: 0, reserved: 0, onHand: Number(sz.quantity) || 0, price: fromCents(sz.purchasePriceCents),
        vendorPrice: sz.vendorPriceCents != null ? fromCents(sz.vendorPriceCents) : null,
        vendorConnectionId: blank.vendorConnectionId != null ? Number(blank.vendorConnectionId) : null, orders: [], items: [] };
      rows.set(key, row);
    }
    row.reorderPoint = Number(sz.reorderPoint);
    row.restockOnOrder = inbound.get(key) || 0;
  }
  // Restricted brands (migrations/0075): the rule, and per product the line's pieces are for, its supplier approval —
  // {"<orgId>|<productId>": maxQty (null = any amount) | false (none)}. The screen totals the pieces per style.
  const brandRules = await getBrandRules(db).catch(() => null);
  const approvals = await activeBrandApprovals_(db);
  for (const row of rows.values()) {
    const rule = brandRuleFor_(brandRules, row.brand);
    row.brandRule = rule ? { brand: rule.brand, threshold: rule.threshold, mustDecorate: rule.mustDecorate, largeNeedsApproval: rule.largeNeedsApproval, note: rule.note } : null;
    row.approvals = {};
    for (const pk of row.productKeys || []) {
      const a = rule ? approvals.get(pk + "|" + brandKey_(rule.brand)) : null;
      row.approvals[pk] = a ? a.maxQty : false;
    }
    delete row.productKeys;
  }
  // Only rows something still has to be bought for; grouped by supplier.
  const bySupplier = new Map();
  for (const row of rows.values()) {
    if (!row.needed && !(row.reorderPoint != null && reorderShortfall_(row) > 0)) continue;
    (bySupplier.get(row.vendor) || bySupplier.set(row.vendor, []).get(row.vendor)).push(row);
  }
  const suppliers = [...bySupplier].map(([vendor, list]) => ({ vendor, rows: list }))
    .sort((a, b) => (a.vendor === "") - (b.vendor === "") || a.vendor.localeCompare(b.vendor));
  return { suppliers, unlinked, onOrderPieces, unpaidPieces, unpaidOrders: unpaidOrders.size, includeUnpaid: !!includeUnpaid, generatedAt: new Date().toISOString() };
}

// How far a Blanks to Order row is below its reorder point once its waiting orders are filled from stock: keep −
// (free stock left + restock already on order). The most a row can need — the screen recomputes it for its options.
function reorderShortfall_(row) {
  const left = Math.max(0, (Number(row.onHand) || 0) - (Number(row.reserved) || 0) - (Number(row.needed) || 0)) + (Number(row.restockOnOrder) || 0);
  return Math.max(0, (Number(row.reorderPoint) || 0) - left);
}

// Restock already ordered and not yet in: {"<blankId>\u0001<color>\u0001<size>" → pieces} (Map). Counted from
//   - placed supplier orders (migrations/0072; not cancelled): each line's `restockQty` — what it bought beyond the
//     order lines it was for — and
//   - restock orders placed by hand (blank_restock_orders, migrations/0074; not cancelled),
// from the last 45 days. A line stops counting once a purchase of that blank / color / size is recorded after the
// order (it's in stock then). Read-only; an older database without the tables just has nothing on order.
const RESTOCK_ON_ORDER_DAYS = 45;
async function restockOnOrder_(db, nowMs = Date.now()) {
  const since = new Date(nowMs - RESTOCK_ON_ORDER_DAYS * 86400000).toISOString();
  const orders = [];
  try {
    const { results } = await db.prepare("SELECT * FROM supplier_orders WHERE status='placed' AND COALESCE(placedAt, createdAt) >= ?").bind(since).all();
    for (const o of results) if (!o.cancelledAt) orders.push({ at: o.placedAt || o.createdAt, lines: (tryParse_(o.linesJson, []) || []).map(l => ({ ...l, qty: Number(l.restockQty) || 0 })) });
  } catch (e) { /* no supplier_orders table yet */ }
  try {
    const { results } = await db.prepare("SELECT * FROM blank_restock_orders WHERE voidedAt IS NULL AND createdAt >= ?").bind(since).all();
    for (const o of results) orders.push({ at: o.createdAt, lines: tryParse_(o.linesJson, []) || [] });
  } catch (e) { /* no blank_restock_orders table yet */ }
  const out = new Map();
  if (!orders.length) return out;
  const { results: bought } = await db.prepare(
    "SELECT blankId, color, size, MAX(createdAt) AS last FROM inventory_movements WHERE kind='purchase' AND voidedAt IS NULL AND createdAt >= ? GROUP BY blankId, color, size").bind(since).all();
  const lastBuy = new Map(bought.map(r => [[r.blankId, r.color || "", r.size || ""].join("\u0001"), r.last]));
  for (const o of orders) for (const l of o.lines) {
    const qty = Math.max(0, Math.floor(Number(l && l.qty) || 0));
    if (!qty || !l.blankId) continue;
    const key = [Number(l.blankId), l.color || "", l.size || ""].join("\u0001");
    if (lastBuy.has(key) && String(lastBuy.get(key)) > String(o.at)) continue;   // arrived
    out.set(key, (out.get(key) || 0) + qty);
  }
  return out;
}

// Sizes below their reorder point, for the Blanks screen: {"<blankId>|<color>|<size>": {keep, free, onOrder}} —
// free = on hand − set aside − needed by unordered paid order lines, plus restock on order.
export async function getBlankLowStock(db) {
  const bto = await getBlanksToOrder(db, { includeUnpaid: false });
  const out = {};
  for (const sup of bto.suppliers) for (const r of sup.rows) {
    if (r.reorderPoint == null) continue;
    const short = reorderShortfall_(r);
    if (short > 0) out[[r.blankId, r.color, r.size].join("|")] = { keep: r.reorderPoint, free: r.reorderPoint - short, onOrder: r.restockOnOrder || 0 };
  }
  return out;
}

// Pieces of each blank / color / size used since `sinceIso`: {"<blankId>\u0001<color>\u0001<size>" → pieces} (Map),
// from `consume` movements (made for an order, or for stock), voided ones left out. What "Get me to free shipping"
// ranks suggestions by.
export async function getBlankUsage(db, sinceIso) {
  const { results } = await db.prepare(
    `SELECT blankId, color, size, SUM(-qtyDelta) AS used FROM inventory_movements
     WHERE kind='consume' AND voidedAt IS NULL AND occurredAt >= ? GROUP BY blankId, color, size`).bind(String(sinceIso)).all();
  return new Map(results.filter(r => Number(r.used) > 0).map(r => [[Number(r.blankId), r.color || "", r.size || ""].join("\u0001"), Number(r.used)]));
}

// ---- Free shipping per vendor (2026-10) ------------------------------------------------------------------------
// A supplier ships free over a dollar amount (SanMar, S&S: $200, their published thresholds) or a piece count. Kept per vendor
// NAME — the blank's Vendor field, which Blanks to Order groups by — so it works with or without a vendor connection.
// global_settings 'vendorShipping' = {"<key>": {name, overCents, minQty}} (key = letters and digits, lower case); a
// vendor with no entry uses VENDOR_SHIPPING_DEFAULTS. 0 / null on both = no free shipping.
export const vendorShippingKey_ = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
export const VENDOR_SHIPPING_DEFAULTS = {
  sanmar: { name: "SanMar", overCents: 20000, minQty: null },
  ss: { name: "S&S", overCents: 20000, minQty: null }, ssactivewear: { name: "S&S", overCents: 20000, minQty: null },
};
export async function getVendorShipping(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='vendorShipping'").first();
  const v = row ? tryParse_(row.value, {}) : {};
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
// {overCents, minQty, isDefault} for a vendor name, or null when it has no free shipping.
export function vendorShippingFor(saved, vendor) {
  const key = vendorShippingKey_(vendor);
  if (!key) return null;
  const own = saved && Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : null;
  const e = own || VENDOR_SHIPPING_DEFAULTS[key];
  if (!e) return null;
  const overCents = Number(e.overCents) > 0 ? Math.round(Number(e.overCents)) : null, minQty = Number(e.minQty) > 0 ? Math.floor(Number(e.minQty)) : null;
  return overCents || minQty ? { overCents, minQty, isDefault: !own } : null;
}
// Sets one vendor's free shipping: `over` in dollars and/or `minQty` pieces (blank / 0 = not that kind); `reset`
// goes back to the default. Returns {before, after} for the audit.
export async function setVendorShipping(db, vendor, { over, minQty, reset } = {}) {
  const key = vendorShippingKey_(vendor);
  if (!key) throw Object.assign(new Error("Name the vendor."), { userFacing: true });
  const blankOrNum = (v, max, label) => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max) throw Object.assign(new Error(`${label} must be a number from 0 to ${max.toLocaleString("en-US")}.`), { userFacing: true });
    return n;
  };
  const dollars = blankOrNum(over, 100000, "Free shipping over $"), pieces = blankOrNum(minQty, 100000, "Free shipping at pieces");
  const saved = await getVendorShipping(db);
  const before = vendorShippingFor(saved, vendor);
  if (reset) delete saved[key];
  else saved[key] = { name: String(vendor).trim().slice(0, 80), overCents: dollars ? toCents(dollars) : null, minQty: pieces ? Math.floor(pieces) : null };
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('vendorShipping', ?)").bind(JSON.stringify(saved)).run();
  return { before, after: vendorShippingFor(saved, vendor) };
}

// "Get me to free shipping" — what could be added to an order from `vendor`: every size of every blank whose Vendor
// is that vendor (same name, letters and digits only), with its price (vendor price, else average cost), free stock
// (on hand − set aside − needed by unordered paid order lines + restock on order), reorder point and use in the last
// 90 / 365 days. The browser picks from these (fillToFreeShipping_ in admin.js). Read-only.
export async function getFreeShippingCandidates(db, vendor, nowMs = Date.now()) {
  const key = vendorShippingKey_(vendor);
  const [bto, u90, u365, { results: blanks }, { results: sizes }] = await Promise.all([
    getBlanksToOrder(db, { includeUnpaid: false }),
    getBlankUsage(db, new Date(nowMs - 90 * 86400000).toISOString()),
    getBlankUsage(db, new Date(nowMs - 365 * 86400000).toISOString()),
    db.prepare("SELECT * FROM blanks").all(),
    db.prepare("SELECT * FROM blank_sizes").all(),
  ]);
  const reserved = await getBlankReservations(db);
  const inbound = await restockOnOrder_(db, nowMs);
  const needed = new Map();
  for (const sup of bto.suppliers) for (const r of sup.rows) needed.set([r.blankId, r.color, r.size].join("\u0001"), r.needed);
  const mine = new Map(blanks.filter(b => key && vendorShippingKey_(b.vendor) === key).map(b => [Number(b.id), b]));
  const out = [];
  for (const sz of sizes) {
    const b = mine.get(Number(sz.blankId));
    if (!b) continue;
    const k = [Number(sz.blankId), sz.color || "", sz.size || ""].join("\u0001");
    const res = Number(reserved[[sz.blankId, sz.color || "", sz.size || ""].join("|")]) || 0;
    const price = sz.vendorPriceCents != null ? Number(sz.vendorPriceCents) : Number(sz.purchasePriceCents) || 0;
    out.push({ blankId: Number(b.id), blank: b.name || "", brand: b.brand || "", sku: b.sku || "", vendor: b.vendor || "", forTesting: !!b.forTesting,
      vendorConnectionId: b.vendorConnectionId != null ? Number(b.vendorConnectionId) : null,
      color: sz.color || "", size: sz.size || "", price: price / 100, onHand: Number(sz.quantity) || 0, reserved: res, needed: needed.get(k) || 0,
      onOrder: inbound.get(k) || 0, reorderPoint: sz.reorderPoint == null ? null : Number(sz.reorderPoint), used90: u90.get(k) || 0, used365: u365.get(k) || 0 });
  }
  return out;
}

// Restock orders placed by hand (migrations/0074) — recorded from "Get me to free shipping" so the restock isn't
// suggested again while it's on its way. lines = [{blankId, color, size, qty}].
export async function recordRestockOrder(db, { vendor, reference, lines, actor }) {
  const clean = (Array.isArray(lines) ? lines : []).slice(0, 200).map(l => ({ blankId: Number(l && l.blankId) || 0, color: String((l && l.color) || "").slice(0, 80),
    size: String((l && l.size) || "").slice(0, 20), qty: Math.floor(Number(l && l.qty) || 0) })).filter(l => l.blankId > 0 && l.qty > 0 && l.qty <= 100000);
  if (!clean.length) throw Object.assign(new Error("Nothing to record — every line needs a blank and a quantity."), { userFacing: true });
  const now = new Date().toISOString();
  const r = await db.prepare("INSERT INTO blank_restock_orders (vendor, reference, linesJson, createdAt, createdBy) VALUES (?, ?, ?, ?, ?)")
    .bind(String(vendor || "").slice(0, 80), String(reference || "").slice(0, 80), JSON.stringify(clean), now, String(actor || "").slice(0, 120)).run();
  return { id: Number(r.meta && r.meta.last_row_id), lines: clean };
}
export async function listRestockOrders(db, { days = RESTOCK_ON_ORDER_DAYS } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { results } = await db.prepare("SELECT * FROM blank_restock_orders WHERE voidedAt IS NULL AND createdAt >= ? ORDER BY createdAt DESC").bind(since).all();
  const arrived = await restockOnOrder_(db);
  return results.map(o => {
    const lines = tryParse_(o.linesJson, []) || [];
    return { id: Number(o.id), vendor: o.vendor || "", reference: o.reference || "", createdAt: o.createdAt, createdBy: o.createdBy || "", lines,
      pieces: lines.reduce((n, l) => n + (Number(l.qty) || 0), 0), waiting: lines.some(l => arrived.has([Number(l.blankId), l.color || "", l.size || ""].join("\u0001"))) };
  });
}
export async function cancelRestockOrder(db, id) {
  const r = await db.prepare("UPDATE blank_restock_orders SET voidedAt=? WHERE id=? AND voidedAt IS NULL").bind(new Date().toISOString(), Number(id)).run();
  return !!(r.meta && r.meta.changes);
}

// Blanks SET ASIDE for orders: {"<blankId>|<color>|<size>": pieces} — what's still to make on active
// lines whose blanks are in (received, or taken with Use from stock) on real, open orders. They're still
// on the shelf (stock comes out when the pieces are made, makeItemPieces_ / consumeBlanksForOrder), but
// promised: Blanks to Order's `reserved`, the stock coverage below and the Blanks screen all use this.
export async function getBlankReservations(db) {
  const nb = await noBlankLine_(db);
  const [{ results: lines }, { results: links }] = await Promise.all([
    db.prepare(
      `SELECT oi.orgId, oi.productId, oi.size, oi.qty, COALESCE(oi.manufacturedQty, 0) AS made, oi.configJson
       FROM order_items oi JOIN orders o ON o.orderId = oi.orderId
       WHERE oi.cancelDate IS NULL AND o.voidedAt IS NULL AND o.isTest = 0 AND o.completedAt IS NULL AND o.shippedAt IS NULL AND o.deliveredAt IS NULL AND o.manufacturedAt IS NULL
         AND COALESCE(oi.blankReceivedAt, o.blankReceivedAt) IS NOT NULL AND NOT ${nb("oi")}`).all(),
    db.prepare("SELECT orgId, productId, productColor, productSize, blankId, blankColor, blankSize FROM product_blank_links").all(),
  ]);
  const linkAt = new Map(links.map(l => [[l.orgId, l.productId, l.productColor || "", l.productSize || ""].join("\u0001"), l]));
  const out = {};
  for (const ln of lines) {
    const left = (Number(ln.qty) || 0) - (Number(ln.made) || 0);
    const link = left > 0 && ln.productId ? linkAt.get([ln.orgId, ln.productId, itemColor_(ln), ln.size || ""].join("\u0001")) : null;
    if (!link) continue;
    const key = [link.blankId, link.blankColor || "", link.blankSize || ""].join("|");
    out[key] = (out[key] || 0) + left;
  }
  return out;
}

// ---- Blanks from stock -----------------------------------------------------------------
// An order's blanks can come off the shelf instead of from a supplier. A line WAITING on its blank (not
// ordered, not received, pieces left to make) is covered when the stock on hand of the blank / color /
// size it's linked to, less what's already spoken for — pieces still to make on lines whose blanks are
// in (Blanks to Order's `reserved`) — is enough. Orders are served in the order given (`orderIds`, e.g.
// soonest due first) and only whole orders take stock, so two orders are never both told the same caps
// are theirs. Returns {orderId: {covered, lines: [{itemId, name, qty, blank, color, size, free}],
// unlinked}} for the given orders that have a waiting line. Read-only.
export async function getBlankStockCoverage(db, orderIds) {
  const want = [...new Set((orderIds || []).map(String))];
  if (!want.length) return {};
  const nb = await noBlankLine_(db);
  const [{ results: lines }, { results: links }, { results: blanks }, { results: sizes }, reserved] = await Promise.all([
    db.prepare(
      `SELECT oi.id, oi.orderId, oi.orgId, oi.productId, oi.name, oi.size, oi.qty, COALESCE(oi.manufacturedQty, 0) AS made, oi.configJson
       FROM order_items oi JOIN orders o ON o.orderId = oi.orderId
       WHERE oi.cancelDate IS NULL AND o.voidedAt IS NULL AND o.isTest = 0 AND o.completedAt IS NULL AND o.shippedAt IS NULL AND o.deliveredAt IS NULL AND o.manufacturedAt IS NULL
         AND COALESCE(oi.blankOrderedAt, o.blankOrderedAt) IS NULL AND COALESCE(oi.blankReceivedAt, o.blankReceivedAt) IS NULL
         AND NOT ${nb("oi")}
       ORDER BY oi.id`).all(),
    db.prepare("SELECT orgId, productId, productColor, productSize, blankId, blankColor, blankSize FROM product_blank_links").all(),
    db.prepare("SELECT id, name FROM blanks").all(),
    db.prepare("SELECT blankId, color, size, quantity FROM blank_sizes").all(),
    getBlankReservations(db),
  ]);
  const linkAt = new Map(links.map(l => [[l.orgId, l.productId, l.productColor || "", l.productSize || ""].join("\u0001"), l]));
  const blankName = new Map(blanks.map(b => [Number(b.id), b.name || ""]));
  // Free = on hand less what's set aside for orders whose blanks are in (getBlankReservations).
  const free = new Map(sizes.map(sz => [[sz.blankId, sz.color || "", sz.size || ""].join("|"),
    Math.max(0, Number(sz.quantity) || 0) - (reserved[[sz.blankId, sz.color || "", sz.size || ""].join("|")] || 0)]));
  const waiting = {};
  for (const ln of lines) {   // lines still waiting on their blank: not ordered, not received
    const left = (Number(ln.qty) || 0) - (Number(ln.made) || 0);
    if (left <= 0) continue;
    const link = ln.productId ? linkAt.get([ln.orgId, ln.productId, itemColor_(ln), ln.size || ""].join("\u0001")) : null;
    const key = link ? [link.blankId, link.blankColor || "", link.blankSize || ""].join("|") : null;
    (waiting[ln.orderId] = waiting[ln.orderId] || []).push({ ln, link, key, left });
  }
  const out = {};
  for (const orderId of want) {
    const list = waiting[orderId];
    if (!list) continue;
    const need = new Map();
    for (const w of list) if (w.key) need.set(w.key, (need.get(w.key) || 0) + w.left);
    const unlinked = list.filter(w => !w.key).length;
    const covered = !unlinked && [...need].every(([k, n]) => (free.get(k) || 0) >= n);
    out[orderId] = { covered, unlinked, lines: list.map(w => ({ itemId: Number(w.ln.id), name: w.ln.name || "", qty: w.left,
      blank: w.link ? blankName.get(Number(w.link.blankId)) || "" : "", color: w.link ? w.link.blankColor || "" : "", size: w.link ? w.link.blankSize || "" : "",
      free: w.key ? Math.max(0, free.get(w.key) || 0) : 0 })) };
    if (covered) for (const [k, n] of need) free.set(k, free.get(k) - n);   // these are this order's now
  }
  return out;
}

// Orders → stage "Blanks from stock" / Run Order → "Use from stock": the order's waiting lines are
// marked ordered AND received now, from "In stock", when the stock on hand covers every one of them
// (getBlankStockCoverage, this order served first). The blanks are then spoken for — Blanks to Order
// stops offering them to other orders — and are used up from stock when the order is made, exactly
// as blanks bought for it would be. Nothing is written when something is short or not linked to a
// blank (a userFacing error says what). Returns {lines}.
export async function useBlanksFromStock(db, orderId) {
  const cov = (await getBlankStockCoverage(db, [orderId]))[orderId];
  if (!cov) throw pricingError_("Nothing on this order is waiting for its blanks.");
  if (cov.unlinked) throw pricingError_(`${cov.unlinked} item${cov.unlinked === 1 ? " isn't" : "s aren't"} linked to a blank — link ${cov.unlinked === 1 ? "it" : "them"} on the product, or mark the blanks ordered.`);
  if (!cov.covered) {
    const need = {};
    for (const l of cov.lines) { const k = [l.blank, l.color, l.size].join(" · "); need[k] = need[k] || { n: 0, free: l.free }; need[k].n += l.qty; }
    const short = Object.entries(need).filter(([, v]) => v.n > v.free).map(([k, v]) => `${k}: need ${v.n}, ${v.free} free in stock`);
    throw pricingError_("Not enough in stock — " + short.join("; ") + ". Order the rest instead.");
  }
  const now = new Date().toISOString();
  await db.batch(cov.lines.map(l => db.prepare(
    `UPDATE order_items SET blankOrderedAt=COALESCE(blankOrderedAt, ?), blankReceivedAt=COALESCE(blankReceivedAt, ?), blankVendor='In stock', blankCondition='Good'
     WHERE id=? AND orderId=? AND cancelDate IS NULL AND blankReceivedAt IS NULL`).bind(now, now, l.itemId, orderId)));
  await recomputeOrderBlankStatus_(db, orderId);
  return { lines: cov.lines };
}


// ---- CSV import: blanks and products ------------------------------------------------------------
// Blanks → Import CSV (one row per vendor style, a cost column per size) and a shop's Products →
// Import CSV (one row per listing, linked to its blank by style). Both take the file's rows as plain
// {header: value} objects and do ALL the interpreting here, so the preview (`dryRun`) and the real
// import can't disagree. Re-importing the same file updates instead of duplicating: blanks match on
// their style (blanks.sku), products on their id (the SKU, lower-cased). A row with a `problems`
// entry is never written; `notes` are just things worth knowing.
// Rows per request. The browser sends a big file in small batches (each its own request), because a
// row costs a handful of queries and a Worker invocation only gets so many.
export const IMPORT_MAX_ROWS = 100;
// One INSERT … VALUES (…),(…),… per `perStmt` rows — D1 allows 100 bound values a statement, and a
// style with 20 colors × 10 sizes is 200 rows, so single-row inserts would burn the query budget.
function importMultiInsert_(db, head, rowSql, tail, rows, perStmt) {
  const out = [];
  for (let i = 0; i < rows.length; i += perStmt) {
    const part = rows.slice(i, i + perStmt);
    out.push(db.prepare(`${head} VALUES ${part.map(() => rowSql).join(", ")}${tail ? " " + tail : ""}`).bind(...part.flat()));
  }
  return out;
}
const IMPORT_PRODUCT_ID_RE_ = /^[a-z0-9-]{1,40}$/;   // same rule as catalogValidation's PRODUCT_ID_RE

// Two vendor names for the same vendor: "S&S" and "S&S Activewear", "SanMar" and "Sanmar Corp" — letters and
// digits only, one a prefix of the other (at least 2 characters).
function sameVendor_(a, b) {
  const k = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const x = k(a), y = k(b);
  if (!x || !y) return x === y;
  return x === y || (Math.min(x.length, y.length) >= 2 && (x.startsWith(y) || y.startsWith(x)));
}

const importRow_ = (raw) => {
  const o = {};
  for (const k of Object.keys(raw || {})) o[String(k).replace(/^﻿/, "").trim().toLowerCase()] = raw[k] == null ? "" : String(raw[k]).trim();
  return o;
};
// "Navy | Black|navy" → ["Navy", "Black"] (order kept, blanks and case-insensitive repeats dropped).
const importList_ = (v, max = 80) => {
  const seen = new Set(), out = [];
  for (const part of String(v || "").split("|")) {
    const t = part.trim(); if (!t) continue;
    const k = t.toLowerCase(); if (seen.has(k)) continue;
    seen.add(k); out.push(t.slice(0, max));
  }
  return out;
};
// "$1,234.50" → 1234.5; blank → null; anything else (or negative) → NaN.
const importMoney_ = (v) => {
  const t = String(v == null ? "" : v).replace(/[$,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
};
const importSize_ = (v) => String(v || "").trim().toUpperCase().slice(0, 20);
const importBool_ = (v, dflt) => {
  const t = String(v == null ? "" : v).trim().toLowerCase();
  if (!t) return dflt;
  return ["true", "yes", "y", "1", "active", "visible", "x"].includes(t);
};
const importMoneyText_ = (n) => "$" + Number(n).toFixed(2);

// A vendor/catalog category ("Shirts", "Hoodies & Layers", "Headwear") → one of this site's
// categories (its key). A category's own key, name or storefront heading wins ("Patch", "T Shirts",
// "hoodie"); otherwise the vendor's wording is guessed into shirt / sweatshirt / cap — "sweat…" is
// checked before "shirt" so "Sweatshirts" lands right — and the guess only counts if that category
// still exists. "" when it can't tell. `categories` defaults to the built-in list.
export function importTypeFromCategory(category, categories) {
  const cats = categories && categories.length ? categories : BUILT_IN_CATEGORIES;
  const c = String(category || "").trim().toLowerCase();
  if (!c) return "";
  const norm = (v) => String(v || "").trim().toLowerCase();
  const own = cats.find(k => k.key === c || norm(k.name) === c || norm(k.plural) === c || k.key === categoryKeyFromName(c));
  if (own) return own.key;
  const has = (key) => cats.some(k => k.key === key);
  let guess = "";
  if (/hood|sweat|fleece|layer|pullover|crew|quarter|zip|jacket|outerwear/.test(c)) guess = "sweatshirt";
  else if (/\bcaps?\b|\bhats?\b|beanie|visor|headwear/.test(c)) guess = "cap";
  else if (/shirt|polo|\btees?\b|\btops?\b/.test(c)) guess = "shirt";
  return guess && has(guess) ? guess : "";
}

// Makes sure a blank has the given colors and sizes WITHOUT touching stock: missing colors and
// missing color×size rows are added at quantity 0, nothing is deleted or re-ordered, and no stock
// movement is written (nothing moved). `sizeCosts` (Map size → dollars) are the file's costs: a
// size with no stock takes the file's cost (it's only a reference price until something is
// received), a size WITH stock keeps its weighted-average cost. Without `sizeCosts` a new color
// copies each size's cost from the blank's existing rows. The empty-named placeholder color a
// colorless import creates is dropped once real colors exist, provided it never held stock, has
// no history and nothing links to it. Returns what it did (or would do, with `dryRun`).
async function ensureBlankColorSizes_(db, blankId, addColors, sizeCosts, opts = {}) {
  const id = Number(blankId);
  const [{ results: cRows }, { results: sRows }] = await Promise.all([
    db.prepare("SELECT color, sortOrder FROM blank_colors WHERE blankId=? ORDER BY sortOrder, color").bind(id).all(),
    db.prepare("SELECT color, size, quantity, purchasePriceCents, vendorPriceCents FROM blank_sizes WHERE blankId=? ORDER BY color, id").bind(id).all(),
  ]);
  const info = { addedColors: [], addedSizes: 0, costUpdated: 0, costKept: 0, vendorPriceSet: 0, droppedPlaceholder: false, colors: [], sizes: [] };
  let colorNames = [];
  const haveColor = new Map();   // lower-case → the name as stored
  const note = (c) => { const k = String(c || "").toLowerCase(); if (!haveColor.has(k)) { haveColor.set(k, c || ""); colorNames.push(c || ""); } };
  cRows.forEach(r => note(r.color)); sRows.forEach(r => note(r.color));
  const inCatalog = new Set(cRows.map(r => r.color || ""));
  let maxSort = cRows.reduce((m, r) => Math.max(m, Number(r.sortOrder) || 0), -1);
  const toAdd = (addColors || []).map(c => String(c || "").slice(0, 80)).filter(c => !haveColor.has(c.toLowerCase()));
  const deletes = [], updates = [], colorIns = [], sizeIns = [], now = new Date().toISOString();

  // Costs known today, per size (the placeholder color first, so its file-given costs win).
  const knownCost = new Map(), knownSizes = [];
  for (const r of [...sRows].sort((a, b) => (a.color === "" ? -1 : 0) - (b.color === "" ? -1 : 0))) {
    if (!knownCost.has(r.size)) { knownCost.set(r.size, Number(r.purchasePriceCents) || 0); knownSizes.push(r.size); }
  }

  // Drop the unnamed placeholder once the blank has real colors.
  const named = colorNames.filter(c => c !== "").length + toAdd.filter(c => c !== "").length;
  let dropped = false;
  if (haveColor.has("") && named > 0) {
    const stock = sRows.filter(r => (r.color || "") === "").some(r => Number(r.quantity) !== 0);
    const used = stock ? null : await db.prepare(
      `SELECT (SELECT count(*) FROM inventory_movements WHERE blankId=?1 AND color='') +
              (SELECT count(*) FROM product_blank_links WHERE blankId=?1 AND blankColor='') AS n`).bind(id).first();
    if (!stock && !(used && Number(used.n))) {
      dropped = true; info.droppedPlaceholder = true;
      deletes.push(db.prepare("DELETE FROM blank_sizes WHERE blankId=? AND color=''").bind(id));
      deletes.push(db.prepare("DELETE FROM blank_colors WHERE blankId=? AND color=''").bind(id));
      colorNames = colorNames.filter(c => c !== "");
    }
  }

  const sizeList = [...new Set([...(sizeCosts ? [...sizeCosts.keys()] : []), ...knownSizes])];
  const costOf = (size) => (sizeCosts && sizeCosts.has(size)) ? Math.max(0, toCents(sizeCosts.get(size))) : (knownCost.get(size) || 0);
  const rowAt = new Map(sRows.map(r => [(r.color || "") + "|" + r.size, r]));
  const finalColors = [...colorNames, ...toAdd];
  const priceRows = [];   // the file's costs are the vendor's prices (migrations/0062): [blankId, color, size, to, from, at, actor, note]
  // A row for ONE color (the CSV's `color` column) only touches that color; otherwise every color.
  const only = opts.onlyColors ? new Set(opts.onlyColors.map(c => String(c || "").toLowerCase())) : null;
  for (const color of finalColors) {
    if (only && !only.has(String(color || "").toLowerCase())) continue;
    const isNew = toAdd.includes(color);
    if (isNew || !inCatalog.has(color)) {
      colorIns.push([id, color, ++maxSort, now, now]);
      if (isNew) info.addedColors.push(color);
    }
    for (const size of sizeList) {
      const cur = isNew ? null : rowAt.get(color + "|" + size);
      const cents = costOf(size);
      if (sizeCosts && sizeCosts.has(size)) {
        const was = cur && cur.vendorPriceCents != null ? Number(cur.vendorPriceCents) : null;
        if (was !== cents) { priceRows.push([id, color, size, cents, was, now, String(opts.actor || "").slice(0, 120), "CSV import"]); info.vendorPriceSet++; }
      }
      if (!cur) {
        sizeIns.push([id, color, size, cents]);
        info.addedSizes++;
      } else if (sizeCosts && sizeCosts.has(size) && (Number(cur.purchasePriceCents) || 0) !== cents) {
        if (Number(cur.quantity) > 0) info.costKept++;
        else { updates.push(db.prepare("UPDATE blank_sizes SET purchasePriceCents=? WHERE blankId=? AND color=? AND size=?").bind(cents, id, color, size)); info.costUpdated++; }
      }
    }
  }
  info.colors = finalColors; info.sizes = sizeList;
  if (!opts.dryRun) {
    // Deletes (the placeholder) first, then the new rows, then cost updates — one transaction.
    const all = [
      ...deletes,
      ...importMultiInsert_(db, "INSERT OR IGNORE INTO blank_colors (blankId, color, imagesJson, sortOrder, createdAt, updatedAt)", "(?, ?, '[]', ?, ?, ?)", "", colorIns, 19),
      ...importMultiInsert_(db, "INSERT OR IGNORE INTO blank_sizes (blankId, color, size, purchasePriceCents, quantity)", "(?, ?, ?, ?, 0)", "", sizeIns, 24),
      ...updates,
      // Vendor prices, per color and size (each row in priceRows is one that changed), then the history.
      ...priceRows.map(r => db.prepare("UPDATE blank_sizes SET vendorPriceCents=?, vendorPriceAt=? WHERE blankId=? AND color=? AND size=?")
        .bind(r[3], now, id, r[1], r[2])),
      ...importMultiInsert_(db, "INSERT INTO blank_vendor_prices (blankId, color, size, priceCents, previousCents, enteredAt, actor, note)", "(?, ?, ?, ?, ?, ?, ?, ?)", "", priceRows, 12),
      ...(priceRows.length ? [db.prepare("UPDATE blanks SET pricesCheckedAt=? WHERE id=?").bind(now, id)] : []),
    ];
    if (all.length) await db.batch(all);
  }
  return info;
}

// The notes line the blank import writes: backing and the reference prices have no column of their
// own, so they're kept here rather than dropped. Starts with one of these labels, which is how a
// later import tells its own text (safe to refresh) from notes typed by hand (left alone).
const IMPORT_NOTE_RE_ = /^(Backing:|Book \$|Floor \$|Sale cost \$)/;
function importBlankNotes_(r) {
  const money = (label, v) => { const n = importMoney_(v); return n != null && !Number.isNaN(n) ? `${label} ${importMoneyText_(n)}` : ""; };
  return [r.backing ? "Backing: " + r.backing : "", money("Book", r.book_price), money("Floor", r.floor_price),
    money("Sale cost", r.sale_cost_base || r.sale_cost), r.notes || ""].filter(Boolean).join(" · ").slice(0, 500);
}

// Blanks → Import CSV. Columns (header names, any case): style (required — matched against the
// blank's SKU), name, brand, supplier, category, one cost_<SIZE> per size (blank = the style
// doesn't come in it), needle, backing, notes, sale_cost_base / book_price / floor_price, and an
// optional colors (or all_colors) list separated by |. size_range is ignored (the costs say it).
export async function importBlanksCsv(db, rawRows, opts = {}) {
  const dryRun = !!opts.dryRun;
  const rows = (rawRows || []).slice(0, IMPORT_MAX_ROWS).map(importRow_);
  const { results: blankRows } = await db.prepare("SELECT id, sku, vendor, notes FROM blanks ORDER BY id").all();
  const bySku = new Map();
  for (const b of blankRows) { const k = String(b.sku || "").trim().toLowerCase(); if (k) (bySku.get(k) || bySku.set(k, []).get(k)).push(b); }
  const needleTypes = await listNeedleTypes(db);
  const categories = await listProductCategories(db);
  const findNeedle = (name) => {
    const n = name.toLowerCase();
    return needleTypes.find(t => t.name.toLowerCase() === n)
      || needleTypes.find(t => t.name && (n.startsWith(t.name.toLowerCase()) || t.name.toLowerCase().startsWith(n)));
  };
  // `seen`: styles in the batches the browser already sent, so a repeat further down the file is
  // still caught; `rowOffset` keeps row numbers matching the spreadsheet (header = row 1).
  const out = [], seen = new Set((opts.seen || []).map(x => String(x).toLowerCase())), newNeedleTypes = [];
  const rowOffset = Math.max(0, Math.floor(Number(opts.rowOffset) || 0));
  let created = 0, updated = 0, skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const style = (r.style || r.sku || r.blank_style || "").slice(0, 100);
    // An optional `color` column: the row prices just that color, so a style can take one row per color.
    const rowColor = String(r.color || "").trim().slice(0, 80);
    const res = { row: rowOffset + i + 2, style, name: "", action: "skip", problems: [], notes: [], sizes: [], colors: [] };
    out.push(res);
    if (!style) { res.problems.push("No style — every row needs one"); skipped++; continue; }
    const seenKey = style.toLowerCase() + (rowColor ? "|" + rowColor.toLowerCase() : "");
    if (seen.has(seenKey) || (!rowColor && [...seen].some(k => k.startsWith(style.toLowerCase() + "|"))) || (rowColor && seen.has(style.toLowerCase()))) {
      res.problems.push(rowColor ? "This style and color are in the file more than once" : "This style is in the file more than once"); skipped++; continue;
    }
    seen.add(seenKey);
    const name = (r.name || [r.brand, style].filter(Boolean).join(" ")).slice(0, 200);
    res.name = name;
    let type = importTypeFromCategory(r.category || r.type, categories);
    if (!type) {
      // Not one of the site's categories: file it under Other (or, if that was deleted, the last one).
      const fallback = categories.find(c => c.key === "other") || categories[categories.length - 1];
      type = fallback ? fallback.key : "other";
      if (r.category) res.notes.push(`Category "${r.category}" isn't one this site knows — filed under ${fallback ? fallback.name : "Other"}`);
    }

    const sizeCosts = new Map();
    for (const k of Object.keys(r)) {
      if (!k.startsWith("cost_")) continue;
      const size = importSize_(k.slice(5)), v = importMoney_(r[k]);
      if (!size || v == null) continue;
      if (Number.isNaN(v)) { res.problems.push(`Cost for ${size} isn't a number ("${r[k]}")`); continue; }
      sizeCosts.set(size, v);
    }
    if (!sizeCosts.size && !res.problems.length) res.problems.push("No size costs — fill at least one cost_<size> column (e.g. cost_M, or cost_OSFA for one size)");
    res.sizes = [...sizeCosts.keys()];
    const colors = rowColor ? [rowColor] : importList_(r.colors || r.all_colors);
    res.colors = colors;

    let needleTypeId, needleName = "";
    if (r.needle) {
      const t = findNeedle(r.needle);
      if (t) { needleTypeId = t.id; needleName = t.name; }
      else { needleName = r.needle.slice(0, 60); if (!newNeedleTypes.includes(needleName)) newNeedleTypes.push(needleName); res.notes.push(`Adds the needle type "${needleName}"`); }
    }
    res.needle = needleName;

    const matches = bySku.get(style.toLowerCase()) || [];
    const vendor = (r.supplier || r.vendor || "").slice(0, 100);
    // Matched on vendor + style: a blank of this style from ANOTHER vendor is never updated (or re-vendored).
    // With no vendor in the file, the first blank of the style is used, as before.
    const sameVendor = matches.filter(b => sameVendor_(b.vendor, vendor));
    const existing = vendor ? (sameVendor[0] || null) : (matches[0] || null);
    if (vendor && !existing && matches.length) res.notes.push(`A blank with this style is from ${matches.map(b => b.vendor || "no vendor").join(", ")} — this makes a separate ${vendor} blank`);
    if ((vendor ? sameVendor : matches).length > 1) res.notes.push(`${(vendor ? sameVendor : matches).length} blanks already use this style — updating ${existing && existing.vendor ? "the " + existing.vendor + " one" : "the first"}`);
    if (res.problems.length) { skipped++; continue; }
    res.action = existing ? "update" : "create";
    const notes = importBlankNotes_(r);

    if (!dryRun && needleTypeId === undefined && needleName) {
      const made = findNeedle(needleName);   // an earlier row may have just created it
      needleTypeId = made ? made.id : await saveNeedleType(db, { name: needleName });
      if (!made) needleTypes.push({ id: needleTypeId, name: needleName });
    }

    if (!existing) {
      if (!dryRun) {
        const sizes = [...sizeCosts].map(([size, cost]) => ({ size, purchasePrice: cost, vendorPrice: cost, quantity: 0 }));
        const fields = { name, productType: type, vendor, brand: (r.brand || "").slice(0, 100), sku: style, color: "", notes,
          colors: (colors.length ? colors : [""]).map(color => ({ color, sizes })) };
        if (needleTypeId !== undefined) fields.needleTypeId = needleTypeId;
        res.id = (await createBlank(db, fields, undefined, { actor: opts.actor, note: "CSV import" })).id;
      }
      // Later rows of the same style (one per color) add to this blank rather than make another.
      const made = { id: res.id || -(i + 1), sku: style, vendor, notes };
      (bySku.get(style.toLowerCase()) || bySku.set(style.toLowerCase(), []).get(style.toLowerCase())).push(made);
      created++;
      continue;
    }

    // Existing blank: refresh its catalog fields, add what's missing, never touch stock.
    if (Number(existing.id) < 0) {   // made by an earlier row of this dry run
      res.notes.push("Adds to the blank the row above creates");
      updated++;
      continue;
    }
    res.id = Number(existing.id);
    const keepNotes = !!existing.notes && !IMPORT_NOTE_RE_.test(existing.notes);
    if (keepNotes && notes && notes !== existing.notes) res.notes.push("Its notes were typed by hand — left as they are");
    if (!dryRun) {
      await db.prepare("UPDATE blanks SET name=?, productType=?, vendor=?, brand=?, notes=?, updatedAt=? WHERE id=?")
        .bind(name, type, vendor, (r.brand || "").slice(0, 100), keepNotes ? existing.notes : notes, new Date().toISOString(), Number(existing.id)).run();
      if (needleTypeId !== undefined) await setBlankNeedleType_(db, Number(existing.id), { needleTypeId });
    }
    const did = await ensureBlankColorSizes_(db, existing.id, colors, sizeCosts, { dryRun, actor: opts.actor, onlyColors: rowColor ? [rowColor] : null });
    if (did.vendorPriceSet) res.notes.push(`Sets the vendor price on ${did.vendorPriceSet} size row${did.vendorPriceSet === 1 ? "" : "s"}`);
    if (did.addedColors.length) res.notes.push(`Adds ${did.addedColors.length} color${did.addedColors.length === 1 ? "" : "s"}`);
    if (did.addedSizes) res.notes.push(`Adds ${did.addedSizes} size row${did.addedSizes === 1 ? "" : "s"}`);
    if (did.costUpdated) res.notes.push(`Updates the cost on ${did.costUpdated} size row${did.costUpdated === 1 ? "" : "s"} with no stock`);
    if (did.costKept) res.notes.push(`${did.costKept} size row${did.costKept === 1 ? " has" : "s have"} stock — the average cost is kept, not replaced`);
    updated++;
  }
  return { dryRun, results: out, created, updated, skipped, newNeedleTypes };
}

// A shop's Products → Import CSV. Columns: sku (required — becomes the product id, lower-cased),
// name, category, price, sizes (S|M|L…), size_upcharges (2XL:1.00|3XL:3.00, added to price),
// description, features (a|b|c), default_colors (the garment colors offered) and all_colors (every
// color the blank comes in), graphics_locations ("Front: left chest|Back"), personalization_price,
// active, no_design_needed, and blank_style (the blank's style — links every color and size to that blank, adding
// the colors to it when it doesn't have them yet). brand and margin_base are read by nobody.
// `opts.graphicIds` (already checked to belong to the shop) are offered at each NEW location; a
// location the product already has keeps its own graphics. Images, weight, designs, the pick list
// and anything else not in the file are left alone on a product that already exists.
export async function importProductsCsv(db, orgId, rawRows, opts = {}) {
  const dryRun = !!opts.dryRun;
  const rows = (rawRows || []).slice(0, IMPORT_MAX_ROWS).map(importRow_);
  const existingProducts = await getProductsByOrg(db, orgId, false);
  const byId = new Map(existingProducts.map(p => [p.productId, p]));
  const { results: blankRows } = await db.prepare("SELECT id, sku, name, productType, color FROM blanks ORDER BY id").all();
  const blankBySku = new Map();
  for (const b of blankRows) { const k = String(b.sku || "").trim().toLowerCase(); if (k && !blankBySku.has(k)) blankBySku.set(k, b); }
  const locations = await listLocations(db);
  const categories = await listProductCategories(db);
  const packAsOf = Object.fromEntries(categories.map(c => [c.key, c.packAs]));
  const graphicIds = (opts.graphicIds || []).map(Number).filter(Boolean);
  let nextSort = existingProducts.reduce((m, p) => Math.max(m, Number(p.sortOrder) || 0), 0) + 1;
  const out = [], seen = new Set((opts.seen || []).map(x => String(x).toLowerCase())), newLocations = [];
  const rowOffset = Math.max(0, Math.floor(Number(opts.rowOffset) || 0));
  let created = 0, updated = 0, skipped = 0, linked = 0;
  const ci = (list, want) => list.find(x => String(x).toLowerCase() === String(want).toLowerCase());

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const sku = r.sku || r.product_id || r.productid || r.id || "";
    const productId = sku.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    const res = { row: rowOffset + i + 2, sku, productId, name: (r.name || "").slice(0, 200), action: "skip", problems: [], notes: [],
      sizes: [], colors: [], locations: [], price: "", blank: null };
    out.push(res);
    if (!sku) { res.problems.push("No SKU — every row needs one"); skipped++; continue; }
    if (!IMPORT_PRODUCT_ID_RE_.test(productId)) { res.problems.push(`SKU "${sku}" can't be a product id (use up to 40 letters, numbers and hyphens)`); skipped++; continue; }
    if (seen.has(productId)) { res.problems.push("This SKU is in the file more than once"); skipped++; continue; }
    seen.add(productId);
    if (!res.name) res.problems.push("No name");
    const type = importTypeFromCategory(r.category || r.type, categories);
    if (!type) res.problems.push(`Category "${r.category || ""}" isn't one of this site's categories (${categories.map(c => c.name).join(", ")})`);
    const price = importMoney_(r.price);
    if (price == null) res.problems.push("No price");
    else if (Number.isNaN(price)) res.problems.push(`Price isn't a number ("${r.price}")`);

    let sizes = importList_(r.sizes, 20).map(importSize_);
    const upcharges = {};
    for (const part of importList_(r.size_upcharges)) {
      const m = part.match(/^(.+?)\s*[:=]\s*(.+)$/);
      const amt = m ? importMoney_(m[2]) : NaN;
      if (!m || amt == null || Number.isNaN(amt)) { res.problems.push(`Size upcharge "${part}" should look like 2XL:1.00`); continue; }
      upcharges[importSize_(m[1])] = amt;
    }
    const oneSize = sizes.length <= 1 && (!sizes.length || /^(OSFA|OS|ONE SIZE|ONESIZE)$/.test(sizes[0]));
    // One flat price or a price per size: a category that packs like a cap is always one size; one
    // that packs like a shirt or sweatshirt is a garment and needs its sizes; anything else (a
    // patch, …) is flat when the row lists no sizes, or just OSFA.
    const packs = packAsOf[type] || "other";
    const flat = packs === "cap" || (oneSize && packs !== "shirt" && packs !== "sweatshirt");
    if (!flat && !sizes.length) res.problems.push("No sizes — list them separated by | (S|M|L|XL)");
    if (packs === "cap" && sizes.length > 1) res.notes.push("Caps are sold as one size — the size list is ignored");
    const sizePricing = {};
    if (!flat && price != null && !Number.isNaN(price)) {
      for (const sz of sizes) sizePricing[sz] = Math.round((price + (upcharges[sz] || 0)) * 100) / 100;
      const stray = Object.keys(upcharges).filter(sz => !sizes.includes(sz));
      if (stray.length) res.notes.push(`Upcharge for ${stray.join(", ")} ignored — not in the size list`);
    }
    if (flat) sizes = ["OSFA"];
    res.sizes = sizes;
    if (price != null && !Number.isNaN(price)) {
      const all = flat ? [price] : Object.values(sizePricing);
      const lo = Math.min(...all), hi = Math.max(...all);
      res.price = all.length ? (lo === hi ? importMoneyText_(lo) : importMoneyText_(lo) + "–" + importMoneyText_(hi)) : "";
    }

    const hasPers = Object.prototype.hasOwnProperty.call(r, "personalization_price");
    const pers = importMoney_(r.personalization_price);
    if (Number.isNaN(pers)) res.problems.push(`Personalization price isn't a number ("${r.personalization_price}")`);

    const allColors = importList_(r.all_colors);
    let garmentColors = importList_(r.default_colors || r.colors);
    if (!garmentColors.length && allColors.length) { garmentColors = allColors.slice(); res.notes.push("No default colors — offering every color in all_colors"); }
    res.colors = garmentColors;

    const ex = byId.get(productId) || null;
    // Locations: "Front: left chest" → the Front location (the part after the colon is a placement
    // note, kept on a location this import creates).
    const locEntries = [];
    for (const part of importList_(r.graphics_locations || r.locations, 200)) {
      const cut = part.indexOf(":");
      const lname = (cut < 0 ? part : part.slice(0, cut)).trim().slice(0, 100), lnote = cut < 0 ? "" : part.slice(cut + 1).trim();
      if (!lname) continue;
      let L = locations.find(x => x.name.toLowerCase() === lname.toLowerCase());
      if (!L) {
        if (!newLocations.includes(lname)) newLocations.push(lname);
        res.notes.push(`Adds the location "${lname}"`);
        if (!dryRun && !res.problems.length) {
          const sortOrder = locations.reduce((m, x) => Math.max(m, x.sortOrder), 0) + 1;
          L = { id: await saveLocation(db, { name: lname, notes: lnote, sortOrder }), name: lname, notes: lnote, sortOrder };
          locations.push(L);
        }
      }
      const prev = ex && (ex.locations || []).find(x => (L && Number(x.locationId) === L.id) || String(x.label || "").toLowerCase() === lname.toLowerCase());
      res.locations.push(L ? L.name : lname);
      if (L || prev) locEntries.push({ key: (prev && prev.key) || "loc" + L.id, label: L ? L.name : prev.label, locationId: L ? L.id : (prev.locationId || null),
        graphicIds: prev ? (prev.graphicIds || []) : graphicIds.slice() });
    }
    // Locations the product already has that the file doesn't mention stay (with their graphics).
    if (ex) for (const x of (ex.locations || [])) if (!locEntries.some(e => e.key === x.key)) locEntries.push(x);

    // Color price groups (migrations/0064): color_groups "Heathers: Oxford Heather, Ash | White: White" and
    // color_group_upcharges "Heathers:2.00|White:-1.00", added to each size's price (like size_upcharges).
    let colorGroupsCents;
    if (r.color_groups) {
      const ups = {};
      for (const part of importList_(r.color_group_upcharges)) {
        const m = part.match(/^(.+?)\s*[:=]\s*(-?\$?[\d.,]+)$/);
        const amt = m ? Number(m[2].replace(/[$,]/g, "")) : NaN;
        if (!m || !Number.isFinite(amt)) { res.problems.push(`Color group upcharge "${part}" should look like Heathers:2.00`); continue; }
        ups[m[1].trim().toLowerCase()] = amt;
      }
      const groups = [];
      for (const part of importList_(r.color_groups, 600)) {
        const cut = part.indexOf(":");
        if (cut < 1) { res.problems.push(`Color group "${part}" should look like Heathers: Oxford Heather, Ash`); continue; }
        const label = part.slice(0, cut).trim(), up = ups[label.toLowerCase()] || 0;
        const colors = part.slice(cut + 1).split(",").map(x => x.trim()).filter(Boolean).map(x => garmentColors.find(g => g.toLowerCase() === x.toLowerCase()) || x);
        groups.push(flat ? { label, colors, flatPrice: price == null ? null : Math.round((price + up) * 100) / 100 }
          : { label, colors, sizePricing: Object.fromEntries(Object.entries(sizePricing).map(([z, v]) => [z, Math.round((v + up) * 100) / 100])) });
      }
      const clean = cleanColorGroups_(groups, { pricingMode: flat ? "flat" : "sized", sizePricing, garmentColors });
      if (clean.error) res.problems.push(clean.error); else { colorGroupsCents = clean.groups; res.notes.push(`${groups.length} color price group${groups.length === 1 ? "" : "s"}: ${groups.map(g => g.label).join(", ")}`); }
    }
    if (res.problems.length) { skipped++; continue; }
    res.action = ex ? "update" : "create";
    const configurable = garmentColors.length > 0 || locEntries.length > 0 || !!(ex && ex.configurable);
    const p = {
      productId, type, name: res.name, sub: (r.description || r.sub || "").slice(0, 600),
      features: importList_(r.features, 300).slice(0, 20),
      pricingMode: flat ? "flat" : "sized", flatPrice: flat ? price : null, sizePricing: flat ? {} : sizePricing,
      personalizationPrice: hasPers ? pers : (ex ? ex.personalizationPrice : null),
      visible: importBool_(r.active !== undefined ? r.active : r.visible, ex ? ex.visible : true),
      configurable, garmentColors, locations: locEntries,
      // Not in the file — carried over untouched on an update, defaults on a new product.
      weightOz: ex ? ex.weightOz : null, personalizationOptions: ex ? ex.personalizationOptions : [],
      images: ex ? ex.images : [], sortOrder: ex ? ex.sortOrder : nextSort++, taxable: ex ? ex.taxable : true,
    };
    // Optional: TRUE for a transfer-only (DTF) product, so the catalog check doesn't ask for a design.
    if (Object.prototype.hasOwnProperty.call(r, "no_design_needed") && r.no_design_needed !== "") p.noDesignNeeded = importBool_(r.no_design_needed, false);
    // Optional: TRUE for a product made with no blank at all (a patch), so nothing asks for a blank link.
    if (Object.prototype.hasOwnProperty.call(r, "no_blank_needed") && r.no_blank_needed !== "") p.noBlankNeeded = importBool_(r.no_blank_needed, false);
    if (colorGroupsCents !== undefined) p.colorGroupsCents = colorGroupsCents;
    if (!dryRun) {
      if (ex) await updateProduct(db, orgId, p); else await createProduct(db, orgId, p);
      // New prices are set against the blanks' vendor prices as they are now (migrations/0062).
      if (ex) {
        const after = parseProduct_(await db.prepare("SELECT * FROM products WHERE orgId=? AND productId=?").bind(orgId, productId).first());
        const key = (x) => JSON.stringify([x.pricingMode, x.flatPrice, x.sizePricing, x.colorGroups]);
        if (key(after) !== key(ex)) await confirmProductPrices(db, orgId, productId);
      }
    }
    if (ex) updated++; else created++;

    // Link every color × size to the blank.
    const style = r.blank_style || r.blank || r.blank_sku || "";
    if (!style) { if (!p.noBlankNeeded && !(ex && ex.noBlankNeeded)) res.notes.push("No blank_style — not linked to a blank (stock and cost won't be tracked)"); continue; }
    const blank = blankBySku.get(style.toLowerCase());
    if (!blank) { res.blank = { style, found: false, links: 0 }; res.notes.push(`Blank "${style}" isn't in Blanks yet — import the blanks file first, then import this again to link it`); continue; }
    if (blank.productType && blank.productType !== type) res.notes.push(`Blank "${style}" is filed as ${blank.productType}, this product as ${type}`);
    const wantColors = [...allColors]; for (const c of garmentColors) if (!ci(wantColors, c)) wantColors.push(c);
    const did = await ensureBlankColorSizes_(db, blank.id, wantColors, null, { dryRun });
    if (did.addedColors.length) res.notes.push(`Adds ${did.addedColors.length} color${did.addedColors.length === 1 ? "" : "s"} to the blank`);
    const productColors = garmentColors.length ? garmentColors : [""];
    const missing = [], linkRows = [];
    let n = 0;
    for (const pc of productColors) {
      const blankColor = pc ? ci(did.colors, pc) : (did.colors.includes("") ? "" : (did.colors[0] || ""));
      if (blankColor === undefined) continue;
      for (const ps of sizes) {
        const blankSize = ci(did.sizes, ps) || (flat && did.sizes.length === 1 ? did.sizes[0] : undefined);
        if (blankSize === undefined) { if (!missing.includes(ps)) missing.push(ps); continue; }
        linkRows.push([orgId, productId, pc, ps, Number(blank.id), blankColor, blankSize]);
        n++;
      }
    }
    if (!dryRun && linkRows.length) await db.batch(importMultiInsert_(db,
      "INSERT INTO product_blank_links (orgId, productId, productColor, productSize, blankId, blankColor, blankSize)", "(?, ?, ?, ?, ?, ?, ?)",
      "ON CONFLICT (orgId, productId, productColor, productSize) DO UPDATE SET blankId=excluded.blankId, blankColor=excluded.blankColor, blankSize=excluded.blankSize",
      linkRows, 14));
    linked += n;
    res.blank = { style, found: true, name: blank.name || "", links: n };
    if (missing.length) res.notes.push(`The blank has no cost for ${missing.join(", ")} — ${missing.length === 1 ? "that size isn't" : "those sizes aren't"} linked`);
  }
  return { dryRun, results: out, created, updated, skipped, linked, newLocations };
}

// ---- Order helpers -----------------------------------------------------

// range = {from, to} as YYYY-MM-DD (either optional): only orders placed in that window, so the
// admin Orders page (default: last 30 days) doesn't load a shop's whole history on every visit.
// Padded a day each side — the dates are the admin's local calendar days and placedAt
// is UTC — and the browser still applies the exact range (ordersDateFilter_), so nothing shown changes.
export async function getOrdersByOrg(db, orgId, range = {}) {
  const day = (s, add) => { const d = new Date(String(s) + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + add); return d.toISOString(); };
  const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(Date.parse(s));
  const where = ["o.orgId = ?"], params = [orgId];
  if (valid(range.from)) { where.push("o.placedAt >= ?"); params.push(day(range.from, -1)); }
  if (valid(range.to))   { where.push("o.placedAt < ?");  params.push(day(range.to, 2)); }
  return loadOrders_(db, where.join(" AND "), params, "placedAt DESC");
}

// Every open order across all orgs: not completed, not voided, not a test, and at least one
// item that isn't cancelled (an order whose items are all cancelled is a cancelled order).
export async function getOpenOrders(db) {
  return loadOrders_(db,
    `o.completedAt IS NULL AND o.voidedAt IS NULL AND o.isTest = 0
     AND EXISTS (SELECT 1 FROM order_items ai WHERE ai.orderId = o.orderId AND ai.cancelDate IS NULL)`,
    [], "placedAt ASC");
}

// Loads full orders (items, payments, labels) matching a WHERE clause on `orders o`. The child
// tables are filtered with the same clause as a subquery rather than an IN (?, ?, …) list, so the
// number of orders is never limited by D1's cap on bound parameters per query.
// How many active lines with typed-in (free-form) personalization — or the customer's own design to
// stitch (migrations/0054) — have NO order-specific design uploaded yet (migrations/0032) — per
// order, for the orders matched by `where` on `orders o`. Digitizing complete and Design approved
// wait for those uploads (stagePrereqError). {} on a database without order_item_designs.
async function orderDesignsMissingBy_(db, where, binds) {
  const out = byId_();
  const hasConfig = await orderItemsHasConfigCol_(db);
  const hasLoc = await orderItemDesignsHasLocation_(db);
  try {
    // The lines that can need one (typed-in text, the customer's own design), with the locations
    // they have designs for; orderDesignsMissingOnLine_ counts what's still missing.
    const { results } = await db.prepare(
      `SELECT ax.orderId, ax.personalized, ax.persName, ${hasConfig ? "ax.configJson" : "'' AS configJson"}, px.personalizationOptions,
              (SELECT json_group_array(${hasLoc ? "z.location" : "''"}) FROM order_item_designs z WHERE z.itemId = ax.id) AS designLocs
       FROM order_items ax
       LEFT JOIN products px ON px.orgId = ax.orgId AND px.productId = ax.productId
       WHERE ax.orderId IN (SELECT o.orderId FROM orders o WHERE ${where})
         AND ${featureOnSql_("production")}
         AND ax.cancelDate IS NULL
         AND (ax.personalized = 1${hasConfig ? ` OR ax.configJson LIKE '%"custom":true%'` : ""})`).bind(...binds).all();
    for (const r of results) {
      const n = orderDesignsMissingOnLine_(r, new Set((tryParse_(r.designLocs, []) || []).map(String)));
      if (n) out[r.orderId] = (out[r.orderId] || 0) + n;
    }
  } catch (e) { if (!/no such (table|column)/i.test(String(e && e.message))) throw e; }
  return out;
}

// A lookup keyed by an id someone else chose (an order id comes from the browser). It has no
// prototype, so it holds exactly what was put in it: with a plain {} an order called "constructor"
// or "toString" would find Object's own members there, and listing orders would fail for good.
export function byId_() { return Object.create(null); }

async function loadOrders_(db, where, binds, orderBy) {
  const stage = await stageSql_(db);
  const { results: orderRows } = await db.prepare(
    `SELECT o.*, ${stage.approval} AS needsDesignApproval, ${stage.digitizing} AS needsDigitizing FROM orders o WHERE ${where} ORDER BY ${orderBy}`
  ).bind(...binds).all();

  if (!orderRows.length) return [];
  const missing = await orderDesignsMissingBy_(db, where, binds);
  for (const r of orderRows) r.orderDesignsMissing = missing[r.orderId] || 0;

  const sub = `SELECT o.orderId FROM orders o WHERE ${where}`;
  const nb = await noBlankLine_(db);
  const { results: itemRows } = await db.prepare(
    `SELECT oi.*, ${nb("oi")} AS noBlank FROM order_items oi WHERE oi.orderId IN (${sub}) ORDER BY oi.id`
  ).bind(...binds).all();

  const { results: paymentRows } = await db.prepare(
    `SELECT * FROM order_payments WHERE orderId IN (${sub}) ORDER BY receivedAt ASC`
  ).bind(...binds).all();

  const itemsByOrder = byId_();
  for (const it of itemRows) {
    if (!itemsByOrder[it.orderId]) itemsByOrder[it.orderId] = [];
    itemsByOrder[it.orderId].push(parseItem_(it));
  }

  const paymentsByOrder = byId_();
  for (const p of paymentRows) {
    if (!paymentsByOrder[p.orderId]) paymentsByOrder[p.orderId] = [];
    paymentsByOrder[p.orderId].push(parsePayment_(p));
  }

  const { results: labelRows } = await db.prepare(
    `SELECT * FROM shipping_labels WHERE orderId IN (${sub}) ORDER BY purchasedAt ASC`
  ).bind(...binds).all();
  const labelsByOrder = byId_();
  for (const l of labelRows) (labelsByOrder[l.orderId] = labelsByOrder[l.orderId] || []).push(parseLabel_(l));

  // Blank (garment) shipments per order (migrations/0039) — the Blank Shipped cell links them and
  // the edit modal loads them. Scoped by the SAME order subquery the joins above use, so a large
  // Orders page can't hit D1's bound-parameter cap. A pre-migration DB yields {} internally.
  const shipmentsByOrder = await blankShipmentsByOrder_(db, { sub, binds });
  const invoices = await invoicesByOrder_(db, sub, binds);   // the invoice link emailed for it, if any (0053)
  // Restricted brands it has a large number of, and whether the supplier approved the logo (migrations/0075).
  let reviews = new Map();
  try { reviews = brandReviewsForLines_(await brandContext_(db), itemRows); } catch (e) { console.error("brand review check failed:", e); }

  return orderRows.map((r) => {
    const o = parseOrder_(r, itemsByOrder[r.orderId] || [], paymentsByOrder[r.orderId] || [], labelsByOrder[r.orderId] || []);
    o.blankShipments = shipmentsByOrder[r.orderId] || [];
    o.invoice = invoices[r.orderId] || null;
    o.brandReview = reviews.get(r.orderId) || [];
    return o;
  });
}

export async function getOrderById(db, orderId) {
  const stage = await stageSql_(db);
  const row = await db.prepare(`SELECT o.*, ${stage.approval} AS needsDesignApproval, ${stage.digitizing} AS needsDigitizing FROM orders o WHERE o.orderId=?`).bind(orderId).first();
  if (!row) return null;
  row.orderDesignsMissing = (await orderDesignsMissingBy_(db, "o.orderId=?", [orderId]))[orderId] || 0;
  const nb = await noBlankLine_(db);
  const { results: itemRows } = await db.prepare(
    `SELECT oi.*, ${nb("oi")} AS noBlank FROM order_items oi WHERE oi.orderId=? ORDER BY oi.id`
  ).bind(orderId).all();
  const { results: paymentRows } = await db.prepare(
    "SELECT * FROM order_payments WHERE orderId=? ORDER BY receivedAt ASC"
  ).bind(orderId).all();
  const { results: labelRows } = await db.prepare(
    "SELECT * FROM shipping_labels WHERE orderId=? ORDER BY purchasedAt ASC"
  ).bind(orderId).all();
  const order = parseOrder_(row, itemRows.map(parseItem_), paymentRows.map(parsePayment_), labelRows.map(parseLabel_));
  order.blankShipments = await getBlankShipmentsForOrder(db, orderId).catch(() => []);
  order.invoice = (await invoicesByOrder_(db, "?", [orderId]))[orderId] || null;
  try { order.brandReview = brandReviewsForLines_(await brandContext_(db), itemRows).get(orderId) || []; } catch (e) { order.brandReview = []; }
  return order;
}

// Atomic insert: order header + all items in one batch.
// opts.fillFromStock (the storefront and local sales, migrations/0060): a line for a stocked product +
// size is filled from the shop's finished stock when enough is AVAILABLE (on hand less set aside) — a
// guarded UPDATE right after the line's INSERT, in the same batch, so two orders can't both get the last
// piece. Only plain catalog lines qualify: not personalized, no color/graphic choices, no uploaded design,
// and never on a test order.
export async function insertOrder(db, order, pricedItems, opts = {}) {
  const stmts = [];
  // configJson is additive (migrations/0036); tolerate a pre-0036 schema (tests pin older subsets).
  let hasConfig = false;
  try { const { results } = await db.prepare("PRAGMA table_info(order_items)").all(); hasConfig = results.some(c => c.name === "configJson"); } catch (e) { /* ignore */ }

  // Line and order totals are computed here in integer cents from the unit
  // prices, not taken from the caller's floating-point dollar sums.
  const lines = pricedItems.map((it) => {
    const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
    const unitCents = toCents(it.unitPrice);
    const feeCents = toCents(it.personalizationFee || 0);
    return { it, qty, unitCents, feeCents, lineCents: qty * (unitCents + feeCents) };
  });
  const subtotalCents = lines.reduce((sum, l) => sum + l.lineCents, 0);
  const shippingCents = Math.max(0, toCents(order.shippingCost || 0));

  // Sales tax: today's rate unless the org is tax-exempt; both are snapshotted
  // on the order so later rate/exemption changes never rewrite history.
  const [taxSettings, orgRow] = await Promise.all([
    getSalesTaxSettings(db),
    db.prepare("SELECT taxExempt FROM orgs WHERE orgId=?").bind(order.orgId).first(),
  ]);
  const taxExempt = orgRow && orgRow.taxExempt ? 1 : 0;
  const orderRateBps = Number(taxSettings.rateBps) || 0;
  // Tax in the listed prices, or added to them: today's setting, kept on the order (migrations/0057).
  const mode = taxMode_(order.taxMode || taxSettings.taxMode);
  const outOfState = isOutOfState(stateOf_(order.shippingAddress), taxSettings.jurisdiction);
  const lineRateBps = taxExempt || outOfState ? 0 : orderRateBps;
  // Each line's taxable flag: the catalog product's, or the caller's for a
  // custom (local-sale) line; default taxable.
  const { results: prodRows } = await db.prepare("SELECT * FROM products WHERE orgId=?").bind(order.orgId).all();
  const productRow = Object.fromEntries(prodRows.map(r => [r.productId, r]));
  const fillFromStock = !!opts.fillFromStock && !order.isTest && await hasFromStockColumn_(db);
  const productTaxable = Object.fromEntries(prodRows.map(r => [r.productId, !!r.taxable]));
  const lineTaxable = (it) => (it.productId && it.productId in productTaxable) ? productTaxable[it.productId] : it.taxable !== false;

  const taxed = lines.map(({ it, lineCents }) => {
    const taxable = lineTaxable(it), rate = taxable ? lineRateBps : 0;
    return { taxable, rate, taxCents: taxOn_(lineCents, rate, mode) };
  });
  const taxAddedCents = mode === "exclusive" ? taxed.reduce((sum, t) => sum + t.taxCents, 0) : 0;

  // orders.taxMode is only named when it isn't the column's default, so an order can still be
  // written to a database from before migrations/0052 (where everything is inclusive).
  stmts.push(db.prepare(`INSERT INTO orders
    (orderId,orgId,customerName,contact,paymentMethod,subtotalCents,shippingCostCents,totalCents,
     shippingMethod,shippingAddress,totalWeightOz,placedAt,taxExempt,taxRateBps,isTest${mode === "exclusive" ? ",taxMode" : ""})
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${mode === "exclusive" ? ",'exclusive'" : ""})`)
    .bind(
      order.orderId, order.orgId, order.customerName, order.contact,
      order.paymentMethod || "", subtotalCents,
      shippingCents, subtotalCents + shippingCents + taxAddedCents,
      order.shippingMethod || "",
      order.shippingAddress ? JSON.stringify(order.shippingAddress) : null,
      order.totalWeightOz || 0, order.placedAt || new Date().toISOString(),
      taxExempt, orderRateBps,
      // Admin test transactions (createTestTransaction) stay out of sales.
      order.isTest ? 1 : 0
    ));

  for (const [n, { it, qty, unitCents, feeCents, lineCents }] of lines.entries()) {
    const { taxable, rate, taxCents } = taxed[n];
    const baseBinds = [
      order.orderId, order.orgId, it.productId || "",
      it.name, it.type, it.size || "", qty,
      unitCents, it.personalized ? 1 : 0, it.persName || "",
      feeCents, lineCents, rate, taxCents, taxable ? 1 : 0,
    ];
    if (hasConfig) {
      stmts.push(db.prepare(`INSERT INTO order_items
        (orderId,orgId,productId,name,type,size,qty,unitPriceCents,personalized,persName,
         personalizationFeeCents,lineTotalCents,taxRateBps,taxCents,taxable,configJson)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(...baseBinds, it.config ? JSON.stringify(it.config) : ""));
    } else {
      stmts.push(db.prepare(`INSERT INTO order_items
        (orderId,orgId,productId,name,type,size,qty,unitPriceCents,personalized,persName,
         personalizationFeeCents,lineTotalCents,taxRateBps,taxCents,taxable)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(...baseBinds));
    }
    // The customer's own design files for this line (migrations/0054), recorded on the line as it is
    // written: the line just inserted is this order's highest id, and the batch is one transaction.
    for (const f of (Array.isArray(it.customFiles) ? it.customFiles : [])) {
      stmts.push(db.prepare(`INSERT INTO order_item_files (itemId, fileKey, fileName, fileExt, uploadedBy, createdAt)
        SELECT max(id), ?, ?, ?, 'customer', ? FROM order_items WHERE orderId=?`)
        .bind(String(f.fileKey), String(f.fileName || "").slice(0, 120), String(f.fileExt || ""), order.placedAt || new Date().toISOString(), order.orderId));
    }
    // Filled from finished stock when enough is available right now (this line isn't counted yet).
    const prod = productRow[it.productId];
    if (fillFromStock && prod && !Number(prod.configurable) && !it.personalized && !it.config && !(Array.isArray(it.customFiles) && it.customFiles.length)) {
      const sz = stockSize_(prod.pricingMode, it.size), held = setAsideSql_(order.orgId, it.productId, prod.pricingMode, sz);
      stmts.push(db.prepare(
        `UPDATE order_items SET fromStock = 1 WHERE id = (SELECT max(id) FROM order_items WHERE orderId = ?)
           AND COALESCE((SELECT quantity FROM ready_to_ship WHERE orgId = ? AND productId = ? AND size = ?), 0) - ${held.sql} >= ?`
      ).bind(order.orderId, order.orgId, it.productId, sz, ...held.binds, qty));
    }
  }

  await db.batch(stmts);
  // What was recorded, in dollars: `total` is what the customer owes (tax included either way).
  const taxCents = taxed.reduce((sum, t) => sum + t.taxCents, 0);
  return { taxMode: mode, subtotal: fromCents(subtotalCents), shippingCost: fromCents(shippingCents), salesTax: fromCents(taxCents),
    total: fromCents(subtotalCents + shippingCents + taxAddedCents) };
}

// Kept for callers that mean "this order is paid": records the outstanding
// balance in the ledger (see settleOrderBalance) instead of flipping a flag
// the ledger doesn't back up.
export async function setOrderPaid(db, orderId, _paidAt, note) {
  return settleOrderBalance(db, orderId, note || "Marked paid");
}

export async function setOrderRefunded(db, orderId, refundedAt) {
  await db.prepare("UPDATE orders SET refundedAt=? WHERE orderId=?")
    .bind(refundedAt || new Date().toISOString(), orderId).run();
}

export async function setOrderDisputeStatus(db, orderId, status) {
  await db.prepare("UPDATE orders SET disputeStatus=? WHERE orderId=?")
    .bind(status, orderId).run();
}

export async function setOrderEmailTimestamp(db, orderId, field, ts) {
  // field must be one of the safe column names
  const allowed = { receivedEmailAt: true, confirmedEmailAt: true };
  if (!allowed[field]) throw new Error("Invalid email timestamp field");
  await db.prepare(`UPDATE orders SET ${field}=? WHERE orderId=?`)
    .bind(ts, orderId).run();
}

// The admin's stage order (mirrors FULFILLMENT_STAGES in admin.js), checked on the server so a
// stage can't be skipped through the API: returns "" when `stage` may be set on order `o`, else
// why not. Deliberately NOT applied to the automatic paths that set a stage because something
// real happened — a customer approving their design (verify.js), a local sale handed over in
// person, the carrier scanning a package (deliveryCheck.js). Delivered needs QA & packed, not
// Shipped: pickup orders go straight from packed to delivered.
// Mark manufactured needs the blank received, plus the design approved — or, for an order with no
// free-form personalization (needsDesignApproval false, see NEEDS_DESIGN_APPROVAL_SQL_), digitizing
// done, unless every product on it already has a design (needsDigitizing false).
function manufacturedPrereq_(o) {
  const needsApproval = o.needsDesignApproval !== false, needsDigitizing = o.needsDigitizing !== false;
  if (needsApproval && !o.designApprovedAt) return [false, "the design isn't approved yet"];
  if (!needsApproval && needsDigitizing && !o.digitizingCompleteAt) return [false, "digitizing isn't complete yet"];
  return [o.needsBlanks === false || !!o.blankReceivedAt, "the blank hasn't been received yet"];
}

export function stagePrereqError(o, stage) {
  if (!o) return "order not found";
  // The typed-in name has to be digitized and uploaded (Edit items → Files → Order design) before
  // digitizing counts as done or the design can be approved.
  if ((stage === "digitizingComplete" || stage === "designApproved") && Number(o.orderDesignsMissing) > 0) {
    const n = Number(o.orderDesignsMissing);
    return `${n} order design${n === 1 ? " hasn't" : "s haven't"} been uploaded yet (Edit items → Files → Order design)`;
  }
  // Nothing on the order uses a blank (every product is "No blank needed", migrations/0057).
  if (["blankOrdered", "blankShipped", "blankReceived"].includes(stage) && o.needsBlanks === false) return "nothing on this order uses a blank";
  const need = {
    blankOrdered:       [o.paid, "the order isn't paid yet"],
    blankShipped:       [o.blankOrderedAt, "the blank hasn't been ordered yet"],
    blankReceived:      [o.blankOrderedAt, "the blank hasn't been ordered yet"],
    digitizingComplete: [o.paid, "the order isn't paid yet"],
    designApproved:     [o.needsDigitizing === false ? o.paid : o.digitizingCompleteAt, o.needsDigitizing === false ? "the order isn't paid yet" : "digitizing isn't complete yet"],
    manufactured:       manufacturedPrereq_(o),
    qaPacked:           [o.manufacturedAt, "it isn't manufactured yet"],
    shipped:            [o.qaPackedAt, "it isn't QA'd and packed yet"],
    delivered:          [o.qaPackedAt, "it isn't QA'd and packed yet"],
  }[stage];
  if (!need) return "unknown stage";
  return need[0] ? "" : need[1];
}

// Returns { changed } — for "shipped", whether this call is what moved the order from not shipped
// to shipped (the customer's shipped email goes out exactly once, on that transition). Shipped is
// never overwritten once set: re-marking only fills in a tracking number.
// Which active line items a per-item blank stage applies to: extras.itemIds if given, else all
// active lines of the order. Returns an array of numeric ids.
async function blankTargetItemIds_(db, orderId, extras) {
  const nb = await noBlankLine_(db);
  if (Array.isArray(extras.itemIds) && extras.itemIds.length) {
    const want = new Set(extras.itemIds.map(Number).filter(Boolean));
    const { results } = await db.prepare(`SELECT oi.id FROM order_items oi WHERE oi.orderId=? AND oi.cancelDate IS NULL AND NOT ${nb("oi")}`).bind(orderId).all();
    return results.map(r => Number(r.id)).filter(id => want.has(id));
  }
  const { results } = await db.prepare(`SELECT oi.id FROM order_items oi WHERE oi.orderId=? AND oi.cancelDate IS NULL AND NOT ${nb("oi")}`).bind(orderId).all();
  return results.map(r => Number(r.id));
}

// Recomputes the order-level blank summary columns (migrations/0039) from its active line items,
// so every order-level reader (completion, CSV, prereqs, queues' legacy fallback) stays correct:
// orders.blankOrderedAt is set only when EVERY active line is ordered, blankReceivedAt only when
// every active line is received; vendor/est-delivery/condition summarize the items.
async function recomputeOrderBlankStatus_(db, orderId) {
  const nb = await noBlankLine_(db);
  const { results: active } = await db.prepare(
    `SELECT oi.blankOrderedAt, oi.blankReceivedAt, oi.blankVendor, oi.blankVendorOrderId, oi.blankEstDelivery, oi.blankCondition
     FROM order_items oi WHERE oi.orderId=? AND oi.cancelDate IS NULL AND NOT ${nb("oi")}`).bind(orderId).all();   // only lines that use a blank
  const n = active.length;
  const ordered = active.filter(r => r.blankOrderedAt);
  const received = active.filter(r => r.blankReceivedAt);
  const orderedAt = n > 0 && ordered.length === n ? ordered.map(r => r.blankOrderedAt).sort()[0] : null;
  const receivedAt = n > 0 && received.length === n ? received.map(r => r.blankReceivedAt).sort().slice(-1)[0] : null;
  const withVendor = ordered.find(r => r.blankVendor) || ordered[0] || {};
  const ests = ordered.map(r => r.blankEstDelivery).filter(Boolean).sort();
  const condition = receivedAt ? (active.some(r => r.blankCondition === "Other") ? "Other" : "Good") : "";
  await db.prepare(
    `UPDATE orders SET blankOrderedAt=?, blankReceivedAt=?, blankVendor=?, blankVendorOrderId=?, blankEstDelivery=?, blankCondition=? WHERE orderId=?`
  ).bind(orderedAt, receivedAt, withVendor.blankVendor || "", withVendor.blankVendorOrderId || "",
    ests.slice(-1)[0] || null, condition, orderId).run();
}

export async function setFulfillmentStage(db, orderId, stage, extras = {}) {
  const STAGE_COL = {
    blankOrdered:        "blankOrderedAt",
    blankShipped:        "blankShippedAt",
    blankReceived:       "blankReceivedAt",
    manufactured:        "manufacturedAt",
    digitizingComplete:  "digitizingCompleteAt",
    designApproved:      "designApprovedAt",
    qaPacked:            "qaPackedAt",
    shipped:             "shippedAt",
    delivered:           "deliveredAt",
  };
  const col = STAGE_COL[stage];
  if (!col) throw new Error("Invalid fulfillment stage: " + stage);

  const now = new Date().toISOString();
  if (stage === "blankOrdered") {
    // Stamp the chosen line items (default all active) with the vendor order, then roll up to orders.
    const ids = await blankTargetItemIds_(db, orderId, extras);
    for (const id of ids) {
      await db.prepare(`UPDATE order_items SET blankOrderedAt=COALESCE(blankOrderedAt, ?), blankVendor=?, blankVendorOrderId=?, blankEstDelivery=? WHERE id=? AND orderId=? AND cancelDate IS NULL`)
        .bind(now, extras.vendor || "", extras.vendorOrderId || "", extras.estimatedDelivery || null, id, orderId).run();
    }
    await recomputeOrderBlankStatus_(db, orderId);
  } else if (stage === "blankShipped") {
    // Mark the chosen items shipped (tracking numbers are added separately via addBlankShipment).
    const ids = await blankTargetItemIds_(db, orderId, extras);
    for (const id of ids) {
      await db.prepare(`UPDATE order_items SET blankShippedAt=COALESCE(blankShippedAt, ?) WHERE id=? AND orderId=? AND cancelDate IS NULL`)
        .bind(extras.shippedAt || now, id, orderId).run();
    }
    await recomputeOrderBlankStatus_(db, orderId);
  } else if (stage === "blankReceived") {
    const ids = await blankTargetItemIds_(db, orderId, extras);
    const condByItem = {};
    if (Array.isArray(extras.itemConditions)) for (const ic of extras.itemConditions) {
      const itemId = ic.itemId != null ? ic.itemId : ic.sheetRow;
      if (itemId != null) condByItem[Number(itemId)] = { condition: ic.condition || "Good", note: ic.note || "" };
    }
    for (const id of ids) {
      const c = condByItem[id] || { condition: extras.blankCondition || "Good", note: "" };
      await db.prepare(`UPDATE order_items SET blankReceivedAt=COALESCE(blankReceivedAt, ?), blankCondition=?, blankConditionNote=? WHERE id=? AND orderId=? AND cancelDate IS NULL`)
        .bind(now, c.condition, c.note, id, orderId).run();
    }
    await recomputeOrderBlankStatus_(db, orderId);
  } else if (stage === "shipped") {
    const before = await db.prepare("SELECT shippedAt FROM orders WHERE orderId=?").bind(orderId).first();
    const r = extras.trackingNumber
      ? await db.prepare(`UPDATE orders SET shippedAt = COALESCE(shippedAt, ?), trackingNumber=? WHERE orderId=?`)
          .bind(now, extras.trackingNumber, orderId).run()
      : await db.prepare(`UPDATE orders SET shippedAt = COALESCE(shippedAt, ?) WHERE orderId=?`).bind(now, orderId).run();
    return { changed: !!before && !before.shippedAt && Number(r && r.meta && r.meta.changes) > 0 };
  } else {
    await db.prepare(`UPDATE orders SET ${col}=? WHERE orderId=?`).bind(now, orderId).run();
  }
  // Making the order uses up its blanks: record them as COGS.
  if (stage === "manufactured") await consumeBlanksForOrder(db, orderId);
  return { changed: true };
}

// ---- Completed orders (migrations/0016) --------------------------------------
// An order can be COMPLETED once it's delivered and paid in full: that closes it
// out, and the orders screen then hides it unless "Include completed" is ticked.
// Returns why an order can't be completed yet ("" = it can).
export function whyNotCompletable_(o) {
  if (!o) return "order not found";
  if (o.voidedAt) return "the order is voided";
  if (o.completedAt) return "already completed";
  if (!Number(o.activeItems)) return "every item is cancelled";
  if (!o.deliveredAt) return "not delivered yet";
  if (!o.paid) return "a balance is still due";
  return "";
}

// completed=true closes each order that qualifies; completed=false reopens.
// Returns {updated, skipped:[{orderId, reason}]} — never throws for one bad order.
export async function setOrdersCompleted(db, orderIds, completed) {
  const out = { updated: [], skipped: [] };
  const now = new Date().toISOString();
  for (const orderId of orderIds) {
    const o = await db.prepare(
      `SELECT o.orderId, o.orgId, o.voidedAt, o.completedAt, o.deliveredAt, o.paid,
              (SELECT count(*) FROM order_items i WHERE i.orderId = o.orderId AND i.cancelDate IS NULL) AS activeItems
         FROM orders o WHERE o.orderId = ?`).bind(orderId).first();
    if (!o) { out.skipped.push({ orderId, reason: "order not found" }); continue; }
    if (completed) {
      const why = whyNotCompletable_(o);
      if (why) { out.skipped.push({ orderId, reason: why }); continue; }
      await db.prepare("UPDATE orders SET completedAt = ? WHERE orderId = ? AND completedAt IS NULL").bind(now, orderId).run();
    } else {
      if (!o.completedAt) { out.skipped.push({ orderId, reason: "not completed" }); continue; }
      await db.prepare("UPDATE orders SET completedAt = NULL WHERE orderId = ?").bind(orderId).run();
    }
    out.updated.push({ orderId, orgId: o.orgId });
  }
  return out;
}

// ---- Delivery check (the 6 AM roll-up) ---------------------------------------
// Shipped orders still waiting on a delivery, with a tracking number to look up
// (the order's own, else its site-bought label's) and the carrier to ask.
export async function getShippedAwaitingDelivery(db, limit = 40) {
  const { results } = await db.prepare(
    `SELECT * FROM (
       SELECT o.orderId, o.orgId, o.customerName, o.shippedAt, o.shippingMethod, o.paid,
         COALESCE(NULLIF(o.trackingNumber, ''),
           (SELECT l.trackingNumber FROM shipping_labels l WHERE l.orderId = o.orderId AND l.voidedAt IS NULL AND l.trackingNumber <> '' ORDER BY l.id DESC LIMIT 1), '') AS tracking,
         (SELECT l.carrier FROM shipping_labels l WHERE l.orderId = o.orderId AND l.voidedAt IS NULL ORDER BY l.id DESC LIMIT 1) AS labelCarrier
       FROM orders o
       WHERE o.shippedAt IS NOT NULL AND o.deliveredAt IS NULL AND o.completedAt IS NULL
         AND o.voidedAt IS NULL AND o.isTest = 0
     ) WHERE tracking <> '' ORDER BY shippedAt ASC LIMIT ?`).bind(Math.max(1, Math.min(200, Number(limit) || 40))).all();
  return results.map(r => ({ orderId: r.orderId, orgId: r.orgId, customerName: r.customerName, shippedAt: r.shippedAt,
    shippingMethod: r.shippingMethod || "", paid: !!r.paid, tracking: r.tracking, labelCarrier: r.labelCarrier || "" }));
}

// Orders with a label or tracking number that AREN'T marked shipped yet — a label existing doesn't
// mean the carrier has the package. The daily check looks these up and marks one shipped only once
// tracking shows a carrier scan (dated by that scan). Oldest label first.
export async function getLabeledAwaitingShipment(db, limit = 40) {
  const { results } = await db.prepare(
    `SELECT * FROM (
       SELECT o.orderId, o.orgId, o.customerName, o.shippingMethod, o.paid,
         COALESCE(NULLIF(o.trackingNumber, ''),
           (SELECT l.trackingNumber FROM shipping_labels l WHERE l.orderId = o.orderId AND l.voidedAt IS NULL AND l.trackingNumber <> '' ORDER BY l.id DESC LIMIT 1), '') AS tracking,
         (SELECT l.carrier FROM shipping_labels l WHERE l.orderId = o.orderId AND l.voidedAt IS NULL ORDER BY l.id DESC LIMIT 1) AS labelCarrier,
         (SELECT l.purchasedAt FROM shipping_labels l WHERE l.orderId = o.orderId AND l.voidedAt IS NULL ORDER BY l.id DESC LIMIT 1) AS labelAt
       FROM orders o
       WHERE o.shippedAt IS NULL AND o.deliveredAt IS NULL AND o.completedAt IS NULL
         AND o.voidedAt IS NULL AND o.isTest = 0
     ) WHERE tracking <> '' ORDER BY COALESCE(labelAt, '') ASC LIMIT ?`).bind(Math.max(1, Math.min(200, Number(limit) || 40))).all();
  return results.map(r => ({ orderId: r.orderId, orgId: r.orgId, customerName: r.customerName, labelAt: r.labelAt || "",
    shippingMethod: r.shippingMethod || "", paid: !!r.paid, tracking: r.tracking, labelCarrier: r.labelCarrier || "" }));
}

// Marks an order shipped from a carrier scan — only if it isn't already (a person may have got
// there first). Returns true when this call is what marked it.
export async function markOrderShippedByCarrier(db, orderId, iso) {
  const r = await db.prepare("UPDATE orders SET shippedAt = ? WHERE orderId = ? AND shippedAt IS NULL")
    .bind(iso || new Date().toISOString(), orderId).run();
  return !!(r && r.meta && r.meta.changes > 0);
}

// Marks an order delivered — only if it isn't already (a person may have got there first).
export async function markOrderDelivered(db, orderId, iso) {
  const r = await db.prepare("UPDATE orders SET deliveredAt = ? WHERE orderId = ? AND deliveredAt IS NULL")
    .bind(iso || new Date().toISOString(), orderId).run();
  return !!(r && r.meta && r.meta.changes > 0);
}

export async function setTrackingNumbers(db, orderIds, trackingNumber) {
  const results = { updated: 0, skipped: 0, errors: [] };
  for (const orderId of orderIds) {
    try {
      const r = await db.prepare("UPDATE orders SET trackingNumber=? WHERE orderId=?")
        .bind(trackingNumber, orderId).run();
      if (r.meta.changes > 0) results.updated++;
      else results.skipped++;
    } catch (e) {
      results.errors.push(orderId + ": " + e.message);
    }
  }
  return results;
}

export async function cancelLineItem(db, itemId) {
  const now = new Date().toISOString();
  // Check if blank has already been ordered (lateCancel)
  const item = await db.prepare("SELECT orderId FROM order_items WHERE id=?").bind(itemId).first();
  if (!item) return { lateCancel: false };
  const order = await db.prepare("SELECT blankOrderedAt FROM orders WHERE orderId=?").bind(item.orderId).first();
  const lateCancel = !!(order && order.blankOrderedAt);
  await db.prepare("UPDATE order_items SET cancelDate=?, lateCancel=? WHERE id=?")
    .bind(now, lateCancel ? 1 : 0, itemId).run();
  await returnFinishedStock_(db, item.orderId, itemId);   // a piece already pulled from stock goes back (0060)
  await refreshPaidStatus(db, item.orderId);
  return { lateCancel };
}

export async function cancelLineItemWithReason(db, itemId, reason) {
  const now = new Date().toISOString();
  const item = await db.prepare("SELECT orderId FROM order_items WHERE id=?").bind(itemId).first();
  if (!item) return { lateCancel: false };
  const order = await db.prepare("SELECT blankOrderedAt FROM orders WHERE orderId=?").bind(item.orderId).first();
  const lateCancel = !!(order && order.blankOrderedAt);
  await db.prepare("UPDATE order_items SET cancelDate=?, cancelReason=?, lateCancel=? WHERE id=?")
    .bind(now, reason || "", lateCancel ? 1 : 0, itemId).run();
  await returnFinishedStock_(db, item.orderId, itemId);   // a piece already pulled from stock goes back (0060)
  await refreshPaidStatus(db, item.orderId);
  return { lateCancel };
}

export async function setLineItemRefund(db, itemId, refundAmount) {
  await db.prepare("UPDATE order_items SET refundDate=?, refundCents=? WHERE id=?")
    .bind(new Date().toISOString(), Math.max(0, toCents(refundAmount)), itemId).run();
}

export async function getOrderItemById(db, itemId) {
  const row = await db.prepare("SELECT * FROM order_items WHERE id=?").bind(Number(itemId)).first();
  return row ? parseItem_(row) : null;
}

// configJson is additive (migrations/0036); cached per-db so pre-0036 schemas (some tests) skip it.
async function orderItemsHasConfigCol_(db) {
  if (db.__oiHasConfig === undefined) {
    try { const { results } = await db.prepare("PRAGMA table_info(order_items)").all(); db.__oiHasConfig = results.some(c => c.name === "configJson"); }
    catch (e) { db.__oiHasConfig = false; }
  }
  return db.__oiHasConfig;
}

export async function updateOrderItem(db, id, { productId, name, type, size, qty, unitPrice, personalized, persName, personalizationFee, taxable: taxableIn, config }) {
  const q = Math.max(1, Math.floor(Number(qty) || 1));
  const unitCents = Math.max(0, toCents(unitPrice)), feeCents = Math.max(0, toCents(personalizationFee));
  const lineCents = q * (unitCents + feeCents);
  const item = await db.prepare("SELECT orderId, orgId FROM order_items WHERE id=?").bind(Number(id)).first();
  if (!item) return;
  const taxable = await productTaxable_(db, item.orgId, productId, taxableIn);
  await db.prepare(
    `UPDATE order_items SET productId=?, name=?, type=?, size=?, qty=?, unitPriceCents=?, personalized=?, persName=?, personalizationFeeCents=?, lineTotalCents=?, taxable=? WHERE id=?`
  ).bind(
    productId || "", name || "", type || "", size || "",
    q, unitCents,
    personalized ? 1 : 0, persName || "",
    feeCents, lineCents, taxable ? 1 : 0,
    Number(id)
  ).run();
  // Only overwrite the configurable snapshot when a (re-validated) one was supplied — undefined
  // leaves a classic line's empty config alone.
  if (config !== undefined && await orderItemsHasConfigCol_(db)) {
    await db.prepare("UPDATE order_items SET configJson=? WHERE id=?").bind(config ? JSON.stringify(config) : "", Number(id)).run();
  }
  // A line filled from finished stock that hasn't been pulled yet is checked against stock again after
  // the edit (another product, size or quantity) — still filled from stock only if enough is available.
  if (await hasFromStockColumn_(db)) {
    const row = await db.prepare("SELECT * FROM order_items WHERE id=?").bind(Number(id)).first();
    if (row && Number(row.fromStock) && !Number(row.manufacturedQty)) {
      await db.prepare("UPDATE order_items SET fromStock = 0 WHERE id = ?").bind(Number(id)).run();
      const prod = row.productId ? await db.prepare("SELECT pricingMode, configurable FROM products WHERE orgId=? AND productId=?").bind(row.orgId, row.productId).first() : null;
      if (prod && !Number(prod.configurable) && !Number(row.personalized) && !row.configJson) {
        const sz = stockSize_(prod.pricingMode, row.size), held = setAsideSql_(row.orgId, row.productId, prod.pricingMode, sz);
        await db.prepare(`UPDATE order_items SET fromStock = 1 WHERE id = ?
            AND COALESCE((SELECT quantity FROM ready_to_ship WHERE orgId = ? AND productId = ? AND size = ?), 0) - ${held.sql} >= ?`)
          .bind(Number(id), row.orgId, row.productId, sz, ...held.binds, Number(row.qty)).run();
      }
    }
  }
  await recomputeOrderTax_(db, item.orderId);
}

// A catalog product's taxable flag; for a custom line (no such product) the
// caller's value, default taxable.
async function productTaxable_(db, orgId, productId, fallback) {
  if (productId) {
    const r = await db.prepare("SELECT taxable FROM products WHERE orgId=? AND productId=?").bind(orgId, productId).first();
    if (r) return !!r.taxable;
  }
  return fallback !== false;
}

export async function addOrderItem(db, orderId, orgId, { productId, name, type, size, qty, unitPrice, personalized, persName, personalizationFee, taxable: taxableIn, config }) {
  const q = Math.max(1, Math.floor(Number(qty) || 1));
  const unitCents = Math.max(0, toCents(unitPrice)), feeCents = Math.max(0, toCents(personalizationFee));
  const lineCents = q * (unitCents + feeCents);
  const taxable = await productTaxable_(db, orgId, productId, taxableIn);
  const result = await db.prepare(
    `INSERT INTO order_items (orderId, orgId, productId, name, type, size, qty, unitPriceCents, personalized, persName, personalizationFeeCents, lineTotalCents, taxRateBps, taxCents, taxable)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
  ).bind(
    orderId, orgId, productId || "", name || "", type || "", size || "",
    q, unitCents,
    personalized ? 1 : 0, persName || "",
    feeCents, lineCents, taxable ? 1 : 0
  ).run();
  const newId = Number(result.meta.last_row_id);
  if (config && await orderItemsHasConfigCol_(db)) {
    await db.prepare("UPDATE order_items SET configJson=? WHERE id=?").bind(JSON.stringify(config), newId).run();
  }
  await recomputeOrderTax_(db, orderId);
  return newId;
}

export async function recalcOrderTotals(db, orderId) {
  const { subtotalCents, totalCents } = await storeOrderTotals_(db, orderId);
  await refreshPaidStatus(db, orderId);
  return { subtotal: fromCents(subtotalCents), total: fromCents(totalCents) };
}

export async function updateOrderShipping(db, orderId, { shippingAddress, totalWeightOz, shippingCost, shippingMethod, parcelLength, parcelWidth, parcelHeight }) {
  await db.prepare(
    "UPDATE orders SET shippingAddress=?, totalWeightOz=?, shippingCostCents=?, shippingMethod=?, parcelLength=?, parcelWidth=?, parcelHeight=? WHERE orderId=?"
  ).bind(
    shippingAddress ? JSON.stringify(shippingAddress) : null,
    Number(totalWeightOz) || 0,
    Math.max(0, toCents(shippingCost)),
    shippingMethod || "",
    Number(parcelLength) || 0,
    Number(parcelWidth)  || 0,
    Number(parcelHeight) || 0,
    orderId
  ).run();
  await recomputeOrderTax_(db, orderId);   // ship-to state decides whether it's taxed
  await refreshPaidStatus(db, orderId);
}

// Updates customer-facing fields on an order. Only non-null values in `updates`
// are written. phone/addressLine merge into the existing shippingAddress object.
// Permanently removes an order and all related rows. Irreversible.
export async function deleteOrder(db, orderId) {
  await db.batch([
    db.prepare("DELETE FROM order_items       WHERE orderId=?").bind(orderId),
    db.prepare("DELETE FROM design_verifications WHERE orderId=?").bind(orderId),
    db.prepare("DELETE FROM orders             WHERE orderId=?").bind(orderId),
  ]);
}

export async function updateOrderCustomerInfo(db, orderId, updates) {
  const { customerName, contact, phone, addressLine } = updates;
  const stmts = [];

  if (customerName !== undefined && customerName !== null) {
    stmts.push(db.prepare("UPDATE orders SET customerName=? WHERE orderId=?").bind(customerName, orderId));
  }
  if (contact !== undefined && contact !== null) {
    stmts.push(db.prepare("UPDATE orders SET contact=? WHERE orderId=?").bind(contact, orderId));
  }

  if ((phone !== undefined && phone !== null) || (addressLine !== undefined && addressLine !== null)) {
    const row = await db.prepare("SELECT shippingAddress FROM orders WHERE orderId=?").bind(orderId).first();
    let addr = {};
    if (row && row.shippingAddress) {
      try { addr = JSON.parse(row.shippingAddress); } catch {}
    }
    if (phone !== undefined && phone !== null)       addr.phone   = phone;
    if (addressLine !== undefined && addressLine !== null) addr.line1   = addressLine;
    stmts.push(db.prepare("UPDATE orders SET shippingAddress=? WHERE orderId=?")
      .bind(JSON.stringify(addr), orderId));
  }

  if (stmts.length > 0) await db.batch(stmts);
}

export async function getOrderForShipping(db, orderId) {
  const [row, itemRows] = await Promise.all([
    db.prepare("SELECT shippingAddress, totalWeightOz, customerName FROM orders WHERE orderId=?").bind(orderId).first(),
    db.prepare("SELECT type, qty FROM order_items WHERE orderId=? ORDER BY id").bind(orderId).all(),
  ]);
  if (!row) return null;
  return { ...row, items: (itemRows.results || []).map(r => ({ type: r.type, qty: r.qty })) };
}

// What /api/checkout needs before charging: the real total, whether it's
// already paid, and the org the order actually belongs to.
// What a card checkout should charge: the BALANCE still due — active items + shipping −
// discount − payments already received (orderAmounts, as refreshPaidStatus) — not orders.totalCents,
// which ignores discounts and anything already paid by Venmo/Zelle/check. Also returns whether
// the order is voided, and the customer's name/email from the order row (checkout.js uses these
// rather than trusting the request body).
export async function getOrderCheckoutState(db, orderId) {
  const row = await withTaxMode_((tm) => db.prepare(`
    SELECT o.paid, o.orgId, o.voidedAt, o.customerName, o.contact, o.shippingMethod, ${ORDER_AMOUNT_COLS_.replace("o.taxMode", tm + " AS taxMode")},
      COALESCE((SELECT SUM(amountCents) FROM order_payments
                WHERE orderId = o.orderId AND kind = 'payment' AND voidedAt IS NULL), 0) AS receivedCents
    FROM orders o WHERE o.orderId = ?`).bind(orderId).first());
  if (!row) return null;
  const amounts = orderAmountsOfRow_(row);
  const balanceCents = Math.max(0, amounts.owedCents - (Number(row.receivedCents) || 0));
  return {
    total: fromCents(balanceCents), paid: !!row.paid, orgId: row.orgId, voided: !!row.voidedAt,
    // Sales tax added on top of the listed prices and so part of what's charged (0 when the prices include it).
    taxAdded: fromCents(amounts.taxAddedCents),
    customerName: row.customerName || "", contact: row.contact || "",
    // Placed with shipping still to be quoted, and the shop hasn't set it yet (see SHIPPING_QUOTE_PENDING).
    shippingPending: row.shippingMethod === SHIPPING_QUOTE_PENDING && !(Number(row.shippingCostCents) > 0),
  };
}

export async function getOrderTotal(db, orderId) {
  const row = await db.prepare("SELECT totalCents FROM orders WHERE orderId=?").bind(orderId).first();
  return row ? fromCents(row.totalCents) : null;
}

// ---- Catalog data for getCatalogData() --------------------------------

// One shop as the storefront needs it, from its rows (published, or live for a draft preview).
async function catalogShopFromRows_(db, rows) {
  const org = parseOrg_(rows.org);
  const visible = rows.products.filter(p => Number(p.visible)).sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) || String(a.productId).localeCompare(String(b.productId)));
  let products = await productsFromRows_(db, org.orgId, visible);
  // Blank color images (migrations/0037): each product's linked blank colors' images, keyed by the product color the
  // link is for, so the storefront can show the garment's photo per color. Images only — no stock reaches the catalog.
  products = await attachBlankColorImages_(db, org.orgId, products);
  // Per-location mockups (0042) — any product's: a plain product can have mockups of its printed transfers (0067).
  products = await attachProductGraphicImages_(db, org.orgId, products);
  products = await attachDecorations_(db, org.orgId, products);
  if (!products.some(p => p.configurable)) return { ...org, products };
  const { tiersCents } = await getTierPrices(db, org.orgId);
  const graphics = (await listGraphics(db, org.orgId)).filter(g => g.visible).map(g => ({
    id: g.id, name: g.name, kind: g.kind, tier: g.tier, addOnCents: g.tier ? (tiersCents[g.tier] || 0) : 0,
    inkColors: g.inkColors, imageUrl: g.imageUrl, thumbUrl: g.thumbUrl,
    allowedLocations: g.allowedLocations, allowedGarmentColors: g.allowedGarmentColors,
  }));
  return { ...org, products, graphics, tierPricesCents: tiersCents };
}
// A shop's DRAFT (its live rows), for the admin's signed preview link — never cached.
export async function getDraftCatalogShop(db, orgId) {
  const rows = await liveShopRows_(db, orgId);
  return rows ? catalogShopFromRows_(db, rows) : null;
}
export async function getPublicCatalogData(db) {
  // Each shop as PUBLISHED (migrations/0076): its snapshot rows, or its live rows if never published.
  const shopRows = await Promise.all((await db.prepare("SELECT orgId FROM orgs ORDER BY orgId").all()).results.map(r => publishedShopRows_(db, r.orgId)));
  const [baseSettings, salesTax, business, locale, features, categories] = await Promise.all([
    getGlobalSettings(db),
    getSalesTaxSettings(db),
    getBusinessProfile(db),
    getLocaleSettings(db),
    getFeatures(db),
    listProductCategories(db),
  ]);
  const globalSettings = { ...baseSettings, salesTax };

  // Each shop with its visible products; configurable products also need the shop's visible graphics (option
  // tiles, with the tier add-on resolved) + tier prices (migrations/0036), blank color images (0037) and mockups.
  const orgsWithProducts = await Promise.all(shopRows.filter(Boolean).map(rows => catalogShopFromRows_(db, rows)));
  // Build subdomainMap: { [subdomain]: orgId } — the published address.
  const subdomainMap = {};
  for (const org of orgsWithProducts) subdomainMap[org.subdomain] = org.orgId;

  return {
    status: "ok",
    subdomainMap,
    orgs: Object.fromEntries(orgsWithProducts.map((o) => [o.orgId, o])),
    globalSettings,
    business: publicBusinessProfile(business),   // name, contact and payment details shown to visitors
    locale: { country: locale.country },         // address format the storefront's forms use (Region)
    features,                                    // which optional parts of the site are on (Features)
    // The storefront's sections, in order (migrations/0056): key + heading only.
    categories: categories.map(c => ({ key: c.key, label: c.plural || c.name })),
    version: "d1", // static — the cache is keyed by global_settings.catalogVersion
  };
}

// Attaches `colorImages` { <productColor>: [imageUrls] } to each product, resolved from its blank
// links to the linked blank colors' images (migrations/0037). Tolerates a pre-0037 DB (no
// blank_colors / link color columns) by yielding no images.
async function attachBlankColorImages_(db, orgId, products) {
  let rows = [], colorRows = [];
  try {
    const r = await db.prepare(
      `SELECT l.productId, l.productColor, l.blankId, bc.imagesJson
       FROM product_blank_links l JOIN blank_colors bc ON bc.blankId = l.blankId AND bc.color = l.blankColor
       WHERE l.orgId = ?`
    ).bind(orgId).all();
    rows = r.results || [];
    // Every color of the blanks this shop's products are linked to — for a garment color with no links of its own.
    colorRows = (await db.prepare(
      `SELECT bc.blankId, bc.color, bc.imagesJson FROM blank_colors bc
       WHERE bc.blankId IN (SELECT DISTINCT blankId FROM product_blank_links WHERE orgId = ?)`
    ).bind(orgId).all()).results || [];
  } catch (e) { return products; }
  if (!rows.length) return products;
  const urlsOf = (json) => (tryParse_(json, []) || []).map(normBlankImage_).filter(Boolean).map(x => x.url);
  const byProduct = {}, blanksOf = {};
  for (const r of rows) {
    (blanksOf[r.productId] = blanksOf[r.productId] || new Set()).add(Number(r.blankId));
    // Images may be legacy bare strings or {url, locationId} (migrations/0041); the storefront color
    // preview just wants the URLs, so flatten to url strings here (the location-aware preview
    // uses the separate product_graphic_images table, not this map).
    const imgs = urlsOf(r.imagesJson);
    if (!imgs.length) continue;
    const p = byProduct[r.productId] || (byProduct[r.productId] = {});
    if (!p[r.productColor || ""]) p[r.productColor || ""] = imgs;   // first non-empty wins per color
  }
  // A garment color that has no blank links (added to the product before its links were saved) still shows its
  // photos: the same-named color (any case / spacing) on a blank the product is linked to.
  const key = (c) => String(c || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const p of products) {
    const colors = (Array.isArray(p.garmentColors) ? p.garmentColors : []).map(c => typeof c === "object" && c ? c.color || c.name : c).filter(Boolean);
    const ids = blanksOf[p.productId];
    if (!colors.length || !ids) continue;
    for (const c of colors) {
      if (byProduct[p.productId] && byProduct[p.productId][c]) continue;
      const hit = colorRows.find(r => ids.has(Number(r.blankId)) && key(r.color) === key(c) && urlsOf(r.imagesJson).length);
      if (hit) (byProduct[p.productId] = byProduct[p.productId] || {})[c] = urlsOf(hit.imagesJson);
    }
  }
  return products.map(p => byProduct[p.productId] ? { ...p, colorImages: byProduct[p.productId] } : p);
}

// ---- Per-location graphic × garment-color mockups (migrations/0042) ----------------------
// A configurable product's storefront preview: for each (location, graphic, garment color) the admin
// composed a mockup (a transparent graphic over the blank color photo). Keyed by the unique tuple.
const parseProductGraphicImage_ = (r) => ({ id: Number(r.id), orgId: r.orgId, productId: r.productId,
  locationId: Number(r.locationId), graphicId: Number(r.graphicId), garmentColor: r.garmentColor || "",
  imageUrl: r.imageUrl || "", thumbUrl: r.thumbUrl || "", placement: tryParse_(r.placementJson, {}) || {} });

export async function listProductGraphicImages(db, orgId, productId) {
  try {
    const { results } = await db.prepare(
      "SELECT * FROM product_graphic_images WHERE orgId=? AND productId=? ORDER BY locationId, graphicId, garmentColor"
    ).bind(orgId, productId).all();
    return results.map(parseProductGraphicImage_);
  } catch (e) { if (/no such (table|column)/i.test(String(e && e.message))) return []; throw e; }
}

// The blank color photos available as an overlay BASE image, per (product garment color, location).
// Resolves product_blank_links → blank_colors images and groups by the product color + each image's
// location tag (migrations/0041). Key "<productColor>|<locationId>" for location-tagged photos, and
// "<productColor>|" for untagged ones (a fallback when a color has no location-specific photo).
export async function getProductLocationBaseImages(db, orgId, productId) {
  const out = {};
  let rows = [];
  try {
    const r = await db.prepare(
      `SELECT l.productColor, bc.imagesJson FROM product_blank_links l
       JOIN blank_colors bc ON bc.blankId = l.blankId AND bc.color = l.blankColor
       WHERE l.orgId = ? AND l.productId = ?`).bind(orgId, productId).all();
    rows = r.results || [];
  } catch (e) { return out; }   // pre-migration DB
  for (const r of rows) {
    const pc = r.productColor || "";
    const imgs = (tryParse_(r.imagesJson, []) || []).map(normBlankImage_).filter(Boolean);
    for (const im of imgs) {
      const k = pc + "|" + (im.locationId || "");
      (out[k] = out[k] || []).push(im.url);
      // Also under "<color>|*" (every photo of this color, regardless of its location tag) so the
      // overlay editor can always offer the blank's photos — location-matched ones just rank first.
      const all = (out[pc + "|*"] = out[pc + "|*"] || []);
      if (!all.includes(im.url)) all.push(im.url);
    }
  }
  return out;
}

// Upsert one mockup on its unique tuple. An empty imageUrl deletes the cell instead.
export async function setProductGraphicImage(db, m) {
  const orgId = String(m.orgId || ""), productId = String(m.productId || "");
  const locationId = Number(m.locationId) || 0, graphicId = Number(m.graphicId) || 0, garmentColor = String(m.garmentColor || "");
  if (!orgId || !productId || !locationId || !graphicId) throw pricingError_("A mockup needs an org, product, location and graphic.");
  if (!m.imageUrl) { await deleteProductGraphicImage(db, m); return; }
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO product_graphic_images (orgId, productId, locationId, graphicId, garmentColor, imageUrl, thumbUrl, placementJson, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(orgId, productId, locationId, graphicId, garmentColor)
     DO UPDATE SET imageUrl=excluded.imageUrl, thumbUrl=excluded.thumbUrl, placementJson=excluded.placementJson, updatedAt=excluded.updatedAt`
  ).bind(orgId, productId, locationId, graphicId, garmentColor,
    String(m.imageUrl).slice(0, 500), String(m.thumbUrl || "").slice(0, 500), JSON.stringify(safePlacement_(m.placement)), now, now).run();
}

// Keep only the overlay coords + real (non-data:) URLs. A base/graphic uploaded in the editor arrives
// as a huge base64 data: URL; storing it would blow D1's row/param size limit (and it's useless for
// reopening — the base/graphic are re-resolved), so drop it.
function safePlacement_(p) {
  p = p || {};
  const out = {};
  for (const k of ["xPct", "yPct", "wPct"]) { const n = Number(p[k]); if (isFinite(n)) out[k] = n; }
  for (const k of ["baseUrl", "graphicUrl"]) { const u = String(p[k] || ""); if (u && !/^data:/i.test(u) && u.length <= 500) out[k] = u; }
  return out;
}

export async function deleteProductGraphicImage(db, m) {
  await db.prepare(
    "DELETE FROM product_graphic_images WHERE orgId=? AND productId=? AND locationId=? AND graphicId=? AND garmentColor=?"
  ).bind(String(m.orgId || ""), String(m.productId || ""), Number(m.locationId) || 0, Number(m.graphicId) || 0, String(m.garmentColor || "")).run();
}

// Attaches `graphicImages` { "<locationId>|<graphicId>|<garmentColor>": imageUrl } to every product that has
// mockups, for the shop page (migrations/0042): a configurable product's live per-location preview, and the
// pictures of its printed transfers (migrations/0068) — `fixedMockups` [{locationId, graphicId, label}] says which
// keys those are (a plain product's are under garment color ""). One query per shop, whatever the number of products.
async function attachProductGraphicImages_(db, orgId, products) {
  let rows = [];
  try {
    const r = await db.prepare(
      "SELECT productId, locationId, graphicId, garmentColor, imageUrl FROM product_graphic_images WHERE orgId=? AND imageUrl <> ''"
    ).bind(orgId).all();
    rows = r.results || [];
  } catch (e) { return products; }   // pre-migration DB
  if (!rows.length) return products;
  const byProduct = {};
  for (const r of rows) (byProduct[r.productId] = byProduct[r.productId] || {})[`${r.locationId}|${r.graphicId}|${r.garmentColor}`] = r.imageUrl;
  let names = null;
  const locName = async (id) => { if (!names) { names = {}; try { for (const l of await listLocations(db)) names[Number(l.id)] = l.name; } catch (e) {} } return names[Number(id)] || ""; };
  const out = [];
  for (const p of products) {
    const gi = byProduct[p.productId];
    if (!gi) { out.push(p); continue; }
    const fixedMockups = [];
    // Printed transfers (0067) and embroidered graphics for mockups (0068): both always on the product.
    for (const f of (p.mockupGraphics || []).concat(p.fixedTransfers || []))
      if (f.locationId && f.graphicId && !fixedMockups.some(x => x.locationId === Number(f.locationId) && x.graphicId === Number(f.graphicId)))
        fixedMockups.push({ locationId: Number(f.locationId), graphicId: Number(f.graphicId), label: await locName(f.locationId) });
    out.push({ ...p, graphicImages: gi, ...(fixedMockups.length ? { fixedMockups } : {}) });
  }
  return out;
}

// What decorates each product, in words, for the shop page (2026-10): `decorations` [{kind: "Embroidered" | "Printed",
// name, location}] — shown whether or not there's a picture of it. The embroidered graphics placed for mockups name the
// embroidery where it sits (else the product's own designs with their placement), and its printed transfers what's
// printed where. A configurable product's options are the customer's picks, so they aren't listed here.
async function attachDecorations_(db, orgId, products) {
  const has = (p) => (p.designs || []).length || p.designId || (p.fixedTransfers || []).length || (p.mockupGraphics || []).length;
  if (!products.some(has)) return products;
  const graphics = {}, designs = {}, locs = {};
  try { for (const g of await listGraphics(db, orgId)) graphics[Number(g.id)] = g; } catch (e) {}
  try { for (const d of await listDesigns(db, orgId)) designs[Number(d.id)] = d; } catch (e) {}
  try { for (const l of await listLocations(db)) locs[Number(l.id)] = l.name; } catch (e) {}
  return products.map(p => {
    if (!has(p)) return p;
    const out = [];
    const add = (kind, name, location) => {
      name = String(name || "").trim().slice(0, 120); location = String(location || "").trim().slice(0, 80);
      if (!name || out.some(x => x.kind === kind && x.name === name && x.location === location)) return;
      out.push({ kind, name, location });
    };
    const mock = (p.mockupGraphics || []).filter(m => graphics[Number(m.graphicId)]);
    for (const m of mock) add("Embroidered", graphics[Number(m.graphicId)].name, locs[Number(m.locationId)]);
    if (!mock.length && !Number(p.noDesignNeeded)) {
      const ds = (p.designs || []).length ? p.designs : (p.designId ? [{ designId: p.designId, placement: "" }] : []);
      for (const d of ds) { const x = designs[Number(d.designId)]; if (x) add("Embroidered", x.name, d.placement); }
    }
    for (const f of p.fixedTransfers || []) { const g = graphics[Number(f.graphicId)]; if (g) add("Printed", g.name, locs[Number(f.locationId)]); }
    return out.length ? { ...p, decorations: out } : p;
  });
}

// ---- Design verifications ----------------------------------------------

export async function createDesignVerification(db, { token, orgId, orderId, customerEmail, customerName, message, imagesJson, sentAt }) {
  await db.prepare(`INSERT INTO design_verifications
    (token,orgId,orderId,customerEmail,customerName,message,imagesJson,sentAt)
    VALUES (?,?,?,?,?,?,?,?)`)
    .bind(token, orgId, orderId, customerEmail, customerName, message, imagesJson, sentAt)
    .run();
}

// ---- Order invoices (migrations/0053) — a link the customer opens to choose delivery and pay ----
// One row per order; the token is the credential (the emailed link is /?invoice=<token>). Sending
// again keeps the token, so an earlier email's link keeps working, and renews the 60 days.
export const INVOICE_LINK_TTL_DAYS = 60;
const parseInvoice_ = (r) => r ? ({ token: r.token, orderId: r.orderId, orgId: r.orgId, sentTo: r.sentTo || "", message: r.message || "",
  allowDelivery: !!Number(r.allowDelivery), sentAt: r.sentAt || "", sendCount: Number(r.sendCount) || 1,
  viewedAt: r.viewedAt || "", deliveryChosenAt: r.deliveryChosenAt || "", deliveryChoice: r.deliveryChoice || "" }) : null;
export function invoiceExpired(inv, now = Date.now()) {
  const sent = Date.parse((inv && inv.sentAt) || "");
  return Number.isFinite(sent) && now - sent > INVOICE_LINK_TTL_DAYS * 24 * 3600 * 1000;
}
export async function getOrderInvoice(db, token) {
  return parseInvoice_(await db.prepare("SELECT * FROM order_invoices WHERE token=?").bind(String(token || "")).first());
}
export async function getOrderInvoiceByOrder(db, orderId) {
  return parseInvoice_(await db.prepare("SELECT * FROM order_invoices WHERE orderId=?").bind(String(orderId || "")).first());
}
// Creates the order's invoice, or — if it has one — updates who it went to, the note and whether
// delivery can be chosen, counts the send and renews it. Returns the row (with its token).
export async function sendOrderInvoice(db, { orderId, orgId, sentTo, message, allowDelivery }) {
  const now = new Date().toISOString();
  const msg = String(message || "").slice(0, 3000), to = String(sentTo || "").slice(0, 200);
  const existing = await getOrderInvoiceByOrder(db, orderId);
  if (existing) {
    await db.prepare("UPDATE order_invoices SET sentTo=?, message=?, allowDelivery=?, sentAt=?, sendCount=sendCount+1 WHERE orderId=?")
      .bind(to, msg, allowDelivery === false ? 0 : 1, now, orderId).run();
  } else {
    // 32 hex characters (122 random bits) — unguessable, like the design-verification tokens.
    const token = crypto.randomUUID().replace(/-/g, "").toLowerCase();
    await db.prepare("INSERT INTO order_invoices (token, orderId, orgId, sentTo, message, allowDelivery, sentAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(token, orderId, orgId, to, msg, allowDelivery === false ? 0 : 1, now).run();
  }
  return getOrderInvoiceByOrder(db, orderId);
}
export async function markInvoiceViewed(db, token) {
  await db.prepare("UPDATE order_invoices SET viewedAt=? WHERE token=? AND viewedAt IS NULL").bind(new Date().toISOString(), token).run();
}
// `choice`: 'pickup' | 'option:<id>' | 'shipping' | 'shipping-quote'.
export async function markInvoiceDeliveryChosen(db, token, choice) {
  await db.prepare("UPDATE order_invoices SET deliveryChosenAt=?, deliveryChoice=? WHERE token=?").bind(new Date().toISOString(), String(choice || "").slice(0, 60), token).run();
}
// { orderId: {sentAt, sentTo, viewedAt, deliveryChosenAt} } for the orders a loader just read; {} on a
// database without the table.
async function invoicesByOrder_(db, sub, binds) {
  try {
    const { results } = await db.prepare(`SELECT orderId, sentAt, sentTo, viewedAt, deliveryChosenAt, deliveryChoice, sendCount FROM order_invoices WHERE orderId IN (${sub})`).bind(...binds).all();
    return Object.fromEntries(results.map(r => [r.orderId, { sentAt: r.sentAt || "", sentTo: r.sentTo || "", viewedAt: r.viewedAt || "",
      deliveryChosenAt: r.deliveryChosenAt || "", deliveryChoice: r.deliveryChoice || "", sendCount: Number(r.sendCount) || 1 }]));
  } catch (e) { if (/no such table/i.test(String(e && e.message))) return {}; throw e; }
}

export async function getDesignVerification(db, token) {
  return await db.prepare("SELECT * FROM design_verifications WHERE token=?").bind(token).first();
}

export async function respondToDesignVerification(db, token, { status, customerNote, customerImagesJson, respondedAt }) {
  const result = await db.prepare(
    `UPDATE design_verifications SET status=?,customerNote=?,customerImagesJson=?,respondedAt=?
     WHERE token=? AND status='pending'`
  ).bind(status, customerNote, customerImagesJson, respondedAt, token).run();
  return result.meta && result.meta.changes > 0;
}

// Atomically reserves one upload slot on a pending verification token.
// Returns true if a slot was reserved, false if the token is closed or the
// cap is already reached. A single conditional UPDATE, so concurrent
// uploads can't race past the cap.
export async function reserveVerificationUpload(db, token, maxUploads) {
  const r = await db.prepare(
    "UPDATE design_verifications SET uploadCount = uploadCount + 1 WHERE token=? AND status='pending' AND uploadCount < ?"
  ).bind(token, maxUploads).run();
  return r.meta.changes > 0;
}

export async function releaseVerificationUpload(db, token) {
  await db.prepare(
    "UPDATE design_verifications SET uploadCount = MAX(uploadCount - 1, 0) WHERE token=?"
  ).bind(token).run();
}

export async function getVerificationsByOrder(db, orderId) {
  const { results } = await db.prepare(
    "SELECT * FROM design_verifications WHERE orderId=? ORDER BY sentAt DESC"
  ).bind(orderId).all();
  return results;
}

export async function getLatestVerificationsByOrg(db, orgId) {
  const { results } = await db.prepare(
    "SELECT * FROM design_verifications WHERE orgId=? ORDER BY sentAt DESC"
  ).bind(orgId).all();
  const seen = new Set();
  return results.filter(r => seen.has(r.orderId) ? false : (seen.add(r.orderId), true));
}

// ---- Voids (migrations/0010): nothing financial is ever hard-deleted ---------

// Voids an order: kept on record, excluded from every report. Callers must
// first make sure no money is still held on it (see orders.js voidOrder).
export async function voidOrder(db, orderId, reason) {
  await db.prepare("UPDATE orders SET voidedAt = ?, voidReason = ? WHERE orderId = ? AND voidedAt IS NULL")
    .bind(new Date().toISOString(), String(reason || "").slice(0, 300), orderId).run();
  await returnFinishedStock_(db, orderId, null);   // pieces already pulled from finished stock go back (0060)
}

// Voids a mistaken payment-ledger entry: stays visible, excluded from totals.
export async function voidPayment(db, id, reason) {
  const row = await db.prepare("SELECT orderId FROM order_payments WHERE id=?").bind(Number(id)).first();
  if (!row) return null;
  await db.prepare("UPDATE order_payments SET voidedAt = ?, voidReason = ? WHERE id = ? AND voidedAt IS NULL")
    .bind(new Date().toISOString(), String(reason || "").slice(0, 300), Number(id)).run();
  await refreshPaidStatus(db, row.orderId);
  return row.orderId;
}

// ---- Closed (filed) periods ------------------------------------------------
export const monthOf = (iso) => String(iso || "").slice(0, 7);

export async function getClosedPeriods(db) {
  const { results } = await db.prepare("SELECT month, closedAt, closedBy FROM closed_periods ORDER BY month DESC").all();
  return results;
}
export async function isMonthClosed(db, month) {
  if (!/^\d{4}-\d{2}$/.test(month || "")) return false;
  return !!(await db.prepare("SELECT 1 AS x FROM closed_periods WHERE month=?").bind(month).first());
}
// Month (YYYY-MM) an existing order / line item / ledger entry belongs to.
export async function orderMonth(db, orderId) {
  const r = await db.prepare("SELECT placedAt FROM orders WHERE orderId=?").bind(orderId).first();
  return r ? monthOf(r.placedAt) : "";
}
export async function itemOrderMonth(db, itemId) {
  const r = await db.prepare("SELECT o.placedAt FROM order_items i JOIN orders o ON o.orderId = i.orderId WHERE i.id=?").bind(Number(itemId)).first();
  return r ? monthOf(r.placedAt) : "";
}
export async function paymentMonth(db, id) {
  const r = await db.prepare("SELECT receivedAt FROM order_payments WHERE id=?").bind(Number(id)).first();
  return r ? monthOf(r.receivedAt) : "";
}

export async function movementMonth(db, id) {
  const r = await db.prepare("SELECT occurredAt FROM inventory_movements WHERE id=?").bind(Number(id)).first();
  return r ? monthOf(r.occurredAt) : "";
}

export async function closePeriod(db, month, closedBy) {
  await db.prepare("INSERT OR IGNORE INTO closed_periods (month, closedAt, closedBy) VALUES (?, ?, ?)")
    .bind(month, new Date().toISOString(), closedBy || "").run();
}
export async function reopenPeriod(db, month) {
  await db.prepare("DELETE FROM closed_periods WHERE month=?").bind(month).run();
}

// ---- Cash-basis revenue ------------------------------------------------------
// Money actually received / returned in a period, by org and by method — by
// the date the money moved (receivedAt), not when the order was placed.
// Test orders' card charges are listed separately (they're real Stripe
// charges and appear on the 1099-K). Dollars out.
export async function getCashReport(db, dateFrom, dateTo) {
  const { results } = await db.prepare(`
    SELECT o.orgId, o.isTest, p.kind, p.method, SUM(p.amountCents) AS cents, SUM(p.feeCents) AS fees, COUNT(*) AS n
    FROM order_payments p JOIN orders o ON o.orderId = p.orderId
    WHERE p.receivedAt >= ? AND p.receivedAt <= ? AND p.voidedAt IS NULL
    GROUP BY o.orgId, o.isTest, p.kind, p.method
  `).bind(dateFrom, dateTo).all();
  const byOrg = {}, byMethod = {};
  let testCard = 0, testFees = 0;
  for (const r of results) {
    const cents = Number(r.cents), fees = Number(r.fees);
    if (r.isTest) { if (r.method === "card") { testCard += cents; testFees += fees; } continue; }
    const o = (byOrg[r.orgId] = byOrg[r.orgId] || { orgId: r.orgId, received: 0, refunded: 0, fees: 0, payments: 0 });
    const m = (byMethod[r.method] = byMethod[r.method] || { method: r.method, received: 0, refunded: 0, fees: 0 });
    if (r.kind === "payment") { o.received += cents; m.received += cents; o.payments += Number(r.n); }
    else { o.refunded += -cents; m.refunded += -cents; }
    o.fees += fees; m.fees += fees;
  }
  const out = (x) => ({ ...x, received: fromCents(x.received), refunded: fromCents(x.refunded), fees: fromCents(x.fees),
    net: fromCents(x.received - x.refunded) });
  return { orgs: Object.values(byOrg).map(out), methods: Object.values(byMethod).map(out),
    testCardCharges: fromCents(testCard), testCardFees: fromCents(testFees) };
}

// ---- Accountant export -------------------------------------------------------
// Raw rows for the year-end / monthly CSVs (admin builds the files). Sales
// lines by the month the order was placed (accrual); ledger rows by the
// date money moved (cash). Voided and test rows are included but flagged,
// so every number can be reconciled.
export async function getAccountantExport(db, dateFrom, dateTo) {
  const { results: lines } = await withTaxMode_((tm) => db.prepare(`
    SELECT o.placedAt, o.orderId, o.orgId, o.customerName, o.paymentMethod, o.taxExempt, o.isTest, o.voidedAt, ${tm} AS taxMode,
           o.shipState, o.discountCents, o.discountTaxCents, o.shippingCostCents,
           i.id AS itemId, i.productId, i.name, i.size, i.qty, i.lineTotalCents, i.taxCents, i.taxRateBps,
           i.cogsCents, i.cogsSource, i.cancelDate
    FROM orders o JOIN order_items i ON i.orderId = o.orderId
    WHERE o.placedAt >= ? AND o.placedAt <= ? ORDER BY o.placedAt, o.orderId, i.id
  `).bind(dateFrom, dateTo).all());
  const { results: ledger } = await db.prepare(`
    SELECT p.receivedAt, p.orderId, o.orgId, p.kind, p.method, p.reference, p.amountCents, p.feeCents, p.note,
           p.externalRef, p.voidedAt, o.isTest, o.voidedAt AS orderVoidedAt
    FROM order_payments p JOIN orders o ON o.orderId = p.orderId
    WHERE p.receivedAt >= ? AND p.receivedAt <= ? ORDER BY p.receivedAt, p.id
  `).bind(dateFrom, dateTo).all();
  const { results: labels } = await db.prepare(`
    SELECT l.purchasedAt, l.orderId, o.orgId, l.carrier, l.service, l.amountCents, l.trackingNumber, l.voidedAt, o.isTest
    FROM shipping_labels l JOIN orders o ON o.orderId = l.orderId
    WHERE l.purchasedAt >= ? AND l.purchasedAt <= ? ORDER BY l.purchasedAt
  `).bind(dateFrom, dateTo).all();
  const [taxRows, refundRows, cogs] = await Promise.all([
    getSalesTaxReport(db, dateFrom, dateTo), getSalesTaxRefunds(db, dateFrom, dateTo), getCogsReport(db, dateFrom, dateTo),
  ]);

  // Monthly summary, every figure in cents while summing.
  const months = {};
  const M = (m) => (months[m] = months[m] || { month: m, grossSales: 0, taxCollected: 0, netSales: 0, exemptSales: 0,
    shippingIncome: 0, taxRefunded: 0, refunds: 0, cardReceipts: 0, otherReceipts: 0, stripeFees: 0, postage: 0,
    cogs: 0, purchases: 0, writeoffs: 0, testCardCharges: 0, expensesDeductible: 0, capitalPurchases: 0, useTax: 0,
    serviceIncome: 0, otherIncome: 0, interestIncome: 0, ownerContributions: 0, ownerDraws: 0,
    // migrations/0060: where COGS came from, write-offs by reason, blanks decorated into finished stock
    // (moves between inventory groups — not COGS), and count corrections.
    cogsBlanks: 0, cogsFinished: 0, writeoffsTesting: 0, writeoffsDamagedLost: 0, writeoffsOther: 0, toFinishedStock: 0, inventoryCorrections: 0 });
  for (const r of taxRows) {
    const m = M(r.month);
    m.grossSales += toCents(r.grossSales); m.taxCollected += toCents(r.taxCollected);
    m.netSales += toCents(r.netSales); m.shippingIncome += toCents(r.shipping);
    if (r.exempt) m.exemptSales += toCents(r.netSales);
  }
  for (const r of refundRows) { const m = M(r.month); m.refunds += toCents(r.refunded); m.taxRefunded += toCents(r.taxRefunded); }
  for (const p of ledger) {
    if (p.voidedAt || p.orderVoidedAt) continue;
    const m = M(monthOf(p.receivedAt));
    if (p.isTest) { if (p.method === "card" && p.kind === "payment") m.testCardCharges += Number(p.amountCents); continue; }
    if (p.kind === "payment") { if (p.method === "card") m.cardReceipts += Number(p.amountCents); else m.otherReceipts += Number(p.amountCents); }
    m.stripeFees += Number(p.feeCents);
  }
  for (const l of labels) if (!l.voidedAt && !l.isTest) M(monthOf(l.purchasedAt)).postage += Number(l.amountCents);
  for (const r of cogs.rows) {
    const m = M(r.month); m.cogs += toCents(r.cogs); m.purchases += toCents(r.purchases); m.writeoffs += toCents(r.writeoffs);
    m.cogsBlanks += toCents(r.cogsBlanks || 0); m.cogsFinished += toCents(r.cogsFinished || 0);
    m.writeoffsTesting += toCents(r.writeoffsTesting || 0); m.writeoffsDamagedLost += toCents(r.writeoffsDamagedLost || 0); m.writeoffsOther += toCents(r.writeoffsOther || 0);
    m.toFinishedStock += toCents(r.toFinished || 0); m.inventoryCorrections += toCents(r.corrections || 0);
  }
  const expenseRows = await listExpenses(db, dateFrom.slice(0, 10), dateTo.slice(0, 10), { includeDeleted: true });
  const useTaxRate = Number((await getSalesTaxSettings(db)).rateBps) || 0;
  const useTaxOf = (x) => x.useTaxDue ? Math.sign(toCents(x.amount)) * Math.round(Math.abs(toCents(x.amount)) * useTaxRate / 10000) : 0;   // a refund reverses to the cent
  for (const x of expenseRows) {
    if (x.deletedAt) continue;
    const m = M(x.date.slice(0, 7));
    m.expensesDeductible += toCents(x.deductible);
    if (x.deductionType === "depreciation") m.capitalPurchases += toCents(x.amount);
    m.useTax += useTaxOf(x);
    if (x.paidPersonally) m.ownerContributions += toCents(x.amount);   // owner paid a business expense
  }
  const d0 = dateFrom.slice(0, 10), d1 = dateTo.slice(0, 10);
  const [incomeRows, ownerRows, transferRows, accountsNow] = await Promise.all([
    listMoneyEntries(db, "income", d0, d1), listMoneyEntries(db, "owner", d0, d1), listMoneyEntries(db, "transfer", d0, d1), listAccounts(db, d1)]);
  const accountName = Object.fromEntries(accountsNow.map(a => [a.id, a.name]));
  for (const i of incomeRows) M(i.date.slice(0, 7))[i.type === "service" ? "serviceIncome" : i.type === "interest" ? "interestIncome" : "otherIncome"] += toCents(i.amount);
  for (const o of ownerRows) M(o.date.slice(0, 7))[o.kind === "contribution" ? "ownerContributions" : "ownerDraws"] += toCents(o.amount);
  const summary = Object.values(months).sort((a, b) => a.month.localeCompare(b.month))
    .map(m => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, k === "month" ? v : fromCents(v)])));

  const status = (r) => r.voidedAt ? "void" : r.isTest ? "test" : "";
  // Inventory by group at the start and end of the period (migrations/0060): blanks for sale, blanks for
  // testing / shop use, finished stock (Schedule C Part III, beginning and ending inventory).
  const before = new Date(new Date(dateFrom).getTime() - 1).toISOString();
  const [b0, b1, f0, f1] = await Promise.all([getInventoryValuation(db, before), getInventoryValuation(db, dateTo),
    getFinishedGoodsValuation(db, before), getFinishedGoodsValuation(db, dateTo)]);
  const inventoryGroups = [
    { group: "Blanks for sale", beginning: b0.groups.forSale.value, ending: b1.groups.forSale.value },
    { group: "Blanks for testing / shop use", beginning: b0.groups.testing.value, ending: b1.groups.testing.value },
    { group: "Finished stock", beginning: f0.value, ending: f1.value },
  ];
  return {
    summary,
    inventoryGroups,
    sales: lines.map(r => ({
      date: r.placedAt, orderId: r.orderId, orgId: r.orgId, customer: r.customerName, paymentMethod: r.paymentMethod,
      product: r.name, productId: r.productId, size: r.size, qty: Number(r.qty),
      // gross = what the customer pays for the line, tax included; net = without it — in either mode.
      ...(taxMode_(r.taxMode) === "exclusive"
        ? { gross: fromCents(Number(r.lineTotalCents) + Number(r.taxCents)), tax: fromCents(r.taxCents), net: fromCents(r.lineTotalCents) }
        : { gross: fromCents(r.lineTotalCents), tax: fromCents(r.taxCents), net: fromCents(r.lineTotalCents - r.taxCents) }),
      taxMode: taxMode_(r.taxMode), taxRate: Number(r.taxRateBps) / 100, taxExempt: !!r.taxExempt, shipState: r.shipState || "",
      cogs: fromCentsOrNull(r.cogsCents), cogsSource: r.cogsSource || "",
      cancelled: r.cancelDate ? r.cancelDate.slice(0, 10) : "", status: status(r),
    })),
    ledger: ledger.map(p => ({
      date: p.receivedAt, orderId: p.orderId, orgId: p.orgId, kind: p.kind, method: p.method, reference: p.reference || "",
      amount: fromCents(p.amountCents), fee: fromCents(p.feeCents), note: p.note || "", stripeRef: p.externalRef || "",
      status: p.voidedAt ? "void" : p.orderVoidedAt ? "order void" : p.isTest ? "test" : "",
    })),
    income: incomeRows.slice().reverse().map(i => ({ date: i.date, description: i.description, type: OTHER_INCOME_TYPES[i.type] || i.type,
      amount: i.amount, account: accountName[i.accountId] || "", reference: i.reference })),
    owner: ownerRows.slice().reverse().map(o => ({ date: o.date, kind: o.kind === "contribution" ? "Contribution" : "Draw", amount: o.amount,
      account: accountName[o.accountId] || "", note: o.note })),
    transfers: transferRows.slice().reverse().map(t => ({ date: t.date, from: accountName[t.fromAccountId] || "", to: accountName[t.toAccountId] || "",
      amount: t.amount, note: t.note, stripePayout: t.externalRef || "" })),
    accounts: accountsNow.map(a => ({ account: a.name, type: ACCOUNT_TYPES[a.type] || a.type, openingDate: a.openingDate,
      openingBalance: a.openingBalance, balanceAtEnd: a.balance })),
    reconciliations: (await listReconciliations(db)).filter(r => r.month >= d0.slice(0, 7) && r.month <= d1.slice(0, 7)),
    expenses: expenseRows.slice().reverse().map(x => ({ date: x.date, description: x.description, vendor: x.vendor, category: x.category, type: x.isRefund ? "Refund" : "Expense",
      scheduleCLine: x.scheduleCLine, scheduleCLabel: SCHEDULE_C_LINES[x.scheduleCLine] || "", deductionType: x.deductionType,
      amount: x.amount, businessUsePct: x.businessUsePct, deductiblePct: x.deductiblePct, deductible: x.deductible,
      placedInService: x.deductionType === "depreciation" ? (x.placedInService || x.date) : "",
      method: x.deductionType === "depreciation" ? (DEPRECIATION_METHODS[x.depMethod] || "Ask CPA") : "",
      vendorChargedTax: x.vendorChargedTax ? "yes" : "no", useTax: fromCents(useTaxOf(x)),
      paidFrom: x.paidPersonally ? "Personal funds" : (accountName[x.accountId] || ""),
      receipt: x.receiptKey ? "yes" : "", status: x.deletedAt ? "deleted" : "" })),
    postage: labels.map(l => ({ date: l.purchasedAt, orderId: l.orderId, orgId: l.orgId, carrier: l.carrier, service: l.service,
      amount: fromCents(l.amountCents), tracking: l.trackingNumber || "", status: l.voidedAt ? "void" : l.isTest ? "test" : "" })),
  };
}

// ---- Shipping labels (postage expense) -----------------------------------

// Idempotent on the Shippo transaction id.
export async function recordShippingLabel(db, { orderId, shippoTransactionId, carrier, service, amount, trackingNumber, labelUrl }) {
  await db.prepare(
    `INSERT OR IGNORE INTO shipping_labels (orderId, shippoTransactionId, carrier, service, amountCents, trackingNumber, labelUrl, purchasedAt, accountId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(orderId, shippoTransactionId, carrier || "", service || "", Math.max(0, toCents(amount)),
    trackingNumber || "", labelUrl || "", new Date().toISOString(), (await getMoneyDefaults(db)).postageAccountId).run();
}

// The order's current (not voided) label, newest first — for re-opening its PDF.
export async function getOrderLabel(db, orderId) {
  const row = await db.prepare("SELECT * FROM shipping_labels WHERE orderId=? AND voidedAt IS NULL ORDER BY purchasedAt DESC, id DESC LIMIT 1")
    .bind(orderId).first();
  return row || null;
}
export async function setShippingLabelUrl(db, id, url) {
  await db.prepare("UPDATE shipping_labels SET labelUrl=? WHERE id=?").bind(String(url || ""), Number(id)).run();
}

function parseLabel_(row) {
  return {
    id: Number(row.id), shippoTransactionId: row.shippoTransactionId, carrier: row.carrier || "",
    service: row.service || "", amount: fromCents(row.amountCents), trackingNumber: row.trackingNumber || "",
    labelUrl: row.labelUrl || "", purchasedAt: row.purchasedAt || "", voidedAt: row.voidedAt || "",
  };
}

// ---- Business expenses (migrations/0012) ------------------------------------
// Schedule C Part II lines an expense category can map to.
export const SCHEDULE_C_LINES = {
  "8": "Advertising", "9": "Car and truck expenses", "10": "Commissions and fees", "11": "Contract labor",
  "12": "Depletion", "13": "Depreciation and section 179", "14": "Employee benefit programs",
  "15": "Insurance (other than health)", "16a": "Interest — mortgage", "16b": "Interest — other",
  "17": "Legal and professional services", "18": "Office expense", "19": "Pension and profit-sharing plans",
  "20a": "Rent or lease — vehicles, machinery, equipment", "20b": "Rent or lease — other business property",
  "21": "Repairs and maintenance", "22": "Supplies", "23": "Taxes and licenses", "24a": "Travel",
  "24b": "Deductible meals", "25": "Utilities", "26": "Wages", "27a": "Other expenses",
};
export const DEDUCTION_TYPES = ["depreciation", "deductible", "none"];
export const DEPRECIATION_METHODS = { section179: "Section 179", bonus: "100% bonus", macrs5: "MACRS 5-year", macrs7: "MACRS 7-year", ask_cpa: "Ask CPA" };

// What's deductible THIS year from an ordinary expense: amount × category
// deductible % × business-use %. Depreciation (capital) and non-deductible
// expenses contribute 0 here — capital purchases are reported separately.
function expenseDeductibleCents_(row) {
  if (row.deductionType !== "deductible") return 0;
  // Rounded on the magnitude, then signed: a refund (negative amount) must reverse the
  // original purchase's deduction to the cent (Math.round(-502.5) = -502 but round(502.5) = 503).
  const amt = Number(row.amountCents);
  return Math.sign(amt) * Math.round(Math.abs(amt) * Number(row.deductiblePct) * Number(row.businessUsePct) / 10000);
}
function parseExpenseCategory_(r) {
  return { id: Number(r.id), name: r.name, deductionType: r.deductionType, scheduleCLine: r.scheduleCLine || "",
    deductiblePct: Number(r.deductiblePct), useTaxable: !!r.useTaxable, expenseCount: Number(r.expenseCount || 0) };
}
function parseExpense_(r) {
  return {
    id: Number(r.id), date: r.expenseDate, description: r.description, vendor: r.vendor || "",
    categoryId: Number(r.categoryId), category: r.categoryName || "", deductionType: r.deductionType || "",
    scheduleCLine: r.scheduleCLine || "", deductiblePct: Number(r.deductiblePct ?? 100),
    amount: fromCents(r.amountCents), businessUsePct: Number(r.businessUsePct), deductible: fromCents(expenseDeductibleCents_(r)),
    receiptKey: r.receiptKey || "", receiptName: r.receiptName || "",
    placedInService: r.placedInService || "", depMethod: r.depMethod || "", deletedAt: r.deletedAt || "",
    vendorChargedTax: r.vendorChargedTax === undefined ? true : !!r.vendorChargedTax,
    useTaxDue: !!r.useTaxable && r.vendorChargedTax === 0,   // use tax owed on this purchase
    accountId: r.accountId == null ? null : Number(r.accountId), paidPersonally: !!r.paidPersonally,
    // A refund is a negative expense (money back for something bought) in the ORIGINAL's category.
    isRefund: Number(r.amountCents) < 0, refundOfId: r.refundOfId == null ? null : Number(r.refundOfId),
  };
}

export async function listExpenseCategories(db) {
  const { results } = await db.prepare(
    `SELECT c.*, (SELECT count(*) FROM expenses e WHERE e.categoryId = c.id) AS expenseCount
     FROM expense_categories c ORDER BY c.name COLLATE NOCASE`).all();
  return results.map(parseExpenseCategory_);
}
export async function getExpenseCategory(db, id) {
  const r = await db.prepare(`SELECT c.*, (SELECT count(*) FROM expenses e WHERE e.categoryId = c.id) AS expenseCount
    FROM expense_categories c WHERE c.id = ?`).bind(Number(id)).first();
  return r ? parseExpenseCategory_(r) : null;
}
export async function findExpenseCategoryByName(db, name) {
  const r = await db.prepare("SELECT id FROM expense_categories WHERE name = ? COLLATE NOCASE").bind(String(name).trim()).first();
  return r ? Number(r.id) : null;
}
export async function saveExpenseCategory(db, id, { name, deductionType, scheduleCLine, deductiblePct, useTaxable }) {
  const now = new Date().toISOString();
  if (id) {
    await db.prepare("UPDATE expense_categories SET name = ?, deductionType = ?, scheduleCLine = ?, deductiblePct = ?, useTaxable = ?, updatedAt = ? WHERE id = ?")
      .bind(String(name).trim(), deductionType, scheduleCLine || "", Number(deductiblePct), useTaxable ? 1 : 0, now, Number(id)).run();
    return Number(id);
  }
  const r = await db.prepare(`INSERT INTO expense_categories (name, deductionType, scheduleCLine, deductiblePct, useTaxable, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(String(name).trim(), deductionType, scheduleCLine || "", Number(deductiblePct), useTaxable ? 1 : 0, now, now).first();
  return Number(r.id);
}
// Refused (false) while any expense — even a deleted one — uses the category.
export async function deleteExpenseCategory(db, id) {
  const used = await db.prepare("SELECT count(*) AS n FROM expenses WHERE categoryId = ?").bind(Number(id)).first();
  if (Number(used.n) > 0) return false;
  await db.prepare("DELETE FROM expense_categories WHERE id = ?").bind(Number(id)).run();
  return true;
}

const EXPENSE_SELECT_ = `SELECT e.*, c.name AS categoryName, c.deductionType, c.scheduleCLine, c.deductiblePct, c.useTaxable
  FROM expenses e JOIN expense_categories c ON c.id = e.categoryId`;
// dateFrom/dateTo are YYYY-MM-DD (inclusive).
export async function listExpenses(db, dateFrom, dateTo, { includeDeleted = false } = {}) {
  const { results } = await db.prepare(`${EXPENSE_SELECT_}
    WHERE e.expenseDate >= ? AND e.expenseDate <= ? ${includeDeleted ? "" : "AND e.deletedAt IS NULL"}
    ORDER BY e.expenseDate DESC, e.id DESC`).bind(dateFrom, dateTo).all();
  return results.map(parseExpense_);
}
export async function getExpense(db, id) {
  const r = await db.prepare(`${EXPENSE_SELECT_} WHERE e.id = ?`).bind(Number(id)).first();
  return r ? parseExpense_(r) : null;
}
// Fields already validated by the caller (orders.js saveExpense).
export async function saveExpense(db, id, x) {
  const now = new Date().toISOString();
  const vals = [x.date, String(x.description).trim(), Number(x.categoryId), toCents(x.amount), x.vendor || "",
    Number(x.businessUsePct), x.receiptKey || "", x.receiptName || "", x.placedInService || null, x.depMethod || null,
    x.vendorChargedTax === false ? 0 : 1, x.paidPersonally ? null : (x.accountId ? Number(x.accountId) : null), x.paidPersonally ? 1 : 0,
    x.refundOfId ? Number(x.refundOfId) : null];
  if (id) {
    await db.prepare(`UPDATE expenses SET expenseDate = ?, description = ?, categoryId = ?, amountCents = ?, vendor = ?,
      businessUsePct = ?, receiptKey = ?, receiptName = ?, placedInService = ?, depMethod = ?, vendorChargedTax = ?, accountId = ?, paidPersonally = ?, refundOfId = ?, updatedAt = ?
      WHERE id = ? AND deletedAt IS NULL`).bind(...vals, now, Number(id)).run();
    return Number(id);
  }
  const r = await db.prepare(`INSERT INTO expenses (expenseDate, description, categoryId, amountCents, vendor, businessUsePct,
    receiptKey, receiptName, placedInService, depMethod, vendorChargedTax, accountId, paidPersonally, refundOfId, createdAt, updatedAt, receiptGroup) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(...vals, now, now, x.receiptGroup ? String(x.receiptGroup).slice(0, 64) : null).first();
  return Number(r.id);
}
// How much of a purchase has already been refunded (positive cents), counting the live refund
// expenses linked to it (optionally leaving one out — the one being edited).
export async function getRefundedCents(db, originalId, excludeId = 0) {
  const r = await db.prepare("SELECT COALESCE(-SUM(amountCents), 0) AS c FROM expenses WHERE refundOfId = ? AND deletedAt IS NULL AND amountCents < 0 AND id <> ?")
    .bind(Number(originalId), Number(excludeId) || 0).first();
  return Number(r.c);
}

// ---- Deposits: Venmo cash-outs, cash and checks (migrations/0017, 0018) --------
// Payments on real orders that haven't reached the bank yet — Venmo, cash, check and card (Stripe) payments.
// A payment recorded in ANOTHER account (Venmo, Cash on hand) is moved by a transfer, and can be
// deposited in PARTS (an order paid 50% down / 50% at the end reaches the bank in two cash-outs):
// each transfer records how much of the payment it covers (payment_cashouts), and the payment stays
// on the list until those add up to its amount (allocations to a deleted transfer don't count). A
// payment already recorded IN the bank account (checks default there) is matched to the deposit whole.
// One that's already matched to a statement line is left out. With `ids`, only those — used to
// re-validate what the browser sent.
export async function getDepositPayments(db, ids = null) {
  const idFilter = ids ? ` AND p.id IN (${ids.map(() => "?").join(",") || "NULL"})` : "";
  const { results } = await db.prepare(
    `SELECT * FROM (
       SELECT p.id, p.orderId, p.method, p.amountCents, p.feeCents, p.receivedAt, p.accountId, a.name AS accountName, o.customerName, o.orgId,
         COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
                    WHERE c.paymentId = p.id), 0) AS allocatedCents,
         EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = p.id) AS matched
         FROM order_payments p JOIN orders o ON o.orderId = p.orderId LEFT JOIN accounts a ON a.id = p.accountId
        WHERE p.method IN ('venmo', 'cash', 'check', 'zelle', 'card') AND p.kind = 'payment' AND p.voidedAt IS NULL AND p.accountId IS NOT NULL
          AND o.voidedAt IS NULL AND o.isTest = 0${idFilter}
     ) WHERE allocatedCents < amountCents AND matched = 0 ORDER BY receivedAt DESC, id DESC LIMIT ${ids ? 500 : 300}`).bind(...(ids || [])).all();
  return results.map(r => ({ id: Number(r.id), orderId: r.orderId, orgId: r.orgId, customerName: r.customerName, method: r.method, amountCents: Number(r.amountCents),
    feeCents: Number(r.feeCents || 0), receivedAt: r.receivedAt, accountId: Number(r.accountId), accountName: r.accountName || "",
    allocatedCents: Number(r.allocatedCents), remainingCents: Number(r.amountCents) - Number(r.allocatedCents) }));
}
// What part of a payment's amount reaches the bank: a fee already recorded on the payment is
// taken out in proportion to how much of the payment is being cashed out.
export function cashoutNetCents_(p, allocCents) {
  return p.feeCents > 0 ? Math.round(allocCents * (p.amountCents - p.feeCents) / p.amountCents) : allocCents;
}
// allocations: [{paymentId, amountCents}]
export async function linkPaymentsToCashout(db, allocations, transferId) {
  if (!allocations.length) return;
  const now = new Date().toISOString();
  await db.batch(allocations.map(a => db.prepare("INSERT INTO payment_cashouts (paymentId, transferId, amountCents, createdAt) VALUES (?, ?, ?, ?)")
    .bind(Number(a.paymentId), Number(transferId), Number(a.amountCents), now)));
}
// Soft delete: kept (with the audit snapshot) but excluded from every total.
export async function deleteExpense(db, id) {
  await db.prepare("UPDATE expenses SET deletedAt = ? WHERE id = ? AND deletedAt IS NULL").bind(new Date().toISOString(), Number(id)).run();
}
export async function expenseMonth(db, id) {
  const r = await db.prepare("SELECT expenseDate FROM expenses WHERE id = ?").bind(Number(id)).first();
  return r ? String(r.expenseDate).slice(0, 7) : "";
}

// ---- Expense CSV import helpers ----------------------------------------------
const normDesc_ = (d) => String(d || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
// For each candidate row {date, description, amountCents}: is an expense with
// the same date and amount (and similar description) already recorded, and
// which category did you use last time for this description? Suggestion =
// the most recent expense with the same description, else one whose
// description starts with the same first word (4+ letters).
export async function previewExpenseRows(db, rows) {
  const { results: recent } = await db.prepare(
    "SELECT expenseDate, description, amountCents, categoryId FROM expenses WHERE deletedAt IS NULL ORDER BY expenseDate DESC, id DESC LIMIT 2000").all();
  const byDesc = new Map(), byWord = new Map(), existing = new Set();
  for (const e of recent) {
    const n = normDesc_(e.description);
    if (!byDesc.has(n)) byDesc.set(n, Number(e.categoryId));
    const w = n.split(" ")[0];
    if (w && w.length >= 4 && !byWord.has(w)) byWord.set(w, Number(e.categoryId));
    existing.add(`${e.expenseDate}|${Number(e.amountCents)}`);
  }
  return rows.map(r => {
    const n = normDesc_(r.description), w = n.split(" ")[0];
    return { duplicate: existing.has(`${r.date}|${Math.round(r.amountCents)}`),
      suggestedCategoryId: byDesc.get(n) || (w && w.length >= 4 ? byWord.get(w) : null) || null };
  });
}

// Totals for a period: by Schedule C line and by category, plus the capital
// purchases (depreciation) as an asset register for Form 4562. Dollars out.
export async function getExpenseSummary(db, dateFrom, dateTo) {
  const { results } = await db.prepare(`${EXPENSE_SELECT_}
    WHERE e.expenseDate >= ? AND e.expenseDate <= ? AND e.deletedAt IS NULL ORDER BY e.expenseDate`).bind(dateFrom, dateTo).all();
  const byLine = {}, byCategory = {};
  const t = { amount: 0, deductible: 0, capital: 0, nonDeductible: 0 };
  const assets = [];
  for (const r of results) {
    const amt = Number(r.amountCents), ded = expenseDeductibleCents_(r);
    t.amount += amt;
    const c = (byCategory[r.categoryId] = byCategory[r.categoryId] || { categoryId: Number(r.categoryId), category: r.categoryName,
      deductionType: r.deductionType, scheduleCLine: r.scheduleCLine, amount: 0, deductible: 0, count: 0 });
    c.amount += amt; c.deductible += ded; c.count++;
    if (r.deductionType === "deductible") {
      t.deductible += ded; t.nonDeductible += amt - ded;
      const key = r.scheduleCLine || "27a";
      const l = (byLine[key] = byLine[key] || { line: key, label: SCHEDULE_C_LINES[key] || "Other expenses", amount: 0, deductible: 0 });
      l.amount += amt; l.deductible += ded;
    } else if (r.deductionType === "depreciation") {
      t.capital += amt;
      assets.push({ id: Number(r.id), date: r.expenseDate, description: r.description, vendor: r.vendor || "", category: r.categoryName,
        cost: fromCents(amt), businessUsePct: Number(r.businessUsePct), businessBasis: fromCents(Math.round(amt * Number(r.businessUsePct) / 100)),
        placedInService: r.placedInService || r.expenseDate, method: DEPRECIATION_METHODS[r.depMethod] || "Ask CPA" });
    } else {
      t.nonDeductible += amt;
    }
  }
  const lineOrder = Object.keys(SCHEDULE_C_LINES);
  const money = (o) => ({ ...o, amount: fromCents(o.amount), deductible: fromCents(o.deductible) });
  return {
    totals: { amount: fromCents(t.amount), deductible: fromCents(t.deductible), capital: fromCents(t.capital), nonDeductible: fromCents(t.nonDeductible) },
    byLine: Object.values(byLine).sort((a, b) => lineOrder.indexOf(a.line) - lineOrder.indexOf(b.line)).map(money),
    byCategory: Object.values(byCategory).sort((a, b) => a.category.localeCompare(b.category)).map(money),
    assets,
  };
}

// ---- Accounts & money movements (migrations/0014) ---------------------------
export const ACCOUNT_TYPES = { checking: "Checking", credit_card: "Credit card", venmo: "Venmo", cash: "Cash", stripe: "Stripe", other: "Other" };
export const OTHER_INCOME_TYPES = {
  service: "Services (Schedule C line 1)",
  other: "Other business income (Schedule C line 6)",
  interest: "Interest (Schedule B — not Schedule C)",
};
const METHOD_ACCOUNT_TYPE_ = { card: "stripe", venmo: "venmo", cash: "cash", zelle: "checking", check: "checking", other: "checking" };

// The (first active) account a payment method's money lands in.
export async function accountIdForMethod(db, method) {
  const type = METHOD_ACCOUNT_TYPE_[method] || "checking";
  const r = await db.prepare("SELECT id FROM accounts WHERE type = ? AND active = 1 ORDER BY id LIMIT 1").bind(type).first();
  return r ? Number(r.id) : null;
}
// Where Shippo postage is charged and where Stripe pays out to.
export async function getMoneyDefaults(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='moneyDefaults'").first();
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch (_) {}
  return { postageAccountId: Number(v.postageAccountId) || 2, payoutAccountId: Number(v.payoutAccountId) || 1 };
}
export async function setMoneyDefaults(db, d) {
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('moneyDefaults', ?)")
    .bind(JSON.stringify({ postageAccountId: Number(d.postageAccountId), payoutAccountId: Number(d.payoutAccountId) })).run();
}

// Every money movement, one row per account side: (src, srcId, accountId,
// date YYYY-MM-DD, cents signed — into the account positive), plus a label.
// Balances sum these; statement reconciliation (Part B) matches against them.
// Kept as separate SELECTs run one by one: D1 caps the number of terms in a
// compound (UNION ALL) SELECT well below the nine sources here.
export const MONEY_MOVE_SOURCES = [
  `SELECT 'payment' AS src, p.id AS srcId, p.accountId AS accountId, substr(p.receivedAt, 1, 10) AS d, p.amountCents AS c,
          p.orderId || ' ' || p.kind || ' (' || p.method || ')' AS label FROM order_payments p WHERE p.voidedAt IS NULL AND p.accountId IS NOT NULL`,
  `SELECT 'fee' AS src, p.id AS srcId, p.accountId AS accountId, substr(p.receivedAt, 1, 10) AS d, -p.feeCents AS c, p.orderId || ' processing fee' AS label
     FROM order_payments p WHERE p.voidedAt IS NULL AND p.accountId IS NOT NULL AND p.feeCents > 0`,
  `SELECT 'expense' AS src, e.id AS srcId, e.accountId AS accountId, e.expenseDate AS d, -e.amountCents AS c, e.description AS label
     FROM expenses e WHERE e.deletedAt IS NULL AND e.accountId IS NOT NULL AND e.paidPersonally = 0`,
  `SELECT 'blanks' AS src, m.id AS srcId, m.accountId AS accountId, substr(m.occurredAt, 1, 10) AS d, -(m.qtyDelta * m.unitCostCents) AS c,
          'Blanks: ' || m.blankName || ' ' || m.size AS label FROM inventory_movements m WHERE m.kind = 'purchase' AND m.accountId IS NOT NULL AND m.paidPersonally = 0 AND m.voidedAt IS NULL`,
  // Transfer sheets bought (the inventory part; a written-off or personal part is its own expense /
  // owner draw), so the "Paid from" account moves and the purchase can be reconciled.
  `SELECT 'transfer_sheet' AS src, m.id AS srcId, m.accountId AS accountId, substr(m.occurredAt, 1, 10) AS d, -(m.qtyDelta * m.unitCostCents) AS c,
          'Transfers: ' || m.transferName AS label FROM transfer_movements m WHERE m.kind = 'purchase' AND m.accountId IS NOT NULL AND m.paidPersonally = 0 AND m.voidedAt IS NULL`,
  `SELECT 'postage' AS src, l.id AS srcId, l.accountId AS accountId, substr(l.purchasedAt, 1, 10) AS d, -l.amountCents AS c, 'Postage ' || l.orderId AS label
     FROM shipping_labels l WHERE l.voidedAt IS NULL AND l.accountId IS NOT NULL`,
  `SELECT 'income' AS src, i.id AS srcId, i.accountId AS accountId, i.incomeDate AS d, i.amountCents AS c, i.description AS label
     FROM other_income i WHERE i.deletedAt IS NULL`,
  `SELECT 'owner' AS src, o.id AS srcId, o.accountId AS accountId, o.txDate AS d, CASE o.kind WHEN 'contribution' THEN o.amountCents ELSE -o.amountCents END AS c,
          CASE o.kind WHEN 'contribution' THEN 'Owner contribution' ELSE 'Owner draw' END AS label FROM owner_transactions o WHERE o.deletedAt IS NULL`,
  `SELECT 'transfer_out' AS src, t.id AS srcId, t.fromAccountId AS accountId, t.transferDate AS d, -t.amountCents AS c, 'Transfer out' AS label
     FROM account_transfers t WHERE t.deletedAt IS NULL`,
  `SELECT 'transfer_in' AS src, t.id AS srcId, t.toAccountId AS accountId, t.transferDate AS d, t.amountCents AS c, 'Transfer in' AS label
     FROM account_transfers t WHERE t.deletedAt IS NULL`,
];

// Accounts with their balance as of `asOf` (YYYY-MM-DD, inclusive): opening
// balance + every movement dated on/after the opening date. Dollars out.
export async function listAccounts(db, asOf = new Date().toISOString().slice(0, 10)) {
  const { results: accts } = await db.prepare("SELECT * FROM accounts ORDER BY id").all();
  const moved = {}, moves = {};
  const perSource = await Promise.all(MONEY_MOVE_SOURCES.map(sql => db.prepare(`
    SELECT m.accountId, SUM(CASE WHEN m.d >= a.openingDate AND m.d <= ? THEN m.c ELSE 0 END) AS c, count(*) AS n
    FROM (${sql}) m JOIN accounts a ON a.id = m.accountId GROUP BY m.accountId`).bind(asOf).all()));
  for (const { results } of perSource) for (const r of results) {
    moved[r.accountId] = (moved[r.accountId] || 0) + Number(r.c || 0);
    moves[r.accountId] = (moves[r.accountId] || 0) + Number(r.n || 0);
  }
  return accts.map(a => ({ id: Number(a.id), name: a.name, type: a.type, openingBalance: fromCents(a.openingBalanceCents),
    openingDate: a.openingDate, active: !!a.active, csvMapping: a.csvMapping || "", balance: fromCents(Number(a.openingBalanceCents) + (moved[a.id] || 0)), moves: moves[a.id] || 0 }));
}
export async function saveAccount(db, id, { name, type, openingBalance, openingDate, active }) {
  const now = new Date().toISOString();
  if (id) {
    await db.prepare("UPDATE accounts SET name=?, type=?, openingBalanceCents=?, openingDate=?, active=?, updatedAt=? WHERE id=?")
      .bind(String(name).trim(), type, toCents(openingBalance), openingDate, active ? 1 : 0, now, Number(id)).run();
    return Number(id);
  }
  const r = await db.prepare(`INSERT INTO accounts (name, type, openingBalanceCents, openingDate, active, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(String(name).trim(), type, toCents(openingBalance), openingDate, active ? 1 : 0, now, now).first();
  return Number(r.id);
}
export async function getAccount(db, id) {
  const r = await db.prepare("SELECT * FROM accounts WHERE id=?").bind(Number(id)).first();
  return r ? { id: Number(r.id), name: r.name, type: r.type, active: !!r.active, openingDate: r.openingDate, openingBalance: fromCents(r.openingBalanceCents) } : null;
}

// Generic dated entries: other income, owner transactions, transfers.
const MONEY_TABLES_ = {
  income:   { table: "other_income",       date: "incomeDate",   cols: ["description", "type", "accountId", "reference"] },
  owner:    { table: "owner_transactions", date: "txDate",       cols: ["kind", "accountId", "note"] },
  transfer: { table: "account_transfers",  date: "transferDate", cols: ["fromAccountId", "toAccountId", "note", "externalRef"] },
};
function parseMoneyRow_(kind, r) {
  const t = MONEY_TABLES_[kind];
  const out = { id: Number(r.id), date: r[t.date], amount: fromCents(r.amountCents), deletedAt: r.deletedAt || "" };
  for (const c of t.cols) out[c] = /AccountId$|^accountId$/.test(c) ? Number(r[c]) : (r[c] ?? "");
  return out;
}
export async function listMoneyEntries(db, kind, dateFrom, dateTo) {
  const t = MONEY_TABLES_[kind];
  const { results } = await db.prepare(`SELECT * FROM ${t.table} WHERE deletedAt IS NULL AND ${t.date} >= ? AND ${t.date} <= ? ORDER BY ${t.date} DESC, id DESC`)
    .bind(dateFrom, dateTo).all();
  return results.map(r => parseMoneyRow_(kind, r));
}
export async function getMoneyEntry(db, kind, id) {
  const t = MONEY_TABLES_[kind];
  const r = await db.prepare(`SELECT * FROM ${t.table} WHERE id = ?`).bind(Number(id)).first();
  return r ? parseMoneyRow_(kind, r) : null;
}
// Fields already validated by the caller (orders.js).
export async function saveMoneyEntry(db, kind, id, x) {
  const t = MONEY_TABLES_[kind], now = new Date().toISOString();
  const cols = [t.date, "amountCents", ...t.cols];
  const vals = [x.date, toCents(x.amount), ...t.cols.map(c => x[c] ?? (/AccountId$|^accountId$/.test(c) ? null : ""))];
  if (id) {
    await db.prepare(`UPDATE ${t.table} SET ${cols.map(c => c + " = ?").join(", ")}, updatedAt = ? WHERE id = ? AND deletedAt IS NULL`)
      .bind(...vals, now, Number(id)).run();
    return Number(id);
  }
  // The owner draw one receive wrote carries that receive's receiptGroup (migrations/0061).
  const group = kind === "owner" && x.receiptGroup ? String(x.receiptGroup).slice(0, 64) : null;
  const r = await db.prepare(`INSERT INTO ${t.table} (${cols.join(", ")}, createdAt, updatedAt${group ? ", receiptGroup" : ""}) VALUES (${cols.map(() => "?").join(", ")}, ?, ?${group ? ", ?" : ""}) RETURNING id`)
    .bind(...vals, now, now, ...(group ? [group] : [])).first();
  return Number(r.id);
}
export async function deleteMoneyEntry(db, kind, id) {
  const t = MONEY_TABLES_[kind];
  await db.prepare(`UPDATE ${t.table} SET deletedAt = ? WHERE id = ? AND deletedAt IS NULL`).bind(new Date().toISOString(), Number(id)).run();
}
export async function moneyEntryMonth(db, kind, id) {
  const e = await getMoneyEntry(db, kind, id);
  return e ? String(e.date).slice(0, 7) : "";
}

// A Stripe payout (payout.paid webhook): Stripe balance → the payout account
// (a negative payout — Stripe debiting the bank — goes the other way).
// Idempotent on the payout id. Returns true when newly recorded.
export async function recordStripePayout(db, { payoutId, amountCents, arrivalDate }) {
  const stripe = await db.prepare("SELECT id FROM accounts WHERE type = 'stripe' AND active = 1 ORDER BY id LIMIT 1").first();
  const { payoutAccountId } = await getMoneyDefaults(db);
  if (!stripe || !payoutId || !amountCents) return false;
  const out = amountCents > 0;
  const now = new Date().toISOString();
  const r = await db.prepare(`INSERT OR IGNORE INTO account_transfers (transferDate, fromAccountId, toAccountId, amountCents, note, externalRef, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(arrivalDate, out ? Number(stripe.id) : payoutAccountId, out ? payoutAccountId : Number(stripe.id),
    Math.abs(Math.round(amountCents)), "Stripe payout", payoutId, now, now).run();
  return !!(r.meta && r.meta.changes);
}

// Year-end style summary for a period (YYYY-MM-DD bounds): other income by
// type, owner money in/out (including expenses and blanks paid personally),
// and account balances at the end. Dollars out.
export async function getMoneySummary(db, dateFrom, dateTo) {
  const q = async (sql, ...b) => (await db.prepare(sql).bind(...b).first()) || {};
  const byType = (await db.prepare(`SELECT type, SUM(amountCents) c, count(*) n FROM other_income WHERE deletedAt IS NULL AND incomeDate >= ? AND incomeDate <= ? GROUP BY type`)
    .bind(dateFrom, dateTo).all()).results;
  const own = (await db.prepare(`SELECT kind, SUM(amountCents) c FROM owner_transactions WHERE deletedAt IS NULL AND txDate >= ? AND txDate <= ? GROUP BY kind`)
    .bind(dateFrom, dateTo).all()).results;
  const personalExp = await q(`SELECT COALESCE(SUM(amountCents), 0) c FROM expenses WHERE deletedAt IS NULL AND paidPersonally = 1 AND expenseDate >= ? AND expenseDate <= ?`, dateFrom, dateTo);
  const personalBlanks = await q(`SELECT COALESCE(SUM(qtyDelta * unitCostCents), 0) c FROM inventory_movements WHERE kind = 'purchase' AND paidPersonally = 1 AND voidedAt IS NULL AND substr(occurredAt, 1, 10) >= ? AND substr(occurredAt, 1, 10) <= ?`, dateFrom, dateTo);
  const personalTransfers = await q(`SELECT COALESCE(SUM(qtyDelta * unitCostCents), 0) c FROM transfer_movements WHERE kind = 'purchase' AND paidPersonally = 1 AND voidedAt IS NULL AND substr(occurredAt, 1, 10) >= ? AND substr(occurredAt, 1, 10) <= ?`, dateFrom, dateTo);
  const unassigned = await q(`SELECT
      (SELECT count(*) FROM expenses WHERE deletedAt IS NULL AND accountId IS NULL AND paidPersonally = 0) +
      (SELECT count(*) FROM inventory_movements WHERE kind = 'purchase' AND accountId IS NULL AND paidPersonally = 0 AND voidedAt IS NULL) +
      (SELECT count(*) FROM transfer_movements WHERE kind = 'purchase' AND accountId IS NULL AND paidPersonally = 0 AND voidedAt IS NULL) +
      (SELECT count(*) FROM order_payments WHERE voidedAt IS NULL AND accountId IS NULL) AS n`);
  const cents = (arr, key) => Number((arr.find(r => r.type === key || r.kind === key) || {}).c || 0);
  const contributed = cents(own, "contribution"), personal = Number(personalExp.c) + Number(personalBlanks.c) + Number(personalTransfers.c);
  return {
    otherIncome: Object.fromEntries(Object.keys(OTHER_INCOME_TYPES).map(k => [k, fromCents(cents(byType, k))])),
    owner: { contributions: fromCents(contributed), paidPersonally: fromCents(personal), totalIn: fromCents(contributed + personal), draws: fromCents(cents(own, "draw")) },
    unassigned: Number(unassigned.n || 0),
    balances: await listAccounts(db, dateTo),
  };
}

// Stock bought — garment blanks and transfer sheets — for Accounts & money. Inventory, not expenses:
// each becomes cost of goods sold as it's used. One row per receive (the rows one
// Receive / Receive order / Receive sheet wrote together), with what was bought, the vendor and
// invoice, where the money came from and the receipt. Voided entries are left out. The amount is the
// inventory part only (incl. shipping spread into the cost); an R&D or personal part of the same order
// is its own expense / owner draw. Dollars out, newest first.
export async function listStockPurchases(db, dateFrom, dateTo) {
  const read = async (sql) => { try { return (await db.prepare(sql).bind(dateFrom, dateTo).all()).results || []; } catch (e) { if (/no such (table|column)/i.test(String(e && e.message))) return []; throw e; } };
  const blanks = await read(`SELECT id, blankName AS name, color, size, qtyDelta AS qty, unitCostCents, vendor, vendorRef, occurredAt, createdAt,
      accountId, paidPersonally, receiptKey, receiptName, vendorChargedTax, receiptGroup FROM inventory_movements
    WHERE kind = 'purchase' AND voidedAt IS NULL AND substr(occurredAt, 1, 10) >= ? AND substr(occurredAt, 1, 10) <= ? ORDER BY id`);
  const transfers = await read(`SELECT id, transferName AS name, '' AS color, '' AS size, qtyDelta AS qty, unitCostCents, vendor, vendorRef, occurredAt, createdAt,
      accountId, paidPersonally, receiptKey, receiptName, 0 AS vendorChargedTax, receiptGroup FROM transfer_movements
    WHERE kind = 'purchase' AND voidedAt IS NULL AND substr(occurredAt, 1, 10) >= ? AND substr(occurredAt, 1, 10) <= ? ORDER BY id`);
  const accounts = Object.fromEntries(((await db.prepare("SELECT id, name FROM accounts").all()).results || []).map(a => [a.id, a.name]));
  const groups = [];
  for (const [kind, rows] of [["blanks", blanks], ["transfers", transfers]]) {
    const open = new Map();   // key → the group still taking rows
    for (const r of rows) {
      // Rows written by one receive share the date, vendor, invoice, payer and receipt, and were written
      // within moments of each other (each line is its own write, so not to the millisecond); the same
      // details written later are another purchase.
      // (Records stamped with a receiptGroup — migrations/0061 — are exactly one receive, however close in time another is.)
      const key = [r.occurredAt && String(r.occurredAt).slice(0, 10), r.vendor, r.vendorRef, r.accountId, r.paidPersonally, r.receiptKey, r.receiptGroup || ""].join("|");
      const at = Date.parse(r.createdAt) || 0;
      let g = open.get(key);
      if (g && Math.abs(at - g.lastAt) > 10000) g = null;
      if (!g) { groups.push(g = { kind, date: String(r.occurredAt || "").slice(0, 10), vendor: r.vendor || "", vendorRef: r.vendorRef || "",
        accountId: r.accountId == null ? null : Number(r.accountId), accountName: r.accountId == null ? "" : (accounts[r.accountId] || ""),
        paidPersonally: !!Number(r.paidPersonally), receiptKey: r.receiptKey || "", receiptName: r.receiptName || "",
        vendorChargedTax: !!Number(r.vendorChargedTax), receiptGroup: r.receiptGroup || "", qty: 0, cents: 0, items: new Map(), ids: [], lastAt: at }); open.set(key, g); }
      g.lastAt = at;
      g.qty += Number(r.qty) || 0;
      g.cents += (Number(r.qty) || 0) * (Number(r.unitCostCents) || 0);
      g.ids.push(Number(r.id));
      const item = [r.name, r.color].filter(Boolean).join(" · ");
      const sizes = g.items.get(item) || new Map();
      const sz = r.size || "";
      sizes.set(sz, (sizes.get(sz) || 0) + (Number(r.qty) || 0));
      g.items.set(item, sizes);
    }
  }
  // The other parts of the same receive (R&D / written-off expense, personal-use draw), for the receipts that are linked.
  const extras = new Map();
  const wanted = [...new Set(groups.map(g => g.receiptGroup).filter(Boolean))];
  for (let i = 0; i < wanted.length; i += 80) {
    const chunk = wanted.slice(i, i + 80), ph = chunk.map(() => "?").join(",");
    for (const [sql, label] of [[`SELECT receiptGroup AS g, amountCents AS c FROM expenses WHERE deletedAt IS NULL AND receiptGroup IN (${ph})`, "R&D / written-off expense"],
                                [`SELECT receiptGroup AS g, amountCents AS c FROM owner_transactions WHERE deletedAt IS NULL AND receiptGroup IN (${ph})`, "Personal-use draw"]]) {
      try { for (const e of (await db.prepare(sql).bind(...chunk).all()).results) { const a = extras.get(e.g) || []; a.push({ label, amount: fromCents(e.c) }); extras.set(e.g, a); } }
      catch (e) { if (!/no such (table|column)/i.test(String(e && e.message))) throw e; }
    }
  }
  return groups.map(g => ({ receiptGroup: g.receiptGroup, extras: extras.get(g.receiptGroup) || [],
    kind: g.kind, date: g.date, vendor: g.vendor, vendorRef: g.vendorRef, accountId: g.accountId, accountName: g.accountName,
    paidPersonally: g.paidPersonally, receiptKey: g.receiptKey, receiptName: g.receiptName, vendorChargedTax: g.vendorChargedTax, qty: g.qty, ids: g.ids,
    total: fromCents(g.cents),
    // "Gildan 64000 · Navy: S×4, M×6" — or "Crest ×25" for a transfer.
    items: [...g.items.entries()].map(([name, sizes]) => {
      const parts = [...sizes.entries()].map(([sz, q]) => (sz ? sz + "×" : "×") + q);
      return sizes.size === 1 && !([...sizes.keys()][0]) ? `${name} ${parts[0]}` : `${name}: ${parts.join(", ")}`;
    }) }))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.ids[0] - a.ids[0]);
}

// ---- Account viewer & receipts on money records (migrations/0061) ------------------------------
// Which table holds the receipt (receiptKey / receiptName) for each kind of money movement, and how to tell
// a live record from a voided / deleted one. A processing-fee row is its payment's; both sides of a transfer
// are the one transfer record.
const RECEIPT_TABLES_ = {
  payment:        { table: "order_payments",      live: "voidedAt IS NULL" },
  fee:            { table: "order_payments",      live: "voidedAt IS NULL" },
  expense:        { table: "expenses",            live: "deletedAt IS NULL" },
  blanks:         { table: "inventory_movements", live: "voidedAt IS NULL" },
  transfer_sheet: { table: "transfer_movements",  live: "voidedAt IS NULL" },
  postage:        { table: "shipping_labels",     live: "voidedAt IS NULL" },
  income:         { table: "other_income",        live: "deletedAt IS NULL" },
  owner:          { table: "owner_transactions",  live: "deletedAt IS NULL" },
  transfer_in:    { table: "account_transfers",   live: "deletedAt IS NULL" },
  transfer_out:   { table: "account_transfers",   live: "deletedAt IS NULL" },
};
const REGISTER_CATEGORY_ = { fee: "Processing fee", blanks: "Blanks", transfer_sheet: "Transfers (stock)", postage: "Postage", income: "Other income" };

// ---- One charge per receipt (2026-10) ---------------------------------------------------------------
// The records one stock receive wrote — a stock row per blank / color / size (or per transfer sheet line),
// plus its R&D / written-off expense and personal-items draw when it has them — are ONE charge on the card
// or bank statement. receiptGroups_ says which of the given money moves ({src, srcId}) belong together:
// Map "src:srcId" → {group, kind, vendor, vendorRef, part}, `part` being the stock line's own wording
// ("Gildan 64000 · Navy M ×6"). Receives stamped with a receiptGroup (migrations/0061) group by it. Older ones:
// with an invoice # — same day, vendor, invoice # and payer, however far apart they were entered (one invoice
// can be received in two sittings, e.g. a color added to the blank first, each with its own copy of the PDF);
// without one — same day, vendor, payer and receipt file, written within 10 s of each other. An expense or
// draw joins through a shared receiptGroup, or — for an older receive — by the wording Receive order gives
// them ("R&D / testing — SanMar #SO-1", "Personal items — SanMar #SO-1"), same date and payer.
// Moves of other kinds aren't in the map.
async function receiptGroups_(db, moves) {
  const out = new Map();
  const ids = (src) => [...new Set(moves.filter(m => m.src === src).map(m => Number(m.srcId)))];
  const read = async (sqlWith, sqlWithout, list) => {
    const rows = [];
    for (let i = 0; i < list.length; i += 80) {
      const chunk = list.slice(i, i + 80), q = chunk.map(() => "?").join(",");
      try { rows.push(...((await db.prepare(sqlWith(q)).bind(...chunk).all()).results || [])); }
      catch (e) { if (!/no such column/i.test(String(e && e.message))) throw e; rows.push(...((await db.prepare(sqlWithout(q)).bind(...chunk).all()).results || [])); }
    }
    return rows;
  };
  for (const [src, table, nameCol, colorCol, kind] of [["blanks", "inventory_movements", "blankName", "color", "blanks"], ["transfer_sheet", "transfer_movements", "transferName", "''", "transfers"]]) {
    const cols = `id, ${nameCol} AS name, ${colorCol} AS color, size, qtyDelta, vendor, vendorRef, accountId, paidPersonally, receiptKey, occurredAt, createdAt`;
    const rows = await read((q) => `SELECT ${cols}, receiptGroup FROM ${table} WHERE id IN (${q})`, (q) => `SELECT ${cols}, NULL AS receiptGroup FROM ${table} WHERE id IN (${q})`, ids(src));
    const legacy = new Map();
    for (const r of rows) {
      if (r.receiptGroup) { out.set(`${src}:${r.id}`, { group: "group:" + r.receiptGroup, row: r, kind }); continue; }
      const byInvoice = !!String(r.vendorRef || "").trim();
      const k = [kind, String(r.occurredAt || "").slice(0, 10), r.vendor || "", r.vendorRef || "", r.accountId ?? "", Number(r.paidPersonally) || 0, byInvoice ? "" : (r.receiptKey || "")].join("\u0001");
      (legacy.get(k) || legacy.set(k, { byInvoice, rows: [] }).get(k)).rows.push(r);
    }
    for (const { byInvoice, rows: list } of legacy.values()) {
      list.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || Number(a.id) - Number(b.id));
      let group = "", last = 0;
      for (const r of list) {
        const at = Date.parse(r.createdAt) || 0;
        if (!group || (!byInvoice && at - last > RECEIPT_CLUSTER_GAP_MS_)) group = `legacy:${kind}:${r.id}`;
        last = at;
        out.set(`${src}:${r.id}`, { group, row: r, kind });
      }
    }
  }
  for (const v of out.values()) {
    const r = v.row;
    v.vendor = r.vendor || ""; v.vendorRef = r.vendorRef || "";
    v.day = String(r.occurredAt || "").slice(0, 10); v.accountId = r.accountId;
    v.part = [r.name, r.color].filter(Boolean).join(" · ") + (r.size ? " " + r.size : "") + " ×" + Number(r.qtyDelta);
    delete v.row;
  }
  // The R&D / written-off expense and the personal-items draw of a receive: a stamped one shares its
  // receiptGroup; an older blank receive's are found by the wording Receive order gave them, same date and payer.
  const stamped = new Map(), byWording = new Map();
  for (const v of out.values()) {
    if (v.group.startsWith("group:")) { if (!stamped.has(v.group)) stamped.set(v.group, v); continue; }
    if (v.kind !== "blanks" || !v.vendor) continue;
    const what = v.vendor + (v.vendorRef ? ` #${v.vendorRef}` : "");
    for (const prefix of ["R&D / testing — ", "Personal items — "]) {
      const k = [prefix + what, v.day, v.accountId ?? ""].join("\u0001");
      if (!byWording.has(k)) byWording.set(k, v);
    }
  }
  if (stamped.size || byWording.size) {
    for (const [src, table, textCol, dateCol] of [["expense", "expenses", "description", "expenseDate"], ["owner", "owner_transactions", "note", "txDate"]]) {
      const cols = `id, ${textCol} AS text, ${dateCol} AS d, accountId`;
      const rows = await read((q) => `SELECT ${cols}, receiptGroup FROM ${table} WHERE id IN (${q})`, (q) => `SELECT ${cols}, NULL AS receiptGroup FROM ${table} WHERE id IN (${q})`, ids(src));
      for (const r of rows) {
        const g = r.receiptGroup ? stamped.get("group:" + r.receiptGroup) : byWording.get([String(r.text || ""), String(r.d || "").slice(0, 10), r.accountId ?? ""].join("\u0001"));
        if (g) out.set(`${src}:${r.id}`, { group: g.group, kind: g.kind, vendor: g.vendor, vendorRef: g.vendorRef, part: src === "owner" ? String(r.text || "Personal items") : "" });
      }
    }
  }
  // Only a receipt with more than one record among these moves is worth combining.
  const count = {};
  for (const m of moves) { const v = out.get(`${m.src}:${m.srcId}`); if (v) count[v.group] = (count[v.group] || 0) + 1; }
  for (const [k, v] of out) if ((count[v.group] || 0) < 2) out.delete(k);
  return out;
}
// The one-line wording of a combined receipt: "Blanks — S&S Activewear #INV-1001 (3 items)".
function receiptLabel_(g, n) {
  const who = [g.vendor, g.vendorRef ? "#" + g.vendorRef : ""].filter(Boolean).join(" ");
  return `${g.kind === "transfers" ? "Transfer sheets" : "Blanks"}${who ? " — " + who : ""} (${n} item${n === 1 ? "" : "s"})`;
}
// Moves {key, src, srcId, date, cents, label} → one entry per receipt, in the order of each receipt's first
// part: {key, keys, date, cents, label, parts: [{key, label, cents}]} (a plain move keeps keys [key], parts []).
async function combineReceipts_(db, moves) {
  const groups = await receiptGroups_(db, moves);
  const out = [], byGroup = new Map();
  for (const m of moves) {
    const g = groups.get(m.key);
    if (!g) { out.push({ ...m, keys: [m.key], parts: [] }); continue; }
    let e = byGroup.get(g.group);
    if (!e) { byGroup.set(g.group, e = { key: m.key, keys: [], date: m.date, cents: 0, label: "", parts: [], src: m.src, srcId: m.srcId, _g: g }); out.push(e); }
    e.keys.push(m.key); e.cents += m.cents;
    e.parts.push({ key: m.key, label: g.part || m.label, cents: m.cents });
  }
  for (const e of out) if (e._g) { e.label = receiptLabel_(e._g, e.parts.length); delete e._g; }
  return out;
}

// The register of one account: every movement from MONEY_MOVE_SOURCES (the same list the balances are summed
// from, so it can never disagree with Accounts & money) dated on/after the account's opening date and up to
// `dateTo`, oldest first for the running balance, returned NEWEST first. Dollars out.
export async function getAccountRegister(db, accountId, dateFrom, dateTo) {
  const acct = await db.prepare("SELECT * FROM accounts WHERE id = ?").bind(Number(accountId)).first();
  if (!acct) return null;
  const all = [];
  const perSource = await Promise.all(MONEY_MOVE_SOURCES.map(sql => db.prepare(
    `SELECT m.* FROM (${sql}) m WHERE m.accountId = ? AND m.d >= ? AND m.d <= ?`).bind(Number(accountId), acct.openingDate, dateTo).all()));
  perSource.forEach(({ results }, order) => { for (const r of results) all.push({ src: r.src, srcId: Number(r.srcId), date: r.d, cents: Number(r.c), label: r.label || "", order }); });
  all.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order || a.srcId - b.srcId);
  // One row per stock receipt (2026-10): its records — a stock row per blank / size, and any R&D expense or
  // personal-items draw — sit together where the first of them falls, and become one row with the parts listed.
  const rgroups = await receiptGroups_(db, all);
  if (rgroups.size) {
    const members = new Map();
    for (const r of all) { const g = rgroups.get(`${r.src}:${r.srcId}`); if (g) (members.get(g.group) || members.set(g.group, []).get(g.group)).push(r); }
    const done = new Set(), ordered = [];
    for (const r of all) {
      const g = rgroups.get(`${r.src}:${r.srcId}`);
      if (!g) { ordered.push(r); continue; }
      if (done.has(g.group)) continue;
      done.add(g.group);
      ordered.push(...members.get(g.group));
    }
    all.length = 0; all.push(...ordered);
  }

  // Extra facts the category / description need: transfer counterparties and receipts, one query per table.
  const ids = (src) => [...new Set(all.filter(r => r.src === src).map(r => r.srcId))];
  const names = Object.fromEntries(((await db.prepare("SELECT id, name FROM accounts").all()).results || []).map(a => [Number(a.id), a.name]));
  const xfer = new Map();
  const xferIds = [...new Set([...ids("transfer_in"), ...ids("transfer_out")])];
  for (let i = 0; i < xferIds.length; i += 80) {
    const chunk = xferIds.slice(i, i + 80);
    const { results } = await db.prepare(`SELECT id, fromAccountId, toAccountId, note FROM account_transfers WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
    for (const t of results) xfer.set(Number(t.id), t);
  }
  const receipts = new Map();   // "table:id" → {key, name}
  for (const table of [...new Set(Object.values(RECEIPT_TABLES_).map(t => t.table))]) {
    const want = [...new Set(all.filter(r => RECEIPT_TABLES_[r.src].table === table).map(r => r.srcId))];
    for (let i = 0; i < want.length; i += 80) {
      const chunk = want.slice(i, i + 80);
      const { results } = await db.prepare(`SELECT id, receiptKey, receiptName FROM ${table} WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
      for (const t of results) receipts.set(table + ":" + Number(t.id), { key: t.receiptKey || "", name: t.receiptName || "" });
    }
  }

  let bal = Number(acct.openingBalanceCents) || 0, startBal = bal, totalIn = 0, totalOut = 0;
  const rows = [];
  let open = null;   // the receipt row still taking parts
  for (const r of all) {
    const before = r.date < dateFrom;
    bal += r.cents;
    if (before) { startBal = bal; continue; }
    if (r.cents > 0) totalIn += r.cents; else totalOut += -r.cents;
    const g = rgroups.get(`${r.src}:${r.srcId}`);
    if (g) {
      const isStock = r.src === "blanks" || r.src === "transfer_sheet";
      if (open && open._group === g.group) {
        open._cents += r.cents; open.amount = fromCents(open._cents); open.balance = fromCents(bal);
        open.parts.push({ description: g.part || r.label, amount: fromCents(r.cents) });
        if (isStock && !open._stock) {   // the receipt button works through a stock row (it covers the whole receive)
          const rc = receipts.get(RECEIPT_TABLES_[r.src].table + ":" + r.srcId) || { key: "", name: "" };
          Object.assign(open, { src: r.src, srcId: r.srcId, receiptKey: rc.key, receiptName: rc.name, _stock: true });
        }
        open.description = receiptLabel_(g, open.parts.length);
        continue;
      }
      const rc = receipts.get(RECEIPT_TABLES_[r.src].table + ":" + r.srcId) || { key: "", name: "" };
      open = { src: r.src, srcId: r.srcId, date: r.date, category: g.kind === "transfers" ? "Transfers (stock)" : "Blanks", description: receiptLabel_(g, 1),
        amount: fromCents(r.cents), balance: fromCents(bal), receiptKey: rc.key, receiptName: rc.name,
        parts: [{ description: g.part || r.label, amount: fromCents(r.cents) }], _group: g.group, _cents: r.cents, _stock: isStock };
      rows.push(open);
      continue;
    }
    open = null;
    let category = REGISTER_CATEGORY_[r.src] || "", description = r.label;
    if (r.src === "payment") category = / (refund|dispute) \(/.test(r.label) ? "Refund" : "Deposit";
    else if (r.src === "expense") category = r.cents > 0 ? "Expense refund" : "Expense";
    else if (r.src === "owner") category = r.cents > 0 ? "Owner contribution" : "Owner draw";
    else if (r.src === "transfer_in" || r.src === "transfer_out") {
      const t = xfer.get(r.srcId), other = t ? Number(r.src === "transfer_in" ? t.fromAccountId : t.toAccountId) : 0;
      category = "Transfer";
      description = (r.src === "transfer_in" ? "From " : "To ") + (names[other] || "another account") + (t && t.note ? " — " + t.note : "");
    }
    const rc = receipts.get(RECEIPT_TABLES_[r.src].table + ":" + r.srcId) || { key: "", name: "" };
    rows.push({ src: r.src, srcId: r.srcId, date: r.date, category, description, amount: fromCents(r.cents), balance: fromCents(bal),
      receiptKey: rc.key, receiptName: rc.name });
  }
  for (const r of rows) { delete r._group; delete r._cents; delete r._stock; }
  rows.reverse();
  const MAX_ROWS = 3000;
  return { account: { id: Number(acct.id), name: acct.name, type: acct.type, active: !!acct.active, openingDate: acct.openingDate, openingBalance: fromCents(acct.openingBalanceCents) },
    dateFrom, dateTo, startBalance: fromCents(startBal), endBalance: fromCents(bal), totalIn: fromCents(totalIn), totalOut: fromCents(totalOut),
    count: rows.length, truncated: rows.length > MAX_ROWS, rows: rows.slice(0, MAX_ROWS) };
}

// ---- One receipt = several records ---------------------------------------------------------------
// A Receive order (or transfer sheet) writes the stock rows for every blank / sheet on it, an optional
// R&D / written-off expense and an optional personal-use owner draw. New receives stamp them all with one
// receiptGroup; older ones are found by what they share. `kind` is "blanks" or "transfers"; `seedId` is any
// one of the stock rows. Returns null when it isn't a live purchase row, else
//   { kind, via: "group"|"match", group, stock: [{id, name, color, size, qty, unitCostCents, accountId, paidPersonally, occurredAt, receiptKey}],
//     expense: {...}|null, draw: {...}|null, vendor, vendorRef, date, accountId, paidPersonally, receiptKey, receiptName }
const RECEIPT_EXTRA_PREFIX_ = { blanks: "R&D / testing —", transfers: "Transfer sheet written off —" };
const RECEIPT_CLUSTER_GAP_MS_ = 10000;     // rows one receive wrote are written within moments of each other
export async function getReceiptRecords(db, kind, seedId) {
  const table = kind === "transfers" ? "transfer_movements" : "inventory_movements";
  const nameCol = kind === "transfers" ? "transferName" : "blankName";
  const seed = await db.prepare(`SELECT * FROM ${table} WHERE id = ? AND kind = 'purchase' AND voidedAt IS NULL`).bind(Number(seedId)).first();
  if (!seed) return null;
  const stockOf = (r) => ({ id: Number(r.id), name: r[nameCol] || "", color: r.color || "", size: r.size || "", qty: Number(r.qtyDelta), unitCostCents: Number(r.unitCostCents),
    accountId: r.accountId == null ? null : Number(r.accountId), paidPersonally: !!Number(r.paidPersonally), occurredAt: r.occurredAt, receiptKey: r.receiptKey || "", createdAt: r.createdAt });
  const expenseOf = (r) => r ? { id: Number(r.id), description: r.description, amountCents: Number(r.amountCents), accountId: r.accountId == null ? null : Number(r.accountId),
    paidPersonally: !!Number(r.paidPersonally), date: r.expenseDate, receiptKey: r.receiptKey || "" } : null;
  const drawOf = (r) => r ? { id: Number(r.id), note: r.note || "", amountCents: Number(r.amountCents), accountId: r.accountId == null ? null : Number(r.accountId), date: r.txDate, receiptKey: r.receiptKey || "" } : null;
  let stock, expense = null, draw = null, via;
  if (seed.receiptGroup) {
    via = "group";
    stock = (await db.prepare(`SELECT * FROM ${table} WHERE receiptGroup = ? AND kind = 'purchase' AND voidedAt IS NULL ORDER BY id`).bind(seed.receiptGroup).all()).results.map(stockOf);
    expense = expenseOf(await db.prepare("SELECT * FROM expenses WHERE receiptGroup = ? AND deletedAt IS NULL ORDER BY id LIMIT 1").bind(seed.receiptGroup).first());
    draw = drawOf(await db.prepare("SELECT * FROM owner_transactions WHERE receiptGroup = ? AND deletedAt IS NULL ORDER BY id LIMIT 1").bind(seed.receiptGroup).first());
  } else {
    via = "match";
    // Same day, vendor, invoice, payer and receipt file, written in one run (each row within 10 s of the next).
    const { results } = await db.prepare(`SELECT * FROM ${table} WHERE kind = 'purchase' AND voidedAt IS NULL AND receiptGroup IS NULL
        AND substr(occurredAt, 1, 10) = substr(?, 1, 10) AND vendor = ? AND vendorRef = ? AND accountId IS ? AND paidPersonally = ? AND receiptKey = ? ORDER BY createdAt, id`)
      .bind(seed.occurredAt, seed.vendor || "", seed.vendorRef || "", seed.accountId ?? null, Number(seed.paidPersonally) || 0, seed.receiptKey || "").all();
    const at = (r) => Date.parse(r.createdAt) || 0;
    const clusters = []; let cur = null;
    for (const r of results) { if (!cur || at(r) - cur.last > RECEIPT_CLUSTER_GAP_MS_) clusters.push(cur = { rows: [], last: 0 }); cur.rows.push(r); cur.last = at(r); }
    const mine = clusters.find(c => c.rows.some(r => Number(r.id) === Number(seed.id))) || { rows: [seed] };
    stock = mine.rows.map(stockOf);
    const lo = Math.min(...mine.rows.map(at)) - 30000, hi = Math.max(...mine.rows.map(at)) + 30000;
    const near = (r) => { const t = Date.parse(r.createdAt) || 0; return t >= lo && t <= hi; };
    const day = String(seed.occurredAt).slice(0, 10);
    const exp = (await db.prepare(`SELECT * FROM expenses WHERE deletedAt IS NULL AND receiptGroup IS NULL AND expenseDate = ? AND vendor = ? AND description LIKE ? AND accountId IS ? AND paidPersonally = ? ORDER BY id`)
      .bind(day, seed.vendor || "", RECEIPT_EXTRA_PREFIX_[kind] + "%", seed.accountId ?? null, Number(seed.paidPersonally) || 0).all()).results.filter(near);
    expense = expenseOf(exp[0]);
    if (!Number(seed.paidPersonally)) {
      const dr = (await db.prepare(`SELECT * FROM owner_transactions WHERE deletedAt IS NULL AND receiptGroup IS NULL AND txDate = ? AND kind = 'draw' AND note LIKE 'Personal items —%' AND accountId IS ? ORDER BY id`)
        .bind(day, seed.accountId ?? null).all()).results.filter(near);
      draw = drawOf(dr[0]);
    }
  }
  return { kind, via, group: seed.receiptGroup || "", stock, expense, draw, vendor: seed.vendor || "", vendorRef: seed.vendorRef || "", date: String(seed.occurredAt).slice(0, 10),
    accountId: seed.accountId == null ? null : Number(seed.accountId), paidPersonally: !!Number(seed.paidPersonally), receiptKey: seed.receiptKey || "", receiptName: seed.receiptName || "" };
}

// The records a receipt file belongs on, as [{table, id}]: just the one row for most kinds of money movement, but
// the WHOLE receive (every stock row, its expense and its draw) for a blank / transfer-sheet purchase — the
// vendor's receipt covers all of it, and a Receive order attaches it to all of it. null if not found / not live.
export async function receiptTargets(db, src, srcId) {
  const meta = RECEIPT_TABLES_[src];
  if (!meta) return null;
  const row = await db.prepare(`SELECT id FROM ${meta.table} WHERE id = ? AND ${meta.live}`).bind(Number(srcId)).first();
  if (!row) return null;
  if (src === "blanks" || src === "transfer_sheet") {
    const rec = await getReceiptRecords(db, src === "blanks" ? "blanks" : "transfers", srcId);
    if (rec) return [...rec.stock.map(s => ({ table: meta.table, id: s.id })), ...(rec.expense ? [{ table: "expenses", id: rec.expense.id }] : []),
      ...(rec.draw ? [{ table: "owner_transactions", id: rec.draw.id }] : [])];
  }
  return [{ table: meta.table, id: Number(srcId) }];
}
export async function getRecordReceipt(db, src, srcId) {
  const meta = RECEIPT_TABLES_[src];
  const r = meta ? await db.prepare(`SELECT receiptKey, receiptName FROM ${meta.table} WHERE id = ? AND ${meta.live}`).bind(Number(srcId)).first() : null;
  return r ? { key: r.receiptKey || "", name: r.receiptName || "" } : null;
}
// Sets (or clears, with key "") the receipt on those records in one batch. Changes no amounts.
export async function setReceiptFile(db, targets, key, name) {
  const ALLOWED = new Set(Object.values(RECEIPT_TABLES_).map(t => t.table));
  await db.batch(targets.filter(t => ALLOWED.has(t.table)).map(t =>
    db.prepare(`UPDATE ${t.table} SET receiptKey = ?, receiptName = ? WHERE id = ?`).bind(String(key || "").slice(0, 300), String(name || "").slice(0, 200), Number(t.id))));
}

// What stands in the way of moving a receipt to another paying account, as plain sentences ([] = nothing).
// `target` is {accountId, paidPersonally} or null (only the target-independent checks run). Closed tax months are
// checked by the caller's periodGuard.
export async function receiptAccountBlockers(db, rec, target) {
  const out = [];
  const matched = async (src, ids) => {
    if (!ids.length) return 0;
    return Number((await db.prepare(`SELECT count(*) n FROM statement_matches WHERE src = ? AND srcId IN (${ids.map(() => "?").join(",")})`).bind(src, ...ids).first()).n || 0);
  };
  const n = await matched(rec.kind === "transfers" ? "transfer_sheet" : "blanks", rec.stock.map(s => s.id))
    + await matched("expense", rec.expense ? [rec.expense.id] : []) + await matched("owner", rec.draw ? [rec.draw.id] : []);
  if (n) out.push("Part of this receipt is matched to a bank-statement line. Unmatch it on Reconcile first, then change the account.");
  const month = String(rec.date).slice(0, 7);
  const old = [...new Set([...rec.stock.map(s => s.accountId), rec.expense && rec.expense.accountId, rec.draw && rec.draw.accountId].filter(x => x != null))];
  for (const a of old) if (await isReconciled(db, a, month)) { out.push(`${month} is reconciled for the account it was paid from — reopen that month on Reconcile first.`); break; }
  if (target && target.accountId && await isReconciled(db, target.accountId, month)) out.push(`${month} is reconciled for the account you chose — reopen that month on Reconcile first.`);
  if (target && target.paidPersonally && rec.draw) out.push("This receipt has a “Personal items” owner draw. Paid with personal funds that part isn't a business transaction at all — delete the draw first, then choose Personal funds.");
  return out;
}

// Moves EVERY record of one receipt to the same paying account (or to Personal funds) in one batch: its stock rows,
// its R&D / written-off expense and its personal-use owner draw. `rec` is from getReceiptRecords. Stock, cost and
// COGS don't change — only where the money came from. The caller has already checked the blockers.
export async function setReceiptAccount(db, rec, target) {
  const table = rec.kind === "transfers" ? "transfer_movements" : "inventory_movements";
  const acct = target.paidPersonally ? null : Number(target.accountId), pers = target.paidPersonally ? 1 : 0, now = new Date().toISOString();
  const stmts = rec.stock.map(s => db.prepare(`UPDATE ${table} SET accountId = ?, paidPersonally = ? WHERE id = ? AND voidedAt IS NULL`).bind(acct, pers, s.id));
  if (rec.expense) stmts.push(db.prepare("UPDATE expenses SET accountId = ?, paidPersonally = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL").bind(acct, pers, now, rec.expense.id));
  if (rec.draw && acct) stmts.push(db.prepare("UPDATE owner_transactions SET accountId = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL").bind(acct, now, rec.draw.id));
  await db.batch(stmts);
}

// ---- Statement import & reconciliation (migrations/0015) ---------------------
// Long digit runs (card / account numbers) in statement descriptions are
// masked before storage: "…4412", never the full number.
export function maskStatementDescription(desc) {
  return String(desc || "").replace(/\d[\d -]{6,}\d/g, m => { const d = m.replace(/\D/g, ""); return d.length >= 8 ? "••••" + d.slice(-4) : m; })
    .replace(/\s+/g, " ").trim().slice(0, 200);
}
async function sha256Hex_(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}
// lines: [{date: YYYY-MM-DD, description, amountCents (signed, + = into the
// account)}], already validated. Identical lines on the same day are told
// apart by their order in the file, so re-importing the same (or an
// overlapping) statement inserts nothing new. Returns {inserted, duplicates}.
export async function importStatementLines(db, accountId, lines, batch) {
  const seen = {}, now = new Date().toISOString();
  const stmts = [];
  for (const l of lines) {
    const desc = maskStatementDescription(l.description);
    const key = `${l.date}|${l.amountCents}|${desc.toLowerCase()}`;
    const n = (seen[key] = (seen[key] || 0) + 1);
    const fp = await sha256Hex_(`${key}|${n}`);
    stmts.push(db.prepare(`INSERT OR IGNORE INTO statement_lines (accountId, lineDate, description, amountCents, fingerprint, importBatch, importedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(Number(accountId), l.date, desc, Math.round(l.amountCents), fp, batch || "", now));
  }
  let inserted = 0;
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await db.batch(stmts.slice(i, i + 50));
    for (const r of res) inserted += (r.meta && r.meta.changes) || 0;
  }
  return { inserted, duplicates: lines.length - inserted };
}

// An account's recorded money movements between two dates (YYYY-MM-DD,
// inclusive), each keyed "src:srcId" — the same sources as the balances.
export async function listMoneyMoves(db, accountId, dateFrom, dateTo) {
  const out = [];
  for (const sql of MONEY_MOVE_SOURCES) {
    const { results } = await db.prepare(`SELECT * FROM (${sql}) m WHERE m.accountId = ? AND m.d >= ? AND m.d <= ?`)
      .bind(Number(accountId), dateFrom, dateTo).all();
    for (const r of results) out.push({ key: `${r.src}:${r.srcId}`, src: r.src, srcId: Number(r.srcId), date: r.d, cents: Number(r.c), label: r.label || "" });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}
const addDays_ = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
export const monthBounds = (month) => {
  const [y, m] = month.split("-").map(Number);
  return { from: `${month}-01`, to: `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}` };
};

async function matchedKeys_(db, accountId) {
  const { results } = await db.prepare(`SELECT sm.src, sm.srcId, sm.lineId FROM statement_matches sm JOIN statement_lines sl ON sl.id = sm.lineId WHERE sl.accountId = ?`)
    .bind(Number(accountId)).all();
  return new Map(results.map(r => [`${r.src}:${r.srcId}`, Number(r.lineId)]));
}

// Auto-match a month's unmatched statement lines to unmatched recorded
// movements of the same amount within ±5 days (closest date wins). A Stripe
// charge can show on its statement as one net line, so a payment + its fee
// (same payment id) also count as one candidate. Returns how many matched.
export async function autoMatchStatement(db, accountId, month) {
  const { from, to } = monthBounds(month);
  const { results: lines } = await db.prepare(`SELECT sl.* FROM statement_lines sl WHERE sl.accountId = ? AND sl.lineDate >= ? AND sl.lineDate <= ?
      AND sl.ignoredAt IS NULL AND NOT EXISTS (SELECT 1 FROM statement_matches sm WHERE sm.lineId = sl.id) ORDER BY sl.lineDate, sl.id`)
    .bind(Number(accountId), from, to).all();
  if (!lines.length) return 0;
  const taken = await matchedKeys_(db, accountId);
  const moves = (await listMoneyMoves(db, accountId, addDays_(from, -7), addDays_(to, 7))).filter(m => !taken.has(m.key));
  const byKey = new Map(moves.map(m => [m.key, m]));
  const groups = moves.map(m => ({ keys: [m.key], cents: m.cents, date: m.date }));
  for (const m of moves) if (m.src === "payment" && byKey.has(`fee:${m.srcId}`)) {
    groups.push({ keys: [m.key, `fee:${m.srcId}`], cents: m.cents + byKey.get(`fee:${m.srcId}`).cents, date: m.date });
  }
  // A stock receipt is one charge on the statement (2026-10): every size of every blank on it, with its R&D /
  // personal part, as one candidate.
  for (const e of await combineReceipts_(db, moves)) if (e.keys.length > 1) groups.push({ keys: e.keys, cents: e.cents, date: e.date });
  const used = new Set();
  const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
  const stmts = [], now = new Date().toISOString();
  let matched = 0;
  for (const l of lines) {
    const best = groups.filter(g => g.cents === Number(l.amountCents) && g.keys.every(k => !used.has(k)) && days(g.date, l.lineDate) <= 5)
      .sort((a, b) => days(a.date, l.lineDate) - days(b.date, l.lineDate) || a.keys.length - b.keys.length)[0];
    if (!best) continue;
    for (const k of best.keys) {
      used.add(k);
      const [src, id] = k.split(":");
      stmts.push(db.prepare("INSERT OR IGNORE INTO statement_matches (lineId, src, srcId, matchedAt, auto) VALUES (?, ?, ?, ?, 1)").bind(l.id, src, Number(id), now));
    }
    matched++;
  }
  if (stmts.length) await db.batch(stmts);
  return matched;
}

export async function getStatementLine(db, id) {
  return await db.prepare("SELECT * FROM statement_lines WHERE id = ?").bind(Number(id)).first();
}
// Manual match: the chosen movements must be unmatched, in the line's
// account, and add up to exactly the line's amount.
export async function matchStatementLine(db, lineId, keys) {
  const line = await getStatementLine(db, lineId);
  if (!line) return { error: "Statement line not found" };
  const taken = await matchedKeys_(db, line.accountId);
  const moves = await listMoneyMoves(db, line.accountId, "0000-01-01", "9999-12-31");
  const byKey = new Map(moves.map(m => [m.key, m]));
  let sum = 0;
  for (const k of keys) {
    const m = byKey.get(k);
    if (!m) return { error: "One of the chosen items isn't in this account" };
    if (taken.has(k) && taken.get(k) !== Number(lineId)) return { error: "One of the chosen items is already matched to another line" };
    sum += m.cents;
  }
  if (sum !== Number(line.amountCents)) return { error: `The chosen items add up to ${(sum / 100).toFixed(2)}, not ${(line.amountCents / 100).toFixed(2)}` };
  const now = new Date().toISOString();
  await db.batch([db.prepare("DELETE FROM statement_matches WHERE lineId = ?").bind(Number(lineId)),
    ...keys.map(k => { const [src, id] = k.split(":"); return db.prepare("INSERT INTO statement_matches (lineId, src, srcId, matchedAt, auto) VALUES (?, ?, ?, ?, 0)").bind(Number(lineId), src, Number(id), now); })]);
  return { ok: true };
}
export async function unmatchStatementLine(db, lineId) {
  await db.prepare("DELETE FROM statement_matches WHERE lineId = ?").bind(Number(lineId)).run();
}
export async function setStatementLineIgnored(db, lineId, reason) {
  if (reason === null) await db.prepare("UPDATE statement_lines SET ignoredAt = NULL, ignoreReason = '' WHERE id = ?").bind(Number(lineId)).run();
  else await db.prepare("UPDATE statement_lines SET ignoredAt = ?, ignoreReason = ? WHERE id = ?").bind(new Date().toISOString(), String(reason).slice(0, 200), Number(lineId)).run();
}

// Everything the reconcile screen needs for one account-month. Book balance
// = opening + every recorded movement through month end. When every
// statement line (since the opening date) is matched or ignored, the
// statement's ending balance must equal: book balance − recorded items not
// yet on any statement (uncleared) + ignored statement lines. Dollars out.
export async function getReconciliationData(db, accountId, month) {
  const account = await db.prepare("SELECT * FROM accounts WHERE id = ?").bind(Number(accountId)).first();
  if (!account) return null;
  const { from, to } = monthBounds(month);
  const [allMoves, taken, { results: lines }, { results: matchRows }, rec, ign] = await Promise.all([
    listMoneyMoves(db, accountId, account.openingDate, addDays_(to, 10)),
    matchedKeys_(db, accountId),
    db.prepare("SELECT * FROM statement_lines WHERE accountId = ? AND lineDate >= ? AND lineDate <= ? ORDER BY lineDate, id").bind(Number(accountId), from, to).all(),
    db.prepare("SELECT sm.* FROM statement_matches sm JOIN statement_lines sl ON sl.id = sm.lineId WHERE sl.accountId = ? AND sl.lineDate >= ? AND sl.lineDate <= ?").bind(Number(accountId), from, to).all(),
    db.prepare("SELECT * FROM reconciliations WHERE accountId = ? AND month = ?").bind(Number(accountId), month).first(),
    db.prepare("SELECT COALESCE(SUM(amountCents), 0) c FROM statement_lines WHERE accountId = ? AND ignoredAt IS NOT NULL AND lineDate >= ? AND lineDate <= ?").bind(Number(accountId), account.openingDate, to).first(),
  ]);
  const moveByKey = new Map(allMoves.map(m => [m.key, m]));
  const matchesByLine = {};
  for (const r of matchRows) (matchesByLine[r.lineId] = matchesByLine[r.lineId] || []).push(`${r.src}:${r.srcId}`);
  // A stock receipt's records (a row per blank / size, its R&D / personal part) are one charge on the statement,
  // so each list shows them as ONE entry with `keys` (all its records) and `parts` (2026-10, combineReceipts_).
  const entry = (e) => ({ key: e.key, keys: e.keys, date: e.date, label: e.label, amount: fromCents(e.cents),
    parts: e.parts.map(p => ({ key: p.key, label: p.label, amount: fromCents(p.cents) })) });
  const outLines = [];
  for (const l of lines) {
    const keys = matchesByLine[l.id] || [];
    const items = keys.map(k => moveByKey.get(k)).filter(Boolean);
    const broken = keys.length > 0 && items.length !== keys.length;   // a matched item was since voided/deleted
    outLines.push({ id: Number(l.id), date: l.lineDate, description: l.description, amount: fromCents(l.amountCents),
      status: l.ignoredAt ? "ignored" : broken ? "broken" : items.length ? "matched" : "unmatched",
      ignoreReason: l.ignoreReason || "", matched: (await combineReceipts_(db, items)).map(entry) });
  }
  const through = allMoves.filter(m => m.date <= to);
  const bookCents = Number(account.openingBalanceCents) + through.reduce((a, m) => a + m.cents, 0);
  const uncleared = through.filter(m => !taken.has(m.key));
  const unclearedCents = uncleared.reduce((a, m) => a + m.cents, 0);
  const expectedStatementCents = bookCents - unclearedCents + Number(ign.c);
  return {
    account: { id: Number(account.id), name: account.name, type: account.type, openingDate: account.openingDate, csvMapping: account.csvMapping || "" },
    month, from, to, lines: outLines,
    unmatchedBook: (await combineReceipts_(db, uncleared.filter(m => m.date >= from))).map(entry),
    unclearedEarlier: (await combineReceipts_(db, uncleared.filter(m => m.date < from))).map(entry),
    candidates: (await combineReceipts_(db, allMoves.filter(m => !taken.has(m.key) && m.date >= addDays_(from, -10)))).map(entry),
    bookBalance: fromCents(bookCents), uncleared: fromCents(unclearedCents), ignored: fromCents(Number(ign.c)),
    expectedStatementBalance: fromCents(expectedStatementCents),
    reconciled: rec ? { statementBalance: fromCents(rec.statementEndingBalanceCents), bookBalance: fromCents(rec.bookBalanceCents), at: rec.reconciledAt, by: rec.reconciledBy } : null,
  };
}
export async function setReconciled(db, accountId, month, statementCents, bookCents, by) {
  await db.prepare(`INSERT OR REPLACE INTO reconciliations (accountId, month, statementEndingBalanceCents, bookBalanceCents, reconciledAt, reconciledBy)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(Number(accountId), month, Math.round(statementCents), Math.round(bookCents), new Date().toISOString(), by || "").run();
}
export async function clearReconciled(db, accountId, month) {
  await db.prepare("DELETE FROM reconciliations WHERE accountId = ? AND month = ?").bind(Number(accountId), month).run();
}
export async function isReconciled(db, accountId, month) {
  return !!(await db.prepare("SELECT 1 x FROM reconciliations WHERE accountId = ? AND month = ?").bind(Number(accountId), month).first());
}
export async function listReconciliations(db) {
  const { results } = await db.prepare(`SELECT r.*, a.name FROM reconciliations r JOIN accounts a ON a.id = r.accountId ORDER BY r.month, a.id`).all();
  return results.map(r => ({ account: r.name, month: r.month, statementBalance: fromCents(r.statementEndingBalanceCents),
    bookBalance: fromCents(r.bookBalanceCents), reconciledAt: r.reconciledAt, by: r.reconciledBy }));
}
export async function saveCsvMapping(db, accountId, mapping) {
  await db.prepare("UPDATE accounts SET csvMapping = ? WHERE id = ?").bind(JSON.stringify(mapping || {}).slice(0, 2000), Number(accountId)).run();
}

// ---- Failed admin sign-ins (reported in the daily roll-up) --------------------
// Counted at /api/admin-session (wrong passphrase / wrong 2FA code) in
// global_settings key "failedAdminLogins": {count, passphrase, code, ips[<=10],
// first, last}. Cleared once a roll-up reporting them is sent.
export async function recordFailedAdminLogin(db, reason, ip) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='failedAdminLogins'").first();
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch (_) {}
  const now = new Date().toISOString();
  v.count = (Number(v.count) || 0) + 1;
  v[reason === "code" ? "code" : "passphrase"] = (Number(v[reason === "code" ? "code" : "passphrase"]) || 0) + 1;
  v.ips = Array.isArray(v.ips) ? v.ips : [];
  if (ip && !v.ips.includes(ip) && v.ips.length < 10) v.ips.push(String(ip).slice(0, 45));
  v.first = v.first || now; v.last = now;
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('failedAdminLogins', ?)").bind(JSON.stringify(v)).run();
}
export async function getFailedAdminLogins(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='failedAdminLogins'").first();
  try { const v = row ? JSON.parse(row.value) : null; return v && v.count > 0 ? v : null; } catch (_) { return null; }
}
export async function clearFailedAdminLogins(db) {
  await db.prepare("DELETE FROM global_settings WHERE key='failedAdminLogins'").run();
}

// ---- System problems for the 6 AM roll-up ---------------------------------------------------
// Failures that would otherwise show up only in the Worker's log: an email that couldn't be sent,
// a Stripe webhook whose update failed (Stripe retries it), a roll-up run that didn't complete.
// Kept like failedAdminLogins — one small global_settings value, no table — and reported in the
// next roll-up (a reason to send one), then cleared.
// {kinds: {<kind>: {count, first, last, samples[<=5]}}}
export const SYSTEM_ISSUE_LABELS = {
  email_failed: "Emails that couldn't be sent at all",
  webhook_failed: "Stripe webhook updates that failed (Stripe retries these)",
  digest_failed: "Daily roll-ups that did not complete (the scheduled run will try again tomorrow)",
};
export async function recordSystemIssue(db, kind, sample) {
  if (!db || typeof db.prepare !== "function") return;
  try {
    const row = await db.prepare("SELECT value FROM global_settings WHERE key='systemIssues'").first();
    let v = {};
    try { v = row ? JSON.parse(row.value) : {}; } catch (_) {}
    v.kinds = v.kinds || {};
    const now = new Date().toISOString();
    const k = (v.kinds[kind] = v.kinds[kind] || { count: 0, first: now, samples: [] });
    k.count++; k.last = now;
    if (sample && k.samples.length < 5) k.samples.push(String(sample).slice(0, 200));
    await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('systemIssues', ?)").bind(JSON.stringify(v)).run();
  } catch (e) { console.error("Could not record system issue", kind, e); }
}
export async function getSystemIssues(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='systemIssues'").first();
  try {
    const v = row ? JSON.parse(row.value) : null;
    const kinds = (v && v.kinds) || {};
    const list = Object.entries(kinds).filter(([, k]) => k && k.count > 0)
      .map(([kind, k]) => ({ kind, label: SYSTEM_ISSUE_LABELS[kind] || kind, count: k.count, first: k.first, last: k.last, samples: k.samples || [] }));
    return list.length ? list : null;
  } catch (_) { return null; }
}
export async function clearSystemIssues(db) {
  await db.prepare("DELETE FROM global_settings WHERE key='systemIssues'").run();
}

// ---- Daily order roll-up (owner digest) -------------------------------------
// Owner notices (Stripe payments/refunds/disputes, design responses) wait in
// owner_notices until the next roll-up lists them (migrations/0011).
export async function addOwnerNotice(db, { kind, orderId, orgId, summary, detail, imageUrls, urgent }) {
  await db.prepare(
    `INSERT INTO owner_notices (kind, orderId, orgId, summary, detail, imageUrls, urgent, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(kind, orderId || "", orgId || "", String(summary || "").slice(0, 500), String(detail || "").slice(0, 4000),
    JSON.stringify((imageUrls || []).filter(Boolean).slice(0, 10)), urgent ? 1 : 0, new Date().toISOString()).run();
}
export async function getUnsentOwnerNotices(db) {
  const { results } = await db.prepare("SELECT * FROM owner_notices WHERE sentAt IS NULL ORDER BY id LIMIT 500").all();
  return results.map(r => ({ id: Number(r.id), kind: r.kind, orderId: r.orderId, orgId: r.orgId, summary: r.summary,
    detail: r.detail, imageUrls: (() => { try { return JSON.parse(r.imageUrls); } catch (_) { return []; } })(),
    urgent: !!r.urgent, createdAt: r.createdAt }));
}
export async function markOwnerNoticesSent(db, ids) {
  if (!ids.length) return;
  const at = new Date().toISOString();
  await db.batch(ids.map(id => db.prepare("UPDATE owner_notices SET sentAt = ? WHERE id = ? AND sentAt IS NULL").bind(at, id)));
}

// Progress is the newest order already reported, by when it was WRITTEN (orders.insertedAt,
// migrations/0031) — so a backdated order date can't make an order be skipped or sent twice, and
// a VACUUM or table rebuild can't renumber it the way an implicit-rowid cursor could. Stored in global_settings as {"afterInsertedAt": ISO, "afterOrderId": id, "sentAt": ISO}
// (before migrations/0031: {"afterRowid": N, "sentAt": ISO} — see getOrdersForDigest).
export async function getDigestState(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='dailyDigest'").first();
  try { return row ? JSON.parse(row.value) : null; } catch (_) { return null; }
}
export async function setDigestState(db, state) {
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('dailyDigest', ?)").bind(JSON.stringify(state)).run();
}
// The last time the roll-up RAN, whatever it found — {at, trigger, ok, sent, orders, notices, delivered,
// message}. Kept apart from `dailyDigest` (the cursor, which only moves when an email goes out): a run
// that finds nothing sends nothing, and without this record "no email" couldn't be told from
// "it never ran". Communications shows it.
export async function getDigestRun(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='dailyDigestRun'").first();
  try { return row ? JSON.parse(row.value) : null; } catch (_) { return null; }
}
export async function setDigestRun(db, run) {
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('dailyDigestRun', ?)").bind(JSON.stringify(run)).run();
}
// Real orders not yet reported (test and voided orders are skipped), full detail, plus `cursor` —
// the fields to save as the new state once the email has gone out.
//
// "Not yet reported" = written after the cursor {afterInsertedAt, afterOrderId} (migrations/0031:
// orders.insertedAt, set by a trigger on insert). insertedAt, not placedAt: a backdated order (a local
// sale entered later) is still new to the owner. The cursor passes over test/voided orders too, so
// they're never reconsidered. First run (no state): the last 24 hours by placedAt.
// Switch-over: a state saved before 0031 holds {afterRowid}; that one run still uses rowid (so
// nothing is skipped or repeated), then the cursor jumps to the newest order.
// Before 0031 is applied (no insertedAt column), the rowid logic runs and saves {afterRowid}.
export async function getOrdersForDigest(db, state, now = new Date()) {
  const real = (r) => !Number(r.isTest) && !r.voidedAt;
  const load = async (ids) => ids.length
    ? loadOrders_(db, "o.orderId IN (SELECT value FROM json_each(?))", [JSON.stringify(ids)], "o.placedAt ASC")
    : [];
  let newest;
  try {
    newest = await db.prepare("SELECT insertedAt, orderId FROM orders WHERE insertedAt IS NOT NULL ORDER BY insertedAt DESC, orderId DESC LIMIT 1").first();
  } catch (e) {
    if (!/no such column/i.test(String(e && e.message))) throw e;
    return getOrdersForDigestByRowid_(db, state, now, load, real);
  }
  const atNewest = newest ? { afterInsertedAt: newest.insertedAt, afterOrderId: newest.orderId } : { afterInsertedAt: "", afterOrderId: "" };

  if (state && typeof state.afterInsertedAt === "string") {
    const { results } = await db.prepare(
      `SELECT orderId, insertedAt, isTest, voidedAt FROM orders
        WHERE insertedAt > ? OR (insertedAt = ? AND orderId > ?)
        ORDER BY insertedAt, orderId`).bind(state.afterInsertedAt, state.afterInsertedAt, String(state.afterOrderId || "")).all();
    const last = results[results.length - 1];
    const cursor = last ? { afterInsertedAt: last.insertedAt, afterOrderId: last.orderId }
                        : { afterInsertedAt: state.afterInsertedAt, afterOrderId: String(state.afterOrderId || "") };
    return { orders: await load(results.filter(real).map(r => r.orderId)), cursor };
  }
  if (state && Number.isFinite(Number(state.afterRowid))) {
    const old = await getOrdersForDigestByRowid_(db, state, now, load, real);
    return { orders: old.orders, cursor: atNewest };
  }
  const { results } = await db.prepare("SELECT orderId, isTest, voidedAt FROM orders WHERE placedAt >= ?")
    .bind(new Date(now.getTime() - 24 * 3600 * 1000).toISOString()).all();
  return { orders: await load(results.filter(real).map(r => r.orderId)), cursor: atNewest };
}

// The pre-0031 cursor (implicit rowid): used before the migration, and once for the switch-over.
async function getOrdersForDigestByRowid_(db, state, now, load, real) {
  const maxRow = await db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM orders").first();
  const throughRowid = Number(maxRow.m) || 0;
  const { results } = state && Number.isFinite(Number(state.afterRowid))
    ? await db.prepare("SELECT orderId, isTest, voidedAt FROM orders WHERE rowid > ? AND rowid <= ? ORDER BY rowid")
        .bind(Number(state.afterRowid), throughRowid).all()
    : await db.prepare("SELECT orderId, isTest, voidedAt FROM orders WHERE placedAt >= ? AND rowid <= ? ORDER BY rowid")
        .bind(new Date(now.getTime() - 24 * 3600 * 1000).toISOString(), throughRowid).all();
  return { orders: await load(results.filter(real).map(r => r.orderId)), cursor: { afterRowid: throughRowid } };
}

// Moves a (non-Stripe) ledger entry to another account, e.g. a check that was
// deposited somewhere other than the method's default.
export async function setPaymentAccount(db, id, accountId) {
  await db.prepare("UPDATE order_payments SET accountId = ? WHERE id = ?").bind(Number(accountId), Number(id)).run();
}

// Corrects when a ledger entry's money actually arrived (entries recorded
// late, or imported, carry the date they were typed in). Keeps the order's
// paidAt in step: a paid order is paid as of its latest payment.
export async function setPaymentDate(db, id, receivedAt) {
  const row = await db.prepare("SELECT orderId FROM order_payments WHERE id=?").bind(Number(id)).first();
  if (!row) return null;
  await db.prepare("UPDATE order_payments SET receivedAt = ? WHERE id = ?").bind(receivedAt, Number(id)).run();
  await db.prepare(`UPDATE orders SET paidAt = (SELECT MAX(receivedAt) FROM order_payments
      WHERE orderId = orders.orderId AND kind = 'payment' AND voidedAt IS NULL)
    WHERE orderId = ? AND paid = 1`).bind(row.orderId).run();
  return row.orderId;
}

// Card payments linked to a Stripe PaymentIntent (for syncing their dates).
export async function getStripeLinkedPayments(db) {
  const { results } = await db.prepare(
    `SELECT id, orderId, receivedAt, externalRef, feeCents FROM order_payments
     WHERE method = 'card' AND kind = 'payment' AND voidedAt IS NULL AND externalRef LIKE 'pi_%' ORDER BY receivedAt`
  ).all();
  return results.map(r => ({ id: Number(r.id), orderId: r.orderId, receivedAt: r.receivedAt, externalRef: r.externalRef, feeCents: Number(r.feeCents) }));
}

// Stripe card payments that don't have their processing fee recorded yet
// (for the one-time backfill admin action).
export async function getCardPaymentsMissingFees(db) {
  const { results } = await db.prepare(
    `SELECT p.id, p.orderId, p.amountCents, p.externalRef, p.receivedAt FROM order_payments p
     WHERE p.method = 'card' AND p.kind = 'payment' AND p.feeCents = 0 AND p.voidedAt IS NULL
       AND p.note NOT LIKE 'Local sale%'   -- an in-person card sale has no Checkout Session to look up; its fee comes from the payout (Deposit → Stripe payout)
     ORDER BY p.receivedAt`
  ).all();
  return results.map(r => ({ id: Number(r.id), orderId: r.orderId, amount: fromCents(r.amountCents), externalRef: r.externalRef || "", receivedAt: r.receivedAt }));
}

// Card payments recorded by the Stripe webhook whose fee is still 0 (Stripe often hasn't created the
// charge's balance transaction yet when the webhook fires). Used by the background follow-up and the
// daily safety net in functions/_lib/stripeFees.js.
export async function getRecentCardPaymentsMissingFee(db, sinceIso, limit = 20) {
  const { results } = await db.prepare(
    `SELECT id, externalRef FROM order_payments
     WHERE method = 'card' AND kind = 'payment' AND feeCents = 0 AND voidedAt IS NULL
       AND externalRef LIKE 'pi_%' AND note NOT LIKE 'Local sale%' AND receivedAt >= ?
     ORDER BY receivedAt DESC LIMIT ?`
  ).bind(sinceIso, limit).all();
  return results.map(r => ({ id: Number(r.id), externalRef: r.externalRef }));
}

// Sets the fee on the card payment for a PaymentIntent, only while it is still 0. Returns rows changed.
export async function setCardFeeByRef(db, externalRef, feeCents) {
  const r = await db.prepare(
    "UPDATE order_payments SET feeCents = ? WHERE externalRef = ? AND method = 'card' AND kind = 'payment' AND feeCents = 0"
  ).bind(Math.max(0, Math.round(Number(feeCents) || 0)), externalRef).run();
  return (r.meta && r.meta.changes) || 0;
}

export async function setPaymentFee(db, paymentId, feeCents, externalRef) {
  await db.prepare(
    "UPDATE order_payments SET feeCents = ?, externalRef = CASE WHEN externalRef = '' THEN ? ELSE externalRef END WHERE id = ?"
  ).bind(Math.max(0, Math.round(Number(feeCents) || 0)), externalRef || "", Number(paymentId)).run();
}

// ---- Internal helpers --------------------------------------------------

function parsePayment_(row) {
  return {
    id: Number(row.id),
    orderId: row.orderId,
    amount: fromCents(row.amountCents),          // negative for refunds / lost disputes
    note: row.note || "",
    method: row.method || "other",
    reference: row.reference || "",
    fee: fromCents(row.feeCents),                // kept by the processor (Stripe)
    kind: row.kind || "payment",
    voidedAt: row.voidedAt || "",                // voided entries are excluded from every total
    voidReason: row.voidReason || "",
    receivedAt: row.receivedAt || "",
    fromStripe: /^(pi_|re_|dp_|cs_)/.test(row.externalRef || ""), // real Stripe movement: refund in Stripe, don't void
    accountId: row.accountId == null ? null : Number(row.accountId),
    shipping: fromCents(row.shippingCents || 0),  // refunds: how much of it was shipping (untaxed, 0035)
  };
}

// Per-line-item blank progress for the Orders table (migrations/0039). Counts active (not cancelled)
// lines at each blank stage; blankShippedAt is derived (no order column) and set only when every
// active line has shipped, mirroring how recomputeOrderBlankStatus_ sets the order-level ordered/
// received summaries. blankCounts drives the "N/T" partial-progress labels in the admin cells.
function blankProgress_(items) {
  const active = (items || []).filter(it => !it.cancelDate && !it.noBlank);   // lines that use a blank
  const total = active.length;
  const ordered = active.filter(it => it.blankOrderedAt).length;
  const shipped = active.filter(it => it.blankShippedAt).length;
  const received = active.filter(it => it.blankReceivedAt).length;
  // The latest ship date across active lines, surfaced only when they've all shipped.
  const allShipped = total > 0 && shipped === total;
  const blankShippedAt = allShipped
    ? active.reduce((m, it) => (it.blankShippedAt > m ? it.blankShippedAt : m), "")
    : "";
  return { blankShippedAt, blankCounts: { ordered, shipped, received, total } };
}

function parseOrder_(row, items, payments, labels) {
  payments = payments || [];
  const live = payments.filter(p => !p.voidedAt);
  // All arithmetic in integer cents, converted to dollars only on the way out.
  // "Received" = actual payments; refunds / lost disputes are tracked apart.
  const receivedCents = live.filter(p => (p.kind || "payment") === "payment").reduce((s, p) => s + toCents(p.amount), 0);
  const refundedCents = -live.filter(p => p.kind === "refund" || p.kind === "dispute").reduce((s, p) => s + toCents(p.amount), 0);
  const feesCents = live.reduce((s, p) => s + toCents(p.fee || 0), 0);
  const discountCents = Number(row.discountCents) || 0;
  const shippingCents = Number(row.shippingCostCents) || 0;
  // Derive from items (same formula as the top-bar grandTotal) — row.subtotal and
  // row.total can be stale when items are cancelled or shipping is added post-placement.
  const activeItems = items.filter(it => !it.cancelDate);
  const activeItemsCents = activeItems.reduce((s, it) => s + toCents(it.lineTotal), 0);
  // Tax included in what's owed for goods: active lines' tax, less the tax
  // portion of any discount. Shipping is not taxed.
  const itemsTaxCents = activeItems.reduce((s, it) => s + toCents(it.tax), 0);
  const taxMode = taxMode_(row.taxMode);
  // parseItem_ doesn't know the order's mode: with tax on top, a line's net is its listed total.
  if (taxMode === "exclusive") for (const it of items) { it.netAmount = it.lineTotal; it.taxIncluded = false; }
  const amounts = orderAmounts({ itemsCents: activeItemsCents, itemsTaxCents, shippingCents, discountCents, discountTaxCents: row.discountTaxCents, taxMode });
  const salesTaxCents = amounts.taxCents, netSalesCents = amounts.netSalesCents, effectiveCents = amounts.owedCents;
  const amountReceived = fromCents(receivedCents);
  const discountAmount = fromCents(discountCents);
  const shippingCost = fromCents(shippingCents);
  const shippingPaidAmount = fromCents(row.shippingPaidCents);
  const activeItemsTotal = fromCents(activeItemsCents);
  const effectiveTotal = fromCents(effectiveCents);
  const balanceDue = fromCents(Math.max(0, effectiveCents - receivedCents));
  return {
    orderId: row.orderId,
    orgId: row.orgId,
    customerName: row.customerName,
    contact: row.contact,
    paymentMethod: row.paymentMethod || "",
    paid: !!row.paid,
    paidAt: row.paidAt || "",
    refundedAt: row.refundedAt || "",
    disputeStatus: row.disputeStatus || "",
    subtotal: fromCents(row.subtotalCents),
    itemsSubtotal: activeItemsTotal,
    shippingCost,
    shippingPaidAmount,
    discountAmount,
    discountNote: row.discountNote || "",
    taxExempt: !!row.taxExempt,
    voidedAt: row.voidedAt || "",
    voidReason: row.voidReason || "",
    isTest: !!row.isTest,
    taxRate: (Number(row.taxRateBps) || 0) / 100,
    taxMode,                              // "inclusive": salesTax is inside the item prices; "exclusive": added on top
    salesTax: fromCents(salesTaxCents),
    netSales: fromCents(netSalesCents),   // goods revenue excluding tax and shipping
    total: fromCents(row.totalCents),
    effectiveTotal,
    amountReceived,
    refundedAmount: fromCents(refundedCents),            // refunds + lost disputes (positive)
    netReceived: fromCents(receivedCents - refundedCents),
    processorFees: fromCents(feesCents),
    labels: labels || [],
    labelCost: fromCents((labels || []).filter(l => !l.voidedAt).reduce((s, l) => s + toCents(l.amount), 0)),
    balanceDue,
    payments,
    shippingMethod: row.shippingMethod || "",
    shippingAddress: row.shippingAddress ? tryParse_(row.shippingAddress, null) : null,
    totalWeightOz: Number(row.totalWeightOz) || 0,
    parcelLength: Number(row.parcelLength) || 0,
    parcelWidth:  Number(row.parcelWidth)  || 0,
    parcelHeight: Number(row.parcelHeight) || 0,
    trackingNumber: row.trackingNumber || "",
    receivedEmailAt: row.receivedEmailAt || "",
    confirmedEmailAt: row.confirmedEmailAt || "",
    blankOrderedAt: row.blankOrderedAt || "",
    blankVendor: row.blankVendor || "",
    blankVendorOrderId: row.blankVendorOrderId || "",
    blankEstDelivery: row.blankEstDelivery || "",
    blankReceivedAt: row.blankReceivedAt || "",
    // Per-line-item progress for the Orders table's blank cells (migrations/0039). The order-level
    // columns above are all-or-nothing summaries; these show partial progress (e.g. "2/5 shipped"),
    // and blankShippedAt has no order column at all, so it's derived here (set only when every
    // active line has shipped).
    ...blankProgress_(items),
    // false when every active line's product is made with no blank (migrations/0057): the order has
    // no blank steps at all, and Mark manufactured doesn't wait for one.
    needsBlanks: !(items || []).some(it => !it.cancelDate) || (items || []).some(it => !it.cancelDate && !it.noBlank),
    // Every active line is filled from the shop's finished stock (migrations/0060): "made" = pulled from stock.
    allFromStock: (items || []).some(it => !it.cancelDate) && (items || []).filter(it => !it.cancelDate).every(it => it.fromStock),
    blankCondition: row.blankCondition || "",
    manufacturedAt: row.manufacturedAt || "",
    digitizingCompleteAt: row.digitizingCompleteAt || "",
    designApprovedAt: row.designApprovedAt || "",
    // false only when the loader computed it and no active line has free-form personalization;
    // a loader that didn't select it keeps the default (approval required).
    needsDesignApproval: row.needsDesignApproval == null ? true : !!row.needsDesignApproval,
    needsDigitizing: row.needsDigitizing == null ? true : !!row.needsDigitizing,  // false: every product has a design
    // Typed-in-personalization lines still waiting for their order-specific design upload (0032).
    orderDesignsMissing: Number(row.orderDesignsMissing) || 0,
    qaPackedAt: row.qaPackedAt || "",
    shippedAt: row.shippedAt || "",
    deliveredAt: row.deliveredAt || "",
    completedAt: row.completedAt || "",
    placedAt: row.placedAt || "",
    dueDate: row.dueDate || "",   // optional (migrations/0038); prioritizes the run queues
    items,
  };
}

function parseItem_(row) {
  return {
    id: row.id,
    orderId: row.orderId,
    productId: row.productId || "",
    // Its product is made with no blank (migrations/0057), or it's filled from finished stock (0060):
    // the blank steps don't apply to this line.
    noBlank: !!Number(row.noBlank),
    fromStock: !!Number(row.fromStock),   // filled from the shop's finished stock (migrations/0060)
    name: row.name,
    type: row.type,
    size: row.size || "",
    qty: Number(row.qty) || 1,
    unitPrice: fromCents(row.unitPriceCents),
    personalized: !!row.personalized,
    persName: row.persName || "",
    personalizationFee: fromCents(row.personalizationFeeCents),
    lineTotal: fromCents(row.lineTotalCents),
    taxRate: (Number(row.taxRateBps) || 0) / 100,          // percent, e.g. 6
    tax: fromCents(row.taxCents),                           // included in lineTotal — or on top of it (order.taxMode; parseOrder_ fixes netAmount)
    netAmount: fromCents((Number(row.lineTotalCents) || 0) - (Number(row.taxCents) || 0)),
    cogs: fromCentsOrNull(row.cogsCents),                    // blank cost; null = not yet known
    cogsSource: row.cogsSource || "",
    cancelDate: row.cancelDate || "",
    cancelReason: row.cancelReason || "",
    lateCancel: !!row.lateCancel,
    refundDate: row.refundDate || "",
    refundAmount: fromCentsOrNull(row.refundCents),
    blankCondition: row.blankCondition || "",
    blankConditionNote: row.blankConditionNote || "",
    // Per-line-item blank fulfillment (migrations/0039).
    blankOrderedAt: row.blankOrderedAt || "",
    blankShippedAt: row.blankShippedAt || "",
    blankReceivedAt: row.blankReceivedAt || "",
    blankVendor: row.blankVendor || "",
    blankVendorOrderId: row.blankVendorOrderId || "",
    blankEstDelivery: row.blankEstDelivery || "",
    // Configurable line snapshot + transfer-received gate (migrations/0036).
    config: tryParse_(row.configJson, null),
    transferReceivedAt: row.transferReceivedAt || "",
    // sheetRow: the name admin.js knows a line item's id by (item.sheetRow)
    sheetRow: row.id,
  };
}

// ---- Finished stock (migrations/0060) ---------------------------------------------------------------
// Blanks already decorated for a shop's product, on hand to sell: ready_to_ship (shop + product + size →
// quantity, avgCostCents), with every change a finished_goods_movements row — the same shape as blanks
// (inventory_movements → blank_sizes). How pieces get there and leave:
//   make    Make for stock: N blanks leave blank inventory at their average cost (a consume row with
//           reason 'finished' — NOT cost of goods) and N finished pieces arrive at that cost.
//   opening the counts entered before this was tracked (the migration), at the linked blank's cost.
//   adjust  a count correction (Stock window → Correct count).
//   sell    an order line filled from stock is PULLED when the order is made — that's the cost of goods.
//   return  a pulled piece put back (its line cancelled / order voided before it shipped).
// A storefront (or local) order line for an in-stock product + size is filled from stock when it's
// placed (order_items.fromStock); until it's pulled its pieces are SET ASIDE — worked out when read, so a
// cancel or void releases them with nothing to write. The shop's "N in stock" badge shows what's left.
// Configurable products (color / graphic pickers) aren't stocked in this version: a finished piece would
// be one color + graphics combination, and the storefront shows no stock badge for them.

// The size finished stock is kept under: '' for a flat-priced product (whose order lines say "OSFA").
function stockSize_(pricingMode, size) { return pricingMode === "flat" ? "" : String(size || ""); }
// Pieces SET ASIDE per "orgId|productId|stockSize": still to pull on active lines filled from stock.
async function finishedSetAside_(db, orgId) {
  if (!(await hasFromStockColumn_(db))) return {};
  const { results } = await db.prepare(
    `SELECT oi.orgId, oi.productId, CASE WHEN p.pricingMode = 'flat' THEN '' ELSE oi.size END AS size,
            SUM(oi.qty - COALESCE(oi.manufacturedQty, 0)) AS n, group_concat(DISTINCT oi.orderId) AS orderIds
     FROM order_items oi JOIN orders o ON o.orderId = oi.orderId
     LEFT JOIN products p ON p.orgId = oi.orgId AND p.productId = oi.productId
     WHERE oi.fromStock = 1 AND oi.cancelDate IS NULL AND o.voidedAt IS NULL AND COALESCE(oi.manufacturedQty, 0) < oi.qty
       ${orgId ? "AND oi.orgId = ?" : ""}
     GROUP BY oi.orgId, oi.productId, 3`).bind(...(orgId ? [orgId] : [])).all();
  const out = {};
  for (const r of results) out[[r.orgId, r.productId, r.size].join("|")] = { n: Number(r.n) || 0, orderIds: String(r.orderIds || "").split(",").filter(Boolean) };
  return out;
}
// SQL (with its binds) for the pieces set aside on one product + stock size — used inside the guarded
// statements, so it's evaluated at the moment the statement runs.
function setAsideSql_(orgId, productId, pricingMode, size) {
  return pricingMode === "flat"
    ? { sql: `COALESCE((SELECT SUM(x.qty - COALESCE(x.manufacturedQty, 0)) FROM order_items x JOIN orders xo ON xo.orderId = x.orderId
               WHERE x.fromStock = 1 AND x.cancelDate IS NULL AND xo.voidedAt IS NULL AND x.orgId = ? AND x.productId = ?), 0)`, binds: [orgId, productId] }
    : { sql: `COALESCE((SELECT SUM(x.qty - COALESCE(x.manufacturedQty, 0)) FROM order_items x JOIN orders xo ON xo.orderId = x.orderId
               WHERE x.fromStock = 1 AND x.cancelDate IS NULL AND xo.voidedAt IS NULL AND x.orgId = ? AND x.productId = ? AND x.size = ?), 0)`, binds: [orgId, productId, size] };
}
async function stockProduct_(db, orgId, productId) {
  return db.prepare("SELECT productId, name, pricingMode, configurable, noBlankNeeded FROM products WHERE orgId=? AND productId=?").bind(orgId, productId).first()
    .catch(() => db.prepare("SELECT productId, name, pricingMode FROM products WHERE orgId=? AND productId=?").bind(orgId, productId).first());
}
// The blank a product + stock size is made from (a flat product's link is under "OSFA", or '').
async function stockLink_(db, orgId, productId, pricingMode, size) {
  for (const sz of pricingMode === "flat" ? ["OSFA", ""] : [size]) {
    const l = await db.prepare(
      `SELECT l.blankId, l.blankColor, l.blankSize, b.name AS blankName, COALESCE(bs.quantity, 0) AS quantity, COALESCE(bs.purchasePriceCents, 0) AS avg
       FROM product_blank_links l LEFT JOIN blanks b ON b.id = l.blankId
       LEFT JOIN blank_sizes bs ON bs.blankId = l.blankId AND bs.color = l.blankColor AND bs.size = l.blankSize
       WHERE l.orgId = ? AND l.productId = ? AND l.productColor = '' AND l.productSize = ?`).bind(orgId, productId, sz).first();
    if (l && l.blankId != null) return l;
  }
  return null;
}

// What the storefront badge shows: AVAILABLE pieces (on hand less set aside), per product + size.
export async function getReadyToShipByOrg(db, orgId) {
  const { results } = await db.prepare(
    "SELECT productId, size, quantity FROM ready_to_ship WHERE orgId=? ORDER BY productId, size"
  ).bind(orgId).all();
  const held = await finishedSetAside_(db, orgId);
  return results.map(r => ({ productId: r.productId, size: r.size,
    quantity: Math.max(0, (Number(r.quantity) || 0) - ((held[[orgId, r.productId, r.size].join("|")] || {}).n || 0)) }));
}

// "Ready to decorate": per product + color + size, how many of its linked blank are FREE (on hand less
// set aside for orders, getBlankReservations — the same free Make for stock and Use from stock use). A
// blank shared by several products counts for each. {productId: {color: {size: n}}}; a plain product's
// color is '', a flat product's size is '' (as the storefront keys finished stock). Products made with no
// blank and blanks kept for testing are left out; only counts above 0 are returned.
export async function getBlankReadyByOrg(db, orgId) {
  const sql = noBlank => `SELECT l.productId, l.productColor, l.productSize, l.blankId, l.blankColor, l.blankSize,
      p.pricingMode, COALESCE(bs.quantity, 0) AS quantity
    FROM product_blank_links l JOIN products p ON p.orgId = l.orgId AND p.productId = l.productId
    JOIN blanks b ON b.id = l.blankId
    JOIN blank_sizes bs ON bs.blankId = l.blankId AND bs.color = l.blankColor AND bs.size = l.blankSize
    WHERE l.orgId = ? AND COALESCE(b.forTesting, 0) = 0${noBlank ? " AND COALESCE(p.noBlankNeeded, 0) = 0" : ""}`;
  let rows;
  try { ({ results: rows } = await db.prepare(sql(true)).bind(orgId).all()); }
  catch (e) { ({ results: rows } = await db.prepare(sql(false)).bind(orgId).all()); }
  const held = await getBlankReservations(db);
  const out = {};
  for (const r of rows) {
    const free = (Number(r.quantity) || 0) - (held[[r.blankId, r.blankColor || "", r.blankSize || ""].join("|")] || 0);
    if (free <= 0) continue;
    const size = r.pricingMode === "flat" ? "" : String(r.productSize || "");
    const byColor = (out[r.productId] = out[r.productId] || {});
    const bySize = (byColor[r.productColor || ""] = byColor[r.productColor || ""] || {});
    bySize[size] = Math.max(bySize[size] || 0, free);
  }
  return out;
}

// The Stock window: per size on hand / set aside (and by which orders) / available / average cost /
// value, and what Make for stock would use — the linked blank and how many of it are free.
export async function getFinishedStock(db, orgId, productId) {
  const p = await stockProduct_(db, orgId, productId);
  if (!p) return null;
  let rows = [];
  try { ({ results: rows } = await db.prepare("SELECT size, quantity, avgCostCents FROM ready_to_ship WHERE orgId=? AND productId=? ORDER BY size").bind(orgId, productId).all()); }
  catch (e) { ({ results: rows } = await db.prepare("SELECT size, quantity, 0 AS avgCostCents FROM ready_to_ship WHERE orgId=? AND productId=? ORDER BY size").bind(orgId, productId).all()); }
  const held = await finishedSetAside_(db, orgId), reserved = await getBlankReservations(db);
  const sizes = p.pricingMode === "flat" ? [""] : Object.keys(tryParse_((await db.prepare("SELECT sizePricingCents FROM products WHERE orgId=? AND productId=?").bind(orgId, productId).first() || {}).sizePricingCents, {}) || {});
  for (const r of rows) if (!sizes.includes(r.size)) sizes.push(r.size);
  const out = [];
  for (const size of sizes) {
    const r = rows.find(x => x.size === size) || { quantity: 0, avgCostCents: 0 };
    const h = held[[orgId, productId, size].join("|")] || { n: 0, orderIds: [] };
    const link = await stockLink_(db, orgId, productId, p.pricingMode, size);
    const onHand = Number(r.quantity) || 0, avg = Number(r.avgCostCents) || 0;
    out.push({ size, onHand, setAside: h.n, setAsideOrders: h.orderIds, available: Math.max(0, onHand - h.n), avgCost: fromCents(avg), value: fromCents(Math.max(0, onHand) * avg),
      blank: link ? { blankId: Number(link.blankId), name: link.blankName || "", color: link.blankColor || "", size: link.blankSize || "", avgCost: fromCents(link.avg),
        free: Math.max(0, Number(link.quantity) - (reserved[[link.blankId, link.blankColor || "", link.blankSize || ""].join("|")] || 0)) } : null });
  }
  return { productId, name: p.name || productId, flat: p.pricingMode === "flat", configurable: !!Number(p.configurable), noBlankNeeded: !!Number(p.noBlankNeeded), sizes: out };
}

// Make for stock: `qty` blanks of the size's linked blank are decorated into finished pieces. One
// guarded batch (makeItemPieces_ style): every statement only applies while the blank still has
// enough FREE (on hand less set aside for orders), and the claim on blank_sizes runs last — so two
// requests can't both take the last blanks. Returns {claimed, unitCost}.
export async function makeForStock(db, { orgId, productId, size, qty, occurredAt }) {
  const q = Math.floor(Number(qty) || 0);
  if (q <= 0) throw pricingError_("Enter how many were made.");
  const p = await stockProduct_(db, orgId, productId);
  if (!p) throw pricingError_("Product not found.");
  if (Number(p.configurable)) throw pricingError_("Products with color and graphic choices can't be stocked yet — each finished piece would be one combination.");
  const sz = stockSize_(p.pricingMode, size);
  // Made with no blank at all (migrations/0057, a patch from shop supplies): no blanks to take out.
  if (Number(p.noBlankNeeded)) throw pricingError_(`${p.name || productId} is made with no blank, so there are no blanks to take out — enter how many you have with Correct count.`);
  const link = await stockLink_(db, orgId, productId, p.pricingMode, sz);
  if (!link) throw pricingError_(`${p.name || productId}${sz ? " (" + sz + ")" : ""} isn't linked to a blank — link it on the product first, or enter the count with Correct count.`);
  const blankId = Number(link.blankId), bColor = link.blankColor || "", bSize = link.blankSize || "";
  const held = (await getBlankReservations(db))[[blankId, bColor, bSize].join("|")] || 0;
  const free = Number(link.quantity) - held;
  if (q > free) throw pricingError_(`Only ${Math.max(0, free)} ${link.blankName || "blank"}${bColor ? " " + bColor : ""}${bSize && bSize !== "OSFA" ? " " + bSize : ""} free${held ? ` (${held} set aside for orders)` : ""} — receive more first.`);
  const now = new Date().toISOString(), at = occurredAt || now;
  const G = "(SELECT quantity FROM blank_sizes WHERE blankId = ? AND color = ? AND size = ?) >= ?", gb = [blankId, bColor, bSize, q + held];
  const avgSql = "MAX(0, COALESCE((SELECT purchasePriceCents FROM blank_sizes WHERE blankId = ? AND color = ? AND size = ?), 0))", ab = [blankId, bColor, bSize];
  const note = `Made for stock — ${p.name || productId}${sz ? " (" + sz + ")" : ""}`.slice(0, 300);
  const res = await db.batch([
    db.prepare(`INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, orderId, itemId, vendor, vendorRef, note, occurredAt, createdAt, vendorChargedTax, accountId, paidPersonally, receiptKey, receiptName, reason)
      SELECT ?, ?, ?, ?, ?, ${avgSql}, 'consume', NULL, NULL, '', '', ?, ?, ?, 0, NULL, 0, '', '', 'finished' WHERE ${G}`)
      .bind(blankId, link.blankName || "", bColor, bSize, -q, ...ab, note, at, now, ...gb),
    db.prepare(`INSERT INTO finished_goods_movements (orgId, productId, productName, color, size, qtyDelta, unitCostCents, kind, blankMovementId, note, occurredAt, createdAt)
      SELECT ?, ?, ?, '', ?, ?, ${avgSql}, 'make', (SELECT max(id) FROM inventory_movements WHERE blankId = ? AND reason = 'finished'), ?, ?, ? WHERE ${G}`)
      .bind(orgId, productId, p.name || productId, sz, q, ...ab, blankId, note, at, now, ...gb),
    db.prepare(`INSERT INTO ready_to_ship (orgId, productId, size, quantity, updatedAt, avgCostCents) SELECT ?, ?, ?, ?, ?, ${avgSql} WHERE ${G}
      ON CONFLICT(orgId, productId, size) DO UPDATE SET
        avgCostCents = CAST(ROUND((MAX(ready_to_ship.quantity, 0) * ready_to_ship.avgCostCents + excluded.quantity * excluded.avgCostCents) * 1.0
                                  / (MAX(ready_to_ship.quantity, 0) + excluded.quantity)) AS INTEGER),
        quantity = ready_to_ship.quantity + excluded.quantity, updatedAt = excluded.updatedAt`)
      .bind(orgId, productId, sz, q, now, ...ab, ...gb),
    db.prepare(`UPDATE blank_sizes SET quantity = quantity - ? WHERE blankId = ? AND color = ? AND size = ? AND quantity >= ?`).bind(q, blankId, bColor, bSize, q + held),
  ]);
  const claimed = Number(res.at(-1) && res.at(-1).meta && res.at(-1).meta.changes) === 1;
  return { claimed, unitCost: fromCents(Number(link.avg) || 0), blank: { name: link.blankName || "", color: bColor, size: bSize } };
}

// Stock window → Correct count: sets the on-hand count to what was counted, as an `adjust` movement for
// the difference (an increase at the current average cost, or the linked blank's when there's none yet).
// Refused below what's set aside for orders, and if the count changed since it was read.
export async function setFinishedCount(db, { orgId, productId, size, quantity, note }) {
  const want = Math.floor(Number(quantity));
  if (!Number.isFinite(want) || want < 0) throw pricingError_("Enter a count of 0 or more.");
  const p = await stockProduct_(db, orgId, productId);
  if (!p) throw pricingError_("Product not found.");
  const sz = stockSize_(p.pricingMode, size);
  const cur = await db.prepare("SELECT quantity, avgCostCents FROM ready_to_ship WHERE orgId=? AND productId=? AND size=?").bind(orgId, productId, sz).first();
  const onHand = cur ? Number(cur.quantity) || 0 : 0, avg = cur ? Number(cur.avgCostCents) || 0 : 0;
  const held = ((await finishedSetAside_(db, orgId))[[orgId, productId, sz].join("|")] || {}).n || 0;
  if (want < held) throw pricingError_(`${held} ${held === 1 ? "is" : "are"} set aside for orders — the count can't go below that.`);
  const delta = want - onHand;
  if (!delta) return { delta: 0 };
  let unit = avg;
  if (!unit && delta > 0) { const l = await stockLink_(db, orgId, productId, p.pricingMode, sz); unit = l ? Number(l.avg) || 0 : 0; }
  const newAvg = delta > 0 ? Math.round((Math.max(0, onHand) * avg + delta * unit) / (Math.max(0, onHand) + delta)) : avg;
  const now = new Date().toISOString();
  const G = "COALESCE((SELECT quantity FROM ready_to_ship WHERE orgId = ? AND productId = ? AND size = ?), 0) = ?", gb = [orgId, productId, sz, onHand];
  const res = await db.batch([
    db.prepare(`INSERT INTO finished_goods_movements (orgId, productId, productName, color, size, qtyDelta, unitCostCents, kind, note, occurredAt, createdAt)
      SELECT ?, ?, ?, '', ?, ?, ?, 'adjust', ?, ?, ? WHERE ${G}`)
      .bind(orgId, productId, p.name || productId, sz, delta, unit, String(note || "Count corrected").slice(0, 300), now, now, ...gb),
    db.prepare(`INSERT INTO ready_to_ship (orgId, productId, size, quantity, updatedAt, avgCostCents) SELECT ?, ?, ?, ?, ?, ? WHERE ${G}
      ON CONFLICT(orgId, productId, size) DO UPDATE SET quantity = excluded.quantity, avgCostCents = excluded.avgCostCents, updatedAt = excluded.updatedAt`)
      .bind(orgId, productId, sz, want, now, newAvg, ...gb),
  ]);
  if (!(Number(res[0] && res[0].meta && res[0].meta.changes) === 1)) throw pricingError_("The count changed while you were editing — reopen the Stock window and try again.");
  return { delta, unitCost: fromCents(unit) };
}

// Kept for older callers: a typed count is now a recorded correction.
export async function upsertReadyToShipQty(db, orgId, productId, size, quantity) {
  return setFinishedCount(db, { orgId, productId, size, quantity });
}

// Rebuilds one product + size's cached quantity / average cost from its non-voided movements (the
// same replay as getFinishedGoodsValuation) — after a void, like recomputeBlankSizeFromHistory_.
async function recomputeFinishedFromHistory_(db, orgId, productId, size) {
  const { results } = await db.prepare(
    "SELECT qtyDelta, unitCostCents, kind FROM finished_goods_movements WHERE orgId=? AND productId=? AND size=? AND voidedAt IS NULL ORDER BY occurredAt, id"
  ).bind(orgId, productId, size).all();
  let qty = 0, avg = 0;
  for (const m of results) {
    const d = Number(m.qtyDelta);
    if (d > 0 && m.kind !== "sell") { const on = Math.max(0, qty); avg = Math.round((on * avg + d * Number(m.unitCostCents)) / (on + d)); }
    qty += d;
  }
  await db.prepare(`INSERT INTO ready_to_ship (orgId, productId, size, quantity, updatedAt, avgCostCents) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(orgId, productId, size) DO UPDATE SET quantity = excluded.quantity, avgCostCents = excluded.avgCostCents, updatedAt = excluded.updatedAt`)
    .bind(orgId, productId, size, qty, new Date().toISOString(), avg).run();
}

export async function getFinishedGoodsMovements(db, orgId, productId) {
  const { results } = await db.prepare(
    "SELECT * FROM finished_goods_movements WHERE orgId=? AND productId=? ORDER BY occurredAt DESC, id DESC LIMIT 500").bind(orgId, productId).all();
  return results.map(r => ({ id: Number(r.id), size: r.size || "", qtyDelta: Number(r.qtyDelta), unitCost: fromCents(r.unitCostCents), kind: r.kind,
    orderId: r.orderId || "", note: r.note || "", occurredAt: r.occurredAt, voidedAt: r.voidedAt || "", voidReason: r.voidReason || "" }));
}

// Voids a mistaken opening / make / adjust entry (sell and return rows come from orders and are
// corrected there). Voiding a `make` also voids the blanks it used — they're back in blank stock.
// Refused when it would leave fewer on hand than are set aside. Returns the row (pre-void) or throws.
export async function voidFinishedGoodsMovement(db, id, reason) {
  const row = await db.prepare("SELECT * FROM finished_goods_movements WHERE id=?").bind(Number(id)).first();
  if (!row || row.voidedAt) throw pricingError_("That entry isn't there or is already voided.");
  if (!["opening", "make", "adjust"].includes(row.kind)) throw pricingError_("Entries made by an order are corrected on the order.");
  const cur = await db.prepare("SELECT quantity FROM ready_to_ship WHERE orgId=? AND productId=? AND size=?").bind(row.orgId, row.productId, row.size).first();
  const held = ((await finishedSetAside_(db, row.orgId))[[row.orgId, row.productId, row.size].join("|")] || {}).n || 0;
  const after = (cur ? Number(cur.quantity) : 0) - Number(row.qtyDelta);
  if (after < 0) throw pricingError_(`Voiding this would leave ${after} on hand — some of these pieces have already been sold. Use Correct count instead.`);
  if (after < held) throw pricingError_(`Voiding this would leave ${after} on hand, but ${held} ${held === 1 ? "is" : "are"} set aside for orders.`);
  const now = new Date().toISOString(), why = String(reason || "").slice(0, 300);
  const r = await db.prepare("UPDATE finished_goods_movements SET voidedAt=?, voidReason=? WHERE id=? AND voidedAt IS NULL").bind(now, why, Number(id)).run();
  if (!((r.meta && r.meta.changes) > 0)) throw pricingError_("That entry was just voided.");
  if (row.kind === "make" && row.blankMovementId) {
    const bm = await db.prepare("SELECT * FROM inventory_movements WHERE id=? AND voidedAt IS NULL").bind(Number(row.blankMovementId)).first();
    if (bm) {
      await db.prepare("UPDATE inventory_movements SET voidedAt=?, voidReason=? WHERE id=?").bind(now, ("Finished stock entry voided: " + why).slice(0, 300), Number(bm.id)).run();
      await recomputeBlankSizeFromHistory_(db, bm.blankId, bm.color || "", bm.size);
    }
  }
  await recomputeFinishedFromHistory_(db, row.orgId, row.productId, row.size);
  return row;
}

// Finished stock on hand and its value at the END of a moment (ISO), from the movements — a running
// weighted-average cost per shop + product + size (Schedule C Part III, like getInventoryValuation).
export async function getFinishedGoodsValuation(db, asOf) {
  let results = [];
  try {
    ({ results } = await db.prepare(
      "SELECT orgId, productId, productName, size, qtyDelta, unitCostCents, kind FROM finished_goods_movements WHERE occurredAt <= ? AND voidedAt IS NULL ORDER BY occurredAt, id"
    ).bind(asOf).all());
  } catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
  const state = new Map();
  for (const m of results) {
    const key = [m.orgId, m.productId, m.size].join("|");
    const st = state.get(key) || { orgId: m.orgId, productId: m.productId, name: m.productName, size: m.size || "", qty: 0, avg: 0 };
    const d = Number(m.qtyDelta);
    if (d > 0 && m.kind !== "sell") { const on = Math.max(0, st.qty); st.avg = Math.round((on * st.avg + d * Number(m.unitCostCents)) / (on + d)); }
    st.qty += d; st.name = m.productName || st.name;
    state.set(key, st);
  }
  const rows = [...state.values()].filter(r => r.qty !== 0)
    .map(r => ({ orgId: r.orgId, productId: r.productId, name: r.name, size: r.size, qty: r.qty, avgCost: fromCents(r.avg), value: fromCents(Math.max(0, r.qty) * r.avg) }))
    .sort((a, b) => (a.orgId + a.name + a.size).localeCompare(b.orgId + b.name + b.size));
  return { asOf, rows, units: rows.reduce((s, r) => s + r.qty, 0), value: fromCents(rows.reduce((s, r) => s + toCents(r.value), 0)) };
}

// A pulled from-stock line taken back (its line cancelled, or its order voided, before it shipped):
// its pieces return to finished stock at the cost they left with, and the line's cost is cleared.
// Guarded: the line's cost is the claim (cleared last), so it happens once. itemId null = every line.
async function returnFinishedStock_(db, orderId, itemId) {
  if (!(await hasFromStockColumn_(db))) return 0;
  const o = await db.prepare("SELECT shippedAt, deliveredAt FROM orders WHERE orderId=?").bind(orderId).first();
  if (!o || o.shippedAt || o.deliveredAt) return 0;
  const { results: lines } = await db.prepare(
    `SELECT oi.id, oi.orgId, oi.productId, oi.size, oi.manufacturedQty, oi.cogsCents, p.pricingMode, p.name
     FROM order_items oi LEFT JOIN products p ON p.orgId = oi.orgId AND p.productId = oi.productId
     WHERE oi.orderId = ? AND oi.fromStock = 1 AND COALESCE(oi.manufacturedQty, 0) > 0 AND COALESCE(oi.cogsCents, 0) > 0 ${itemId ? "AND oi.id = ?" : ""}`
  ).bind(...(itemId ? [orderId, Number(itemId)] : [orderId])).all();
  let n = 0;
  for (const l of lines) {
    const pieces = Number(l.manufacturedQty), cents = Number(l.cogsCents), unit = Math.round(cents / pieces);
    const sz = stockSize_(l.pricingMode, l.size), now = new Date().toISOString();
    const G = "(SELECT COALESCE(cogsCents, 0) FROM order_items WHERE id = ?) = ?", gb = [Number(l.id), cents];
    const res = await db.batch([
      db.prepare(`INSERT INTO finished_goods_movements (orgId, productId, productName, color, size, qtyDelta, unitCostCents, kind, orderId, itemId, note, occurredAt, createdAt)
        SELECT ?, ?, ?, '', ?, ?, ?, 'return', ?, ?, ?, ?, ? WHERE ${G}`)
        .bind(l.orgId, l.productId, l.name || l.productId, sz, pieces, unit, orderId, Number(l.id), ("Put back from order " + orderId).slice(0, 300), now, now, ...gb),
      db.prepare(`INSERT INTO ready_to_ship (orgId, productId, size, quantity, updatedAt, avgCostCents) SELECT ?, ?, ?, ?, ?, ? WHERE ${G}
        ON CONFLICT(orgId, productId, size) DO UPDATE SET
          avgCostCents = CAST(ROUND((MAX(ready_to_ship.quantity, 0) * ready_to_ship.avgCostCents + excluded.quantity * excluded.avgCostCents) * 1.0
                                    / (MAX(ready_to_ship.quantity, 0) + excluded.quantity)) AS INTEGER),
          quantity = ready_to_ship.quantity + excluded.quantity, updatedAt = excluded.updatedAt`)
        .bind(l.orgId, l.productId, sz, pieces, now, unit, ...gb),
      db.prepare("UPDATE order_items SET cogsCents = 0 WHERE id = ? AND COALESCE(cogsCents, 0) = ?").bind(Number(l.id), cents),
    ]);
    if (Number(res.at(-1) && res.at(-1).meta && res.at(-1).meta.changes) === 1) n += pieces;
  }
  return n;
}

export async function updateOrderPlacedAt(db, orderId, placedAt) {
  await db.prepare("UPDATE orders SET placedAt = ? WHERE orderId = ?")
    .bind(placedAt, orderId).run();
}

// The optional due date (migrations/0038) — a 'YYYY-MM-DD' string, or null/'' to clear it.
// Prioritizes the Run Order and Run Transfer Sheets queues (soonest first, undated last).
export async function setOrderDueDate(db, orderId, dueDate) {
  const d = dueDate && /^\d{4}-\d{2}-\d{2}$/.test(String(dueDate)) ? String(dueDate) : null;
  await db.prepare("UPDATE orders SET dueDate = ? WHERE orderId = ?").bind(d, orderId).run();
  return d;
}

export async function getRevenueData(db, dateFrom, dateTo) {
  const { results } = await withTaxMode_((tm) => db.prepare(`
    SELECT
      o.orderId,
      o.orgId,
      o.discountCents, o.discountTaxCents, o.shippingCostCents, ${tm} AS taxMode,
      COALESCE(SUM(CASE WHEN oi.cancelDate IS NULL THEN oi.lineTotalCents ELSE 0 END), 0) AS itemsCents,
      COALESCE(SUM(CASE WHEN oi.cancelDate IS NULL THEN oi.taxCents ELSE 0 END), 0) AS itemsTaxCents,
      -- Net of refunds and lost disputes (negative rows): a refund — e.g. shipping overcharged then
      -- refunded, after the order's shipping was lowered to match — must not leave "received" above
      -- what the order now costs.
      COALESCE((SELECT SUM(p.amountCents) FROM order_payments p WHERE p.orderId = o.orderId AND p.kind IN ('payment', 'refund', 'dispute') AND p.voidedAt IS NULL), 0) / 100.0 AS received
    FROM orders o
    LEFT JOIN order_items oi ON oi.orderId = o.orderId
    WHERE o.placedAt >= ? AND o.placedAt <= ?
      AND o.isTest = 0 AND o.voidedAt IS NULL
    GROUP BY o.orderId
  `).bind(dateFrom, dateTo).all());
  // Dollars out; effectiveTotal is what the order comes to (orderAmounts), shipping what it charges.
  return results.map(r => {
    const a = orderAmountsOfRow_(r);
    return { orderId: r.orderId, orgId: r.orgId, itemSubtotal: fromCents(r.itemsCents), discountAmount: fromCents(r.discountCents),
      shippingCost: fromCents(a.shippingCents), salesTax: fromCents(a.taxCents), effectiveTotal: fromCents(a.owedCents), received: r.received };
  });
}

// Sales-tax report (accrual, by the month the order was placed). One row per
// (month, exempt?, ship-to state). Excludes test and voided orders. Dollars out.
// taxCollected = active lines' tax - discount tax; netTaxable = goods sold
// excluding tax; shipping is reported separately (not taxed). Each order is read in its own
// tax mode (the listed prices include the tax, or it was added on top), so a period with both
// adds up: gross is always what customers paid for goods, net always excludes the tax.
export async function getSalesTaxReport(db, dateFrom, dateTo) {
  const { results } = await withTaxMode_((tm) => db.prepare(`
    WITH per AS (
      SELECT o.orderId, substr(o.placedAt, 1, 7) AS month, o.taxExempt AS exempt, ${tm} AS mode,
             COALESCE(o.shipState, '') AS state, o.orgId,
             o.discountCents AS disc, o.discountTaxCents AS discTax, o.shippingCostCents AS ship,
             COALESCE(SUM(CASE WHEN i.cancelDate IS NULL THEN i.lineTotalCents END), 0) AS gross,
             COALESCE(SUM(CASE WHEN i.cancelDate IS NULL THEN i.taxCents END), 0) AS tax
      FROM orders o LEFT JOIN order_items i ON i.orderId = o.orderId
      WHERE o.placedAt >= ? AND o.placedAt <= ? AND o.isTest = 0 AND o.voidedAt IS NULL
      GROUP BY o.orderId
    )
    SELECT month, exempt, state,
           COUNT(*) AS orders,
           SUM(gross) AS grossCents,
           SUM(MIN(disc, gross)) AS discountCents,
           SUM(MAX(tax - discTax, 0)) AS taxCents,
           SUM(CASE WHEN mode = 'exclusive' THEN MAX(tax - discTax, 0) ELSE 0 END) AS taxAddedCents,
           SUM(CASE WHEN gross > 0 THEN ship ELSE 0 END) AS shippingCents,
           GROUP_CONCAT(DISTINCT orgId) AS orgs
    FROM per GROUP BY month, exempt, state ORDER BY month, exempt, state
  `).bind(dateFrom, dateTo).all());
  return results.map(r => {
    // Listed prices after the discount, plus the tax that was added on top of them.
    const grossAfterDiscount = Math.max(0, Number(r.grossCents) - Number(r.discountCents)) + (Number(r.taxAddedCents) || 0);
    return {
      month: r.month, exempt: !!r.exempt, state: r.state, orders: Number(r.orders),
      grossSales: fromCents(grossAfterDiscount),              // what customers paid for goods (tax included)
      taxCollected: fromCents(r.taxCents),
      netSales: fromCents(grossAfterDiscount - Number(r.taxCents)), // taxable (or exempt) sales, tax excluded
      shipping: fromCents(r.shippingCents),                   // not taxed
      orgs: String(r.orgs || "").split(",").filter(Boolean),
    };
  });
}

// Month-by-month figures laid out like a state sales & use tax return
// (each period, and the annual return). Sales EXCLUDE tax (backed out of
// tax-inclusive prices; never in tax-exclusive ones — per order): taxable sales + the three
// deductions (exempt-org, out-of-state/interstate, non-taxable services) =
// gross sales. Discounts are shared across an order's lines by amount. Use tax
// = the current rate × untaxed purchases of use-taxable goods (expenses whose
// category is use-taxable and whose vendor didn't charge sales tax). Dollars out.
export async function getSalesTaxReturn(db, dateFrom, dateTo) {
  const settings = await getSalesTaxSettings(db);
  const { results: lines } = await withTaxMode_((tm) => db.prepare(`
    SELECT substr(o.placedAt, 1, 7) AS month, o.orderId, o.taxExempt, o.shipState, o.discountCents, o.discountTaxCents,
           o.shippingCostCents, i.lineTotalCents, i.taxCents, i.taxable, ${tm} AS taxMode
    FROM orders o JOIN order_items i ON i.orderId = o.orderId
    WHERE o.placedAt >= ? AND o.placedAt <= ? AND o.isTest = 0 AND o.voidedAt IS NULL AND i.cancelDate IS NULL
    ORDER BY o.orderId`).bind(dateFrom, dateTo).all());
  const months = {};
  // taxable = taxable sales as listed; taxIncl = the tax that is INSIDE that figure (inclusive orders
  // only), so taxable − taxIncl is taxable sales excluding tax whatever the mix of modes.
  const M = (m) => (months[m] = months[m] || { month: m, taxable: 0, tax: 0, taxIncl: 0, exempt: 0, interstate: 0, nonTaxable: 0,
    shipping: 0, taxRefunded: 0, refunds: 0, useTaxBase: 0, useTax: 0, orders: new Set() });
  const orderGross = byId_();
  for (const l of lines) orderGross[l.orderId] = (orderGross[l.orderId] || 0) + Number(l.lineTotalCents);
  for (const l of lines) {
    const m = M(l.month), incl = taxMode_(l.taxMode) !== "exclusive";
    const gross = orderGross[l.orderId] || 0, line = Number(l.lineTotalCents);
    const discShare = gross > 0 ? Math.round(Math.min(Number(l.discountCents) || 0, gross) * line / gross) : 0;
    const after = line - discShare;
    if (!m.orders.has(l.orderId)) {
      m.orders.add(l.orderId);
      if (gross > 0) m.shipping += Number(l.shippingCostCents) || 0;
      m.tax -= Number(l.discountTaxCents) || 0;   // tax taken off with the discount (once per order)
      if (incl) m.taxIncl -= Number(l.discountTaxCents) || 0;
    }
    if (l.taxExempt) m.exempt += after;
    else if (isOutOfState(l.shipState, settings.jurisdiction)) m.interstate += after;
    else if (!l.taxable) m.nonTaxable += after;
    else { m.taxable += after; m.tax += Number(l.taxCents); if (incl) m.taxIncl += Number(l.taxCents); }
  }
  for (const r of await getSalesTaxRefunds(db, dateFrom, dateTo)) {
    const m = M(r.month); m.taxRefunded += toCents(r.taxRefunded); m.refunds += toCents(r.refunded);
  }
  const { results: untaxed } = await db.prepare(`
    SELECT e.id, e.expenseDate, e.description, e.vendor, e.amountCents, c.name AS category
    FROM expenses e JOIN expense_categories c ON c.id = e.categoryId
    WHERE e.deletedAt IS NULL AND c.useTaxable = 1 AND e.vendorChargedTax = 0 AND e.expenseDate >= ? AND e.expenseDate <= ?
    ORDER BY e.expenseDate`).bind(dateFrom.slice(0, 10), dateTo.slice(0, 10)).all();
  const rate = Number(settings.rateBps) || 0;
  const useTaxItems = untaxed.map(e => {
    const tax = Math.sign(Number(e.amountCents)) * Math.round(Math.abs(Number(e.amountCents)) * rate / 10000);   // a refund reverses it to the cent
    const m = M(String(e.expenseDate).slice(0, 7)); m.useTaxBase += Number(e.amountCents); m.useTax += tax;
    return { id: Number(e.id), date: e.expenseDate, description: e.description, vendor: e.vendor || "", category: e.category,
      amount: fromCents(e.amountCents), useTax: fromCents(tax) };
  });
  const out = (m) => {
    const taxableNet = m.taxable - m.taxIncl;   // taxable sales excluding the tax in them
    const gross = taxableNet + m.exempt + m.interstate + m.nonTaxable;
    return { month: m.month, orders: m.orders.size, grossSales: fromCents(gross), taxableSales: fromCents(taxableNet),
      exemptSales: fromCents(m.exempt), interstateSales: fromCents(m.interstate), nonTaxableSales: fromCents(m.nonTaxable),
      taxCollected: fromCents(m.tax), taxRefunded: fromCents(m.taxRefunded), useTaxablePurchases: fromCents(m.useTaxBase),
      useTax: fromCents(m.useTax), totalDue: fromCents(m.tax - m.taxRefunded + m.useTax), shipping: fromCents(m.shipping) };
  };
  const rows = Object.values(months).sort((a, b) => a.month.localeCompare(b.month));
  const total = rows.reduce((t, m) => { for (const k of ["taxable", "tax", "taxIncl", "exempt", "interstate", "nonTaxable", "shipping", "taxRefunded", "refunds", "useTaxBase", "useTax"]) t[k] += m[k];
    m.orders.forEach(o => t.orders.add(o)); return t; }, { month: "total", taxable: 0, tax: 0, taxIncl: 0, exempt: 0, interstate: 0, nonTaxable: 0, shipping: 0, taxRefunded: 0, refunds: 0, useTaxBase: 0, useTax: 0, orders: new Set() });
  return { months: rows.map(out), total: out(total), useTaxItems, ratePct: rate / 100, jurisdiction: settings.jurisdiction || "" };
}

// How much of a refund (or lost dispute) was shipping (migrations/0035) — between $0 and the whole
// refund. Shipping isn't taxed, so that part carries no sales tax (getSalesTaxRefunds).
export async function setRefundShipping(db, paymentId, shippingAmount) {
  const p = await db.prepare("SELECT id, orderId, amountCents, kind, voidedAt FROM order_payments WHERE id=?").bind(Number(paymentId)).first();
  if (!p) throw new Error("Payment not found");
  if (p.kind !== "refund" && p.kind !== "dispute") throw new Error("Only a refund can have a shipping part");
  if (p.voidedAt) throw new Error("That refund was voided");
  const cents = toCents(shippingAmount);
  if (!Number.isFinite(cents) || cents < 0) throw new Error("The shipping part must be $0 or more");
  if (cents > Math.abs(Number(p.amountCents))) throw new Error(`The shipping part can't be more than the $${fromCents(Math.abs(Number(p.amountCents))).toFixed(2)} refund`);
  await db.prepare("UPDATE order_payments SET shippingCents=? WHERE id=?").bind(cents, Number(paymentId)).run();
  return { orderId: p.orderId, shipping: fromCents(cents) };
}

// Refunds and lost disputes in a period (by the month the money went back),
// with the tax portion backed out at the refunded order's own rate — the
// money going back always includes its tax, whether the tax was inside the
// listed price or added to it. Dollars out.
export async function getSalesTaxRefunds(db, dateFrom, dateTo) {
  const { results } = await withTaxMode_((tm) => db.prepare(`
    SELECT substr(p.receivedAt, 1, 7) AS month, -p.amountCents AS refundCents, COALESCE(p.shippingCents, 0) AS shippingCents,
           o.taxExempt, o.taxRateBps, o.shipState, ${tm} AS taxMode,
           COALESCE((SELECT SUM(lineTotalCents) FROM order_items i WHERE i.orderId = o.orderId AND i.cancelDate IS NULL), 0) AS grossCents,
           COALESCE((SELECT SUM(lineTotalCents) FROM order_items i WHERE i.orderId = o.orderId AND i.cancelDate IS NULL AND i.taxable = 1), 0) AS taxableCents
    FROM order_payments p JOIN orders o ON o.orderId = p.orderId
    WHERE p.kind IN ('refund', 'dispute') AND p.receivedAt >= ? AND p.receivedAt <= ?
      AND p.voidedAt IS NULL AND o.isTest = 0 AND o.voidedAt IS NULL
  `).bind(dateFrom, dateTo).all());
  const { jurisdiction } = await getSalesTaxSettings(db);
  const byMonth = {};
  for (const r of results) {
    const m = (byMonth[r.month] = byMonth[r.month] || { month: r.month, refundCents: 0, taxCents: 0, count: 0 });
    const refund = Number(r.refundCents);
    // Tax only on the taxable share of an in-state, non-exempt order — and never on the refund's
    // shipping part (shipping isn't taxed; migrations/0035).
    const rate = r.taxExempt || isOutOfState(r.shipState, jurisdiction) ? 0 : Number(r.taxRateBps) || 0;
    let gross = Number(r.grossCents), taxable = Number(r.taxableCents);
    // The refund is money the customer paid. With tax on top, the taxable lines' share of that
    // money is their listed total PLUS their tax, so weigh them that way before backing it out.
    if (taxMode_(r.taxMode) === "exclusive") {
      taxable = Math.min(taxable, gross);
      const added = addTaxExclusive(taxable, rate).taxCents;
      gross += added; taxable += added;
    }
    const goods = Math.max(0, refund - Math.min(Math.max(0, Number(r.shippingCents) || 0), Math.max(0, refund)));
    const taxablePart = gross > 0 ? Math.round(goods * Math.min(taxable, gross) / gross) : goods;
    m.refundCents += refund;
    m.taxCents += splitTaxInclusive(taxablePart, rate).taxCents;
    m.count++;
  }
  return Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month))
    .map(m => ({ month: m.month, refunds: m.count, refunded: fromCents(m.refundCents), taxRefunded: fromCents(m.taxCents) }));
}

export async function insertAuditLog(db, { orgId, orderId, action, detail, actor, ip, actorUserId, targetUserId }) {
  const createdAt = new Date().toISOString();
  const detailJson = detail != null ? JSON.stringify(detail) : null;
  // Security entries also say which user did it and to which (migrations/0053).
  if (actorUserId != null || targetUserId != null) {
    await db.prepare(
      "INSERT INTO audit_log (createdAt, orgId, orderId, action, detail, actor, ip, actorUserId, targetUserId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(createdAt, orgId || null, orderId || null, action, detailJson, actor || null, ip || null, actorUserId == null ? null : actorUserId, targetUserId == null ? null : targetUserId).run();
    return;
  }
  try {
    await db.prepare(
      "INSERT INTO audit_log (createdAt, orgId, orderId, action, detail, actor, ip) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(createdAt, orgId || null, orderId || null, action, detailJson, actor || null, ip || null).run();
  } catch (e) {
    // Database not yet migrated (migrations/0004 adds actor/ip): still record
    // the event — with the actor folded into detail — rather than lose it.
    if (!/no such column|has no column named/i.test(String(e && e.message))) throw e;
    await db.prepare(
      "INSERT INTO audit_log (createdAt, orgId, orderId, action, detail) VALUES (?, ?, ?, ?, ?)"
    ).bind(createdAt, orgId || null, orderId || null, action,
      JSON.stringify({ ...(detail || {}), _actor: actor || null, _ip: ip || null })).run();
  }
}

export async function getAuditLog(db, { orgId, orderId, action, dateFrom, dateTo, limit = 20 } = {}) {
  const conditions = [];
  const params = [];
  if (orgId)    { conditions.push("orgId = ?");       params.push(orgId); }
  if (orderId)  { conditions.push("orderId = ?");     params.push(orderId); }
  if (action)   { conditions.push("action LIKE ?");   params.push("%" + action + "%"); }
  if (dateFrom) { conditions.push("createdAt >= ?");  params.push(dateFrom); }
  if (dateTo)   { conditions.push("createdAt <= ?");  params.push(dateTo + "T23:59:59.999Z"); }
  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const cap = Math.min(Math.max(1, Number(limit) || 20), 200);
  params.push(cap);
  const { results } = await db.prepare(
    `SELECT id, createdAt, orgId, orderId, action, detail, actor, ip, actorUserId, targetUserId FROM audit_log ${where} ORDER BY createdAt DESC LIMIT ?`
  ).bind(...params).all();
  return results.map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

function tryParse_(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}
