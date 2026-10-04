(() => {
  if (window.__moviraWebChatLoaded) return;
  window.__moviraWebChatLoaded = true;
  const script = document.currentScript;
  const widgetKey = script?.dataset?.widgetKey;
  if (!widgetKey) return;
  const apiBase = new URL(script.src).pathname.replace(/\/widget\.js$/, `/${encodeURIComponent(widgetKey)}`);
  const apiOrigin = new URL(script.src).origin;
  const api = `${apiOrigin}${apiBase}`;
  const storageKey = `movira:webchat:${widgetKey}`;
  let session = null;
  let config = null;
  let pollTimer = null;
  let lastMessageAt = null;

  const root = document.createElement("div");
  root.id = "movira-chat-root";
  const shadow = root.attachShadow({ mode: "open" });
  document.body.appendChild(root);

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
    if (!response.ok) throw new Error(payload.message || "Chat is unavailable.");
    return payload.data;
  }

  function styles() {
    return `<style>
      *{box-sizing:border-box}button,input{font:inherit}.launcher{position:fixed;z-index:2147483000;bottom:22px;${config.position}:22px;display:flex;min-height:50px;align-items:center;justify-content:center;gap:9px;border:0;border-radius:999px;padding:0 17px;background:${config.accentColor};color:#fff;box-shadow:0 12px 35px #0003;font:700 14px/1.2 system-ui;cursor:pointer}.launcher svg{width:20px;height:20px;flex:0 0 auto}.launcher.style-compact{min-height:42px;border-radius:12px;padding:0 13px;font-size:12px}.launcher.style-bubble,.launcher.style-square{width:52px;padding:0}.launcher.style-bubble{border-radius:50%}.launcher.style-square{border-radius:15px}.launcher.style-bubble span,.launcher.style-square span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.launcher.style-text{min-height:44px;border-radius:11px;padding:0 18px}.launcher.style-text svg{display:none}.panel{position:fixed;z-index:2147483000;bottom:84px;${config.position}:22px;width:min(370px,calc(100vw - 28px));height:min(560px,calc(100vh - 110px));overflow:hidden;border:1px solid #e7e4ee;border-radius:20px;background:#fff;box-shadow:0 25px 70px #1b12352e;font:14px/1.4 system-ui;color:#1e2532;display:none;flex-direction:column}.panel.open{display:flex}.head{padding:18px;background:${config.accentColor};color:#fff}.head strong{display:block;font-size:17px}.head span{font-size:12px;opacity:.88}.messages{flex:1;overflow:auto;padding:16px;background:#f8f7fb}.msg{max-width:82%;margin:0 0 10px;padding:10px 12px;border-radius:14px 14px 14px 4px;background:#fff;box-shadow:0 2px 8px #1b12350d;white-space:pre-wrap}.msg.outbound{margin-left:auto;border-radius:14px 14px 4px;background:${config.accentColor};color:#fff}.msg small{display:block;margin-top:4px;font-size:9px;opacity:.65}.form,.details{display:flex;gap:8px;padding:12px;border-top:1px solid #ece9f1;background:#fff}.form input,.details input{width:100%;border:1px solid #dcd7e5;border-radius:10px;padding:10px;outline:none}.form input:focus,.details input:focus{border-color:${config.accentColor};box-shadow:0 0 0 3px ${config.accentColor}1f}.form button,.details button{border:0;border-radius:10px;padding:0 14px;background:${config.accentColor};color:#fff;font-weight:700;cursor:pointer}.details{display:grid;padding:16px}.details>p{margin:0 0 4px;color:#62697a;font-size:12px}.details button{min-height:42px}.detail-field{display:grid;gap:5px}.detail-field span{color:#424958;font-size:11px;font-weight:700}.detail-field small{color:#7a8190;font-size:10px;font-weight:500}.error{padding:8px 14px;color:#b42318;font-size:11px}@media(max-width:480px){.panel{bottom:0;left:0;right:0;width:100%;height:100%;max-height:none;border-radius:0}.launcher{bottom:15px;${config.position}:15px}}
      .launcher.style-outline{border:2px solid ${config.accentColor};background:#fff;color:${config.accentColor};box-shadow:0 10px 28px #0002}.launcher.style-status{display:grid;min-height:58px;grid-template-columns:auto auto;grid-template-rows:auto auto;column-gap:10px;row-gap:1px;justify-content:start;border-radius:16px;padding:9px 16px}.launcher.style-status svg{grid-row:1/3}.launcher.style-status::after{content:"Online now";grid-column:2;color:#fff;font-size:10px;font-weight:600;opacity:.84}.launcher.style-tab{bottom:120px;${config.position}:0;min-height:96px;border-radius:${config.position === "right" ? "14px 0 0 14px" : "0 14px 14px 0"};padding:13px 10px;writing-mode:vertical-rl;${config.position === "left" ? "transform:rotate(180deg);" : ""}}
    </style>`;
  }

  function render() {
    shadow.innerHTML = `${styles()}<button class="launcher style-${htmlEscape(config.launcherStyle)}" aria-label="${htmlEscape(config.launcherLabel)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg><span>${htmlEscape(config.launcherLabel)}</span></button><section class="panel" aria-label="Movira chat"><div class="head"><strong>${htmlEscape(config.displayName)}</strong><span>${htmlEscape(config.greeting)}</span></div>${session ? `<div class="messages"></div><div class="error"></div><form class="form"><input aria-label="Message" maxlength="2000" placeholder="${htmlEscape(config.messagePlaceholder)}"/><button>Send</button></form>` : `<form class="details"><p>${htmlEscape(config.introText)}</p>${visitorField("name", "text", "Name", config.nameField, 120)}${visitorField("email", "email", "Email address", config.emailField, 320)}${visitorField("phone", "tel", "Phone number", config.phoneField, 30)}<button>Start chat</button></form>`}</section>`;
    const panel = shadow.querySelector(".panel");
    shadow.querySelector(".launcher").onclick = () => { panel.classList.toggle("open"); if (panel.classList.contains("open") && session) loadMessages(); };
    if (session) bindMessageForm(); else bindDetailsForm();
  }

  function bindDetailsForm() {
    shadow.querySelector(".details").onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      try {
        session = await request("/sessions", { method: "POST", body: JSON.stringify({ visitor: { name: data.get("name"), email: data.get("email"), phone: data.get("phone"), pageUrl: location.href } }) });
        localStorage.setItem(storageKey, JSON.stringify(session));
        render();
        startPolling();
      } catch (error) { alert(error.message); }
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
    if (!session) return;
    try {
      const rows = await request(`/messages${lastMessageAt ? `?after=${encodeURIComponent(lastMessageAt)}` : ""}`);
      const box = shadow.querySelector(".messages");
      for (const message of rows) {
        const node = document.createElement("div");
        node.className = `msg ${message.direction}`;
        node.innerHTML = `${htmlEscape(message.textBody)}<small>${new Date(message.occurredAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small>`;
        box.appendChild(node);
        lastMessageAt = message.occurredAt;
      }
      if (rows.length) box.scrollTop = box.scrollHeight;
      shadow.querySelector(".error").textContent = "";
    } catch (error) { shadow.querySelector(".error").textContent = error.message; }
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
      render();
      if (session) startPolling();
    } catch (error) { console.warn("Movira chat:", error.message); }
  })();
})();
