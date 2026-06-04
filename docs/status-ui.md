# Status UI

## Run Manually

```bash
npm start
```

Open:

```text
http://127.0.0.1:3000
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

- `GET /api/status` - reader status, Telegram unread status, and server status.
- `GET /api/health` - server health.
- `POST /api/reader/start` - starts `run_hourly.sh background`.
- `POST /api/reader/stop` - stops the process from `reader.pid`.
- `POST /api/reader/restart` - stops and starts the reader.
