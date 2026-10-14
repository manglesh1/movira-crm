(() => {
  if (window.__moviraWebChatLoaded) return;
  const script = document.currentScript;
  const widgetKey = script?.dataset?.widgetKey;
  if (!widgetKey || !script.isConnected) return;
  window.__moviraWebChatLoaded = true;
  const apiBase = new URL(script.src).pathname.replace(/\/widget\.js$/, `/${encodeURIComponent(widgetKey)}`);
  const apiOrigin = new URL(script.src).origin;
  const api = `${apiOrigin}${apiBase}`;
  const storageKey = `movira:webchat:${widgetKey}`;
  let session = null;
  let config = null;
  let pollTimer = null;
  let lastMessageAt = null;
  let lastMessageId = null;
  let loadingMessages = false;
  let destroyed = false;
  const seen = new Set();

  const root = document.createElement("div");
  root.id = "movira-chat-root";
  const shadow = root.attachShadow({ mode: "open" });
  (document.body || document.documentElement).appendChild(root);
  root.destroy = () => { destroyed = true; clearInterval(pollTimer); root.remove(); window.__moviraWebChatLoaded = false; };

  function htmlEscape(value) {
    const node = document.createElement("span");
    node.textContent = String(value || "");
    return node.innerHTML;
  }

  function visitorField(name, type, label, mode, maxLength) {
    if (mode === "hidden") return "";
    const optional = mode === "optional";
    return `<label class="detail-field"><span>${htmlEscape(label)}${optional ? " <small>Optional</small>" : ""}</span><input name="${name}" type="${type}" maxlength="${maxLength}" autocomplete="${name === "name" ? "name" : name}" placeholder="${htmlEscape(label)}" ${optional ? "" : "required"}/></label>`;
  }

  async function request(path, options = {}) {
    const response = await fetch(`${api}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(session?.sessionToken ? { "X-Session-Token": session.sessionToken } : {}), ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.message || "Chat is unavailable."), { status: response.status, code: payload.error, details: payload.details });
    return payload.data;
  }

  function styles() {
    return `<style>
:host{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#182230;color-scheme:light}
*,*::before,*::after{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:wait;opacity:.55}[hidden]{display:none!important}
button:focus-visible,a:focus-visible{outline:3px solid #93b4ff;outline-offset:3px}
.launcher{position:fixed;z-index:2147483000;bottom:22px;${config.position}:22px;display:flex;min-height:50px;align-items:center;justify-content:center;gap:9px;border:0;border-radius:999px;padding:0 18px;background:${config.accentColor};color:#fff;box-shadow:0 8px 28px #172b4d30;font:650 14px/1.2 system-ui,sans-serif}
.launcher svg{width:21px;height:21px;flex:0 0 auto}.launcher.style-compact{min-height:42px;border-radius:12px;padding:0 13px;font-size:12px}
.launcher.style-bubble,.launcher.style-square{width:52px;padding:0}.launcher.style-bubble{border-radius:50%}.launcher.style-square{border-radius:15px}
.launcher.style-bubble span,.launcher.style-square span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.launcher.style-text{min-height:44px;border-radius:11px}.launcher.style-text svg{display:none}
.launcher.style-outline{border:2px solid ${config.accentColor};background:#fff;color:${config.accentColor}}
.launcher.style-status{display:grid;min-height:58px;grid-template-columns:auto auto;grid-template-rows:auto auto;column-gap:10px;row-gap:1px;border-radius:16px;padding:9px 16px}.launcher.style-status svg{grid-row:1/3}.launcher.style-status::after{content:"Chat with us";grid-column:2;font-size:10px;opacity:.84}
.launcher.style-tab{bottom:120px;${config.position}:0;min-height:96px;border-radius:${config.position === "right" ? "14px 0 0 14px" : "0 14px 14px 0"};padding:13px 10px;writing-mode:vertical-rl;${config.position === "left" ? "transform:rotate(180deg);" : ""}}
.panel{position:fixed;z-index:2147483001;bottom:84px;${config.position}:22px;width:min(400px,calc(100vw - 32px));height:min(650px,calc(100dvh - 110px));overflow:hidden;border:1px solid #e2e8f0;border-radius:22px;background:#fff;box-shadow:0 24px 72px #10182833,0 4px 16px #10182814;font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#182230;display:none;flex-direction:column;isolation:isolate}
.panel.open{display:flex}.head{display:flex;align-items:center;gap:12px;flex-shrink:0;padding:20px 18px;background:${config.accentColor};color:#fff}
.head-icon{display:grid;place-items:center;width:40px;height:40px;flex-shrink:0;border:1px solid #ffffff38;border-radius:13px;background:#ffffff1a}.head-icon svg{width:23px;height:23px}
.head-copy{flex:1;min-width:0}.head strong{display:block;font-size:16px;line-height:1.35;font-weight:700;overflow-wrap:anywhere}.head span{display:block;margin-top:4px;font-size:12px;line-height:1.4;color:#ffffffeb;overflow-wrap:anywhere}
.head button{display:grid;place-items:center;align-self:flex-start;flex-shrink:0;width:34px;height:34px;border:1px solid #ffffff45;border-radius:10px;background:#ffffff14;color:#fff}.head button:hover{background:#ffffff2b}.head button svg{width:18px;height:18px}
.handling{display:flex;align-items:center;gap:8px;flex-shrink:0;padding:10px 18px;border-bottom:1px solid #e9edf3;background:#fff;font-size:11px;line-height:1.5;color:#526073}.handling::before{content:"";width:6px;height:6px;flex-shrink:0;border-radius:50%;background:#15966b}.handling[data-mode="waiting"]::before{background:#d39326}
.messages{flex:1;min-height:80px;overflow:auto;overscroll-behavior:contain;padding:20px 16px 8px;background:#f5f7fb;scrollbar-width:thin;scrollbar-color:#c6cfdd transparent}.messages:empty::before{content:"Ask a question about your visit.";display:block;margin:28px 12px;text-align:center;color:#64748b;font-size:13px}
.msg{width:fit-content;max-width:94%;margin:0 0 18px;padding:15px 16px 11px;border:1px solid #e5eaf1;border-radius:4px 17px 17px 17px;background:#fff;box-shadow:0 2px 4px #172b4d04;overflow-wrap:anywhere}.msg.inbound{max-width:86%;margin-left:auto;border:0;border-radius:17px 4px 17px 17px;background:${config.accentColor};color:#fff;padding:12px 14px 9px}.msg.system{background:#eef2f6;color:#526073;box-shadow:none}
.message-body{font-size:13px;line-height:1.65}.message-body p{margin:0 0 10px;white-space:pre-wrap}.message-body p:last-child{margin-bottom:0}.message-body .response-title{font-weight:700;font-size:14px;line-height:1.5;color:#172338}.message-body ul,.message-body ol{padding-left:19px;margin:8px 0 12px}.message-body li{padding-left:2px;margin:5px 0}.message-body strong{font-weight:700}
.msg small{display:block;margin-top:10px;font-size:10px;line-height:1.4;color:#758196}.msg.inbound small{color:#ffffffe0;margin-top:6px}
.choices{display:grid;gap:8px;margin-top:14px}.choice{display:flex;align-items:center;justify-content:space-between;gap:14px;width:100%;min-height:44px;border:1px solid #dce4f0;border-radius:10px;padding:10px 12px;background:#f8faff;color:#2459b5;text-align:left;text-decoration:none;font-size:12px;line-height:1.45;font-weight:600;transition:background .15s,border-color .15s}.choice::after{content:"→";font-size:17px;line-height:1;flex-shrink:0}.choice:hover{background:#edf3ff;border-color:#afc7ec}.choice:active{background:#e3edff}
.actions{display:flex;flex-wrap:wrap;gap:8px;flex-shrink:0;padding:12px 16px;border-top:1px solid #e9edf3;background:#fff}.actions button{min-height:36px;border:1px solid #e0e6ee;border-radius:9px;padding:7px 10px;background:#fff;color:#475569;font-size:11px;font-weight:600}.actions button:hover{background:#f5f7fb;color:#1e293b}
.form{display:flex;align-items:center;gap:8px;padding:12px 14px 16px;border-top:1px solid #eef1f6;background:#fff;flex-shrink:0}.form input{min-width:0;flex:1;height:46px;padding:0 13px;border:1px solid #dce3ed;border-radius:13px;background:#f8fafc;color:#172338;font-size:13px}.form input::placeholder{color:#7b8798}.form button{height:46px;min-width:54px;border:0;border-radius:13px;background:${config.accentColor};color:#fff;font-size:12px;font-weight:700}
input:focus,select:focus,textarea:focus{outline:2px solid ${config.accentColor};outline-offset:1px}.error:empty{display:none}.error{padding:10px 16px;background:#fff5f4;color:#b42318;font-size:12px;line-height:1.5;flex-shrink:0}
.details{display:grid;gap:15px;padding:20px;overflow:auto;min-height:0;background:#fff}.details>p{margin:0;color:#66758a;font-size:12px;line-height:1.6}.detail-field{display:grid;gap:6px}.detail-field span{color:#344054;font-size:12px;font-weight:650}.detail-field small{color:#748196;font-size:11px;font-weight:400}
.details input,.details select,.details textarea{min-width:0;width:100%;min-height:43px;border:1px solid #d9e1ec;border-radius:10px;padding:10px 12px;background:#fff;color:#182230;font-size:13px}.details textarea{min-height:85px;resize:vertical}.details [aria-invalid="true"]{border-color:#d92d20;background:#fff9f8}.details button{min-height:44px;border:0;border-radius:10px;padding:10px 15px;background:${config.accentColor};color:#fff;font-size:13px;font-weight:650}.details button[type="button"]{background:#f1f4f8;color:#475569}
.lead{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;background:#fff}.lead h2{font-size:18px;line-height:1.4;margin:0 0 5px;font-weight:700}.lead .details{overflow:visible}.lead-success{padding:28px 22px;display:grid;gap:14px}.lead-success p{margin:0;color:#526073;font-size:13px}.lead-success button{min-height:44px;border:1px solid #dce3ed;border-radius:10px;background:#f8fafc;color:#344054;font-weight:600}.bot-trap{position:absolute;left:-10000px;opacity:0;height:1px;overflow:hidden}
@media(max-width:480px){.panel{bottom:0;left:0;right:0;width:100%;height:100dvh;max-height:none;border:0;border-radius:0}.head{padding-top:max(18px,env(safe-area-inset-top));padding-bottom:18px}.form{padding-bottom:max(16px,env(safe-area-inset-bottom))}.launcher{bottom:15px;${config.position}:15px}.details input,.details select,.details textarea,.form input{font-size:16px}.choice{min-height:46px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
    </style>`;
  }

  function render() {
    const wasOpen = shadow.querySelector(".panel")?.classList.contains("open") || script.dataset.open === "true";
    seen.clear(); lastMessageAt = null; lastMessageId = null;
    shadow.innerHTML = `${styles()}<button class="launcher style-${htmlEscape(config.launcherStyle)}" aria-label="${htmlEscape(config.launcherLabel)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg><span>${htmlEscape(config.launcherLabel)}</span></button><section class="panel" aria-label="Movira chat"><div class="head"><div class="head-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M7 9h10M7 13h6"/></svg></div><div class="head-copy"><strong>${htmlEscape(config.displayName)}</strong><span>${htmlEscape(config.greeting)}</span></div></div>${session ? `<div class="handling" role="status"></div><div class="messages" role="log" aria-live="polite"></div><div class="actions"><button type="button" class="handoff">Talk to a person</button><button type="button" class="followup">Request follow-up</button></div><div class="lead" hidden></div><div class="error" role="alert"></div><form class="form"><input aria-label="Message" maxlength="2000" placeholder="${htmlEscape(config.messagePlaceholder)}"/><button>Send</button></form>` : `<form class="details"><p>${htmlEscape(config.introText)}</p>${visitorField("name", "text", "Name", config.nameField, 120)}${visitorField("email", "email", "Email address", config.emailField, 320)}${visitorField("phone", "tel", "Phone number", config.phoneField, 30)}<label class="bot-trap" aria-hidden="true">Company website<input name="company" tabindex="-1" autocomplete="off" /></label><p>Your details help the park team follow up. This does not subscribe you to marketing.</p><div class="error" role="alert"></div><button>Start chat</button></form>`}</section>`;
    const panel = shadow.querySelector(".panel");
    const launcher = shadow.querySelector(".launcher");
    const setOpen = (open) => {
      panel.classList.toggle("open", open); launcher.setAttribute("aria-expanded", String(open));
      if (open) {
        if (session) loadMessages();
        const lead = shadow.querySelector(".lead");
        const target = lead && !lead.hidden
          ? lead.querySelector("input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button")
          : shadow.querySelector(session ? ".form input" : ".details input");
        target?.focus();
      }
      else launcher.focus();
    };
    launcher.setAttribute("aria-expanded", String(!!wasOpen));
    launcher.onclick = () => setOpen(!panel.classList.contains("open"));
    panel.onkeydown = (event) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); } };
    panel.classList.toggle("open", !!wasOpen);
    const close = document.createElement("button"); close.type = "button"; close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>'; close.setAttribute("aria-label", "Close chat"); close.onclick = () => setOpen(false); shadow.querySelector(".head").append(close);
    if (session) {
      bindMessageForm();
      shadow.querySelector(".handoff").onclick = async () => { try { await request("/handoff", { method: "POST", body: "{}" }); await loadStatus(); } catch (error) { showError(error); } };
      shadow.querySelector(".followup").onclick = openLeadForm;
    } else bindDetailsForm();
  }

  function bindDetailsForm() {
    shadow.querySelector(".details").onsubmit = async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const button = form.querySelector("button"); button.disabled = true;
      try {
        // Renew on submission: a booking page may have been open for hours.
        // Keep the form intact and respect the server's minimum challenge age.
        const fresh = await request('/config');
        config.browserChallenge = fresh.browserChallenge;
        if (config.browserChallenge) await new Promise(resolve => setTimeout(resolve, 550));
        session = await request("/sessions", { method: "POST", body: JSON.stringify({ visitor: { name: data.get("name"), email: data.get("email"), phone: data.get("phone"), pageUrl: location.href }, challenge: config.browserChallenge, company: data.get("company") }) });
        try { localStorage.setItem(storageKey, JSON.stringify(session)); } catch { /* Chat works without storage. */ }
        render(); startPolling();
      } catch (error) { showError(error); button.disabled = false; }
    };
  }

  function bindMessageForm() {
    shadow.querySelector(".form").onsubmit = async (event) => {
      event.preventDefault();
      const input = event.currentTarget.querySelector("input");
      const button = event.currentTarget.querySelector("button");
      if (button.disabled) return;
      const textBody = input.value.trim();
      if (!textBody) return;
      input.value = ""; button.disabled = true;
      showError({ message: "" });
      try {
        await request("/messages", { method: "POST", headers: { "Idempotency-Key": `wc-${Date.now()}-${Math.random().toString(36).slice(2)}` }, body: JSON.stringify({ textBody }) });
        await loadMessages();
      } catch (error) { shadow.querySelector(".error").textContent = error.message; if (!input.value) input.value = textBody; }
      finally { button.disabled = false; }
    };
  }

  async function loadMessages() {
    if (!session || loadingMessages || destroyed) return;
    loadingMessages = true;
    try {
      const rows = await request(`/messages${lastMessageAt ? `?after=${encodeURIComponent(lastMessageAt)}&afterId=${encodeURIComponent(lastMessageId || "")}` : ""}`);
      if (destroyed) return;
      const box = shadow.querySelector(".messages");
      const followLatest = box.scrollHeight - box.scrollTop - box.clientHeight < 100 || !seen.size;
      for (const message of rows) {
        lastMessageAt = message.occurredAt; lastMessageId = message.id;
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        const node = document.createElement("div");
        node.className = `msg ${message.direction === "inbound" ? "inbound" : "outbound"}${message.author === "system" ? " system" : ""}`;
        node.append(messageBody(message));
        const choices = document.createElement("div"); choices.className = "choices";
        for (const choice of (message.choices || []).slice(0, 12)) {
          let url; try { url = new URL(choice.url); } catch { /* Text choice. */ }
          const link = url && ["https:", "http:"].includes(url.protocol);
          const action = document.createElement(link ? "a" : "button"); action.textContent = choice.label || "Continue"; action.className = "choice"; action.setAttribute("aria-label", choice.label || "Continue");
          if (link) { action.href = url.toString(); action.target = "_blank"; action.rel = "noopener noreferrer"; }
          else { action.type = "button"; action.onclick = () => { const form = shadow.querySelector(".form"); form.querySelector("input").value = choice.message || choice.label || ""; form.requestSubmit(); }; }
          choices.append(action);
        }
        if (choices.childElementCount) node.append(choices);
        const metadata = document.createElement("small");
        metadata.textContent = `${message.author === "ai" ? config.assistantName : message.author === "visitor" ? "You" : message.author === "system" ? "System" : "Team"} · ${new Date(message.occurredAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
        node.append(metadata);
        box.appendChild(node);
        lastMessageAt = message.occurredAt;
      }
      if (rows.length && followLatest) box.scrollTop = box.scrollHeight;
      await loadStatus();
      if (shadow.querySelector(".error")?.dataset.source === "poll") showError({ message: "" });
    } catch (error) { if (error.status === 404) root.destroy(); else showError(error, "poll"); } finally { loadingMessages = false; }
  }

  function appendInline(parent, text) {
    // A small, safe formatting subset. Message content is never parsed as HTML.
    for (const part of String(text).split(/(\*\*[^*]+\*\*)/g)) {
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        const bold = document.createElement("strong"); bold.textContent = part.slice(2, -2); parent.append(bold);
      } else parent.append(document.createTextNode(part));
    }
  }

  function messageBody(message) {
    const body = document.createElement("div"); body.className = "message-body";
    const text = String(message.textBody || "");
    if (message.direction === "inbound") { const p = document.createElement("p"); p.textContent = text; body.append(p); return body; }
    const labels = new Set((message.choices || []).slice(0, 12).map(choice => String(choice.label || "").trim()));
    const blocks = text.split(/\n\s*\n/).filter(block => block.trim());
    for (const [index, block] of blocks.entries()) {
      const lines = block.trim().split("\n");
      const bullets = lines.map(line => line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/));
      if (bullets.every(Boolean)) {
        // Product choices already carry these exact labels. Show one actionable
        // list instead of repeating the same names above unstyled buttons.
        if (bullets.every(match => labels.has(match[1].replace(/\*\*/g, "").trim()))) continue;
        const list = document.createElement(/^\s*\d+[.)]/.test(lines[0]) ? "ol" : "ul");
        for (const match of bullets) { const item = document.createElement("li"); appendInline(item, match[1]); list.append(item); }
        body.append(list);
      } else {
        const p = document.createElement("p");
        const heading = /^#{1,3}\s+/.test(block) || (index === 0 && blocks.length > 1 && !block.includes("\n") && block.length <= 100);
        if (heading) p.className = "response-title";
        appendInline(p, block.replace(/^#{1,3}\s+/, "")); body.append(p);
      }
    }
    return body;
  }

  function showError(error, source = "action") {
    const el = shadow.querySelector(".error");
    if (!el || (source === "poll" && el.textContent && el.dataset.source === "action")) return;
    el.dataset.source = source;
    el.textContent = source === "poll" ? "Connection interrupted. Reconnecting…" : error.message;
  }
  async function loadStatus() {
    const status = await request("/session");
    if (destroyed) return;
    config = { ...config, ...status.settings };
    shadow.querySelector(".head strong").textContent = config.displayName;
    shadow.querySelector(".head span").textContent = config.greeting;
    shadow.querySelector(".handling").dataset.mode = status.handlingMode;
    shadow.querySelector(".handling").textContent = status.handlingMode === "ai" ? `${config.assistantName} · AI assistant` : status.handlingMode === "human" ? "Your team is handling this chat" : config.offlineMessage;
    shadow.querySelector(".handoff").hidden = status.handlingMode !== "ai";
  }
  async function openLeadForm() {
    try {
      showError({ message: "" });
      const result = await request("/lead");
      const container = shadow.querySelector(".lead"); container.replaceChildren();
      setLeadOpen(true);
      if (result.state === "success") { showLeadSuccess(result.message); return; }
      const definition = result.form;
      if (!definition) { setLeadOpen(false); throw new Error("Follow-up form is unavailable. Please try again."); }
      const form = document.createElement("form"); form.className = "details";
      const title = document.createElement("h2"); title.textContent = "Request a follow-up"; form.append(title);
      const notice = document.createElement("p"); notice.textContent = definition.privacyNotice; form.append(notice);
      const fields = [...(definition.leadTypes?.length ? [{ key: "lead_type", label: "Request type", type: "select", options: definition.leadTypes, required: definition.leadTypeRequired }] : []), ...definition.fields];
      const controls = fields.map((field) => {
        const label = document.createElement("label"); label.className = "detail-field";
        const caption = document.createElement("span"); caption.textContent = `${field.label}${field.required ? " *" : ""}`; label.append(caption);
        const select = ["select", "multiselect", "boolean"].includes(field.type);
        const input = document.createElement(select ? "select" : field.type === "textarea" ? "textarea" : "input");
        input.name = field.key;
        if (select) {
          input.multiple = field.type === "multiselect";
          const options = field.type === "boolean" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : field.options || [];
          for (const item of [{ value: "", label: "Choose an option" }, ...options]) { const option = document.createElement("option"); option.value = typeof item === "object" ? item.value : item; option.textContent = typeof item === "object" ? item.label : item; input.append(option); }
        } else { input.type = ({ phone: "tel", email: "email", number: "number", date: "date", time: "time" })[field.type] || "text"; input.maxLength = field.type === "textarea" ? 2000 : 500; }
        if (field.min != null) input.min = field.min; if (field.max != null) input.max = field.max;
        input.value = definition.values?.[field.key] || "";
        const errorText = document.createElement("small"); errorText.id = `lead-error-${field.key}`; errorText.style.color = "#b42318"; errorText.hidden = true;
        input.setAttribute("aria-describedby", errorText.id);
        input.oninput = () => { input.removeAttribute("aria-invalid"); errorText.hidden = true; errorText.textContent = ""; };
        label.append(input, errorText); form.append(label); return { field, input, label, errorText };
      });
      const applyConditions = () => { const type = form.elements.lead_type?.value || "general"; for (const { field, input, label } of controls) { const show = !field.leadTypes?.length || field.leadTypes.includes(type); label.hidden = !show; input.disabled = !show; input.required = show && field.required; } };
      form.onchange = applyConditions; applyConditions();
      const submit = document.createElement("button"); submit.textContent = definition.submitLabel || "Send request";
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel"; cancel.onclick = () => setLeadOpen(false);
      form.append(submit, cancel); container.append(form);
      controls.find(({ input }) => !input.disabled)?.input.focus();
      form.onsubmit = async (event) => {
        event.preventDefault(); submit.disabled = true;
        showError({ message: "" });
        for (const { input, errorText } of controls) { input.removeAttribute("aria-invalid"); errorText.hidden = true; errorText.textContent = ""; }
        const values = {}; for (const { input } of controls) if (!input.disabled) values[input.name] = input.multiple ? Array.from(input.selectedOptions, (option) => option.value) : input.value;
        try { const saved = await request("/lead", { method: "POST", body: JSON.stringify({ fields: values }) }); if (saved.state !== "success" && saved.type !== "lead_saved") throw new Error(saved.message || "Please check your form."); showLeadSuccess(saved.message); }
        catch (error) {
          showError(error); submit.disabled = false;
          let firstInvalid;
          for (const { field, input, errorText } of controls) {
            const message = error.details?.fieldErrors?.[field.key];
            if (!message || input.disabled) continue;
            errorText.textContent = message; errorText.hidden = false; input.setAttribute("aria-invalid", "true");
            firstInvalid ||= input;
          }
          firstInvalid?.focus();
        }
      };
    } catch (error) { showError(error); }
  }

  function setLeadOpen(open) {
    shadow.querySelector(".lead").hidden = !open;
    for (const selector of [".messages", ".actions", ".form"]) shadow.querySelector(selector).hidden = open;
    if (!open) { showError({ message: "" }); shadow.querySelector(".followup").focus(); }
  }

  function showLeadSuccess(message) {
    const container = shadow.querySelector(".lead"); container.replaceChildren();
    const card = document.createElement("div"); card.className = "lead-success";
    const title = document.createElement("h2"); title.textContent = "Request received";
    const text = document.createElement("p"); text.textContent = message;
    const back = document.createElement("button"); back.type = "button"; back.textContent = "Back to chat"; back.onclick = () => setLeadOpen(false);
    card.append(title, text, back); container.append(card); back.focus();
  }

  function startPolling() {
    clearInterval(pollTimer);
    loadMessages();
    pollTimer = setInterval(loadMessages, 4000);
  }

  (async () => {
    try {
      config = await request("/config");
      try { session = JSON.parse(localStorage.getItem(storageKey) || "null"); } catch { session = null; }
      if (session?.sessionToken) {
        try { session = await request("/sessions", { method: "POST", body: JSON.stringify({ sessionToken: session.sessionToken, visitor: {}, pageUrl: location.href }) }); }
        catch { session = null; localStorage.removeItem(storageKey); }
      }
      if (destroyed) return;
      render();
      if (session) startPolling();
    } catch (error) { root.destroy(); console.warn("Movira chat:", error.message); }
  })();
})();
