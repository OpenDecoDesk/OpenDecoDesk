// Ordering blanks from a supplier through PromoStandards (migrations/0072) — the part shared by the admin
// actions (functions/api/orders.js: previewSupplierOrder / placeSupplierOrder / checkSupplierOrderShipments)
// and the 6 AM roll-up (daily-digest.js), which asks the supplier for the tracking numbers of orders placed here.
//
// Nothing the browser sends about parts, prices or stock is trusted: planSupplierOrder() looks each blank up
// in our database, finds the supplier's part for its color + size with a live getProduct, and (when the
// connection has the Inventory service) checks the supplier's stock.
import { getVendorConnectionRow, listVendorConnections, getBlanksForSupplierOrder, supplierOrdersAwaitingShipment, recordSupplierShipments, getShipFromAddress,
  brandContext_, brandRuleFor_, brandApprovalCovers_, itemColorOf_ } from "./db.js";
import { psGetParts, psPartFor_, psGetInventory, psGetShipments, PS_OVERRIDES } from "./promostandards.js";
import { decryptVendorCredentials } from "./vendorCredentials.js";

export const SUPPLIER_ORDER_MAX_LINES = 100;
export const SUPPLIER_ORDER_MAX_QTY = 5000;
const SUPPLIER_ORDER_MAX_STYLES = 20;

// A connection ready to call: {conn} or {error, code}. The login is decrypted here and used only for the calls.
export async function supplierConnection(env, id) {
  const row = await getVendorConnectionRow(env.DB, id);
  if (!row) return { error: "Connection not found", code: 404 };
  let credentials;
  try { credentials = await decryptVendorCredentials(env, row.credentialsEnc); }
  catch (e) { return { error: e.message, code: 400 }; }
  if (!credentials) return { error: "This connection has no login yet — add it under Vendor integrations.", code: 400 };
  let endpoints = {}, overrides = {};
  try { endpoints = JSON.parse(row.endpointsJson || "{}"); } catch (e) {}
  try { overrides = JSON.parse(row.overridesJson || "{}"); } catch (e) {}
  return { conn: { id: Number(row.id), name: row.name, companyCode: row.companyCode, endpoints, overrides, credentials, environment: endpoints.environment === "test" ? "test" : "production" } };
}

// The ship methods offered for a supplier (its override list, else UPS Ground only).
export function supplierShipMethods(companyCode) {
  const o = PS_OVERRIDES[companyCode];
  return o && Array.isArray(o.shipMethods) && o.shipMethods.length ? o.shipMethods : [{ carrier: "UPS", service: "GROUND", label: "UPS Ground" }];
}

// The shop's address as the order's ship-to; `missing` lists what's blank (the order is refused until it's set).
export async function supplierShipTo(env) {
  const a = await getShipFromAddress(env.DB, env);
  const missing = [["street1", "street"], ["city", "city"], ["state", "state"], ["zip", "ZIP"]].filter(([k]) => !String(a[k] || "").trim()).map(([, label]) => label);
  return { shipTo: { company: a.name || "", street1: a.street1 || "", street2: "", city: a.city || "", state: a.state || "", zip: a.zip || "", email: a.email || "", phone: a.phone || "" }, missing };
}

// Cleans what the browser sent: [{blankId, color, size, qty}] → merged (one line per blank / color / size — a
// supplier checks stock per line), or {error}.
export function cleanSupplierOrderLines(lines) {
  if (!Array.isArray(lines) || !lines.length) return { error: "Nothing to order." };
  if (lines.length > SUPPLIER_ORDER_MAX_LINES) return { error: `At most ${SUPPLIER_ORDER_MAX_LINES} lines in one order.` };
  const merged = new Map();
  for (const l of lines) {
    const blankId = Number(l && l.blankId);
    const qty = l && l.qty;
    if (!Number.isInteger(blankId) || blankId <= 0) return { error: "A line has no blank." };
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > SUPPLIER_ORDER_MAX_QTY) return { error: `Each quantity must be a whole number from 1 to ${SUPPLIER_ORDER_MAX_QTY}.` };
    const color = String((l && l.color) || "").slice(0, 60), size = String((l && l.size) || "").slice(0, 40);
    const restockQty = Math.min(qty, Math.max(0, Math.floor(Number(l && l.restockQty) || 0)));   // beyond the order lines it's for
    const key = blankId + "\u0001" + color + "\u0001" + size;
    const prev = merged.get(key);
    if (prev) { prev.qty += qty; prev.restockQty += restockQty; } else merged.set(key, { blankId, color, size, qty, restockQty });
  }
  const out = [...merged.values()];
  if (out.some(l => l.qty > SUPPLIER_ORDER_MAX_QTY)) return { error: `Each quantity must be a whole number from 1 to ${SUPPLIER_ORDER_MAX_QTY}.` };
  return { lines: out };
}

