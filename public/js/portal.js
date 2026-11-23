(function () {
  'use strict';
  var P = window.HGGPricing;
  var grid = document.getElementById('portal-grid');
  var cartBody = document.getElementById('cart-body');
  var saveEl = document.getElementById('portal-save');
  var ordersEl = document.getElementById('orders-list');
  if (!P || !grid || !cartBody) return;

  var pct = P.WHOLESALE_PERCENT_OFF_DEFAULT;
  var displayBtn = document.getElementById('add-display');

  function fmt(c) { return P.formatCents(c); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function loadCart() { try { return JSON.parse(localStorage.getItem('hgd_cart') || 'null') || { items: [] }; } catch (e) { return { items: [] }; } }
  function saveCart(c) { try { localStorage.setItem('hgd_cart', JSON.stringify(c)); } catch (e) {} }

  function boxesOf(c, flavor) {
    var i = c.items.find(function (x) { return x.flavor === flavor; });
    return i ? i.qty : 0;
  }

  function setBoxes(flavor, qty) {
    var c = loadCart();
    qty = Math.max(0, Math.min(P.MAX_BOXES_PER_FLAVOR, Math.round(qty) || 0));
    c.items = c.items.filter(function (x) { return x.flavor !== flavor; });
    if (qty > 0) c.items.push({ flavor: flavor, qty: qty });
    saveCart(c);
    render();
  }

  /** A display is one box of each flavor - 3 boxes, 45 packs. */
  function addDisplay() {
    var c = loadCart();
    var atMax = c.items.some(function (x) { return x.qty >= P.MAX_BOXES_PER_FLAVOR; }) || P.FLAVORS.length > 0 && P.FLAVORS.some(function (f) { return boxesOf(c, f.id) + 1 > P.MAX_BOXES_PER_FLAVOR; });
    if (atMax) { alert('That is the most boxes we can take in one order.'); return; }
    P.FLAVORS.forEach(function (f) {
      var q = boxesOf(c, f.id) + 1;
      c.items = c.items.filter(function (x) { return x.flavor !== f.id; });
      c.items.push({ flavor: f.id, qty: q });
    });
    saveCart(c);
    render();
  }

  function renderGrid(c) {
    var boxC = P.boxCentsFor(pct);
    var cards = P.FLAVORS.map(function (f) {
      var qty = boxesOf(c, f.id);
      var avif = f.image.replace(/\.webp$/, '.avif');
      return '<article class="product-card" data-card="' + f.id + '">'
        + '<picture><source type="image/avif" srcset="' + avif + '"><img src="' + f.image + '" alt="' + esc(f.name) + '"></picture>'
        + '<h3>' + esc(f.name) + '</h3>'
        + '<p class="wprice"><b>' + fmt(boxC) + '</b> / box <small>(' + P.PACKS_PER_BOX + ' packs)</small></p>'
        + '<p class="wprice-sub"><s>' + fmt(P.PACKS_PER_BOX * P.BASE_UNIT_CENTS) + '</s> retail &middot; ' + pct + '% off</p>'
        + '<div class="buy-row">'
        + '<div class="stepper"><button type="button" data-dec="' + f.id + '" aria-label="Decrease ' + esc(f.name) + ' boxes">&minus;</button>'
        + '<input type="number" inputmode="numeric" min="0" max="' + P.MAX_BOXES_PER_FLAVOR + '" value="' + qty + '" data-qty="' + f.id + '" aria-label="' + esc(f.name) + ' boxes">'
        + '<button type="button" data-inc="' + f.id + '" aria-label="Increase ' + esc(f.name) + ' boxes">+</button></div>'
        + '<button type="button" class="btn btn-red" data-add="' + f.id + '">Add box</button>'
        + '</div>'
        + '<p class="packs-under">' + (qty ? qty + ' box' + (qty === 1 ? '' : 'es') + ' = ' + qty * P.PACKS_PER_BOX + ' packs' : '&nbsp;') + '</p>'
        + '</article>';
    }).join('');
    grid.innerHTML = cards;
  }

  function renderCart(c) {
    var q = P.quoteWholesale(c.items, pct);
    saveEl.hidden = true;
    if (!q.totalBoxes) {
      cartBody.innerHTML = '<p class="cart-empty">Your cart is empty. A box is ' + P.PACKS_PER_BOX + ' packs of one flavor.</p>';
      return;
    }
    saveEl.hidden = false;
    saveEl.innerHTML = 'Saving <b>' + fmt(q.savingsCents) + '</b> vs retail &mdash; <b>' + pct + '% off</b> every box.';
    var lines = q.lines.map(function (l) {
      return '<li><span>' + esc(l.name) + ' &times; ' + l.boxes + ' box' + (l.boxes === 1 ? '' : 'es')
        + ' <small>(' + l.packs + ' packs)</small></span><span>' + fmt(l.lineCents) + '</span></li>';
    }).join('');
    var displayNote = q.displays > 0
      ? '<p class="cart-packs"><b>' + q.displays + '</b> full display' + (q.displays === 1 ? '' : 's') + ' (' + q.displays * P.PACKS_PER_DISPLAY + ' packs)'
        + (q.totalBoxes > q.displays * P.BOXES_PER_DISPLAY ? ' + ' + (q.totalBoxes - q.displays * P.BOXES_PER_DISPLAY) + ' loose box' + (q.totalBoxes - q.displays * P.BOXES_PER_DISPLAY === 1 ? '' : 'es') : '')
        + '</p>'
      : '<p class="cart-packs">' + q.totalBoxes + ' box' + (q.totalBoxes === 1 ? '' : 'es') + ' &middot; add one box of each flavor for a full display</p>';
    cartBody.innerHTML = '<ul class="cart-lines">' + lines + '</ul>'
      + displayNote
      + '<dl class="totals">'
      + '<div><dt>Subtotal <small>(' + q.totalPacks + ' packs)</small></dt><dd>' + fmt(q.subtotalCents) + '</dd></div>'
      + '<div><dt>Retail</dt><dd class="muted"><s>' + fmt(q.listCents) + '</s></dd></div>'
      + '<div><dt>Shipping <small>(flat rate)</small></dt><dd>' + fmt(q.shippingCents) + '</dd></div>'
      + '<div class="grand"><dt>Total</dt><dd>' + fmt(q.totalCents) + '</dd></div>'
      + '</dl>'
      + '<button type="button" class="btn btn-red btn-block btn-xl" id="checkout-btn">Checkout</button>'
      + '<p class="muted" style="font-size:12.5px;margin:10px 0 0;">Secure checkout by Stripe. Tax is calculated at checkout.</p>';
    var cb = document.getElementById('checkout-btn');
    if (cb) cb.addEventListener('click', checkout);
  }

  function checkout() {
    var c = loadCart();
    if (!c.items.length) return;
    var btn = document.getElementById('checkout-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Starting checkout...'; }
    window.hgd.api('/api/checkout', { method: 'POST', body: JSON.stringify({ items: c.items }) }).then(function (r) {
      if (r.ok && r.data.url) { window.location.href = r.data.url; return; }
      if (btn) { btn.disabled = false; btn.textContent = 'Checkout'; }
      if (r.data && r.data.code === 'checkout_unavailable') { saveEl.hidden = false; saveEl.innerHTML = r.data.message || 'Checkout opens soon.'; }
      else alert((r.data && r.data.error) || 'Could not start checkout.');
    }).catch(function () { if (btn) { btn.disabled = false; btn.textContent = 'Checkout'; } alert('No connection - try again.'); });
  }

  function renderOrders(orders) {
    if (!orders || !orders.length) { ordersEl.innerHTML = '<p class="muted-block">No orders yet.</p>'; return; }
    ordersEl.innerHTML = orders.map(function (o) {
      var items = (Array.isArray(o.items) ? o.items : []).map(function (i) {
        var f = P.flavorById(i.flavor);
        return (f ? f.name : i.flavor) + ' &times; ' + i.qty + ' box' + (i.qty === 1 ? '' : 'es');
      }).join(', ');
      var d = new Date(o.created_at);
      var when = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      return '<div class="order-row"><div><div class="or-items">' + esc(items) + '</div><div class="or-date">' + esc(when) + '</div></div><div class="or-total">' + fmt(o.total_cents) + '</div></div>';
    }).join('');
  }

  function render() {
    var c = loadCart();
    renderGrid(c);
    renderCart(c);
  }

  grid.addEventListener('click', function (e) {
    var t = e.target.closest('[data-inc],[data-dec],[data-add]');
    if (!t) return;
    var flavor = t.getAttribute('data-inc') || t.getAttribute('data-dec') || t.getAttribute('data-add');
    var q = boxesOf(loadCart(), flavor);
    if (t.hasAttribute('data-inc')) setBoxes(flavor, q + 1);
    else if (t.hasAttribute('data-dec')) setBoxes(flavor, q - 1);
    else setBoxes(flavor, q + 1);
  });
  grid.addEventListener('input', function (e) {
    var t = e.target.closest('[data-qty]');
    if (!t) return;
    setBoxes(t.getAttribute('data-qty'), parseInt(t.value, 10) || 0);
  });
  if (displayBtn) displayBtn.addEventListener('click', addDisplay);

  // Boot: confirm the session, get the wholesale percent, load orders.
  window.hgd.api('/api/me').then(function (r) {
    if (!r.ok) { window.location.href = '/login?next=/portal'; return; }
    pct = Number(r.data.wholesalePercentOff) || P.WHOLESALE_PERCENT_OFF_DEFAULT;
    if (r.data.user && r.data.user.name) { var n = document.getElementById('portal-user-name'); if (n) n.textContent = r.data.user.name; }
    render();
    return window.hgd.api('/api/orders');
  }).then(function (r) {
    if (r && r.ok) renderOrders(r.data.orders);
  }).catch(function () { render(); });
})();
