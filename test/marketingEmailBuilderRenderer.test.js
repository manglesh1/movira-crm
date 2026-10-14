const assert = require("node:assert/strict");
const test = require("node:test");
const { renderDesign } = require("../src/modules/marketing/email/builder/renderer");
const { createDefaultDesign } = require("../src/modules/marketing/email/builder/defaultDesign");

test("renders the default marketing email design as table-based HTML", () => {
  const { html } = renderDesign(createDefaultDesign(), { title: "Welcome" });

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /role="presentation"/);
  assert.match(html, /width="600"/);
  assert.match(html, /Start from scratch/);
});

test("applies centrally supplied white-label colours at render time", () => {
  const design = createDefaultDesign({
    settings: { linkColor: "#7220E6", buttonColor: "#7220E6" },
    sections: [
      {
        id: "brand_section",
        type: "section",
        settings: { backgroundColor: "#480D9A" },
        columns: [{ id: "brand_column", width: "100%", blocks: [{ id: "brand_button", type: "button", content: "Continue", settings: { href: "https://example.test", backgroundColor: "#7220E6" } }] }],
      },
    ],
  });

  const { html } = renderDesign(design, {
    data: { emailBrandPrimaryColor: "#0F766E", emailBrandSecondaryColor: "#134E4A" },
  });

  assert.match(html, /#0F766E/);
  assert.match(html, /#134E4A/);
  assert.doesNotMatch(html, /#7220E6/i);
  assert.doesNotMatch(html, /#480D9A/i);
});

test("interpolates merge tags and escapes button labels", () => {
  const design = {
    schemaVersion: 1,
    settings: { contentWidth: 600 },
    sections: [
      {
        id: "sec_1",
        type: "section",
        columns: [
          {
            id: "col_1",
            width: "100%",
            blocks: [
              {
                id: "heading_1",
                type: "heading",
                content: "Hi {{contact.firstName}}",
              },
              {
                id: "button_1",
                type: "button",
                content: "Claim <deal>",
                settings: { href: "https://example.test/deal" },
              },
            ],
          },
        ],
      },
    ],
  };

  const { html } = renderDesign(design, {
    data: { contact: { firstName: "Yogesh" } },
  });

  assert.match(html, /Hi Yogesh/);
  assert.match(html, /Claim &lt;deal&gt;/);
  assert.match(html, /https:\/\/example\.test\/deal/);
});

test("drops untrusted code blocks and unsafe image URLs", () => {
  const design = {
    schemaVersion: 1,
    sections: [
      {
        id: "sec_1",
        columns: [
          {
            id: "col_1",
            blocks: [
              { id: "code_1", type: "code", content: "<script>alert(1)</script>" },
              { id: "img_1", type: "image", settings: { src: "javascript:alert(1)" } },
            ],
          },
        ],
      },
    ],
  };

  const { html } = renderDesign(design);

  assert.doesNotMatch(html, /<script>/i);
  assert.doesNotMatch(html, /javascript:/i);
});

test("adds open pixel and rewrites external links when tracking is enabled", () => {
  const design = {
    schemaVersion: 1,
    sections: [
      {
        id: "sec_1",
        columns: [
          {
            id: "col_1",
            blocks: [
              {
                id: "text_1",
                type: "text",
                content: '<a href="https://example.test/a">Read more</a>',
              },
            ],
          },
        ],
      },
    ],
  };

  const { html } = renderDesign(design, {
    tracking: {
      clickBaseUrl: "https://crm.movira.test/m/click/msg_1",
      openPixelUrl: "https://crm.movira.test/m/open/msg_1.gif",
    },
  });

  assert.match(html, /https:\/\/crm\.movira\.test\/m\/click\/msg_1\?u=https%3A%2F%2Fexample\.test%2Fa/);
  assert.match(html, /https:\/\/crm\.movira\.test\/m\/open\/msg_1\.gif/);
});
