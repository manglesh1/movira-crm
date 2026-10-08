# Movira CRM

Movira CRM is the **communications service** for Movira. It owns:

- **Transactional messaging** — booking confirmations, receipts, payment links, waivers, OTPs, operational notifications.
- **Marketing messaging** — campaigns, broadcasts, templates, audience segments, journeys (roadmap), suppression, delivery analytics.
- **Notification routing** — event→template bindings that let admins switch which template fires for which event without code changes.
- **Provider integrations** — SES (email today), SMS/WhatsApp/Push roadmap-only.
- **Webhooks** — SES bounce/complaint/delivery events routed to the correct domain (transactional or marketing) and persisted as delivery events.
- **Audit log** — every template, binding, and campaign change is recorded.

Transactional and marketing live as **separate tables** but share **one builder UI** (in `my-admin-app`).

## Database boundary

`movira-crm` uses the same Postgres database as the booking/core app, but all CRM-owned tables live in a dedicated PostgreSQL schema.

Recommended production layout:

```
movira_core.public  -> bookings, payments, schedules, waivers, POS, staff
movira_core.crm     -> contacts, segments, email, automations, audit logs
```

Use `MOVIRA_CRM_DATABASE_URL` for this service even when it points at the same physical database as aeroSportsAdmin. Do not use generic `DATABASE_URL`, `DB_NAME`, or `DB_HOST` keys here; those names can collide with the booking/core app and accidentally point CRM migrations at the wrong place. `CRM_DB_SCHEMA` controls the CRM schema name and defaults to `crm`.

CRM queue work is stored in `crm_queue_jobs` with separate queues:

- `contacts` -> CSV/contact import jobs, async advanced-filter count jobs, large bulk contact actions, and queued CSV exports
- `segments` -> dynamic segment recalculation jobs
- `automation` -> workflow trigger execution jobs

Run each worker independently so high import load does not block segment refreshes or automation execution.
Advanced-filter exact totals are cached in `crm_contact_filter_counts`; the customers grid previews the first page immediately and the contacts worker calculates the exact matching count asynchronously. Large bulk actions are tracked in `crm_contact_bulk_action_jobs` and executed by the contacts worker in batches. Large exports are tracked in `crm_contact_export_jobs`; configure `S3_CONTACT_EXPORTS_BUCKET` for private S3 storage, otherwise files are written to `CRM_CONTACT_EXPORT_DIR` or the OS temp directory locally.

## Architecture in 1 minute

```
Producer (aeroSportsAdmin booking/payment/waiver controllers)
   │
   ▼ HTTP POST  (services/crmNotify in aeroSportsAdmin)
POST /api/notifications/events  ──► movira-crm
   │
   ▼ binding lookup (event_template_bindings)
templateKey resolved
   │
   ▼ transactional service.enqueueMessage
crm_transactional_messages row inserted (status: queued)
   │
   ▼ SQS enqueue
transactional worker
   │
   ▼ render + dispatch
SES sendEmail (Raw if attachments) with EmailTags {domain, message_id}
   │
   ▼ SES events → SNS → POST /api/webhooks/ses
webhook handler detects domain → updates transactional OR marketing message + delivery event
```

## Documentation map

| Topic | File |
|---|---|
| System design overview | [docs/system-design.md](docs/system-design.md) |
| Notification events + bindings (the routing layer) | [docs/notification-events.md](docs/notification-events.md) |
| Transactional messages API | [docs/api/transactional-messages.md](docs/api/transactional-messages.md) |
| All 33 system templates + families | [docs/transactional-template-catalog.md](docs/transactional-template-catalog.md) |
| Marketing module overview | [docs/marketing.md](docs/marketing.md) |
| Marketing template builder | [docs/marketing-email-builder-platform.md](docs/marketing-email-builder-platform.md) |
| CRM production roadmap + GoHighLevel plan | [docs/email-platform-roadmap.md](docs/email-platform-roadmap.md) |
| Unified conversations architecture | [docs/conversations-omnichannel-architecture.md](docs/conversations-omnichannel-architecture.md) |
| Customer email setup | [docs/customer/email-sending-setup.md](docs/customer/email-sending-setup.md) |
| Customer campaign launch guide | [docs/customer/campaign-launch-guide.md](docs/customer/campaign-launch-guide.md) |
| Customer Conversations guide | [docs/customer/conversations-guide.md](docs/customer/conversations-guide.md) |
| CRM production incident runbook | [docs/runbooks/crm-production-incidents.md](docs/runbooks/crm-production-incidents.md) |
| Admin UI structure (CRM settings + tabs) | [docs/settings.md](docs/settings.md) |
| Postman collection | [docs/postman.md](docs/postman.md) |

