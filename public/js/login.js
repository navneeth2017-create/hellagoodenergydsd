(function () {
  'use strict';
  var form = document.getElementById('login-form');
  if (!form) return;
  var msg = document.getElementById('login-msg');
  var btn = document.getElementById('login-btn');
  var next = (document.getElementById('next') && document.getElementById('next').value) || '/portal';

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('email').value.trim();
    var password = document.getElementById('password').value;
    msg.className = 'form-msg';
    if (!email || !password) { msg.className = 'form-msg error'; msg.textContent = 'Enter your email and password.'; return; }
    btn.disabled = true;
    window.hgd.api('/api/login', { method: 'POST', body: JSON.stringify({ email: email, password: password }) }).then(function (r) {
      if (r.ok) { window.location.href = next; return; }
      btn.disabled = false;
      msg.className = 'form-msg error';
      msg.textContent = (r.data && r.data.error) || 'Could not log in.';
    }).catch(function () {
      btn.disabled = false;
      msg.className = 'form-msg error';
      msg.textContent = 'No connection — try again.';
    });
  });
})();
