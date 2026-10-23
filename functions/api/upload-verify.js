/**
 * Token-gated image upload for customer design-verification responses.
 * POST /api/upload-verify?token=TOKEN  (raw body = image bytes, Content-Type = image type)
 * Returns { status:"ok", url } on success.
 * No admin auth — only the verify token is checked (must be valid and pending).
 * Capped at MAX_UPLOADS_PER_TOKEN uploads per token (counted in D1).
 */

import { getDesignVerification, reserveVerificationUpload, releaseVerificationUpload } from "../_lib/db.js";
import { jsonResponse, featureIsOff } from "../_lib/http.js";
import { readBodyWithLimit, hasValidMagicBytes } from "../_lib/fileUpload.js";
import { verificationExpired } from "../_lib/verifyLinks.js";

const ALLOWED_TYPES = {
  "image/jpeg": "jpg",
  "image/png":  "png",
  "image/webp": "webp",
  "image/gif":  "gif",
};

const MAX_BYTES = 5 * 1024 * 1024;
// verify.js keeps at most 3 customer image URLs per response, so more than
// that per token is only ever storage abuse (R2 free tier is 10 GB). A few
// spare slots allow re-picking a photo before submitting.
const MAX_UPLOADS_PER_TOKEN = 6;

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return jsonResponse({ status: "error", message: "Server misconfigured" }, 500);
  if (await featureIsOff(env, "designVerification")) {
    return jsonResponse({ status: "error", feature: "designVerification", message: "Design approval isn't available right now. Please contact us about your order." }, 403);
  }
  if (!env.IMAGES || !env.R2_PUBLIC_BASE) return jsonResponse({ status: "error", message: "Image storage not configured" }, 500);

  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  if (!token) return jsonResponse({ status: "error", message: "Missing token" }, 400);

  const row = await getDesignVerification(env.DB, token);
  if (!row) return jsonResponse({ status: "error", message: "Invalid token" }, 403);
  if (row.status !== "pending") return jsonResponse({ status: "error", message: "This verification is already closed" }, 409);
  if (verificationExpired(row)) return jsonResponse({ status: "error", message: "This link has expired — contact us for a new one." }, 410);

  const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const ext = ALLOWED_TYPES[contentType];
  if (!ext) return jsonResponse({ status: "error", message: "Unsupported image type — use JPEG, PNG, WebP, or GIF." }, 400);

  let result;
  try { result = await readBodyWithLimit(request, MAX_BYTES); }
  catch { return jsonResponse({ status: "error", message: "Could not read the uploaded file." }, 400); }

  if (result.tooLarge) return jsonResponse({ status: "error", message: "Image is too large (max 5 MB)." }, 400);
  const bytes = result.bytes;
  if (!bytes || bytes.byteLength === 0) return jsonResponse({ status: "error", message: "No file uploaded." }, 400);
  // The bytes must really be the declared image type — these land in the
  // PUBLIC images bucket, served with the declared content type.
  if (!hasValidMagicBytes(bytes, contentType)) {
    return jsonResponse({ status: "error", message: "File content does not match the declared image type." }, 415);
  }

  if (!(await reserveVerificationUpload(env.DB, token, MAX_UPLOADS_PER_TOKEN))) {
    return jsonResponse({ status: "error", message: "Upload limit reached for this verification." }, 429);
  }

  const raw = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
  const uploadId = raw.replace(/[^a-z0-9]/gi, "").slice(0, 32).toLowerCase();
  const objectKey = "verify/" + uploadId + "." + ext;

  try {
    await env.IMAGES.put(objectKey, bytes, {
      httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
    });
  } catch {
    try { await releaseVerificationUpload(env.DB, token); } catch (_) {}
    return jsonResponse({ status: "error", message: "Upload failed" }, 502);
  }

  const rawBase = String(env.R2_PUBLIC_BASE).replace(/\/+$/, "");
  const base = /^https?:\/\//i.test(rawBase) ? rawBase : "https://" + rawBase;
  return jsonResponse({ status: "ok", url: base + "/" + objectKey });
}

export async function onRequestGet() {
  return jsonResponse({ status: "error", message: "Use POST." }, 405);
}
