const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

// Canonical Movira360 email tokens. Values are kept in one JS object and
// inlined by the design generator because several major email clients still do
// not reliably support CSS custom properties.
const BRAND = Object.freeze({
  primary: "#7220E6",
  primaryHover: "#480D9A",
  cyan: "#A66BFF",
  navy: "#24113F",
  hero: "#480D9A",
  navySoft: "#5C1AB1",
  canvas: "#F8F6FC",
  surface: "#FFFFFF",
  soft: "#F3ECFD",
  border: "#D9C7F3",
  divider: "#E9DFF7",
  text: "#241A33",
  muted: "#756A82",
  white: "#FFFFFF",
  onDarkMuted: "#EEE4FC",
  shadow: "rgba(72,13,154,.10)",
  success: "#08745B",
  successSoft: "#E9F7F2",
  warning: "#936000",
  warningSoft: "#FFF6E2",
  danger: "#A8342B",
  dangerSoft: "#FFF1EF",
});

const FONT_STACK =
  "Aptos, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

const FAMILY_PROFILES = {
  customer_experience: { accent: BRAND.primary, dark: BRAND.navy, soft: BRAND.soft, label: "Customer Experience" },
  booking: { accent: BRAND.primary, dark: BRAND.navy, soft: BRAND.soft, label: "Booking" },
  payment: { accent: BRAND.primary, dark: BRAND.navy, soft: BRAND.soft, label: "Payment" },
  waiver: { accent: BRAND.primary, dark: BRAND.navy, soft: BRAND.soft, label: "Waiver" },
  membership: { accent: BRAND.primary, dark: BRAND.navy, soft: BRAND.soft, label: "Membership" },
  giftcard: { accent: BRAND.primary, dark: BRAND.navy, soft: BRAND.soft, label: "Gift Card" },
  guestList: { accent: BRAND.primary, dark: BRAND.navy, soft: BRAND.soft, label: "Guest List" },
  saas: { accent: BRAND.primary, dark: BRAND.navy, soft: BRAND.soft, label: "Movira360" },
  simple: { accent: BRAND.primary, dark: BRAND.navy, soft: BRAND.soft, label: "Notice" },
  system: { accent: BRAND.primary, dark: BRAND.navy, soft: BRAND.soft, label: "Notice" },
};

const TEMPLATE_PRESENTATION = Object.freeze({
  customerExperienceFeedbackRequest: { status: "Your feedback", title: "Tell us about your visit", tone: "primary" },
  customerExperienceFeedbackReceived: { status: "New response", title: "Guest feedback", tone: "primary" },
  customerExperienceRecoveryReply: { status: "Follow-up", title: "A message from your venue", tone: "primary" },
  customerExperienceRewardIssued: { status: "Thank you", title: "Your reward", tone: "success" },
  bookingConfirmation: { status: "Confirmed", title: "Booking details", tone: "success" },
  "canceled-tentative-booking": { status: "Cancelled", title: "Cancelled booking", tone: "danger" },
  "fnb-order-confirmation": { status: "Confirmed", title: "Food & beverage order", tone: "success" },
  "booking-reminder": { status: "Coming up", title: "Upcoming visit", tone: "primary" },
  "signed-booking-agreement": { status: "Signed", title: "Agreement details", tone: "success" },
  "booking-agreement": { status: "Action needed", title: "Agreement details", tone: "warning" },
  "guest-list-update": { status: "Updated", title: "Guest list update", tone: "primary" },
  "guest-list-rsvp-confirmed": { status: "RSVP confirmed", title: "RSVP details", tone: "success" },
  "guest-list-rsvp-reminder": { status: "Reminder", title: "RSVP reminder", tone: "warning" },
  waiverLink: { status: "Signature needed", title: "Waiver details", tone: "warning" },
  "waiver-complete": { status: "Signed", title: "Waiver confirmation", tone: "success" },
  waiverExpiryReminder: { status: "Expiring", title: "Waiver validity", tone: "warning" },
  "waiver-reminder": { status: "Signature needed", title: "Waiver details", tone: "warning" },
  "payment-receipt": { status: "Paid", title: "Payment receipt", tone: "success" },
  paymentLink: { status: "Payment due", title: "Payment request", tone: "warning" },
  "invoice-email": { status: "Invoice", title: "Invoice summary", tone: "primary" },
  "giftcard-received": { status: "Gift received", title: "Gift card details", tone: "success" },
  "gift-card-sent": { status: "Delivered", title: "Gift card delivery", tone: "success" },
  "membership-details": { status: "Active", title: "Membership details", tone: "success" },
  "membership-purchase-receipt": { status: "Active", title: "Membership purchase", tone: "success" },
  "membership-1st-failed-payment": { status: "Payment failed", title: "Membership billing", tone: "warning" },
  "membership-3rd-failed-payment": { status: "Final notice", title: "Membership billing", tone: "danger" },
  "membership-suspended": { status: "Suspended", title: "Membership status", tone: "danger" },
  "membership-successful-payment": { status: "Paid", title: "Membership payment", tone: "success" },
  "membership-cancelled": { status: "Cancelled", title: "Membership status", tone: "danger" },
  "membership-expired": { status: "Expired", title: "Membership status", tone: "warning" },
  "membership-renewal-winback": { status: "Renew", title: "Membership renewal", tone: "primary" },
  "membership-pending-cancellation": { status: "Pending", title: "Cancellation request", tone: "warning" },
  "group-membership-edited": { status: "Updated", title: "Group membership", tone: "primary" },
  "payment-details-update-link": { status: "Action needed", title: "Payment details", tone: "warning" },
  "guest-deleted": { status: "Completed", title: "Account deletion", tone: "primary" },
  "discount-code-issued": { status: "Ready", title: "Discount details", tone: "success" },
  "loyalty-reward-reminder": { status: "Expiring", title: "Reward details", tone: "warning" },
});

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function section(id, layout, settings, columns) {
  return {
    id,
    type: "section",
    layout,
    settings: {
      backgroundType: "content",
      mobileStack: true,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      ...settings,
    },
    columns,
  };
}

