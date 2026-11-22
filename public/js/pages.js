/* Small helpers for the /success and /cancel pages of the DSD portal. */
(function () {
  'use strict';
  var page = document.body.getAttribute('data-page');

  if (page === 'success') {
    // The order went through: empty the saved DSD cart (and the legacy D2C key).
    try { localStorage.removeItem('hgd_cart'); } catch (e) { /* storage blocked */ }
    try { localStorage.removeItem('hgg-cart-v1'); } catch (e) { /* storage blocked */ }
    return;
  }

  // /cancel: the cart stays saved in the browser, so nothing to do here — the portal rebuilds it.
})();
