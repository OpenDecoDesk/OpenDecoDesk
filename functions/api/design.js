// Design files (embroidery files for a design version) and order line-item customization
// uploads — stored in the PRIVATE R2 bucket bound as DESIGNS (never public: designs are the
// shop's own IP, and a line-item upload may be a customer's personal photo). Admin-only,
// admin-subdomain-only, same gate as every other admin endpoint (requireAdmin). Mirrors
// receipt.js closely.
//
//   POST ?designId=<id>&role=<design|machine>&ext=<dst|emb|...>&name=<original file name>,
//     body = the file bytes → {status, key, name, ext}. A design VERSION requires two files —
//     role=design (the native, editable design-software project file, e.g. .emb/.jdx) and
//     role=machine (the actual stitch file a machine runs, e.g. .dst/.exp) — uploaded as two
//     separate POSTs; role restricts which extensions are accepted (below). An embroidery
//     file's Content-Type is unreliable (browsers report application/octet-stream for most of
//     these), so the extension is taken from the client-supplied ?ext= and validated against a
//     known list rather than read from Content-Type; there's no reliable magic-byte signature
//     for these formats either, so the size cap + admin auth is the safety net here (not a
//     content check).
//   POST ?itemId=<id>&ext=...&name=..., body = the file bytes → same shape, no role — a
//     line-item customization upload may be either an embroidery file (any of the extensions
//     below, either role) or an image (jpeg/png/webp/gif — Content-Type + magic bytes ARE
//     checked here, since those formats do have a reliable signature).
//
//   POST, Content-Type application/json {key} → {status, url}
//     A signed, 60-second link for downloading it (GET below) — a POST so the admin cookie's
//     same-origin CSRF check applies; the link opens in a new tab with the file's own headers.
//
//   GET ?key&exp&sig → the file (admin subdomain only; HMAC-checked, expires in 60 s, never
//     cached).

import { classifyHost } from "../_lib/hostConfig.js";
import { requireAdmin, timingSafeEqual } from "../_lib/adminAuth.js";
import { jsonResponse, featureOffResponse, featureIsOff } from "../_lib/http.js";
import { readBodyWithLimit, hasValidMagicBytes } from "../_lib/fileUpload.js";

// Embroidery file formats: ANY embroidery extension is accepted. There are dozens of
// formats across brands, so instead of an allowlist a file is accepted when its extension is a plain
// 1–10 letter/digit word that isn't a known non-embroidery type (web pages, scripts, programs,
// images, documents, archives — NOT_EMBROIDERY_EXTS). The two roles still can't be swapped for the
// formats we know: a known stitch format can't be the Design (native project) file and a known
// project format can't be the Machine file — "Send design to machine" relies on the machine file
// being a stitch file. An unknown extension is trusted to be what the admin says it is. A line-item
// upload (itemId, no role) accepts any embroidery file or an image.
const DESIGN_NATIVE_EXTS = new Set(["emb", "jdx", "art", "ofm", "pxf"]);
const MACHINE_STITCH_EXTS = new Set(["dst", "dsb", "dsz", "pes", "pec", "exp", "vp3", "vip", "xxx", "hus", "jef", "sew", "csd", "shv", "u01", "edr", "pcs", "pcm", "tap", "tbf", "fdr", "ksm", "10o", "gt", "inb", "max", "emd", "new", "stx", "sst", "phb", "phc"]);
const NOT_EMBROIDERY_EXTS = new Set([
  "html", "htm", "xhtml", "shtml", "mht", "svg", "svgz", "xml", "xsl", "js", "mjs", "cjs", "css", "json", "wasm",
  "php", "phtml", "asp", "aspx", "jsp", "cgi", "pl", "py", "rb", "sh", "bash", "zsh", "ps1", "psm1", "vbs", "vbe", "wsf", "hta",
  "exe", "com", "bat", "cmd", "msi", "msp", "dll", "scr", "cpl", "jar", "app", "dmg", "pkg", "deb", "rpm", "apk", "lnk", "reg",
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "ico", "pdf", "doc", "docx", "docm", "xls", "xlsx", "xlsm",
  "ppt", "pptx", "rtf", "txt", "csv", "zip", "rar", "7z", "gz", "tar", "iso"]);
export const isEmbroideryExt = (ext) => /^[a-z0-9]{1,10}$/.test(ext) && !NOT_EMBROIDERY_EXTS.has(ext);
const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const IMAGE_EXTS = new Set(Object.values(IMAGE_TYPES));