function column(id, width, blocks) {
  return { id, width, blocks };
}

function text(id, content, settings = {}) {
  return { id, type: "text", content, settings };
}

function heading(id, content, settings = {}) {
  return { id, type: "heading", content, settings };
}

function button(id, label, href, settings = {}) {
  return {
    id,
    type: "button",
    content: label,
    settings: {
      href,
      align: "left",
      radius: 10,
      paddingY: 12,
      paddingX: 18,
      fontSize: 13,
      fontWeight: 700,
      letterSpacing: ".01em",
      ...settings,
    },
  };
}

function image(id, src, settings = {}) {
  return { id, type: "image", settings: { src, width: 132, alt: "", ...settings } };
}

function code(id, content, settings = {}) {
  return { id, type: "code", content, settings };
}

function footer(id, content, settings = {}) {
  return { id, type: "footer", content, settings };
}

function styleVars(profile) {
  return `
    <style>
      .txn-card{border:.5px solid ${BRAND.border};border-radius:13px;overflow:hidden;background:${BRAND.surface};box-shadow:0 8px 24px ${BRAND.shadow};}
      .txn-row{border-bottom:.5px solid ${BRAND.divider};}
      .txn-label{font-family:${FONT_STACK};font-size:9px;color:${BRAND.muted};text-transform:uppercase;letter-spacing:.11em;font-weight:700;}
      .txn-value{font-family:${FONT_STACK};font-size:13px;color:${BRAND.text};font-weight:650;line-height:1.45;letter-spacing:-.01em;}
      .txn-muted{font-family:${FONT_STACK};font-size:11px;color:${BRAND.muted};line-height:1.55;}
      .txn-total{font-family:${FONT_STACK};font-size:20px;color:${BRAND.navy};font-weight:750;line-height:1.1;letter-spacing:-.025em;}
      .txn-pill{display:inline-block;background:${BRAND.navy};color:${BRAND.white};border-radius:999px;padding:4px 9px;font-family:${FONT_STACK};font-size:9px;font-weight:750;text-transform:uppercase;letter-spacing:.09em;}
      .txn-link{color:${profile.accent};text-decoration:none;font-weight:700;border-bottom:.5px solid ${profile.accent};}
    </style>
  `;
}

function toneColors(tone = "primary") {
  if (tone === "success") return { color: BRAND.success, background: BRAND.successSoft };
  if (tone === "warning") return { color: BRAND.warning, background: BRAND.warningSoft };
  if (tone === "danger") return { color: BRAND.danger, background: BRAND.dangerSoft };
  return { color: BRAND.primary, background: BRAND.soft };
}

function presentationFor(row = {}) {
  return TEMPLATE_PRESENTATION[row.key] || {
    status: row.family === "simple" ? "Notice" : "Update",
    title: row.name || "Details",
    tone: "primary",
  };
}

function buildSummaryCard(profile, title, rowsHtml, presentation = {}) {
  const tone = toneColors(presentation.tone);
  return `
    ${styleVars(profile)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="txn-card">
      <tr>
        <td style="padding:13px 16px;background:${profile.soft};border-bottom:.5px solid ${BRAND.divider};">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td>
                <span class="txn-pill">${profile.label}</span>
                <h2 style="margin:8px 0 0;font-family:${FONT_STACK};font-size:17px;line-height:1.25;letter-spacing:-.02em;color:${BRAND.navy};font-weight:750;">${title}</h2>
              </td>
              <td align="right" valign="top">
                <span style="display:inline-block;padding:6px 9px;border:.5px solid ${tone.color};border-radius:999px;background:${tone.background};color:${tone.color};font-family:${FONT_STACK};font-size:9px;font-weight:750;text-transform:uppercase;letter-spacing:.07em;">${presentation.status || "Update"}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      ${rowsHtml}
    </table>
  `;
}

