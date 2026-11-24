/*
 * The landing's only cart job: keep the steppers working and the numbers honest,
 * so a DSD can build an order here and find it waiting after they log in.
 * The landing itself is not an ordering surface - every buy path goes to /login.
 * The signed-in shop uses portal.js instead.
 */
(function () {
  'use strict';
  var P = window.HGGPricing;
  if (!P) return;

  var KEY = 'hgd_cart';

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null') || { items: [] }; }
    catch (e) { return { items: [] }; }
  }
  function save(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) {} }
  function boxesOf(c, flavor) {
    var i = c.items.find(function (x) { return x.flavor === flavor; });
    return i ? i.qty : 0;
  }

  function syncCard(flavor) {
    var qty = boxesOf(load(), flavor);
    var input = document.querySelector('[data-qty="' + flavor + '"]');
    if (input && document.activeElement !== input) input.value = qty;
    var note = document.querySelector('[data-note="' + flavor + '"]');
    if (note) {
      note.textContent = qty
        ? qty + ' box' + (qty === 1 ? '' : 'es') + ' = ' + qty * P.PACKS_PER_BOX + ' packs'
        : '\u00a0';
    }
  }

  function setBoxes(flavor, qty) {
    var c = load();
    qty = Math.max(0, Math.min(P.MAX_BOXES_PER_FLAVOR, Math.round(qty) || 0));
    c.items = c.items.filter(function (x) { return x.flavor !== flavor; });
    if (qty > 0) c.items.push({ flavor: flavor, qty: qty });
    save(c);
    syncCard(flavor);
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-inc],[data-dec],[data-add]');
    if (!t) return;
    var flavor = t.getAttribute('data-inc') || t.getAttribute('data-dec') || t.getAttribute('data-add');
    var q = boxesOf(load(), flavor);
    if (t.hasAttribute('data-dec')) setBoxes(flavor, q - 1);
    else setBoxes(flavor, q + 1);
  });

  document.addEventListener('input', function (e) {
    var t = e.target.closest('[data-qty]');
    if (!t) return;
    setBoxes(t.getAttribute('data-qty'), parseInt(t.value, 10) || 0);
  });

  // Paint any cart already sitting in storage.
  P.FLAVORS.forEach(function (f) { syncCard(f.id); });
})();
