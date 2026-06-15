/**
 * NeonPing Chat Widget
 * Injected via Shopify Theme App Extension block.
 * Config is written inline by the Liquid block before this script runs.
 */
(function () {
  "use strict";

  // -------------------------------------------------------------------------
  // Config — injected by neonping-widget.liquid before this script
  // -------------------------------------------------------------------------
  const cfg = window.__neonping_cfg;
  if (!cfg || !cfg.api_url || !cfg.shop) return; // misconfigured — bail silently

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const SESSION_KEY = "neonping_sid_" + cfg.shop.replace(/\./g, "_");
  let sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, sessionId);
  }

  let isOpen = false;
  let isThinking = false;
  let currentAbort = null;

  // -------------------------------------------------------------------------
  // Styles
  // -------------------------------------------------------------------------
  const style = document.createElement("style");
  style.textContent = `
    #np-launcher {
      position: fixed;
      ${cfg.position === "bottom-left" ? "left: 20px;" : "right: 20px;"}
      bottom: 20px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: ${cfg.color};
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,.25);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9998;
      transition: transform .2s;
    }
    #np-launcher:hover { transform: scale(1.08); }
    #np-launcher svg { width: 26px; height: 26px; fill: #fff; }

    #np-panel {
      position: fixed;
      ${cfg.position === "bottom-left" ? "left: 20px;" : "right: 20px;"}
      bottom: 86px;
      width: 360px;
      max-width: calc(100vw - 32px);
      height: 520px;
      max-height: calc(100vh - 110px);
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,.18);
      display: flex;
      flex-direction: column;
      z-index: 9999;
      overflow: hidden;
      transform: translateY(12px);
      opacity: 0;
      pointer-events: none;
      transition: opacity .2s, transform .2s;
    }
    #np-panel.np-open {
      opacity: 1;
      transform: translateY(0);
      pointer-events: all;
    }

    #np-header {
      background: ${cfg.color};
      color: #fff;
      padding: 14px 16px;
      font-family: system-ui, sans-serif;
      font-size: 15px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    #np-header-title { flex: 1; }
    #np-close {
      background: none;
      border: none;
      color: #fff;
      cursor: pointer;
      opacity: .8;
      padding: 2px;
      line-height: 1;
      font-size: 20px;
    }
    #np-close:hover { opacity: 1; }

    #np-messages {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-family: system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.5;
    }

    .np-msg {
      max-width: 80%;
      padding: 9px 13px;
      border-radius: 14px;
      word-break: break-word;
    }
    .np-msg.np-user {
      align-self: flex-end;
      background: ${cfg.color};
      color: #fff;
      border-bottom-right-radius: 4px;
    }
    .np-msg.np-bot {
      align-self: flex-start;
      background: #f1f1f1;
      color: #111;
      border-bottom-left-radius: 4px;
    }
    .np-msg.np-error {
      background: #fff0f0;
      color: #c0392b;
      align-self: flex-start;
    }

    .np-typing {
      align-self: flex-start;
      display: flex;
      gap: 5px;
      padding: 9px 13px;
    }
    .np-typing span {
      width: 8px; height: 8px;
      background: #bbb;
      border-radius: 50%;
      animation: np-bounce .9s infinite;
    }
    .np-typing span:nth-child(2) { animation-delay: .15s; }
    .np-typing span:nth-child(3) { animation-delay: .3s; }
    @keyframes np-bounce {
      0%, 80%, 100% { transform: translateY(0); }
      40% { transform: translateY(-6px); }
    }

    .np-products {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 6px;
    }
    .np-product {
      display: flex;
      gap: 10px;
      background: #fff;
      border: 1px solid #e8e8e8;
      border-radius: 10px;
      padding: 8px;
      align-items: center;
      text-decoration: none;
      color: inherit;
    }
    .np-product img {
      width: 48px;
      height: 48px;
      object-fit: cover;
      border-radius: 6px;
      flex-shrink: 0;
    }
    .np-product-info { flex: 1; min-width: 0; }
    .np-product-title {
      font-weight: 600;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .np-product-price { font-size: 12px; color: #555; margin-top: 2px; }

    .np-quick-replies {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    .np-qr {
      background: none;
      border: 1.5px solid ${cfg.color};
      color: ${cfg.color};
      border-radius: 20px;
      padding: 5px 13px;
      font-size: 13px;
      cursor: pointer;
      font-family: system-ui, sans-serif;
      transition: background .15s, color .15s;
    }
    .np-qr:hover { background: ${cfg.color}; color: #fff; }

    .np-checkout-link {
      display: inline-block;
      margin-top: 8px;
      background: ${cfg.color};
      color: #fff;
      border-radius: 8px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
    }
    .np-checkout-link:hover { opacity: .9; }

    .np-discount-badge {
      display: inline-block;
      background: #e8f5e9;
      color: #2e7d32;
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 600;
      margin-top: 6px;
      letter-spacing: .5px;
    }

    #np-input-row {
      display: flex;
      gap: 8px;
      padding: 12px;
      border-top: 1px solid #eee;
      flex-shrink: 0;
    }
    #np-input {
      flex: 1;
      border: 1.5px solid #ddd;
      border-radius: 22px;
      padding: 9px 14px;
      font-size: 14px;
      font-family: system-ui, sans-serif;
      outline: none;
      transition: border-color .15s;
    }
    #np-input:focus { border-color: ${cfg.color}; }
    #np-send {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: ${cfg.color};
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: opacity .15s;
    }
    #np-send:disabled { opacity: .45; cursor: default; }
    #np-send svg { width: 18px; height: 18px; fill: #fff; }
  `;
  document.head.appendChild(style);

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------
  const launcher = document.createElement("button");
  launcher.id = "np-launcher";
  launcher.setAttribute("aria-label", "Open chat");
  launcher.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/></svg>`;

  const panel = document.createElement("div");
  panel.id = "np-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "NeonPing chat");
  panel.innerHTML = `
    <div id="np-header">
      <svg style="width:20px;height:20px;fill:#fff;flex-shrink:0" viewBox="0 0 24 24">
        <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/>
      </svg>
      <span id="np-header-title">${escHtml(cfg.store_name || cfg.shop)}</span>
      <button id="np-close" aria-label="Close chat">&times;</button>
    </div>
    <div id="np-messages"></div>
    <div id="np-input-row">
      <input id="np-input" type="text" placeholder="${escHtml(cfg.placeholder || "Ask me anything…")}" autocomplete="off" />
      <button id="np-send" aria-label="Send">
        <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
      </button>
    </div>
  `;

  document.body.appendChild(launcher);
  document.body.appendChild(panel);

  const messagesEl = document.getElementById("np-messages");
  const inputEl = document.getElementById("np-input");
  const sendBtn = document.getElementById("np-send");

  // -------------------------------------------------------------------------
  // Greeting
  // -------------------------------------------------------------------------
  if (cfg.greeting) {
    appendBotMessage(cfg.greeting);
  }

  // -------------------------------------------------------------------------
  // Toggle
  // -------------------------------------------------------------------------
  launcher.addEventListener("click", () => togglePanel(true));
  document.getElementById("np-close").addEventListener("click", () => togglePanel(false));

  function togglePanel(open) {
    isOpen = open;
    panel.classList.toggle("np-open", open);
    launcher.setAttribute("aria-expanded", String(open));
    if (open) inputEl.focus();
  }

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------
  sendBtn.addEventListener("click", sendMessage);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || isThinking) return;

    inputEl.value = "";
    appendUserMessage(text);
    runChat(text);
  }

  // -------------------------------------------------------------------------
  // Chat — SSE streaming
  // -------------------------------------------------------------------------
  async function runChat(userText) {
    setThinking(true);
    const typingEl = appendTyping();

    // Abort any in-flight request
    if (currentAbort) currentAbort.abort();
    const abortCtrl = new AbortController();
    currentAbort = abortCtrl;

    let botEl = null;
    let botText = "";

    try {
      const res = await fetch(cfg.api_url, {
        method: "POST",
        signal: abortCtrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          shop: cfg.shop,
          message: userText,
          customer_id: cfg.customer_id || undefined,
          customer_access_token: cfg.customer_access_token || undefined,
          cart_total_cents: cfg.cart_total_cents || undefined,
        }),
      });

      if (!res.ok) throw new Error("HTTP " + res.status);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      typingEl.remove();
      botEl = appendBotMessage("");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop(); // keep incomplete chunk

        for (const part of parts) {
          const lines = part.split("\n");
          let event = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          handleSseEvent(event, data, botEl, (t) => { botText += t; });
        }
      }

      // Ensure final text is rendered
      if (botEl) botEl.innerHTML = renderText(botText);
    } catch (err) {
      typingEl.remove();
      if (err.name !== "AbortError") {
        appendErrorMessage(cfg.error_message || "Something went wrong. Please try again.");
      }
    } finally {
      setThinking(false);
      scrollBottom();
    }
  }

  function handleSseEvent(event, data, botEl, appendText) {
    if (event === "delta") {
      try {
        const { text } = JSON.parse(data);
        appendText(text);
        if (botEl) botEl.innerHTML = renderText(
          botEl.dataset.raw = (botEl.dataset.raw || "") + text
        );
      } catch { /* ignore malformed */ }
    }

    if (event === "meta") {
      try {
        const meta = JSON.parse(data);
        renderMeta(meta, botEl);
      } catch { /* ignore */ }
    }

    if (event === "error") {
      try {
        const { message } = JSON.parse(data);
        appendErrorMessage(message || (cfg.error_message || "Something went wrong."));
      } catch { /* ignore */ }
    }
  }

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------
  function renderText(text) {
    // Basic markdown: **bold**, newlines → <br>
    return escHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
  }

  function renderMeta(meta, botEl) {
    if (!botEl) return;
    const extras = document.createElement("div");

    // Products carousel
    if (meta.products && meta.products.length) {
      const list = document.createElement("div");
      list.className = "np-products";
      for (const p of meta.products.slice(0, 3)) {
        const item = document.createElement("a");
        item.className = "np-product";
        item.href = p.url ? "https://" + cfg.shop + p.url : "#";
        item.target = "_blank";
        item.rel = "noopener";
        item.innerHTML = `
          ${p.image_url ? `<img src="${escHtml(p.image_url)}" alt="${escHtml(p.title || "")}" loading="lazy"/>` : ""}
          <div class="np-product-info">
            <div class="np-product-title">${escHtml(p.title || "Product")}</div>
            ${p.price_min ? `<div class="np-product-price">${escHtml(p.price_min)}</div>` : ""}
          </div>
        `;
        list.appendChild(item);
      }
      extras.appendChild(list);
    }

    // Discount code badge
    if (meta.discount_code) {
      const badge = document.createElement("div");
      badge.className = "np-discount-badge";
      badge.textContent = "🏷 " + meta.discount_code;
      extras.appendChild(badge);
    }

    // Checkout CTA
    if (meta.checkout_url) {
      const link = document.createElement("a");
      link.className = "np-checkout-link";
      link.href = meta.checkout_url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Complete checkout →";
      extras.appendChild(link);
    }

    // Quick replies
    if (meta.quick_replies && meta.quick_replies.length) {
      const qrRow = document.createElement("div");
      qrRow.className = "np-quick-replies";
      for (const label of meta.quick_replies) {
        const btn = document.createElement("button");
        btn.className = "np-qr";
        btn.textContent = label;
        btn.addEventListener("click", () => {
          inputEl.value = label;
          sendMessage();
        });
        qrRow.appendChild(btn);
      }
      extras.appendChild(qrRow);
    }

    if (extras.children.length) botEl.appendChild(extras);
    scrollBottom();
  }

  // -------------------------------------------------------------------------
  // DOM helpers
  // -------------------------------------------------------------------------
  function appendUserMessage(text) {
    const el = document.createElement("div");
    el.className = "np-msg np-user";
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollBottom();
    return el;
  }

  function appendBotMessage(text) {
    const el = document.createElement("div");
    el.className = "np-msg np-bot";
    el.innerHTML = renderText(text);
    messagesEl.appendChild(el);
    scrollBottom();
    return el;
  }

  function appendErrorMessage(text) {
    const el = document.createElement("div");
    el.className = "np-msg np-error";
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollBottom();
  }

  function appendTyping() {
    const el = document.createElement("div");
    el.className = "np-typing";
    el.innerHTML = "<span></span><span></span><span></span>";
    messagesEl.appendChild(el);
    scrollBottom();
    return el;
  }

  function setThinking(val) {
    isThinking = val;
    sendBtn.disabled = val;
    inputEl.disabled = val;
  }

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
