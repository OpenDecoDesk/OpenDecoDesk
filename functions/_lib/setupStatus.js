/**
 * Setup status — what a fresh install still needs, for Tools → Global settings → Setup status.
 *
 * A new install works with almost nothing configured, and most missing pieces fail quietly (no
 * email is sent, a picture can't be uploaded, a card payment isn't recorded). This list makes them
 * visible. It reports ONLY whether each thing is set — never a value: no key, token, passphrase or
 * id leaves this function, and the provider names it mentions ("Resend") are not secrets.
 *
 * setupStatus(env, settings) is pure: `env` is the Worker's environment, `settings` is what the
 * caller read from the database ({ business, salesTax, locale }). Each item is
 *   { key, label, ready, level, affects, note }
 *     level:   "required" (the site doesn't work without it), "recommended" (something visible is
 *              missing), or "optional" (a service you may not want)
 *     affects: one line on what works or doesn't
 *     note:    extra detail when half-configured, or which provider is in use ("" otherwise)
 * No imports, so every test harness can load it on its own.
 */

const set = (v) => v != null && String(v).trim() !== "";
// The placeholder hostConfig.js falls back to when ROOT_DOMAIN isn't set.
const PLACEHOLDER_ROOT = "example.com";
// The send-agent relay refuses a shorter token (functions/api/agent.js).
const MIN_AGENT_TOKEN = 32;

export function setupStatus(env, settings) {
  env = env || {};
  const { business = {}, salesTax = {}, locale = {} } = settings || {};
  const items = [];
  const add = (key, label, level, ready, affects, note) => items.push({ key, label, level, ready: !!ready, affects, note: note || "" });
  // The desktop edition (hostConfig.js isDesktopEdition, repeated so this file keeps no imports): no
  // domain, email, buckets or online services to set up — the desktop program provides the
  // database, the files and the secrets itself — so only what the person running it must fill in.
  if (String(env.EDITION || "").trim().toLowerCase() === "desktop") {
    add("database", "Database", "required", !!(env.DB && typeof env.DB.prepare === "function"), "Everything: orders, shops, products, settings.");
    addBusiness_(add, business, env);
    addSalesTax_(add, salesTax);
    addTimeZone_(add, locale, env);
    return items;
  }

  const root = String(env.ROOT_DOMAIN || "").trim().toLowerCase();
  add("rootDomain", "Root domain", "required", set(root) && root !== PLACEHOLDER_ROOT,
    "Which addresses are the admin and the shops, and the links in emails. Without it only the placeholder example.com is recognised.",
    set(root) ? "" : "ROOT_DOMAIN is not set.");

  add("database", "Database", "required", !!(env.DB && typeof env.DB.prepare === "function"), "Everything: orders, shops, products, settings.");

  const signing = set(env.SIGNING_SECRET), signingFallback = set(env.LINK_SIGNING_SECRET) || set(env.QUOTE_SIGNING_SECRET) || set(env.STRIPE_SECRET_KEY);
  add("signingSecret", "Signing secret", "required", signing || signingFallback,
    "Signs carrier shipping quotes and the short-lived links that open receipts and design files. Without one, those are refused.",
    signing ? "" : signingFallback ? "SIGNING_SECRET is not set; an older fallback secret is being used instead. Set SIGNING_SECRET." : "SIGNING_SECRET is not set.");

  const resend = set(env.RESEND_API_KEY), cfBinding = !!(env.EMAIL && typeof env.EMAIL.send === "function");
  const cfToken = set(env.CF_EMAIL_API_TOKEN), cfAccount = set(env.CF_ACCOUNT_ID);
  add("email", "Email", "recommended", resend || cfBinding || (cfToken && cfAccount),
    "Order confirmations, design proofs, shipped notices and the morning roll-up. Without a provider no email is sent at all (each attempt is listed as a problem on Communications).",
    resend ? "Sending through Resend." : cfBinding ? "Sending through Cloudflare Email Service (binding)." : (cfToken && cfAccount) ? "Sending through Cloudflare Email Service (API token)."
      : cfToken ? "CF_EMAIL_API_TOKEN is set but CF_ACCOUNT_ID is not — both are needed." : "Set RESEND_API_KEY, or CF_EMAIL_API_TOKEN with CF_ACCOUNT_ID. The sending domain must also be verified with the provider (this page can't check that).");

  // File storage (Cloudflare R2) is optional: an install without it works, minus uploads. The one
  // case worth a nudge is a pictures bucket that is there but has no public address yet.
  const NO_STORAGE = "No file storage on this install. To add it, switch on R2 in the Cloudflare dashboard and run `npm run setup` again.";
  const imagesBucket = !!env.IMAGES, publicBase = set(env.R2_PUBLIC_BASE);
  add("images", "Images bucket", imagesBucket && !publicBase ? "recommended" : "optional", imagesBucket && publicBase,
    "Uploading product and shop pictures, and pictures customers attach to a design approval. Without it, products have no pictures.",
    imagesBucket && publicBase ? "" : !imagesBucket ? NO_STORAGE : "R2_PUBLIC_BASE (the bucket's public address) is not set, so uploads are refused.");
  add("receipts", "Receipts bucket", "optional", !!env.RECEIPTS, "Attaching receipts to expenses and vendor invoices to stock received (private files).", env.RECEIPTS ? "" : NO_STORAGE);
  add("designs", "Designs bucket", "optional", !!env.DESIGNS, "Embroidery design files and files attached to order lines (private files).", env.DESIGNS ? "" : NO_STORAGE);

  addBusiness_(add, business, env);
  addSalesTax_(add, salesTax);
  addTimeZone_(add, locale, env);

  const sk = set(env.STRIPE_SECRET_KEY), wh = set(env.STRIPE_WEBHOOK_SECRET);
  add("stripe", "Card payments (Stripe)", "optional", sk && wh,
    "Paying by card at checkout and the payment links you email. Without it, Card isn't offered.",
    sk && wh ? "" : sk ? "The key is set but STRIPE_WEBHOOK_SECRET is not: cards can be charged, but the payments are not recorded on their orders." : wh ? "STRIPE_WEBHOOK_SECRET is set but STRIPE_SECRET_KEY is not." : "");

  add("shippo", "Carrier shipping (Shippo)", "optional", set(env.SHIPPO_API_KEY),
    "Shipping rates at checkout, buying labels, and the daily tracking check. Without it, shops offer pickup and flat-fee delivery only.");

  const tsSecret = set(env.TURNSTILE_SECRET_KEY), tsSite = set(env.TURNSTILE_SITE_KEY);
  add("turnstile", "Bot check on orders (Turnstile)", "optional", tsSecret && tsSite,
    "Refuses orders placed by scripts. Without it, order submission is only rate-limited.",
    tsSecret && tsSite ? "" : tsSecret ? "TURNSTILE_SECRET_KEY is set without TURNSTILE_SITE_KEY: the check can't be shown, so EVERY order is refused. Set the site key or remove the secret."
      : tsSite ? "TURNSTILE_SITE_KEY is set without TURNSTILE_SECRET_KEY, so the check is off." : "");

  const team = set(env.ACCESS_TEAM_DOMAIN), aud = set(env.ACCESS_AUD);
  add("access", "Cloudflare Access for the admin", "optional", team && aud,
    "Cloudflare's own sign-in in front of the admin, on top of each user's. Without it, each user's email, password and two-step code are the sign-in.",
    team && aud ? "" : (team || aud) ? "Only one of ACCESS_TEAM_DOMAIN / ACCESS_AUD is set, so Access is not being checked." : "");

  const cdBase = set(env.CF_API_TOKEN) && set(env.CF_ACCOUNT_ID) && set(env.CF_ZONE_ID);
  const cdTarget = set(env.CF_WORKER_NAME) || set(env.CF_PAGES_PROJECT);
  add("customDomains", "Automatic hostnames for new shops", "optional", cdBase && cdTarget,
    "Attaching a new shop's address when you create it. Without it, add each shop's hostname by hand.",
    cdBase && cdTarget ? "" : (set(env.CF_API_TOKEN) || set(env.CF_ZONE_ID) || cdTarget) ? "Needs all of CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID and CF_WORKER_NAME — at least one is missing." : "");

  const token = String(env.AGENT_TOKEN || "");
  add("agentRelay", "Send-agent relay", "optional", token.length >= MIN_AGENT_TOKEN && !!env.AGENT_MAILBOX,
    "Using embroidery machines from a phone or tablet, through the separate send-agent program. Not needed otherwise.",
    token && token.length < MIN_AGENT_TOKEN ? "AGENT_TOKEN is shorter than " + MIN_AGENT_TOKEN + " characters, so the relay is off." : "");

  add("cronSecret", "Manual roll-up key", "optional", set(env.CRON_SECRET),
    "Only for starting the morning roll-up by hand (POST /api/daily-digest). The scheduled roll-up doesn't need it.");

  return items;
}

