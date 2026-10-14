const assert = require("node:assert/strict");
const test = require("node:test");
const platformBranding = require("../src/shared/platformBranding");

test("Movira platform branding is fetched once and cached", async () => {
  platformBranding.resetCache();
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.match(url, /\/internal\/crm\/platform-branding$/);
    assert.ok(options.headers["x-internal-api-secret"]);
    return {
      ok: true,
      async json() {
        return { data: { emailBrandPrimaryColor: "#0F766E", emailBrandSecondaryColor: "#134E4A" } };
      },
    };
  };

  const first = await platformBranding.getPlatformBranding({ fetchImpl, now: 100 });
  const second = await platformBranding.getPlatformBranding({ fetchImpl, now: 200 });

  assert.equal(first.emailBrandPrimaryColor, "#0F766E");
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test("location email branding is resolved and cached independently", async () => {
  platformBranding.resetCache();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.match(url, /\/internal\/crm\/locations\/42\/email-branding$/);
    return {
      ok: true,
      async json() {
        return { data: { emailBrandName: "Yug Water Park", brandingSource: "location_white_label" } };
      },
    };
  };

  const first = await platformBranding.getEmailBranding(42, { fetchImpl, now: 100 });
  const second = await platformBranding.getEmailBranding(42, { fetchImpl, now: 200 });
  assert.equal(first.emailBrandName, "Yug Water Park");
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test("fresh location branding bypasses cache for test emails", async () => {
  platformBranding.resetCache();
  let calls = 0;
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      calls += 1;
      return { data: { emailBrandPrimaryColor: calls === 1 ? "#111111" : "#22AA66" } };
    },
  });

  await platformBranding.getEmailBranding(42, { fetchImpl, now: 100 });
  const fresh = await platformBranding.getEmailBranding(42, { fetchImpl, now: 200, fresh: true });

  assert.equal(fresh.emailBrandPrimaryColor, "#22AA66");
  assert.equal(calls, 2);
});

test("location branding failure never exposes platform support contacts", async () => {
  platformBranding.resetCache();
  const fetchImpl = async (url) => {
    if (url.includes("/locations/42/email-branding")) {
      return { ok: false, status: 503, async json() { return {}; } };
    }
    return {
      ok: true,
      async json() {
        return {
          data: {
            emailBrandName: "Movira360",
            supportEmail: "support@movira360.com",
            supportPhone: "+1 555 0100",
            supportUrl: "https://help.movira360.com",
          },
        };
      },
    };
  };

  const result = await platformBranding.getEmailBranding(42, { fetchImpl, now: 100 });
  assert.equal(result.emailBrandName, "Movira360");
  assert.equal(result.supportEmail, "");
  assert.equal(result.supportPhone, "");
  assert.equal(result.supportUrl, "");
});
