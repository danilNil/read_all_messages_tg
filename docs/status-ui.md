# Status UI

## Run Manually

```bash
npm start
```

Open:

```text
http://127.0.0.1:3000
```

The UI shows reader state, archive read state, Telegram unread state, VK unread state, and VK token validity.

The reader loop runs every 5 minutes by default. Override it with:

```bash
READER_INTERVAL_SECONDS=300
```

## Install macOS Autostart

Copy the launchd template to the user agents directory:

```bash
cp launchd/com.read-all.status-ui.plist ~/Library/LaunchAgents/com.read-all.status-ui.plist
launchctl load ~/Library/LaunchAgents/com.read-all.status-ui.plist
```

After that, the Node.js UI server starts after login and restarts if it exits.

## Stop macOS Autostart

```bash
launchctl unload ~/Library/LaunchAgents/com.read-all.status-ui.plist
```

## API

- `GET /api/status` - reader status, archive read status, Telegram unread status, VK unread status, VK session status, and server status.
- `GET /api/health` - server health.
- `GET /api/vk/session` - cached VK token validity state.
- `POST /api/vk/session/check` - force-checks VK token validity.
- `POST /api/vk/token` - validates and saves a new VK access token to `.env`.
- `POST /api/reader/start` - starts `run_hourly.sh background`.
- `POST /api/reader/stop` - stops the process from `reader.pid`.
- `POST /api/reader/restart` - stops and starts the reader.

## VK Token

The VK token can be added or replaced from the UI. The server validates it with VK before writing it to `.env`, and the token is never returned in API responses.

Required setting:

```bash
VK_ACCESS_TOKEN=your_vk_access_token
```

Optional settings:

```bash
VK_API_VERSION=5.199
VK_UNREAD_COUNT=50
VK_CHECK_TIMEOUT_MS=30000
VK_CACHE_MS=20000
```

## Tests

Run end-to-end tests:

```bash
npm run test:e2e
```

The tests use Node's built-in test runner, start the real HTTP server on a random local port, and replace Telegram, VK, plus the reader loop with temporary fake helpers. They do not connect to Telegram or VK and do not mark real messages as read.

## Telegram Session Lock

`read_all.py` and `check_unread_inbox.py` share the same Telethon session file. They use `session_name.lock` to prevent concurrent sqlite access. If the reader is running, the UI Telegram check may briefly report that the session is busy instead of opening the session at the same time.

## Archive Read Status

After every archive-processing pass, `read_all.py` writes `reader_status.json`. The UI reads this file through `/api/status` and shows when the archive was last read plus how many archived dialogs were processed.