function buildBookingMain(profile, row) {
  const presentation = presentationFor(row);
  const key = row.key || "";
  const showOrder = ["bookingConfirmation", "fnb-order-confirmation"].includes(key);
  const showAgreement = ["booking-agreement", "signed-booking-agreement"].includes(key);
  return buildSummaryCard(
    profile,
    presentation.title,
    `
      <tr class="txn-row">
        <td style="padding:13px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td><div class="txn-label">Booking</div><div class="txn-value">{{bookingNumber}}</div></td>
              <td align="right"><div class="txn-label">Visit date</div><div class="txn-value">{{bookingDate}}</div></td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:13px 16px;">
          ${
            showOrder
              ? '<div class="txn-label" style="margin-bottom:8px;">Order items</div>{{lineItemsHtml}}<div style="height:14px;line-height:14px;">&nbsp;</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">{{pricingRowsHtml}}</table>{{chargedSummaryHtml}}'
              : showAgreement
                ? '<div class="txn-label">Agreement</div><div class="txn-value">{{bookingName}}</div><div class="txn-muted" style="margin-top:8px;">Keep this email for your booking records.</div>'
                : '<div class="txn-label">Activity</div><div class="txn-value">{{bookingName}}</div><div class="txn-muted" style="margin-top:8px;">Venue: {{venueName}}</div>'
          }
        </td>
      </tr>
    `,
    presentation
  );
}

function buildPaymentMain(profile, key) {
  const isLink = key === "paymentLink";
  const presentation = presentationFor({ key, family: "payment" });
  return buildSummaryCard(
    profile,
    presentation.title,
    `
      <tr class="txn-row">
        <td style="padding:13px 16px;">
          <div class="txn-label">${isLink ? "Amount due" : "Amount paid"}</div>
          <div class="txn-total">${isLink ? "{{amountDue}}" : "{{amountPaid}}"}</div>
          <div class="txn-muted" style="margin-top:6px;">Booking {{bookingNumber}} at {{venueName}}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:13px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">{{pricingRowsHtml}}</table>
          {{chargedSummaryHtml}}
          <div class="txn-muted" style="margin-top:12px;">Payment method: {{gateway}}</div>
        </td>
      </tr>
    `,
    presentation
  );
}

function buildWaiverMain(profile, key) {
  const signed = key === "waiver-complete";
  const expiring = key === "waiverExpiryReminder";
  const presentation = presentationFor({ key, family: "waiver" });
  return buildSummaryCard(
    profile,
    presentation.title,
    `
      <tr class="txn-row">
        <td style="padding:13px 16px;">
          <div class="txn-label">Guest</div>
          <div class="txn-value">{{guestName}}</div>
          <div class="txn-muted" style="margin-top:6px;">{{venueName}}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:13px 16px;">
          <div class="txn-label">${signed || expiring ? "Expiry" : "Waiver link"}</div>
          <div class="txn-value">${signed || expiring ? "{{expiryDate}}" : '<a class="txn-link" href="{{waiverShareUrl}}">Open waiver</a>'}</div>
          <div class="txn-muted" style="margin-top:8px;">Booking {{bookingNumber}}</div>
        </td>
      </tr>
    `,
    presentation
  );
}

function buildMembershipMain(profile, row) {
  const presentation = presentationFor(row);
  return buildSummaryCard(
    profile,
    presentation.title,
    `
      <tr class="txn-row">
        <td style="padding:13px 16px;">
          <div class="txn-label">Member</div>
          <div class="txn-value">{{guestName}}</div>
          <div class="txn-muted" style="margin-top:6px;">{{membershipName}}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:13px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td class="txn-muted">Status</td><td align="right" class="txn-value">{{membership.status}}</td></tr>
            <tr><td class="txn-muted">Activated</td><td align="right" class="txn-value">{{membership.activatedAt}}</td></tr>
            <tr><td class="txn-muted">Expires</td><td align="right" class="txn-value">{{membership.expiresAt}}</td></tr>
          </table>
        </td>
      </tr>
    `,
    presentation
  );
}

function buildGuestListMain(profile, row) {
  const presentation = presentationFor(row);
  return buildSummaryCard(
    profile,
    presentation.title,
    `
      <tr class="txn-row">
        <td style="padding:13px 16px;">
          <div class="txn-label">Booking</div>
          <div class="txn-value">{{bookingNumber}}</div>
          <div class="txn-muted" style="margin-top:6px;">{{bookingDate}} · {{venueName}}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:13px 16px;">
          <div class="txn-label">Guest list</div>
          <div class="txn-value" style="margin-top:6px;">{{guestListSummary}}</div>
          <div class="txn-muted" style="margin-top:8px;">{{rsvpMessage}}</div>
        </td>
      </tr>
    `,
    presentation
  );
}

function buildGiftCardMain(profile, row) {
  const presentation = presentationFor(row);
  return buildSummaryCard(
    profile,
    presentation.title,
    `
      <tr class="txn-row">
        <td style="padding:15px 16px;">
          <div class="txn-label">Gift card value</div>
          <div class="txn-total" style="margin-top:6px;">{{giftCardAmount}}</div>
          <div class="txn-muted" style="margin-top:8px;">Recipient: {{recipientName}}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:13px 16px;">
          <div class="txn-label">Gift card code</div>
          <div class="txn-value" style="font-size:18px;letter-spacing:.08em;margin-top:5px;">{{giftCardCode}}</div>
          <div class="txn-muted" style="margin-top:8px;">Valid until {{expiryDate}}</div>
        </td>
      </tr>
    `,
    presentation
  );
}

