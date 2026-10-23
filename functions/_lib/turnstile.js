/**
 * Cloudflare Turnstile server-side verification (free bot check).
 * ========================================================================
 * Order submission sends an "order received" email to whatever address the
 * submitter typed. Without a bot check, a script can spam arbitrary inboxes
 * through the shop's sending domain and burn the sending quota and
 * reputation real customers need. Turnstile stops that without a CAPTCHA puzzle.
 *
 * Opt-in: enforced only when TURNSTILE_SECRET_KEY is set (dashboard env
 * var, encrypted). TURNSTILE_SITE_KEY (plain env var) is handed to the
 * storefront via /api/catalog so the widget renders. Set BOTH together.
 * Once enabled this FAILS CLOSED — a missing/invalid token or an
 * unreachable siteverify endpoint rejects the order submission.
 */

export function turnstileEnabled(env){
  return !!env.TURNSTILE_SECRET_KEY;
}

// Returns {ok:true} or {ok:false, message}.
export async function verifyTurnstile(env, token, request){
  if(!turnstileEnabled(env)) return { ok: true };
  if(typeof token !== "string" || !token || token.length > 2048){
    return { ok: false, message: "Bot check missing — please try again." };
  }
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY);
  form.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if(ip) form.append("remoteip", ip);
  try{
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const data = await res.json();
    if(data && data.success === true) return { ok: true };
    console.error("Turnstile rejected:", data && data["error-codes"]);
    return { ok: false, message: "Bot check failed — please refresh the page and try again." };
  }catch(err){
    console.error("Turnstile siteverify unreachable:", err);
    return { ok: false, message: "Bot check unavailable — please try again in a moment." };
  }
}
