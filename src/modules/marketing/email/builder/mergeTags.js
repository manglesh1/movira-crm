// Merge fields intentionally mirror the customer/guest data currently exposed
// by aeroSportsAdmin's /api/customers endpoints. Keep this catalog narrow until
// the CRM owns more first-party objects.

const MERGE_TAG_GROUPS = [
  {
    key: "contact",
    label: "Contact",
    description: "AeroSportsAdmin guest/customer profile fields.",
    contexts: ["marketing", "transactional"],
    fields: [
      { label: "Full Name", token: "contact.fullName", type: "text", sampleValue: "Yogesh Niranjan" },
      { label: "First Name", token: "contact.firstName", type: "text", sampleValue: "Yogesh" },
      { label: "Last Name", token: "contact.lastName", type: "text", sampleValue: "Niranjan" },
      { label: "Guest Name", token: "guestName", type: "text", sampleValue: "Yogesh Niranjan", contexts: ["transactional"] },
      { label: "Guest First Name", token: "guestFirstName", type: "text", sampleValue: "Yogesh", contexts: ["transactional"] },
      { label: "Email", token: "contact.email", type: "email", sampleValue: "yogesh@example.com" },
      { label: "Phone", token: "contact.phone", type: "phone", sampleValue: "+1 555 0100" },
      { label: "Address", token: "contact.fullAddress", type: "text", sampleValue: "123 Main Street" },
      { label: "Postal Code", token: "contact.postalCode", type: "text", sampleValue: "M5V 2T6" },
      { label: "Gender", token: "contact.gender", type: "text", sampleValue: "other" },
      { label: "Source", token: "contact.source", type: "text", sampleValue: "booking" },
      { label: "Lifecycle", token: "contact.type", type: "text", sampleValue: "customer" },
      { label: "Tags", token: "contact.tags", type: "list", sampleValue: "vip,birthday" },
      { label: "Do Not Contact", token: "contact.doNotContact", type: "boolean", sampleValue: "false" },
      { label: "Engagement Score", token: "contact.engagementScore", type: "number", sampleValue: "82" },
      { label: "Last Engaged At", token: "contact.lastEngagedAt", type: "datetime", sampleValue: "2026-05-15" },
      {
        label: "Custom Fields",
        token: "contact.customFields",
        type: "group",
        children: [
          { label: "Membership Level", token: "contact.customFields.membershipLevel", type: "text", sampleValue: "Gold" },
          { label: "Preferred Activity", token: "contact.customFields.preferredActivity", type: "text", sampleValue: "Trampoline" },
          { label: "Birthday Month", token: "contact.customFields.birthdayMonth", type: "text", sampleValue: "May" },
        ],
      },
    ],
  },
  {
    key: "booking",
    label: "Latest Booking",
    description: "Most recent booking item shown on the customer profile.",
    contexts: ["marketing", "transactional"],
    fields: [
      { label: "Booking Number", token: "booking.number", type: "text", sampleValue: "BK-1001" },
      { label: "Booking Name", token: "booking.name", type: "text", sampleValue: "Birthday Party" },
      { label: "Booking Date", token: "booking.date", type: "date", sampleValue: "2026-05-15" },
      { label: "Booking Number", token: "bookingNumber", type: "text", sampleValue: "BK-1001", contexts: ["transactional"] },
      { label: "Booking Name", token: "bookingName", type: "text", sampleValue: "Birthday Party", contexts: ["transactional"] },
      { label: "Booking Date", token: "bookingDate", type: "date", sampleValue: "2026-05-15", contexts: ["transactional"] },
      { label: "Status", token: "booking.status", type: "text", sampleValue: "confirmed" },
      { label: "Payment Status", token: "booking.paymentStatus", type: "text", sampleValue: "paid" },
      { label: "Activity Name", token: "booking.activityName", type: "text", sampleValue: "Open Jump" },
      { label: "Guest Count", token: "booking.guestCount", type: "number", sampleValue: "8" },
      { label: "Booked For", token: "booking.bookedFor", type: "list", sampleValue: "Aarav, Vihaan" },
      { label: "Total", token: "booking.total", type: "money", sampleValue: "$249.00" },
      { label: "Total Amount", token: "totalAmount", type: "money", sampleValue: "$249.00", contexts: ["transactional"] },
      { label: "Balance", token: "booking.balance", type: "money", sampleValue: "$0.00" },
      { label: "Receipt URL", token: "booking.receiptUrl", type: "url", sampleValue: "https://example.test/receipts/1001" },
      { label: "Receipt URL", token: "receiptUrl", type: "url", sampleValue: "https://example.test/receipts/1001", contexts: ["transactional"] },
      { label: "Tickets URL", token: "booking.ticketsUrl", type: "url", sampleValue: "https://example.test/tickets/BK-1001" },
      { label: "Tickets URL", token: "ticketsUrl", type: "url", sampleValue: "https://example.test/tickets/BK-1001", contexts: ["transactional"] },
      { label: "QR Code URL", token: "booking.qrCodeUrl", type: "url", sampleValue: "https://api.qrserver.com/v1/create-qr-code/?size=204x204&data=BK-1001" },
      { label: "QR Code URL", token: "qrCodeUrl", type: "url", sampleValue: "https://api.qrserver.com/v1/create-qr-code/?size=204x204&data=BK-1001", contexts: ["transactional"] },
    ],
  },
  {
    key: "membership",
    label: "Membership",
    description: "Latest membership fields from the customer profile.",
    contexts: ["marketing", "transactional"],
    fields: [
      { label: "Activity Name", token: "membership.activityName", type: "text", sampleValue: "Annual Pass" },
      { label: "Status", token: "membership.status", type: "text", sampleValue: "active" },
      { label: "Purchased At", token: "membership.purchasedAt", type: "date", sampleValue: "2026-05-01" },
      { label: "Activated At", token: "membership.activatedAt", type: "date", sampleValue: "2026-05-02" },
      { label: "Expires At", token: "membership.expiresAt", type: "date", sampleValue: "2027-05-02" },
      { label: "Auto Renew", token: "membership.autoRenew", type: "boolean", sampleValue: "true" },
    ],
  },
  {
    key: "waiver",
    label: "Waiver",
    description: "Latest waiver/signature state from the customer profile.",
    contexts: ["marketing", "transactional"],
    fields: [
      { label: "Status", token: "waiver.status", type: "text", sampleValue: "valid" },
      { label: "Name", token: "waiver.name", type: "text", sampleValue: "Standard Waiver" },
      { label: "Signed At", token: "waiver.signedAt", type: "date", sampleValue: "2026-05-10" },
      { label: "Expires At", token: "waiver.expiresAt", type: "date", sampleValue: "2027-05-10" },
      { label: "Signed By", token: "waiver.signedBy", type: "text", sampleValue: "Yogesh Niranjan" },
      { label: "Share URL", token: "waiver.shareUrl", type: "url", sampleValue: "https://example.test/waiver/share/BK-1001" },
      { label: "Waiver Link", token: "waiverShareUrl", type: "url", sampleValue: "https://example.test/waiver/share/BK-1001", contexts: ["transactional"] },
    ],
  },
  {
    key: "payment",
    label: "Payment",
    description: "Payment summary based on the latest booking item.",
    contexts: ["marketing", "transactional"],
    fields: [
      { label: "Amount", token: "payment.amount", type: "money", sampleValue: "$249.00" },
      { label: "Amount Paid", token: "amountPaid", type: "money", sampleValue: "$249.00", contexts: ["transactional"] },
      { label: "Balance", token: "payment.balance", type: "money", sampleValue: "$0.00" },
      { label: "Status", token: "payment.status", type: "text", sampleValue: "paid" },
      { label: "Discount", token: "payment.discount", type: "money", sampleValue: "$10.00" },
      { label: "Amount Due", token: "payment.amountDue", type: "money", sampleValue: "$0.00" },
      { label: "Amount Due", token: "amountDue", type: "money", sampleValue: "$0.00", contexts: ["transactional"] },
      { label: "Gateway", token: "payment.gateway", type: "text", sampleValue: "Stripe" },
      { label: "Payment Link", token: "payment.link", type: "url", sampleValue: "https://example.test/pay/1001" },
      { label: "Payment Link", token: "paymentLink", type: "url", sampleValue: "https://example.test/pay/1001", contexts: ["transactional"] },
    ],
  },
  {
    key: "business",
    label: "Business",
    description: "Sender/business fields used in footers and compliance copy.",
    contexts: ["marketing", "transactional"],
    fields: [
      { label: "Name", token: "business.name", type: "text", sampleValue: "Movira" },
      { label: "Location Name", token: "locationName", type: "text", sampleValue: "Movira", contexts: ["transactional"] },
      { label: "Address", token: "business.address", type: "text", sampleValue: "123 Main Street" },
      { label: "Location Address", token: "locationAddress", type: "text", sampleValue: "123 Main Street", contexts: ["transactional"] },
      { label: "Phone", token: "business.phone", type: "phone", sampleValue: "+1 555 0100" },
      { label: "Location Phone", token: "locationPhone", type: "phone", sampleValue: "+1 555 0100", contexts: ["transactional"] },
      { label: "Email", token: "business.email", type: "email", sampleValue: "hello@example.test" },
      { label: "Location Email", token: "locationEmail", type: "email", sampleValue: "hello@example.test", contexts: ["transactional"] },
      { label: "Website", token: "business.website", type: "url", sampleValue: "https://example.test" },
    ],
  },
  {
    key: "email",
    label: "Email Links",
    description: "Runtime URLs generated by the email system.",
    contexts: ["marketing", "transactional"],
    fields: [
      { label: "View in browser URL", token: "viewInBrowserUrl", type: "url", runtime: true, sampleValue: "https://example.test/view" },
      { label: "Unsubscribe URL", token: "unsubscribeUrl", type: "url", runtime: true, sampleValue: "https://example.test/unsubscribe" },
    ],
  },
];

