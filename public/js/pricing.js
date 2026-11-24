/*
 * HELLA GOOD! pricing rules - one file shared by the browser (display only)
 * and the server (the source of truth for every charge).
 * All money is in integer cents.
 *
 * Retail (D2C): sold by the single pack, tiered (see quote()).
 * Wholesale (DSD): NEVER single packs. Sold by the BOX - 15 packs of one flavor.
 * A retail display holds 3 boxes, one of each flavor, so 45 packs.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HGGPricing = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BASE_UNIT_CENTS = 599;
  const SHIPPING_CENTS = 799;
  const MIN_QTY = 1;
  const MAX_QTY_PER_FLAVOR = 100;

  // Wholesale units. A DSD orders boxes; a display is three boxes (one per flavor).
  const PACKS_PER_BOX = 15;
  const BOXES_PER_DISPLAY = 3;
  const PACKS_PER_DISPLAY = PACKS_PER_BOX * BOXES_PER_DISPLAY; // 45
  const MIN_BOXES = 1;
  const MAX_BOXES_PER_FLAVOR = 90;

  const FLAVORS = Object.freeze([
    { id: 'blue-razz', name: 'Razzilicious', color: 'turquoise', image: '/images/pack-razzilicious.webp', boxImage: '/images/box-razzilicious.webp' },
    { id: 'strawberry-lemonade', name: 'Strawberry Lemonade', color: 'red', image: '/images/pack-strawberry-lemonade.webp', boxImage: '/images/box-strawberry-lemonade.webp' },
    { id: 'orange-pineapple-mango', name: 'Orange Pineapple Mango', color: 'orange', image: '/images/pack-orange-pineapple-mango.webp', boxImage: '/images/box-orange-pineapple-mango.webp' },
  ]);

  // Highest threshold first. Flavors mix and match toward the tier. (Retail only.)
  const TIERS = Object.freeze([
    { minPacks: 15, percentOff: 20 },
    { minPacks: 5, percentOff: 10 },
    { minPacks: 1, percentOff: 0 },
  ]);

  function unitCentsFor(percentOff) {
    return Math.round((BASE_UNIT_CENTS * (100 - percentOff)) / 100);
  }

  function tierFor(totalPacks) {
    for (const t of TIERS) {
      if (totalPacks >= t.minPacks) return { ...t, unitCents: unitCentsFor(t.percentOff) };
    }
    return { minPacks: 0, percentOff: 0, unitCents: BASE_UNIT_CENTS };
  }

  /** The next tier up (or null when already at the top tier). */
  function nextTier(totalPacks) {
    const up = TIERS.filter((t) => t.minPacks > totalPacks && t.percentOff > 0);
    if (!up.length) return null;
    const t = up[up.length - 1];
    return { ...t, unitCents: unitCentsFor(t.percentOff), packsNeeded: t.minPacks - totalPacks };
  }

  function flavorById(id) {
    return FLAVORS.find((f) => f.id === id) || null;
  }

  /**
   * Validate a DSD cart ({items:[{flavor, qty}]}). `qty` is BOXES, not packs.
   * Returns {ok, items} or {ok:false, error}. Rejects unknown flavors, duplicate
   * flavors, non-integers and quantities outside 1..MAX_BOXES_PER_FLAVOR.
   */
  function validateItems(items) {
    if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'Your cart is empty.' };
    if (items.length > FLAVORS.length) return { ok: false, error: 'Too many cart lines.' };
    const seen = new Set();
    const clean = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') return { ok: false, error: 'Invalid cart item.' };
      const flavor = flavorById(item.flavor);
      if (!flavor) return { ok: false, error: 'Unknown flavor.' };
      if (seen.has(flavor.id)) return { ok: false, error: 'Each flavor can appear only once.' };
      seen.add(flavor.id);
      const qty = item.qty;
      if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < MIN_BOXES || qty > MAX_BOXES_PER_FLAVOR) {
        return { ok: false, error: `Boxes of ${flavor.name} must be a whole number from ${MIN_BOXES} to ${MAX_BOXES_PER_FLAVOR}.` };
      }
      clean.push({ flavor: flavor.id, qty });
    }
    return { ok: true, items: clean };
  }

  /** Price a validated retail cart. Shipping is a flat rate per order. */
  function quote(items) {
    const totalPacks = items.reduce((n, i) => n + i.qty, 0);
    const tier = tierFor(totalPacks);
    const lines = items.map((i) => {
      const flavor = flavorById(i.flavor);
      return {
        flavor: flavor.id,
        name: flavor.name,
        qty: i.qty,
        unitCents: tier.unitCents,
        lineCents: tier.unitCents * i.qty,
      };
    });
    const subtotalCents = lines.reduce((n, l) => n + l.lineCents, 0);
    const listCents = totalPacks * BASE_UNIT_CENTS;
    const shippingCents = totalPacks > 0 ? SHIPPING_CENTS : 0;
    return {
      totalPacks,
      tier,
      next: nextTier(totalPacks),
      lines,
      listCents,
      savingsCents: listCents - subtotalCents,
      subtotalCents,
      shippingCents,
      totalCents: subtotalCents + shippingCents,
    };
  }

  /** DSDs get a flat percent off every pack - no tiers, no mix-and-match thresholds. */
  const WHOLESALE_PERCENT_OFF_DEFAULT = 25;

  function wholesaleUnitCentsFor(percentOff) {
    return Math.round((BASE_UNIT_CENTS * (100 - percentOff)) / 100);
  }

  /** One box: 15 packs of one flavor. */
  function boxCentsFor(percentOff) {
    return wholesaleUnitCentsFor(percentOff) * PACKS_PER_BOX;
  }

  /** One display: three boxes, one per flavor (45 packs). */
  function displayCentsFor(percentOff) {
    return boxCentsFor(percentOff) * BOXES_PER_DISPLAY;
  }

  /**
   * Price a validated DSD cart of boxes. The server calls this; the browser shows it.
   * A complete display needs at least one box of each flavor.
   */
  function quoteWholesale(items, percentOff = WHOLESALE_PERCENT_OFF_DEFAULT) {
    const boxCents = boxCentsFor(percentOff);
    const lines = items.map((i) => {
      const flavor = flavorById(i.flavor);
      return {
        flavor: flavor.id,
        name: flavor.name,
        boxes: i.qty,
        qty: i.qty,
        packs: i.qty * PACKS_PER_BOX,
        unitCents: boxCents,
        lineCents: boxCents * i.qty,
      };
    });
    const totalBoxes = lines.reduce((n, l) => n + l.boxes, 0);
    const totalPacks = lines.reduce((n, l) => n + l.packs, 0);
    const subtotalCents = lines.reduce((n, l) => n + l.lineCents, 0);
    const listCents = totalPacks * BASE_UNIT_CENTS;
    const shippingCents = totalBoxes > 0 ? SHIPPING_CENTS : 0;
    // Whole displays = the boxes you have of every flavor (so 2/2/1 is one display + one loose box).
    const perFlavor = FLAVORS.map((f) => {
      const line = lines.find((l) => l.flavor === f.id);
      return line ? line.boxes : 0;
    });
    return {
      totalBoxes,
      totalPacks,
      displays: Math.min(...perFlavor),
      boxCents,
      displayCents: boxCents * BOXES_PER_DISPLAY,
      unitCents: boxCents,
      percentOff,
      lines,
      listCents,
      savingsCents: listCents - subtotalCents,
      subtotalCents,
      shippingCents,
      totalCents: subtotalCents + shippingCents,
    };
  }

  function nudge(totalPacks) {
    const n = nextTier(totalPacks);
    if (totalPacks <= 0) return 'Mix any 5 packs to save 10%. 15+ packs saves 20%.';
    if (!n) return `You're saving 20%, the best price per pack.`;
    const packs = n.packsNeeded === 1 ? '1 more pack' : `${n.packsNeeded} more packs`;
    return `Add ${packs} to save ${n.percentOff}%.`;
  }

  function formatCents(c) {
    return '$' + (c / 100).toFixed(2);
  }

  return {
    BASE_UNIT_CENTS,
    SHIPPING_CENTS,
    MIN_QTY,
    MAX_QTY_PER_FLAVOR,
    PACKS_PER_BOX,
    BOXES_PER_DISPLAY,
    PACKS_PER_DISPLAY,
    MIN_BOXES,
    MAX_BOXES_PER_FLAVOR,
    FLAVORS,
    TIERS,
    unitCentsFor,
    tierFor,
    nextTier,
    flavorById,
    validateItems,
    quote,
    nudge,
    formatCents,
    WHOLESALE_PERCENT_OFF_DEFAULT,
    wholesaleUnitCentsFor,
    boxCentsFor,
    displayCentsFor,
    quoteWholesale,
  };
});
