/**
 * Same-origin image proxy for the overlay editor.
 * ========================================================================
 * File: functions/api/image-proxy.js  →  https://<host>/api/image-proxy?src=<url>
 *
 * The admin "overlay a graphic on the blank photo" editor (public/admin.js) composites a base
 * color photo + a transparent graphic on a <canvas> and exports the flattened PNG via toBlob().
 * The base/graphic live on the R2 public image domain (e.g. images.example.com), a DIFFERENT
 * origin from the admin page — drawing a cross-origin image taints the canvas, so toBlob() throws.
 * Serving the image THROUGH this same-origin endpoint makes it same-origin, so the canvas stays
 * clean, with no R2 CORS configuration needed.
 *
 * We read the object straight from the R2 BINDING (env.IMAGES.get(key)), NOT by fetch()ing the
 * public URL: this handler can't fetch a custom-domain URL on its own Cloudflare zone — that
 * loops back at the edge and fails ("error code: 502"). The stored URL is always
 * `${R2_PUBLIC_BASE}/${key}`, so we derive the key from `src` and read the bucket directly.
 *
 * SECURITY: `src` MUST be an absolute URL under the project's own R2_PUBLIC_BASE — an image we
 * already serve publicly from our own bucket. Anything else is refused (400). It exposes nothing
 * that isn't already public and can't be pointed at an arbitrary host (no SSRF). No auth is required
 * precisely because the content is public, and an <img> request can't carry the admin header anyway.
 */

import { jsonResponse } from "../_lib/http.js";

const EXT_TYPE = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

export async function onRequestGet(context){
  const { request, env } = context;
  const src = new URL(request.url).searchParams.get("src") || "";
  const base = String(env.R2_PUBLIC_BASE || "").replace(/\/+$/, "");
  if (!base || !env.IMAGES) return jsonResponse({ status: "error", message: "Image storage not configured." }, 500);
  // Only our own public image bucket, exact origin+path prefix — no other host or scheme.
  if (!/^https:\/\//i.test(src) || !src.startsWith(base + "/")) {
    return jsonResponse({ status: "error", message: "Only images from this site's image store can be proxied." }, 400);
  }
  // The object key is the URL path after the public base (keys have no special chars, but decode defensively).
  let key = src.slice(base.length + 1);
  try { key = decodeURIComponent(key); } catch (e) {}
  if (!key || key.indexOf("..") !== -1) return jsonResponse({ status: "error", message: "Bad image key." }, 400);

  let obj;
  try { obj = await env.IMAGES.get(key); }
  catch (e) { return jsonResponse({ status: "error", message: "Could not read the image." }, 502); }
  if (!obj) return jsonResponse({ status: "error", message: "Image not found." }, 404);

  const ext = (key.split(".").pop() || "").toLowerCase();
  const type = (obj.httpMetadata && obj.httpMetadata.contentType) || EXT_TYPE[ext] || "application/octet-stream";
  return new Response(obj.body, {
    status: 200,
    headers: { "Content-Type": type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" },
  });
}