## Quick start

```bash
npm install
npm run migrate     # also runs seeders
npm run dev         # starts API on PORT from .env (default 4100)
npm run worker:transactional  # in a second terminal
npm run worker:marketing      # in a third terminal
npm run worker:contacts       # CRM contact import jobs
npm run worker:segments       # CRM segment recalculation jobs
npm run worker:automation     # CRM automation trigger jobs
npm run worker:rss            # RSS/Atom feed polling and campaign creation
npm run worker:email-health   # provider credential health + DNS re-verification
npm run credentials:rotate   # validates old/current keys (add -- --apply to rotate)
```

`predev` script runs `migrate && seed` automatically when you `npm run dev`.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `MOVIRA_CRM_DATABASE_URL` | prod | Movira CRM Postgres connection string; can point to the same database as aeroSportsAdmin |
| `CRM_DB_SCHEMA` | no | PostgreSQL schema used by CRM tables (default `crm`) |
| `MOVIRA_CRM_DB_SSL` | prod | Enables/disables SSL for the CRM database connection |
| `MOVIRA_CRM_DB_USERNAME` | dev only | CRM DB username when no URL is provided |
| `MOVIRA_CRM_DB_PASSWORD` | dev only | CRM DB password when no URL is provided |
| `MOVIRA_CRM_DB_NAME` | dev only | CRM DB name when no URL is provided |
| `MOVIRA_CRM_DB_HOST` | dev only | CRM DB host when no URL is provided |
| `MOVIRA_CRM_DB_PORT` | dev only | CRM DB port when no URL is provided |
| `PORT` | no | API port (default 4100) |
| `JWT_SECRET` | prod | Same JWT signing secret used by aeroSportsAdmin |
| `INTERNAL_API_SECRET` | prod | Shared service-to-service secret for aeroSportsAdmin ↔ movira-crm |
| `MOVIRA_CORE_API_BASE_URL` | prod | aeroSportsAdmin API base URL, ending in `/api` |
| `CRM_ALLOWED_ORIGINS` | prod | Comma-separated frontend origins allowed by CORS |
| `CRM_WEBHOOK_SHARED_SECRET` | optional | Extra shared-secret header for custom webhook forwarders (`x-movira-webhook-secret`) |
| `MAILGUN_WEBHOOK_SIGNING_KEY` | if Mailgun webhooks enabled | Mailgun webhook signing key |
| `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY` | if SendGrid webhooks enabled | SendGrid signed event webhook public key |
| `POSTMARK_WEBHOOK_TOKEN` | if Postmark token guard enabled | Expected `x-postmark-webhook-token` header |
| `POSTMARK_WEBHOOK_USERNAME` / `POSTMARK_WEBHOOK_PASSWORD` | if Postmark basic auth enabled | Basic auth credentials configured on the Postmark webhook |
| `CRM_ALLOW_UNSIGNED_WEBHOOKS` | dev only | Allows unsigned provider webhooks outside production |
| `AWS_REGION` | no | AWS region for SQS/SES (default us-east-1) |
| `AWS_*` SQS URLs | prod | Transactional + marketing queue URLs |
| `SES_DEFAULT_FROM` | prod | Default from address |
| `SES_TRANSACTIONAL_CONFIG_SET` | prod | SES transactional configuration set |
| `SES_MARKETING_CONFIG_SET` | prod | SES marketing configuration set |
| `AWS_SES_REGION` | prod | SES region |
| `SES_GLOBAL_CAPACITY_ENFORCEMENT` | prod | Must be `true`; atomically enforces the shared Movira SES account quota across locations |
| `SES_CAPACITY_SNAPSHOT_TTL_SECONDS` | prod | Live SES quota refresh interval; default `60` |
| `SES_CAPACITY_RESERVATION_TTL_SECONDS` | prod | Releases abandoned pre-send reservations; default `300` |
| `SES_TRANSACTIONAL_CAPACITY_RESERVE_PERCENT` | prod | Shared quota protected from marketing traffic; default `20` |
| `SES_CAPACITY_SAFETY_MARGIN_PERCENT` | prod | Safety buffer below the AWS quota; default `5` |
| `CRM_QUEUE_WORKER_STALE_LOCK_MS` | prod | Reclaims durable jobs after a crashed worker; default `600000` (10 minutes) |
| `CRM_CREDENTIALS_ENCRYPTION_KEY` | prod | Base64-encoded 32-byte current credential-encryption key; required before provider migration |
| `CRM_CREDENTIALS_ENCRYPTION_KEY_ID` | prod | Stable identifier for the current key, for example `2026-10-primary` |
| `CRM_CREDENTIALS_PREVIOUS_KEYS` | rotation only | JSON object containing old key IDs and base64 keys until every credential is re-encrypted |
| `CRM_QUEUE_WORKER_POLL_MS` | no | DB-backed CRM queue worker poll interval |
| `CRM_QUEUE_WORKER_BATCH_SIZE` | no | Jobs claimed per CRM queue worker poll |
| `EMAIL_INFRA_HEALTH_INTERVAL_MINUTES` | no | Health worker loop interval; default `15` |
| `EMAIL_PROVIDER_RECHECK_MINUTES` | no | Customer-provider credential handshake interval; default `1440` |
| `EMAIL_PENDING_DOMAIN_RECHECK_MINUTES` | no | DNS/provider recheck interval before verification; default `60` |
| `EMAIL_VERIFIED_DOMAIN_RECHECK_MINUTES` | no | Ongoing verification check interval; default `1440` |
| `TRANSACTIONAL_MANUAL_RETRY_LIMIT` | no | Safe default maximum manual retries per failed transactional message; default `5` |
| `CRM_LOCATION_EMAIL_LIMITS` | prod | JSON plan allowance map, for example `{"default":{"dailyLimit":10000,"hourlyLimit":2000},"51":{"dailyLimit":50000,"hourlyLimit":7000}}`; shared Movira limits apply per location after warmup |

