# ADR 0002: VK unread status in the local status UI

## Status

Proposed

## Context

The project already has a local Node.js status UI that reports:

- whether the hourly Telegram reader is running;
- whether Telegram has unread non-archived dialogs.

Telegram state is checked by a small Python helper (`check_unread_inbox.py`) that returns JSON to the Node.js server. This keeps external API details out of the browser and lets the UI show an error state when a provider check fails.

We also want to know whether the VK account has unread messages. This should be a read-only status check, not an automatic "mark as read" action.

The VK API supports `messages.getConversations` with `filter=unread`, `count` up to 200, and user/group access tokens. The official VK API schema currently targets API version `5.199`, so the implementation should pass an explicit API version instead of relying on a server default:

- VK API schema: <https://github.com/VKCOM/vk-api-schema>
- `messages.getConversations` schema: <https://github.com/VKCOM/vk-api-schema/blob/master/messages/methods.json>

The main operational uncertainty is authentication. Unlike Telegram, where the project already owns a Telethon session, VK requires an access token with permission to read messages. Token acquisition and renewal can be more fragile than the unread query itself, so the design must make credential failure visible instead of hiding it as "no unread messages".

## Decision

Add VK as a second provider status check through a dedicated Python helper script, called by the existing Node.js server.

Recommended files:

- `check_vk_unread.py` - read-only VK unread helper.
- `server.mjs` - add VK helper execution, timeout, cache, and `vk` field in `/api/status`.
- `public/index.html` - add a third status card for VK unread messages.
- `.env` - add VK configuration, never committed.

Use direct HTTPS calls from Python to VK API instead of adding a VK SDK dependency. The helper only needs one method call, so the standard library (`urllib.request`) is enough and keeps `requirements.txt` unchanged.

Required environment variables:

```bash
VK_ACCESS_TOKEN=...
VK_API_VERSION=5.199
```

Optional environment variables:

```bash
VK_UNREAD_COUNT=50
VK_CHECK_TIMEOUT_MS=30000
VK_CACHE_MS=20000
```

The helper will call:

```text
https://api.vk.com/method/messages.getConversations
  ?filter=unread
  &count=<VK_UNREAD_COUNT>
  &v=<VK_API_VERSION>
  &access_token=<VK_ACCESS_TOKEN>
```

The helper will output JSON to stdout:

```json
{
  "hasUnreadInbox": true,
  "unreadDialogCount": 2,
  "checkedAt": "2026-06-04T10:00:00.000Z",
  "error": null,
  "unreadDialogs": [
    {
      "peerId": 123,
      "unreadCount": 4,
      "title": "Example"
    }
  ]
}
```

The Node.js `/api/status` response will become:

```json
{
  "reader": {},
  "telegram": {},
  "vk": {
    "hasUnreadInbox": true,
    "unreadDialogCount": 2,
    "checkedAt": "2026-06-04T10:00:00.000Z",
    "error": null,
    "cached": false
  },
  "server": {}
}
```

If `VK_ACCESS_TOKEN` is missing, expired, lacks message permission, or VK returns an API error, the helper must return `error` and a non-zero exit code. The UI should show VK as "ошибка" or "неизвестно", not as "нет непрочитанных".

The UI will poll VK status through the same `/api/status` request as Telegram. The server should cache VK results for about 15-30 seconds, because VK checks perform network I/O and the UI can poll often.

## Consequences

This matches the existing architecture: Node.js owns the local UI and process orchestration, while small Python helpers own provider-specific API calls.

The unread VK check stays read-only. It will not call `messages.markAsRead` and therefore cannot accidentally consume messages.

The UI can show three independent states:

- hourly reader process;
- Telegram unread inbox;
- VK unread inbox.

VK availability now depends on a valid `VK_ACCESS_TOKEN`. If token renewal becomes annoying, we can later add a small setup command or OAuth callback flow, but that should be a separate decision.

Provider failures become explicit. A Telegram error does not block VK status, and a VK error does not block reader process status.

## Implementation Notes

`check_vk_unread.py` should:

- load `.env` from the project directory with `python-dotenv`, as the Telegram helper already does;
- fail clearly when `VK_ACCESS_TOKEN` is missing;
- call `messages.getConversations` with `filter=unread`, `count`, `v`, and `access_token`;
- parse VK API errors from the `error` response object;
- compute `hasUnreadInbox` from `response.count > 0` or returned unread items;
- include only a small preview of unread dialogs, for example the first 20;
- never log or print the token.

`server.mjs` should:

- add `VK_HELPER`, `VK_CHECK_TIMEOUT_MS`, and `VK_CACHE_MS` constants;
- add `getVkStatus()` using the same `runCommand()` pattern as Telegram;
- call reader, Telegram, and VK checks in parallel inside `getStatus()`;
- preserve `/api/status` compatibility by adding `vk` rather than reshaping existing fields.

`public/index.html` should:

- add a VK status card beside Telegram;
- show `есть`, `нет`, or `ошибка`;
- display checked time, unread dialog count, cache state, and a short error message when present;
- avoid exposing token or raw API response details.

## Alternatives Considered

### Add VK logic directly to Node.js

Rejected for now. It would work, but it would split provider checks across languages. The current project already uses Python helpers for account API checks, and Python can make this one request without adding dependencies.

### Use a VK SDK

Rejected for the first version. The check needs one API method and no complex object model. A SDK can be introduced later if token refresh, long polling, or more VK operations appear.

### Poll VK Long Poll API

Rejected for now. Long Poll is useful for event-driven notifications, but this UI only needs current unread status when the panel is open. Periodic `messages.getConversations` is simpler and easier to reason about.

### Scrape the VK web UI

Rejected. Browser scraping would be brittle, harder to run under `launchd`, and more likely to break after VK UI changes.

### Mark VK messages as read automatically

Rejected. The requested feature is checking unread state. Automatic read actions should be a separate, explicit decision because they change account state.
