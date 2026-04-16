// ==UserScript==
// @name         Chatlink Twitch Mirror
// @namespace    chatlink
// @version      0.5.0
// @description  Inject Chatlink localhost events into Twitch's native chat message flow.
// @match        https://www.twitch.tv/*
// @match        https://www.twitch.tv/popout/*/chat
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  const BRIDGE_BASE = "http://127.0.0.1:8787";
  const MAX_RENDERED_MESSAGES = 120;
  const POLL_INTERVAL_MS = 2000;
  const DEBUG = false;
  const SHOW_BADGE = false;
  const STARTUP_CONTAINER_RETRIES = 10;
  const STATE = {
    booted: false,
    container: null,
    messages: new Map(),
    nodes: new Map(),
    pollTimer: null,
    lastError: "",
    lastPollAt: "",
    pollCount: 0,
    statusBadge: null,
  };

  function log(...args) {
    if (!DEBUG) {
      return;
    }

    console.log("[chatlink]", ...args);
  }

  function ensureStatusBadge() {
    if (!SHOW_BADGE && !DEBUG) {
      return null;
    }

    let badge = document.querySelector("[data-chatlink-status]");

    if (!badge) {
      badge = document.createElement("div");
      badge.dataset.chatlinkStatus = "true";
      badge.style.position = "fixed";
      badge.style.right = "12px";
      badge.style.bottom = "12px";
      badge.style.zIndex = "2147483647";
      badge.style.padding = "8px 10px";
      badge.style.borderRadius = "10px";
      badge.style.background = "rgba(15,15,20,0.92)";
      badge.style.color = "#fff";
      badge.style.fontSize = "12px";
      badge.style.fontFamily = 'Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif';
      badge.style.boxShadow = "0 10px 24px rgba(0,0,0,0.35)";
      badge.style.border = "1px solid rgba(255,255,255,0.14)";
      badge.style.maxWidth = "320px";
      badge.style.pointerEvents = "none";
      document.documentElement.append(badge);
    }

    STATE.statusBadge = badge;
    return badge;
  }

  function setStatusBadge(text, tone) {
    const badge = ensureStatusBadge();

    if (!badge) {
      return;
    }

    badge.textContent = `chatlink: ${text}`;
    badge.dataset.tone = tone;

    if (tone === "ok") {
      badge.style.background = "rgba(18,62,32,0.94)";
      badge.style.borderColor = "rgba(102,255,163,0.3)";
      return;
    }

    if (tone === "warn") {
      badge.style.background = "rgba(73,45,9,0.95)";
      badge.style.borderColor = "rgba(255,205,97,0.35)";
      return;
    }

    badge.style.background = "rgba(15,15,20,0.92)";
    badge.style.borderColor = "rgba(255,255,255,0.14)";
  }

  function findContainer() {
    return (
      document.querySelector('[data-test-selector="chat-scrollable-area__message-container"]') ||
      document.querySelector(".chat-scrollable-area__message-container") ||
      null
    );
  }

  function isSupportedPage() {
    const { hostname, pathname } = window.location;

    if (hostname === "www.twitch.tv") {
      if (/^\/popout\/[^/]+\/chat\/?$/.test(pathname)) {
        return true;
      }

      const blockedRoots = new Set([
        "",
        "directory",
        "downloads",
        "jobs",
        "settings",
        "subscriptions",
        "wallet",
        "inventory",
        "videos",
        "search",
        "turbo",
        "p",
      ]);
      const root = pathname.split("/").filter(Boolean)[0] ?? "";
      return !blockedRoots.has(root);
    }

    return false;
  }

  function getScrollableParent() {
    return (
      document.querySelector('[data-a-target="chat-scroller"]') ||
      STATE.container?.closest(".scrollable-area") ||
      null
    );
  }

  function ensureContainer() {
    const next = findContainer();

    if (!next) {
      return false;
    }

    if (STATE.container !== next) {
      STATE.container = next;
      rerenderAll();
    }

    return true;
  }

  function buildMessageNode(message) {
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    const row = document.createElement("div");
    const layout = document.createElement("div");
    const highlight = document.createElement("div");
    const messageContainer = document.createElement("div");
    const spacer = document.createElement("div");
    const contentWrap = document.createElement("div");
    const noBg = document.createElement("div");
    const content = document.createElement("div");
    const usernameWrap = document.createElement("div");
    const badgeSlot = document.createElement("span");
    const badge = document.createElement("span");
    const usernameButton = document.createElement("span");
    const username = document.createElement("span");
    const colon = document.createElement("span");
    const body = document.createElement("span");
    const text = document.createElement("span");

    outer.dataset.chatlinkShell = "true";
    inner.className = "Layout-sc-1xcs6mc-0";

    row.className = "chat-line__message";
    row.dataset.aTarget = "chat-line-message";
    row.dataset.chatlinkId = message.id;
    row.dataset.chatlink = "youtube";
    row.dataset.aUser = `yt:${message.authorChannelId || message.id}`;
    row.tabIndex = 0;
    row.setAttribute("align-items", "center");
    row.setAttribute("aria-label", `${message.author || "YouTube"}: ${message.text || ""}`);

    layout.className = "Layout-sc-1xcs6mc-0 AoXTY";
    highlight.className = "Layout-sc-1xcs6mc-0 haALyh chat-line__message-highlight";
    highlight.style.background = "linear-gradient(90deg, rgba(255,0,0,0.35), rgba(255,0,0,0))";

    messageContainer.className = "Layout-sc-1xcs6mc-0 AoXTY chat-line__message-container";
    contentWrap.className = "Layout-sc-1xcs6mc-0";
    noBg.className = "Layout-sc-1xcs6mc-0 fHdBNk chat-line__no-background";
    content.className = "Layout-sc-1xcs6mc-0 dtoOxd";
    usernameWrap.className =
      "Layout-sc-1xcs6mc-0 nnbce chat-line__username-container chat-line__username-container--hoverable";

    badge.className = "chat-badge";
    badge.textContent = "YT";
    badge.style.display = "inline-flex";
    badge.style.alignItems = "center";
    badge.style.justifyContent = "center";
    badge.style.minWidth = "20px";
    badge.style.height = "18px";
    badge.style.padding = "0 6px";
    badge.style.borderRadius = "999px";
    badge.style.background = "#ff0033";
    badge.style.color = "#fff";
    badge.style.fontSize = "10px";
    badge.style.fontWeight = "700";
    badge.style.lineHeight = "1";
    badge.style.marginRight = "6px";
    badge.title = "Mirrored from YouTube";

    usernameButton.className = "chat-line__username";
    usernameButton.setAttribute("role", "button");
    usernameButton.tabIndex = 0;

    username.className = "chat-author__display-name";
    username.dataset.aTarget = "chat-message-username";
    username.dataset.testSelector = "message-username";
    username.dataset.aUser = row.dataset.aUser;
    username.style.color = pickUsernameColor(message);
    username.textContent = message.author || "YouTube";

    colon.setAttribute("aria-hidden", "true");
    colon.textContent = ": ";

    body.dataset.aTarget = "chat-line-message-body";
    body.dir = "auto";

    text.className = "text-fragment";
    text.dataset.aTarget = "chat-message-text";
    text.textContent = message.text || "";

    badgeSlot.append(badge);
    usernameButton.append(username);
    usernameWrap.append(badgeSlot, usernameButton);
    body.append(text);
    content.append(usernameWrap, colon, body);
    noBg.append(content);
    contentWrap.append(noBg);
    messageContainer.append(spacer, contentWrap);
    layout.append(highlight, messageContainer);
    row.append(layout);
    inner.append(row);
    outer.append(inner);

    return outer;
  }

  function pickUsernameColor(message) {
    if (message.authorRole === "moderator") {
      return "#4aa3ff";
    }

    if (message.authorRole === "member") {
      return "#34c759";
    }

    return "#b3b3b3";
  }

  function trimRenderedMessages() {
    while (STATE.nodes.size > MAX_RENDERED_MESSAGES) {
      const oldestId = STATE.messages.keys().next().value;

      if (!oldestId) {
        break;
      }

      removeMessage(oldestId, true);
    }
  }

  function renderMessage(message) {
    STATE.messages.delete(message.id);
    STATE.messages.set(message.id, message);

    if (!ensureContainer() || !STATE.container) {
      return;
    }

    const scroller = getScrollableParent();
    const stickToBottom =
      !scroller ||
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 32;

    const nextNode = buildMessageNode(message);
    const existing = STATE.nodes.get(message.id);

    if (existing && existing.parentElement) {
      existing.replaceWith(nextNode);
    } else {
      STATE.container.append(nextNode);
    }

    STATE.nodes.set(message.id, nextNode);
    trimRenderedMessages();
    setStatusBadge(`live ${STATE.nodes.size} mirrored`, "ok");

    if (stickToBottom && scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }

  function removeMessage(id, dropState) {
    const node = STATE.nodes.get(id);

    if (node) {
      node.remove();
      STATE.nodes.delete(id);
    }

    if (dropState) {
      STATE.messages.delete(id);
    }
  }

  function rerenderAll() {
    if (!STATE.container) {
      return;
    }

    STATE.container.querySelectorAll("[data-chatlink-shell]").forEach((node) => node.remove());
    STATE.nodes.clear();

    for (const message of STATE.messages.values()) {
      const node = buildMessageNode(message);
      STATE.container.append(node);
      STATE.nodes.set(message.id, node);
    }
  }

  function requestJson(path) {
    return new Promise((resolve, reject) => {
      const gmRequest =
        typeof GM_xmlhttpRequest === "function"
          ? GM_xmlhttpRequest
          : typeof GM === "object" && typeof GM.xmlHttpRequest === "function"
            ? GM.xmlHttpRequest.bind(GM)
            : null;

      if (gmRequest) {
        gmRequest({
          method: "GET",
          url: `${BRIDGE_BASE}${path}`,
          onload(response) {
            if (response.status < 200 || response.status >= 300) {
              reject(new Error(`Request failed: ${response.status}`));
              return;
            }

            try {
              resolve(JSON.parse(response.responseText));
            } catch (error) {
              reject(error);
            }
          },
          onerror(error) {
            reject(error);
          },
        });
        return;
      }

      log("falling back to page fetch");
      fetch(`${BRIDGE_BASE}${path}`)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Request failed: ${response.status}`);
          }

          return response.json();
        })
        .then(resolve)
        .catch(reject);
    });
  }

  function applySnapshot(messages) {
    const nextMessages = new Map();

    for (const message of messages.slice(-MAX_RENDERED_MESSAGES)) {
      nextMessages.set(message.id, message);
      renderMessage(message);
    }

    for (const existingId of Array.from(STATE.messages.keys())) {
      if (!nextMessages.has(existingId)) {
        removeMessage(existingId, true);
      }
    }

    STATE.messages = nextMessages;
  }

  async function loadSnapshot() {
    const payload = await requestJson("/messages");
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    STATE.lastPollAt = new Date().toISOString();
    STATE.pollCount += 1;
    log("snapshot", {
      count: messages.length,
      pollCount: STATE.pollCount,
    });
    setStatusBadge(`poll ${STATE.pollCount}, ${messages.length} messages`, "ok");
    applySnapshot(messages);
  }

  async function pollSnapshot() {
    try {
      ensureContainer();
      await loadSnapshot();
      STATE.lastError = "";
    } catch (error) {
      STATE.lastError = error instanceof Error ? error.message : String(error);
      console.error("chatlink poll failed", error);
      setStatusBadge(`error ${STATE.lastError}`, "warn");
    } finally {
      STATE.pollTimer = setTimeout(pollSnapshot, POLL_INTERVAL_MS);
    }
  }

  function installStyle() {
    if (document.querySelector("[data-chatlink-style]")) {
      return;
    }

    const style = document.createElement("style");
    style.dataset.chatlinkStyle = "true";
    style.textContent = `
      [data-chatlink="youtube"] .chat-line__message-container {
        position: relative;
      }

      [data-chatlink="youtube"] .chat-line__message-container::before {
        content: "";
        position: absolute;
        left: -6px;
        top: 4px;
        bottom: 4px;
        width: 2px;
        border-radius: 999px;
        background: rgba(255, 0, 51, 0.65);
      }

      [data-chatlink="youtube"] [data-a-target="chat-message-text"] {
        white-space: pre-wrap;
        word-break: break-word;
      }
    `;
    document.head.append(style);
  }

  function exposeTestHook() {
    window.__chatlinkTestLoad = (messages) => {
      if (!Array.isArray(messages)) {
        throw new Error("Expected an array of messages");
      }

      ensureContainer();
      applySnapshot(messages);
      return {
        count: STATE.nodes.size,
      };
    };
    window.__chatlinkDebug = STATE;
  }

  async function boot() {
    if (STATE.booted) {
      return;
    }

    STATE.booted = true;
    if (!isSupportedPage()) {
      log("unsupported page, skipping");
      return;
    }

    installStyle();

    for (let attempt = 0; attempt < STARTUP_CONTAINER_RETRIES; attempt += 1) {
      if (ensureContainer()) {
        log("chat container found", {
          attempt,
        });
        setStatusBadge("chat container found", "ok");
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!STATE.container) {
      log("chat container not found");
      STATE.booted = false;
      return;
    }

    try {
      exposeTestHook();
      setStatusBadge("loading snapshot", "idle");
      await loadSnapshot();
      STATE.pollTimer = setTimeout(pollSnapshot, POLL_INTERVAL_MS);
      log("boot complete");
      setStatusBadge(`boot complete, ${STATE.nodes.size} mirrored`, "ok");
    } catch (error) {
      STATE.lastError = error instanceof Error ? error.message : String(error);
      console.error("chatlink boot failed", error);
      setStatusBadge(`boot failed: ${STATE.lastError}`, "warn");
      STATE.booted = false;
      setTimeout(boot, 3000);
    }
  }

  boot();
})();
