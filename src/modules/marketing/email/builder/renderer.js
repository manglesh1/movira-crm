const { createDefaultDesign } = require("./defaultDesign");

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function getByPath(obj, path) {
  return String(path)
    .split(".")
    .reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

function interpolate(input, data = {}) {
  if (input == null) return "";
  return String(input).replace(TOKEN_RE, (_match, key) => {
    const value = getByPath(data, key);
    return value == null ? "" : String(value);
  });
}

function px(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

function normalizePadding(padding = {}, fallback = {}) {
  return {
    top: px(padding.top, fallback.top || 0),
    right: px(padding.right, fallback.right || 0),
    bottom: px(padding.bottom, fallback.bottom || 0),
    left: px(padding.left, fallback.left || 0),
  };
}

function styleObj(styles) {
  return Object.entries(styles)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
}

function cssClass(prefix, id) {
  return `${prefix}_${String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function mobileSettings(settings = {}) {
  return settings && typeof settings.mobile === "object" ? settings.mobile : null;
}

function mobilePaddingRule(selector, padding) {
  if (!padding) return "";
  const p = normalizePadding(padding);
  return `${selector}{padding:${p.top}px ${p.right}px ${p.bottom}px ${p.left}px !important;}`;
}

function columnWidths(columns = []) {
  const count = Math.max(1, columns.length);
  return columns.map((column) => {
    if (column.width) return String(column.width);
    return `${Math.floor(100 / count)}%`;
  });
}

function safeUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (/^(https?:|mailto:|tel:|#)/i.test(url)) return url;
  return "";
}

function renderRichContent(content, data) {
  // Builder-owned rich text can contain basic markup. Interpolate first, then
  // strip script-capable tags/handlers without pretending this is a full HTML sanitizer.
  return interpolate(content, data)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, "");
}

function safeCustomCss(css) {
  return String(css || "")
    .replace(/<\/?style[^>]*>/gi, "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/@import[^;]+;/gi, "");
}

function renderTextBlock(block, settings, data, tag = "div") {
  const s = block.settings || {};
  const klass = cssClass("mblk", block.id);
  // Canvas defaults: 8px top/bottom — keep parity so saved padding doesn't
  // jump between authoring view and rendered preview.
  const padding = normalizePadding(s.padding, { top: 8, right: 0, bottom: 8, left: 0 });
  // Heading defaults match the catalog's heading entry (fontSize 32, weight 700).
  // Text defaults inherit from template settings.
  const isHeading = tag === "h1";
  const defaultMarginTop = isHeading ? 0 : px(settings.paragraphTopSpacing, 0);
  const defaultMarginBottom = isHeading ? 0 : px(settings.paragraphBottomSpacing, 0);
  const textStyle = styleObj({
    "font-family": s.fontFamily || settings.fontFamily,
    "font-size": `${px(s.fontSize, isHeading ? settings.headingFontSize || 32 : settings.fontSize || 16)}px`,
    "font-weight": s.fontWeight || (isHeading ? 700 : 400),
    "line-height": s.lineHeight || (isHeading ? "1.2" : "1.5"),
    "letter-spacing": s.letterSpacing || undefined,
    color: s.color || (isHeading ? settings.headingColor || settings.textColor : settings.textColor),
    "text-align": s.align || "left",
    margin: `${defaultMarginTop}px 0 ${defaultMarginBottom}px`,
  });
  // The td inherits the block's borderRadius so a heading/text block can
  // have a contained, rounded background if the user chose one.
  const tdStyle = styleObj({
    padding: `${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px`,
    "border-radius": s.borderRadius ? `${px(s.borderRadius, 0)}px` : undefined,
    background: s.blockBackgroundColor || s.backgroundColor || undefined,
    border: s.borderWidth ? `${px(s.borderWidth, 0)}px ${s.borderStyle || "solid"} ${s.borderColor || "#111827"}` : undefined,
  });
  return `
    <tr>
      <td class="${klass}" style="${tdStyle}">
        <${tag} class="mtext" style="${textStyle}">${renderRichContent(block.content || "", data)}</${tag}>
      </td>
    </tr>`;
}

function renderButtonBlock(block, settings, data) {
  const s = block.settings || {};
  const klass = cssClass("mblk", block.id);
  const padding = normalizePadding(s.padding, { top: 12, right: 0, bottom: 12, left: 0 });
  const href = escapeAttr(safeUrl(interpolate(s.href || s.url || "#", data)) || "#");
  const label = escapeHtml(interpolate(block.content || s.label || "Button", data));
  const align = s.align || "center";
  const radius = px(s.radius, 6);
  return `
    <tr>
      <td class="${klass}" align="${escapeAttr(align)}" style="padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px;">
        <a class="mbutton" href="${href}" style="${styleObj({
          background: s.backgroundColor || settings.buttonColor,
          color: s.color || "#ffffff",
          display: s.fullWidth ? "block" : "inline-block",
          width: s.fullWidth ? "100%" : undefined,
          "box-sizing": s.fullWidth ? "border-box" : undefined,
          "text-align": s.fullWidth ? align : undefined,
          "font-family": s.fontFamily || settings.fontFamily,
          "font-size": `${px(s.fontSize, 16)}px`,
          "font-weight": s.fontWeight || 700,
          "letter-spacing": s.letterSpacing || undefined,
          "line-height": "1",
          padding: `${px(s.paddingY, 12)}px ${px(s.paddingX, 20)}px`,
          "border-radius": `${radius}px`,
          "text-decoration": "none",
        })}">${label}</a>
      </td>
    </tr>`;
}

function renderImageBlock(block, settings, data) {
  const s = block.settings || {};
  const klass = cssClass("mblk", block.id);
  const src = escapeAttr(safeUrl(interpolate(s.src || block.src, data)));
  if (!src) return "";
  const padding = normalizePadding(s.padding, { top: 10, right: 0, bottom: 10, left: 0 });
  // fullWidth wins over an explicit pixel width — it makes the image
  // span the column. Otherwise fall back to the explicit width attr.
  const widthAttr = s.fullWidth ? `width="100%"` : s.width ? `width="${px(s.width, 600)}"` : "";
  const imgStyle = styleObj({
    display: "block",
    "max-width": "100%",
    height: "auto",
    width: s.fullWidth ? "100%" : undefined,
    border: "0",
    outline: "none",
    "text-decoration": "none",
    "border-radius": s.borderRadius ? `${px(s.borderRadius, 0)}px` : undefined,
    margin: s.align === "center" ? "0 auto" : s.align === "right" ? "0 0 0 auto" : undefined,
  });
  const altText = escapeAttr(interpolate(s.alt || "", data));
  const innerImg = `<img class="mimage" src="${src}" ${widthAttr} alt="${altText}" style="${imgStyle}" />`;
  // If the user supplied a click URL, wrap the image in a link.
  const href = safeUrl(interpolate(s.href || "", data));
  const wrapped = href ? `<a href="${escapeAttr(href)}" style="text-decoration:none;border:0;">${innerImg}</a>` : innerImg;
  return `
    <tr>
      <td class="${klass}" align="${escapeAttr(s.align || "center")}" style="padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px;">
        ${wrapped}
      </td>
    </tr>`;
}

function renderDividerBlock(block, settings) {
  const s = block.settings || {};
  const klass = cssClass("mblk", block.id);
  const padding = normalizePadding(s.padding, { top: 12, right: 0, bottom: 12, left: 0 });
  const widthPct = Math.max(10, Math.min(100, px(s.width, 100)));
  const align = s.align || "left";
  // Outer wrapper handles alignment for partial-width dividers; the
  // inner cell carries the actual border-top rule.
  const outerAlign = `align="${escapeAttr(align)}"`;
  return `
    <tr>
      <td class="${klass}" style="padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px;">
        <table role="presentation" width="${widthPct}%" ${outerAlign} cellspacing="0" cellpadding="0" border="0" style="width:${widthPct}%;${align === "center" ? "margin:0 auto;" : align === "right" ? "margin-left:auto;" : ""}">
          <tr><td style="border-top:${px(s.height, 1)}px ${escapeAttr(s.style || "solid")} ${escapeAttr(s.color || settings.dividerColor)};font-size:1px;line-height:1px;">&nbsp;</td></tr>
        </table>
      </td>
    </tr>`;
}

function renderSpacerBlock(block) {
  const height = px(block.settings?.height, 24);
  const klass = cssClass("mblk", block.id);
  return `<tr><td class="${klass}" height="${height}" style="height:${height}px;line-height:${height}px;font-size:1px;">&nbsp;</td></tr>`;
}

function renderSocialBlock(block, settings, data) {
  const items = Array.isArray(block.items) ? block.items : [];
  if (!items.length) return "";
  const s = block.settings || {};
  const klass = cssClass("mblk", block.id);
  const padding = normalizePadding(s.padding, { top: 10, right: 0, bottom: 10, left: 0 });
  const display = s.display || "icon";
  const shape = s.iconShape || "circle";
  const iconSize = px(s.iconSize, 36);
  const radius = shape === "square" ? 4 : shape === "rounded" ? 8 : 999;
  const cells = items
    .map((item) => {
      const href = escapeAttr(safeUrl(interpolate(item.href || item.url || "#", data)) || "#");
      const label = escapeHtml(item.label || item.type || "Social");
      const glyph = escapeHtml(item.glyph || label.slice(0, 2));
      const color = escapeAttr(item.color || settings.linkColor || "#7220E6");
      const content = display === "label" ? label : display === "icon-label" ? `${glyph} ${label}` : glyph;
      const linkStyle = display === "label"
        ? styleObj({
            "font-family": settings.fontFamily,
            "font-size": "13px",
            color,
            "font-weight": 600,
            "text-decoration": "none",
          })
        : styleObj({
            display: "inline-block",
            "min-width": `${iconSize}px`,
            height: `${iconSize}px`,
            "line-height": `${iconSize}px`,
            padding: display === "icon-label" ? `0 ${Math.round(iconSize / 3)}px` : undefined,
            "border-radius": `${radius}px`,
            background: color,
            color: "#ffffff",
            "font-family": settings.fontFamily,
            "font-size": `${Math.max(11, Math.round(iconSize * 0.42))}px`,
            "font-weight": 800,
            "text-align": "center",
            "text-decoration": "none",
          });
      return `<td style="padding:0 ${px(s.gap, 5)}px;"><a href="${href}" style="${linkStyle}">${content}</a></td>`;
    })
    .join("");
  return `
    <tr>
      <td class="${klass}" align="${escapeAttr(s.align || "center")}" style="${styleObj({
        padding: `${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px`,
        background: s.blockBackgroundColor || undefined,
        border: s.borderWidth ? `${px(s.borderWidth, 0)}px ${s.borderStyle || "solid"} ${s.borderColor || "#111827"}` : undefined,
        "border-radius": s.borderRadius ? `${px(s.borderRadius, 0)}px` : undefined,
      })}">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>${cells}</tr></table>
      </td>
    </tr>`;
}

function renderBlock(block, settings, data) {
  if (!block || !block.type) return "";
  switch (block.type) {
    case "heading":
      return renderTextBlock(block, settings, data, "h1");
    case "text":
      return renderTextBlock(block, settings, data, "div");
    case "button":
      return renderButtonBlock(block, settings, data);
    case "image":
    case "logo":
      return renderImageBlock(block, settings, data);
    case "divider":
      return renderDividerBlock(block, settings);
    case "spacer":
      return renderSpacerBlock(block);
    case "social":
      return renderSocialBlock(block, settings, data);
    case "footer":
      return renderTextBlock(block, settings, data, "div");
    case "video":
      return renderVideoBlock(block, settings, data);
    case "shopping_cart":
      return renderShoppingCartBlock(block, settings, data);
    case "rss_header":
      return renderRssHeaderBlock(block, settings, data);
    case "rss_items":
      return renderRssItemsBlock(block, settings, data);
    case "faq":
      return renderFaqBlock(block, settings, data);
    case "products":
      return renderProductsBlock(block, settings, data);
    case "image_slider":
      return renderImageSliderBlock(block, settings, data);
    case "preview_url":
      return renderPreviewUrlBlock(block, settings, data);
    case "countdown":
      return renderCountdownBlock(block, settings, data);
    case "review_link":
      return renderReviewLinkBlock(block, settings, data);
    case "code": {
      // Admin-authored content; render as a raw HTML row inside the
      // section table so the layout doesn't break. The script-strip in
      // renderRichContent provides a baseline guard.
      const html = renderRichContent(block.content || "", data);
      if (!html.trim()) return "";
      const klass = cssClass("mblk", block.id);
      const padding = normalizePadding(block.settings?.padding, { top: 0, right: 0, bottom: 0, left: 0 });
      return `<tr><td class="${klass}" style="padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px;">${html}</td></tr>`;
    }
    default:
      return "";
  }
}

// ── Video ─────────────────────────────────────────────────────────
// Real video can't play in email clients, so we render the poster
// image with a centred play badge and link the whole thing to the
// hosted video URL.
function renderVideoBlock(block, settings, data) {
  const s = block.settings || {};
  const klass = cssClass("mblk", block.id);
  const posterUrl = escapeAttr(safeUrl(interpolate(s.posterUrl || "", data)));
  const videoUrl = safeUrl(interpolate(s.videoUrl || "", data));
  const padding = normalizePadding(s.padding, { top: 10, right: 0, bottom: 10, left: 0 });
  const playColor = s.playButtonColor || "#ffffff";
  const linkOpen = videoUrl ? `<a href="${escapeAttr(videoUrl)}" style="text-decoration:none;border:0;display:inline-block;position:relative;">` : "";
  const linkClose = videoUrl ? `</a>` : "";
  const poster = posterUrl
    ? `<img class="mimage" src="${posterUrl}" alt="${escapeAttr(s.alt || "Video")}" style="display:block;max-width:100%;height:auto;border:0;border-radius:${px(s.borderRadius, 6)}px;" />`
    : `<div style="width:100%;height:200px;background:#0f172a;display:grid;place-items:center;color:#fff;font-size:12px;border-radius:${px(s.borderRadius, 6)}px;">Video poster</div>`;
  // Play badge — separate <span> overlay using percent-based positioning.
  const badge = `<span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:56px;height:56px;border-radius:999px;background:rgba(15,23,42,0.65);display:inline-block;line-height:56px;text-align:center;color:${escapeAttr(playColor)};font-size:22px;">▶</span>`;
  return `
    <tr>
      <td class="${klass}" align="${escapeAttr(s.align || "center")}" style="padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px;">
        ${linkOpen}${poster}${videoUrl ? badge : ""}${linkClose}
      </td>
    </tr>`;
}