Without SQS URLs, message rows are created with status `enqueue_skipped` — handy for local dev.

## Frontend

Both transactional and marketing UIs live in [movira-admin](../movira-admin/):

- `/crm/marketing?tab=templates&templateType=transactional` — transactional templates (33 system + custom variants), family-grouped
- `/crm/marketing?tab=templates&templateType=marketing` — marketing templates
- `/crm/marketing?tab=campaigns` — marketing campaigns
- `/crm/settings?channel=notifications` — event→template bindings (the routing layer)
- `/crm/settings?channel=email` — email provider/domain/route settings
- `/crm/marketing/templates/:id/builder?type=transactional` — visual builder (works for both types)

## Calling from aeroSportsAdmin

Producer code uses the [crmNotify helper](../movira-platform-admin/services/crmNotify/index.js):

```js
const crm = require("./services/crmNotify");

await crm.send({
  template: "bookingConfirmation",       // legacy slug; helper maps to eventType
  to: guest.guestEmail,
  data: { guestName, bookingNumber, venueName, ... },
  attachments: [{ filename: "invoice.pdf", content: pdfBuffer, contentType: "application/pdf" }],
  idempotencyKey: `booking.confirmed:${bookingId}`,
  locationId: location.locationId,
  priority: crm.PRIORITY.HIGH,
});
```

See [movira-platform-admin/docs/crmNotify.md](../movira-platform-admin/docs/crmNotify.md).
