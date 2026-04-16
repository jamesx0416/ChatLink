# chatlink

Local bridge that opens a YouTube live chat in Puppeteer, bootstraps YouTube's internal `youtubei` live chat feed, and exposes normalized chat events on `localhost` for a userscript or extension.

## Run

1. Install dependencies:

```bash
bun install
```

2. Start the bridge with a YouTube stream URL:

```bash
bun run src/main.ts --yt-url 'https://www.youtube.com/watch?v=VIDEO_ID'
```

Or pass only the video ID:

```bash
bun run src/main.ts --yt-id VIDEO_ID
```

Useful flags:

- `--yt-url`: YouTube stream or live chat URL. Quote it in `zsh`.
- `--yt-id`: YouTube video ID
- `--port`: localhost port, default `8787`
- `--host`: bind address, default `127.0.0.1`
- `--poll-ms`: minimum polling interval, default `1500`. The collector also respects YouTube's continuation timeout.
- `--headful`: open Chromium visibly instead of headless

## Endpoints

- `GET /health`
- `GET /messages`
- `GET /events`

`/events` is a Server-Sent Events stream. Event names:

- `message_add`
- `message_update`
- `message_delete`

## Notes

- The collector uses YouTube's internal `youtubei/v1/live_chat/get_live_chat` feed instead of scraping rendered DOM nodes.
- Delete handling is based on structured live chat actions such as item deletion, item replacement with tombstones, item removal, and delete-by-author events.
- `youtubei` is an internal web endpoint, not a stable public API. Expect occasional breakage when YouTube changes its web client.
- The Twitch userscript in `examples/twitch-bridge.user.js` is only a starter example. Twitch changes its DOM frequently, so selectors there may need adjustment.
- Some streams may show consent or age gates before chat becomes readable. Those cases are not handled yet.