// ── Shopping Cart ─────────────────────────────────────────────────
function renderShoppingCartBlock(block, settings, data) {
  const s = block.settings || {};
  const klass = cssClass("mblk", block.id);
  const padding = normalizePadding(s.padding, { top: 12, right: 0, bottom: 12, left: 0 });
  const items = Array.isArray(block.items) ? block.items : [];
  const symbol = s.currencySymbol || "₹";
  const subtotal = items.reduce((sum, item) => {
    const qty = Number(item.quantity || 1);
    const price = Number(String(item.price || 0).replace(/[^0-9.-]/g, "")) || 0;
    return sum + qty * price;
  }, 0);
  const rows = items
    .map((item) => {
      const name = escapeHtml(interpolate(item.name || "", data));
      const qty = escapeHtml(String(item.quantity || 1));
      const priceStr = `${symbol}${Number(String(item.price || 0).replace(/[^0-9.-]/g, "")) || 0}`;
      const img = item.imageUrl && s.showImages !== false
        ? `<td width="48" style="padding-right:10px;"><img src="${escapeAttr(safeUrl(item.imageUrl))}" width="48" alt="" style="display:block;width:48px;height:48px;border-radius:6px;object-fit:cover;" /></td>`
        : "";
      return `
        <tr>
          ${img}
          <td style="padding:8px 0;font-family:${escapeAttr(settings.fontFamily)};color:${escapeAttr(settings.textColor)};">
            <div style="font-weight:600;">${name}</div>
            <div style="font-size:12px;color:#64748b;">Qty: ${qty}</div>
          </td>
          <td align="right" style="padding:8px 0;font-family:${escapeAttr(settings.fontFamily)};font-weight:600;color:${escapeAttr(settings.textColor)};">${escapeHtml(priceStr)}</td>
        </tr>`;
    })
    .join("");
  const totalLabel = escapeHtml(s.totalLabel || "Total");
  return `
    <tr>
      <td class="${klass}" style="padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          ${rows}
          <tr><td colspan="3" style="border-top:1px solid #e2e8f0;height:1px;line-height:1px;font-size:1px;">&nbsp;</td></tr>
          <tr>
            <td colspan="2" style="padding:10px 0;font-family:${escapeAttr(settings.fontFamily)};font-weight:700;color:${escapeAttr(settings.textColor)};">${totalLabel}</td>
            <td align="right" style="padding:10px 0;font-family:${escapeAttr(settings.fontFamily)};font-weight:700;color:${escapeAttr(settings.textColor)};">${escapeHtml(`${symbol}${subtotal.toFixed(2)}`)}</td>
          </tr>
        </table>
      </td>
    </tr>`;
}

