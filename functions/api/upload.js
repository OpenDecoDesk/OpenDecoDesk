/**
 * Admin image upload to R2.
 * ========================================================================
 * File location: functions/api/upload.js  →  https://<host>/api/upload
 *
 * Lets the admin panel upload a product/org image instead of pasting an
 * external URL. The file is stored in a Cloudflare R2 bucket and the
 * function returns its public URL, which the admin form then drops into
 * the image field (stored in the catalog exactly like a pasted URL).
 *
 * The admin form resizes images in the browser before sending, so what
 * lands in R2 is already display-sized — there's no separate thumbnail
 * system, and no server-side image library is needed here.
 *
 * ---- TRANSPORT ----
 * The image bytes are the raw POST body (Content-Type = the image type);
 * metadata rides in headers/query (admin passphrase in X-Admin-Key, org in
 * ?org=). Deliberately NOT multipart/form-data — multipart file parsing on
 * the Workers runtime proved unreliable, and a raw body streams to R2 with
 * no parsing ambiguity.
 *
 * ---- AUTH ----
 * Same gate as every other admin write action: must arrive on the admin
 * subdomain (see hostConfig.js) AND pass requireAdmin (the session cookie,
 * or the passphrase in the X-Admin-Key header).
 *
 * ---- SETUP ----
 * 1. Create an R2 bucket (e.g. `opendecodesk-images`).
 * 2. Enable public access on it — a custom domain like
 *    images.example.com (recommended) or the bucket's r2.dev URL.
 * 3. Bind the bucket to the Worker as `IMAGES` (wrangler.toml).
 * 4. Set `R2_PUBLIC_BASE` to that bucket's public base URL (no
 *    trailing slash), e.g. "https://images.example.com". A second
 *    install (a test site) should point at its own bucket, so uploads
 *    never cross over.
 */

import { classifyHost } from "../_lib/hostConfig.js";
import { requireAdmin } from "../_lib/adminAuth.js";
import { jsonResponse } from "../_lib/http.js";
import { readBodyWithLimit, hasValidMagicBytes } from "../_lib/fileUpload.js";

// Only real raster image types the storefront actually displays. Deciding
// the stored extension from the CONTENT TYPE (not a client-supplied name)
// means a mislabeled or spoofed name can't pick the object key's suffix.
const ALLOWED_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif"
};

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — the browser resize keeps real uploads well under this; hard server-side cap

export async function onRequestPost(context){
  const { request, env } = context;
  const url = new URL(request.url);

  // Admin-only, admin-subdomain-only — same posture as the write actions
  // in orders.js, via the same shared gate (rate-limited + constant-time
  // compare, sharing orders.js's admin_auth budget since it's the same
  // passphrase). The admin check keys off the subdomain label, so no
  // catalog/subdomain-map lookup is needed here. Checked BEFORE the
  // IMAGES/R2_PUBLIC_BASE config check below, so an unauthenticated caller
  // never learns whether image storage is configured.
  const host = classifyHost(url.hostname, null, env);
  // Back office work: any signed-in user (functions/_lib/adminAuth.js).
  const denied = await requireAdmin(env, host, request.headers.get("X-Admin-Key"), request, "Not available here.", "staff");
  if(denied) return denied;
  if(!env.IMAGES || !env.R2_PUBLIC_BASE){
    return jsonResponse({status:"error", message:"Server misconfigured — image storage not set up."}, 500);
  }

  const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const ext = ALLOWED_TYPES[contentType];
  if(!ext){
    return jsonResponse({status:"error", message:"Unsupported image type — use JPEG, PNG, WebP, or GIF."}, 400);
  }

  // Read the body under a hard cap (see readBodyWithLimit above) so the
  // size check happens WHILE reading, never after buffering the whole
  // thing — the actual bytes are still what's enforced, a Content-Length
  // header is only a cheap early rejection, never the sole check.
  let result;
  try{
    result = await readBodyWithLimit(request, MAX_BYTES);
  }catch(e){
    return jsonResponse({status:"error", message:"Could not read the uploaded file."}, 400);
  }
  if(result.tooLarge){
    return jsonResponse({status:"error", message:"Image is too large (max 5 MB)."}, 400);
  }
  const bytes = result.bytes;
  if(!bytes || bytes.byteLength === 0){
    return jsonResponse({status:"error", message:"No file uploaded."}, 400);
  }
  if(!hasValidMagicBytes(bytes, contentType)){
    return jsonResponse({status:"error", message:"File content does not match the declared image type."}, 415);
  }

  // org is only used (sanitized) to group files; a bad value just changes
  // the folder, never the safety of the key.
  const org = String(url.searchParams.get("org") || "misc").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "misc";

  // ?thumbFor=<id> uploads the 320px thumbnail for an already-uploaded main
  // image. The id must be exactly the 32-char hex string returned as uploadId
  // by the original upload — any other format is rejected before use.
  const thumbForParam = url.searchParams.get("thumbFor") || "";
  const UPLOAD_ID_RE = /^[0-9a-f]{32}$/i;
  let objectKey;
  let uploadId;
  if(thumbForParam){
    if(!UPLOAD_ID_RE.test(thumbForParam)){
      return jsonResponse({status:"error", message:"Invalid thumbFor value."}, 400);
    }
    // Thumb key derives from the main key — same folder, same id, -thumb suffix.
    objectKey = "uploads/" + org + "/" + thumbForParam.toLowerCase() + "-thumb." + ext;
    uploadId = null; // not returned for thumb uploads
  }else{
    // Main upload: server generates the id entirely — client never picks the key.
    const raw = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
    uploadId = raw.replace(/[^a-z0-9]/gi, "").slice(0, 32).toLowerCase();
    objectKey = "uploads/" + org + "/" + uploadId + "." + ext;
  }

  try{
    await env.IMAGES.put(objectKey, bytes, {
      httpMetadata: {
        contentType: contentType,
        // Unique key per upload (never overwritten), so a long immutable
        // cache is safe — R2's public bucket serves this header.
        cacheControl: "public, max-age=31536000, immutable"
      }
    });
  }catch(e){
    return jsonResponse({status:"error", message:"Upload failed — could not store the image."}, 502);
  }

  const rawBase = String(env.R2_PUBLIC_BASE).replace(/\/+$/, "");
  const base = /^https?:\/\//i.test(rawBase) ? rawBase : "https://" + rawBase;
  const responseUrl = base + "/" + objectKey;
  const body = {status:"ok", url: responseUrl};
  if(uploadId) body.uploadId = uploadId;
  return jsonResponse(body);
}

export async function onRequestGet(){
  return jsonResponse({status:"error", message:"Use POST."}, 405);
}
