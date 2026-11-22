(function () {
  'use strict';
  var form = document.getElementById('apply-form');
  if (!form) return;
  var msg = document.getElementById('apply-msg');
  var btn = document.getElementById('apply-btn');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('name').value.trim();
    var company = document.getElementById('company').value.trim();
    var email = document.getElementById('email').value.trim();
    var phone = document.getElementById('phone').value.trim();
    var password = document.getElementById('password').value;
    msg.className = 'form-msg';
    if (!name) { msg.className = 'form-msg error'; msg.textContent = 'Enter your name.'; return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.className = 'form-msg error'; msg.textContent = 'Enter a valid email.'; return; }
    if (password.length < 8) { msg.className = 'form-msg error'; msg.textContent = 'Use a password of at least 8 characters.'; return; }
    btn.disabled = true;
    window.hgd.api('/api/apply', { method: 'POST', body: JSON.stringify({ name: name, company: company, email: email, phone: phone, password: password }) }).then(function (r) {
      if (r.ok) {
        msg.className = 'form-msg ok';
        msg.textContent = r.data.message || 'Application received. We will email you once your account is approved.';
        form.style.display = 'none';
        return;
      }
      btn.disabled = false;
      msg.className = 'form-msg error';
      msg.textContent = (r.data && r.data.error) || 'Could not submit your application.';
    }).catch(function () {
      btn.disabled = false;
      msg.className = 'form-msg error';
      msg.textContent = 'No connection — try again.';
    });
  });
})();
