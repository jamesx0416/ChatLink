import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import tmi from "@tmi.js/chat";
import puppeteer, { type Browser, type Page } from "puppeteer";

type CliOptions = {
  ytUrl: string;
  ytId: string;
  host: string;
  port: number;
  pollMs: number;
  headful: boolean;
  resume: boolean;
};

type ChatMessage = {
  id: string;
  status: "active" | "deleted";
  author: string;
  authorChannelId: string;
  authorRole: "moderator" | "member" | "default";
  text: string;
  timestamp: string;
  rendererType: string;
  avatarUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

type BridgeEvent =
  | {
      seq: number;
      type: "message_add" | "message_update";
      at: string;
      message: ChatMessage;
    }
  | {
      seq: number;
      type: "message_delete";
      at: string;
      id: string;
    };

type SseClient = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeatId: ReturnType<typeof setInterval>;
};

type EventsSnapshot = {
  sequence: number;
  messages: ChatMessage[];
};

type TwitchChatMessage = {
  id: string;
  channel: string;
  author: string;
  text: string;
  timestampMs: number;
};

type TimelineEntry =
  | {
      kind: "twitch";
      id: string;
      timestampMs: number;
    }
  | {
      kind: "youtube";
      id: string;
      timestampMs: number;
      message: ChatMessage;
    };

type InnerTubeBootstrap = {
  apiKey: string;
  context: {
    client: {
      clientName: string;
      clientVersion: string;
      visitorData: string;
      hl: string;
    };
  };
  continuation: string;
};

type LiveChatBatch = {
  actions: unknown[];
  continuation: string | null;
  timeoutMs: number | null;
};

type ParsedEvent =
  | {
      kind: "upsert";
      message: Omit<ChatMessage, "firstSeenAt" | "lastSeenAt">;
    }
  | {
      kind: "delete";
      id: string;
    }
  | {
      kind: "deleteByAuthor";
      authorChannelId: string;
    };

type DebugEventSummary = {
  kind: ParsedEvent["kind"];
  id?: string;
  authorChannelId?: string;
  rendererType?: string;
  text?: string;
};

type PersistedChatState = {
  version: 1;
  savedAt: string;
  sequence: number;
  messages: ChatMessage[];
};

const encoder = new TextEncoder();
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const HISTORY_FILE_PATH = join(process.cwd(), ".chatlink", "history.json");
const TIMELINE_YOUTUBE_LIMIT = 120;

class TwitchChatStore {
  private readonly client = new tmi.Client();
  private readonly messagesByChannel = new Map<string, TwitchChatMessage[]>();
  private readonly joinedChannels = new Set<string>();
  private connectPromise: Promise<void> | null = null;

  constructor() {
    this.client.on("message", (event) => {
      const channel = normalizeTwitchChannel(event.channel.login);
      const nextMessage: TwitchChatMessage = {
        id: event.message.id,
        channel,
        author: event.user.display || event.user.login,
        text: event.message.text,
        timestampMs:
          typeof event.tags?.tmiSentTs === "number" && Number.isFinite(event.tags.tmiSentTs)
            ? event.tags.tmiSentTs
            : Date.now(),
      };

      const channelMessages = this.messagesByChannel.get(channel) ?? [];
      channelMessages.push(nextMessage);

      if (channelMessages.length > 500) {
        channelMessages.splice(0, channelMessages.length - 500);
      }

      this.messagesByChannel.set(channel, channelMessages);
    });

    this.client.on("part", (event) => {
      this.joinedChannels.delete(normalizeTwitchChannel(event.channel.login));
    });

    this.client.on("close", () => {
      this.joinedChannels.clear();
      this.connectPromise = null;
    });

    this.client.on("error", (error) => {
      console.error(`[twitch] ${error.message}`);
    });
  }

  async ensureChannel(channel: string) {
    const normalized = normalizeTwitchChannel(channel);
    await this.connect();

    if (this.joinedChannels.has(normalized)) {
      return normalized;
    }

    await this.client.join(normalized);
    this.joinedChannels.add(normalized);
    return normalized;
  }

  listChannelMessages(channel: string, limit = 250) {
    const normalized = normalizeTwitchChannel(channel);
    const messages = this.messagesByChannel.get(normalized) ?? [];
    return messages.slice(-limit);
  }

