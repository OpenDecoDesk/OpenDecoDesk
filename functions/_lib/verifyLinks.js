// Design-verification links (functions/api/verify.js, upload-verify.js)
// stop working this long after they're sent, so an old email can't be used
// to change an order's approval status months later. The admin can always
// send a fresh one.
export const VERIFY_LINK_TTL_DAYS = 60;

export function verificationExpired(row, now = Date.now()) {
  const sent = Date.parse((row && row.sentAt) || "");
  return Number.isFinite(sent) && now - sent > VERIFY_LINK_TTL_DAYS * 24 * 3600 * 1000;
}

// Customer response images must be ones uploaded through /api/upload-verify
// (our public R2 base + /verify/), not arbitrary links that would then be
// shown in the admin panel and the owner's roll-up email.
export function isOwnVerifyImage(env, url) {
  const raw = String((env && env.R2_PUBLIC_BASE) || "").replace(/\/+$/, "");
  if (!raw) return false;
  const base = (/^https?:\/\//i.test(raw) ? raw : "https://" + raw) + "/verify/";
  return typeof url === "string" && url.startsWith(base) && /^[a-z0-9]{1,64}\.(jpg|png|webp|gif)$/.test(url.slice(base.length));
}
