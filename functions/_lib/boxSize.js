/**
 * Box selection for shipping rate quotes and label purchases.
 *
 * When DB-backed presets are provided, uses their per-type capacity fields
 * (maxShirts, maxCaps, maxSweatshirts) — smallest fitting preset wins.
 * Falls back to hardcoded defaults when no presets with capacity data exist.
 *
 * Returns { box:{length,width,height}, packing } or null when the order
 * doesn't fit any defined configuration (admin will send shipping separately).
 *
 * Type classification: a product's category says which limit it counts against
 * (product_categories.packAs, passed in as `packAs` = { <category key>: class }).
 * A type that isn't in that map — an old order line, or a caller that doesn't
 * pass the map — falls back to keyword matching on the type string.
 */

const FALLBACK_BOXES = [
  {
    l: "12", w: "9", h: "2", packing: 1.50,
    fits(s, sw, c) {
      return (s <= 2 && sw === 0 && c === 0) || (sw === 1 && s === 0 && c === 0);
    },
  },
  {
    l: "12", w: "9", h: "4", packing: 2.00,
    fits(s, sw, c) {
      return (sw === 1 && s === 0 && c === 0) ||
             (s <= 4 && sw === 0 && c === 0) ||
             (c <= 10 && sw === 0 && s === 0);
    },
  },
  {
    l: "12", w: "12", h: "12", packing: 2.50,
    fits(s, sw, c) {
      return (sw <= 3 && s === 0 && c === 0) ||
             (s <= 6 && sw === 0 && c === 0) ||
             (c <= 20 && sw === 0 && s === 0) ||
             (s <= 2 && c <= 10 && sw === 0);
    },
  },
];

function classifyType(type, packAs) {
  const t = String(type || "").toLowerCase();
  if (packAs && Object.prototype.hasOwnProperty.call(packAs, t)) return packAs[t];
  if (/sweatshirt|hoodie|crewneck|fleece/.test(t)) return "sweatshirt";
  if (/shirt|tee|polo|jersey/.test(t))             return "shirt";
  if (/cap|hat|beanie|visor/.test(t))              return "cap";
  return "other";
}

/**
 * Given an array of {type, qty} items and an optional array of DB-backed
 * presets (from getBoxPresets), returns { box:{length,width,height}, packing }
 * for the smallest fitting box, or null if no box fits.
 */
const DEFAULT_ITEM_WEIGHT_OZ = 8;

export function selectBox(items, presets, packAs) {
  let shirts = 0, sweatshirts = 0, caps = 0, other = 0, totalWeightOz = 0;
  for (const item of items) {
    // Whole pieces only. A storefront cart arrives here already checked (lineQty in db.js), so the box
    // is picked for the same count the quote is signed for. A count that isn't a whole number is
    // never rounded into one: such a cart has no box (null), the same as a cart nothing fits.
    if (item.qty != null && !(Number.isInteger(item.qty) && item.qty > 0)) return null;
    const qty = item.qty == null ? 1 : item.qty;
    const wt  = (typeof item.weightOz === "number" && item.weightOz > 0) ? item.weightOz : DEFAULT_ITEM_WEIGHT_OZ;
    totalWeightOz += wt * qty;
    switch (classifyType(item.type || item.productType || "", packAs)) {
      case "shirt":      shirts      += qty; break;
      case "sweatshirt": sweatshirts += qty; break;
      case "cap":        caps        += qty; break;
      default:           other       += qty;
    }
  }
  if (other > 0) return null;

  // Use DB presets when at least one has capacity data configured.
  const capacityPresets = (presets || []).filter(
    p => p.maxShirts != null || p.maxCaps != null || p.maxSweatshirts != null || p.maxWeightOz != null
  );
  if (capacityPresets.length > 0) {
    for (const p of capacityPresets) {
      const ok = (p.maxShirts == null || shirts <= p.maxShirts)
              && (p.maxCaps == null || caps <= p.maxCaps)
              && (p.maxSweatshirts == null || sweatshirts <= p.maxSweatshirts)
              && (p.maxWeightOz == null || totalWeightOz <= p.maxWeightOz);
      if (ok) return {
        box: { length: String(p.length), width: String(p.width), height: String(p.height) },
        packing: p.packingCost || 0,
        boxWeightOz: p.boxWeightOz || 0,
      };
    }
    return null;
  }

  // Fallback to hardcoded defaults.
  for (const box of FALLBACK_BOXES) {
    if (box.fits(shirts, sweatshirts, caps)) {
      return { box: { length: box.l, width: box.w, height: box.h }, packing: box.packing };
    }
  }
  return null;
}
