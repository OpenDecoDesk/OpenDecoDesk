// Every call to a connected vendor's web services, logged in full (2026-10, migrations/0078): one vendor_api_log row
// per call (when, which connection, the SOAP action, what it was about, HTTP status, ok / the vendor's error, how
// long, sizes) and the complete request and response in the private RECEIPTS bucket under vendor-logs/ — or inline
// in the row's `payload` when there's no bucket (local / tests). The login's password is blanked before anything is
// kept. Logging never breaks a call: a failure to log is only reported to the console. Kept 30 days
// (cleanUpVendorApiLog, from the daily run).
//
// Use: give a decrypted connection `conn.fetch = vendorLogFetch(env, conn.id, {context, actor, defer})`; every
// promostandards.js call made with that connection then goes through it.

export const VENDOR_LOG_DAYS = 30;
const PREFIX = "vendor-logs/";

// The password (PromoStandards `password`, SanMar's own `SanMarUserPassword`) blanked in a request.
export function redactVendorRequest(xml) {
  return String(xml || "").replace(/(<(?:[\w.-]+:)?(?:password|SanMarUserPassword)>)[\s\S]*?(<\/(?:[\w.-]+:)?(?:password|SanMarUserPassword)>)/gi, "$1•••$2");
}

// What a call was about, from its request: the style / product, PO number or the like.
export function vendorRequestSubject(xml) {
  const s = String(xml || "");
  const pick = (name) => { const m = s.match(new RegExp(`<(?:[\\w.-]+:)?${name}>([^<]{1,80})<`)); return m ? m[1].trim() : ""; };
  const parts = [];
  for (const [label, name] of [["product", "productId"], ["PO", "orderNumber"], ["reference", "referenceNumber"], ["part", "partId"]]) {
    const v = pick(name);
    if (v) parts.push(`${label} ${v}`);
    if (parts.length >= 2) break;
  }
  return parts.join(" · ");
}