function filterGroupsByContext(groups, context) {
  if (!context || context === "all" || context === "both") return groups;
  return groups
    .filter((group) => !group.contexts || group.contexts.includes(context))
    .map((group) => ({
      ...group,
      fields: filterFieldsByContext(group.fields || [], context),
    }));
}

function filterFieldsByContext(fields, context) {
  return fields
    .filter((field) => !field.contexts || field.contexts.includes(context))
    .map((field) => ({
      ...field,
      children: field.children ? filterFieldsByContext(field.children, context) : undefined,
    }));
}

function setPath(target, path, value) {
  const parts = String(path || "").split(".").filter(Boolean);
  if (!parts.length) return;
  let cursor = target;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      cursor[part] = value;
      return;
    }
    if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
    cursor = cursor[part];
  });
}

function collectFields(fields = []) {
  return fields.flatMap((field) => (field.children?.length ? collectFields(field.children) : [field]));
}

function createSampleMergeData(groups = MERGE_TAG_GROUPS) {
  const data = {
    unsubscribeUrl: "https://example.test/unsubscribe",
    viewInBrowserUrl: "https://example.test/view",
  };
  groups.forEach((group) => {
    collectFields(group.fields || []).forEach((field) => {
      if (field.runtime || !field.token || field.type === "group") return;
      setPath(data, field.token, field.sampleValue ?? "");
    });
  });
  Object.assign(data, {
    guestName: data.contact?.fullName || "Yogesh Niranjan",
    guestFirstName: data.contact?.firstName || "Yogesh",
    venueName: data.business?.name || "Movira",
    locationName: data.business?.name || "Movira",
    locationAddress: data.business?.address || "123 Main Street",
    locationPhone: data.business?.phone || "+1 555 0100",
    locationEmail: data.business?.email || "hello@example.test",
    bookingNumber: data.booking?.number || "BK-1001",
    bookingId: data.booking?.number || "BK-1001",
    bookingName: data.booking?.name || "Birthday Party",
    bookingDate: data.booking?.date || "2026-05-15",
    totalAmount: data.booking?.total || "$249.00",
    amount: data.payment?.amount || "$249.00",
    amountPaid: data.payment?.amount || "$249.00",
    amountDue: data.payment?.amountDue || "$0.00",
    balanceDue: data.payment?.balance || "$0.00",
    gateway: data.payment?.gateway || "Stripe",
    paymentLink: data.payment?.link || "https://example.test/pay/1001",
    waiverShareUrl: data.waiver?.shareUrl || "https://example.test/waiver/share/BK-1001",
    receiptUrl: data.booking?.receiptUrl || "https://example.test/receipts/1001",
    ticketsUrl: data.booking?.ticketsUrl || "https://example.test/tickets/BK-1001",
    qrCodeUrl: data.booking?.qrCodeUrl || "https://api.qrserver.com/v1/create-qr-code/?size=204x204&data=BK-1001",
    lineItemsHtml:
      '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding:8px 0;border-bottom:1px solid #eef2f7;"><div class="txn-value">Open Jump - General Admission</div><div class="txn-muted">2 x $22.00</div></td><td align="right" style="padding:8px 0;border-bottom:1px solid #eef2f7;" class="txn-value">$44.00</td></tr><tr><td style="padding:8px 0;border-bottom:1px solid #eef2f7;"><div class="txn-value">Jumping socks</div><div class="txn-muted">2 x $5.00</div></td><td align="right" style="padding:8px 0;border-bottom:1px solid #eef2f7;" class="txn-value">$10.00</td></tr></table>',
    pricingRowsHtml:
      '<tr><td class="txn-muted" style="padding:4px 0;">Subtotal</td><td align="right" class="txn-muted" style="padding:4px 0;">$54.00</td></tr><tr><td class="txn-muted" style="padding:4px 0;">Tax</td><td align="right" class="txn-muted" style="padding:4px 0;">$7.02</td></tr><tr><td class="txn-value" style="padding:10px 0;border-top:1px solid #e5e7eb;">Total</td><td align="right" class="txn-value" style="padding:10px 0;border-top:1px solid #e5e7eb;">$61.02</td></tr>',
    chargedSummaryHtml:
      '<div style="margin-top:16px;padding-top:14px;border-top:1px solid #e5e7eb;"><div class="txn-label">Charged</div><div class="txn-total" style="font-size:22px;margin-top:4px;">$61.02</div><div class="txn-muted" style="margin-top:6px;">Credit card •••• 4781</div></div>',
  });
  return data;
}

function getMergeTagCatalog({ context = "all" } = {}) {
  const groups = filterGroupsByContext(MERGE_TAG_GROUPS, context);
  return {
    schemaVersion: 1,
    context,
    syntax: "{{ token.path }}",
    source: "aeroSportsAdmin.customers",
    groups,
    sampleData: createSampleMergeData(groups),
  };
}

module.exports = {
  MERGE_TAG_GROUPS,
  createSampleMergeData,
  getMergeTagCatalog,
};
