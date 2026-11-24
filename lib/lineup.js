'use strict';
/*
 * The Line Up: the three flavor boxes, as cards.
 *
 * Built on the server so the products are already in the HTML. The browser only
 * has to wire up the steppers and the cart - a failed script can no longer leave
 * the page with an empty product grid, and the cards render with JS off.
 */
const pricing = require('../public/js/pricing.js');

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const money = (cents) => pricing.formatCents(cents);

/** "2 boxes = 30 packs" - or a non-breaking space, so the card height never jumps. */
function qtyNote(qty) {
  if (!qty) return '&nbsp;';
  return `${qty} box${qty === 1 ? '' : 'es'} = ${qty * pricing.PACKS_PER_BOX} packs`;
}

function card(flavor, { boxCents, listCents, qty, signedIn }) {
  const name = esc(flavor.name);
  const boxAvif = flavor.boxImage.replace(/\.webp$/, '.avif');
  const perBox = pricing.PACKS_PER_BOX;

  // Signed in: the real stepper. Signed out: one honest way forward.
  const buy = signedIn
    ? `<div class="buy-row">
          <div class="stepper sm">
            <button type="button" data-dec="${flavor.id}" aria-label="One less box of ${name}">&minus;</button>
            <input type="number" inputmode="numeric" min="0" max="${pricing.MAX_BOXES_PER_FLAVOR}" step="1" value="${qty}" data-qty="${flavor.id}" aria-label="Boxes of ${name}">
            <button type="button" data-inc="${flavor.id}" aria-label="One more box of ${name}">+</button>
          </div>
          <button type="button" class="btn btn-flavor" data-add="${flavor.id}">Add box</button>
        </div>
        <p class="flavor-tierhint" data-note="${flavor.id}">${qtyNote(qty)}</p>`
    : `<a class="btn btn-flavor" href="/login?next=/portal">Log in to order</a>
        <p class="flavor-tierhint">&nbsp;</p>`;

  return `<article class="flavor-card" data-color="${flavor.color}" data-card="${flavor.id}">
        <div class="flavor-img">
          <picture>
            <source type="image/avif" srcset="${boxAvif}">
            <img src="${flavor.boxImage}" alt="HELLA GOOD! ${name} box, ${perBox} packs" loading="lazy" decoding="async">
          </picture>
        </div>
        <div class="flavor-body">
          <h3 class="flavor-name">${name}</h3>
          <p class="flavor-spec"><strong>${perBox} packs</strong> &middot; one flavor</p>
          <p class="flavor-price">
            <span class="price-now">${money(boxCents)}</span>
            <span class="price-was">${money(listCents)}</span>
            <span class="price-unit">/ box</span>
          </p>
          ${buy}
        </div>
      </article>`;
}

/**
 * @param {object} opts
 * @param {number} opts.pct        wholesale percent off retail
 * @param {boolean} opts.signedIn  whether to render the cart stepper or a login link
 * @param {Record<string, number>} [opts.quantities]  boxes already in the cart, per flavor
 */
function cardsHtml({ pct, signedIn = false, quantities = {} } = {}) {
  const boxCents = pricing.boxCentsFor(pct);
  const listCents = pricing.PACKS_PER_BOX * pricing.BASE_UNIT_CENTS;
  return pricing.FLAVORS.map((f) => card(f, { boxCents, listCents, qty: quantities[f.id] || 0, signedIn })).join('\n      ');
}

module.exports = { cardsHtml, qtyNote, money };
