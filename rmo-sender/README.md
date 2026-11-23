# RMO Sender

A dark, AI-assisted email campaign application starter with account login, Google Gmail OAuth, contact consent records, HTML placeholder personalization, campaign history, and a queue-backed sender.

## Important status

This is a deployable application codebase, **not a hosted service**. It does not create your cloud database, Google OAuth project, Redis instance, domain verification, or AI API key. Configure those services and secrets before using it with real recipients. The UI and API are implemented; production hardening, legal review, monitoring, and provider approval are still required.

## Stack

- Node.js + Express API
- PostgreSQL + Prisma
- Redis + BullMQ sending queue
- Google OAuth / Gmail API (`gmail.send` scope only)
- OpenAI API for campaign-writing and placeholder assistance
- Dark responsive dashboard

## Local setup

1. Install Node.js 20+ and PostgreSQL and Redis.
2. Copy `.env.example` to `.env` and fill every required secret.
3. Generate a 32-byte encryption key: `openssl rand -hex 32`.
4. Generate a long JWT secret: `openssl rand -base64 48`.
5. Create a Google Cloud OAuth **Web application** client. Add the exact redirect URI from `GOOGLE_REDIRECT_URI`; configure the OAuth consent screen and authorized test users. Request only `gmail.send`, `openid`, and `email`.
6. Set `APP_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OPENAI_API_KEY`, `DATABASE_URL`, and `REDIS_URL`.
7. Run:
   ```bash
   npm install
   npx prisma generate
   npx prisma migrate dev --name init
   npm run dev
   ```
8. In a second terminal run `npm run worker`.
9. Open `http://localhost:8080`.

## Production deployment

Deploy the web process and worker as separate services. Use managed PostgreSQL and Redis with TLS, HTTPS, a persistent secret manager, backups, alerting, and a transactional email/domain configuration strategy. Set `APP_URL` to the public HTTPS origin. Do not expose `.env`, database URLs, OAuth secrets, JWT secret, encryption key, or OpenAI key to browser code.

## Sending and identity rules

- Gmail OAuth uses the connected account's own authenticated identity. The display name field is a preference for that account and must not be used to impersonate another person or organization.
- Google applies its own account and API sending quotas. The queue is deliberately throttled; 6,000 is a product campaign ceiling, **not a promise that Gmail will deliver 6,000 messages in one day**. For higher-volume production campaigns, use an approved bulk email provider with a verified sending domain, SPF, DKIM and DMARC.
- Only import contacts with documented consent. Do not use purchased, harvested, scraped, or guessed addresses.
- Honor unsubscribes and complaints immediately. Maintain suppression lists and monitor bounce/complaint rates.
- Review local anti-spam and privacy laws (for example CAN-SPAM, CASL, GDPR/UK GDPR where applicable) before launch.

## Current implementation notes / production checklist

- Add CSRF protection and secure, HTTP-only cookie sessions (the starter uses bearer tokens in localStorage for ease of local testing; replace this before public launch).
- Add OAuth `state` signing and one-time nonce persistence/validation, account disconnect/revocation, and refresh-token rotation handling.
- Add a verified-domain sending provider such as SES, Postmark, or Resend for true campaign volume; enforce per-provider quotas and per-account limits dynamically.
- Make unsubscribe endpoint accept both GET and RFC 8058 POST semantics, verify signed tokens, and never expose raw recipient email addresses in unsubscribe URLs.
- Add CSV parser with column mapping and explicit consent-source validation; current API accepts JSON.
- Add campaign audience selection, test-send flow, scheduling, idempotency keys, per-user quotas, audit logs, export, bounce/complaint webhooks, and analytics.
- Add HTML sanitization and link validation before sending; test email rendering across major clients.
- Add a reviewed privacy policy, terms, retention policy, data export/deletion controls, and administrator security procedures.

## Placeholder fields

The sender supports `{{firstName}}`, `{{lastName}}`, `{{email}}`, and `{{company}}`. Unknown placeholders are left unchanged for review rather than silently replaced with incorrect data.
