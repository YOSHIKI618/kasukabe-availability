# Kasukabe availability notifier

Public source only. Personal conditions, notification destinations, history and secrets are stored separately in an authenticated Cloudflare Worker and D1.

Regular monitoring uses one SQLite-backed Cloudflare Durable Object and persisted hourly alarms. The phone UI uses Workers Free, D1 Free and standards-based Web Push. No PC needs to remain running. No automated booking or cancellation. Alarm and delivery delays are possible; availability is not guaranteed until a booking is made on the official site. GitHub Actions is a manual fallback only, with no scheduled trigger.

For a separate installation, create a free D1 database, run migrations/0001.sql, replace the database ID and SELF_URL in wrangler.jsonc, and deploy with Wrangler. Register all values listed in .dev.vars.example using Workers Secrets (never commit real values). VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be a matching P-256 pair; the private key uses PKCS8 PEM. Register a phone from the home-screen web app, then start monitoring in the authenticated app. The Durable Object migration must use new_sqlite_classes for the Free plan. Do not enable a paid plan or add payment details.