function buildSimpleMain(profile, row) {
  const presentation = presentationFor(row);
  const key = row.key || "";
  const details =
    key === "discount-code-issued"
      ? '<div class="txn-label">Discount code</div><div class="txn-value" style="font-size:20px;letter-spacing:.08em;margin-top:5px;">{{discountCode}}</div><div class="txn-muted" style="margin-top:8px;">Valid until {{expiryDate}}</div>'
      : key === "loyalty-reward-reminder"
        ? '<div class="txn-label">Available reward</div><div class="txn-total" style="margin-top:6px;">{{rewardValue}}</div><div class="txn-muted" style="margin-top:8px;">Expires {{expiryDate}}</div>'
        : '<div class="txn-label">Account</div><div class="txn-value">{{guestName}}</div><div class="txn-muted" style="margin-top:8px;">The requested account action has been completed.</div>';
  return buildSummaryCard(
    profile,
    presentation.title,
    `<tr><td style="padding:15px 16px;">${details}</td></tr>`,
    presentation
  );
}

function buildGenericMain(profile, title, row) {
  const presentation = presentationFor(row);
  return buildSummaryCard(
    profile,
    presentation.title || title,
    `
      <tr class="txn-row">
        <td style="padding:13px 16px;">
          <div class="txn-label">Guest</div>
          <div class="txn-value">{{guestName}}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:13px 16px;">
          <div class="txn-label">Reference</div>
          <div class="txn-value">{{bookingNumber}}</div>
          <div class="txn-muted" style="margin-top:8px;">{{venueName}}</div>
        </td>
      </tr>
    `,
    presentation
  );
}

function saasRow(label, value) {
  return `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #F3F0EC;">
        <div class="txn-label">${label}</div>
      </td>
      <td align="right" style="padding:10px 0;border-bottom:1px solid #F3F0EC;">
        <div class="txn-value">${value}</div>
      </td>
    </tr>
  `;
}

function saasStatusFor(row) {
  const key = row.key || "";
  if (key === "saasInvoicePaymentLink") return "Payment due";
  if (key === "saasInvoicePaid") return "Paid";
  if (key === "saasInvoiceReminder") return "Reminder";
  if (key === "saasInvoiceVoided") return "Voided";
  if (key === "saasInvoiceRefunded") return "Refunded";
  if (key === "saasBillingPastDue") return "Past due";
  if (key === "saasBillingSuspended") return "Billing hold";
  if (key === "saasBillingRecovered") return "Recovered";
  if (key === "saasParkGoLive") return "Live";
  if (key === "saasParkGoLiveBlocked") return "Needs checks";
  if (key === "saasOnboardingStarted") return "Onboarding";
  return "SaaS update";
}

function buildSaasMain(profile, row) {
  const key = row.key || "";
  const onboarding = key === "saasOnboardingStarted";
  const parkLifecycle = key === "saasParkGoLive" || key === "saasParkGoLiveBlocked";
  const paymentLink = key === "saasInvoicePaymentLink";
  const paid = key === "saasInvoicePaid";
  const reminder = key === "saasInvoiceReminder" || key === "saasBillingPastDue" || key === "saasBillingSuspended";
  const refunded = key === "saasInvoiceRefunded";
  const title = onboarding
    ? "Workspace access"
    : parkLifecycle
      ? "Park launch status"
      : paid
        ? "Payment receipt"
        : paymentLink
          ? "Secure payment request"
          : "Billing summary";
  const amountValue = paid ? "{{paidAmountLabel}}" : refunded ? "{{paidAmountLabel}}" : reminder ? "{{balanceDueLabel}}" : "{{totalAmountLabel}}";
  const rows = onboarding || parkLifecycle
    ? [
        saasRow("Park", "{{venueName}}"),
        saasRow("Organization", "{{organizationName}}"),
        saasRow("Current phase", "{{onboardingPhase}}"),
        saasRow("Modules", "{{modules}}"),
      ].join("")
    : [
        saasRow("Invoice", "{{invoiceNumber}}"),
        saasRow("Billing cycle", "{{billingCycle}}"),
        saasRow("Period", "{{periodStart}} - {{periodEnd}}"),
        saasRow("Due date", "{{dueDate}}"),
        saasRow(paid ? "Paid amount" : refunded ? "Current paid balance" : reminder ? "Balance due" : "Total", amountValue),
      ].join("");
  const tone =
    ["saasInvoicePaid", "saasBillingRecovered", "saasParkGoLive"].includes(key)
      ? "success"
      : ["saasInvoiceVoided", "saasInvoiceRefunded", "saasBillingSuspended", "saasParkGoLiveBlocked"].includes(key)
        ? "danger"
        : reminder || paymentLink
          ? "warning"
          : "primary";
  const presentation = { status: saasStatusFor(row), tone };

  return buildSummaryCard(
    profile,
    title,
    `
      <tr class="txn-row">
        <td style="padding:10px 16px 12px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>
        </td>
      </tr>
      <tr>
        <td style="padding:15px 16px;background:${BRAND.canvas};">
          ${
            onboarding || parkLifecycle
              ? '<div class="txn-muted">{{lifecycleMessage}}</div><div class="txn-muted">Phase: {{onboardingPhase}}</div><div style="height:10px;line-height:10px;">&nbsp;</div>{{ownerAccessHtml}}'
              : '<div class="txn-label" style="margin-bottom:8px;">Line items</div>{{lineItemsHtml}}<div style="height:10px;line-height:10px;">&nbsp;</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="txn-muted">Base</td><td align="right" class="txn-value">{{baseAmount}}</td></tr><tr><td class="txn-muted">Modules</td><td align="right" class="txn-value">{{moduleAmount}}</td></tr><tr><td class="txn-muted">Discount</td><td align="right" class="txn-value">{{discountAmount}}</td></tr><tr><td class="txn-muted">Tax</td><td align="right" class="txn-value">{{taxAmount}}</td></tr></table>'
          }
          ${
            paymentLink
              ? `<div style="margin-top:14px;padding:12px 14px;border-radius:10px;background:${BRAND.white};border:.5px solid ${BRAND.border};color:${BRAND.text};font-size:13px;line-height:1.5;">This secure link is for your Movira360 subscription invoice. It is separate from guest checkout and POS payments.</div>`
              : ""
          }
        </td>
      </tr>
    `,
    presentation
  );
}

