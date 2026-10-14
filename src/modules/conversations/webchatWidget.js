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
    if (!response.ok) throw Object.assign(new Error(payload.message || "Chat is unavailable."), { status: response.status, code: payload.error });
    return payload.data;
  }

  function styles() {
    return `<style>
      *{box-sizing:border-box}button,input{font:inherit}.launcher{position:fixed;z-index:2147483000;bottom:22px;${config.position}:22px;display:flex;min-height:50px;align-items:center;justify-content:center;gap:9px;border:0;border-radius:999px;padding:0 17px;background:${config.accentColor};color:#fff;box-shadow:0 12px 35px #0003;font:700 14px/1.2 system-ui;cursor:pointer}.launcher svg{width:20px;height:20px;flex:0 0 auto}.launcher.style-compact{min-height:42px;border-radius:12px;padding:0 13px;font-size:12px}.launcher.style-bubble,.launcher.style-square{width:52px;padding:0}.launcher.style-bubble{border-radius:50%}.launcher.style-square{border-radius:15px}.launcher.style-bubble span,.launcher.style-square span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.launcher.style-text{min-height:44px;border-radius:11px;padding:0 18px}.launcher.style-text svg{display:none}.panel{position:fixed;z-index:2147483000;bottom:84px;${config.position}:22px;width:min(370px,calc(100vw - 28px));height:min(560px,calc(100vh - 110px));overflow:hidden;border:1px solid #e7e4ee;border-radius:20px;background:#fff;box-shadow:0 25px 70px #1b12352e;font:14px/1.4 system-ui;color:#1e2532;display:none;flex-direction:column}.panel.open{display:flex}.head{padding:18px;background:${config.accentColor};color:#fff}.head strong{display:block;font-size:17px}.head span{font-size:12px;opacity:.88}.messages{flex:1;overflow:auto;padding:16px;background:#f8f7fb}.msg{max-width:82%;margin:0 0 10px;padding:10px 12px;border-radius:14px 14px 14px 4px;background:#fff;box-shadow:0 2px 8px #1b12350d;white-space:pre-wrap}.msg.inbound{margin-left:auto;border-radius:14px 14px 4px;background:${config.accentColor};color:#fff}.msg small{display:block;margin-top:4px;font-size:9px;opacity:.65}.form,.details{display:flex;gap:8px;padding:12px;border-top:1px solid #ece9f1;background:#fff}.form input,.details input{width:100%;border:1px solid #dcd7e5;border-radius:10px;padding:10px;outline:none}.form input:focus,.details input:focus{border-color:${config.accentColor};box-shadow:0 0 0 3px ${config.accentColor}1f}.form button,.details button{border:0;border-radius:10px;padding:0 14px;background:${config.accentColor};color:#fff;font-weight:700;cursor:pointer}.details{display:grid;padding:16px}.details>p{margin:0 0 4px;color:#62697a;font-size:12px}.details button{min-height:42px}.detail-field{display:grid;gap:5px}.detail-field span{color:#424958;font-size:11px;font-weight:700}.detail-field small{color:#7a8190;font-size:10px;font-weight:500}.error{padding:8px 14px;color:#b42318;font-size:11px}@media(max-width:480px){.panel{bottom:0;left:0;right:0;width:100%;height:100%;max-height:none;border-radius:0}.launcher{bottom:15px;${config.position}:15px}}
      .launcher.style-outline{border:2px solid ${config.accentColor};background:#fff;color:${config.accentColor};box-shadow:0 10px 28px #0002}.launcher.style-status{display:grid;min-height:58px;grid-template-columns:auto auto;grid-template-rows:auto auto;column-gap:10px;row-gap:1px;justify-content:start;border-radius:16px;padding:9px 16px}.launcher.style-status svg{grid-row:1/3}.launcher.style-status::after{content:"Chat with us";grid-column:2;color:#fff;font-size:10px;font-weight:600;opacity:.84}.launcher.style-tab{bottom:120px;${config.position}:0;min-height:96px;border-radius:${config.position === "right" ? "14px 0 0 14px" : "0 14px 14px 0"};padding:13px 10px;writing-mode:vertical-rl;${config.position === "left" ? "transform:rotate(180deg);" : ""}}
      .handling,.actions{padding:8px 14px;font-size:12px}.actions{display:flex;gap:8px}.actions button,.head button{cursor:pointer;border:1px solid #ddd;border-radius:8px;padding:6px;background:white;color:#332b45}.lead{max-height:65%;overflow:auto}.lead select,.lead textarea{width:100%;padding:8px}.detail-field[hidden]{display:none}.bot-trap{position:absolute;left:-10000px;opacity:0;height:1px;overflow:hidden}.details button:disabled{opacity:.55;cursor:wait}.head button{float:right}
    </style>`;
  }

  function render() {
    const wasOpen = shadow.querySelector(".panel")?.classList.contains("open") || script.dataset.open === "true";
    seen.clear(); lastMessageAt = null; lastMessageId = null;
    shadow.innerHTML = `${styles()}<button class="launcher style-${htmlEscape(config.launcherStyle)}" aria-label="${htmlEscape(config.launcherLabel)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg><span>${htmlEscape(config.launcherLabel)}</span></button><section class="panel" aria-label="Movira chat"><div class="head"><strong>${htmlEscape(config.displayName)}</strong><span>${htmlEscape(config.greeting)}</span></div>${session ? `<div class="handling" role="status"></div><div class="messages" role="log" aria-live="polite"></div><div class="actions"><button type="button" class="handoff">Talk to a person</button><button type="button" class="followup">Request follow-up</button></div><div class="lead" hidden></div><div class="error" role="alert"></div><form class="form"><input aria-label="Message" maxlength="2000" placeholder="${htmlEscape(config.messagePlaceholder)}"/><button>Send</button></form>` : `<form class="details"><p>${htmlEscape(config.introText)}</p>${visitorField("name", "text", "Name", config.nameField, 120)}${visitorField("email", "email", "Email address", config.emailField, 320)}${visitorField("phone", "tel", "Phone number", config.phoneField, 30)}<label class="bot-trap" aria-hidden="true">Company website<input name="company" tabindex="-1" autocomplete="off" /></label><p>Your details help the park team follow up. This does not subscribe you to marketing.</p><div class="error" role="alert"></div><button>Start chat</button></form>`}</section>`;
    const panel = shadow.querySelector(".panel");
    shadow.querySelector(".launcher").onclick = () => { panel.classList.toggle("open"); if (panel.classList.contains("open") && session) loadMessages(); };
    panel.classList.toggle("open", !!wasOpen);
    const close = document.createElement("button"); close.type = "button"; close.textContent = "Close"; close.setAttribute("aria-label", "Close chat"); close.onclick = () => panel.classList.remove("open"); shadow.querySelector(".head").append(close);
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
      const textBody = input.value.trim();
      if (!textBody) return;
      input.value = "";
      try {
        await request("/messages", { method: "POST", headers: { "Idempotency-Key": `wc-${Date.now()}-${Math.random().toString(36).slice(2)}` }, body: JSON.stringify({ textBody }) });
        await loadMessages();
      } catch (error) { shadow.querySelector(".error").textContent = error.message; input.value = textBody; }
    };
  }

  async function loadMessages() {
    if (!session || loadingMessages || destroyed) return;
    loadingMessages = true;
    try {
      const rows = await request(`/messages${lastMessageAt ? `?after=${encodeURIComponent(lastMessageAt)}&afterId=${encodeURIComponent(lastMessageId || "")}` : ""}`);
      if (destroyed) return;
      const box = shadow.querySelector(".messages");
      for (const message of rows) {
        lastMessageAt = message.occurredAt; lastMessageId = message.id;
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        const node = document.createElement("div");
        node.className = `msg ${message.direction}`;
        node.innerHTML = `${htmlEscape(message.textBody)}<small>${htmlEscape(message.author === "ai" ? config.assistantName : message.author === "visitor" ? "You" : message.author === "system" ? "System" : "Team")} · ${new Date(message.occurredAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small>`;
        for (const choice of (message.choices || []).slice(0, 12)) {
          let url; try { url = new URL(choice.url); } catch { /* Text choice. */ }
          const link = url && ["https:", "http:"].includes(url.protocol);
          const action = document.createElement(link ? "a" : "button"); action.textContent = choice.label || "Continue";
          if (link) { action.href = url.toString(); action.target = "_blank"; action.rel = "noopener noreferrer"; }
          else { action.type = "button"; action.onclick = () => { const form = shadow.querySelector(".form"); form.querySelector("input").value = choice.message || choice.label || ""; form.requestSubmit(); }; }
          node.append(action);
        }
        box.appendChild(node);
        lastMessageAt = message.occurredAt;
      }
      if (rows.length) box.scrollTop = box.scrollHeight;
      await loadStatus();
    } catch (error) { if (error.status === 404) root.destroy(); else showError(error); } finally { loadingMessages = false; }
  }

  function showError(error) { const el = shadow.querySelector(".error"); if (el) el.textContent = error.message; }
  async function loadStatus() {
    const status = await request("/session");
    if (destroyed) return;
    config = { ...config, ...status.settings };
    shadow.querySelector(".handling").textContent = status.handlingMode === "ai" ? `${config.assistantName} · AI assistant` : status.handlingMode === "human" ? "Your team is handling this chat" : config.offlineMessage;
    shadow.querySelector(".handoff").hidden = status.handlingMode !== "ai";
  }
  async function openLeadForm() {
    try {
      const result = await request("/lead");
      const container = shadow.querySelector(".lead"); container.hidden = false; container.replaceChildren();
      if (result.state === "success") { container.textContent = result.message; return; }
      const definition = result.form;
      if (!definition) throw new Error(result.message || "Follow-up form is unavailable.");
      const form = document.createElement("form"); form.className = "details";
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
        label.append(input); form.append(label); return { field, input, label };
      });
      const applyConditions = () => { const type = form.elements.lead_type?.value || "general"; for (const { field, input, label } of controls) { const show = !field.leadTypes?.length || field.leadTypes.includes(type); label.hidden = !show; input.disabled = !show; input.required = show && field.required; } };
      form.onchange = applyConditions; applyConditions();
      const submit = document.createElement("button"); submit.textContent = definition.submitLabel || "Send request";
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel"; cancel.onclick = () => { container.hidden = true; };
      form.append(submit, cancel); container.append(form);
      form.onsubmit = async (event) => {
        event.preventDefault(); submit.disabled = true;
        const values = {}; for (const { input } of controls) if (!input.disabled) values[input.name] = input.multiple ? Array.from(input.selectedOptions, (option) => option.value) : input.value;
        try { const saved = await request("/lead", { method: "POST", body: JSON.stringify({ fields: values }) }); if (saved.state !== "success" && saved.type !== "lead_saved") throw new Error(saved.message || "Please check your form."); container.textContent = saved.message; }
        catch (error) { showError(error); submit.disabled = false; }
      };
    } catch (error) { showError(error); }
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
