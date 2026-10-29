# Fragma Alchemy ERP + CRM

A dark commerce-operations workspace for a small marketplace business. This local release candidate combines a local sign-in server with interactive sample workflows. TikTok Shop and Tokopedia are **not connected** and no marketplace API is called.

## Current system version

- **Version:** 1.0.14
- **Status:** Published to GitHub main
- **Updated:** 29 October 2026
- **Highlights:** Restored the **Next stage →** lead action so it advances through New, Contacted, Qualified, Proposal sent, Negotiation, and Won; finished or closed leads do not show it. Sales pipeline stages now use distinct high-contrast colors, and follow-up chips mark overdue and due-today items prominently, with separate colors for upcoming, scheduled, and unset dates. Next follow-up is selected from a calendar date picker. Pipeline stages can be chosen directly from New, Contacted, Qualified, Proposal sent, Negotiation, Won, Lost, and Closed — Not a prospect; closed leads no longer count as open or due. Sales pipeline leads link to a selected customer record and capture their creation timestamp. Customer records include an optional WhatsApp number. Fixed New Import finalization: batch, stock, HPP, stock movements, and activity now save in a single revision-safe workspace update. Previously, logging the import queued a first save before the explicit finalization save; the second write reused a stale revision, conflicted, and restored the unsaved state. Import uses side-by-side entry and live calculation panels on desktop, stacked on smaller screens. Product dimensions on New Import are read-only and use the selected SKU catalog dimensions. Product lines receive sequential numbers, and the live preview has selectable batch and per-product pages. Removed SKU-specific customs duty, import tax, and other direct cost fields; active preview page is clearly highlighted. The live preview distinguishes fixed shipment totals from the customs duty rate per CBM. Customs duty totals and per-SKU/per-unit allocations are calculated from CBM, and only the calculated amount enters import expenses and HPP. The preview shows purchase costs, CBM, expenses, landed cost, and HPP before finalization.
- **Scope:** Local SQLite workspace. TikTok Shop and Tokopedia are not connected, and Shopee SKU is a catalog mapping only. Import batches are internal records; finalizing one adds inventory only to this workspace.

The app's **System version** page shows this release information and the available modules.

## Run locally

