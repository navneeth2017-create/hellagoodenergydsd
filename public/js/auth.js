/* Shared DSD helpers: JSON API fetch + sign-out. Loaded on every portal page. */
(function () {
  'use strict';

  function api(url, opts) {
    opts = opts || {};
    return fetch(url, Object.assign({}, opts, {
      headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
    })).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data || {} };
      });
    });
  }

  function logout() {
    return api('/api/logout', { method: 'POST' }).then(function () { window.location.href = '/login'; });
  }

  window.hgd = { api: api, logout: logout };

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-logout]') : null;
    if (el) { e.preventDefault(); logout(); }
  });
})();
