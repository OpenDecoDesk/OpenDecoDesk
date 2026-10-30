/**
 * The desktop edition's start-up step (desktop/, hostConfig.js isDesktopEdition).
 * ========================================================================
 * Run by src/worker.js before the first request a desktop install answers, and once more after
 * any failure. It makes the database fit the desktop program, every time it starts:
 *
 *   - The features that need the internet (desktopLockedFeatures: the storefront, carrier shipping
 *     while there is no Shippo key, and design approval while email isn't set up) are saved OFF.
 *     Saving them, rather than only hiding them, matters: the rules that live in SQL (featureOnSql_
 *     in db.js — which orders need an approval) read the saved value, and orders.js refuses to turn
 *     them back on. With a Shippo key carrier shipping, and with email design approval, are left as
 *     the owner set them.
 *   - There is always one shop. Orders, products and prices belong to a shop, and the desktop
 *     program has no shop pages to create one from, so a database with none gets a default shop,
 *     "My shop", which the owner renames under Shops like any other.
 *
 * Both are no-ops once done, so a normal start costs two small reads.
 */

import { desktopLockedFeatures } from "./hostConfig.js";
import { getFeatures, setFeatures, getAllOrgs, createOrg, bumpCatalogVersion, getSettingRaw, setSettingRaw, deleteSettingRaw } from "./db.js";

// The default shop. Card payments need Stripe, which the desktop program doesn't have.
export const DESKTOP_DEFAULT_SHOP = { orgId: "shop", subdomain: "shop", name: "My shop" };

export async function ensureDesktopReady(env) {
  const db = env.DB;
  let changed = false;
  const features = await getFeatures(db);
  const off = {};
  for (const k of desktopLockedFeatures(env)) if (features[k] !== false) off[k] = false;
  if (Object.keys(off).length) { await setFeatures(db, off); changed = true; }
  // Adding a Shippo key is asking for carrier shipping: the first start that has one turns Shipping
  // on (once — the owner can turn it off again, and it stays off). Without a key it's locked off
  // above, and the next key turns it on again.
  const keyed = !!(env && env.SHIPPO_API_KEY);
  const marked = (await getSettingRaw(db, "desktopShippoKeySeen")) === "1";
  if (keyed && !marked) {
    if (features.shipping === false) { await setFeatures(db, { shipping: true }); changed = true; }
    await setSettingRaw(db, "desktopShippoKeySeen", "1");
  } else if (!keyed && marked) await deleteSettingRaw(db, "desktopShippoKeySeen");
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