// ── RSS Header ─────────────────────────────────────────────────────
function renderRssHeaderBlock(block, settings, data) {
  const s = block.settings || {};
  const klass = cssClass("mblk", block.id);
  const padding = normalizePadding(s.padding, { top: 12, right: 0, bottom: 4, left: 0 });
  const title = escapeHtml(interpolate(s.title || "Latest posts", data));
  const subtitle = escapeHtml(interpolate(s.subtitle || "", data));
  return `
    <tr>
      <td class="${klass}" align="${escapeAttr(s.align || "center")}" style="padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px;font-family:${escapeAttr(settings.fontFamily)};">
        <div style="font-size:22px;font-weight:700;color:${escapeAttr(settings.textColor)};">${title}</div>
        ${subtitle ? `<div style="font-size:13px;color:#64748b;margin-top:4px;">${subtitle}</div>` : ""}
      </td>
    </tr>`;
}

// ── RSS Items ─────────────────────────────────────────────────────
// Render items the editor already saved. Server-side feed-fetching
// belongs in a worker that updates `block.items` before the campaign
// is sent — kept out of the render path so render stays deterministic.
function renderRssItemsBlock(block, settings, data) {
  const s = block.settings || {};
  const klass = cssClass("mblk", block.id);
  const padding = normalizePadding(s.padding, { top: 8, right: 0, bottom: 8, left: 0 });
  const items = Array.isArray(block.items) ? block.items.slice(0, Number(s.limit) || 5) : [];
  const rows = items
    .map((item) => {
      const title = escapeHtml(interpolate(item.title || "", data));
      const url = escapeAttr(safeUrl(interpolate(item.url || "#", data)) || "#");
      const excerpt = s.showExcerpt !== false ? escapeHtml(interpolate(item.excerpt || "", data)) : "";
      const date = s.showDate !== false ? escapeHtml(item.date || "") : "";
      return `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;font-family:${escapeAttr(settings.fontFamily)};">
            <a href="${url}" style="font-size:15px;font-weight:600;color:${escapeAttr(settings.linkColor)};text-decoration:none;">${title}</a>
            ${date ? `<div style="font-size:11px;color:#94a3b8;margin-top:2px;">${date}</div>` : ""}
            ${excerpt ? `<div style="font-size:13px;color:${escapeAttr(settings.textColor)};margin-top:6px;line-height:1.5;">${excerpt}</div>` : ""}
          </td>
        </tr>`;
    })
    .join("");
  return `
    <tr>
      <td class="${klass}" style="padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>
      </td>
    </tr>`;
}

