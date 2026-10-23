// Copies one vendor image into the shop's public image bucket (IMAGES) — the fallback for an image a vendor
// lists that isn't in the local bulk-image download the admin picked. Normally images go through the admin's
// own upload (resized in the browser by /api/upload). Same rules as upload.js: real raster images only,
// checked by magic bytes, 5 MB at most (read under the cap, never buffered whole first), and the object key is
// made here — the caller never picks it.
import { readBodyWithLimit, hasValidMagicBytes } from "./fileUpload.js";

const TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
export const VENDOR_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export async function copyVendorImage(env, url, fetchImpl = fetch) {
  if (!env.IMAGES || !env.R2_PUBLIC_BASE) return { ok: false, message: "Image storage isn't set up on this site." };
  let u;
  try { u = new URL(String(url || "")); } catch { return { ok: false, message: "That isn't a web address." }; }
  if (u.protocol !== "https:" || u.username || u.password) return { ok: false, message: "Only https image links can be downloaded." };
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/i.test(u.hostname) || !u.hostname.includes(".")) return { ok: false, message: "That address can't be downloaded." };
  let res;
  try { res = await fetchImpl(u.toString(), { redirect: "follow", headers: { Accept: "image/*" } }); }
  catch (e) { return { ok: false, message: "The vendor's server couldn't be reached." }; }
  if (!res.ok) return { ok: false, message: `The vendor's server answered ${res.status}.` };
  const type = String(res.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const ext = TYPES[type];
  if (!ext) return { ok: false, message: "That link isn't a JPEG, PNG, WebP or GIF image." };
  const read = await readBodyWithLimit(res, VENDOR_IMAGE_MAX_BYTES).catch(() => null);
  if (!read) return { ok: false, message: "The image couldn't be read." };
  if (read.tooLarge) return { ok: false, message: "The image is over 5 MB — use the copy in your downloaded image folder instead." };
  if (!read.bytes || !read.bytes.byteLength || !hasValidMagicBytes(read.bytes, type)) return { ok: false, message: "The file isn't the image type it claims to be." };
  const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^a-z0-9]/gi, "").slice(0, 32).toLowerCase();
  const key = "uploads/blanks/" + id + "." + ext;
  try {
    await env.IMAGES.put(key, read.bytes, { httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" } });
  } catch (e) { return { ok: false, message: "The image couldn't be stored." }; }
  // Same base as upload.js: some environments hold R2_PUBLIC_BASE without the scheme.
  const rawBase = String(env.R2_PUBLIC_BASE).replace(/\/+$/, "");
  const base = /^https?:\/\//i.test(rawBase) ? rawBase : "https://" + rawBase;
  // The browser then makes its 320px thumbnail (…/<id>-thumb.<ext>, what thumbUrl() shows) through /api/upload?thumbFor=<id>.
  return { ok: true, url: base + "/" + key, id };
}
