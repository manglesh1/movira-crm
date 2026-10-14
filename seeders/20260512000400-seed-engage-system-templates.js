"use strict";

// Recovered from the old aeroSportsAdmin/services/engage/templates/_systemCatalog.js
// (commit 3736134). 32 email templates total, plus families for grouping.
//
// Placeholder convention from the legacy catalog uses [Venue.Name] etc.
// We preserve those bracket-style tokens inside the body HTML AND a converted
// {{locationName}} version on the same line, so this works whether the binding's
// variableMap re-maps them or the caller already sends the camelCase names.

const SYSTEM_TEMPLATES = [
  // family: booking
  {
    slug: "bookingConfirmation",
    name: "Order confirmation",
    family: "booking",
    description: "Sent to the guest with confirmation and booking details when an order is made",
    subject: "Get ready to visit {{locationName}}",
    heading: "Order confirmed!",
    paragraph:
      "Hi {{guestName}},<br/>Thanks for choosing {{locationName}}. Please see below for instructions.",
  },
  {
    slug: "canceled-tentative-booking",
    name: "Canceled tentative booking",
    family: "booking",
    description:
      "Email sent to inform guests that their booking has been automatically canceled due to non-payment",
    subject: "Your tentative booking at {{locationName}} was cancelled",
    heading: "Booking cancelled",
    paragraph:
      "Hi {{guestName}},<br/>Your tentative booking was cancelled because payment was not completed in time. You're welcome to book again whenever you're ready.",
  },
  {
    slug: "fnb-order-confirmation",
    name: "Food and beverage order confirmation",
    family: "booking",
    description:
      "Sent to the guest with confirmation and booking details when a food and beverage order is made",
    subject: "Your F&B order at {{locationName}} is confirmed",
    heading: "Your order is in!",
    paragraph:
      "Hi {{guestName}},<br/>Your food &amp; beverage order is confirmed. We'll have it ready when you arrive at {{locationName}}.",
  },
  {
    slug: "booking-reminder",
    name: "Booking reminder",
    family: "booking",
    description: "Email sent to guests to remind them of useful information before their booking",
    subject: "Your visit to {{locationName}} is coming up!",
    heading: "See you soon!",
    paragraph:
      "Hi {{guestName}},<br/>Just a friendly reminder about your upcoming visit. Here's what you need to know.",
  },
  {
    slug: "signed-booking-agreement",
    name: "Signed booking agreement",
    family: "booking",
    description: "Email sent to guests after signing a booking agreement",
    subject: "Your booking agreement is signed",
    heading: "Booking agreement complete",
    paragraph:
      "Hi {{guestName}},<br/>Thanks for signing the booking agreement. A copy is attached for your records.",
  },
  {
    slug: "booking-agreement",
    name: "Booking agreement",
    family: "booking",
    description: "Email sent to guests requesting them to sign a booking agreement",
    subject: "Please sign your {{locationName}} booking agreement",
    heading: "Sign your booking agreement",
    paragraph:
      "Hi {{guestName}},<br/>To finalise your booking, please review and sign the agreement linked below.",
  },

  // family: guestList
  {
    slug: "guest-list-update",
    name: "Guest list update",
    family: "guestList",
    description: "Email sent to booking holder each time a guest RSVPs to their booking",
    subject: "A guest has RSVPd to your {{locationName}} booking",
    heading: "Your guest list just got bigger",
    paragraph:
      "Hi {{guestName}},<br/>Someone just RSVPd to your booking. Here's the latest guest list.",
  },
  {
    slug: "guest-list-rsvp-confirmed",
    name: "Guest list RSVP confirmed",
    family: "guestList",
    description: "Email sent to each to guest who RSVPs to a booking",
    subject: "You're in! See you at {{locationName}}",
    heading: "RSVP confirmed",
    paragraph: "Hi there,<br/>Thanks for confirming. We'll see you at {{locationName}}!",
  },
  {
    slug: "guest-list-rsvp-reminder",
    name: "Guest list RSVP reminder",
    family: "guestList",
    description: "Email sent to each to guest 24 hours before the booking",
    subject: "Tomorrow at {{locationName}} — see you there!",
    heading: "Tomorrow is the day",
    paragraph:
      "Hi there,<br/>Just a quick reminder about tomorrow's booking at {{locationName}}. Here's everything you need to know.",
  },

  // family: waiver
  {
    slug: "waiverLink",
    name: "Waiver request",
    family: "waiver",
    description: "Email sent to request guests to sign their waiver",
    subject: "Sign your waiver before visiting {{locationName}}",
    heading: "Sign your waiver",
    paragraph:
      "Hi {{guestName}},<br/>A quick waiver makes check-in faster. Sign it now to skip the queue.",
  },
  {
    slug: "waiver-complete",
    name: "Waiver complete",
    family: "waiver",
    description: "Sent to waiver signatory after waiver is signed",
    subject: "Your waiver is signed — see you at {{locationName}}",
    heading: "Waiver signed!",
    paragraph:
      "Hi {{guestName}},<br/>Thanks for completing your waiver. We can't wait to see you at {{locationName}}.",
  },
  {
    slug: "waiverExpiryReminder",
    name: "Waiver expiry reminder",
    family: "waiver",
    description: "Reminder that waiver is about to expire",
    subject: "Your {{locationName}} waiver is about to expire",
    heading: "Waiver expiring soon",
    paragraph:
      "Hi {{guestName}},<br/>Your waiver is about to expire. Renew it now to skip the queue.",
  },
  {
    slug: "waiver-reminder",
    name: "Waiver reminder",
    family: "waiver",
    description: "Reminder email sent for waiver signing, unless the guest list feature is enabled",
    subject: "Don't forget your waiver for {{locationName}}",
    heading: "Waiver still needs signing",
    paragraph:
      "Hi {{guestName}},<br/>Skip the queue when you arrive — sign your waiver before your visit.",
  },

  // family: payment
  {
    slug: "payment-receipt",
    name: "Payment receipt",
    family: "payment",
    description: "Manually sent to the guest from VM or POS",
    subject: "Your receipt from {{locationName}}",
    heading: "Thanks for your payment",
    paragraph:
      "Hi {{guestName}},<br/>Here's your receipt for your recent visit to {{locationName}}.",
  },
  {
    slug: "paymentLink",
    name: "Payment link",
    family: "payment",
    description: "Email used to send guests payment links",
    subject: "Action required: complete your payment for {{locationName}}",
    heading: "Payment required",
    paragraph: "Hi {{guestName}},<br/>Please complete your payment to confirm your booking.",
  },
  {
    slug: "invoice-email",
    name: "Invoice email",
    family: "payment",
    description:
      "Email used to send guests an invoice from the location booking details area",
    subject: "Invoice from {{locationName}}",
    heading: "Your invoice is attached",
    paragraph:
      "Hi {{guestName}},<br/>Please find your invoice attached. Reach out if you have any questions.",
  },

  // family: giftcard
  {
    slug: "giftcard-received",
    name: "Giftcard received",
    family: "giftcard",
    description: "Sent to giftcard recipient",
    subject: "You've received a giftcard from {{locationName}}",
    heading: "A gift just for you 🎁",
    paragraph:
      "Hi there,<br/>Someone special has sent you a giftcard from {{locationName}}. Redeem it any time at checkout.",
  },
  {
    slug: "gift-card-sent",
    name: "Gift card sent",
    family: "giftcard",
    description: "Sent to the gift card sender",
    subject: "Your gift card has been sent",
    heading: "Gift card on its way",
    paragraph:
      "Hi {{guestName}},<br/>Your gift card has been delivered. Thanks for sharing {{locationName}} with someone you love.",
  },

  // family: membership
  {
    slug: "membership-details",
    name: "Membership details",
    family: "membership",
    description:
      "Email containing membership details, sent to guest after purchasing memberships",
    subject: "Welcome to {{locationName}} — your membership is active",
    heading: "You're a member!",
    paragraph:
      "Hi {{guestName}},<br/>Your membership at {{locationName}} is now active. See your benefits below.",
  },
  {
    slug: "membership-purchase-receipt",
    name: "Membership purchase details",
    family: "membership",
    description:
      "Email sent after membership purchase with membership details, redemption QR, and usage instructions",
    subject: "Your {{locationName}} membership details",
    heading: "Your membership is ready",
    paragraph:
      "Hi {{guestName}},<br/>Your {{membershipName}} membership is active for {{locationName}}. Show the QR code at the POS or front desk to redeem.",
  },
  {
    slug: "membership-1st-failed-payment",
    name: "Membership 1st failed payment",
    family: "membership",
    description: "Email sent to guest after 1st failed payment",
    subject: "Action needed: payment failed for your {{locationName}} membership",
    heading: "Payment couldn't be processed",
    paragraph:
      "Hi {{guestName}},<br/>We weren't able to charge your card for this period's membership fee. Please update your payment details to avoid disruption.",
  },
  {
    slug: "membership-3rd-failed-payment",
    name: "Membership 3rd failed payment",
    family: "membership",
    description: "Email sent to guest after 3rd failed payment",
    subject: "Final notice: {{locationName}} membership at risk",
    heading: "Final payment notice",
    paragraph:
      "Hi {{guestName}},<br/>This is the third time we couldn't process your membership payment. Please update your card now or your membership will be cancelled.",
  },
  {
    slug: "membership-suspended",
    name: "Membership suspended",
    family: "membership",
    description:
      "Email sent to guest after 2nd failed payment to notify their membership has been suspended",
    subject: "Your {{locationName}} membership has been suspended",
    heading: "Membership suspended",
    paragraph:
      "Hi {{guestName}},<br/>Following repeated payment failures, your membership has been suspended. Update your payment details to reactivate it.",
  },
  {
    slug: "membership-successful-payment",
    name: "Membership successful payment",
    family: "membership",
    description:
      "Email sent to guest to notify them that their membership is active after successful payment",
    subject: "Payment received — your {{locationName}} membership is active",
    heading: "Payment received",
    paragraph:
      "Hi {{guestName}},<br/>Your payment was successful and your membership is active. Thanks for being part of {{locationName}}.",
  },
  {
    slug: "membership-cancelled",
    name: "Membership cancelled",
    family: "membership",
    description: "Email sent to guest after their membership has been cancelled",
    subject: "Your {{locationName}} membership has been cancelled",
    heading: "Membership cancelled",
    paragraph:
      "Hi {{guestName}},<br/>Your membership has been cancelled as requested. We'd love to have you back any time.",
  },
  {
    slug: "membership-expired",
    name: "Membership expired",
    family: "membership",
    description: "Email sent to guest after their membership has expired",
    subject: "Your {{locationName}} membership has expired",
    heading: "Membership expired",
    paragraph:
      "Hi {{guestName}},<br/>Your membership has expired. Renew now to keep your perks.",
  },
  {
    slug: "membership-renewal-winback",
    name: "Membership renewal winback",
    family: "membership",
    description:
      "Email sent to guest 30 and 60 days after their membership was expired/cancelled to prompt them to renew",
    subject: "We miss you at {{locationName}}",
    heading: "Come back to {{locationName}}",
    paragraph:
      "Hi {{guestName}},<br/>It's been a while. Renew your membership today and we'll have something special waiting for you.",
  },
  {
    slug: "membership-pending-cancellation",
    name: "Membership pending cancellation",
    family: "membership",
    description:
      "Email sent to guest after they have requested to cancel their membership via online accounts",
    subject: "Your {{locationName}} cancellation request is being processed",
    heading: "Cancellation pending",
    paragraph:
      "Hi {{guestName}},<br/>We've received your request to cancel. Your membership will end at the close of the current period.",
  },
  {
    slug: "group-membership-edited",
    name: "Group membership edited",
    family: "membership",
    description:
      "Email sent when an add-on member is added or removed from a group membership",
    subject: "Your {{locationName}} group membership has been updated",
    heading: "Group membership updated",
    paragraph:
      "Hi {{guestName}},<br/>A change has been made to your group membership. See the updated details below.",
  },
  {
    slug: "payment-details-update-link",
    name: "Payment details update link",
    family: "membership",
    description:
      "Email sent to guests to update payment details for recurring memberships",
    subject: "Update your payment details for {{locationName}}",
    heading: "Update your card on file",
    paragraph:
      "Hi {{guestName}},<br/>Please update your payment details to keep your recurring membership active.",
  },

  // family: simple (notifications)
  {
    slug: "guest-deleted",
    name: "Guest deleted",
    family: "simple",
    description: "Email sent to guests when their details have been deleted",
    subject: "Your {{locationName}} account has been deleted",
    heading: "Account removed",
    paragraph:
      "Hi there,<br/>Your account and personal details have been deleted as requested. We're sorry to see you go.",
  },
  {
    slug: "discount-code-issued",
    name: "Discount code issued",
    family: "simple",
    description: "Email sent when a discount code is issued on product purchase",
    subject: "Here's your discount code from {{locationName}}",
    heading: "A discount, just for you",
    paragraph:
      "Hi {{guestName}},<br/>Here's a special discount code as a thank-you. Use it on your next visit.",
  },
  {
    slug: "loyalty-reward-reminder",
    name: "Loyalty reward reminder",
    family: "simple",
    description:
      "Email sent to guests to remind them to redeem their loyalty rewards before they expire",
    subject: "Your {{locationName}} rewards expire soon",
    heading: "Rewards expiring soon",
    paragraph:
      "Hi {{guestName}},<br/>You have unused loyalty rewards that are about to expire. Redeem them on your next visit.",
  },
];