// The order as it would go to the supplier: per line the supplier's part, its stock (when the connection has the
// Inventory service), our unit price (the blank's vendor price, else its average cost) and what's wrong with it.
// A line with a `problem` can't be ordered; a `note` is only worth knowing.
export async function planSupplierOrder(env, conn, rawLines) {
  const cleaned = cleanSupplierOrderLines(rawLines);
  if (cleaned.error) return { error: cleaned.error };
  const info = await getBlanksForSupplierOrder(env.DB, cleaned.lines.map(l => l.blankId));
  const sameCompany = new Set((await listVendorConnections(env.DB)).filter(c => c.companyCode === conn.companyCode).map(c => Number(c.id)));
  const lines = cleaned.lines.map(l => {
    const e = info.get(l.blankId);
    const b = e ? e.blank : null;
    const z = e ? e.sizes.get(l.color + "\u0001" + l.size) : null;
    const unitCents = z ? (z.vendorPriceCents != null ? Number(z.vendorPriceCents) : Number(z.purchasePriceCents) || 0) : 0;
    const out = { blankId: l.blankId, blank: b ? b.name || "" : "", brand: b ? b.brand || "" : "", color: l.color, size: l.size, style: b ? String(b.sku || "").trim() : "",
      qty: l.qty, restockQty: l.restockQty || 0, unitCents, productId: "", partId: "", available: null, problem: "", problemKind: "", note: "" };
    // problemKind: "blank" (ours: gone, no style #, not linked), "part" (the supplier has no such part), "stock"
    // (short), "lookup" (the supplier couldn't be asked) — the window unticks only the first two.
    const bad = (kind, msg) => { out.problem = msg; out.problemKind = kind; };
    if (!b) bad("blank", "This blank no longer exists.");
    else if (!z) bad("blank", "The blank has no such color and size.");
    else if (!out.style) bad("blank", "The blank has no style # (its SKU), so the supplier can't be asked for it.");
    else if (!sameCompany.has(Number(b.vendorConnectionId))) bad("blank", `This blank isn't linked to ${conn.name} — link it under Tools → Vendor integrations.`);
    if (!out.problem && !unitCents) out.note = "No price on file — the supplier charges its own price.";
    return out;
  });
  const styles = [...new Map(lines.filter(l => !l.problem).map(l => [l.style + "\u0001" + l.brand, { style: l.style, brand: l.brand }])).values()];
  if (styles.length > SUPPLIER_ORDER_MAX_STYLES) return { error: `At most ${SUPPLIER_ORDER_MAX_STYLES} different styles in one order — split it in two.` };
  const checked = await Promise.all(styles.map(async (s) => {
    try {
      const parts = await psGetParts(conn, s.style, { brand: s.brand });
      return { ...s, parts };
    } catch (e) { return { ...s, error: e.message || "The supplier couldn't be asked about this style." }; }
  }));
  const byStyle = new Map(checked.map(c => [c.style + "\u0001" + c.brand, c]));
  for (const l of lines) {
    if (l.problem) continue;
    const c = byStyle.get(l.style + "\u0001" + l.brand);
    if (c.error) { l.problem = c.error; l.problemKind = /not found|no product/i.test(c.error) ? "part" : "lookup"; continue; }
    l.productId = c.parts.productId;
    l.partId = psPartFor_(c.parts, l.color, l.size);
    if (!l.partId) { l.problem = `${conn.name} has no ${[l.color, l.size].filter(Boolean).join(" / ") || "such part"} in style ${l.style}.`; l.problemKind = "part"; }
  }
  // Stock: one call per style, for its parts only.
  let stockChecked = false;
  if (conn.endpoints.inv) {
    stockChecked = true;
    await Promise.all(checked.filter(c => !c.error).map(async (c) => {
      const mine = lines.filter(l => !l.problem && l.style === c.style && l.brand === c.brand);
      if (!mine.length) return;
      try {
        const levels = await psGetInventory(conn, c.parts.productId, mine.map(l => l.partId));
        for (const l of mine) {
          l.available = levels[l.partId] != null ? levels[l.partId] : 0;
          if (l.qty > l.available) { l.problem = l.available ? `Only ${l.available} in stock at ${conn.name}.` : `Out of stock at ${conn.name}.`; l.problemKind = "stock"; }
        }
      } catch (e) { for (const l of mine) l.note = (l.note ? l.note + " " : "") + "Stock couldn't be checked: " + (e.message || "error"); }
    }));
  }
  const totalCents = lines.filter(l => !l.problem).reduce((t, l) => t + l.unitCents * l.qty, 0);
  const lookup = lines.find(l => l.problemKind === "lookup");
  return { lines, totalCents, total: totalCents / 100, problems: lines.filter(l => l.problem).length, stockChecked, lookupError: lookup ? lookup.problem : "" };
}