function buildCustomerExperienceMain(profile, row) {
  const presentation = presentationFor(row);
  let content;
  if (row.key === "customerExperienceFeedbackRequest") {
    content = `<div class="txn-label">Survey</div><div class="txn-value">{{surveyFormName}}</div>
      <p class="txn-muted">Choose a rating to start your survey. You can review it before submitting.</p>
      <div>${[1, 2, 3, 4, 5].map((rating) =>
        `<a class="txn-link" href="{{feedbackUrl}}?rating=${rating}" style="display:inline-block;padding:10px 14px;margin:3px;" aria-label="Rate your visit ${rating} out of 5">${rating}</a>`
      ).join(" ")}</div><p class="txn-muted">1 = Poor &nbsp; 5 = Excellent</p>`;
  } else if (row.key === "customerExperienceFeedbackReceived") {
    content = `<div class="txn-label">Guest</div><div class="txn-value">{{guestName}}</div>
      <div class="txn-muted">{{guestEmail}}</div>
      <p class="txn-value">Overall rating: {{ratingOverall}}/5</p>
      <div class="txn-label">Comment</div><p class="txn-value">{{feedbackComment}}</p>
      <div class="txn-label">Ratings by category</div>{{factorRatingsHtml}}`;
  } else {
    // Reply and reward details already live in their editable introduction.
    content = '<div class="txn-label">From</div><div class="txn-value">{{venueName}}</div>';
  }
  return buildSummaryCard(profile, presentation.title,
    `<tr><td style="padding:16px;">${content}</td></tr>`, presentation);
}

function actionFor(row) {
  const key = row.key;
  if (key === "customerExperienceFeedbackRequest") return { label: "Start survey", href: "{{feedbackUrl}}" };
  if (key === "customerExperienceFeedbackReceived") return { label: "View feedback", href: "{{feedbackAdminUrl}}" };
  if (key === "saasInvoicePaymentLink") return { label: "Pay invoice", href: "{{paymentLink}}" };
  if (key === "saasOnboardingStarted") return { label: "Open Movira", href: "{{loginUrl}}" };
  if (key === "saasParkGoLive") return { label: "Open Movira", href: "{{loginUrl}}" };
  if (key === "paymentLink") return { label: "Pay now", href: "{{paymentLink}}" };
  if (["waiverLink", "waiverExpiryReminder", "waiver-reminder"].includes(key)) {
    return { label: "Sign waiver", href: "{{waiverShareUrl}}" };
  }
  if (["booking-agreement"].includes(key)) return { label: "Review agreement", href: "{{agreementUrl}}" };
  if (["payment-details-update-link", "membership-1st-failed-payment", "membership-3rd-failed-payment", "membership-suspended"].includes(key)) {
    return { label: "Update payment details", href: "{{paymentUpdateUrl}}" };
  }
  if (key === "bookingConfirmation") return { label: "View tickets", href: "{{ticketsUrl}}" };
  if (key === "payment-receipt") return { label: "View receipt", href: "{{receiptUrl}}" };
  if (key === "membership-purchase-receipt") return { label: "Open membership", href: "{{membershipUrl}}" };
  if (key === "membership-renewal-winback") return { label: "Renew membership", href: "{{membershipRenewalUrl}}" };
  if (key === "discount-code-issued") return { label: "Book your visit", href: "{{bookingUrl}}" };
  if (key === "giftcard-received") return { label: "Use gift card", href: "{{giftCardUrl}}" };
  return null;
}

function mainContentFor(row, profile, headingText) {
  if (row.family === "customer_experience") return buildCustomerExperienceMain(profile, row);
  if (row.family === "saas") return buildSaasMain(profile, row);
  if (row.family === "booking") return buildBookingMain(profile, row);
  if (row.family === "payment") return buildPaymentMain(profile, row.key);
  if (row.family === "waiver") return buildWaiverMain(profile, row.key);
  if (row.family === "membership") return buildMembershipMain(profile, row);
  if (row.family === "guestList") return buildGuestListMain(profile, row);
  if (row.family === "giftcard") return buildGiftCardMain(profile, row);
  if (row.family === "simple") return buildSimpleMain(profile, row);
  return buildGenericMain(profile, headingText, row);
}