  close() {
    this.client.close();
  }

  private async connect() {
    if (this.client.isConnected()) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.client.off("connect", onConnect);
        this.client.off("error", onError);
        this.connectPromise = null;
      };

      this.client.on("connect", onConnect);
      this.client.on("error", onError);

      try {
        this.client.connect();
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return this.connectPromise;
  }
}

class HistoryPersistor {
  private pendingState: PersistedChatState | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly filePath: string) {}

  schedule(state: PersistedChatState) {
    this.pendingState = state;

    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      void this.flush();
    }, 250);
  }

  async flush() {
    const state = this.pendingState;

    if (!state) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      return;
    }

    this.pendingState = null;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(state, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[history] failed to persist ${this.filePath}: ${message}`);
    }
  }
}

class ChatStore {
  constructor(private readonly onChange?: () => void) {}

  private readonly messages = new Map<string, ChatMessage>();
  private readonly order: string[] = [];
  private readonly clients = new Set<SseClient>();
  private readonly eventHistory: BridgeEvent[] = [];
  private sequence = 0;

  listActiveMessages() {
    return this.order
      .map((id) => this.messages.get(id))
      .filter((message): message is ChatMessage => Boolean(message && message.status === "active"));
  }

  getSequence() {
    return this.sequence;
  }

  eventsSnapshot(): EventsSnapshot {
    return {
      sequence: this.sequence,
      messages: this.listActiveMessages(),
    };
  }

  snapshot(): PersistedChatState {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      sequence: this.sequence,
      messages: this.order
        .map((id) => this.messages.get(id))
        .filter((message): message is ChatMessage => Boolean(message))
        .map((message) => ({ ...message })),
    };
  }

  hydrate(state: PersistedChatState) {
    this.messages.clear();
    this.order.length = 0;

    for (const message of state.messages) {
      this.messages.set(message.id, { ...message });
      this.order.push(message.id);
    }

    this.sequence = state.sequence;
  }

  attachClient(controller: ReadableStreamDefaultController<Uint8Array>, sinceSeq = 0) {
    const client: SseClient = {
      controller,
      heartbeatId: setInterval(() => {
        this.safeEnqueue(client, ": ping\n\n");
      }, 15_000),
    };

    this.clients.add(client);

    if (sinceSeq > 0) {
      for (const event of this.eventHistory) {
        if (event.seq > sinceSeq) {
          this.safeEnqueue(client, this.formatEvent(event));
        }
      }
    }

    this.safeEnqueue(
      client,
      `id: ${this.sequence}\nevent: ready\ndata: ${JSON.stringify({
        seq: this.sequence,
        activeCount: this.listActiveMessages().length,
      })}\n\n`,
    );

    return () => {
      clearInterval(client.heartbeatId);
      this.clients.delete(client);
    };
  }

  upsert(message: Omit<ChatMessage, "firstSeenAt" | "lastSeenAt">) {
    const now = new Date().toISOString();
    const existing = this.messages.get(message.id);

    if (!existing) {
      const created: ChatMessage = {
        ...message,
        firstSeenAt: now,
        lastSeenAt: now,
      };
      this.messages.set(message.id, created);
      this.order.push(message.id);
      this.emit({
        seq: ++this.sequence,
        type: "message_add",
        at: now,
        message: created,
      });
      this.onChange?.();
      return;
    }

    const changed =
      existing.author !== message.author ||
      existing.authorChannelId !== message.authorChannelId ||
      existing.authorRole !== message.authorRole ||
      existing.text !== message.text ||
      existing.timestamp !== message.timestamp ||
      existing.avatarUrl !== message.avatarUrl ||
      existing.rendererType !== message.rendererType ||
      existing.status !== message.status;

    if (!changed) {
      existing.lastSeenAt = now;
      return;
    }

    existing.author = message.author;
    existing.authorChannelId = message.authorChannelId;
    existing.authorRole = message.authorRole;
    existing.text = message.text;
    existing.timestamp = message.timestamp;
    existing.avatarUrl = message.avatarUrl;
    existing.rendererType = message.rendererType;
    existing.status = message.status;
    existing.lastSeenAt = now;
    this.emit({
      seq: ++this.sequence,
      type: "message_update",
      at: now,
      message: { ...existing },
    });
    this.onChange?.();
  }

  deleteById(id: string) {
    const existing = this.messages.get(id);

    if (!existing || existing.status === "deleted") {
      return;
    }

    existing.status = "deleted";
    existing.lastSeenAt = new Date().toISOString();
    this.emit({
      seq: ++this.sequence,
      type: "message_delete",
      at: existing.lastSeenAt,
      id,
    });
    this.onChange?.();
  }

  deleteByAuthorChannelId(authorChannelId: string) {
    for (const message of this.messages.values()) {
      if (message.authorChannelId === authorChannelId) {
        this.deleteById(message.id);
      }
    }
  }

  private emit(event: BridgeEvent) {
    this.eventHistory.push(event);

    if (this.eventHistory.length > 2000) {
      this.eventHistory.shift();
    }

    const payload = this.formatEvent(event);

    for (const client of [...this.clients]) {
      this.safeEnqueue(client, payload);
    }
  }

  private formatEvent(event: BridgeEvent) {
    return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  private safeEnqueue(client: SseClient, chunk: string) {
    try {
      client.controller.enqueue(encoder.encode(chunk));
    } catch {
      clearInterval(client.heartbeatId);
      this.clients.delete(client);
    }
  }
}

class DebugStore {
  lastPollAt = "";
  lastError = "";
  lastActionTypes: string[] = [];
  lastEventSummary: DebugEventSummary[] = [];
  lastContinuation = "";
  lastTimeoutMs = 0;

  update(batch: LiveChatBatch, events: ParsedEvent[]) {
    this.lastPollAt = new Date().toISOString();
    this.lastError = "";
    this.lastActionTypes = batch.actions.map((action) => Object.keys((action as Record<string, unknown>) ?? {}).join(","));
    this.lastEventSummary = events.slice(0, 25).map((event) => {
      if (event.kind === "upsert") {
        return {
          kind: event.kind,
          id: event.message.id,
          rendererType: event.message.rendererType,
          text: event.message.text.slice(0, 120),
        };
      }

      if (event.kind === "deleteByAuthor") {
        return {
          kind: event.kind,
          authorChannelId: event.authorChannelId,
        };
      }

      return {
        kind: event.kind,
        id: event.id,
      };
    });
    this.lastContinuation = batch.continuation ?? "";
    this.lastTimeoutMs = batch.timeoutMs ?? 0;
  }

  fail(message: string) {
    this.lastError = message;
  }
}

function parseCli(argv: string[]): CliOptions {
  const options: CliOptions = {
    ytUrl: "",
    ytId: "",
    host: "127.0.0.1",
    port: 8787,
    pollMs: 1500,
    headful: false,
    resume: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--headful") {
      options.headful = true;
      continue;
    }

    if (arg === "--resume" || arg === "-r") {
      options.resume = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? argv[++index];

    if (!value) {
      throw new Error(`Missing value for --${rawKey}`);
    }

    switch (rawKey) {
      case "yt-url":
        options.ytUrl = value;
        break;
      case "yt-id":
        options.ytId = value;
        break;
      case "host":
        options.host = value;
        break;
      case "port":
        options.port = Number.parseInt(value, 10);
        break;
      case "poll-ms":
        options.pollMs = Number.parseInt(value, 10);
        break;
      default:
        throw new Error(`Unknown flag: --${rawKey}`);
    }
  }

  if (!options.ytUrl && !options.ytId) {
    throw new Error("Missing required flag: --yt-url or --yt-id");
  }

  if (options.ytUrl && options.ytId) {
    throw new Error("Use either --yt-url or --yt-id, not both");
  }

  if (!Number.isFinite(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`Invalid --port value: ${options.port}`);
  }

  if (!Number.isFinite(options.pollMs) || options.pollMs < 250) {
    throw new Error(`Invalid --poll-ms value: ${options.pollMs}`);
  }

  return options;
}

function printUsage() {
  console.log(`Usage:
  bun run src/main.ts (--yt-url <youtube-stream-url> | --yt-id <youtube-video-id>) [--port 8787] [--host 127.0.0.1] [--poll-ms 1500] [--headful] [-r|--resume]

Examples:
  bun run src/main.ts --yt-url 'https://www.youtube.com/watch?v=VIDEO_ID'
  bun run src/main.ts --yt-id VIDEO_ID
  bun run src/main.ts --yt-id VIDEO_ID --resume
  bun run src/main.ts --yt-url 'https://www.youtube.com/live/VIDEO_ID' --headful
`);
}

function normalizeChatUrl(input: string) {
  const url = new URL(input);
  const host = url.hostname.replace(/^www\./, "");

  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "youtu.be") {
    throw new Error(`Unsupported YouTube host: ${url.hostname}`);
  }

  if (url.pathname === "/live_chat" || url.pathname === "/live_chat_replay") {
    url.searchParams.set("is_popout", "1");
    return url.toString();
  }

  let videoId = "";

  if (host === "youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0] ?? "";
  } else if (url.pathname === "/watch") {
    videoId = url.searchParams.get("v") ?? "";
  } else {
    const liveMatch = url.pathname.match(/^\/live\/([^/]+)/);
    videoId = liveMatch?.[1] ?? "";
  }

  if (!videoId) {
    throw new Error(`Could not determine video id from URL: ${input}`);
  }

  return buildChatUrlFromVideoId(videoId);
}

function buildChatUrlFromVideoId(videoId: string) {
  const normalizedId = videoId.trim();

  if (!normalizedId) {
    throw new Error("Missing YouTube video id");
  }

  return `https://www.youtube.com/live_chat?is_popout=1&v=${encodeURIComponent(normalizedId)}`;
}

