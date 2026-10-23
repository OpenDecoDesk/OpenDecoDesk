/**
 * A customer's own design, uploaded from the shop page (migrations/0054).
 * ========================================================================
 * Route: POST /api/customer-design?product=<productId>
 *
 * A product set to take the customer's own design (Embroidery or Transfer) shows an upload box on
 * the shop page. The image is uploaded here BEFORE the order is placed; the cart line then names
 * the returned uploadId, and placing the order (orders.js) checks it belongs to this shop and
 * product, prices it, and records the file on the line (order_item_files, uploadedBy 'customer').
 *
 *   Body: the raw image bytes. Headers: Content-Type (image/png, image/jpeg or image/webp),
 *   X-Turnstile-Token (when Turnstile is on), X-File-Name (URI-encoded — the file's name stays out
 *   of the URL and so out of logs).
 *   → {status:"ok", uploadId, width, height}
 *
 * Checks, in order: a shop's own address (never the admin or an unknown host); 10 uploads a minute
 * per address; the shop is open and the product is shown and takes a customer's design; the bot
 * check; the type, at most 10 MB, and bytes that really are that type; the pixel size read from the
 * header (functions/_lib/imageInfo.js) — at least 500 px on the long side so it can be reproduced,
 * at most 10,000 px on either side so it can't be an image bomb; and a cap of 2 GB uploaded across
 * the whole site in the last 48 hours.
 *
 * Stored in the PRIVATE DESIGNS bucket at order-files/pending/<random>.<ext> — a key the admin's
 * signed download (design.js, DESIGN_KEY_RE) already serves. Nothing here is ever readable by the
 * public. Uploads no order points to are deleted after 48 hours (cleanUpCustomerDesigns, run by the
 * Worker's daily task).
 */

import { classifyHost } from "../_lib/hostConfig.js";
import { getCatalogData } from "../_lib/catalogCache.js";
import { jsonResponse } from "../_lib/http.js";
import { rateLimited, rateLimitResponse } from "../_lib/rateLimit.js";
import { verifyTurnstile } from "../_lib/turnstile.js";
import { readBodyWithLimit, hasValidMagicBytes } from "../_lib/fileUpload.js";
import { imageSize } from "../_lib/imageInfo.js";
import { getOrgById } from "../_lib/db.js";

export const CUSTOMER_DESIGN_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export const CUSTOMER_DESIGN_MAX_BYTES = 10 * 1024 * 1024;
export const CUSTOMER_DESIGN_MIN_LONG_SIDE = 500;
export const CUSTOMER_DESIGN_MAX_SIDE = 10000;
export const CUSTOMER_DESIGN_SITE_CAP_BYTES = 2 * 1024 * 1024 * 1024;   // across every shop, last 48 hours
export const CUSTOMER_DESIGN_KEEP_HOURS = 48;
const PRODUCT_RE = /^[a-z0-9-]{1,40}$/;

const fail = (message, status = 400) => jsonResponse({ status: "error", message }, status);
const randomHex32 = () => crypto.randomUUID().replace(/-/g, "").slice(0, 32);