function buildBody(t) {
  return [
    `<h1>${t.heading}</h1>`,
    `<p>${t.paragraph}</p>`,
  ].join("\n");
}

function buildVariables(t) {
  const set = new Set();
  const text = `${t.subject || ""} ${t.heading || ""} ${t.paragraph || ""}`;
  const re = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    set.add(m[1]);
  }
  return Array.from(set);
}

function familyToCategory(family) {
  if (family === "booking") return "booking";
  if (family === "payment") return "payment";
  if (family === "waiver") return "waiver";
  if (family === "membership") return "membership";
  if (family === "giftcard") return "giftcard";
  if (family === "guestList") return "guest-list";
  return "system";
}

module.exports = {
  up: async (queryInterface) => {
    for (const t of SYSTEM_TEMPLATES) {
      const [existing] = await queryInterface.sequelize.query(
        `
        SELECT id, "isSystem" FROM crm_transactional_templates
        WHERE "locationId" IS NULL AND key = :key AND channel = 'email'
        LIMIT 1
        `,
        { replacements: { key: t.slug } }
      );

      const row = {
        family: t.family,
        description: t.description,
        category: familyToCategory(t.family),
      };

      if (existing.length) {
        // Idempotent heal — system templates are the canonical source.
        // If anyone (incl. past dev edits or hand-written SQL) drifted
        // a system template's name / subject / body / editorType /
        // designJson / family, re-running the seeder restores it. We
        // do NOT touch tenant clones (only rows where isSystem = true
        // AND locationId IS NULL).
        await queryInterface.bulkUpdate(
          "crm_transactional_templates",
          {
            name: t.name,
            family: row.family,
            category: row.category,
            description: row.description,
            subject: t.subject,
            body: buildBody(t),
            editorType: "code",
            designJson: null,
            plainText: null,
            defaults: JSON.stringify({
              subject: t.subject,
              heading: t.heading,
              paragraph: t.paragraph,
            }),
            updatedAt: new Date(),
          },
          { locationId: null, key: t.slug, channel: "email", isSystem: true }
        );
      } else {
        const variables = buildVariables(t);
        await queryInterface.bulkInsert("crm_transactional_templates", [
          {
            locationId: null,
            key: t.slug,
            channel: "email",
            name: t.name,
            category: row.category,
            family: row.family,
            description: row.description,
            subject: t.subject,
            body: buildBody(t),
            editorType: "code",
            designJson: null,
            plainText: null,
            config: JSON.stringify({ contentType: "html", textFallback: null }),
            defaults: JSON.stringify({
              subject: t.subject,
              heading: t.heading,
              paragraph: t.paragraph,
            }),
            variables: JSON.stringify(variables),
            isSystem: true,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]);
      }
    }
  },

  down: async (queryInterface) => {
    const newSlugs = SYSTEM_TEMPLATES
      .filter((t) => !["bookingConfirmation", "payment-receipt", "paymentLink", "waiverLink", "waiverExpiryReminder", "waiver-complete"].includes(t.slug))
      .map((t) => t.slug);
    if (newSlugs.length === 0) return;
    await queryInterface.sequelize.query(
      `DELETE FROM crm_transactional_templates WHERE "isSystem" = true AND channel = 'email' AND key IN (:slugs)`,
      { replacements: { slugs: newSlugs } }
    );
  },
};