async function waitForChatBootstrap(page: Page) {
  await page.waitForFunction(
    () => {
      const appReady = Boolean(document.querySelector("yt-live-chat-app"));
      const initialData = Boolean(
        (window as typeof window & { ytInitialData?: { contents?: { liveChatRenderer?: { continuations?: unknown[] } } } })
          .ytInitialData?.contents?.liveChatRenderer?.continuations?.length,
      );

      return appReady && initialData;
    },
    { timeout: 60_000 },
  );
}

async function readBootstrap(page: Page): Promise<InnerTubeBootstrap> {
  return page.evaluate(() => {
    const win = window as typeof window & {
      ytcfg?: {
        data_?: Record<string, unknown>;
        get?: (key: string) => unknown;
      };
      ytInitialData?: {
        contents?: {
          liveChatRenderer?: {
            continuations?: Array<{
              timedContinuationData?: {
                continuation?: string;
              };
              invalidationContinuationData?: {
                continuation?: string;
              };
              reloadContinuationData?: {
                continuation?: string;
              };
            }>;
          };
        };
      };
    };

    const get = win.ytcfg?.get?.bind(win.ytcfg);
    const apiKey = String(get?.("INNERTUBE_API_KEY") ?? win.ytcfg?.data_?.INNERTUBE_API_KEY ?? "");
    const clientName = String(get?.("INNERTUBE_CLIENT_NAME") ?? win.ytcfg?.data_?.INNERTUBE_CLIENT_NAME ?? "WEB");
    const clientVersion = String(
      get?.("INNERTUBE_CLIENT_VERSION") ?? win.ytcfg?.data_?.INNERTUBE_CLIENT_VERSION ?? "",
    );
    const visitorData = String(get?.("VISITOR_DATA") ?? win.ytcfg?.data_?.VISITOR_DATA ?? "");
    const hl = String(get?.("HL") ?? win.ytcfg?.data_?.HL ?? "en");
    const initialContinuation = win.ytInitialData?.contents?.liveChatRenderer?.continuations?.[0];
    const continuation =
      initialContinuation?.timedContinuationData?.continuation ??
      initialContinuation?.invalidationContinuationData?.continuation ??
      initialContinuation?.reloadContinuationData?.continuation ??
      "";

    return {
      apiKey,
      context: {
        client: {
          clientName,
          clientVersion,
          visitorData,
          hl,
        },
      },
      continuation,
    };
  });
}

