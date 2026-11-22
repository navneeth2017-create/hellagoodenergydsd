(function () {
  'use strict';
  var dsdList = document.getElementById('dsd-list');
  var ordersList = document.getElementById('orders-list');
  if (!dsdList) return; // not the admin page

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(c) { return '$' + ((Number(c) || 0) / 100).toFixed(2); }
  function badge(status) {
    return '<span class="badge ' + status + '">' + (status === 'applied' ? 'Applied' : status === 'invited' ? 'Invited' : status === 'active' ? 'Active' : 'Disabled') + '</span>';
  }

  /* ---- tabs ---- */
  document.querySelectorAll('.admin-tabs [data-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.admin-tabs [data-tab]').forEach(function (x) { x.classList.remove('active'); });
      document.querySelectorAll('.admin-panel').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      var panel = document.querySelector('.admin-panel[data-panel="' + b.getAttribute('data-tab') + '"]');
      if (panel) panel.classList.add('active');
    });
  });

  /* ---- config ---- */
  function loadConfig() {
    window.hgd.api('/api/admin/config').then(function (r) {
      if (!r.ok) return;
      var input = document.getElementById('wholesale-pct');
      input.value = r.data.wholesalePercentOff;
      updateUnit(r.data.wholesalePercentOff);
    });
  }
  function updateUnit(pct) {
    var el = document.getElementById('config-unit');
    if (!el) return;
    var unit = Math.round((599 * (100 - pct)) / 100);
    el.textContent = 'DSD price: $' + (unit / 100).toFixed(2) + ' per pack (retail $5.99).';
  }
  var saveBtn = document.getElementById('save-pct');
  if (saveBtn) saveBtn.addEventListener('click', function () {
    var input = document.getElementById('wholesale-pct');
    var v = parseInt(input.value, 10);
    if (isNaN(v) || v < 0 || v > 90) { alert('Discount must be 0–90.'); return; }
    saveBtn.disabled = true;
    window.hgd.api('/api/admin/config', { method: 'PATCH', body: JSON.stringify({ wholesalePercentOff: v }) }).then(function (r) {
      saveBtn.disabled = false;
      if (r.ok) updateUnit(r.data.wholesalePercentOff);
      else alert((r.data && r.data.error) || 'Could not save.');
    });
  });
  var pctInput = document.getElementById('wholesale-pct');
  if (pctInput) pctInput.addEventListener('input', function () { updateUnit(parseInt(pctInput.value, 10) || 0); });

  /* ---- DSDs ---- */
  function loadDsds() {
    window.hgd.api('/api/admin/dsds').then(function (r) {
      if (!r.ok) return;
      var dsds = r.data.dsds || [];
      document.getElementById('dsd-empty').hidden = dsds.length > 0;
      dsdList.innerHTML = dsds.map(function (d) {
        var who = d.name || d.email;
        var actions = '';
        if (d.status === 'applied' || d.status === 'invited') actions += '<button class="btn btn-sm btn-red" data-act="approve" data-id="' + d.id + '">Approve</button>';
        if (d.status === 'active') actions += '<button class="btn btn-sm btn-outline" data-act="disable" data-id="' + d.id + '">Disable</button>';
        if (d.status === 'disabled') actions += '<button class="btn btn-sm btn-outline" data-act="enable" data-id="' + d.id + '">Enable</button>';
        var pct = d.wholesale_pct == null ? '' : d.wholesale_pct;
        return '<tr>'
          + '<td><b>' + esc(who) + '</b>' + (d.company ? '<div class="muted">' + esc(d.company) + '</div>' : '') + '<div class="muted">' + esc(d.email) + '</div></td>'
          + '<td>' + badge(d.status) + '</td>'
          + '<td class="num">' + d.orders + '</td>'
          + '<td class="num">' + money(d.total_cents) + '</td>'
          + '<td class="num"><input type="number" min="0" max="90" step="1" value="' + esc(pct) + '" data-pct="' + d.id + '" placeholder="—" style="width:64px;background:var(--bg);border:1px solid var(--line);border-radius:8px;color:var(--text);padding:6px 8px;font:inherit;font-size:13.5px;"></td>'
          + '<td><div class="row-actions">' + actions + '</div></td>'
          + '</tr>';
      }).join('');
    });
  }

  dsdList.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var id = b.getAttribute('data-id');
    var act = b.getAttribute('data-act');
    b.disabled = true;
    window.hgd.api('/api/admin/dsds/' + id + '/' + act, { method: 'POST' }).then(function (r) {
      if (!r.ok) alert((r.data && r.data.error) || 'Could not update.');
      loadDsds();
    });
  });
  dsdList.addEventListener('change', function (e) {
    var input = e.target.closest('[data-pct]');
    if (!input) return;
    var id = input.getAttribute('data-pct');
    var v = input.value.trim() === '' ? null : parseInt(input.value, 10);
    if (v !== null && (isNaN(v) || v < 0 || v > 90)) { loadDsds(); return; }
    window.hgd.api('/api/admin/dsds/' + id, { method: 'PATCH', body: JSON.stringify({ wholesale_pct: v }) }).then(function (r) { if (!r.ok) loadDsds(); });
  });

  /* ---- invite ---- */
  var inviteBtn = document.getElementById('invite-btn');
  if (inviteBtn) inviteBtn.addEventListener('click', function () {
    var email = document.getElementById('invite-email').value.trim();
    var name = document.getElementById('invite-name').value.trim();
    var company = document.getElementById('invite-company').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { alert('Enter a valid email.'); return; }
    inviteBtn.disabled = true;
    window.hgd.api('/api/admin/dsds', { method: 'POST', body: JSON.stringify({ email: email, name: name, company: company }) }).then(function (r) {
      inviteBtn.disabled = false;
      if (r.ok) {
        var link = document.getElementById('invite-link');
        link.hidden = false;
        link.textContent = 'Send this link: ' + window.location.origin + r.data.invite_url;
        document.getElementById('invite-email').value = '';
        document.getElementById('invite-name').value = '';
        document.getElementById('invite-company').value = '';
        loadDsds();
      } else alert((r.data && r.data.error) || 'Could not invite.');
    });
  });

  /* ---- orders ---- */
  function loadOrders() {
    window.hgd.api('/api/admin/orders').then(function (r) {
      if (!r.ok) return;
      var orders = r.data.orders || [];
      document.getElementById('orders-empty').hidden = orders.length > 0;
      ordersList.innerHTML = orders.map(function (o) {
        var items = (Array.isArray(o.items) ? o.items : []).map(function (i) { return i.qty + '&times; ' + esc(i.flavor); }).join(', ');
        var d = new Date(o.created_at);
        var when = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        return '<tr><td>' + esc(when) + '</td><td>' + esc(o.who || o.email) + '</td><td class="muted">' + items + '</td>'
          + '<td class="num">' + money(o.subtotal_cents) + '</td><td class="num">' + money(o.shipping_cents) + '</td><td class="num">' + money(o.tax_cents) + '</td><td class="num"><b>' + money(o.total_cents) + '</b></td></tr>';
      }).join('');
    });
  }

  // Boot: confirm admin, then load everything.
  window.hgd.api('/api/me').then(function (r) {
    if (!r.ok || !r.data.user || r.data.user.role !== 'admin') { window.location.href = '/login?next=/admin'; return; }
    loadConfig();
    loadDsds();
    loadOrders();
  });
})();