function headerReferenceFor(row = {}) {
  if (row.family === "customer_experience") return "{{venueName}}";
  if (row.family === "saas") {
    if (row.key === "saasOnboardingStarted") return "ONBOARDING";
    if (["saasParkGoLive", "saasParkGoLiveBlocked"].includes(row.key)) return "PARK STATUS";
    return "#{{invoiceNumber}}";
  }
  if (row.family === "membership") return "{{membershipName}}";
  if (row.family === "giftcard") return "{{giftCardCode}}";
  if (row.family === "simple") return presentationFor(row).status;
  return "#{{bookingNumber}}";
}

function headerStatusFor(row = {}) {
  return row.family === "saas" ? saasStatusFor(row) : presentationFor(row).status;
}

function factsFor(row = {}) {
  if (row.family === "customer_experience") {
    return [["VENUE", "{{venueName}}"], ["GUEST", "{{guestName}}"], ["STATUS", presentationFor(row).status]];
  }
  if (row.family === "saas") {
    if (["saasOnboardingStarted", "saasParkGoLive", "saasParkGoLiveBlocked"].includes(row.key)) {
      return [
        ["PARK", "{{venueName}}"],
        ["PHASE", "{{onboardingPhase}}"],
        ["STATUS", saasStatusFor(row)],
      ];
    }
    return [
      ["INVOICE", "{{invoiceNumber}}"],
      ["DUE DATE", "{{dueDate}}"],
      ["AMOUNT", "{{amountDueLabel}}"],
    ];
  }
  if (row.family === "payment") {
    return [
      ["BOOKING", "{{bookingNumber}}"],
      ["METHOD", "{{gateway}}"],
      ["AMOUNT", row.key === "paymentLink" ? "{{amountDue}}" : "{{amountPaid}}"],
    ];
  }
  if (row.family === "membership") {
    return [
      ["MEMBERSHIP", "{{membershipName}}"],
      ["STATUS", "{{membership.status}}"],
      ["VALID UNTIL", "{{membership.expiresAt}}"],
    ];
  }
  if (row.family === "giftcard") {
    return [
      ["VALUE", "{{giftCardAmount}}"],
      ["CODE", "{{giftCardCode}}"],
      ["EXPIRES", "{{expiryDate}}"],
    ];
  }
  if (row.family === "waiver") {
    return [
      ["GUEST", "{{guestName}}"],
      ["STATUS", presentationFor(row).status],
      ["EXPIRES", "{{expiryDate}}"],
    ];
  }
  return [
    ["BOOKING", "{{bookingNumber}}"],
    ["WHEN", "{{bookingDate}}"],
    ["VENUE", "{{venueName}}"],
  ];
}