// The three settings both editions list. The desktop edition sends no email, so there the business
// profile only needs a name.
function addBusiness_(add, business, env) {
  if (String(env.EDITION || "").trim().toLowerCase() === "desktop") {
    add("business", "Business profile", "recommended", set(business.name),
      "Your business's name and address, printed on packing slips, invoices and reports. Without a name they say “Our shop”.",
      set(business.name) ? "" : "No business name yet (Business profile, below).");
    return;
  }
  const inbox = set(business.ownerEmail) || set(env.OWNER_EMAIL);
  add("business", "Business profile", "recommended", set(business.name) && inbox,
    "The name customers see and where notices to you are sent. Without a name the site says “Our shop”; without your inbox, notices go to owner@ your domain.",
    set(business.name) && inbox ? "" : !set(business.name) ? "No business name yet (Business profile, below)." : "No inbox for yourself yet (Business profile → Your inbox, below).");
}
function addSalesTax_(add, salesTax) {
  const rate = Number(salesTax.rateBps) || 0, home = set(salesTax.jurisdiction);
  add("salesTax", "Sales tax", "recommended", rate > 0 && home,
    "Whether sales tax is collected on orders and shown in the reports.",
    rate > 0 && home ? "" : rate > 0 ? "A rate is set but no home state, so no order counts as out of state." : "No rate is set, so no sales tax is collected. Leave it this way only if you don't collect any.");
}
function addTimeZone_(add, locale, env) {
  const desktop = String(env.EDITION || "").trim().toLowerCase() === "desktop";
  add("timeZone", "Time zone", "recommended", set(locale.timeZone) || set(env.TIMEZONE),
    desktop ? "The dates and times printed on orders and reports." : "The hour the morning roll-up arrives and the dates printed in emails.",
    set(locale.timeZone) ? "" : set(env.TIMEZONE) ? "Using the TIMEZONE variable." : "Not set, so UTC is used (Region, below).");
}

// Counts for a one-line summary: how many required / recommended things are still missing.
export function setupSummary(items) {
  const missing = (level) => items.filter(i => i.level === level && !i.ready).length;
  return { required: missing("required"), recommended: missing("recommended"), optional: missing("optional"), total: items.length };
}
