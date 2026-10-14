# Shared conversation contacts and leads

CRM owns the channel connections, identities, conversations, messages and outbox.
The platform's `services/conversations` record service owns contact reconciliation,
follow-up forms and lead creation, using the same PostgreSQL database. Guest AI
is an optional answer service; contact/lead writes do not require an AI catalog.

## Storage

- `crm.crm_contacts`: general profile. New chat profiles have
  `communicationOnly=true`, marketing/SMS status `unknown`, and no normalized
  email/phone identity. Supplied contact details are unverified display data.
- `crm.crm_chat_contacts`: channel contact details and review/retention state,
  linked to the profile by `crm_contact_id`. The numeric `guest_ai_contact_id`
  column is deliberately retained for existing contact URLs and API clients.
  New records are unique by park and channel identity, not supplied email.
- `crm.crm_leads`: submitted requests, including `channel`, `source`,
  `created_by`, `crm_contact_id` and `crm_conversation_id`.
- `crm.crm_lead_sessions`, `crm.crm_lead_deliveries`, `crm.crm_lead_configs`:
  drafts, delivery status and park-specific form configuration.
- Existing `crm_conversation_*` tables remain the message source of truth.
  `authorType` separates visitor, AI, staff and system messages.

The old public `guest_ai_contacts` and `guest_ai_leads` compatibility views were
removed by migration `20261013000500`; the shared CRM tables hold their data.
The legacy lead config/session/delivery aliases remain updatable views.
No record copy or two-way synchronization is involved. Old model exports remain
aliases of the shared models. Historical IDs, timestamps and form snapshots stay
intact. Existing `chat_conversations` rows remain compatibility context projections;
new channel transcripts are stored only in the CRM conversation message store.
`public.chat_conversations` and `public.chat_messages` are still required by the
mounted `/api/ai-agent` customer assistant, history/handoff routes and retention.
They are not safe to drop as unused tables.

## Flows

1. Webchat, Meta or inbound email stores a message and queues
   `conversation.contact.sync` in the same transaction. Future adapters should
   do the same, with the CRM conversation ID as the event aggregate ID.
2. The worker calls the authenticated `/api/internal/conversations/contact`
   endpoint. The record service verifies the conversation's park in the database,
   derives its channel/identity, and creates or updates its shared contact.
3. AI-enabled webchat can request an answer. Human-only chat never calls the
   answer service. Human takeover or assigning a staff user changes handling to
   `human` and increments the handling version, invalidating pending AI responses.
   Unassigning staff does not restart AI. Staff can use **Send back to AI** on an
   open website chat: the server validates park readiness and enabled channel
   settings, clears the individual assignee (retaining the team), and increments
   the handling version again. AI answers the next guest message; old questions
   are not replayed. The transition is audited. Other channels cannot use this
   Guest AI action.
4. A visitor submits the widget follow-up form, or staff uses **Create follow-up**
   in the inbox. The request is validated and stored once, independently of AI.
   These new shared requests create a lead, not a booking Customer or marketing
   subscription. Historical customer links and the legacy one-shot lead workflow
   remain supported.
5. Staff can link two conversations' channel identities after confirming the
   identity and supplying a reason. The link is park-scoped and audited in the
   conversation outbox. Each original message thread stays intact. Contact
   details display the histories of all linked channel records.

## Email grouping for staff

Chat contacts uses `(locationId, lower(trim(email)))` as its main grouping key.
The group shows all matching channel identities, combined chat/lead activity and
name/phone differences. Search, channel filters, summary counts and pagination
operate on these groups. Review actions apply to the group within its park.
Contacts without an email remain separate channel identities.

This is a staff-facing grouping, not a database primary-key rewrite. Numeric
contact URLs and CRM UUIDs remain unchanged. The public widget still requires its
own session token; entering a matching email never grants access to other chats.
Email groups do not merge customer records or transfer marketing consent.
Submitted leads remain individual requests with their own status and assignment;
all related requests are visible in the grouped contact detail.

General CRM imports and manual/API upserts match a known provider/customer ID or
normalized email within the park. A shared phone number never merges records.
Keeping an existing external ID allows booking sync to follow an explicit email
change without inventing a new booking customer. Automation events resolve an
explicit CRM contact ID or same-park email; phone-only events are skipped.

## Source history