export async function onRequestPost({ request, env }) {
  if (!env.DB) return fail("Uploads aren't available right now.", 503);
  const url = new URL(request.url);

  // 1. A shop's own address only.
  let catalog;
  try { catalog = await getCatalogData(env); } catch (e) { return fail("Uploads aren't available right now — please try again shortly.", 503); }
  // (The bare domain serves no shop — catalog.js — so it's refused here too.)
  const host = classifyHost(url.hostname, catalog.subdomainMap, env);
  if (host.kind !== "locked" || !host.orgId) return fail("Not available here.", 403);
  const orgId = host.orgId;
  if (((catalog && catalog.features) || {}).storefront === false) return jsonResponse({ status: "error", feature: "storefront", message: "Online ordering isn't available here." }, 403);

  // 2. Rate limit, before any more database work.
  const rl = await rateLimited(env, "customer_design", request, 10);
  if (rl.blocked) return rateLimitResponse(rl.retryAfter);

  // 3. The shop is open and the product takes the customer's own design.
  const productId = url.searchParams.get("product") || "";
  if (!PRODUCT_RE.test(productId)) return fail("That product isn't available.", 404);
  const org = await getOrgById(env.DB, orgId);
  if (!org || !org.ready) return fail("This shop is not currently accepting orders.", 403);
  let product = null;
  try { product = await env.DB.prepare("SELECT visible, customDesign FROM products WHERE orgId=? AND productId=?").bind(orgId, productId).first(); }
  catch (e) { if (!/no such column/i.test(String(e && e.message))) throw e; }
  if (!product || !Number(product.visible) || !product.customDesign) return fail("This product doesn't take your own design.", 404);
  if (!env.DESIGNS) return fail("Uploads aren't available right now.", 503);

  // 4. Bot check.
  const bot = await verifyTurnstile(env, request.headers.get("X-Turnstile-Token") || "", request);
  if (!bot.ok) return fail(bot.message, 403);

  // 5. Type, size and content.
  const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const ext = CUSTOMER_DESIGN_TYPES[contentType];
  if (!ext) return fail("Please upload a PNG, JPG or WebP image.", 415);
  let body;
  try { body = await readBodyWithLimit(request, CUSTOMER_DESIGN_MAX_BYTES); }
  catch (e) { return fail("We couldn't read that file — please try again."); }
  if (body.tooLarge) return fail("That image is too large — the limit is 10 MB.", 413);
  const bytes = body.bytes;
  if (!bytes || !bytes.byteLength) return fail("That file is empty.");
  if (!hasValidMagicBytes(bytes, contentType)) return fail("That file isn't a PNG, JPG or WebP image.", 415);

  // 6. Pixel size, from the header.
  const size = imageSize(bytes, contentType);
  if (!size) return fail("We couldn't read that image — please save it as a PNG or JPG and try again.", 415);
  if (Math.max(size.width, size.height) < CUSTOMER_DESIGN_MIN_LONG_SIDE)
    return fail(`That image is too small to reproduce (${size.width} × ${size.height} px) — please use one at least ${CUSTOMER_DESIGN_MIN_LONG_SIDE} px on the long side.`);
  if (size.width > CUSTOMER_DESIGN_MAX_SIDE || size.height > CUSTOMER_DESIGN_MAX_SIDE)
    return fail(`That image is too large (${size.width} × ${size.height} px) — please use one at most ${CUSTOMER_DESIGN_MAX_SIDE.toLocaleString("en-US")} px on each side.`);

  // 7. The whole site's uploads in the last 48 hours stay under the cap.
  const since = new Date(Date.now() - CUSTOMER_DESIGN_KEEP_HOURS * 3600 * 1000).toISOString();
  const used = await env.DB.prepare("SELECT COALESCE(sum(bytes), 0) AS n FROM customer_design_uploads WHERE createdAt >= ?").bind(since).first();
  if (Number(used && used.n) + bytes.byteLength > CUSTOMER_DESIGN_SITE_CAP_BYTES) {
    console.error("Customer design uploads are over the 48-hour cap");
    return fail("Uploads are paused for the moment — please try again later, or contact the shop.", 503);
  }

  let fileName = "";
  try { fileName = decodeURIComponent(request.headers.get("X-File-Name") || ""); } catch (e) { fileName = ""; }
  fileName = fileName.replace(/[^\w .()-]/g, "").trim().slice(0, 120) || `design.${ext}`;
  const uploadId = randomHex32();
  const key = `order-files/pending/${randomHex32()}.${ext}`;
  try {
    await env.DESIGNS.put(key, bytes, { httpMetadata: { contentType }, customMetadata: { name: fileName } });
  } catch (e) {
    console.error("Storing a customer design failed:", e);
    return fail("Upload failed — please try again.", 502);
  }
  await env.DB.prepare(`INSERT INTO customer_design_uploads (id, orgId, productId, fileKey, fileName, fileExt, contentType, bytes, width, height, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(uploadId, orgId, productId, key, fileName, ext, contentType, bytes.byteLength, size.width, size.height, new Date().toISOString()).run();
  return jsonResponse({ status: "ok", uploadId, width: size.width, height: size.height });
}

export async function onRequestGet() {
  return fail("Use POST for this endpoint.", 405);
}

// The daily clean-up (src/worker.js): uploads older than 48 hours that no order line points to are
// deleted — the file and the row. Only keys under order-files/pending/, at most 1,000 a run.
export async function cleanUpCustomerDesigns(env, now = Date.now()) {
  if (!env.DB) return { deleted: 0 };
  const before = new Date(now - CUSTOMER_DESIGN_KEEP_HOURS * 3600 * 1000).toISOString();
  let results;
  try {
    ({ results } = await env.DB.prepare(
      `SELECT u.id, u.fileKey FROM customer_design_uploads u
       WHERE u.createdAt < ? AND NOT EXISTS (SELECT 1 FROM order_item_files f WHERE f.fileKey = u.fileKey)
       ORDER BY u.createdAt LIMIT 1000`).bind(before).all());
  } catch (e) { if (/no such table/i.test(String(e && e.message))) return { deleted: 0 }; throw e; }   // before migrations/0054
  let deleted = 0;
  for (const r of results) {
    if (!/^order-files\/pending\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(String(r.fileKey))) continue;
    if (env.DESIGNS) await env.DESIGNS.delete(r.fileKey);
    await env.DB.prepare("DELETE FROM customer_design_uploads WHERE id=?").bind(r.id).run();
    deleted++;
  }
  return { deleted };
}