// ── FAQ ───────────────────────────────────────────────────────────
function renderFaqBlock(block, settings, data) {
  const s = block.settings || {};
  const klass = cssClass("mblk", block.id);
  const padding = normalizePadding(s.padding, { top: 8, right: 0, bottom: 8, left: 0 });
  const items = Array.isArray(block.items) ? block.items : [];
  const rows = items
    .map((item) => {
      const q = escapeHtml(interpolate(item.question || "", data));
      const a = renderRichContent(item.answer || "", data);
      return `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;font-family:${escapeAttr(settings.fontFamily)};">
            <div style="font-size:14px;font-weight:700;color:${escapeAttr(settings.textColor)};">${q}</div>
            <div style="font-size:13px;color:${escapeAttr(settings.textColor)};margin-top:6px;line-height:1.55;">${a}</div>
          </td>
        </tr>`;
    })
    .join("");
  return `
    <tr>
      <td class="${klass}" align="${escapeAttr(s.align || "left")}" style="padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>
      </td>
    </tr>`;
}

// ── Products ──────────────────────────────────────────────────────
function renderProductsBlock(block, settings, data) {
  const s = block.settings || {};
  const klass = cssClass("mblk", block.id);
  const padding = normalizePadding(s.padding, { top: 12, right: 0, bottom: 12, left: 0 });
  const items = Array.isArray(block.items) ? block.items : [];
  const cols = Math.max(1, Math.min(4, Number(s.columns) || 2));
  const cellWidth = `${Math.floor(100 / cols)}%`;
  // Group items into rows of `cols`.
  const groups = [];
  for (let i = 0; i < items.length; i += cols) groups.push(items.slice(i, i + cols));
  const rowsHtml = groups
    .map((group) => {
      const cellsHtml = group
        .map((item) => {
          const name = escapeHtml(interpolate(item.name || "", data));
          const price = escapeHtml(interpolate(item.price || "", data));
          const ctaLabel = escapeHtml(item.ctaLabel || "Buy now");
          const ctaUrl = escapeAttr(safeUrl(interpolate(item.ctaUrl || "#", data)) || "#");
          const img = item.imageUrl
            ? `<img src="${escapeAttr(safeUrl(item.imageUrl))}" alt="" style="display:block;width:100%;height:auto;border-radius:8px;" />`
            : `<div style="width:100%;padding-top:60%;background:#f1f5f9;border-radius:8px;"></div>`;
          return `
            <td class="mcol mcol-stack" valign="top" width="${cellWidth}" style="width:${cellWidth};padding:8px;">
              ${img}
              <div style="font-family:${escapeAttr(settings.fontFamily)};font-weight:600;font-size:14px;color:${escapeAttr(settings.textColor)};margin-top:8px;">${name}</div>
              <div style="font-family:${escapeAttr(settings.fontFamily)};font-weight:700;font-size:13px;color:${escapeAttr(settings.textColor)};margin-top:2px;">${price}</div>
              <a href="${ctaUrl}" style="display:inline-block;margin-top:8px;padding:8px 14px;background:${escapeAttr(settings.buttonColor)};color:#ffffff;font-size:12px;font-weight:700;text-decoration:none;border-radius:6px;font-family:${escapeAttr(settings.fontFamily)};">${ctaLabel}</a>
            </td>`;
        })
        .join("");
      return `<tr>${cellsHtml}</tr>`;
    })
    .join("");
  return `
    <tr>
      <td class="${klass}" style="padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rowsHtml}</table>
      </td>
    </tr>`;
}

