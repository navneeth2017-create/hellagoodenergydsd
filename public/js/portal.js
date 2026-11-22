(function () {
  'use strict';
  var P = window.HGGPricing;
  var grid = document.getElementById('portal-grid');
  var cartBody = document.getElementById('cart-body');
  var saveEl = document.getElementById('portal-save');
  var ordersEl = document.getElementById('orders-list');
  if (!P || !grid || !cartBody) return;

  var pct = P.WHOLESALE_PERCENT_OFF_DEFAULT;

  function fmt(c) { return P.formatCents(c); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function loadCart() { try { return JSON.parse(localStorage.getItem('hgd_cart') || 'null') || { items: [] }; } catch (e) { return { items: [] }; } }
  function saveCart(c) { try { localStorage.setItem('hgd_cart', JSON.stringify(c)); } catch (e) {} }

  function cartQty(c, flavor) { var i = c.items.find(function (x) { return x.flavor === flavor; }); return i ? i.qty : 0; }

  function setQty(flavor, qty) {
    var c = loadCart();
    qty = Math.max(0, Math.min(100, Math.round(qty) || 0));
    if (qty === 0) c.items = c.items.filter(function (i) { return i.flavor !== flavor; });
    else { var f = c.items.find(function (i) { return i.flavor === flavor; }); if (f) f.qty = qty; else c.items.push({ flavor: flavor, qty: qty }); }
    saveCart(c);
    render();
  }

  function renderGrid(c) {
    var unit = P.wholesaleUnitCentsFor(pct);
    grid.innerHTML = P.FLAVORS.map(function (f) {
      var qty = cartQty(c, f.id);
      var avif = f.image.replace(/\.webp$/, '.avif');
      return '<article class="product-card">'
        + '<picture><source type="image/avif" srcset="' + avif + '"><img src="' + f.image + '" alt="' + esc(f.name) + '"></picture>'
        + '<h3>' + esc(f.name) + '</h3>'
        + '<p class="wprice"><b>' + fmt(unit) + '</b> / pack <s>' + fmt(P.BASE_UNIT_CENTS) + '</s></p>'
        + '<div class="buy-row">'
        + '<div class="stepper"><button type="button" data-dec="' + f.id + '" aria-label="Decrease ' + esc(f.name) + '">&minus;</button>'
        + '<input type="number" inputmode="numeric" min="0" max="100" value="' + qty + '" data-qty="' + f.id + '" aria-label="' + esc(f.name) + ' quantity">'
        + '<button type="button" data-inc="' + f.id + '" aria-label="Increase ' + esc(f.name) + '">+</button></div>'
        + '<button type="button" class="btn btn-red" data-add="' + f.id + '">Add</button>'
        + '</div></article>';
    }).join('');
  }

  function renderCart(c) {
    var totalPacks = c.items.reduce(function (n, i) { return n + i.qty; }, 0);
    saveEl.hidden = true;
    if (!totalPacks) {
      cartBody.innerHTML = '<p class="cart-empty">Your cart is empty. Pick a flavor above.</p>';
      return;
    }
    var q = P.quoteWholesale(c.items, pct);
    saveEl.hidden = false;
    saveEl.innerHTML = 'Saving <b>' + fmt(q.savingsCents) + '</b> vs retail &mdash; <b>' + pct + '% off</b> every pack.';
    var lines = q.lines.map(function (l) {
      return '<li><span>' + esc(l.name) + ' &times; ' + l.qty + '</span><span>' + fmt(l.lineCents) + '</span></li>';
    }).join('');
    cartBody.innerHTML = '<ul class="cart-lines">' + lines + '</ul>'
      + '<dl class="totals">'
      + '<div><dt>Subtotal</dt><dd>' + fmt(q.subtotalCents) + '</dd></div>'
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
    if (btn) { btn.disabled = true; btn.textContent = 'Starting checkout…'; }
    window.hgd.api('/api/checkout', { method: 'POST', body: JSON.stringify({ items: c.items }) }).then(function (r) {
      if (r.ok && r.data.url) { window.location.href = r.data.url; return; }
      if (btn) { btn.disabled = false; btn.textContent = 'Checkout'; }
      if (r.data && r.data.code === 'checkout_unavailable') { saveEl.hidden = false; saveEl.innerHTML = r.data.message || 'Checkout opens soon.'; }
      else alert((r.data && r.data.error) || 'Could not start checkout.');
    }).catch(function () { if (btn) { btn.disabled = false; btn.textContent = 'Checkout'; } alert('No connection — try again.'); });
  }

  function renderOrders(orders) {
    if (!orders || !orders.length) { ordersEl.innerHTML = '<p class="muted-block">No orders yet.</p>'; return; }
    ordersEl.innerHTML = orders.map(function (o) {
      var items = (Array.isArray(o.items) ? o.items : []).map(function (i) {
        var f = P.flavorById(i.flavor);
        return (f ? f.name : i.flavor) + ' &times; ' + i.qty;
      }).join(', ');
      var d = new Date(o.created_at);
      var when = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
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
    var q = cartQty(loadCart(), flavor);
    if (t.hasAttribute('data-inc')) setQty(flavor, q + 1);
    else if (t.hasAttribute('data-dec')) setQty(flavor, q - 1);
    else setQty(flavor, q + 1);
  });
  grid.addEventListener('input', function (e) {
    var t = e.target.closest('[data-qty]');
    if (!t) return;
    setQty(t.getAttribute('data-qty'), parseInt(t.value, 10) || 0);
  });

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