async function fetchLiveChatBatch(
  page: Page,
  bootstrap: InnerTubeBootstrap,
  continuation: string,
): Promise<LiveChatBatch> {
  return page.evaluate(
    async (requestInfo) => {
      const response = await fetch(
        `/youtubei/v1/live_chat/get_live_chat?key=${encodeURIComponent(requestInfo.apiKey)}&prettyPrint=false`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            context: requestInfo.context,
            continuation: requestInfo.continuation,
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`youtubei request failed with ${response.status}: ${text.slice(0, 300)}`);
      }

      const json = await response.json();
      const liveChat = json?.continuationContents?.liveChatContinuation;
      const continuationData =
        liveChat?.continuations?.[0]?.timedContinuationData ??
        liveChat?.continuations?.[0]?.invalidationContinuationData ??
        liveChat?.continuations?.[0]?.reloadContinuationData ??
        null;

      return {
        actions: liveChat?.actions ?? [],
        continuation: continuationData?.continuation ?? null,
        timeoutMs: continuationData?.timeoutMs ?? null,
      };
    },
    {
      apiKey: bootstrap.apiKey,
      context: bootstrap.context,
      continuation,
    },
  );
}

function parseActions(actions: unknown[]): ParsedEvent[] {
  const events: ParsedEvent[] = [];

  for (const rawAction of actions) {
    const action = rawAction as Record<string, unknown>;

    if (action.addChatItemAction) {
      const message = itemToMessage(
        (action.addChatItemAction as { item?: unknown }).item,
      );

      if (message) {
        events.push({
          kind: "upsert",
          message,
        });
      }

      continue;
    }

    if (action.replaceChatItemAction) {
      const replaceAction = action.replaceChatItemAction as {
        targetItemId?: string;
        replacementItem?: unknown;
      };
      const replacement = itemToMessage(replaceAction.replacementItem);

      if (replacement) {
        if (replacement.rendererType.includes("tombstone")) {
          events.push({
            kind: "delete",
            id: replaceAction.targetItemId ?? replacement.id,
          });
        } else {
          events.push({
            kind: "upsert",
            message: replacement,
          });
        }
      } else if (replaceAction.targetItemId) {
        events.push({
          kind: "delete",
          id: replaceAction.targetItemId,
        });
      }

      continue;
    }

    if (action.markChatItemAsDeletedAction) {
      const deleteAction = action.markChatItemAsDeletedAction as {
        targetItemId?: string;
      };

      if (deleteAction.targetItemId) {
        events.push({
          kind: "delete",
          id: deleteAction.targetItemId,
        });
      }

      continue;
    }

    if (action.removeChatItemAction) {
      const removeAction = action.removeChatItemAction as {
        targetItemId?: string;
      };

      if (removeAction.targetItemId) {
        events.push({
          kind: "delete",
          id: removeAction.targetItemId,
        });
      }

      continue;
    }

    if (action.markChatItemsByAuthorAsDeletedAction) {
      const deleteByAuthorAction = action.markChatItemsByAuthorAsDeletedAction as {
        externalChannelId?: string;
      };

      if (deleteByAuthorAction.externalChannelId) {
        events.push({
          kind: "deleteByAuthor",
          authorChannelId: deleteByAuthorAction.externalChannelId,
        });
      }

      continue;
    }

    if (action.removeChatItemByAuthorAction) {
      const removeByAuthorAction = action.removeChatItemByAuthorAction as {
        externalChannelId?: string;
        authorExternalChannelId?: string;
        channelId?: string;
      };
      const authorChannelId =
        removeByAuthorAction.externalChannelId ??
        removeByAuthorAction.authorExternalChannelId ??
        removeByAuthorAction.channelId;

      if (authorChannelId) {
        events.push({
          kind: "deleteByAuthor",
          authorChannelId,
        });
      }
    }
  }

  return events;
}

