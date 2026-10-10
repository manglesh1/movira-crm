const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BRAND,
  buildTransactionalSystemDesign,
  buildTransactionalPlainText,
} = require("../src/modules/transactional/systemTemplateDesigns");
const {
  renderTemplate,
  normalizePayload,
} = require("../src/modules/transactional/templateRenderer");

const CASES = [
  ["bookingConfirmation", "booking", "Booking details"],
  ["giftcard-received", "giftcard", "Gift card details"],
  ["membership-suspended", "membership", "Membership status"],
  ["saasOnboardingStarted", "saas", "Workspace access"],
  ["saasInvoicePaid", "saas", "Payment receipt"],
];

test("system transactional designs use the global Movira360 frame and event content", () => {
  assert.equal(BRAND.primary, "#7220E6");
  assert.equal(BRAND.primaryHover, "#480D9A");

  for (const [key, family, expectedTitle] of CASES) {
    const design = buildTransactionalSystemDesign({
      key,
      family,
      name: key,
      defaults: {
        heading: "A useful event heading",
        paragraph: "Hi {{guestName}}, this event has useful details.",
      },
    });
    const serialized = JSON.stringify(design);

    assert.equal(design.settings.containerBorderWidth, 0.5);
    assert.equal(design.settings.containerBorderColor, BRAND.border);
    assert.equal(design.settings.buttonColor, BRAND.primary);
    assert.equal(design.settings.backgroundColor, BRAND.canvas);
    assert.match(serialized, /Movira360/);
    assert.match(serialized, /#7220E6/);
    assert.match(serialized, /#480D9A/);
    assert.doesNotMatch(serialized, /#0A66C2|#0755A3|#20AEE5|#071C2C|#0D3B56|#103A56/);
    assert.match(serialized, new RegExp(expectedTitle));
    assert.match(serialized, /Powered by/);
    assert.match(buildTransactionalPlainText({ key, family }), /Powered by Movira360/);
  }
});

test("transactional payload aliases preserve onboarding names and branding", () => {
  const payload = normalizePayload({
    customerName: "Asha Patel",
    locationName: "Sky Park",
    business: { email: "hello@sky.example" },
  });

  assert.equal(payload.guestName, "Asha Patel");
  assert.equal(payload.venueName, "Sky Park");
  assert.equal(payload.locationEmail, "hello@sky.example");
  assert.match(payload.moviraLogoUrl, /^https:\/\//);
});

test("rendered onboarding email has full frame, logo colors and no unresolved core aliases", () => {
  const designJson = buildTransactionalSystemDesign({
    key: "saasOnboardingStarted",
    family: "saas",
    name: "SaaS onboarding started",
    defaults: {
      heading: "Your Movira workspace is ready",
      paragraph: "Hi {{guestName}}, {{venueName}} onboarding has started.",
    },
  });
  const rendered = renderTemplate(
    {
      name: "SaaS onboarding started",
      subject: "Welcome {{guestName}} to {{venueName}}",
      editorType: "design",
      designJson,
      plainText: "Hi {{guestName}} — {{venueName}}\nPowered by Movira360",
    },
    {
      customerName: "Asha Patel",
      locationName: "Sky Park",
      onboardingPhase: "Park workspace",
      organizationName: "Sky Group",
      modules: "bookings, crm",
      loginUrl: "https://app.movira360.com/login",
    }
  );

  assert.equal(rendered.subject, "Welcome Asha Patel to Sky Park");
  assert.match(rendered.body, /class="mframe"/);
  assert.match(rendered.body, /border:0\.5px solid/);
  assert.match(rendered.body, new RegExp(BRAND.primary.replace("#", ""), "i"));
  assert.match(rendered.body, /Powered by/);
  assert.doesNotMatch(rendered.body, /\{\{\s*(guestName|venueName)\s*\}\}/);
});

test("Movira Control invoice uses platform support once and renders an explicit total", () => {
  const designJson = buildTransactionalSystemDesign({
    key: "saasInvoiceIssued",
    family: "saas",
    name: "SaaS invoice issued",
    defaults: {
      heading: "Your Movira invoice is ready",
      paragraph: "Hi {{guestName}}, review invoice {{invoiceNumber}} below.",
    },
  });
  const rendered = renderTemplate(
    {
      name: "SaaS invoice issued",
      subject: "Invoice {{invoiceNumber}} for {{locationName}}",
      editorType: "design",
      designJson,
      plainText: "Invoice {{invoiceNumber}} total {{totalAmountLabel}}",
    },
    {
      templateScope: "movira_control",
      customerName: "Asha Patel",
      locationName: "Sky Park",
      invoiceNumber: "SAAS-10",
      totalAmountLabel: "$371.00",
      lineItemsHtml: "<div>Bookings — $49.00</div>",
      pricingRowsHtml: "<tr><td>Total</td><td>$371.00</td></tr>",
      supportEmail: "support@movira360.com",
      supportPhone: "+1 555 0100",
      supportUrl: "https://help.movira360.com",
    }
  );

  assert.match(rendered.body, /YOUR LOCATION/);
  assert.match(rendered.body, /support@movira360\.com/);
  assert.match(rendered.body, /<td>Total<\/td><td>\$371\.00<\/td>/);
  assert.doesNotMatch(rendered.body, /YOUR VENUE|Secure venue communication/);
  assert.equal((rendered.body.match(/Bookings — \$49\.00/g) || []).length, 1);
});
