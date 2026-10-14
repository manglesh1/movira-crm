# Website Chat + Guest AI

CRM Conversations → Channels → Website Chat + Guest AI is the shared widget setup. Submitted leads and Chat contacts tabs reuse the existing core records and permissions. Old `/guest-ai/leads` and `/guest-ai/contacts` links redirect with their filters and pagination intact.

## Modes and ownership

- Widget enabled controls visibility and new access on all approved origins.
- Enable Guest AI on: new conversations start with AI. The existing Guest AI service supplies grounded answers, product choices, and booking links. AI requires an active validated park catalog.
- Enable Guest AI off: new conversations wait for the team. No AI service or catalog is needed to message or submit a follow-up.
- A visitor can choose Talk to a person. A staff member can Take over or reply. The same CRM conversation and transcript continue with AI paused. Staff takeover does not automatically return to AI.
- Disabling AI also moves existing AI conversations to the team queue. Re-enabling affects new conversations only.
- Each AI job rechecks the connection, handling version and newest message before publishing. AI errors hand off to the team. Follow-up leads are created only when a visitor explicitly submits the configured form.

## Services and installation

Run the core API, CRM API and CRM conversations worker. Run Guest AI when AI answers are enabled. Existing launch commands are unchanged. AI and contact-sync jobs use a separate polling loop in the conversations worker, so slow AI requests do not block other channels' outgoing messages. Their existing delivery and retry behavior is preserved.

1. Apply all pending CRM migrations with `npm run migrate`, including `20261012000100-unify-webchat-guest-ai.js` and the shared-record migrations through `20261013000600-preserve-contact-source-history.js`. These add widget handling settings and shared contact/lead storage while preserving existing records, widget keys and encrypted legacy configuration. See `SHARED_CONVERSATION_RECORDS.md` for migration and compatibility details.
2. Core and CRM must use the same PostgreSQL database; core reads the CRM schema only for the widget compatibility mapping. `CRM_DB_SCHEMA` defaults to `crm` on both services.
3. Set core `WEBSITE_CHAT_PUBLIC_BASE_URL` (falls back to `CRM_PUBLIC_BASE_URL`) to the externally reachable CRM origin (without `/api`). Development defaults to `http://localhost:4100`. Production requires an explicit URL. Existing CRM-to-core `MOVIRA_CORE_API_BASE_URL`/internal-secret settings and core-to-Guest-AI settings must be configured as before.
4. Save the shared channel settings. Manage AI knowledge, publishing, activation, validation and lead-form configuration in Admin → Locations → Guest AI. The shared widget settings only select whether AI participates in conversations. Use human-only without activating a catalog.
5. Add exact allowed origins for the website and booking portal. Also add the Guest AI site's origin if existing standalone Guest AI links are used. Copy the new script for new installations; existing Guest AI `gaw_` installation snippets automatically resolve to the saved CRM `wc_` widget.

Compatibility is staged: parks without saved shared settings keep their legacy Guest AI widget. Once saved, old installation IDs and the booking portal resolve to CRM. A disabled unified widget cannot fall back to the old AI widget. Existing visitors may need a page refresh to load updated widget JavaScript. Historical Guest AI contacts and leads move into shared CRM tables with their IDs and data preserved; existing URLs remain supported. New full transcripts live in CRM and are linked from contact details. Legacy assistant conversation tables remain available for their existing callers.

Human handoff is an inbox queue, not a promise that a staff member is currently online. Configure the waiting message accordingly. Contact details are self-reported and never imply marketing consent or an authenticated customer identity.

Email-code verification is deferred. Starting chat uses the existing name/email form. Server-side email/phone validation, a hidden bot-trap field, an expiring signed form challenge scoped to the widget/origin/IP, and limits of 10 new chats/hour/IP/widget and 20 messages/minute/conversation reduce automated abuse. When deployed behind a reverse proxy, set `WEBCHAT_TRUSTED_PROXIES` to its trusted IPs/CIDRs so limits use the visitor address. Forwarded headers are ignored by default; this setting affects webchat only. These checks do not prove that a visitor is human or owns an email. Existing session tokens restore their own history; entering the same unverified email on another browser never exposes it.

In the staff inbox, clicking the email or **Open customer profile** resolves the email only within the selected park. A unique core customer opens the existing full customer-details overlay; a CRM-only contact opens the existing CRM drawer; a chat-only guest opens the existing Guest AI contact panel. No customer record or marketing consent is created by this lookup. Unverified identity is labelled explicitly.

## Verification

- CRM unit suite: `npm test`.
- Isolated PostgreSQL flow test: PowerShell `$env:RUN_UNIFIED_CHAT_DB_TEST='1'; node --test test/unifiedWebchat.integration.test.js`. It creates and removes its own random test schema, with core/AI calls stubbed.
- Core tests: `node --test --test-concurrency=1 --test-force-exit "tests/guest-ai-*.test.js"`.
- Guest AI: `npm test`.
- Admin and booking portal: `npm test` and `npm run build`.
- Browser checks from my-admin-app: `npx playwright test --config e2e/unified-chat.config.js`. API requests are intercepted; no customer messages or external lead notifications are sent.