// ── Image Slider ──────────────────────────────────────────────────
// Email clients don't support real carousels, so we render the first
// image as the hero with caption + a row of small thumbnails below.
function renderImageSliderBlock(block, settings, data) {
  const s = block.settings || {};
  const klass = cssClass("mblk", block.id);
  const padding = normalizePadding(s.padding, { top: 10, right: 0, bottom: 10, left: 0 });
  const items = Array.isArray(block.items) ? block.items.filter((i) => i.src) : [];
  if (!items.length) return "";
  const hero = items[0];
  const heroSrc = escapeAttr(safeUrl(hero.src || ""));
  const heroCaption = escapeHtml(interpolate(hero.caption || "", data));
  const thumbs = items
    .slice(1)
    .map((item) => `<td style="padding:0 4px;"><img src="${escapeAttr(safeUrl(item.src || ""))}" width="64" alt="${escapeAttr(item.alt || "")}" style="display:block;width:64px;height:64px;object-fit:cover;border-radius:6px;" /></td>`)
    .join("");
  return `
    <tr>
      <td class="${klass}" align="${escapeAttr(s.align || "center")}" style="padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px;">
        <img class="mimage" src="${heroSrc}" alt="${escapeAttr(hero.alt || "")}" style="display:block;max-width:100%;height:auto;border-radius:8px;width:100%;" />
        ${heroCaption ? `<div style="font-family:${escapeAttr(settings.fontFamily)};font-size:13px;color:${escapeAttr(settings.textColor)};margin-top:8px;">${heroCaption}</div>` : ""}
        ${thumbs ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin-top:10px;"><tr>${thumbs}</tr></table>` : ""}
      </td>
    </tr>`;
}

// ── Preview URL ───────────────────────────────────────────────────
// Card-style link preview (favicon-less for email-safety): image,
// title, description. Author manually populates fields; future work
// could OG-scrape on save.
function renderPreviewUrlBlock(block, settings, data) {
  const s = block.settings || {};
  const klass = cssClass("mblk", block.id);
  const padding = normalizePadding(s.padding, { top: 10, right: 0, bottom: 10, left: 0 });
  const url = safeUrl(interpolate(s.url || "#", data)) || "#";
  const img = s.imageUrl
    ? `<td width="120" valign="top" style="padding-right:14px;"><img src="${escapeAttr(safeUrl(s.imageUrl))}" alt="" width="120" style="display:block;width:120px;height:auto;border-radius:8px;" /></td>`
    : "";
  return `
    <tr>
      <td class="${klass}" style="padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px;">
        <a href="${escapeAttr(url)}" style="text-decoration:none;color:inherit;border:0;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#ffffff;">
            <tr>
              ${img}
              <td valign="top" style="padding:14px;font-family:${escapeAttr(settings.fontFamily)};">
                <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;">${escapeHtml(url)}</div>
                <div style="font-size:14px;font-weight:700;color:${escapeAttr(settings.textColor)};margin-top:4px;">${escapeHtml(interpolate(s.title || "", data))}</div>
                <div style="font-size:12.5px;color:#64748b;margin-top:6px;line-height:1.5;">${escapeHtml(interpolate(s.description || "", data))}</div>
              </td>
            </tr>
          </table>
        </a>
      </td>
    </tr>`;
}

// ── Countdown ─────────────────────────────────────────────────────
// Text-only countdown — at render time we compute days/hours from
// `endsAt`. For live tickers customers should switch to a GIF service
// later (motionmail / sendtric); this gets the layout right today.
function renderCountdownBlock(block, settings, data) {
  const s = block.settings || {};
  const klass = cssClass("mblk", block.id);
  const padding = normalizePadding(s.padding, { top: 14, right: 0, bottom: 14, left: 0 });
  const endsAt = s.endsAt ? new Date(s.endsAt) : null;
  let parts = { days: 0, hours: 0, minutes: 0 };
  if (endsAt && !Number.isNaN(endsAt.getTime())) {
    const diffMs = Math.max(0, endsAt.getTime() - Date.now());
    parts.days = Math.floor(diffMs / 86400000);
    parts.hours = Math.floor((diffMs % 86400000) / 3600000);
    parts.minutes = Math.floor((diffMs % 3600000) / 60000);
  }
  const accent = s.accentColor || settings.buttonColor || "#7220E6";
  const label = escapeHtml(interpolate(s.label || "Sale ends in", data));
  const cell = (value, suffix) => `
    <td align="center" style="padding:0 8px;">
      <div style="font-family:${escapeAttr(settings.fontFamily)};font-size:32px;font-weight:800;color:${escapeAttr(accent)};line-height:1;">${value}</div>
      <div style="font-family:${escapeAttr(settings.fontFamily)};font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;margin-top:4px;">${suffix}</div>
    </td>`;
  return `
    <tr>
      <td class="${klass}" align="${escapeAttr(s.align || "center")}" style="padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px;">
        <div style="font-family:${escapeAttr(settings.fontFamily)};font-size:13px;color:${escapeAttr(settings.textColor)};margin-bottom:8px;">${label}</div>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${escapeAttr(s.align || "center")}">
          <tr>${cell(parts.days, "Days")}${cell(parts.hours, "Hours")}${cell(parts.minutes, "Minutes")}</tr>
        </table>
      </td>
    </tr>`;
}

// ── Review Link ───────────────────────────────────────────────────
function renderReviewLinkBlock(block, settings, data) {
  const s = block.settings || {};
  const klass = cssClass("mblk", block.id);
  const padding = normalizePadding(s.padding, { top: 12, right: 0, bottom: 12, left: 0 });
  const href = escapeAttr(safeUrl(interpolate(s.href || "#", data)) || "#");
  const total = Math.max(1, Math.min(5, Number(s.stars) || 5));
  const accent = s.color || settings.buttonColor || "#7220E6";
  const stars = Array.from({ length: 5 })
    .map((_v, i) => `<span style="color:${escapeAttr(i < total ? accent : "#e2e8f0")};font-size:22px;line-height:1;margin:0 1px;">★</span>`)
    .join("");
  const label = escapeHtml(interpolate(block.content || "Leave a review", data));
  return `
    <tr>
      <td class="${klass}" align="${escapeAttr(s.align || "center")}" style="padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px;font-family:${escapeAttr(settings.fontFamily)};">
        <a href="${href}" style="text-decoration:none;color:${escapeAttr(accent)};display:inline-block;">
          <div>${stars}</div>
          <div style="margin-top:6px;font-size:13px;font-weight:600;">${label}</div>
        </a>
      </td>
    </tr>`;
}

