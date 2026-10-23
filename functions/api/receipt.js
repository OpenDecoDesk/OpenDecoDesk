// Expense receipts — stored in the PRIVATE R2 bucket bound as RECEIPTS
// (never public: receipts can show card digits and addresses; product images
// live in the public IMAGES bucket instead). Admin-only, admin-subdomain-only,
// same gate as every other admin endpoint (requireAdmin).
//
//   POST, body = the file bytes (Content-Type image/jpeg|png|webp or
//   application/pdf), ?name=<original file name> → {status, key, name}
//     Type checked against the file's first bytes; 10 MB cap enforced while
//     reading; the key is generated here (receipts/<year>/<random>.<ext>) —
//     the client never picks it and can't overwrite anything.
//
//   POST, Content-Type application/json {key} → {status, url}
//     A signed, 60-second link for viewing it (GET below). Asking for the link
//     is a POST so the admin cookie's same-origin CSRF check applies (browsers
//     don't send Origin on a GET navigation); the link itself then opens in a
//     new tab with the file's own headers — a blob: URL would inherit the admin
//     page's CSP (object-src 'none'), which stops PDFs from displaying.
//
//   GET ?key&exp&sig → the file (admin subdomain only; HMAC-checked, expires
//     in 60 s; never cached; images get a locked-down CSP).

import { classifyHost } from "../_lib/hostConfig.js";
import { requireAdmin, timingSafeEqual } from "../_lib/adminAuth.js";
import { jsonResponse, featureOffResponse, featureIsOff } from "../_lib/http.js";
import { readBodyWithLimit, hasValidMagicBytes } from "../_lib/fileUpload.js";

const TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
const EXT_TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf" };
const MAX_BYTES = 10 * 1024 * 1024;
const LINK_TTL_SECONDS = 60;
export const RECEIPT_KEY_RE = /^receipts\/\d{4}\/[a-z0-9]{32}\.(jpg|png|webp|pdf)$/;

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();

  // Back office work: any signed-in user (functions/_lib/adminAuth.js).
  const denied = await requireAdmin(env, classifyHost(url.hostname, null, env), request.headers.get("X-Admin-Key"), request, "Not available here.", "staff");
  if (denied) return denied;
  // Global settings → Features → Bookkeeping switched off: no receipt uploads or links.
  if (await featureIsOff(env, "bookkeeping")) return featureOffResponse("bookkeeping", "Bookkeeping");
  if (!env.RECEIPTS) return jsonResponse({ status: "error", message: "Receipt storage isn't set up (RECEIPTS bucket binding)." }, 500);

  // ---- View ----
  if (contentType === "application/json") {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ status: "error", message: "Invalid JSON" }, 400); }
    const key = String((body && body.key) || "");
    if (!RECEIPT_KEY_RE.test(key)) return jsonResponse({ status: "error", message: "Invalid receipt reference" }, 400);
    const secret = linkSecret(env);
    if (!secret) return jsonResponse({ status: "error", message: "No signing secret configured" }, 500);
    const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
    const sig = await hmacHex(secret, key + "|" + exp);
    return jsonResponse({ status: "ok", url: `/api/receipt?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}` });
  }

  // ---- Upload ----
  const ext = TYPES[contentType];
  if (!ext) return jsonResponse({ status: "error", message: "Receipts must be a JPEG, PNG, WebP image or a PDF." }, 400);
  let result;
  try { result = await readBodyWithLimit(request, MAX_BYTES); }
  catch { return jsonResponse({ status: "error", message: "Could not read the uploaded file." }, 400); }
  if (result.tooLarge) return jsonResponse({ status: "error", message: "Receipt is too large (max 10 MB)." }, 400);
  const bytes = result.bytes;
  if (!bytes || bytes.byteLength === 0) return jsonResponse({ status: "error", message: "No file uploaded." }, 400);
  if (!hasValidMagicBytes(bytes, contentType)) {
    return jsonResponse({ status: "error", message: "File content does not match its type." }, 415);
  }
  const id = crypto.randomUUID().replace(/[^a-z0-9]/gi, "").slice(0, 32).toLowerCase();
  const key = `receipts/${new Date().getUTCFullYear()}/${id}.${ext}`;
  const name = String(url.searchParams.get("name") || "").replace(/[^\w .()-]/g, "").trim().slice(0, 120) || `receipt.${ext}`;
  try {
    await env.RECEIPTS.put(key, bytes, { httpMetadata: { contentType }, customMetadata: { name } });
  } catch {
    return jsonResponse({ status: "error", message: "Upload failed — could not store the receipt." }, 502);
  }
  return jsonResponse({ status: "ok", key, name });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (classifyHost(url.hostname, null, env).kind !== "admin" || !env.RECEIPTS) return notFound();
  const key = url.searchParams.get("key") || "", exp = Number(url.searchParams.get("exp")), sig = url.searchParams.get("sig") || "";
  const now = Math.floor(Date.now() / 1000);
  const secret = linkSecret(env);
  if (!secret || !RECEIPT_KEY_RE.test(key) || !Number.isInteger(exp) || exp < now || exp > now + LINK_TTL_SECONDS + 5) return notFound();
  if (!timingSafeEqual(sig, await hmacHex(secret, key + "|" + exp))) return notFound();
  const obj = await env.RECEIPTS.get(key);
  if (!obj) return notFound();
  const type = EXT_TYPES[key.split(".").pop()];
  const headers = {
    "Content-Type": type,
    "Content-Disposition": "inline",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
  };
  // Images can't run script anyway; lock them down fully. PDFs are left to
  // the browser's built-in viewer (a sandbox/object-src CSP blocks it).
  if (type !== "application/pdf") headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
  return new Response(obj.body, { headers });
}

// View links are signed with a key derived from an existing secret
// (label-separated, so it can't be confused with any other use of it).
function linkSecret(env) {
  // SIGNING_SECRET — the one random secret every signature on the site is made with (each use adds
  // its own label, so a quote signature can't pass as a download link). The older per-purpose secrets
  // and the Stripe key are only a fallback for an install that hasn't set it yet. Never the admin
  // passphrase: it's typed by a person (low entropy) and shouldn't double as an HMAC key.
  // The links only live 60 s, so rotating any of these just expires them.
  return env.SIGNING_SECRET || env.LINK_SIGNING_SECRET || env.QUOTE_SIGNING_SECRET || env.STRIPE_SECRET_KEY || "";
}
async function hmacHex(secret, data) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode("odd-receipt-view:" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(data));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, "0")).join("");
}
