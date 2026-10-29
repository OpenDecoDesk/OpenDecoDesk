/**
 * The desktop edition's start-up step (desktop/, hostConfig.js isDesktopEdition).
 * ========================================================================
 * Run by src/worker.js before the first request a desktop install answers, and once more after
 * any failure. It makes the database fit the desktop program, every time it starts:
 *
 *   - The features that need the internet (DESKTOP_LOCKED_FEATURES: the storefront, carrier
 *     shipping, emailed design approval) are saved OFF. Saving them, rather than only hiding them,
 *     matters: the rules that live in SQL (featureOnSql_ in db.js — which orders need an approval)
 *     read the saved value, and orders.js refuses to turn them back on.
 *   - There is always one shop. Orders, products and prices belong to a shop, and the desktop
 *     program has no shop pages to create one from, so a database with none gets a default shop,
 *     "My shop", which the owner renames under Shops like any other.
 *
 * Both are no-ops once done, so a normal start costs two small reads.
 */

import { DESKTOP_LOCKED_FEATURES } from "./hostConfig.js";
import { getFeatures, setFeatures, getAllOrgs, createOrg, bumpCatalogVersion } from "./db.js";

// The default shop. Card payments need Stripe, which the desktop program doesn't have.
export const DESKTOP_DEFAULT_SHOP = { orgId: "shop", subdomain: "shop", name: "My shop" };

export async function ensureDesktopReady(env) {
  const db = env.DB;
  let changed = false;
  const features = await getFeatures(db);
  const off = {};
  for (const k of DESKTOP_LOCKED_FEATURES) if (features[k] !== false) off[k] = false;
  if (Object.keys(off).length) { await setFeatures(db, off); changed = true; }
  if (!(await getAllOrgs(db)).length) {
    try {
      await createOrg(db, { ...DESKTOP_DEFAULT_SHOP, ready: true, shippingEnabled: false,
        enabledPayments: { card: false, venmo: true, zelle: true, check: true } });
      changed = true;
    } catch (e) {
      // Two first requests at once: the other one made it (the orgId is the primary key).
      if (!/UNIQUE|constraint/i.test(String(e && e.message))) throw e;
    }
  }
  // The switches and the shop list travel in the cached catalog: a new version makes it re-read.
  if (changed) await bumpCatalogVersion(db);
  return { changed };
}
