# Marketing Module

The marketing module handles **bulk + segmented email campaigns**, audience suppression, delivery tracking, and the visual template builder shared with transactional.

For the visual builder itself see [marketing-email-builder-platform.md](marketing-email-builder-platform.md).

## What it owns

- **Campaigns** — draft → scheduled → sent, pause/resume mid-flight
- **Templates** — design (visual), code (HTML), plain editor types
- **Folders** — organize templates and campaigns
- **Assets** — image/logo library backed by S3
- **Snippets** — reusable design blocks
- **Recipients & preflight** — recipient lists, validation before queueing
- **Bulk dispatch** — SQS-based, rate-limited, pauseable
- **Engagement tracking** — opens, clicks, bounces, complaints, unsubscribes
- **Suppression** — manual + automatic on bounce/complaint/unsubscribe
- **Test send** — preview to a test address before launch
- **Test harness** — local simulator for end-to-end testing without real SES
- **Audit log** — every campaign + template change tracked

## What it does NOT own (yet)

- Segments — audience builder (orchestrators/README only; no implementation)
- Journeys — multi-step automation (orchestrators/README only)
- A/B testing — no variant logic
- Scheduled sends use durable `marketing.campaign_dispatch` jobs with a unique campaign key; the marketing-audience worker dispatches them at `runAt` and stale worker locks are reclaimed.

## Tables (selected)

| Table | Purpose |
|---|---|
| `crm_marketing_campaigns` | Campaign metadata + status + aggregated metrics |
| `crm_marketing_templates` | Templates (design + code editor types) |
| `crm_marketing_template_revisions` | Version history per template (each save) |
| `crm_marketing_messages` | One row per recipient per campaign |
| `crm_marketing_delivery_events` | Open/click/bounce/complaint/unsubscribe |
| `crm_marketing_folders` | Folder hierarchy |
| `crm_marketing_assets` | Uploaded images/logos |
| `crm_marketing_snippets` | Reusable design blocks |
| `crm_marketing_suppressions` | Suppressed recipients with reason + scope |
| `crm_marketing_worker_heartbeat` | Worker liveness + queue depth |

## Send flow

```
Campaign created (status: draft)
   │
   ▼ preflight
recipients validated, suppressions filtered
   │
   ▼ queue (status: scheduled / sending)
SQS messages enqueued per recipient
   │
   ▼ marketingWorker
- Rate limit check
- Pause check
- Render via design renderer
- SES sendMarketingEmail with EmailTags {domain: marketing, message_id, campaign_id}
   │
   ▼ message status: sent
SES events → SNS → POST /webhooks/ses
   │
   ▼ tracking service
- Delivery event row inserted
- Message status updated (delivered / bounced / etc.)
- Auto-suppress on bounce/complaint/unsubscribe
- Campaign aggregate metrics incremented
```

## Builder (visual + code)

Single React component in `my-admin-app/src/pages/crm/marketing/EmailTemplateBuilder.jsx`. Handles:

- Drag-drop blocks from `/templates/builder/catalog`
- Section + column + block tree with mobile overrides
- Image picker pulling from `assets`
- Snippet picker for reusable sections
- Live preview (`/templates/render` for marketing, `/transactional/templates/render` for transactional)
- Test send (POSTs to corresponding test-send endpoint)
- Revision history (marketing only)
- Auto-save every 1.6s after edits

The builder is **type-aware** via `?type=transactional` URL query param. When present, all CRUD routes to transactional endpoints; otherwise marketing.

## Admin UI surface

```
/crm/marketing                          Overview + tab navigation
/crm/marketing?tab=statistics           Aggregated metrics
/crm/marketing?tab=campaigns            Campaigns list + builder
/crm/marketing?tab=templates            Templates (area cards: Marketing | Transactional | Shared | All)
/crm/marketing?tab=suppressions         Suppression list
/crm/marketing?tab=failed_inbox         Failed messages with retry
/crm/marketing?tab=queue_monitor        SQS depth + in-flight
/crm/marketing?tab=ses_simulator        Local SES event simulator
/crm/marketing?tab=audit_logs           Activity log
/crm/marketing?tab=docs                 In-app docs
/crm/marketing?tab=test_lab             Test harness controls
/crm/marketing/templates/:id/builder    Visual builder (use ?type=transactional for transactional)
```

## Domain separation

Although marketing and transactional **share the builder UI**, they store data in separate tables (`crm_marketing_templates` vs `crm_transactional_templates`) with different lookup patterns (UUID vs slug key). This was an explicit decision — see [system-design.md](system-design.md) for rationale.

The marketing dispatcher refuses to send any template flagged `useCase=transactional` (defensive check in `marketing/email/messageDispatcher.js:35`). Transactional templates can only be sent through `transactional/dispatcher.js`.

## Suppression policy

Recipients are auto-suppressed when SES reports:

- **Bounce (permanent)** — `reason: bounce`
- **Complaint** — `reason: complaint`
- **Unsubscribe** — recipient clicked the unsubscribe link in a marketing email

Suppression is **per-location + per-email**. Once suppressed, future marketing sends to that recipient are skipped during preflight. Transactional does NOT consult marketing suppression (legal/operational emails should still send) — but if you want to consult it, future work.

## Local development

```bash
npm run dev                       # API
npm run worker:marketing          # marketing worker (separate terminal)
```

Use the **test harness** tab in the UI to seed demo campaigns + messages and simulate SES events without real AWS:

```
POST /api/marketing/email/test-harness/seed
POST /api/marketing/email/test-harness/campaigns/:id/process
POST /api/marketing/email/test-harness/messages/:id/events  → simulate open/click/bounce
```
