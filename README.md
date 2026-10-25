# Fragma Alchemy ERP + CRM

A dark commerce-operations workspace for a small marketplace business. This first release combines a local sign-in server with interactive sample workflows. TikTok Shop, Tokopedia, and Shopee are **not connected** and no marketplace API is called.

## Run locally

Use Node.js 24 or newer (the app uses Node's built-in SQLite module). There are no npm dependencies.

```powershell
node dev-server.js
```

Open <http://localhost:4173> and stop the server with `Ctrl+C`. On a new installation, create the first Owner account on the setup screen. This workspace already has the requested Owner account in its local ignored database; the database and password hash are not part of the Git repository.

## Sign-in and users

The initial Owner email is `fragmaalchemy@gmail.com`. Its password is the one supplied by the owner in the setup conversation. Sign-in uses a salted scrypt password hash, HTTP-only same-site session cookie, and rate limiting for failed attempts. The Owner/Admin role can open **Admin panel** and create Operations, Support, or Viewer accounts. New user passwords must be at least 10 characters. No password is shown in the user list.

In a fresh clone, first-time setup creates the local Owner. Local account data lives in `data/fragma.sqlite`, which is ignored by Git. To initialize an Owner non-interactively, create a temporary `.owner-bootstrap.json` containing `name`, `email`, and `password`, then run `node setup-owner.js`; the script hashes the password and removes the bootstrap file. Never commit either file.

The demo role controls which sections and actions appear. Sample business data is still kept in browser `localStorage`, shared within that browser profile. This is a local demo, not a production identity or access system; do not store real buyer records in it. There are no remote backups.

## Included workflows

- Dashboard sales summaries, marketplace breakdown, recent orders, low-stock watch, and activity.
- Searchable order and fulfillment queues; update sample order status and tracking.
- Product catalog add/edit; inventory count, adjustment, reorder point, and movement history.
- Support and returns cases; customer records and a lightweight lead pipeline.
- Operational report estimates and CSV exports.
- Marketplace connection checklist and demo sync history. Demo sync records an attempt without contacting any store.
- Owner-only user management and role-specific workspace navigation.

## Data boundaries

Marketplace orders, customers, cases, sales charts, and settlement estimates are sample data. Fees and gross margin are illustrative, not settlement records or accounting results. Marketplace buyer data must not be contacted outside platform rules. Never enter marketplace credentials in this demo.

## Marketplace integration status

TikTok Shop, Tokopedia, and Shopee connectors are **not implemented or authorized**. Before enabling a live connector:

1. Obtain official partner / Open Platform access and request only necessary scopes.
2. Complete each marketplace's seller authorization and test with an approved test account where available.
3. Implement an isolated server-side adapter; never put app secrets or tokens in browser code or Git.
4. Add encrypted token storage, signed webhook checks where supported, scheduled sync, rate-limit backoff, retries, idempotent imports, and audited sync history.
5. Map marketplace listings to the central catalog and reconcile cancellations, returns, stock, and settlement records against official data.

Do not scrape marketplace pages or use unofficial endpoints. Only show a live connection after authorization and a successful end-to-end test.

## Next production milestones

1. Move operational records out of browser storage into SQLite-backed server APIs with migrations, validation, audit events, and backups.
2. Enforce role permissions for every business-data API and harden deployment sessions, CSRF protections, monitoring, and recovery.
3. Add official marketplace connectors and background sync jobs, then settlement import and reconciliation.

Keep the first production deployment a modular monolith. Kubernetes, event streaming, and paid analytics are unnecessary for the initial use case. Hosting and database costs depend on the provider selected for deployment.

## Configuration and files

The local demo needs no marketplace credentials. `.env.example` contains placeholders for a future backend. `.env`, the local SQLite database, and the optional first-owner bootstrap are Git-ignored.

- `index.html` — app entry point
- `auth.js` — sign-in and first Owner setup screens
- `app.js` — demo workflows and role-specific interface
- `server.js` / `dev-server.js` — local HTTP server, SQLite accounts, sessions, and Owner-only user API
- `setup-owner.js` — optional first-owner bootstrap helper
- `styles.css` — responsive dark interface