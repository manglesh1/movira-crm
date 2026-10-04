const BLOCK_CATALOG = [
  {
    type: "text",
    label: "Text",
    category: "content",
    defaults: {
      content: "Write your text here",
      settings: { align: "left", fontSize: 16 },
    },
  },
  {
    type: "heading",
    label: "Heading",
    category: "content",
    defaults: {
      content: "Start from scratch",
      settings: { align: "center", fontSize: 32, fontWeight: 700 },
    },
  },
  {
    type: "image",
    label: "Image",
    category: "media",
    defaults: {
      settings: { src: "", alt: "", align: "center" },
    },
  },
  {
    type: "button",
    label: "Button",
    category: "content",
    defaults: {
      content: "Click here",
      settings: { href: "#", align: "center", paddingX: 20, paddingY: 12, radius: 4 },
    },
  },
  {
    type: "divider",
    label: "Divider",
    category: "layout",
    defaults: {
      settings: { height: 1, style: "solid", color: "#E5E7EB" },
    },
  },
  {
    type: "spacer",
    label: "Spacer",
    category: "layout",
    defaults: {
      settings: { height: 24 },
    },
  },
  {
    type: "social",
    label: "Social",
    category: "content",
    defaults: {
      items: [
        { type: "facebook", label: "Facebook", href: "#" },
        { type: "instagram", label: "Instagram", href: "#" },
      ],
      settings: { align: "center" },
    },
  },
  {
    type: "footer",
    label: "Footer",
    category: "compliance",
    defaults: {
      content: "{{business.name}}<br>{{business.address}}<br><a href=\"{{unsubscribeUrl}}\">Unsubscribe</a>",
      settings: { align: "center", fontSize: 12, color: "#6B7280" },
    },
  },
  {
    type: "code",
    label: "Code",
    category: "advanced",
    defaults: {
      content: "",
      settings: { trusted: false },
    },
  },
  {
    type: "logo",
    label: "Logo",
    category: "media",
    defaults: {
      settings: { src: "", alt: "Logo", width: 120, align: "center" },
    },
  },
  {
    type: "video",
    label: "Video",
    category: "media",
    defaults: {
      settings: {
        posterUrl: "",
        videoUrl: "",
        align: "center",
        playButtonColor: "#ffffff",
      },
    },
  },
  {
    type: "shopping_cart",
    label: "Shopping Cart",
    category: "commerce",
    defaults: {
      items: [
        { name: "Sample item", quantity: 1, price: 0, imageUrl: "" },
      ],
      settings: {
        currencySymbol: "₹",
        totalLabel: "Total",
        showImages: true,
      },
    },
  },
  {
    type: "rss_header",
    label: "RSS Header",
    category: "rss",
    defaults: {
      settings: {
        feedUrl: "",
        title: "Latest from our blog",
        subtitle: "Stay updated with our latest posts",
        align: "center",
      },
    },
  },
  {
    type: "rss_items",
    label: "RSS Items",
    category: "rss",
    defaults: {
      items: [
        { title: "Post title", url: "#", excerpt: "Short description…", date: "" },
      ],
      settings: { feedUrl: "", limit: 5, showExcerpt: true, showDate: true },
    },
  },
  {
    type: "faq",
    label: "FAQ",
    category: "content",
    defaults: {
      items: [
        { question: "Frequently asked question?", answer: "Answer goes here." },
      ],
      settings: { align: "left" },
    },
  },
  {
    type: "products",
    label: "Products",
    category: "commerce",
    defaults: {
      items: [
        { name: "Product name", price: "₹0", imageUrl: "", ctaLabel: "Buy now", ctaUrl: "#" },
      ],
      settings: { columns: 2 },
    },
  },
  {
    type: "image_slider",
    label: "Image Slider",
    category: "media",
    defaults: {
      items: [{ src: "", alt: "", caption: "" }],
      settings: { align: "center" },
    },
  },
  {
    type: "preview_url",
    label: "Preview URL",
    category: "content",
    defaults: {
      settings: {
        url: "",
        title: "Page title",
        description: "Short description of the linked page.",
        imageUrl: "",
      },
    },
  },
  {
    type: "countdown",
    label: "Countdown",
    category: "content",
    defaults: {
      settings: {
        endsAt: "",
        label: "Sale ends in",
        align: "center",
        accentColor: "var(--aero-orange-600, #5A31DA)",
      },
    },
  },
  {
    type: "review_link",
    label: "Review Link",
    category: "content",
    defaults: {
      content: "Leave a review",
      settings: {
        href: "#",
        stars: 5,
        align: "center",
        color: "var(--aero-orange-600, #5A31DA)",
      },
    },
  },
];

const LAYOUT_CATALOG = [
  { type: "1", label: "1 column", columns: ["100%"] },
  { type: "2", label: "2 columns", columns: ["50%", "50%"] },
  { type: "3", label: "3 columns", columns: ["33.33%", "33.33%", "33.33%"] },
  { type: "1-3:2-3", label: "1/3 : 2/3", columns: ["33.33%", "66.67%"] },
  { type: "2-3:1-3", label: "2/3 : 1/3", columns: ["66.67%", "33.33%"] },
  { type: "1-4:3-4", label: "1/4 : 3/4", columns: ["25%", "75%"] },
  { type: "3-4:1-4", label: "3/4 : 1/4", columns: ["75%", "25%"] },
  { type: "4", label: "4 columns", columns: ["25%", "25%", "25%", "25%"] },
];

function getBuilderCatalog() {
  return {
    schemaVersion: 1,
    blocks: BLOCK_CATALOG,
    layouts: LAYOUT_CATALOG,
  };
}

module.exports = {
  BLOCK_CATALOG,
  LAYOUT_CATALOG,
  getBuilderCatalog,
};