function buildTransactionalSystemDesign(row = {}) {
  const defaults = parseJson(row.defaults);
  const family = row.family || row.category || "system";
  const profile = FAMILY_PROFILES[family] || FAMILY_PROFILES.system;
  const headingText = defaults.heading || row.name || "Update from {{venueName}}";
  const paragraph = defaults.paragraph || "Hi {{guestName}},<br/>Here are the details for your visit.";
  const action = actionFor(row);
  const mainHtml = mainContentFor(row, profile, headingText);
  const showQr = ["bookingConfirmation", "membership-purchase-receipt"].includes(row.key);
  const facts = factsFor(row);

  return {
    schemaVersion: 1,
    settings: {
      contentWidth: 600,
      backgroundColor: BRAND.canvas,
      bodyColor: BRAND.surface,
      fontFamily: FONT_STACK,
      fontSize: 14,
      textColor: BRAND.text,
      headingColor: BRAND.text,
      linkColor: profile.accent,
      buttonColor: profile.accent,
      dividerColor: BRAND.divider,
      containerBorderWidth: 0.5,
      containerBorderColor: BRAND.border,
      containerBorderRadius: 16,
      containerMarginTop: 24,
      containerMarginBottom: 24,
      customCss:
        `.mframe{box-shadow:0 18px 50px ${BRAND.shadow};}@media only screen and (max-width:480px){.txn-total{font-size:18px!important}.txn-card{border-radius:10px!important}.msec_sys_hero{padding:21px 18px!important}.msec_sys_main{padding:18px 14px!important}.msec_sys_header{padding:13px 14px!important}}`,
    },
    sections: [
      section("sys_brand_rail", "2", { backgroundColor: BRAND.primary, padding: { top: 0, right: 0, bottom: 0, left: 0 } }, [
        column("sys_brand_rail_primary", "72%", [
          code("sys_brand_rail_primary_line", `<div style="height:4px;line-height:4px;background:${BRAND.primary};font-size:1px;">&nbsp;</div>`),
        ]),
        column("sys_brand_rail_cyan", "28%", [
          code("sys_brand_rail_cyan_line", `<div style="height:4px;line-height:4px;background:${BRAND.cyan};font-size:1px;">&nbsp;</div>`),
        ]),
      ]),
      section("sys_header", "3", { backgroundColor: BRAND.surface, padding: { top: 15, right: 22, bottom: 15, left: 22 } }, [
        column("sys_header_logo", "14%", [
          code(
            "sys_logo_lockup",
            `<table role="presentation" width="50" cellspacing="0" cellpadding="0" border="0"><tr><td width="50" height="50" align="center" valign="middle" style="width:50px;height:50px;background:${BRAND.surface};border:.5px solid ${BRAND.border};border-radius:13px;"><img src="{{moviraLogoUrl}}" width="42" alt="Movira360" style="display:block;width:42px;max-width:42px;height:auto;border:0;margin:0 auto;" /></td></tr></table>`
          ),
        ]),
        column("sys_header_brand", "52%", [
          text("sys_movira_brand", `MOVIRA<span style="color:${BRAND.cyan};">360</span>`, {
            fontSize: 18,
            letterSpacing: ".015em",
            fontWeight: 750,
            color: BRAND.navy,
            padding: { top: 3, right: 10, bottom: 0, left: 0 },
          }),
          text("sys_brand", "{{venueName}}", {
            fontSize: 12,
            fontWeight: 650,
            color: BRAND.text,
            padding: { top: 3, right: 10, bottom: 0, left: 0 },
          }),
          text("sys_secure_note", "Secure venue communication", {
            fontSize: 9,
            letterSpacing: ".06em",
            fontWeight: 650,
            color: BRAND.muted,
            padding: { top: 3, right: 10, bottom: 0, left: 0 },
          }),
        ]),
        column("sys_header_meta", "34%", [
          code(
            "sys_reference_card",
            `<table role="presentation" align="right" cellspacing="0" cellpadding="0" border="0" style="margin-left:auto;background:${BRAND.soft};border:.5px solid ${BRAND.border};border-radius:11px;"><tr><td align="right" style="padding:8px 11px;font-family:${FONT_STACK};"><div style="font-size:8px;line-height:1.2;letter-spacing:.11em;font-weight:700;color:${BRAND.muted};">${headerStatusFor(row).toUpperCase()}</div><div style="margin-top:3px;font-size:11px;line-height:1.25;font-weight:750;color:${BRAND.primary};">${headerReferenceFor(row)}</div></td></tr></table>`
          ),
        ]),
      ]),
      section("sys_hero", showQr ? "2-3:1-3" : "1", { backgroundColor: BRAND.hero, padding: { top: 25, right: 26, bottom: 25, left: 26 } }, [
        column("sys_hero_copy", showQr ? "72%" : "100%", [
          text("sys_event_label", profile.label.toUpperCase(), { fontSize: 9, letterSpacing: ".14em", fontWeight: 700, color: BRAND.cyan, padding: { top: 0, right: 10, bottom: 8, left: 0 } }),
          heading("sys_heading", headingText, { fontSize: 23, lineHeight: "1.2", letterSpacing: "-.025em", fontWeight: 750, color: BRAND.white, padding: { top: 0, right: 10, bottom: 9, left: 0 } }),
          text("sys_intro", paragraph, { fontSize: 12, lineHeight: "1.6", fontWeight: 400, color: BRAND.onDarkMuted, padding: { top: 0, right: 10, bottom: 0, left: 0 } }),
        ]),
        ...(showQr
          ? [
              column("sys_hero_qr", "28%", [
                image("sys_qr", "{{qrCodeUrl}}", { align: "right", width: 96, alt: "Access QR code", borderRadius: 8, padding: { top: 2, right: 0, bottom: 7, left: 0 } }),
                text("sys_qr_hint", "Show at check-in", { align: "right", fontSize: 10, color: BRAND.white, padding: { top: 0, right: 0, bottom: 0, left: 0 } }),
              ]),
            ]
          : []),
      ]),
      section("sys_facts", "3", { backgroundColor: BRAND.soft, padding: { top: 14, right: 26, bottom: 15, left: 26 } }, [
        ...facts.map(([label, value], index) =>
          column(`sys_fact_${index}`, "33.33%", [
            text(`sys_fact_${index}_label`, label, { fontSize: 8, letterSpacing: ".12em", fontWeight: 700, color: BRAND.primary, padding: { top: 0, right: 8, bottom: 5, left: 0 } }),
            text(`sys_fact_${index}_value`, value, { fontSize: 11, letterSpacing: "-.005em", fontWeight: 650, color: BRAND.text, padding: { top: 0, right: 8, bottom: 0, left: 0 } }),
          ])
        ),
      ]),
      section("sys_main", "1", { backgroundColor: BRAND.surface, padding: { top: 22, right: 22, bottom: 20, left: 22 } }, [
        column("sys_main_col", "100%", [
          code("sys_main_card", mainHtml),
          ...(action
            ? [
                button("sys_action", action.label, action.href, {
                  backgroundColor: profile.accent,
                  color: BRAND.white,
                  align: "left",
                  fontSize: 13,
                  paddingY: 11,
                  padding: { top: 16, right: 0, bottom: 4, left: 0 },
                }),
              ]
            : []),
        ]),
      ]),
      section("sys_footer", "3", { backgroundColor: BRAND.soft, padding: { top: 18, right: 22, bottom: 17, left: 22 } }, [
        column("sys_footer_logo", "13%", [
          image("sys_footer_mark", "{{moviraLogoUrl}}", {
            align: "left",
            width: 44,
            alt: "Movira360",
            padding: { top: 1, right: 10, bottom: 0, left: 0 },
          }),
        ]),
        column("sys_footer_venue", "49%", [
          text("sys_footer_venue_label", "YOUR VENUE", {
            fontSize: 9,
            letterSpacing: ".11em",
            fontWeight: 700,
            color: BRAND.primary,
            padding: { top: 0, right: 12, bottom: 4, left: 0 },
          }),
          footer("sys_footer_venue_details", `<strong style="color:${BRAND.text};font-weight:650;">{{venueName}}</strong><br>{{locationAddress}}`, {
            fontSize: 11,
            color: BRAND.muted,
            lineHeight: "1.55",
            padding: { top: 0, right: 12, bottom: 0, left: 0 },
          }),
        ]),
        column("sys_footer_support", "38%", [
          text("sys_footer_support_label", "HELP &amp; SUPPORT", {
            align: "right",
            fontSize: 9,
            letterSpacing: ".11em",
            fontWeight: 700,
            color: BRAND.primary,
            padding: { top: 0, right: 0, bottom: 4, left: 0 },
          }),
          footer("sys_footer_support_details", `<a href="mailto:{{locationEmail}}" style="color:${BRAND.text};text-decoration:none;font-weight:650;">{{locationEmail}}</a><br>{{locationPhone}}`, {
            align: "right",
            fontSize: 11,
            color: BRAND.muted,
            lineHeight: "1.55",
            padding: { top: 0, right: 0, bottom: 0, left: 0 },
          }),
        ]),
      ]),
      section("sys_powered", "1", { backgroundColor: BRAND.navy, padding: { top: 11, right: 22, bottom: 12, left: 22 } }, [
        column("sys_powered_col", "100%", [
          footer("sys_powered_text", `Powered by <a href="{{movira360Url}}" style="color:${BRAND.cyan};text-decoration:none;font-weight:750;">Movira360</a><span style="color:${BRAND.onDarkMuted};"> &nbsp;•&nbsp; Smart venue operations</span>`, {
            align: "center",
            fontSize: 10,
            color: BRAND.white,
            lineHeight: "1.5",
            padding: { top: 0, right: 0, bottom: 0, left: 0 },
          }),
        ]),
      ]),
    ],
  };
}

