(function () {
  'use strict';
  var tokenInput = document.getElementById('invite-token');
  if (!tokenInput) return;
  var token = tokenInput.value;
  if (!token) { document.getElementById('invite-invalid').style.display = 'block'; return; }
  document.getElementById('invite-valid').style.display = 'block';

  var form = document.getElementById('invite-form');
  var msg = document.getElementById('invite-msg');
  var btn = document.getElementById('invite-btn');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('name').value.trim();
    var password = document.getElementById('password').value;
    msg.className = 'form-msg';
    if (!name) { msg.className = 'form-msg error'; msg.textContent = 'Enter your name.'; return; }
    if (password.length < 8) { msg.className = 'form-msg error'; msg.textContent = 'Use a password of at least 8 characters.'; return; }
    btn.disabled = true;
    window.hgd.api('/api/invite', { method: 'POST', body: JSON.stringify({ token: token, name: name, password: password }) }).then(function (r) {
      if (r.ok) { window.location.href = '/portal'; return; }
      btn.disabled = false;
      msg.className = 'form-msg error';
      msg.textContent = (r.data && r.data.error) || 'Could not finish setup.';
    }).catch(function () {
      btn.disabled = false;
      msg.className = 'form-msg error';
      msg.textContent = 'No connection — try again.';
    });
  });
})();