// The vendor's own error in a response (a SOAP fault, an ErrorMessage, a ServiceMessage of severity Error), or "".
export function vendorResponseError(text) {
  const s = String(text || "");
  const tag = (name) => { const m = s.match(new RegExp(`<(?:[\\w.-]+:)?${name}>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, "i")); return m ? m[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : ""; };
  if (/<(?:[\w.-]+:)?Fault[\s>]/i.test(s)) return tag("faultstring") || tag("Text") || "SOAP fault";
  const em = s.match(/<(?:[\w.-]+:)?(?:ErrorMessage|errorMessage)>([\s\S]*?)<\/(?:[\w.-]+:)?(?:ErrorMessage|errorMessage)>/);
  if (em) { const d = em[1].match(/<(?:[\w.-]+:)?description>([\s\S]*?)</); const c = em[1].match(/<(?:[\w.-]+:)?code>([\s\S]*?)</); if ((d && d[1].trim()) || (c && c[1].trim())) return ((d && d[1].trim()) || "error " + c[1].trim()).slice(0, 300); }
  for (const m of s.matchAll(/<(?:[\w.-]+:)?ServiceMessage>([\s\S]*?)<\/(?:[\w.-]+:)?ServiceMessage>/g)) {
    if (/<(?:[\w.-]+:)?severity>\s*Error/i.test(m[1])) { const d = m[1].match(/<(?:[\w.-]+:)?description>([\s\S]*?)</); return ((d && d[1].trim()) || "Error").slice(0, 300); }
  }
  return "";
}

// A fetch that logs each call it makes. context: what asked ("testVendorConnection", "previewSupplierOrder",
// "shipment-check"…); actor: who; defer(promise): keep the Worker alive for the write (ctx.waitUntil) — without
// it the write is awaited.
export function vendorLogFetch(env, connectionId, opts = {}) {
  const base = opts.base || fetch;
  return async (url, init = {}) => {
    const at = new Date().toISOString(), started = Date.now();
    const headers = init.headers || {};
    const action = String((headers.SOAPAction || headers.soapaction || "")).replace(/"/g, "") || String(init.method || "GET");
    const request = redactVendorRequest(typeof init.body === "string" ? init.body : "");
    const entry = { connectionId, at, action, url: String(url), request, context: opts.context || "", actor: opts.actor || "" };
    let res;
    try { res = await base(url, init); }
    catch (e) {
      await keep(env, { ...entry, httpStatus: null, ok: 0, error: (e && e.message) || "network error", durationMs: Date.now() - started, response: "" }, opts.defer);
      throw e;
    }
    const text = await res.text().catch(() => "");
    const vendorError = vendorResponseError(text);
    await keep(env, { ...entry, httpStatus: res.status, ok: res.ok && !vendorError ? 1 : 0, error: vendorError || (res.ok ? "" : `HTTP ${res.status}`),
      durationMs: Date.now() - started, response: text }, opts.defer);
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

function keep(env, e, defer) {
  const p = writeVendorLog(env, e).catch(err => console.error("Vendor API log write failed:", err));
  if (defer) { try { defer(p); return; } catch (x) { /* fall through */ } }
  return p;
}

export async function writeVendorLog(env, e) {
  if (!env || !env.DB) return null;
  const payload = JSON.stringify({ request: e.request, response: e.response });
  let key = "", inline = "";
  if (env.RECEIPTS) {
    key = `${PREFIX}${Number(e.connectionId) || 0}/${e.at.slice(0, 10)}/${e.at.replace(/[^0-9]/g, "")}-${Math.random().toString(36).slice(2, 8)}.json`;
    await env.RECEIPTS.put(key, payload, { httpMetadata: { contentType: "application/json" } });
  } else inline = payload;
  const r = await env.DB.prepare(
    `INSERT INTO vendor_api_log (connectionId, at, context, action, url, subject, httpStatus, ok, error, durationMs, requestBytes, responseBytes, payloadKey, payload, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(Number(e.connectionId) || 0, e.at, String(e.context).slice(0, 60), String(e.action).slice(0, 80), String(e.url).slice(0, 300),
    vendorRequestSubject(e.request), e.httpStatus, e.ok ? 1 : 0, String(e.error || "").slice(0, 500), Math.max(0, Math.round(e.durationMs || 0)),
    e.request.length, String(e.response || "").length, key, inline, String(e.actor || "").slice(0, 120)).run();
  return Number(r.meta && r.meta.last_row_id) || null;
}

// The log for one connection, newest first: up to `limit` rows older than `beforeId`, optionally errors only or one
// action. Payloads aren't included (getVendorApiLogEntry).
export async function listVendorApiLog(db, { connectionId, beforeId = null, errorsOnly = false, action = "", limit = 50 } = {}) {
  const where = ["connectionId = ?"], binds = [Number(connectionId) || 0];
  if (beforeId) { where.push("id < ?"); binds.push(Number(beforeId)); }
  if (errorsOnly) where.push("ok = 0");
  if (action) { where.push("action = ?"); binds.push(String(action)); }
  const n = Math.min(200, Math.max(1, Number(limit) || 50));
  const { results } = await db.prepare(`SELECT id, connectionId, at, context, action, url, subject, httpStatus, ok, error, durationMs, requestBytes, responseBytes, actor
    FROM vendor_api_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).bind(...binds, n + 1).all();
  const { results: actions } = await db.prepare("SELECT action, COUNT(*) AS n FROM vendor_api_log WHERE connectionId = ? GROUP BY action ORDER BY action").bind(Number(connectionId) || 0).all();
  return { entries: results.slice(0, n).map(r => ({ ...r, ok: !!r.ok })), more: results.length > n, actions: actions.map(a => ({ action: a.action, count: Number(a.n) })) };
}

// One call with its full request and response.
export async function getVendorApiLogEntry(env, id) {
  const row = await env.DB.prepare("SELECT * FROM vendor_api_log WHERE id = ?").bind(Number(id) || 0).first();
  if (!row) return null;
  let payload = { request: "", response: "" }, missing = false;
  if (row.payloadKey && env.RECEIPTS) {
    const obj = await env.RECEIPTS.get(row.payloadKey);
    if (obj) { try { payload = JSON.parse(await obj.text()); } catch (e) { missing = true; } } else missing = true;
  } else if (row.payload) { try { payload = JSON.parse(row.payload); } catch (e) { missing = true; } }
  const { payload: _p, payloadKey: _k, ...meta } = row;
  return { ...meta, ok: !!row.ok, request: payload.request || "", response: payload.response || "", missing };
}

// Older than VENDOR_LOG_DAYS: the stored payloads and the rows go. Returns how many.
export async function cleanUpVendorApiLog(env, days = VENDOR_LOG_DAYS) {
  const before = new Date(Date.now() - days * 86400000).toISOString();
  let deleted = 0;
  for (let round = 0; round < 20; round++) {
    const { results } = await env.DB.prepare("SELECT id, payloadKey FROM vendor_api_log WHERE at < ? ORDER BY id LIMIT 500").bind(before).all();
    if (!results.length) break;
    const keys = results.map(r => r.payloadKey).filter(Boolean);
    if (keys.length && env.RECEIPTS) { for (let i = 0; i < keys.length; i += 100) await env.RECEIPTS.delete(keys.slice(i, i + 100)); }
    await env.DB.prepare(`DELETE FROM vendor_api_log WHERE id IN (${results.map(() => "?").join(",")})`).bind(...results.map(r => r.id)).run();
    deleted += results.length;
  }
  return { deleted };
}