function renderColumn(column, width, settings, data, options = {}) {
  const blocks = Array.isArray(column.blocks) ? column.blocks : [];
  // `mcol` is targeted by mobile CSS; `mcol-stack` only when the parent
  // section opts into mobile stacking (default true). Mailers honour the
  // media query and collapse the row into a stack of full-width blocks.
  const stackClass = options.stack ? "mcol mcol-stack" : "mcol";
  const klass = `${stackClass} ${cssClass("mcol", column.id)}`.trim();
  return `
    <td class="${klass}" width="${escapeAttr(width)}" valign="top" style="width:${escapeAttr(width)};">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        ${blocks.map((block) => renderBlock(block, settings, data)).join("")}
      </table>
    </td>`;
}

function renderSection(section, settings, data) {
  const s = section.settings || {};
  const klass = cssClass("msec", section.id);
  // Carry visibility flags through so buildMobileCss / applyDesktopOnly
  // can emit display:none rules per device. Both flags true ⇒ row never
  // renders at all (cheaper than emitting display:none everywhere).
  if (s.hideOnDesktop && s.hideOnMobile) return "";
  const padding = normalizePadding(s.padding, { top: 0, right: 0, bottom: 0, left: 0 });
  const margin = normalizePadding(s.margin, { top: 0, right: 0, bottom: 0, left: 0 });
  const columns = Array.isArray(section.columns) && section.columns.length
    ? section.columns
    : [{ id: "col_default", width: "100%", blocks: [] }];
  const widths = columnWidths(columns);
  const innerTableStyle = styleObj({
    width: `${px(settings.contentWidth, 600)}px`,
    "max-width": "100%",
    background: s.backgroundType === "full" ? settings.bodyColor : s.backgroundColor || settings.bodyColor,
    "background-image": s.backgroundImageUrl ? `url('${safeUrl(s.backgroundImageUrl)}')` : undefined,
    "background-size": s.backgroundSize || undefined,
    "background-repeat": s.backgroundRepeat || undefined,
    "background-position": s.backgroundPosition || undefined,
    border: s.borderWidth ? `${px(s.borderWidth, 0)}px ${s.borderStyle || "solid"} ${s.borderColor || "#111827"}` : undefined,
    "border-radius": s.borderRadius ? `${px(s.borderRadius, 0)}px` : undefined,
    overflow: s.borderRadius ? "hidden" : undefined,
  });
  // Default to mobile-stacking unless the section explicitly disables it.
  const stack = s.mobileStack !== false;
  return `
    <tr class="${klass}-row">
      <td align="center" style="${styleObj({
        background: s.backgroundType === "full" ? s.backgroundColor || settings.bodyColor : s.outerBackgroundColor || settings.backgroundColor,
        padding: `${margin.top}px ${margin.right}px ${margin.bottom}px ${margin.left}px`,
      })}">
        <table class="mcontent" role="presentation" width="${px(settings.contentWidth, 600)}" cellspacing="0" cellpadding="0" border="0" style="${innerTableStyle}">
          <tr>
            <td class="${klass}" style="padding:${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>${columns.map((column, index) => renderColumn(column, widths[index], settings, data, { stack })).join("")}</tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function renderDesign(designJson, options = {}) {
  const design = designJson && typeof designJson === "object" ? designJson : createDefaultDesign();
  const settings = { ...createDefaultDesign().settings, ...(design.settings || {}) };
  const sections = Array.isArray(design.sections) ? design.sections : [];
  const mobileCss = buildMobileCss(sections);
  const customCss = safeCustomCss(settings.customCss || "");
  const frameWidth = px(settings.contentWidth, 600);
  const frameBorderWidth = Number(settings.containerBorderWidth);
  const hasFrame = Number.isFinite(frameBorderWidth) && frameBorderWidth > 0;
  const renderedSections = sections
    .map((section) => renderSection(section, settings, options.data || {}))
    .join("");
  const framedContent = hasFrame
    ? `
      <tr>
        <td align="center" style="padding:${px(settings.containerMarginTop, 24)}px 12px ${px(settings.containerMarginBottom, 24)}px;">
          <table class="mframe" role="presentation" width="${frameWidth}" cellspacing="0" cellpadding="0" border="0" style="${styleObj({
            width: `${frameWidth}px`,
            "max-width": "100%",
            background: settings.bodyColor,
            border: `${frameBorderWidth}px solid ${settings.containerBorderColor || settings.dividerColor}`,
            "border-radius": `${px(settings.containerBorderRadius, 16)}px`,
            overflow: "hidden",
          })}">
            ${renderedSections}
          </table>
        </td>
      </tr>`
    : renderedSections;
  const html = applyTracking(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(options.title || "Email")}</title>
    ${(mobileCss || customCss) ? `<style>${mobileCss}${customCss}</style>` : ""}
  </head>
  <body style="margin:0;padding:0;background:${escapeAttr(settings.backgroundColor)};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:${escapeAttr(settings.backgroundColor)};">
      ${framedContent}
    </table>
  </body>
</html>`, options.tracking || null);
  return { html, design, settings };
}

