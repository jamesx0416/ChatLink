// ==UserScript==
// @name         Chatlink Twitch Mirror
// @namespace    chatlink
// @version      0.7.0
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
  const SSE_RETRY_DELAY_MS = 3000;
  const TWITCH_HISTORY_REFRESH_DELAY_MS = 750;
  const DEBUG = false;
  const SHOW_BADGE = false;
  const STARTUP_CONTAINER_RETRIES = 10;
  const STATE = {
    booted: false,
    container: null,
    channelLogin: "",
    messages: new Map(),
    nodes: new Map(),
    latestTwitchMessages: [],
    nativeObserver: null,
    historySyncTimer: null,
    pollTimer: null,
    eventSource: null,
    reconnectTimer: null,
    lastError: "",
    lastPollAt: "",
    pollCount: 0,
    transport: "idle",
    lastSeq: 0,
    sseFailures: 0,
    suspended: false,
    resumeInFlight: false,
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

  function getCurrentChannelLogin() {
    const segments = window.location.pathname.split("/").filter(Boolean);

    if (segments[0] === "popout" && segments[1]) {
      return segments[1].toLowerCase();
    }

    return segments[0] ? segments[0].toLowerCase() : "";
  }

  function normalizeMatchText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function twitchSignature(author, text) {
    return `${normalizeMatchText(author)}\n${normalizeMatchText(text)}`;
  }

  function getScrollableParent() {
    return (
      document.querySelector('[data-a-target="chat-scroller"]') ||
      STATE.container?.closest(".scrollable-area") ||
      null
    );
  }

  function restartNativeObserver() {
    if (STATE.nativeObserver) {
      STATE.nativeObserver.disconnect();
      STATE.nativeObserver = null;
    }

    if (!STATE.container) {
      return;
    }

    STATE.nativeObserver = new MutationObserver((mutations) => {
      const hasNativeChanges = mutations.some((mutation) =>
        Array.from(mutation.addedNodes).some(
          (node) =>
            node instanceof HTMLElement &&
            !node.hasAttribute("data-chatlink-shell"),
        ),
      );

      if (!hasNativeChanges) {
        return;
      }

      scheduleTwitchHistoryRefresh();
    });

    STATE.nativeObserver.observe(STATE.container, {
      childList: true,
      subtree: false,
    });
  }

  function scheduleTwitchHistoryRefresh() {
    if (STATE.historySyncTimer || !STATE.channelLogin || STATE.suspended) {
      return;
    }

    STATE.historySyncTimer = setTimeout(async () => {
      STATE.historySyncTimer = null;

      try {
        const payload = await requestJson(
          `/twitch/messages?channel=${encodeURIComponent(STATE.channelLogin)}`,
        );
        STATE.latestTwitchMessages = Array.isArray(payload.twitchMessages) ? payload.twitchMessages : [];
        matchNativeRowsToHistory(STATE.latestTwitchMessages);
      } catch (error) {
        log("failed to refresh twitch history", error);
      }
    }, TWITCH_HISTORY_REFRESH_DELAY_MS);
  }

  function ensureContainer() {
    const next = findContainer();

    if (!next) {
      return false;
    }

    if (STATE.container !== next) {
      STATE.container = next;
      restartNativeObserver();
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

  function getContainerChild(node) {
    let current = node;

    while (current && current.parentElement && current.parentElement !== STATE.container) {
      current = current.parentElement;
    }

    return current && current.parentElement === STATE.container ? current : null;
  }

  function listNativeTwitchRows() {
    if (!STATE.container) {
      return [];
    }

    const rows = Array.from(STATE.container.querySelectorAll('[data-a-target="chat-line-message"]'));

    return rows
      .filter((row) => !row.closest("[data-chatlink-shell]"))
      .map((row) => {
        const shell = getContainerChild(row);
        const author = row.querySelector('[data-a-target="chat-message-username"]')?.textContent || "";
        const body = Array.from(row.querySelectorAll('[data-a-target="chat-message-text"]'))
          .map((node) => node.textContent || "")
          .join(" ")
          .trim();

        return {
          row,
          shell,
          author,
          text: body,
        };
      })
      .filter((entry) => entry.shell && entry.author && entry.text);
  }

  function assignedNativeTwitchIds() {
    if (!STATE.container) {
      return new Set();
    }

    return new Set(
      Array.from(STATE.container.children)
        .filter((child) => !child.hasAttribute("data-chatlink-shell"))
        .map((child) => child.dataset.chatlinkTwitchId)
        .filter(Boolean),
    );
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

  function messageTimestampMs(message) {
    if (Number.isFinite(message.sentAtMs) && message.sentAtMs > 0) {
      return message.sentAtMs;
    }

    const candidates = [message.firstSeenAt, message.lastSeenAt];

    for (const value of candidates) {
      const timestampMs = Date.parse(value || "");

      if (Number.isFinite(timestampMs)) {
        return timestampMs;
      }
    }

    return Date.now();
  }

  function findInsertionAnchor(timestampMs) {
    if (!STATE.container) {
      return null;
    }

    const children = Array.from(STATE.container.children);

    for (const child of children) {
      if (child.hasAttribute("data-chatlink-shell")) {
        continue;
      }

      const twitchTimestampMs = Number.parseInt(child.dataset.chatlinkTwitchTs || "", 10);

      if (Number.isFinite(twitchTimestampMs) && twitchTimestampMs > timestampMs) {
        return child;
      }
    }

    return null;
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
    const timestampMs = messageTimestampMs(message);

    if (existing) {
      existing.remove();
      STATE.nodes.delete(message.id);
    }

    const beforeNode = findInsertionAnchor(timestampMs);

    if (beforeNode) {
      STATE.container.insertBefore(nextNode, beforeNode);
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

    for (const message of Array.from(STATE.messages.values())) {
      renderMessage(message);
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

  function clearPollTimer() {
    if (!STATE.pollTimer) {
      return;
    }

    clearTimeout(STATE.pollTimer);
    STATE.pollTimer = null;
  }

  function clearReconnectTimer() {
    if (!STATE.reconnectTimer) {
      return;
    }

    clearTimeout(STATE.reconnectTimer);
    STATE.reconnectTimer = null;
  }

  function closeEventSource() {
    if (!STATE.eventSource) {
      return;
    }

    STATE.eventSource.close();
    STATE.eventSource = null;
  }

  function applyBridgeEvent(payload) {
    if (!payload || typeof payload !== "object") {
      return;
    }

    if (typeof payload.seq === "number") {
      STATE.lastSeq = Math.max(STATE.lastSeq, payload.seq);
    }

    if (payload.type === "message_delete") {
      removeMessage(payload.id, true);
      return;
    }

    if (payload.message && typeof payload.message === "object") {
      renderMessage(payload.message);
    }
  }

  function matchNativeRowsToHistory(twitchMessages) {
    if (!STATE.container) {
      return;
    }

    const usedIds = assignedNativeTwitchIds();
    const rows = listNativeTwitchRows().filter((entry) => !entry.shell.dataset.chatlinkTwitchId);
    const availableHistory = twitchMessages.filter((message) => !usedIds.has(message.id));

    if (rows.length === 0 || availableHistory.length === 0) {
      return;
    }

    const rowSignatures = rows.map((entry) => twitchSignature(entry.author, entry.text));
    const historySignatures = availableHistory.map((message) => twitchSignature(message.author, message.text));
    const rowCount = rowSignatures.length;
    const historyCount = historySignatures.length;
    const dp = Array.from({ length: rowCount + 1 }, () => Array(historyCount + 1).fill(0));

    for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
      for (let historyIndex = 1; historyIndex <= historyCount; historyIndex += 1) {
        let best = dp[rowIndex - 1][historyIndex];

        if (dp[rowIndex][historyIndex - 1] > best) {
          best = dp[rowIndex][historyIndex - 1];
        }

        if (rowSignatures[rowIndex - 1] === historySignatures[historyIndex - 1]) {
          const matchScore = dp[rowIndex - 1][historyIndex - 1] + 1000 + historyIndex;

          if (matchScore > best) {
            best = matchScore;
          }
        }

        dp[rowIndex][historyIndex] = best;
      }
    }

    const matches = [];
    let rowIndex = rowCount;
    let historyIndex = historyCount;

    while (rowIndex > 0 && historyIndex > 0) {
      const rowSignature = rowSignatures[rowIndex - 1];
      const historySignature = historySignatures[historyIndex - 1];
      const matchScore = rowSignature === historySignature ? dp[rowIndex - 1][historyIndex - 1] + 1000 + historyIndex : -1;

      if (matchScore === dp[rowIndex][historyIndex]) {
        matches.push([rowIndex - 1, historyIndex - 1]);
        rowIndex -= 1;
        historyIndex -= 1;
        continue;
      }

      if (dp[rowIndex][historyIndex - 1] >= dp[rowIndex - 1][historyIndex]) {
        historyIndex -= 1;
      } else {
        rowIndex -= 1;
      }
    }

    for (const [matchedRowIndex, matchedHistoryIndex] of matches.reverse()) {
      const entry = rows[matchedRowIndex];
      const candidate = availableHistory[matchedHistoryIndex];

      if (!entry || !candidate || usedIds.has(candidate.id)) {
        continue;
      }

      entry.shell.dataset.chatlinkTwitchTs = String(candidate.timestampMs);
      entry.shell.dataset.chatlinkTwitchId = candidate.id;
      usedIds.add(candidate.id);
    }
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

  function applyTimelineSnapshot(payload) {
    const messages = Array.isArray(payload.youtubeMessages) ? payload.youtubeMessages : [];
    const twitchMessages = Array.isArray(payload.twitchMessages) ? payload.twitchMessages : [];
    const timeline = Array.isArray(payload.timeline) ? payload.timeline : [];
    const youtubeIdsInTimeline = new Set(
      timeline
        .filter((entry) => entry && entry.kind === "youtube" && entry.message && entry.message.id)
        .map((entry) => entry.message.id),
    );
    const nextMessages = new Map();

    STATE.latestTwitchMessages = twitchMessages;
    matchNativeRowsToHistory(twitchMessages);
    STATE.container?.querySelectorAll("[data-chatlink-shell]").forEach((node) => node.remove());
    STATE.nodes.clear();

    for (const entry of timeline) {
      if (!entry || entry.kind !== "youtube" || !entry.message || !youtubeIdsInTimeline.has(entry.message.id)) {
        continue;
      }

      nextMessages.set(entry.message.id, entry.message);
      renderMessage(entry.message);
    }

    for (const message of messages) {
      if (!nextMessages.has(message.id)) {
        nextMessages.set(message.id, message);
      }
    }

    STATE.messages = nextMessages;
  }

  async function loadSnapshot() {
    const payload = await requestJson(
      `/timeline?channel=${encodeURIComponent(STATE.channelLogin)}`,
    );
    const messages = Array.isArray(payload.youtubeMessages) ? payload.youtubeMessages : [];
    const nextSeq = Number.isFinite(payload.seq) ? payload.seq : 0;
    STATE.lastPollAt = new Date().toISOString();
    STATE.pollCount += 1;
    STATE.lastSeq = Math.max(STATE.lastSeq, nextSeq);
    log("snapshot", {
      count: messages.length,
      pollCount: STATE.pollCount,
      seq: STATE.lastSeq,
    });
    setStatusBadge(`${STATE.transport} ${STATE.pollCount}, ${messages.length} messages`, "ok");
    applyTimelineSnapshot(payload);
  }

  async function pollSnapshot() {
    if (STATE.suspended) {
      clearPollTimer();
      return;
    }

    try {
      STATE.transport = "poll";
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

  function schedulePollFallback(reason) {
    if (STATE.suspended) {
      return;
    }

    if (STATE.pollTimer) {
      return;
    }

    STATE.transport = "poll";
    log("switching to poll fallback", {
      reason,
    });
    setStatusBadge(`poll fallback: ${reason}`, "warn");
    STATE.pollTimer = setTimeout(pollSnapshot, POLL_INTERVAL_MS);
  }

  function connectEventStream() {
    if (STATE.suspended) {
      return;
    }

    if (typeof EventSource !== "function") {
      schedulePollFallback("EventSource unavailable");
      return;
    }

    closeEventSource();
    clearReconnectTimer();

    try {
      const es = new EventSource(`${BRIDGE_BASE}/events?since=${encodeURIComponent(String(STATE.lastSeq))}`);
      STATE.eventSource = es;
      STATE.transport = "sse";

      es.addEventListener("open", () => {
        STATE.sseFailures = 0;
        clearPollTimer();
        setStatusBadge(`sse live ${STATE.nodes.size} mirrored`, "ok");
      });

      es.addEventListener("ready", (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload && typeof payload.seq === "number") {
            STATE.lastSeq = Math.max(STATE.lastSeq, payload.seq);
          }
        } catch (error) {
          log("failed to parse ready event", error);
        }
      });

      es.addEventListener("message_add", (event) => {
        applyBridgeEvent(JSON.parse(event.data));
      });

      es.addEventListener("message_update", (event) => {
        applyBridgeEvent(JSON.parse(event.data));
      });

      es.addEventListener("message_delete", (event) => {
        applyBridgeEvent(JSON.parse(event.data));
      });

      es.onerror = () => {
        if (STATE.suspended) {
          closeEventSource();
          return;
        }

        STATE.sseFailures += 1;
        closeEventSource();

        if (STATE.sseFailures >= 2) {
          schedulePollFallback("sse blocked");
          return;
        }

        setStatusBadge("sse reconnecting", "warn");
        clearReconnectTimer();
        STATE.reconnectTimer = setTimeout(() => {
          STATE.reconnectTimer = null;
          connectEventStream();
        }, SSE_RETRY_DELAY_MS);
      };
    } catch (error) {
      schedulePollFallback(error instanceof Error ? error.message : String(error));
    }
  }

  function suspendTransport(reason) {
    STATE.suspended = true;
    STATE.transport = "suspended";
    clearPollTimer();
    clearReconnectTimer();
    if (STATE.historySyncTimer) {
      clearTimeout(STATE.historySyncTimer);
      STATE.historySyncTimer = null;
    }
    closeEventSource();
    setStatusBadge(`paused: ${reason}`, "warn");
  }

  async function resumeTransport(reason) {
    if (STATE.resumeInFlight) {
      return;
    }

    STATE.resumeInFlight = true;
    STATE.suspended = false;

    try {
      ensureContainer();
      setStatusBadge(`resync: ${reason}`, "warn");
      await loadSnapshot();
      STATE.lastError = "";
      STATE.sseFailures = 0;
      connectEventStream();
    } catch (error) {
      STATE.lastError = error instanceof Error ? error.message : String(error);
      schedulePollFallback(`resume failed: ${STATE.lastError}`);
    } finally {
      STATE.resumeInFlight = false;
    }
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      suspendTransport("tab hidden");
      return;
    }

    void resumeTransport("tab visible");
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

    STATE.channelLogin = getCurrentChannelLogin();

    if (!STATE.channelLogin) {
      log("channel login not found");
      STATE.booted = false;
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
      if (document.hidden) {
        suspendTransport("tab hidden");
      } else {
        connectEventStream();
      }
      document.addEventListener("visibilitychange", handleVisibilityChange);
      window.addEventListener("focus", () => {
        if (!document.hidden) {
          void resumeTransport("window focus");
        }
      });
      log("boot complete");
      if (STATE.suspended) {
        setStatusBadge("paused: tab hidden", "warn");
      } else {
        setStatusBadge(`boot complete, ${STATE.nodes.size} mirrored`, "ok");
      }
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