function itemToMessage(item: unknown): Omit<ChatMessage, "firstSeenAt" | "lastSeenAt"> | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const [rendererType, renderer] = Object.entries(item as Record<string, unknown>)[0] ?? [];

  if (!rendererType || !renderer || typeof renderer !== "object") {
    return null;
  }

  const payload = renderer as Record<string, unknown>;
  const id = asString(payload.id);

  if (!id) {
    return null;
  }

  return {
    id,
    status: rendererType.includes("tombstone") ? "deleted" : "active",
    author: textFromNode(payload.authorName),
    authorChannelId: asString(payload.authorExternalChannelId),
    authorRole: authorRoleFromBadges(payload.authorBadges),
    text: firstNonEmpty(
      textFromNode(payload.message),
      textFromNode(payload.purchaseAmountText),
      textFromNode(payload.headerPrimaryText),
      textFromNode(payload.headerSubtext),
      textFromNode(payload.primaryText),
      textFromNode(payload.deletedStateMessage),
    ),
    timestamp: textFromNode(payload.timestampText) || asString(payload.timestampUsec),
    rendererType,
    avatarUrl: thumbnailUrl(payload.authorPhoto),
  };
}

function authorRoleFromBadges(value: unknown): "moderator" | "member" | "default" {
  if (!Array.isArray(value)) {
    return "default";
  }

  const labels = value
    .map((entry) => {
      const renderer = (entry as { liveChatAuthorBadgeRenderer?: Record<string, unknown> })
        ?.liveChatAuthorBadgeRenderer;

      if (!renderer) {
        return "";
      }

      return [
        textFromNode(renderer.tooltip),
        asString(renderer.tooltip),
        textFromNode(renderer.accessibility),
        asString((renderer.accessibility as { label?: string } | undefined)?.label),
        asString(
          (
            renderer.accessibility as
              | {
                  accessibilityData?: {
                    label?: string;
                  };
                }
              | undefined
          )?.accessibilityData?.label,
        ),
        asString((renderer.icon as { iconType?: string } | undefined)?.iconType),
        asString(renderer.iconType),
        asString(
          (renderer.customThumbnail as { thumbnails?: Array<{ url?: string }> } | undefined)?.thumbnails
            ?.map((thumbnail) => thumbnail.url ?? "")
            .join(" "),
        ),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    })
    .join(" ");

  if (labels.includes("moderator") || labels.includes("owner")) {
    return "moderator";
  }

  if (
    labels.includes("member") ||
    labels.includes("subscriber") ||
    labels.includes("sponsor")
  ) {
    return "member";
  }

  return "default";
}

function textFromNode(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const node = value as {
    simpleText?: string;
    runs?: Array<{
      text?: string;
      emoji?: {
        shortcuts?: string[];
      };
    }>;
  };

  if (typeof node.simpleText === "string") {
    return node.simpleText.trim();
  }

  if (Array.isArray(node.runs)) {
    return node.runs
      .map((run) => {
        if (typeof run.text === "string") {
          return run.text;
        }

        const shortcut = run.emoji?.shortcuts?.[0];
        return typeof shortcut === "string" ? shortcut : "";
      })
      .join("")
      .trim();
  }

  return "";
}

function thumbnailUrl(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const thumbnails = (value as { thumbnails?: Array<{ url?: string }> }).thumbnails;

  if (!Array.isArray(thumbnails) || thumbnails.length === 0) {
    return "";
  }

  return thumbnails[thumbnails.length - 1]?.url ?? "";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstNonEmpty(...values: string[]) {
  return values.find((value) => value.trim().length > 0) ?? "";
}

function normalizeTwitchChannel(channel: string) {
  const normalized = channel.trim().toLowerCase().replace(/^#/, "");

  if (!normalized) {
    throw new Error("Missing Twitch channel");
  }

  return normalized;
}

function chatMessageTimestampMs(message: ChatMessage) {
  const candidates = [message.firstSeenAt, message.lastSeenAt];

  for (const value of candidates) {
    const timestampMs = Date.parse(value);

    if (Number.isFinite(timestampMs)) {
      return timestampMs;
    }
  }

  return Date.now();
}

function buildTimeline(messages: ChatMessage[], twitchMessages: TwitchChatMessage[]): TimelineEntry[] {
  return [
    ...twitchMessages.map<TimelineEntry>((message) => ({
      kind: "twitch",
      id: message.id,
      timestampMs: message.timestampMs,
    })),
    ...messages.map<TimelineEntry>((message) => ({
      kind: "youtube",
      id: message.id,
      timestampMs: chatMessageTimestampMs(message),
      message,
    })),
  ].sort((left, right) => {
    if (left.timestampMs !== right.timestampMs) {
      return left.timestampMs - right.timestampMs;
    }

    if (left.kind === right.kind) {
      return left.id.localeCompare(right.id);
    }

    return left.kind === "twitch" ? -1 : 1;
  });
}

function parsePersistedMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const message = value as Record<string, unknown>;
  const id = asString(message.id);

  if (!id) {
    return null;
  }

  const status = message.status === "deleted" ? "deleted" : "active";
  const authorRole =
    message.authorRole === "moderator" || message.authorRole === "member" ? message.authorRole : "default";
  const now = new Date().toISOString();

  return {
    id,
    status,
    author: asString(message.author),
    authorChannelId: asString(message.authorChannelId),
    authorRole,
    text: asString(message.text),
    timestamp: asString(message.timestamp),
    rendererType: asString(message.rendererType),
    avatarUrl: asString(message.avatarUrl),
    firstSeenAt: asString(message.firstSeenAt) || now,
    lastSeenAt: asString(message.lastSeenAt) || now,
  };
}

async function loadPersistedChatState(filePath: string): Promise<PersistedChatState | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      sequence?: unknown;
      messages?: unknown;
    };

    if (parsed.version !== 1 || !Array.isArray(parsed.messages)) {
      return null;
    }

    return {
      version: 1,
      savedAt: new Date().toISOString(),
      sequence: Number.isFinite(parsed.sequence) ? Number(parsed.sequence) : 0,
      messages: parsed.messages
        .map((message) => parsePersistedMessage(message))
        .filter((message): message is ChatMessage => Boolean(message)),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`[history] failed to load ${filePath}: ${message}`);
    return null;
  }
}