Migration `20261013000600-preserve-contact-source-history.js` adds `originalSource`
and `sourceHistory` to `crm.crm_contacts`. The database captures the first source
and appends subsequent changes to source type/reference with a recorded timestamp.
The existing `sourceType`/reference fields still represent the current source for
compatibility. These fields are returned with CRM contact profiles; channel
attribution remains on the channel contact, identity and conversation records.

The trigger covers imports, API edits and direct SQL from the core chat service.
It preserves history under concurrent updates and ignores attempts to overwrite
the history fields. Unchanged source retries and phone/name edits do not add
duplicate events. It records source transitions, not every profile edit.

Existing records receive a `legacy_snapshot` of the currently known source;
previously overwritten origins cannot be recovered or claimed as known. New
records use `captured` provenance. Rollback removes these history columns and
their trigger, losing recorded attribution but preserving customer/contact rows.

CRM customer Overview and Chat contact details show a shared read-only source
history card, with the original/current source and an expandable dated timeline.
Legacy snapshots are labelled as the earliest known source. Chat detail responses
return attribution for each linked same-park CRM profile separately, with its
channel labels; email grouping does not invent a merged acquisition history.
Source history is not included in customer-edit save payloads.

Chat contacts and Submitted leads share the CRM workspace header, summary cards,
filters, channel badges and table styling. Legacy standalone URLs remain available.

## API and UI compatibility

The existing `/api/locations/guest-ai/contacts`, `/guest-ai/leads`, park-specific
lead routes, widget URLs and `/api/internal/website-chat/*` endpoints remain.
General record routes use `/api/locations/conversations/contacts` and
`/api/locations/conversations/leads`, with equivalent park-scoped detail routes.
Admin now uses these general routes, with channel filters in Chat contacts and
Submitted leads. Knowledge management remains under Admin Locations.

Authenticated CRM inbox endpoints:

- `POST /api/conversations/:id/return-to-ai`
- `POST /api/conversations/:id/lead-form`
- `POST /api/conversations/:id/lead-submit` (`fields`)
- `POST /api/conversations/:id/link-contact` (`targetConversationId`,
  `verifiedByStaff: true`, `reason`)

The authorization middleware supplies/checks location scope and the authenticated
staff ID. The public widget has no identity-linking endpoint. Typed email does
not authorize historical transcript access.

## Isolation and operations

Communication-only profiles are excluded from ordinary marketing contact lists,
audience/segment selection and automation enrollment. Existing contact consent
and customer records are never overwritten by channel synchronization. Retention
removes an expired communication-only profile only when no retained channel
contact references it; established customer/marketing profiles are preserved.

Run the CRM migration `20261013000200-shared-conversation-records.js` after the
existing platform and CRM baselines, before deploying the updated services. Then
restart CRM API, conversation workers and platform API/jobs. The migration
enqueues reconciliation for existing conversations; it sends no messages.

The migration is atomic and forward-only. Do not run a destructive table rename
rollback once channel records exist. Compatibility views permit legacy readers;
keep one deployed record writer version during rollback. No other module's
schema or migration history is changed. `CRM_DB_SCHEMA` must agree in both services.

X, LinkedIn and other planned channels can use the shared storage contract, but
this change does not enable their external messaging integrations or permissions.

## Verification

- `RUN_SHARED_RECORDS_DB_TEST=1 node --test test/sharedConversationRecords.integration.test.js`
  creates and removes isolated schemas. Covers migration/view compatibility,
  concurrent reconciliation, Meta/email deduplication, email-less identities,
  all-channel leads, invalid forms, idempotency, park isolation, deliberate
  identity linking, consent protection and retention.
- `RUN_UNIFIED_CHAT_DB_TEST=1 node --test test/unifiedWebchat.integration.test.js`
  covers human/AI modes, delayed-response suppression, session authorization,
  handoff, disable/re-enable and message history.
- `RUN_SHARED_RECORDS_DB_TEST=1 node --test test/contactIdentityAndSource.integration.test.js`
  tests shared phones with distinct emails, park isolation, source transitions,
  concurrent history writes, direct chat SQL, booking external-ID sync, automation
  matching and migration rollback/reapply in an isolated schema.
- Admin Playwright suite: `npx playwright test --config e2e/unified-chat.config.js`.
  Provider APIs are mocked; external social account delivery is not live-tested.
