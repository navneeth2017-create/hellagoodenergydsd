# HELLA GOOD! Energy Gummies — DSD Portal

Wholesale ordering for HELLA GOOD! Energy Gummies DSDs (distributors). Built on the
Hella Good D2C storefront (same brand, Express + Stripe) with Postgres accounts, a signed-cookie
login, an apply/invite approval flow, an admin console, and a wholesale shop (flat **25% off** retail
by default, editable).

- **Public**: a branded landing + a DSD login/apply form. No public checkout.
- **DSD**: log in, add packs at wholesale, check out via Stripe (server-computed prices only).
- **Admin**: invite DSDs, approve applications, disable/enable accounts, set a per-DSD discount
  override, and see every order.

## Run it

```bash
npm install
npm start                 # http://localhost:3000
npm test                  # pricing, auth, pages, security, caching, shutdown
```

A `DATABASE_URL` is optional to boot — without it the server still serves the landing and auth pages,
and account endpoints answer 503. Set it (plus `JWT_SECRET`) to turn the portal on.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (Railway Postgres plugin). |
| `JWT_SECRET` | Signs the session cookie. Set a long random string in production. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Seeds the first admin account on boot (idempotent). |
| `STRIPE_SECRET_KEY` | Turns checkout on. Must start `sk_live_` / `sk_test_`. |
| `STRIPE_WEBHOOK_SECRET` | Verifies the `checkout.session.completed` webhook (records orders). |
| `WHOLESALE_PERCENT_OFF` | Default DSD discount (0–90). Defaults to 25. Editable in the admin console. |
| `PUBLIC_URL` | Canonical origin for links/images (else Railway's domain). |

## Pages

| URL | What it is |
| --- | --- |
| `/` | Branded DSD landing (program, flavors, 25% off, login + apply). |
| `/login` | DSD login. |
| `/apply` | Apply to become a DSD (creates a pending application). |
| `/invite/<token>` | Finish setting up an invited account (name + password). |
| `/portal` | The DSD shop (login required): wholesale cart + My orders. |
| `/admin` | Admin console (admin only): DSDs, orders, wholesale % config. |
| `/success`, `/cancel` | Stripe return pages. |
| `/privacy`, `/terms` | Legal drafts. |

## Notes

- **Prices are server-computed.** The browser shows `$4.49` (25% off $5.99) for display only; the server
  is the source of truth for every Stripe charge.
- **Sessions** are a signed, httpOnly cookie (`hgd_dsd`), two weeks, `SameSite=Lax`, `Secure` in production.
- **Orders** are recorded from the Stripe `checkout.session.completed` webhook, attributed by
  `metadata.user_id`, and shown on the DSD's "My orders" and the admin console.
- Passwords are hashed with `scrypt` (per-user salt). Nothing here needs a native dependency beyond `pg`.