function buildMobileCss(sections) {
  // Baseline mobile rules — applied to every design so the rendered
  // email is responsive out of the box. Without these the preview at
  // 390px shows a stuck-at-600px layout.
  const rules = [
    // Shrink the content table to viewport width.
    "table.mcontent{width:100% !important;max-width:100% !important;}",
    "table.mframe{width:100% !important;max-width:100% !important;}",
    // Stack any column whose section opted into mobileStack.
    ".mcol-stack{display:block !important;width:100% !important;max-width:100% !important;box-sizing:border-box !important;}",
    // Images can never bleed outside the column on mobile.
    "img.mimage{max-width:100% !important;height:auto !important;}",
  ];
  // Desktop-only rules (hide on desktop, restore on mobile via media query).
  // We collect these separately and prepend them outside the media query.
  const desktopOnlyRules = [];
  for (const section of sections || []) {
    const sectionMobile = mobileSettings(section.settings);
    const sectionClass = `.${cssClass("msec", section.id)}`;
    const sectionRowSelector = `tr.${cssClass("msec", section.id)}-row`;
    // Visibility flags for the section. (Both flags = section was already
    // dropped at render-time, so we don't end up here.)
    if (section.settings?.hideOnDesktop) {
      desktopOnlyRules.push(`${sectionRowSelector}{display:none !important;}`);
      // Ensure mobile re-enables it.
      rules.push(`${sectionRowSelector}{display:table-row !important;}`);
    }
    if (section.settings?.hideOnMobile) {
      rules.push(`${sectionRowSelector}{display:none !important;}`);
    }
    if (sectionMobile) {
      rules.push(mobilePaddingRule(sectionClass, sectionMobile.padding));
      if (sectionMobile.backgroundColor) rules.push(`${sectionClass}{background:${sectionMobile.backgroundColor} !important;}`);
    }
    for (const column of section.columns || []) {
      for (const block of column.blocks || []) {
        const blockClass = `.${cssClass("mblk", block.id)}`;
        // Block-level visibility flags.
        if (block.settings?.hideOnDesktop) {
          desktopOnlyRules.push(`${blockClass}{display:none !important;}`);
          rules.push(`${blockClass}{display:block !important;}`);
        }
        if (block.settings?.hideOnMobile) {
          rules.push(`${blockClass}{display:none !important;}`);
        }
        const mobile = mobileSettings(block.settings);
        if (!mobile) continue;
        rules.push(mobilePaddingRule(blockClass, mobile.padding));
        if (block.type === "spacer" && mobile.height != null) {
          rules.push(`${blockClass}{height:${px(mobile.height, 24)}px !important;line-height:${px(mobile.height, 24)}px !important;}`);
        }
        const textRules = {};
        if (mobile.fontSize != null) textRules["font-size"] = `${px(mobile.fontSize, 16)}px !important`;
        if (mobile.fontWeight != null) textRules["font-weight"] = `${px(mobile.fontWeight, 400)} !important`;
        if (mobile.lineHeight != null) textRules["line-height"] = `${mobile.lineHeight} !important`;
        if (mobile.color) textRules.color = `${mobile.color} !important`;
        if (mobile.align) textRules["text-align"] = `${mobile.align} !important`;
        const textStyle = styleObj(textRules);
        if (textStyle) rules.push(`${blockClass} .mtext{${textStyle}}`);
        if (block.type === "button") {
          const buttonRules = {};
          if (mobile.fontSize != null) buttonRules["font-size"] = `${px(mobile.fontSize, 16)}px !important`;
          if (mobile.backgroundColor) buttonRules.background = `${mobile.backgroundColor} !important`;
          if (mobile.color) buttonRules.color = `${mobile.color} !important`;
          if (mobile.radius != null) buttonRules["border-radius"] = `${px(mobile.radius, 4)}px !important`;
          if (mobile.paddingX != null || mobile.paddingY != null) {
            const y = px(mobile.paddingY, block.settings?.paddingY ?? 12);
            const x = px(mobile.paddingX, block.settings?.paddingX ?? 20);
            buttonRules.padding = `${y}px ${x}px !important`;
          }
          if (mobile.fullWidth) {
            buttonRules.display = "block !important";
            buttonRules.width = "100% !important";
          }
          const buttonStyle = styleObj(buttonRules);
          if (buttonStyle) rules.push(`${blockClass} .mbutton{${buttonStyle}}`);
        }
        if ((block.type === "image" || block.type === "logo") && mobile.width != null) {
          rules.push(`${blockClass} .mimage{width:${px(mobile.width, 600)}px !important;}`);
        }
        if ((block.type === "image" || block.type === "logo") && mobile.fullWidth) {
          rules.push(`${blockClass} .mimage{width:100% !important;}`);
        }
      }
    }
  }
  const body = rules.filter(Boolean).join("");
  const desktopBody = desktopOnlyRules.filter(Boolean).join("");
  const desktopBlock = desktopBody || "";
  const mobileBlock = body ? `@media only screen and (max-width:480px){${body}}` : "";
  return `${desktopBlock}${mobileBlock}`;
}

function applyTracking(html, tracking) {
  if (!tracking) return html;
  let out = html;
  if (tracking.clickBaseUrl) {
    out = out.replace(/<a\s+([^>]*?)href\s*=\s*(["'])(https?:\/\/[^"']+)\2([^>]*)>/gi, (match, before, _quote, href, after) => {
      const destination = href.replace(/&amp;/gi, "&");
      // Compliance links must remain direct; do not double-wrap tracked URLs.
      if (/\/m\/(unsubscribe|view)\//i.test(destination) || destination.startsWith(tracking.clickBaseUrl)) return match;
      const tracked = `${tracking.clickBaseUrl}?u=${encodeURIComponent(destination)}`;
      return `<a ${before}href="${escapeAttr(tracked)}"${after}>`;
    });
  }
  if (tracking.openPixelUrl) {
    const pixel = `<img src="${escapeAttr(tracking.openPixelUrl)}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;opacity:0;" />`;
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${pixel}</body>`) : `${out}${pixel}`;
  }
  return out;
}

module.exports = {
  renderDesign,
  interpolate,
  escapeHtml,
  applyTracking,
};