// Asks the supplier for the shipments of orders placed here and records each new tracking number as a blank
// shipment. `opts.order` checks one order; otherwise up to `opts.limit` placed orders from the last 30 days,
// least recently checked first. A connection without the Order Shipment Notification service is skipped.
// Returns {checked, added, errors: [{poNumber, message}]}. Never throws for one order's failure.
export async function checkSupplierShipments(env, opts = {}) {
  const orders = opts.order ? [opts.order] : await supplierOrdersAwaitingShipment(env.DB, { days: 30, limit: opts.limit || 10 });
  const out = { checked: 0, added: 0, errors: [] };
  const conns = new Map();
  for (const o of orders) {
    if (!conns.has(o.connectionId)) conns.set(o.connectionId, await supplierConnection(env, o.connectionId));
    const c = conns.get(o.connectionId);
    if (c.error) { out.errors.push({ poNumber: o.poNumber, message: c.error }); continue; }
    if (!c.conn.endpoints.osn) continue;
    try {
      const shipments = await psGetShipments(c.conn, o.poNumber);
      out.added += await recordSupplierShipments(env.DB, o, shipments);
      out.checked++;
    } catch (e) { out.errors.push({ poNumber: o.poNumber, message: e.message || "Failed" }); }
  }
  return out;
}

// Restricted brands (migrations/0075): a style (blank) of a ruled brand ordered at or over its large quantity needs
// the supplier's logo approval on every product the pieces are for (found from the order lines, itemIds). Returns
// {needsApproval: [{brand, style, blank, pieces, threshold, note, missing: [{orgId, productId, name}]}], restockOnly:
// [{brand, style, pieces, threshold}]} — restockOnly = a large quantity with no order line behind it (no logo to
// review yet): shown, not blocking.
export async function supplierOrderApprovalCheck(env, planLines, itemIds) {
  const ctx = await brandContext_(env.DB);
  const styles = new Map();
  for (const l of planLines || []) {
    const b = ctx.blankAt.get(Number(l.blankId));
    const rule = b ? brandRuleFor_(ctx.rules, b.brand) : null;
    if (!rule || !rule.largeNeedsApproval) continue;
    const e = styles.get(l.blankId) || styles.set(l.blankId, { brand: rule.brand, style: b.sku || b.name || "", blank: b.name || "", pieces: 0, threshold: rule.threshold, note: rule.note || "" }).get(l.blankId);
    e.pieces += Number(l.qty) || 0;
  }
  const big = [...styles.entries()].filter(([, e]) => e.pieces >= e.threshold);
  const out = { needsApproval: [], restockOnly: [] };
  if (!big.length) return out;
  const ids = [...new Set((itemIds || []).map(Number).filter(Boolean))].slice(0, 5000);
  const lines = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT oi.orgId, oi.productId, oi.size, oi.configJson, p.name FROM order_items oi LEFT JOIN products p ON p.orgId = oi.orgId AND p.productId = oi.productId
      WHERE oi.id IN (${chunk.map(() => "?").join(",")}) AND oi.cancelDate IS NULL`).bind(...chunk).all();
    lines.push(...results);
  }
  for (const [blankId, e] of big) {
    const products = new Map();
    for (const ln of lines) {
      if (!ln.productId) continue;
      if (ctx.linkAt.get([ln.orgId, ln.productId, itemColorOf_(ln), ln.size || ""].join("\u0001")) !== Number(blankId)) continue;
      products.set(ln.orgId + "|" + ln.productId, { orgId: ln.orgId, productId: ln.productId, name: ln.name || ln.productId });
    }
    if (!products.size) { out.restockOnly.push({ brand: e.brand, style: e.style, pieces: e.pieces, threshold: e.threshold }); continue; }
    const missing = [...products.values()].filter(p => !brandApprovalCovers_(ctx.approvals, p.orgId, p.productId, e.brand, e.pieces));
    if (missing.length) out.needsApproval.push({ ...e, missing });
  }
  return out;
}
