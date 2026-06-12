# ADR 0001: Simple Node.js status UI

## Status

Accepted

## Context

The project currently runs `read_all.py` through `run_hourly.sh`. The runner writes `reader.pid`, appends runner output to `run_hourly.log`, and the Python script writes Telegram processing logs to `telegram_reader.log`.

We want a simple UI that shows:

- whether the reader loop is running;
- whether there are unread Telegram messages outside the archive.

We also want to recover from common operational failures through the UI: start the reader if it is not running, stop it, and restart it without opening a terminal.

The second value must be checked against Telegram state, not inferred from logs. The current Python script mainly processes archived dialogs, while the UI requirement is specifically about unread messages that are not archived.

There is one important boundary: the UI can manage the reader loop, but it cannot help if the Node.js UI server itself is not running. The server therefore needs its own operating-system-level autostart/restart mechanism.

## Decision

Build a small Node.js HTTP server that serves a static UI and exposes JSON status endpoints.

Use Node.js for the server/UI layer and keep Telegram API access in Python, because the project already uses Telethon and already has the required session and environment setup.

The server will provide:

- `GET /` - static HTML UI.
- `GET /api/status` - combined status response for the UI.
- `GET /api/health` - lightweight server health response.
- `POST /api/reader/start` - start the reader loop.
- `POST /api/reader/stop` - stop the reader loop.
- `POST /api/reader/restart` - stop and start the reader loop.

`GET /api/status` will return:

```json
{
  "reader": {
    "running": true,
    "pid": 12345,
    "source": "reader.pid"
  },
  "telegram": {
    "hasUnreadInbox": true,
    "unreadDialogCount": 3,
    "checkedAt": "2026-06-04T10:00:00.000Z",
    "error": null
  }
}
```

Reader process state will be determined by reading `reader.pid` and checking whether the process exists. If the PID file is missing, unreadable, or points to a dead process, the reader is treated as not running.

Unread non-archived message state will be determined by a small Python helper script that uses the existing Telethon session and credentials, iterates dialogs with `archived=False`, and reports whether any dialog has `unread_count > 0`. The helper will output JSON to stdout so the Node server can consume it without parsing human logs.

The UI will poll `GET /api/status` periodically and display two primary indicators:

- reader: `работает` / `не работает`;
- non-archived unread messages: `есть` / `нет`.

The UI will also provide reader controls:

- start when the reader is not running;
- stop when the reader is running;
- restart when the reader is running or appears stuck.

The Node.js server should be installed as a macOS `launchd` user service so it starts after laptop reboot and is restarted if it exits. The UI is responsible for managing `run_hourly.sh`; `launchd` is responsible for keeping the UI server available.

## Consequences

This keeps the UI implementation simple and avoids porting Telegram client logic from Python to Node.js.

The Node server depends on the Python runtime and project dependencies being available for the Telegram unread check. If the helper fails, the UI will still show reader process state and display the Telegram check as an error/unknown state.

The unread check may perform network I/O against Telegram, so the Node endpoint should use a timeout and may cache the result briefly to avoid repeated expensive checks from UI polling.

Using `launchd` adds one macOS-specific setup step, but it solves the main bootstrapping problem: after a reboot, the UI server can come back without manual terminal work. If this project later needs to run on Linux or a remote host, the same role can be filled by `systemd`, Docker restart policies, or another process supervisor.

Reader start/stop endpoints execute local process-management actions, so the server should bind to localhost by default and should not be exposed publicly without authentication.

## Implementation Notes

Recommended files:

- `server.mjs` - Node.js HTTP server.
- `public/index.html` - static UI.
- `check_unread_inbox.py` - Telethon helper for unread non-archived dialogs.
- `launchd/com.read-all.status-ui.plist` - optional macOS user service template for the Node server.

Recommended runtime behavior:

- Default port: `3000`, configurable through `PORT`.
- Poll interval in UI: 10-30 seconds.
- Cache Telegram unread result for around 15-30 seconds.
- Helper timeout: around 30 seconds.
- Server host: `127.0.0.1` by default.
- Start reader command: `./run_hourly.sh background`.
- Stop reader behavior: read `reader.pid`, check the process, send `SIGTERM`, and verify that the PID file/process is gone.
- Restart reader behavior: stop, wait briefly, then start.
- If `reader.pid` is stale, remove or overwrite it only after confirming the process does not exist.

Recommended Python helper output:

```json
{
  "hasUnreadInbox": true,
  "unreadDialogCount": 3,
  "checkedAt": "2026-06-04T10:00:00.000Z",
  "error": null
}
```

## Alternatives Considered

### Implement Telegram access directly in Node.js

Rejected for now. It would add a new Telegram client library and duplicate session/authentication concerns that are already handled by Telethon.

### Generate a static status file from `read_all.py`

Rejected for the initial UI because it would not reliably answer whether there are unread non-archived messages at the time the UI is opened.

### Infer unread state from logs

Rejected because logs describe past processing activity and do not represent current Telegram state.

### Start the Node.js server from the UI

Rejected because this is circular: if the Node.js server is not running, the UI is unavailable. The server must be kept alive by the operating system or a process supervisor.
