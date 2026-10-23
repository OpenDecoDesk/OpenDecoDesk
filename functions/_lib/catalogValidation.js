// Server-side checks for admin-supplied org/product fields that end up in storefront HTML
// (image URLs in <img src>/<a href>, the accent color in a style, ids in subdomains and
// data-* attributes). The admin forms check the same things in the browser, but that is only
// convenience — these run on every createOrg/updateOrg/createProduct/updateProduct, so a
// hand-crafted request can't store a javascript: link or a CSS-breaking "color".

import { RESERVED_SUBDOMAINS } from "./hostConfig.js";

export const ORG_ID_RE = /^[a-z0-9-]{2,40}$/;
export const SUBDOMAIN_RE = /^[a-z0-9]{2,40}$/;
export const PRODUCT_ID_RE = /^[a-z0-9-]{1,40}$/;

const MAX_URL_LEN = 500;

// An image URL is either absolute http(s) (R2 public base, an external host) or a site-relative
// path like "images/foo.jpg". Anything else — javascript:/data:/vbscript:, a scheme hidden behind
// whitespace or control characters, protocol-relative "//host", or a backslash (browsers treat
// "/\host" as "//host") — is refused. Returns the trimmed URL, "" for blank, or null if unsafe.
export function cleanImageUrl(url) {
  const s = String(url == null ? "" : url).trim();
  if (!s) return "";
  if (s.length > MAX_URL_LEN || /[\u0000-\u001f\u007f\\<>"'`]/.test(s)) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return (u.protocol === "https:" || u.protocol === "http:") && u.hostname ? s : null;
    } catch (_) { return null; }
  }
  if (s.startsWith("//") || s.includes(":")) return null;
  return s;
}

// A CSS color: #hex, a named color, or rgb()/rgba()/hsl()/hsla() with only numeric arguments.
// Never ; { } quotes or anything else that could escape a style declaration.
export function isValidAccent(v) {
  const s = String(v || "").trim();
  return s.length <= 40 && /^(#[0-9a-f]{3,8}|[a-z]{3,30}|(rgba?|hsla?)\([0-9.,%\s\/a-z]{1,40}\))$/i.test(s);
}

// Validates an org create/update body. `isCreate` also checks orgId (it's fixed after creation).
// Returns {error} or {fields} with the cleaned image URLs.
export function validateOrgFields(body, isCreate) {
  if (isCreate && !ORG_ID_RE.test(String(body.orgId || ""))) {
    return { error: "Org ID must be 2-40 lowercase letters, numbers, or hyphens." };
  }
  // "all" is the admin's All-shops Orders page (#orders/all), so it can't be a shop's id.
  if (isCreate && String(body.orgId) === "all") return { error: "“all” is reserved — pick another Org ID." };
  if (body.subdomain && !SUBDOMAIN_RE.test(String(body.subdomain))) {
    return { error: "Subdomain must be 2-40 lowercase letters or numbers (no hyphens)." };
  }
  if (body.subdomain && RESERVED_SUBDOMAINS.includes(String(body.subdomain))) {
    return { error: `“${body.subdomain}” is reserved — pick another web address.` };
  }
  if (body.accent && !isValidAccent(body.accent)) {
    return { error: "Accent must be a valid CSS color (e.g. #1E7A4C, navy, rgb(30,122,76))." };
  }
  const images = {};
  for (const k of ["designImageShirtUrl", "designImageCapUrl", "designImageDetailUrl"]) {
    const u = cleanImageUrl(body[k]);
    if (u === null) return { error: "Image URLs must start with https:// (or be a site path like images/foo.jpg)." };
    images[k] = u;
  }
  return { fields: images };
}

// Validates a product create/update body's image list. Returns {error} or {images}.
export function validateProductImages(images) {
  if (images == null) return { images: [] };
  if (!Array.isArray(images) || images.length > 20) return { error: "Images must be a list of up to 20 URLs." };
  const out = [];
  for (const raw of images) {
    const u = cleanImageUrl(raw);
    if (u === null) return { error: "Image URLs must start with https:// (or be a site path like images/foo.jpg)." };
    if (u) out.push(u);
  }
  return { images: out };
}