const MAX_BYTES = 20 * 1024 * 1024;
const LINK_TTL_SECONDS = 60;
export const DESIGN_KEY_RE = /^(designs|order-files)\/[a-z0-9-]+\/[a-z0-9]{32}\.[a-z0-9]{1,10}$/;

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();

  // Back office work: any signed-in user (functions/_lib/adminAuth.js).
  const denied = await requireAdmin(env, classifyHost(url.hostname, null, env), request.headers.get("X-Admin-Key"), request, "Not available here.", "staff");
  if (denied) return denied;
  if (!env.DESIGNS) return jsonResponse({ status: "error", message: "Design storage isn't set up (DESIGNS bucket binding)." }, 500);
  // Global settings → Features → Production switched off: embroidery design files (a design
  // version's files, an order-specific design) can't be uploaded or fetched. A line item's plain
  // attachments (order-files/…, no role) are part of the order and stay available.
  const productionOff = await featureIsOff(env, "production");

  // ---- View ----
  if (contentType === "application/json") {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ status: "error", message: "Invalid JSON" }, 400); }
    const key = String((body && body.key) || "");
    if (!DESIGN_KEY_RE.test(key)) return jsonResponse({ status: "error", message: "Invalid file reference" }, 400);
    if (productionOff && key.startsWith("designs/")) return featureOffResponse("production", "Production");
    const secret = linkSecret(env);
    if (!secret) return jsonResponse({ status: "error", message: "No signing secret configured" }, 500);
    const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
    const sig = await hmacHex(secret, key + "|" + exp);
    return jsonResponse({ status: "ok", url: `/api/design?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}` });
  }

  // ---- Upload ----
  const designId = url.searchParams.get("designId") || "";
  const itemId = url.searchParams.get("itemId") || "";
  if (!designId && !itemId) return jsonResponse({ status: "error", message: "Missing designId or itemId" }, 400);
  if (designId && !/^\d+$/.test(designId)) return jsonResponse({ status: "error", message: "Invalid designId" }, 400);
  if (itemId && !/^\d+$/.test(itemId)) return jsonResponse({ status: "error", message: "Invalid itemId" }, 400);

  const reqExt = String(url.searchParams.get("ext") || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const isImage = IMAGE_TYPES[contentType] === reqExt;
  const isEmbroidery = !isImage && isEmbroideryExt(reqExt);
  const roleParam = url.searchParams.get("role") || "";
  if (productionOff && (designId || roleParam)) return featureOffResponse("production", "Production");
  if (designId || roleParam) {
    // A design version's two files are role-restricted — and so are an order-specific design's
    // (a line-item upload that names a role, migrations/0032): any embroidery format, but a known
    // stitch format can't be the native project file and a known project format can't be the
    // machine file — this is what lets "Send design to machine" trust it has the right kind of file.
    const role = roleParam;
    if (role !== "design" && role !== "machine") {
      return jsonResponse({ status: "error", message: "Missing or invalid role (must be 'design' or 'machine')." }, 400);
    }
    if (!isEmbroideryExt(reqExt)) {
      return jsonResponse({ status: "error", message: `A .${reqExt || "?"} file isn't an embroidery file.` }, 400);
    }
    if (role === "design" && MACHINE_STITCH_EXTS.has(reqExt)) {
      return jsonResponse({ status: "error", message: `A .${reqExt} is a machine stitch file — the Design file must be the native design format (the editable project file). Upload the .${reqExt} as the Machine file.` }, 400);
    }
    if (role === "machine" && DESIGN_NATIVE_EXTS.has(reqExt)) {
      return jsonResponse({ status: "error", message: `A .${reqExt} is a design-software project file — the Machine file must be a stitch format the machine runs (e.g. .dst, .dsb, .pes).` }, 400);
    }
  } else if (!isImage && !isEmbroidery) {
    return jsonResponse({ status: "error", message: "Unsupported file type." }, 400);
  }

  let result;
  try { result = await readBodyWithLimit(request, MAX_BYTES); }
  catch { return jsonResponse({ status: "error", message: "Could not read the uploaded file." }, 400); }
  if (result.tooLarge) return jsonResponse({ status: "error", message: "File is too large (max 20 MB)." }, 400);
  const bytes = result.bytes;
  if (!bytes || bytes.byteLength === 0) return jsonResponse({ status: "error", message: "No file uploaded." }, 400);
  if (isImage && !hasValidMagicBytes(bytes, contentType)) {
    return jsonResponse({ status: "error", message: "File content does not match its declared image type." }, 415);
  }

  const id = crypto.randomUUID().replace(/[^a-z0-9]/gi, "").slice(0, 32).toLowerCase();
  const prefix = designId ? `designs/${designId}` : `order-files/${itemId}`;
  const key = `${prefix}/${id}.${reqExt}`;
  const name = String(url.searchParams.get("name") || "").replace(/[^\w .()-]/g, "").trim().slice(0, 120) || `file.${reqExt}`;
  try {
    await env.DESIGNS.put(key, bytes, { httpMetadata: { contentType: isImage ? contentType : "application/octet-stream" }, customMetadata: { name } });
  } catch {
    return jsonResponse({ status: "error", message: "Upload failed — could not store the file." }, 502);
  }
  return jsonResponse({ status: "ok", key, name, ext: reqExt });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (classifyHost(url.hostname, null, env).kind !== "admin" || !env.DESIGNS) return notFound();
  const key = url.searchParams.get("key") || "", exp = Number(url.searchParams.get("exp")), sig = url.searchParams.get("sig") || "";
  const now = Math.floor(Date.now() / 1000);
  const secret = linkSecret(env);
  if (!secret || !DESIGN_KEY_RE.test(key) || !Number.isInteger(exp) || exp < now || exp > now + LINK_TTL_SECONDS + 5) return notFound();
  if (!timingSafeEqual(sig, await hmacHex(secret, key + "|" + exp))) return notFound();
  const obj = await env.DESIGNS.get(key);
  if (!obj) return notFound();
  const name = (obj.customMetadata && obj.customMetadata.name) || key.split("/").pop();
  const headers = {
    "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
    "Content-Security-Policy": "default-src 'none'",
  };
  return new Response(obj.body, { headers });
}

// A signed, 60-second site-relative download path for a stored design file, or "" when no signing
// secret is configured / the key isn't a design key. Used by the agent relay (api/agent.js) to mint
// the link at the moment the local agent claims a send job, so a queued job never carries a stale one.
export async function signedDesignPath(env, key) {
  const secret = linkSecret(env);
  if (!secret || !DESIGN_KEY_RE.test(String(key || ""))) return "";
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
  const sig = await hmacHex(secret, key + "|" + exp);
  return `/api/design?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`;
}

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
  const k = await crypto.subtle.importKey("raw", enc.encode("odd-design-view:" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(data));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, "0")).join("");
}