async function reloadBootstrap(page: Page) {
  await page.reload({
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await waitForChatBootstrap(page);
  return readBootstrap(page);
}

async function startCollector(
  page: Page,
  store: ChatStore,
  debugStore: DebugStore,
  bootstrap: InnerTubeBootstrap,
  pollMs: number,
) {
  let currentBootstrap = bootstrap;
  let continuation = bootstrap.continuation;
  let lastError = "";

  while (true) {
    try {
      const batch = await fetchLiveChatBatch(page, currentBootstrap, continuation);
      const events = parseActions(batch.actions);

      for (const event of events) {
        if (event.kind === "upsert") {
          if (event.message.status === "deleted") {
            store.deleteById(event.message.id);
          } else {
            store.upsert(event.message);
          }
          continue;
        }

        if (event.kind === "delete") {
          store.deleteById(event.id);
          continue;
        }

        store.deleteByAuthorChannelId(event.authorChannelId);
      }

      debugStore.update(batch, events);
      continuation = batch.continuation ?? continuation;
      lastError = "";

      const sleepMs = Math.max(batch.timeoutMs ?? 0, pollMs);
      await Bun.sleep(sleepMs);
    } catch (error) {
      const nextError = error instanceof Error ? error.message : String(error);
      debugStore.fail(nextError);

      if (nextError !== lastError) {
        console.error(`[collector] ${nextError}`);
        lastError = nextError;
      }

      await Bun.sleep(2000);
      currentBootstrap = await reloadBootstrap(page);
      continuation = currentBootstrap.continuation;
    }
  }
}

function startServer(
  store: ChatStore,
  twitchStore: TwitchChatStore,
  debugStore: DebugStore,
  options: Pick<CliOptions, "host" | "port">,
) {
  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    async fetch(request) {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: corsHeaders(),
        });
      }

      if (url.pathname === "/health") {
        return json({ ok: true }, 200);
      }

      if (url.pathname === "/messages") {
        const snapshot = store.eventsSnapshot();
        return json(
          {
            seq: snapshot.sequence,
            messages: snapshot.messages,
          },
          200,
        );
      }

      if (url.pathname === "/timeline") {
        const rawChannel = url.searchParams.get("channel") ?? "";

        if (!rawChannel) {
          return json({ error: "Missing required query param: channel" }, 400);
        }

        const channel = await twitchStore.ensureChannel(rawChannel);
        const youtubeMessages = store.listActiveMessages().slice(-TIMELINE_YOUTUBE_LIMIT);
        const twitchMessages = twitchStore.listChannelMessages(channel, 250);
        const timeline = buildTimeline(youtubeMessages, twitchMessages).slice(-500);

        return json(
          {
            seq: store.getSequence(),
            channel,
            youtubeMessages,
            twitchMessages,
            timeline,
          },
          200,
        );
      }

      if (url.pathname === "/twitch/messages") {
        const rawChannel = url.searchParams.get("channel") ?? "";

        if (!rawChannel) {
          return json({ error: "Missing required query param: channel" }, 400);
        }

        const channel = await twitchStore.ensureChannel(rawChannel);
        const twitchMessages = twitchStore.listChannelMessages(channel, 250);

        return json(
          {
            channel,
            twitchMessages,
          },
          200,
        );
      }

      if (url.pathname === "/debug/snapshot") {
        return json(
          {
            lastPollAt: debugStore.lastPollAt,
            lastError: debugStore.lastError,
            lastActionTypes: debugStore.lastActionTypes,
            lastEventSummary: debugStore.lastEventSummary,
            lastContinuation: debugStore.lastContinuation,
            lastTimeoutMs: debugStore.lastTimeoutMs,
            activeMessages: store.listActiveMessages().slice(-20),
          },
          200,
        );
      }

      if (url.pathname === "/events") {
        const sinceParam = Number.parseInt(url.searchParams.get("since") ?? "", 10);
        const headerSince = Number.parseInt(request.headers.get("last-event-id") ?? "", 10);
        const sinceSeq = Number.isFinite(headerSince)
          ? headerSince
          : Number.isFinite(sinceParam)
            ? sinceParam
            : 0;
        let detach = () => {};

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            detach = store.attachClient(controller, sinceSeq);
          },
          cancel() {
            detach();
          },
        });

        request.signal.addEventListener("abort", () => {
          detach();
        });

        return new Response(stream, {
          headers: {
            ...corsHeaders(),
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        });
      }

      if (url.pathname === "/") {
        return new Response(
          `chatlink bridge is running

GET /health
GET /messages
GET /debug/snapshot
GET /events
`,
          {
            headers: {
              ...corsHeaders(),
              "Content-Type": "text/plain; charset=utf-8",
            },
          },
        );
      }

      return new Response("Not found", {
        status: 404,
        headers: corsHeaders(),
      });
    },
  });

  console.log(`[server] listening at http://${server.hostname}:${server.port}`);
  return server;
}

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