function collectTokens(value, out = new Set()) {
  if (value == null) return out;
  if (typeof value === "string") {
    let match;
    while ((match = TOKEN_RE.exec(value)) !== null) out.add(match[1]);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectTokens(item, out));
    return out;
  }
  if (typeof value === "object") {
    Object.values(value).forEach((item) => collectTokens(item, out));
  }
  return out;
}

function collectTransactionalVariables(row, design) {
  return Array.from(collectTokens([row.subject, row.body, row.plainText, design])).sort();
}

function buildTransactionalPlainText(row = {}) {
  const defaults = parseJson(row.defaults);
  if (row.family === "customer_experience") {
    const details = row.key === "customerExperienceFeedbackRequest"
      ? ["Survey: {{surveyFormName}}", "Start survey: {{feedbackUrl}}"]
      : row.key === "customerExperienceFeedbackReceived"
        ? ["Guest: {{guestName}}", "Email: {{guestEmail}}", "Overall rating: {{ratingOverall}}/5", "Comment: {{feedbackComment}}", "View feedback: {{feedbackAdminUrl}}"]
        : [];
    return [
      defaults.heading || row.name || presentationFor(row).title, "",
      String(defaults.paragraph || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""),
      "", "Venue: {{venueName}}", ...details, "", "Powered by Movira360",
    ].join("\n");
  }
  if (row.family === "saas") {
    return [
      defaults.heading || row.name || "Movira SaaS update",
      "",
      String(defaults.paragraph || "Hi {{guestName}}, here is your Movira SaaS update.")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, ""),
      "",
      "Park: {{venueName}}",
      "Organization: {{organizationName}}",
      "Invoice: {{invoiceNumber}}",
      "Status: {{status}}",
      "Amount due: {{amountDueLabel}}",
      "Due date: {{dueDate}}",
      "Payment link: {{paymentLink}}",
      "Login URL: {{loginUrl}}",
      "",
      "Powered by Movira360",
    ].join("\n");
  }
  return [
    defaults.heading || row.name || "Update from {{venueName}}",
    "",
    String(defaults.paragraph || "Hi {{guestName}}, here are your details.").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""),
    "",
    "Booking: {{bookingNumber}}",
    "Date: {{bookingDate}}",
    "Venue: {{venueName}}",
    "Total: {{totalAmount}}",
    "",
    "Powered by Movira360",
  ].join("\n");
}

module.exports = {
  buildTransactionalSystemDesign,
  buildTransactionalPlainText,
  collectTransactionalVariables,
  BRAND,
  TEMPLATE_PRESENTATION,
};