Use Node.js 24 or newer (the app uses Node's built-in SQLite module). There are no npm dependencies.

```powershell
node dev-server.js
```

Open <http://localhost:4173> and stop the server with `Ctrl+C`. On a new installation, create the first Owner account on the setup screen. This workspace already has the requested Owner account in its local ignored database; the database and password hash are not part of the Git repository.

## Sign-in and users

The initial Owner email is `fragmaalchemy@gmail.com`. Its password is the one supplied by the owner in the setup conversation. Sign-in uses a salted scrypt password hash, HTTP-only same-site session cookie, and rate limiting for failed attempts. The Owner/Admin role can open **Admin panel** and create Operations, Support, or Viewer accounts. New user passwords must be at least 10 characters. No password is shown in the user list.

In a fresh clone, first-time setup creates the local Owner. Local account data lives in `data/fragma.sqlite`, which is ignored by Git. To initialize an Owner non-interactively, create a temporary `.owner-bootstrap.json` containing `name`, `email`, and `password`, then run `node setup-owner.js`; the script hashes the password and removes the bootstrap file. Never commit either file.

Business records are stored in the local SQLite database, so signed-in users on the same running server share changes. Existing browser demo data is imported into the server once by the Owner at first login. Account and role checks are enforced by the server for workspace writes. The app still contains sample marketplace records; replace them with verified business data before relying on operational reports.

## Included workflows

- Dashboard sales summaries, marketplace breakdown, recent orders, low-stock watch, and activity.
- Searchable order and fulfillment queues; update sample order status and tracking.
- Owner/Operations TikTok Shop and Tokopedia seller export import for `.xlsx`, `.csv`, and `.tsv`; previews, groups product rows by marketplace order, de-duplicates repeated lines and re-imports, and retains canceled/return orders with explicit statuses.
- Product catalog with permanent Main SKUs and required Tokopedia, TikTok Shop and Shopee SKU references; new products start with zero stock and stock can only be received through New Import; New Import supports multiple existing SKUs, decimal CNY or USD unit prices, manual exchange rates, calculated per-product and batch purchase totals in transaction currency and IDR, dimensions, CBM-based allocation of fixed shared expenses, customs duty calculated from a per-CBM rate, categorized shared expense totals, landed cost, per-batch HPP in IDR, and stock receipt on finalization. The full calculation is previewed before finalization. Products show latest batch HPP and preserved import history. Inventory count, adjustment, reorder point and stock movement history are also available.
- Support and returns cases; customer records and a lightweight lead pipeline.
- Operational report estimates and CSV exports.
- Marketplace connection checklist and demo sync history. Demo sync records an attempt without contacting any store.
- Owner-only user management, two-step workspace-data clearing, backup and confirmed restore, a persistent audit log, and a logout menu.
- SQLite-backed shared workspace records with server-side role checks: Owner/Admin has full access, Operations manages fulfillment, stock and workspace operations, Support handles cases and customer records, and Viewer is read-only.

## Data boundaries

Marketplace connections are not live. Orders imported from seller exports are workspace records, not marketplace API syncs. Order imports omit buyer names, usernames, phone numbers, addresses, and messages; they do not update stock or post anything to a marketplace. Finalized New Import batches update only internal stock and cost records. Fixed shared import expenses are allocated by CBM. Customs duty is entered as an IDR/CBM rate and calculated as rate × shipment CBM, then allocated to each SKU based on its CBM. Product-specific duties and taxes can still be entered against product lines. Fees absent from the workbook remain marked unavailable, and reports exclude built-in sample orders after the first real import. Marketplace buyer data must not be contacted outside platform rules. Never enter marketplace credentials in this demo.

Owner/Admin can download a JSON workspace backup in **Settings → Backup & recovery** and restore it there. Restore replaces current business records and requires confirmation. Backup files contain business records but exclude user accounts and credentials; store backups securely. The SQLite file in `data/fragma.sqlite` also contains local user account hashes and should not be copied to a public repository.

## Marketplace integration status

TikTok Shop and Tokopedia connectors are **not implemented or authorized**. Before enabling a live connector:

1. Obtain official partner / Open Platform access and request only necessary scopes.
2. Complete each marketplace's seller authorization and test with an approved test account where available.
3. Implement an isolated server-side adapter; never put app secrets or tokens in browser code or Git.
4. Add encrypted token storage, signed webhook checks where supported, scheduled sync, rate-limit backoff, retries, idempotent imports, and audited sync history.
5. Map marketplace listings to the central catalog and reconcile cancellations, returns, stock, and settlement records against official data.

Do not scrape marketplace pages or use unofficial endpoints. Only show a live connection after authorization and a successful end-to-end test.

## Next production milestones

1. Before any public or multi-location deployment, add automated off-device backups, tested recovery procedures, deployment secrets, HTTPS, durable sessions, CSRF defenses, monitoring, and an explicit data-retention policy.
2. Replace sample marketplace records with verified imports, then reconcile orders, inventory reservations, cancellations, returns, fees, and settlements.
3. Add official marketplace connectors and background sync jobs only after the needed partner access and seller authorization are approved.

Keep the first production deployment a modular monolith. Kubernetes, event streaming, and paid analytics are unnecessary for the initial use case. Hosting and database costs depend on the provider selected for deployment.

## Configuration and files

The local demo needs no marketplace credentials. `.env.example` contains placeholders for a future backend. `.env`, the local SQLite database, and the optional first-owner bootstrap are Git-ignored.

- `index.html` — app entry point
- `auth.js` — sign-in and first Owner setup screens
- `app.js` — demo workflows and role-specific interface
- `server.js` / `dev-server.js` — local HTTP server, SQLite users and workspace records, sessions, role checks, audit, and Owner-only user and backup APIs
- `setup-owner.js` — optional first-owner bootstrap helper
- `styles.css` — responsive dark interface
