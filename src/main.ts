import puppeteer, { type Browser, type Page } from "puppeteer";

type CliOptions = {
  ytUrl: string;
  ytId: string;
  host: string;
  port: number;
  pollMs: number;
  headful: boolean;
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

const encoder = new TextEncoder();
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

class ChatStore {
  private readonly messages = new Map<string, ChatMessage>();
  private readonly order: string[] = [];
  private readonly clients = new Set<SseClient>();
  private sequence = 0;

  listActiveMessages() {
    return this.order
      .map((id) => this.messages.get(id))
      .filter((message): message is ChatMessage => Boolean(message && message.status === "active"));
  }

  attachClient(controller: ReadableStreamDefaultController<Uint8Array>) {
    const client: SseClient = {
      controller,
      heartbeatId: setInterval(() => {
        this.safeEnqueue(client, ": ping\n\n");
      }, 15_000),
    };

    this.clients.add(client);
    this.safeEnqueue(
      client,
      `event: ready\ndata: ${JSON.stringify({
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
  }

  deleteByAuthorChannelId(authorChannelId: string) {
    for (const message of this.messages.values()) {
      if (message.authorChannelId === authorChannelId) {
        this.deleteById(message.id);
      }
    }
  }

  private emit(event: BridgeEvent) {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

    for (const client of [...this.clients]) {
      this.safeEnqueue(client, payload);
    }
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
  bun run src/main.ts (--yt-url <youtube-stream-url> | --yt-id <youtube-video-id>) [--port 8787] [--host 127.0.0.1] [--poll-ms 1500] [--headful]

Examples:
  bun run src/main.ts --yt-url 'https://www.youtube.com/watch?v=VIDEO_ID'
  bun run src/main.ts --yt-id VIDEO_ID
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
        textFromNode(renderer.accessibility),
        asString(
          (renderer.customThumbnail as { thumbnails?: Array<{ url?: string }> } | undefined)?.thumbnails?.[0]?.url,
        ),
        asString(renderer.iconType),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    })
    .join(" ");

  if (labels.includes("moderator")) {
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
  debugStore: DebugStore,
  options: Pick<CliOptions, "host" | "port">,
) {
  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    fetch(request) {
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
        return json(
          {
            messages: store.listActiveMessages(),
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
        let detach = () => {};

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            detach = store.attachClient(controller);
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
    const store = new ChatStore();
    const debugStore = new DebugStore();

    console.log(`[collector] chat url: ${chatUrl}`);
    startServer(store, debugStore, options);

    const { browser, page } = await launchBrowser(chatUrl, options.headful);
    const bootstrap = await readBootstrap(page);

    const shutdown = async () => {
      console.log("\n[app] shutting down");
      await browser.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await startCollector(page, store, debugStore, bootstrap, options.pollMs);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    printUsage();
    process.exit(1);
  }
}

void main();