async function launchBrowser(chatUrl: string, headful: boolean): Promise<{ browser: Browser; page: Page }> {
  const browser = await puppeteer.launch({
    headless: !headful,
    defaultViewport: {
      width: 1280,
      height: 900,
    },
  });
  const page = await browser.newPage();

  await page.setUserAgent(CHROME_USER_AGENT);
  await page.setExtraHTTPHeaders({
    "accept-language": "en-US,en;q=0.9",
  });
  await page.goto(chatUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await waitForChatBootstrap(page);

  return { browser, page };
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    const chatUrl = options.ytId ? buildChatUrlFromVideoId(options.ytId) : normalizeChatUrl(options.ytUrl);
    const historyPersistor = new HistoryPersistor(HISTORY_FILE_PATH);
    const store = new ChatStore(() => {
      historyPersistor.schedule(store.snapshot());
    });
    const twitchStore = new TwitchChatStore();
    const debugStore = new DebugStore();

    if (options.resume) {
      const restored = await loadPersistedChatState(HISTORY_FILE_PATH);

      if (restored) {
        store.hydrate(restored);
        console.log(`[history] resumed ${store.listActiveMessages().length} active messages from ${HISTORY_FILE_PATH}`);
      } else {
        console.log(`[history] no saved history found at ${HISTORY_FILE_PATH}`);
      }
    }

    console.log(`[collector] chat url: ${chatUrl}`);
    const server = startServer(store, twitchStore, debugStore, options);

    const { browser, page } = await launchBrowser(chatUrl, options.headful);
    const bootstrap = await readBootstrap(page);

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      console.log(`\n[app] shutting down (${signal})`);
      await historyPersistor.flush();

      try {
        server.stop(true);
      } catch {}

      try {
        twitchStore.close();
      } catch {}

      try {
        await browser.close();
      } catch {}

      process.exit(0);
    };

    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });

    await startCollector(page, store, debugStore, bootstrap, options.pollMs);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    printUsage();
    process.exit(1);
  }
}

void main();
